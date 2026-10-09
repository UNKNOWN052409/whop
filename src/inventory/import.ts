/**
 * Inventory import for authorized supplier feeds.
 *
 * The ONLY way a redeem code enters this system. Spec §24 forbids hard-coded
 * inventory and §3 requires supplier-sourced stock, so there is no seed data,
 * no demo data, and no dev shortcut here — you import codes you actually own.
 *
 * ONE WRITE PATH. The admin CSV importer (`src/app/admin/inventory/page.tsx`)
 * does its own CSV-specific work — resolving `sku` to a product, checking the
 * supplier exists, refusing to guess a currency — and then hands resolved rows
 * to `importInventory` here for the write. Adding a third importer (a supplier
 * API feed, say) means adding a resolver in front of this function, never a
 * second copy of it.
 *
 * SECURITY: plaintext codes exist in memory for exactly as long as it takes to
 * encrypt them. They are never written to the database, never returned to the
 * caller, and never placed in an error message or a log line. An import failure
 * reports a ROW NUMBER and a REASON, never the code that failed.
 */

import { Prisma } from '@prisma/client';
import { prisma, withTransaction } from '@/db/prisma';
// The audit writer lives under the admin tree because every current mutation
// does, but the same-transaction rule it encodes is a property of the WRITE, not
// of the panel: an import driven by a supplier feed later must be auditable
// just the same, so the call belongs here rather than in the caller.
import { appendAudit, actorLabel } from '@/app/admin/_lib/audit';
import { codeFingerprint, codeLast4, encrypt, normalizeCode } from '@/lib/crypto';
import { logger } from '@/lib/logger';

export interface ImportRow {
  /** 1-based row number in the source file, for operator feedback. */
  row: number;
  productId: string;
  code: string;
  /**
   * Every optional field below accepts `null` as well as `undefined`: a CSV row
   * that simply had no value in a column is `null` in every parser, and making
   * callers translate that is a chance for one of them to translate it wrongly.
   * An omitted or null value falls back to the product's own — never to a zero
   * or a default currency.
   */
  region?: string | null;
  currency?: string | null;
  faceValueMinor?: number | null;
  supplierId?: string | null;
  externalRef?: string | null;
  expiresAt?: Date | null;
  redemptionInstructions?: string | null;
  /**
   * Alias for `redemptionInstructions`, matching the CSV column name the admin
   * importer reads. Both are accepted so a caller cannot silently drop
   * redemption instructions by picking the other spelling; `redemptionInstructions`
   * wins if both are set.
   */
  instructions?: string | null;
}

/**
 * Product facts a caller has already resolved in batch.
 *
 * Passed in so a resolver can do one `findMany` for a whole file instead of the
 * one-lookup-per-row loop below. Omitting it costs queries, not correctness.
 */
export interface ImportProductFacts {
  id: string;
  currency: string;
  region: string;
  faceValueMinor: number;
}

/**
 * Lifecycle of an import batch.
 *
 * `status` is a free-text column on `InventoryImportBatch`, so these values are
 * a convention rather than a database constraint. They are exported as a type
 * so both writers — this function and any future importer — cannot drift into
 * inventing a fourth spelling. `processing` is only ever visible to a reader
 * inside the import transaction; the batch row and its final status are written
 * together or not at all.
 */
export type ImportBatchStatus = 'processing' | 'completed' | 'completed_with_errors';

export interface ImportOptions {
  /** Products the caller already resolved, keyed by product id. */
  products?: ReadonlyMap<string, ImportProductFacts>;
  /**
   * Rows the caller's own validation refused before the write — an unknown SKU,
   * a supplier that does not exist, a face value with no currency.
   *
   * These never reach the code path below, but the batch row has to describe the
   * FILE the operator uploaded, not the subset that happened to be writable. So
   * they are folded into `totalRows`, `errorRows` and `errors` here rather than
   * being lost, and they cost one extra array instead of a second batch row.
   * Must contain row numbers and reasons only, never code material.
   */
  rejectedRows?: ImportRowResult[];
  /**
   * Who to attribute the import to in the audit trail. Omit for an unattended
   * feed and no audit row is written; supply it and exactly one audit row is
   * written, inside the same transaction as the rows themselves.
   */
  actor?: { userId: string; email: string };
}

export type ImportRowStatus = 'imported' | 'duplicate' | 'invalid';

export interface ImportRowResult {
  row: number;
  status: ImportRowStatus;
  /** Safe to surface to an operator. Never contains code material. */
  reason?: string;
}

export interface ImportResult {
  batchId: string;
  total: number;
  imported: number;
  duplicates: number;
  invalid: number;
  results: ImportRowResult[];
}

/** Codes far outside any realistic length are rejected before touching crypto. */
const MIN_CODE_LENGTH = 4;
const MAX_CODE_LENGTH = 128;

/**
 * Bound on the duplicate pre-check query. A file at the 5,000-row import cap
 * would otherwise put 5,000 bind parameters in one statement; chunking keeps the
 * statement size sane without changing the answer.
 */
const FINGERPRINT_LOOKUP_CHUNK = 1_000;

/** Audit metadata is a count summary. It must never grow a field with code material in it. */
interface ImportAuditCounts {
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  invalidRows: number;
  skippedRows: number;
  errorRows: number;
}

export async function importInventory(
  rows: ImportRow[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  // Rows the caller refused before we were called. Seeded first so the batch's
  // counts describe the whole file rather than the writable remainder.
  const results: ImportRowResult[] = [...(options.rejectedRows ?? [])];
  let invalid = results.length;

  const invalidRow = (row: number, reason: string): ImportRowResult => {
    invalid += 1;
    return { row, status: 'invalid', reason };
  };

  let imported = 0;
  let duplicates = 0;
  /** Every row in the source file, including the ones rejected upstream. */
  const totalRows = rows.length + (options.rejectedRows?.length ?? 0);

  // --- Validation and resolution, before any write ------------------------
  //
  // Nothing here touches the database except one batched product lookup for the
  // ids the caller did not pre-resolve. A row that fails a check is reported
  // and dropped, not written — the whole point of running this outside the
  // transaction is that a malformed row cannot poison the good ones.
  type Candidate = { source: ImportRow; normalized: string; fingerprint: string };
  const candidates: Candidate[] = [];
  /** Fingerprints already seen in THIS file, so a repeated code is a duplicate. */
  const seenFingerprints = new Set<string>();

  for (const row of rows) {
    // Normalised here as well as by any upstream parser: a caller that hands
    // over a raw `" abcd-efgh "` must still get the same fingerprint, the same
    // ciphertext length and the same duplicate verdict as everyone else.
    const normalized = normalizeCode(row.code ?? '');

    if (normalized.length < MIN_CODE_LENGTH || normalized.length > MAX_CODE_LENGTH) {
      results.push(
        invalidRow(row.row, `code length must be ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH} characters after normalisation`),
      );
      continue;
    }

    if (!row.productId) {
      results.push(invalidRow(row.row, 'productId is required'));
      continue;
    }

    let fingerprint: string;
    try {
      fingerprint = codeFingerprint(normalized);
    } catch (error) {
      // Most likely FINGERPRINT_KEY is unset. That is a configuration fault, not
      // a bad row, but reporting it per row keeps the promise that a failed
      // import names rows and reasons and never a code.
      results.push(
        invalidRow(row.row, error instanceof Error ? error.message : 'code could not be fingerprinted'),
      );
      continue;
    }

    // Duplicate WITHIN the file. Left to the database this would be caught by
    // the unique index too, but only after the insert, and the loser could not be
    // attributed to a row number.
    if (seenFingerprints.has(fingerprint)) {
      duplicates += 1;
      results.push({
        row: row.row,
        status: 'duplicate',
        reason: 'this code appears more than once in this import',
      });
      continue;
    }
    seenFingerprints.add(fingerprint);

    candidates.push({ source: row, normalized, fingerprint });
  }

  // Products the caller did not resolve for us, in ONE query rather than one per
  // row. `select` includes faceValueMinor because a row that omits a face value
  // inherits the PRODUCT's — writing `0` instead would silently make free codes
  // look worthless to every downstream margin calculation.
  const productsById = new Map<string, ImportProductFacts>(options.products ?? []);
  const unresolvedIds = [
    ...new Set(candidates.map((c) => c.source.productId).filter((id) => !productsById.has(id))),
  ];
  if (unresolvedIds.length > 0) {
    const found = await prisma.product.findMany({
      where: { id: { in: unresolvedIds } },
      select: { id: true, currency: true, region: true, faceValueMinor: true },
    });
    for (const product of found) productsById.set(product.id, product);
  }

  type PreparedRow = {
    source: ImportRow;
    normalized: string;
    fingerprint: string;
    product: ImportProductFacts;
  };
  const prepared: PreparedRow[] = [];

  for (const candidate of candidates) {
    const product = productsById.get(candidate.source.productId);
    if (!product) {
      results.push(invalidRow(candidate.source.row, 'unknown productId'));
      continue;
    }
    prepared.push({ ...candidate, product });
  }

  // --- The write ----------------------------------------------------------
  //
  // One transaction: batch row, the codes, every Product.inventoryCount bump,
  // the batch's final status and the audit row all commit or roll back
  // together. A count that disagrees with the InventoryCode table is a
  // storefront selling stock it does not have, and a half-applied import is the
  // surest way to produce one.
  const outcome = await withTransaction(async (tx) => {
    const batch = await tx.inventoryImportBatch.create({
      data: { totalRows, status: 'processing' satisfies ImportBatchStatus },
    });

    // Pre-check the (productId, fingerprint) pairs so the counts reported back
    // are the real ones. The fingerprint is a keyed HMAC, so it is safe to query
    // with and useless to anyone who steals the table. This is a REPORTING
    // aid: the unique index below is the authority if two imports race.
    const fingerprints = [...new Set(prepared.map((row) => row.fingerprint))];
    const existingKeys = new Set<string>();
    for (let offset = 0; offset < fingerprints.length; offset += FINGERPRINT_LOOKUP_CHUNK) {
      const chunk = fingerprints.slice(offset, offset + FINGERPRINT_LOOKUP_CHUNK);
      const existing = await tx.inventoryCode.findMany({
        where: {
          productId: { in: [...new Set(prepared.map((row) => row.source.productId))] },
          codeFingerprint: { in: chunk },
        },
        select: { productId: true, codeFingerprint: true },
      });
      for (const entry of existing) existingKeys.add(`${entry.productId}:${entry.codeFingerprint}`);
    }

    const inserts: Prisma.InventoryCodeCreateManyInput[] = [];
    const createdPerProduct = new Map<string, number>();

    for (const row of prepared) {
      if (existingKeys.has(`${row.product.id}:${row.fingerprint}`)) {
        duplicates += 1;
        results.push({
          row: row.source.row,
          status: 'duplicate',
          // The (productId, codeFingerprint) unique index fired: this exact code
          // is already in stock for this product. This is the duplicate guard
          // that prevents selling the same code twice.
          reason: 'this code is already in inventory for this product',
        });
        continue;
      }

      inserts.push({
        productId: row.product.id,
        supplierId: row.source.supplierId ?? null,
        externalRef: row.source.externalRef ?? null,
        // Encrypted at rest. Nothing downstream reads this column directly.
        codeCiphertext: encrypt(row.normalized),
        codeLast4: codeLast4(row.normalized),
        // HMAC, so the unique index below catches duplicates WITHOUT the
        // database ever needing to decrypt anything.
        codeFingerprint: row.fingerprint,
        region: row.source.region ?? row.product.region,
        currency: row.source.currency ?? row.product.currency,
        // The PRODUCT's face value, never 0: a zero-value code reads as free
        // stock and quietly destroys the COGS figures this store is built on.
        faceValueMinor: row.source.faceValueMinor ?? row.product.faceValueMinor,
        expiresAt: row.source.expiresAt ?? null,
        redemptionInstructions: row.source.redemptionInstructions ?? row.source.instructions ?? null,
        status: 'AVAILABLE',
        importBatchId: batch.id,
      });
      createdPerProduct.set(row.product.id, (createdPerProduct.get(row.product.id) ?? 0) + 1);
    }

    let created = 0;
    if (inserts.length > 0) {
      const write = await tx.inventoryCode.createMany({
        data: inserts,
        // Belt and braces: the pre-check above gives exact counts, but if another
        // import lands between the check and this insert, the unique index wins.
        skipDuplicates: true,
      });

      // Count what actually landed rather than what we meant to write.
      // `skipDuplicates` means `write.count` can be lower than `inserts.length`,
      // and incrementing inventoryCount by the larger number is how a store
      // ends up advertising stock it never received. Grouping by the batch id
      // is exact under concurrency and costs one query.
      const landed = await tx.inventoryCode.groupBy({
        by: ['productId'],
        where: { importBatchId: batch.id },
        _count: { _all: true },
      });
      createdPerProduct.clear();
      for (const entry of landed) {
        createdPerProduct.set(entry.productId, entry._count._all);
      }
      created = write.count;

      // Rows lost to a racing import. They cannot be attributed to a row number
      // after the fact, so they are counted, not listed.
      duplicates += inserts.length - created;
    }

    imported += created;

    for (const [productId, count] of createdPerProduct) {
      await tx.product.update({
        where: { id: productId },
        data: { inventoryCount: { increment: count } },
      });
    }

    const errorRows = invalid;
    const skippedRows = duplicates + invalid;
    const status: ImportBatchStatus =
      errorRows > 0 ? 'completed_with_errors' : 'completed';

    await tx.inventoryImportBatch.update({
      where: { id: batch.id },
      data: {
        importedRows: created,
        skippedRows,
        errorRows,
        status,
        // Only the rows that did NOT land — an all-success import stores nothing
        // here rather than 100 rows saying "imported". Row numbers, statuses and
        // reasons only: no code, no fingerprint, no file contents.
        errors:
          results.some((row) => row.status !== 'imported')
            ? (results
                .filter((row) => row.status !== 'imported')
                .slice(0, 100)
                .map(({ row, status: rowStatus, reason }) => ({
                  row,
                  status: rowStatus,
                  reason: reason ?? null,
                })) as Prisma.InputJsonValue)
            : undefined,
      },
    });

    if (options.actor) {
      const counts: ImportAuditCounts = {
        totalRows,
        importedRows: created,
        duplicateRows: duplicates,
        invalidRows: invalid,
        skippedRows,
        errorRows,
      };
      await appendAudit(tx, {
        actor: actorLabel(options.actor),
        actorId: options.actor.userId,
        action: 'inventory.import.completed',
        entity: 'InventoryImportBatch',
        entityId: batch.id,
        // Counts only. No code, no fingerprint, no file contents. Written inside
        // the import transaction so it cannot be lost to exactly the rollback it
        // exists to explain.
        metadata: { ...counts },
      });
    }

    return { batchId: batch.id, created };
  });

  logger.info('Inventory import completed', {
    batchId: outcome.batchId,
    total: totalRows,
    imported,
    duplicates,
    invalid,
  });

  return {
    batchId: outcome.batchId,
    total: totalRows,
    imported,
    duplicates,
    invalid,
    results,
  };
}
