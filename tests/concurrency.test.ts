/**
 * Concurrency guarantees, exercised against a REAL Postgres.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Every guarantee below is enforced by the DATABASE — `SELECT ... FOR UPDATE
 * SKIP LOCKED`, the unique index on `InventoryCode.orderId`, the conditional
 * `UPDATE` in the release reaper. None of them can be observed by a unit test
 * with a mocked Prisma client, because a mock has no locks and no unique
 * indexes. Until this file runs against a real database, the no-oversell
 * promise in spec §11/§21 is an unverified claim. This suite is the proof.
 *
 * SKIPPING, NOT FAILING
 * ---------------------
 * The whole file is `describe.skipIf(!process.env.TEST_DATABASE_URL)`. With no
 * database the suite is skipped — it does not error, and it does not "pass" a
 * weaker assertion. A CI box with no Postgres still runs the other 144 tests.
 *
 * NOTHING IS MOCKED
 * -----------------
 * These tests call `reserveCodes`, `markAssigned`, `markDelivered`,
 * `revokeCode` and `releaseExpiredReservations` exactly as production does. The
 * only writes performed directly through Prisma are FIXTURE writes (creating a
 * product, its codes, its orders) and one deliberate lease-ageing update that
 * stands in for "a worker crashed and the lease ran out". No production code
 * path is stubbed, intercepted or injected.
 *
 * NO PLAINTEXT CODE EVER LEAVES THIS FILE
 * ----------------------------------------
 * The synthetic fixture codes are generated here, encrypted immediately, and
 * only row ids are ever asserted on or logged. Nothing resembling a plaintext
 * redeem code is written to the database, to stdout, or into an assertion
 * message.
 */

import { randomBytes } from 'node:crypto';
import {
  InventoryStatus,
  OrderStatus,
  ProductStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isAppError } from '@/lib/errors';
import { codeFingerprint, codeLast4, encrypt } from '@/lib/crypto';
import { generateOrderReference } from '@/lib/ids';
import type { ReserveCodesResult } from '@/inventory';
import { disconnectDatabase, getPrisma } from './helpers/db';

// Type-only imports are erased by the compiler, so the modules they name are
// never evaluated. See `subject()` for why evaluation is deferred.
type InventoryModule = typeof import('@/inventory');
type AvailabilityModule = typeof import('@/catalog/availability');

interface Subject {
  prisma: PrismaClient;
  inventory: InventoryModule;
  availability: AvailabilityModule;
}

/**
 * Every application module that transitively imports `@/db/prisma` is loaded
 * LAZILY, inside this function.
 *
 * `new PrismaClient()` validates `DATABASE_URL` at construction time and
 * throws if it is absent. A top-level `import { reserveCodes } from
 * '@/inventory'` would therefore make the entire file fail to COLLECT on a
 * database-free machine — turning a clean skip into a red run. Deferred loading
 * is what makes `describe.skipIf` meaningful.
 */
let cachedSubject: Subject | null = null;

async function subject(): Promise<Subject> {
  if (cachedSubject) return cachedSubject;
  const [prisma, inventory, availability] = await Promise.all([
    getPrisma(),
    import('@/inventory'),
    import('@/catalog/availability'),
  ]);
  cachedSubject = { prisma, inventory, availability };
  return cachedSubject;
}

/**
 * Unique per run, so two runs (or two developers sharing one test database)
 * never collide on the unique `Product.slug` / `Order.reference` indexes and
 * never mistake each other's rows for their own.
 */
const RUN = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/** Every product this run created, deleted in `afterAll`. */
const createdProductIds: string[] = [];

const MINOR = 100; // face value, minor units
const CHARGED = 300; // selling price, minor units
const COST = 50; // supplier cost, minor units

// --- Fixtures ---------------------------------------------------------------

/**
 * `noUncheckedIndexedAccess` makes `array[0]` a `T | undefined`, which is
 * correct and, in a fixture helper, unhelpful: it would force every call site
 * to re-handle a case that only happens when seeding itself failed. This turns
 * that into a named failure with a useful message instead.
 */
function requireAt<T>(items: readonly T[], index: number, what: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Fixture is missing ${what} at index ${index}: created ${items.length} row(s)`);
  }
  return value;
}

interface SeededProduct {
  productId: string;
  codeIds: string[];
}

/**
 * A product with `codeCount` AVAILABLE codes, priced in integer minor units.
 * Every code is synthetic, encrypted before it reaches the database, and given
 * a distinct fingerprint so the (productId, codeFingerprint) unique index does
 * not reject the batch.
 */
async function seedProductWithCodes(
  prisma: PrismaClient,
  label: string,
  codeCount: number,
): Promise<SeededProduct> {
  const product = await prisma.product.create({
    data: {
      slug: `concurrency-${label}-${RUN}`.toLowerCase(),
      productName: `Concurrency fixture (${label})`,
      brand: 'TestOnly',
      category: 'TestOnly',
      region: 'US',
      currency: 'USD',
      faceValueMinor: MINOR,
      sellingPriceMinor: CHARGED,
      supplierCostMinor: COST,
      discountBps: 6667,
      marginBps: 8333,
      status: ProductStatus.ACTIVE,
      inventoryCount: codeCount,
    },
    select: { id: true },
  });
  createdProductIds.push(product.id);

  const codeIds: string[] = [];
  for (let index = 0; index < codeCount; index += 1) {
    // Obviously synthetic and unique per run. Never logged, never asserted on.
    const synthetic = `K6LOAD-${RUN}-${label}-${index}`;
    const created = await prisma.inventoryCode.create({
      data: {
        productId: product.id,
        codeCiphertext: encrypt(synthetic),
        codeLast4: codeLast4(synthetic),
        codeFingerprint: codeFingerprint(synthetic),
        region: 'US',
        currency: 'USD',
        faceValueMinor: MINOR,
        status: InventoryStatus.AVAILABLE,
      },
      select: { id: true },
    });
    codeIds.push(created.id);
  }

  return { productId: product.id, codeIds };
}

/** Distinct orders for the same product, each in a state the pipeline expects. */
async function seedOrders(
  prisma: PrismaClient,
  productId: string,
  count: number,
): Promise<string[]> {
  const rows: Prisma.OrderCreateManyInput[] = Array.from({ length: count }, (_, index) => ({
    reference: generateOrderReference(),
    status: OrderStatus.PAYMENT_VERIFIED,
    productId,
    quantity: 1,
    productName: 'Concurrency fixture',
    faceValueMinor: MINOR,
    sellingPriceMinor: CHARGED,
    unitPriceMinor: CHARGED,
    currency: 'USD',
    region: 'US',
    customerEmail: `buyer-${index}-${RUN}@loadtest.invalid`,
    customerEmailNormalized: `buyer-${index}-${RUN}@loadtest.invalid`,
    totalMinor: CHARGED,
  }));
  await prisma.order.createMany({ data: rows });

  const orders = await prisma.order.findMany({
    where: { productId },
    select: { id: true },
  });
  return orders.map((order) => order.id);
}

/**
 * Age every reservation lease on this product into the past.
 *
 * This is the state a crashed worker leaves behind: a RESERVED row whose lease
 * has run out. It is the ONLY reason the release reaper has anything to do, and
 * it is what makes tests 3 and 4 non-vacuous — the reaper demonstrably runs and
 * demonstrably matches its predicate, so a code that survives it survived on
 * merit, not because the sweep never fired.
 */
async function ageLeases(prisma: PrismaClient, productId: string): Promise<void> {
  await prisma.inventoryCode.updateMany({
    where: { productId },
    data: { reservationExpiresAt: new Date(Date.now() - 60_000) },
  });
}

function isFulfilled(
  result: PromiseSettledResult<ReserveCodesResult>,
): result is PromiseFulfilledResult<ReserveCodesResult> {
  return result.status === 'fulfilled';
}

/** Error codes of every rejected promise, de-duplicated. Never includes text. */
function rejectionCodes(results: readonly PromiseSettledResult<unknown>[]): string[] {
  const codes = new Set<string>();
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    const reason: unknown = result.reason;
    if (isAppError(reason)) {
      codes.add(reason.code);
    } else {
      throw new Error(
        `A reservation failed with a non-AppError (${reason instanceof Error ? reason.name : typeof reason}). ` +
          'A raw driver error escaping the inventory module is itself a defect.',
      );
    }
  }
  return [...codes].sort();
}

// --- Suite ------------------------------------------------------------------

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'inventory concurrency guarantees (real PostgreSQL)',

  () => {
    beforeAll(async () => {
      const { prisma } = await subject();
      // Fail loudly and specifically if the schema was never pushed, instead of
      // surfacing "table InventoryCode does not exist" from inside test 1.
      await prisma.product.count();
    });

    afterAll(async () => {
      if (createdProductIds.length === 0) return;
      const ids = [...createdProductIds];
      try {
        const { prisma } = await subject();
        // Codes first (they hold the FK to Order), then orders, then products.
        await prisma.inventoryCode.deleteMany({ where: { productId: { in: ids } } });
        await prisma.order.deleteMany({ where: { productId: { in: ids } } });
        await prisma.product.deleteMany({ where: { id: { in: ids } } });
      } catch {
        // A schema that was never pushed has nothing to clean up. A cleanup
        // failure must not turn a green run red after the assertions passed.
      } finally {
        const prisma = cachedSubject?.prisma ?? null;
        await disconnectDatabase(prisma);
      }
    });

    it('N concurrent reservations for fewer codes than requests never oversell', async () => {
      const { prisma, inventory, availability } = await subject();

      const CODE_COUNT = 5;
      const REQUEST_COUNT = 20;

      const { productId, codeIds } = await seedProductWithCodes(
        prisma,
        'oversell',
        CODE_COUNT,
      );
      const orderIds = await seedOrders(prisma, productId, REQUEST_COUNT);
      expect(orderIds).toHaveLength(REQUEST_COUNT);

      // Every promise is launched before any is awaited, so all 20 transactions
      // genuinely contend on the same rows. This is the interleaving the
      // `FOR UPDATE SKIP LOCKED` clause exists to survive.
      const results = await Promise.allSettled(
        orderIds.map((orderId) =>
          inventory.reserveCodes({ orderId, productId, quantity: 1, ttlSeconds: 300 }),
        ),
      );

      const granted = results.filter(isFulfilled);
      const grantedCodeIds = granted.flatMap((result) => result.value.codes.map((c) => c.id));

      // --- The core guarantee: never more than the stock on hand. ---------
      expect(grantedCodeIds).toHaveLength(CODE_COUNT);

      // --- ...never the same code twice, to anyone. ------------------------
      expect(new Set(grantedCodeIds).size).toBe(CODE_COUNT);
      for (const id of grantedCodeIds) {
        expect(codeIds, 'a code outside this product was handed out').toContain(id);
      }

      // --- ...and exactly the requests that could be served were served. ---
      // "Not fewer" matters as much as "not more": a lost code is a refund.
      expect(granted).toHaveLength(CODE_COUNT);
      expect(results).toHaveLength(REQUEST_COUNT);
      expect(rejectionCodes(results)).toEqual(['INSUFFICIENT_INVENTORY']);

      // --- The database agrees, read back from the rows themselves. --------
      const bound = await prisma.inventoryCode.findMany({
        where: { productId },
        select: { id: true, orderId: true, status: true },
      });
      expect(bound).toHaveLength(CODE_COUNT);

      const boundToOrder = bound.filter((row) => row.orderId !== null);
      expect(boundToOrder).toHaveLength(CODE_COUNT);
      expect(new Set(boundToOrder.map((row) => row.orderId)).size).toBe(CODE_COUNT);
      for (const row of boundToOrder) {
        expect(row.status).toBe(InventoryStatus.RESERVED);
      }

      // --- Storefront counter: zero left, and not drifted from the rows. ---
      const snapshot = await availability.getAvailability(productId);
      expect(snapshot).not.toBeNull();
      if (!snapshot) return;
      expect(snapshot.availableCount).toBe(0);
      expect(snapshot.reservedCount).toBe(CODE_COUNT);
      expect(snapshot.productInventoryCount).toBe(0);
      expect(snapshot.drifted).toBe(false);
      expect(await availability.countAvailableInventory(productId)).toBe(0);
    });

    it('the same webhook delivered 10 times yields exactly one allocation', async () => {
      const { prisma, inventory, availability } = await subject();

      const DELIVERY_COUNT = 10;
      const CODE_COUNT = 5;

      const { productId } = await seedProductWithCodes(prisma, 'replay', CODE_COUNT);
      const orderIds = await seedOrders(prisma, productId, 1);
      const orderId = requireAt(orderIds, 0, 'order');

      // Ten providers deliveries of one event. They are the same call with the
      // same orderId — which is exactly what a retried Inngest step, a replayed
      // webhook and a manual requeue all produce.
      const results = await Promise.allSettled(
        Array.from({ length: DELIVERY_COUNT }, () =>
          inventory.reserveCodes({ orderId, productId, quantity: 1, ttlSeconds: 300 }),
        ),
      );

      // --- Exactly one code row is bound to the order. --------------------
      const bound = await prisma.inventoryCode.findMany({
        where: { orderId },
        select: { id: true, status: true },
      });
      expect(bound).toHaveLength(1);
      const boundRow = requireAt(bound, 0, 'bound code');
      expect(boundRow.status).toBe(InventoryStatus.RESERVED);

      // --- Every caller that resolved saw the SAME single code. -------------
      const granted = results.filter(isFulfilled);
      expect(granted.length).toBeGreaterThan(0);
      for (const result of granted) {
        expect(result.value.codes).toHaveLength(1);
        expect(requireAt(result.value.codes.map((c) => c.id), 0, 'reserved code')).toBe(
          boundRow.id,
        );
      }

      // --- Losers fail as typed application errors, never as driver noise. -
      // CRITICAL_FULFILLMENT_ERROR is the unique-index path (a second row tried
      // to bind the same orderId); INSUFFICIENT_INVENTORY is the loser that saw
      // every remaining row locked. Both are correct, neither is a crash.
      const codes = rejectionCodes(results);
      for (const code of codes) {
        expect(['CRITICAL_FULFILLMENT_ERROR', 'INSUFFICIENT_INVENTORY']).toContain(code);
      }

      // --- The other codes were never touched. -----------------------------
      const all = await prisma.inventoryCode.findMany({
        where: { productId },
        select: { id: true, orderId: true },
      });
      expect(all).toHaveLength(CODE_COUNT);
      expect(all.filter((row) => row.orderId !== null)).toHaveLength(1);

      // --- The denormalised counter was decremented exactly ONCE. -----------
      // This is the assertion that catches "allocated twice, counted twice",
      // which the row-level check alone would miss.
      const snapshot = await availability.getAvailability(productId);
      if (!snapshot) throw new Error('fixture product vanished');
      expect(snapshot.availableCount).toBe(CODE_COUNT - 1);
      expect(snapshot.productInventoryCount).toBe(CODE_COUNT - 1);
      expect(snapshot.drifted).toBe(false);
    });

    it('a delivered code never returns to AVAILABLE', async () => {
      const { prisma, inventory } = await subject();

      const { productId } = await seedProductWithCodes(prisma, 'delivered', 2);
      const orderIds = await seedOrders(prisma, productId, 2);
      const deliveredOrderId = requireAt(orderIds, 0, 'delivered order');
      const controlOrderId = requireAt(orderIds, 1, 'control order');

      await inventory.reserveCodes({
        orderId: deliveredOrderId,
        productId,
        quantity: 1,
        ttlSeconds: 300,
      });
      // `markAssigned` returns `{ assigned: count }`, not a bare count (see
      // src/inventory/allocate.ts: `Promise<{ assigned: number }>`). Assert the
      // whole documented object rather than only the field, so the shape is
      // pinned too and a future signature change cannot slip past unnoticed.
      expect(await inventory.markAssigned(deliveredOrderId)).toEqual({ assigned: 1 });

      // A second order whose code is deliberately left RESERVED with an aged
      // lease. This is the control: it proves the reaper below really did fire
      // and really did reclaim, so the DELIVERED row surviving it is a result
      // and not an accident.
      await inventory.reserveCodes({
        orderId: controlOrderId,
        productId,
        quantity: 1,
        ttlSeconds: 300,
      });
      await ageLeases(prisma, productId);

      // Ids are captured BEFORE the sweep, because the sweep unlinks rows from
      // their order and "the row with no orderId afterwards" is not a safe way
      // to identify anything.
      const deliveredId = requireAt(
        (
          await prisma.inventoryCode.findMany({
            where: { orderId: deliveredOrderId },
            select: { id: true },
          })
        ).map((row) => row.id),
        0,
        'delivered code',
      );
      const controlId = requireAt(
        (
          await prisma.inventoryCode.findMany({
            where: { orderId: controlOrderId },
            select: { id: true },
          })
        ).map((row) => row.id),
        0,
        'control code',
      );

      expect(await inventory.markDelivered(deliveredOrderId)).toBe(1);

      const beforeRelease = await prisma.inventoryCode.findUnique({
        where: { id: deliveredId },
        select: { status: true },
      });
      expect(beforeRelease?.status).toBe(InventoryStatus.DELIVERED);

      await inventory.releaseExpiredReservations();

      const after = await prisma.inventoryCode.findMany({
        where: { productId },
        select: { id: true, status: true, orderId: true, deliveredAt: true, revokedAt: true },
      });

      const deliveredRow = after.find((row) => row.id === deliveredId);
      expect(deliveredRow, 'the delivered code was deleted rather than kept').toBeDefined();
      if (!deliveredRow) return;
      expect(deliveredRow.orderId).toBe(deliveredOrderId);
      expect(deliveredRow.status).toBe(InventoryStatus.DELIVERED);
      expect(deliveredRow.revokedAt).toBeNull();
      expect(deliveredRow.deliveredAt).not.toBeNull();

      // Control: the reaper ran and did reclaim the merely-RESERVED sibling.
      const controlRow = after.find((row) => row.id === controlId);
      expect(controlRow, 'the reaper released nothing; this test proved nothing').toBeDefined();
      if (controlRow) {
        expect(controlRow.status).toBe(InventoryStatus.AVAILABLE);
        expect(controlRow.orderId).toBeNull();
      }

      // The delivered code is still gone from the sellable pool, exactly once.
      expect(after.filter((row) => row.status === InventoryStatus.DELIVERED)).toHaveLength(1);
      expect(after.filter((row) => row.status === InventoryStatus.AVAILABLE)).toHaveLength(1);
      expect(after.filter((row) => row.status === InventoryStatus.RESERVED)).toHaveLength(0);
    });

    it('revoke is terminal', async () => {
      const { prisma, inventory } = await subject();

      const { productId } = await seedProductWithCodes(prisma, 'revoked', 2);
      const orderIds = await seedOrders(prisma, productId, 2);
      const revokedOrderId = requireAt(orderIds, 0, 'revoked order');
      const controlOrderId = requireAt(orderIds, 1, 'control order');

      await inventory.reserveCodes({
        orderId: revokedOrderId,
        productId,
        quantity: 1,
        ttlSeconds: 300,
      });
      await inventory.reserveCodes({
        orderId: controlOrderId,
        productId,
        quantity: 1,
        ttlSeconds: 300,
      });

      const boundBefore = await prisma.inventoryCode.findMany({
        where: { productId },
        select: { id: true, orderId: true },
      });
      const targetId = requireAt(
        boundBefore
          .filter((row) => row.orderId === revokedOrderId)
          .map((row) => row.id),
        0,
        'revocation target',
      );
      const controlId = requireAt(
        boundBefore
          .filter((row) => row.orderId === controlOrderId)
          .map((row) => row.id),
        0,
        'control code',
      );
      expect(targetId).not.toBe(controlId);

      await ageLeases(prisma, productId);

      // Chargeback / supplier recall. The code is burned.
      expect(await inventory.revokeCode(targetId, 'chargeback (fixture)')).toBe(true);

      await inventory.releaseExpiredReservations();

      const after = await prisma.inventoryCode.findMany({
        where: { productId },
        select: { id: true, status: true, orderId: true, revokedAt: true },
      });

      const revokedRow = after.find((row) => row.id === targetId);
      expect(revokedRow, 'the revoked code was deleted rather than revoked').toBeDefined();
      if (revokedRow) {
        expect(revokedRow.status).toBe(InventoryStatus.REVOKED);
        expect(revokedRow.orderId).toBeNull();
        expect(revokedRow.revokedAt).not.toBeNull();
      }

      // Terminal means terminal: a second revoke is a no-op, not a re-issue.
      expect(await inventory.revokeCode(targetId, 'duplicate revoke')).toBe(false);

      // Control: the reaper really did run. A REVOKED row surviving it is a
      // guarantee; a reaper that never fired would prove nothing at all. The
      // control is tracked by id, because revocation also leaves a row with no
      // orderId and "the unlinked row" would otherwise be ambiguous.
      const controlRow = after.find((row) => row.id === controlId);
      expect(controlRow, 'the reaper released nothing; this test proved nothing').toBeDefined();
      if (controlRow) {
        expect(controlRow.status).toBe(InventoryStatus.AVAILABLE);
        expect(controlRow.orderId).toBeNull();
      }

      // A revoked code is consumed, not returned: it is absent from the pool
      // permanently and no sweep in this suite can put it back.
      expect(after.filter((row) => row.status === InventoryStatus.AVAILABLE)).toHaveLength(1);
      expect(after.filter((row) => row.status === InventoryStatus.REVOKED)).toHaveLength(1);
      expect(after.filter((row) => row.status === InventoryStatus.RESERVED)).toHaveLength(0);

      // And it stays that way across a second reaper pass.
      await inventory.releaseExpiredReservations();
      const stillRevoked = await prisma.inventoryCode.findUnique({
        where: { id: targetId },
        select: { status: true },
      });
      expect(stillRevoked?.status).toBe(InventoryStatus.REVOKED);
    });
  },
);