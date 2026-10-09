/**
 * Input validation (spec §2, §13).
 *
 * Two jobs:
 *   1. Zod schemas for the admin product create/update endpoints.
 *   2. A validating CSV parser for supplier inventory feeds.
 *
 * MONEY: amounts may arrive as integers ("300") or as decimal strings ("3.00")
 * from an admin form. Decimal strings are converted with the exact string
 * parser in `@/lib/money` — never `parseFloat`, never `Number("3.50")` — so a
 * price is always an exact count of minor units. Amounts with more precision
 * than the currency supports ("3.005 USD") are rejected, not truncated.
 *
 * SECRETS: `parseInventoryCsv` handles plaintext redeem codes. Nothing in this
 * file logs a code, puts one in an error message, or returns one in the error
 * list. Errors carry a line number and a column name; that is the entire
 * vocabulary for describing a bad row.
 */

import { z } from 'zod';
import { DeliveryMethod, ProductStatus } from '@prisma/client';
import { codeFingerprint, codeLast4, normalizeCode } from '@/lib/crypto';
import { errors } from '@/lib/errors';
import { fromProviderDecimal } from '@/lib/money';
import { appConfig } from '@/lib/env';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .transform((value) => value.toUpperCase());

const regionSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,8}$/, 'region must be a 2-8 letter code, e.g. US, IN, GB')
  .transform((value) => value.toUpperCase());

const slugSchema = z
  .string()
  .trim()
  .min(3, 'slug must be at least 3 characters')
  .max(80, 'slug must be at most 80 characters')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words separated by single dashes')
  .transform((value) => value.toLowerCase());

/**
 * A monetary amount as an integer count of minor units, or as a decimal
 * string in MAJOR units which is converted exactly.
 *
 * `$3` and `3.00` and `300` all mean the same thing; `$3,00` and `3.005` and
 * `abc` do not.
 */
const minorAmountSchema = z.union([
  z.number().int('amount must be an integer number of minor units'),
  z
    .string()
    .trim()
    .regex(
      /^\d{1,12}(\.\d{1,4})?$/,
      'amount must look like 300 or 3.00 — no currency symbols, thousands separators or signs',
    ),
]);

/** Upper bound that still catches a units mistake (e.g. typing dollars as cents). */
const MAX_MINOR_AMOUNT = 100_000_000; // 1,000,000.00 in a 2-exponent currency

// ---------------------------------------------------------------------------
// Product schemas
// ---------------------------------------------------------------------------

const productFields = {
  slug: slugSchema,
  productName: z.string().trim().min(1, 'productName is required').max(120),
  brand: z.string().trim().min(1, 'brand is required').max(80),
  category: z.string().trim().min(1, 'category is required').max(60),
  region: regionSchema.optional(),
  description: z.string().trim().max(2_000).nullish(),
  imageUrl: z.string().trim().url('imageUrl must be a valid URL').max(500).nullish(),
  currency: currencySchema,
  faceValueMinor: minorAmountSchema,
  sellingPriceMinor: minorAmountSchema,
  supplierCostMinor: minorAmountSchema.optional(),
  deliveryMethod: z.nativeEnum(DeliveryMethod).optional(),
  metadata: z.record(z.unknown()).nullish(),
  status: z.nativeEnum(ProductStatus).optional(),
} as const;

export interface ProductCreateInput {
  slug: string;
  productName: string;
  brand: string;
  category: string;
  region: string;
  description: string | null;
  imageUrl: string | null;
  currency: string;
  faceValueMinor: number;
  sellingPriceMinor: number;
  supplierCostMinor: number;
  deliveryMethod: DeliveryMethod;
  metadata: Record<string, unknown> | null;
  status: ProductStatus | undefined;
}

export type ProductUpdateInput = Partial<ProductCreateInput>;

/**
 * Converts a validated raw amount to integer minor units, exactly.
 *
 * The currency exponent matters: "3000" is 3000 yen (JPY has no minor unit)
 * and 30,00 EUR, not 300000 of anything. Strings go through
 * `fromProviderDecimal`, which refuses more precision than the currency has.
 */
function toMinorUnits(raw: number | string, currency: string, field: string, ctx: z.RefinementCtx): number | undefined {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be an integer number of minor units`,
      });
      return undefined;
    }
    if (raw < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} cannot be negative` });
      return undefined;
    }
    if (raw > MAX_MINOR_AMOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} exceeds the maximum of ${MAX_MINOR_AMOUNT} minor units — check the units`,
      });
      return undefined;
    }
    return raw;
  }

  try {
    const parsed = fromProviderDecimal(raw, currency);
    if (parsed < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} cannot be negative` });
      return undefined;
    }
    if (parsed > MAX_MINOR_AMOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} exceeds the maximum of ${MAX_MINOR_AMOUNT} minor units — check the units`,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message:
        error instanceof Error
          ? `${field}: ${error.message}`
          : `${field} is not a valid amount for ${currency}`,
    });
    return undefined;
  }
}

const baseProductSchema = z.object(productFields);

export const productCreateSchema = baseProductSchema
  .superRefine((value, ctx) => {
    const faceValue = toMinorUnits(value.faceValueMinor, value.currency, 'faceValueMinor', ctx);
    const sellingPrice = toMinorUnits(value.sellingPriceMinor, value.currency, 'sellingPriceMinor', ctx);
    // Validated here, but deliberately NOT enforced as a hard error: pricing
    // below supplier cost is a legitimate draft state, and computePricing()
    // is what reports it (with the margin rule that covers it).
    toMinorUnits(value.supplierCostMinor ?? 0, value.currency, 'supplierCostMinor', ctx);

    if (faceValue !== undefined && faceValue <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['faceValueMinor'],
        message: 'faceValueMinor must be greater than zero',
      });
    }
    if (sellingPrice !== undefined && sellingPrice <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sellingPriceMinor'],
        message:
          'sellingPriceMinor must be greater than zero — this catalog sells at a markup, so the price is never zero',
      });
    }
  })
  .transform((value): ProductCreateInput => {
    const currency = value.currency;
    return {
      slug: value.slug,
      productName: value.productName,
      brand: value.brand,
      category: value.category,
      region: value.region ?? 'US',
      description: value.description ?? null,
      imageUrl: value.imageUrl ?? null,
      currency,
      faceValueMinor: toMinorUnitsStrict(value.faceValueMinor, currency),
      sellingPriceMinor: toMinorUnitsStrict(value.sellingPriceMinor, currency),
      supplierCostMinor: toMinorUnitsStrict(value.supplierCostMinor ?? 0, currency),
      deliveryMethod: value.deliveryMethod ?? DeliveryMethod.EMAIL,
      metadata: (value.metadata as Record<string, unknown> | null | undefined) ?? null,
      status: value.status,
    };
  });

export const productUpdateSchema = baseProductSchema
  .partial()
  .superRefine((value, ctx) => {
    const currency = value.currency ?? 'USD';
    if (value.faceValueMinor !== undefined) toMinorUnits(value.faceValueMinor, currency, 'faceValueMinor', ctx);
    if (value.sellingPriceMinor !== undefined) {
      const price = toMinorUnits(value.sellingPriceMinor, currency, 'sellingPriceMinor', ctx);
      if (price !== undefined && price <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sellingPriceMinor'],
          message: 'sellingPriceMinor must be greater than zero',
        });
      }
    }
    if (value.supplierCostMinor !== undefined) {
      toMinorUnits(value.supplierCostMinor, currency, 'supplierCostMinor', ctx);
    }
  })
  .transform((value): ProductUpdateInput => {
    const currency = value.currency;
    const out: ProductUpdateInput = {};
    if (value.slug !== undefined) out.slug = value.slug;
    if (value.productName !== undefined) out.productName = value.productName;
    if (value.brand !== undefined) out.brand = value.brand;
    if (value.category !== undefined) out.category = value.category;
    if (value.region !== undefined) out.region = value.region;
    if (value.description !== undefined) out.description = value.description ?? null;
    if (value.imageUrl !== undefined) out.imageUrl = value.imageUrl ?? null;
    if (value.currency !== undefined) out.currency = value.currency;
    if (value.faceValueMinor !== undefined) out.faceValueMinor = toMinorUnitsStrict(value.faceValueMinor, currency);
    if (value.sellingPriceMinor !== undefined) {
      out.sellingPriceMinor = toMinorUnitsStrict(value.sellingPriceMinor, currency);
    }
    if (value.supplierCostMinor !== undefined) {
      out.supplierCostMinor = toMinorUnitsStrict(value.supplierCostMinor, currency);
    }
    if (value.deliveryMethod !== undefined) out.deliveryMethod = value.deliveryMethod;
    if (value.metadata !== undefined) out.metadata = (value.metadata as Record<string, unknown> | null) ?? null;
    if (value.status !== undefined) out.status = value.status;
    return out;
  });

/**
 * The transform stage runs only after the refinement stage passed, so every
 * value reaching here is already known to parse. This is the non-`ctx` version
 * used by those transforms.
 */
function toMinorUnitsStrict(raw: number | string, currency: string | undefined): number {
  if (typeof raw === 'number') return raw;
  return fromProviderDecimal(raw, currency ?? 'USD');
}

export function formatZodError(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const existing = out[key];
    if (existing) existing.push(issue.message);
    else out[key] = [issue.message];
  }
  return out;
}

/** Throwing wrapper for API routes. Never returns a partially-valid object. */
export function parseProductCreate(data: unknown): ProductCreateInput {
  const result = productCreateSchema.safeParse(data);
  if (!result.success) {
    throw errors.validation('Invalid product', formatZodError(result.error));
  }
  return result.data;
}

export function parseProductUpdate(data: unknown): ProductUpdateInput {
  const result = productUpdateSchema.safeParse(data);
  if (!result.success) {
    throw errors.validation('Invalid product update', formatZodError(result.error));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Inventory CSV import
// ---------------------------------------------------------------------------

/** Hard caps. A feed that trips these is rejected, not silently truncated. */
export const MAX_IMPORT_ROWS = 5_000;
export const MAX_CSV_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_LINE_LENGTH = 1_024;
export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 64;
export const MAX_INSTRUCTIONS_LENGTH = 2_000;

const COLUMN_ALIASES: Record<string, readonly string[]> = {
  code: ['code', 'redeemcode', 'redeem_code', 'voucher', 'voucher_code', 'pin'],
  productId: ['productid', 'product_id', 'id'],
  sku: ['sku', 'productsku', 'product_sku', 'suppliersku', 'supplier_sku'],
  supplierId: ['supplierid', 'supplier_id', 'supplier'],
  region: ['region', 'country'],
  currency: ['currency', 'cur'],
  faceValue: ['facevalue', 'face_value', 'value', 'amount', 'denomination'],
  expiresAt: ['expiresat', 'expires_at', 'expiry', 'expiration', 'expirydate'],
  instructions: ['instructions', 'redemptioninstructions', 'redemption_instructions', 'notes'],
} as const;

type ColumnName = keyof typeof COLUMN_ALIASES;

/**
 * A validated CSV row.
 *
 * `code` is PLAINTEXT and therefore sensitive: it must be encrypted before it
 * is written (see `@/lib/crypto`) and must never be logged, returned from an
 * API, or put in an error message.
 */
export interface ParsedInventoryRow {
  code: string;
  codeFingerprint: string;
  codeLast4: string;
  productId: string | null;
  sku: string | null;
  supplierId: string | null;
  region: string | null;
  currency: string | null;
  faceValueMinor: number | null;
  expiresAt: Date | null;
  instructions: string | null;
  lineNumber: number;
}

export interface InventoryCsvError {
  lineNumber: number;
  column: string;
  message: string;
}

export interface InventoryCsvParseResult {
  rows: ParsedInventoryRow[];
  errors: InventoryCsvError[];
  totalDataRows: number;
  /** True when the file was rejected for exceeding a hard cap. */
  rejected: boolean;
  /** Header column -> canonical name, useful for telling an operator what is wrong. */
  detectedColumns: Record<string, string>;
}

/** RFC4180-ish split: quoted fields, "" escapes, CRLF or LF, optional BOM. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]/g, '');
}

function buildHeaderMap(headerFields: string[]): { index: Map<ColumnName, number>; detected: Record<string, string> } {
  const index = new Map<ColumnName, number>();
  const detected: Record<string, string> = {};

  headerFields.forEach((rawHeader, columnIndex) => {
    const header = normaliseHeader(rawHeader);
    if (header === '') return;
    detected[rawHeader.trim()] = header;
    for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES) as [ColumnName, readonly string[]][]) {
      if (index.has(canonical)) continue;
      if (aliases.some((alias) => normaliseHeader(alias) === header)) {
        index.set(canonical, columnIndex);
        break;
      }
    }
  });

  return { index, detected };
}

function parseDateField(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Import requires an HMAC key for fingerprint-based duplicate detection.
 * Absence is reported, never worked around with a fake fingerprint.
 */
function fingerprintKeyIsAvailable(): boolean {
  return Boolean(appConfig.fingerprintKey);
}

export interface ParseInventoryCsvOptions {
  maxRows?: number;
}

/**
 * Parses and validates a supplier inventory CSV.
 *
 * Columns (header aliases are accepted, matching is case- and separator-
 * insensitive): code, productId | sku, supplierId, region, currency, faceValue,
 * expiresAt, instructions.
 *
 *   - `code` is required. Everything else is optional; missing values are
 *     resolved from the Product row by the inventory module. The parser never
 *     guesses a currency.
 *   - Rows that fail validation are collected in `errors` with a line number and
 *     a column name — NEVER the code value.
 *   - Duplicate codes inside the same file are detected here via the HMAC
 *     fingerprint, before any database write.
 *   - Caps are hard rejections, not truncations: a 50k-row file returns zero
 *     rows and one error saying why.
 */
export function parseInventoryCsv(
  text: string,
  options: ParseInventoryCsvOptions = {},
): InventoryCsvParseResult {
  const maxRows = options.maxRows ?? MAX_IMPORT_ROWS;
  const result: InventoryCsvParseResult = {
    rows: [],
    errors: [],
    totalDataRows: 0,
    rejected: false,
    detectedColumns: {},
  };

  if (typeof text !== 'string' || text.trim() === '') {
    result.errors.push({ lineNumber: 0, column: 'file', message: 'The file is empty' });
    result.rejected = true;
    return result;
  }

  if (text.length > MAX_CSV_BYTES) {
    result.errors.push({
      lineNumber: 0,
      column: 'file',
      message: `File is larger than the ${MAX_CSV_BYTES}-byte import limit`,
    });
    result.rejected = true;
    return result;
  }

  const fingerprintKeyPresent = fingerprintKeyIsAvailable();
  if (!fingerprintKeyPresent) {
    result.errors.push({
      lineNumber: 0,
      column: 'file',
      message: 'FINGERPRINT_KEY (or ENCRYPTION_KEY) is NOT CONFIGURED — inventory import cannot run',
    });
    result.rejected = true;
    return result;
  }

  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r\n|\n|\r/);

  let headerMap: { index: Map<ColumnName, number>; detected: Record<string, string> } | null = null;
  const seenFingerprints = new Set<string>();
  let dataRows = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const rawLine = lines[i] ?? '';

    if (rawLine.trim() === '') continue;

    if (rawLine.length > MAX_LINE_LENGTH) {
      result.errors.push({
        lineNumber,
        column: 'row',
        message: `Row exceeds the ${MAX_LINE_LENGTH}-character limit`,
      });
      continue;
    }

    const fields = splitCsvLine(rawLine);

    if (headerMap === null) {
      headerMap = buildHeaderMap(fields);
      result.detectedColumns = headerMap.detected;
      if (!headerMap.index.has('code')) {
        result.errors.push({
          lineNumber,
          column: 'header',
          message: 'Missing required "code" column',
        });
        result.rejected = true;
        return result;
      }
      continue;
    }

    dataRows += 1;
    result.totalDataRows = dataRows;

    if (dataRows > maxRows) {
      result.rows = [];
      result.errors = [
        {
          lineNumber: 0,
          column: 'file',
          message: `File contains more than the ${maxRows}-row import limit; nothing was imported`,
        },
      ];
      result.rejected = true;
      return result;
    }

    // Captured into a const so the per-row reader below sees a non-null header
    // map: `headerMap` is a `let` mutated inside this loop, and TypeScript does
    // not carry that narrowing into a closure.
    const columns = headerMap;
    if (!columns) {
      // A data row appeared before any header row — a malformed file, not a
      // schema variation. Reject rather than guessing column meanings.
      result.errors.push({
        lineNumber,
        column: 'header',
        message: 'Data row found before a header row',
      });
      result.rejected = true;
      return result;
    }
    const read = (column: ColumnName): string => {
      const at = columns.index.get(column);
      if (at === undefined) return '';
      return (fields[at] ?? '').trim();
    };

    const rowErrors: InventoryCsvError[] = [];
    const addError = (column: string, message: string) =>
      rowErrors.push({ lineNumber, column, message });

    // --- code (never logged, never echoed into an error) --------------------
    const rawCode = read('code');
    const normalized = normalizeCode(rawCode);
    if (rawCode === '') {
      addError('code', 'code is required');
    } else if (normalized.length < MIN_CODE_LENGTH) {
      addError('code', `code must be at least ${MIN_CODE_LENGTH} characters`);
    } else if (normalized.length > MAX_CODE_LENGTH) {
      addError('code', `code must be at most ${MAX_CODE_LENGTH} characters`);
    }

    // --- identity ----------------------------------------------------------
    const productId = read('productId');
    const sku = read('sku');
    if (productId === '' && sku === '') {
      addError('productId', 'either productId or sku is required');
    }

    // --- region / currency -------------------------------------------------
    const region = read('region');
    if (region !== '' && !/^[A-Za-z]{2,8}$/.test(region)) {
      addError('region', 'region must be 2-8 letters, e.g. US, IN, GB');
    }

    const currencyRaw = read('currency');
    let currency: string | null = null;
    if (currencyRaw !== '') {
      if (!/^[A-Za-z]{3}$/.test(currencyRaw)) {
        addError('currency', 'currency must be a 3-letter ISO 4217 code');
      } else {
        currency = currencyRaw.toUpperCase();
      }
    }

    // --- face value --------------------------------------------------------
    const faceValueRaw = read('faceValue');
    let faceValueMinor: number | null = null;
    if (faceValueRaw !== '') {
      if (!/^\d{1,12}(\.\d{1,4})?$/.test(faceValueRaw)) {
        addError('faceValue', 'faceValue must look like 1 or 1.00');
      } else if (currency === null) {
        // Cannot convert an amount without knowing its minor unit.
        addError('currency', 'currency is required when faceValue is supplied');
      } else {
        try {
          const parsed = fromProviderDecimal(faceValueRaw, currency);
          if (parsed < 0 || parsed > MAX_MINOR_AMOUNT) {
            addError('faceValue', `faceValue must be between 0 and ${MAX_MINOR_AMOUNT} minor units`);
          } else {
            faceValueMinor = parsed;
          }
        } catch (error) {
          addError(
            'faceValue',
            error instanceof Error ? error.message : 'faceValue is not a valid amount',
          );
        }
      }
    }

    // --- expiry ------------------------------------------------------------
    const expiresRaw = read('expiresAt');
    let expiresAt: Date | null = null;
    if (expiresRaw !== '') {
      const parsed = parseDateField(expiresRaw);
      if (parsed === null) {
        addError('expiresAt', 'expiresAt must be an ISO 8601 date, e.g. 2027-01-31');
      } else {
        expiresAt = parsed;
      }
    }

    // --- instructions ------------------------------------------------------
    const instructionsRaw = read('instructions');
    if (instructionsRaw.length > MAX_INSTRUCTIONS_LENGTH) {
      addError('instructions', `instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
    }

    if (rowErrors.length > 0) {
      result.errors.push(...rowErrors);
      continue;
    }

    // From here the code is known good; it must not appear in any message.
    const fingerprint = codeFingerprint(rawCode);
    if (seenFingerprints.has(fingerprint)) {
      result.errors.push({
        lineNumber,
        column: 'code',
        message: 'duplicate code in this file (matched by fingerprint)',
      });
      continue;
    }
    seenFingerprints.add(fingerprint);

    result.rows.push({
      code: normalized,
      codeFingerprint: fingerprint,
      codeLast4: codeLast4(rawCode),
      productId: productId === '' ? null : productId,
      sku: sku === '' ? null : sku,
      supplierId: read('supplierId') || null,
      region: region === '' ? null : region.toUpperCase(),
      currency,
      faceValueMinor,
      expiresAt,
      instructions: instructionsRaw === '' ? null : instructionsRaw,
      lineNumber,
    });
  }

  if (headerMap === null) {
    result.errors.push({ lineNumber: 0, column: 'file', message: 'The file has no header row' });
    result.rejected = true;
  }

  return result;
}