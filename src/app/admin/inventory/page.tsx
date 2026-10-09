import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Alert } from '@/components/alert';
import { prisma } from '@/db/prisma';
import { errors, isAppError } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { importInventory } from '@/inventory';
import type { ImportProductFacts, ImportRow } from '@/inventory';
import {
  parseInventoryCsv,
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
} from '@/catalog/validation';
import type { ParsedInventoryRow } from '@/catalog/validation';
import { assertMutationOrigin, requirePageSession, requireSession } from '@/app/admin/_lib/auth';
import {
  badgeClass,
  displayPriceValue,
  emailTone,
  formatCount,
  formatDateTime,
  humaniseToken,
  inventoryTone,
  maskedCode,
} from '@/app/admin/_lib/format';
import { loadInventoryOverview } from '@/app/admin/_lib/queries';

/**
 * INVENTORY.
 *
 * Counts by status, live reservations, delivery status, and the supplier CSV
 * import.
 *
 * PLAINTEXT CODES
 * ---------------
 * This page handles plaintext redeem codes on the way IN and must never let one
 * out. Three separate guarantees, because any one of them alone is not enough:
 *
 *   1. The parser (`@/catalog/validation`) reports bad rows as a line number and
 *      a column name. It never echoes the code.
 *   2. This page never renders a code. Codes leave as `codeLast4` through
 *      `maskedCode()`, including in the import result summary.
 *   3. `importInventory` writes the audit row, and its metadata contains counts
 *      only — never a row's code, even though `appendAudit` would redact a
 *      `code`-named key anyway.
 *
 * IMPORT WRITE PATH
 * -----------------
 * ONE PATH. This page resolves CSV rows to products and validates them, then
 * hands the survivors to `importInventory` in `@/inventory`, which owns every
 * write to `InventoryCode` and `Product.inventoryCount` plus the batch and audit
 * rows — all inside a single transaction.
 *
 * This page used to keep a second, inline copy of that write. Two copies meant
 * two places to keep encryption, duplicate detection, batch status and count
 * arithmetic in agreement, and the copies had already drifted. If you are adding
 * an importer (a supplier API feed, say), add a resolver in front of
 * `importInventory`, not another write path behind it.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Inventory' };

function messageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

interface ImportSummary {
  ok: boolean;
  message: string;
  imported?: number;
  skipped?: number;
  errors?: { lineNumber: number; column: string; message: string }[];
}

export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('ADMIN', '/admin/inventory');

  const params = await searchParams;
  const notice = typeof params.notice === 'string' ? params.notice : '';
  const actionError = typeof params.error === 'string' ? params.error : '';
  const errorLines = typeof params.lines === 'string' ? params.lines : '';

  const overview = await loadInventoryOverview();

  // Delivery status has no read model in `_lib/queries.ts`, and an operator
  // asking "did the codes actually reach anybody" needs it, so it is read here
  // rather than left out. Counts only — no addresses, no message bodies.
  const deliveryCounts = await prisma.delivery.groupBy({
    by: ['status'],
    _count: { _all: true },
    orderBy: { status: 'asc' },
  });

  async function importCsv(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'inventory.importCsv' });

    let outcome: ImportSummary;
    try {
      const file = formData.get('file');
      if (!(file instanceof File) || file.size === 0) {
        throw errors.validation('Choose a CSV file to import');
      }
      if (file.size > MAX_CSV_BYTES) {
        throw errors.validation(
          `That file is ${formatCount(file.size)} bytes; the import limit is ${formatCount(MAX_CSV_BYTES)}`,
        );
      }

      const text = await file.text();
      const parsed = parseInventoryCsv(text);

      if (parsed.rejected) {
        // A rejected file is rejected WHOLE. Importing the "good" rows of a file
        // that tripped a hard cap is how a truncated feed looks like a complete
        // one.
        outcome = {
          ok: false,
          message: 'The file was rejected in full — nothing was imported.',
          imported: 0,
          skipped: parsed.totalDataRows,
          errors: parsed.errors.slice(0, 25),
        };
      } else if (parsed.errors.length > 0) {
        outcome = {
          ok: false,
          message: `${formatCount(parsed.errors.length)} row problem(s) found; nothing was imported. Fix the file and upload it again.`,
          imported: 0,
          skipped: parsed.totalDataRows - parsed.rows.length,
          errors: parsed.errors.slice(0, 25),
        };
      } else if (parsed.rows.length === 0) {
        outcome = {
          ok: false,
          message: 'The file contained a header but no data rows.',
          imported: 0,
          skipped: 0,
        };
      } else {
        outcome = await performImport(parsed.rows, actor);
      }
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/inventory');
    const query = new URLSearchParams();
    query.set(outcome.ok ? 'notice' : 'error', outcome.message);
    if (outcome.imported !== undefined) query.set('imported', String(outcome.imported));
    if (outcome.skipped !== undefined) query.set('skipped', String(outcome.skipped));
    if (outcome.errors && outcome.errors.length > 0) {
      query.set(
        'lines',
        outcome.errors.map((e) => `line ${e.lineNumber} (${e.column}): ${e.message}`).join(' · '),
      );
    }
    redirect(`/admin/inventory?${query.toString()}`);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-fg">Inventory</h1>

      {notice ? (
        <div className="mt-4">
          <Alert variant="success" title="Import finished">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-4">
          <Alert variant="error" title="Import refused">
            <p>{actionError}</p>
            {errorLines ? <p className="mt-2 font-mono text-xs">{errorLines}</p> : null}
          </Alert>
        </div>
      ) : null}

      {/* --- Counts by status --------------------------------------------- */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">
          Codes by status
        </h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {overview.snapshot.byStatus.length === 0 ? (
            <p className="text-sm text-muted">No codes have been imported.</p>
          ) : (
            overview.snapshot.byStatus.map((entry) => (
              <span key={entry.status} className={badgeClass(inventoryTone(entry.status))}>
                {humaniseToken(entry.status)}: {formatCount(entry.count)}
              </span>
            ))
          )}
        </div>
        <p className="mt-2 text-xs text-subtle">
          {formatCount(overview.snapshot.total)} total ·{' '}
          {formatCount(overview.snapshot.reservedForOrders)} reserved or assigned ·{' '}
          {formatCount(overview.snapshot.expiredReservations)} reservation lease(s) expired and
          reclaimable
        </p>
        {overview.snapshot.expiredReservations > 0 ? (
          <div className="mt-3">
            <Alert variant="warning" title="Stock is being held by expired leases">
              <p>
                A crashed or abandoned checkout keeps its code reserved until the lease expires. The
                inventory reaper reclaims them; between the expiry and the reaper those codes are
                unsellable.
              </p>
            </Alert>
          </div>
        ) : null}
      </section>

      {/* --- Delivery status ---------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">
          Delivery status (all orders)
        </h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {deliveryCounts.length === 0 ? (
            <p className="text-sm text-muted">No delivery has been queued yet.</p>
          ) : (
            deliveryCounts.map((entry) => (
              <span key={entry.status} className={badgeClass(emailTone(entry.status))}>
                {humaniseToken(entry.status)}: {formatCount(entry._count._all)}
              </span>
            ))
          )}
        </div>
        <p className="mt-2 text-xs text-subtle">
          A FAILED or SUPPRESSED delivery with a paid order is a customer who has money and no code.
          Find them under Orders → Email: Failed.
        </p>
      </section>

      {/* --- Per product -------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">By product</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Product</th>
                <th scope="col" className="px-4 py-3 font-medium">Terms</th>
                <th scope="col" className="px-4 py-3 font-medium">Available</th>
                <th scope="col" className="px-4 py-3 font-medium">Reserved</th>
                <th scope="col" className="px-4 py-3 font-medium">Assigned</th>
                <th scope="col" className="px-4 py-3 font-medium">Delivered</th>
                <th scope="col" className="px-4 py-3 font-medium">Revoked</th>
                <th scope="col" className="px-4 py-3 font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {overview.byProduct.map((product) => (
                <tr key={product.productId} id={`product-${product.productId}`}>
                  <td className="px-4 py-3">
                    <span className="font-medium">{product.productName}</span>
                    <span className="ml-2 text-xs text-subtle">{product.slug}</span>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {displayPriceValue(
                      product.sellingPriceMinor,
                      product.faceValueMinor,
                      product.currency,
                    )}
                  </td>
                  <td
                    className={`px-4 py-3 tabular-nums ${
                      product.available === 0 ? 'text-danger' : product.available <= 5 ? 'text-warning' : ''
                    }`}
                  >
                    {formatCount(product.available)}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{formatCount(product.reserved)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatCount(product.assigned)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatCount(product.delivered)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatCount(product.revoked)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatCount(product.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- Reservations ------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">
          Live reservations ({formatCount(overview.reservations.length)})
        </h2>
        <p className="mt-1 text-xs text-subtle">
          Codes only ever appear here masked. There is no action on this panel that reveals a full
          code — delivery to the customer is the only channel.
        </p>
        {overview.reservations.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing is currently reserved.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Code</th>
                  <th scope="col" className="px-4 py-3 font-medium">Product</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Order</th>
                  <th scope="col" className="px-4 py-3 font-medium">Face value</th>
                  <th scope="col" className="px-4 py-3 font-medium">Reserved</th>
                  <th scope="col" className="px-4 py-3 font-medium">Lease expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {overview.reservations.map((row) => {
                  const expired =
                    row.reservationExpiresAt !== null && row.reservationExpiresAt < new Date();
                  return (
                    <tr key={row.id}>
                      <td className="px-4 py-3 font-mono">{maskedCode(row.codeLast4)}</td>
                      <td className="px-4 py-3">
                        {row.productName}
                        {row.supplierName ? (
                          <span className="ml-2 text-xs text-subtle">{row.supplierName}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <span className={badgeClass(inventoryTone(row.status))}>
                          {humaniseToken(row.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {row.orderReference ? (
                          <Link
                            href={`/admin/orders/${row.orderReference}`}
                            className="font-mono text-xs underline hover:text-accent"
                          >
                            {row.orderReference}
                          </Link>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {formatMoney(row.faceValueMinor, row.currency)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {formatDateTime(row.reservedAt)}
                      </td>
                      <td
                        className={`px-4 py-3 text-xs ${expired ? 'text-warning' : 'text-muted'}`}
                      >
                        {formatDateTime(row.reservationExpiresAt)}
                        {expired ? ' · expired' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- Import ------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">
          Import a supplier CSV
        </h2>
        <div className="mt-2 rounded-lg border border-line bg-surface-2 p-4">
          <p className="text-sm text-muted">
            Columns (header aliases accepted, case- and separator-insensitive):{' '}
            <code>code</code> (required), <code>productId</code> or <code>sku</code> (one
            required), <code>supplierId</code>, <code>region</code>, <code>currency</code>,{' '}
            <code>faceValue</code>, <code>expiresAt</code>, <code>instructions</code>. At most{' '}
            {formatCount(MAX_IMPORT_ROWS)} rows and {formatCount(MAX_CSV_BYTES)} bytes.
          </p>
          <p className="mt-2 text-xs text-subtle">
            The file contains plaintext codes. It is parsed in memory, every code is encrypted
            before it is written, and no row — valid or not — is ever echoed back to this page.
            A file with any row error is rejected in full rather than partially applied.
          </p>

          <form action={importCsv} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="inventory-csv" className="text-sm font-medium text-fg">
                CSV file
              </label>
              <input
                id="inventory-csv"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                className="text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-xs file:text-fg"
              />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-strong"
            >
              Import codes
            </button>
          </form>
        </div>

        {overview.batches.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">File</th>
                  <th scope="col" className="px-4 py-3 font-medium">Rows</th>
                  <th scope="col" className="px-4 py-3 font-medium">Imported</th>
                  <th scope="col" className="px-4 py-3 font-medium">Skipped</th>
                  <th scope="col" className="px-4 py-3 font-medium">Errors</th>
                  <th scope="col" className="px-4 py-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {overview.batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="px-4 py-3 text-xs">{batch.fileName ?? batch.id}</td>
                    <td className="px-4 py-3 tabular-nums">{formatCount(batch.totalRows)}</td>
                    <td className="px-4 py-3 tabular-nums text-success">
                      {formatCount(batch.importedRows)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted">
                      {formatCount(batch.skippedRows)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-danger">
                      {formatCount(batch.errorRows)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {formatDateTime(batch.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * CSV half of the import: turn parsed rows into something `importInventory` will
 * accept, and report what it refused.
 *
 * This function deliberately does NOT write anything. Resolution and validation
 * are CSV concerns — a supplier API feed has its own notion of what a product
 * reference means — so they stay here; the INSERT, the `inventoryCount` bump,
 * the batch bookkeeping and the audit row are the canonical write path's job and
 * live in `importInventory` alone.
 *
 * Module-level on purpose (see the products page for why): a Server Action's
 * closure is serialised, and this function takes its data as an argument rather
 * than closing over the page's render scope.
 *
 * Order of operations:
 *   1. resolve every row to a product (by id, else by supplier SKU), in batched
 *      queries — one for all ids, one for all SKUs, one for all suppliers;
 *   2. apply the CSV-only rules: the supplier must exist, and a face value must
 *      arrive with a currency;
 *   3. hand the survivors to `importInventory`, which encrypts and writes them.
 *
 * No code reaches this function's return value. Errors carry a line number, a
 * column name and a reason — the same vocabulary the parser uses.
 */
async function performImport(
  rows: ParsedInventoryRow[],
  actor: { userId: string; email: string },
): Promise<ImportSummary> {
  const problems: { lineNumber: number; column: string; message: string }[] = [];

  // Products referenced by explicit id.
  const explicitIds = [...new Set(rows.map((row) => row.productId).filter((id): id is string => !!id))];
  const productsById = new Map<string, ImportProductFacts>();
  if (explicitIds.length > 0) {
    const found = await prisma.product.findMany({
      where: { id: { in: explicitIds } },
      select: { id: true, currency: true, faceValueMinor: true, region: true },
    });
    for (const product of found) productsById.set(product.id, product);
  }

  // Products referenced by supplier SKU through ProductProvider.
  const skus = [...new Set(rows.map((row) => row.sku).filter((sku): sku is string => !!sku))];
  const productsBySku = new Map<string, ImportProductFacts>();
  if (skus.length > 0) {
    const found = await prisma.productProvider.findMany({
      where: { supplierSku: { in: skus } },
      select: {
        supplierSku: true,
        product: { select: { id: true, currency: true, faceValueMinor: true, region: true } },
      },
    });
    for (const entry of found) productsBySku.set(entry.supplierSku, entry.product);
  }

  // Suppliers referenced by id — resolved in ONE query, not one per row.
  const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter((id): id is string => !!id))];
  const knownSuppliers = new Set<string>();
  if (supplierIds.length > 0) {
    const foundSuppliers = await prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true },
    });
    for (const supplier of foundSuppliers) knownSuppliers.add(supplier.id);
  }

  const importable: ImportRow[] = [];

  for (const row of rows) {
    const product = row.productId ? productsById.get(row.productId) : row.sku ? productsBySku.get(row.sku) : undefined;
    if (!product) {
      problems.push({
        lineNumber: row.lineNumber,
        column: 'productId',
        message: row.sku
          ? `No product matches supplier SKU "${row.sku}"`
          : 'No product matches that productId',
      });
      continue;
    }

    const supplierId = row.supplierId ?? null;
    if (supplierId && !knownSuppliers.has(supplierId)) {
      problems.push({ lineNumber: row.lineNumber, column: 'supplierId', message: 'Unknown supplier' });
      continue;
    }

    // Never guess a currency: fall back to the product's, never to USD.
    const currency = row.currency ?? product.currency;
    if (row.faceValueMinor !== null && row.currency === null) {
      problems.push({
        lineNumber: row.lineNumber,
        column: 'currency',
        message: 'currency is required when faceValue is supplied',
      });
      continue;
    }

    importable.push({
      row: row.lineNumber,
      productId: product.id,
      // Plaintext, for the length of this call only. `importInventory`
      // normalises, encrypts and fingerprints it; it is never stored, logged or
      // returned from here.
      code: row.code,
      supplierId,
      region: row.region ?? product.region,
      currency,
      faceValueMinor: row.faceValueMinor ?? product.faceValueMinor,
      expiresAt: row.expiresAt,
      redemptionInstructions: row.instructions,
    });
  }

  if (importable.length === 0) {
    // Nothing resolved, so nothing was written — no batch, no codes, no audit
    // row. Saying so is more useful than an import of zero.
    return {
      ok: false,
      message: 'No rows could be resolved to a product; nothing was imported.',
      imported: 0,
      skipped: rows.length,
      errors: problems.slice(0, 25),
    };
  }

  // Pre-resolved products are handed over so the canonical path skips its
  // per-row `findUnique`; it still owns the face-value and currency fallbacks,
  // which resolve to the same values this page computed above. The rows refused
  // above ride along so the batch row the operator sees describes the file, not
  // just the rows that were writable.
  const result = await importInventory(importable, {
    products: new Map([...productsById, ...productsBySku]),
    rejectedRows: problems.map((problem) => ({
      row: problem.lineNumber,
      status: 'invalid' as const,
      reason: problem.message,
    })),
    actor,
  });

  // The canonical path's per-row verdicts come back as row numbers and reasons.
  // Fold them into this page's error report shape; none of them carry code
  // material, which is why passing them through to the operator is safe.
  for (const row of result.results) {
    if (row.status === 'imported') continue;
    if (problems.some((problem) => problem.lineNumber === row.row)) continue;
    problems.push({
      lineNumber: row.row,
      column: 'code',
      message: row.reason ?? row.status,
    });
  }

  // `skipped` counts rows that were well-formed but already in stock;
  // `problems.length` counts rows that could never be imported. Keeping them
  // apart means the two numbers in the summary add up to the file instead of
  // the rejected rows being counted twice.
  return {
    ok: result.imported > 0,
    message:
      `Imported ${formatCount(result.imported)} code(s)` +
      (result.duplicates > 0 ? `, skipped ${formatCount(result.duplicates)}` : '') +
      (problems.length > 0 ? `, ${formatCount(problems.length)} row(s) rejected` : '') +
      '.',
    imported: result.imported,
    skipped: result.duplicates,
    errors: problems.slice(0, 25),
  };
}
