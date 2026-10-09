# Load tests — `POST /api/checkout`

This directory contains a [k6](https://k6.io/) script that measures how the
checkout endpoint behaves under a small amount of concurrent traffic.

It is deliberately conservative. There is no "safe mode" flag and no dry run,
because a flag like that gets set once, forgotten, and then the script is
pointed at production by someone in a hurry.

---

## ⚠️ This creates real records. Read this before running anything.

Every iteration that gets past body validation and the stock check writes to
the database your target points at:

| Row | When it is written |
| --- | --- |
| `Order` | Always, **before** the fraud gate runs. A held order is still a real order. |
| `IdempotencyKey` | Always. |
| `FraudEvent` | Always. |
| `Payment` + a real checkout configuration at the payment provider | Only for iterations that pass the fraud gate. |

So: **N iterations ⇒ roughly N real orders, and up to N real provider
checkouts.** The script does not delete them. Silently deleting financial
records is a worse idea than leaving them for you to inspect.

Every iteration that clears the fraud gate creates a **REAL ORDER** and a real
checkout session at the provider. The defaults are 10 iterations. That is not an
accident.

The customer email used by the script is always at `@loadtest.invalid`, a domain
reserved by [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) that can never
resolve, so no message can reach a real inbox even if the deployment is
configured to send one.

### Never point this at production

It needs a **preview deployment URL**. A preview is cheap, disposable, and
configured against the payment provider's sandbox. Production is neither.

The script also refuses to start if the target reports `payments: REAL`
(i.e. `WHOP_ENVIRONMENT=production`) unless you explicitly set
`ALLOW_REAL_PROVIDER=1`. A preview deployment that is wired to the live
merchant account is still a live-money target, and the script will say so.

---

## Prerequisites

1. **k6 installed** — <https://grafana.com/docs/k6/latest/set-up/install-k6/>.
   Not an npm dependency; it is a standalone binary. `k6 version` should work.
2. **A preview deployment** that is up and configured against the payment
   provider's **sandbox**. Verify by hand first:

   ```bash
   curl -s https://<your-preview-url>/api/health | jq '.integrations'
   ```

   You want `payments: "SANDBOX"` and `database.ok: true`. If `payments` is
   `"NOT_CONFIGURED"`, stop: the run will measure a 503 that returns in
   single-digit milliseconds and tell you nothing at all.
3. **A product to buy.** An `ACTIVE` product with at least one `AVAILABLE`,
   unexpired redeem code. If stock is zero every request 409s before it does
   any real work, and you will be timing a rejection.

   ```sql
   SELECT p.id, p.slug, p.inventoryCount
     FROM "Product" p
    WHERE p.status = 'ACTIVE' AND p."inventoryCount" > 0
    LIMIT 10;
   ```

   Pick one whose id you are willing to burn stock on. Checkout does not
   allocate a code — that happens in fulfillment, after payment — but keep the
   id handy anyway.

---

## Running it

```bash
cd tests/load

BASE_URL="https://<project>-<hash>-<team>.vercel.app" \
PRODUCT_ID="<the product id from step 3>" \
CONFIRM_REAL_ORDERS="i-understand-this-creates-real-orders" \
k6 run checkout-flow.js
```

PowerShell (this repo is developed on Windows):

```powershell
$env:BASE_URL     = "https://<project>-<hash>-<team>.vercel.app"
$env:PRODUCT_ID   = "<the product id from step 3>"
$env:CONFIRM_REAL_ORDERS = "i-understand-this-creates-real-orders"
k6 run checkout-flow.js
```

`CONFIRM_REAL_ORDERS` must match exactly. It exists so that running a load test
is always a deliberate act.

---

## Safe starting numbers

| Variable | Default | What it means |
| --- | --- | --- |
| `ITERATIONS` | `10` | **Total requests across the whole run.** This is the number of real orders you will create. |
| `VUS` | `2` | Concurrent virtual users. |
| `MAX_DURATION` | `3m` | Hard ceiling; the scenario stops early once iterations are done. |
| `P95_BUDGET_MS` | `2000` | p95 latency threshold. |
| `P99_BUDGET_MS` | `5000` | p99 latency threshold. |
| `BASE_URL` | — | Required. Preview URL. |
| `PRODUCT_ID` | — | Required. |
| `ALLOW_REAL_PROVIDER` | — | Set to `1` to load-test a target whose provider is `REAL`. Think hard first. |

The progression, in order:

```bash
# 1. Smoke — 5 requests, 1 VU. Is the endpoint answering JSON at all?
ITERATIONS=5 VUS=1 k6 run checkout-flow.js

# 2. A real, small look — 20 requests, 4 VUs. 20 real orders.
ITERATIONS=20 VUS=4 k6 run checkout-flow.js

# 3. Only once 2 is green and you understand the numbers:
#    100 requests, 10 VUs. 100 real orders, 100 provider checkouts.
ITERATIONS=100 VUS=10 k6 run checkout-flow.js
```

Every step up is roughly a 5x jump in the number of rows you are about to
write. There is no reason to jump from 10 to 1000.

---

## What to watch

### The three that matter

**1. `checkout_json_body` — must be exactly `rate==1.0`.**

Every response, success or handled failure, must be `application/json` and must
parse. A failure here means the framework itself broke: an unhandled throw, a
serverless function timeout, an edge 502, a dropped connection. This is the
assertion that catches a platform fault hiding behind a plausible latency
number, and it is the reason this script exists.

**2. `http_req_duration{expected_response:true}` — p95 under `P95_BUDGET_MS`.**

2000 ms is a deliberately generous budget for a cold-starting serverless
function that opens a Prisma connection, claims an idempotency key, writes two
rows, evaluates fraud, and makes one outbound HTTPS call to the payment
provider. Treat it as a budget, not a target.

Cold starts dominate at these volumes. If p95 is 1.8 s but p50 is 120 ms, you
are measuring Vercel booting a function, not your code. Re-run with a higher
`ITERATIONS` so the ratio of cold to warm requests drops, or read p50/p90
rather than p95.

**3. `orders_created`.**

This is the number that matters most and is easiest to ignore. It should equal
`ITERATIONS` on a clean run.

| Counters | Reading |
| --- | --- |
| `orders_created` = ITERATIONS | Clean run. |
| `held_or_out_of_stock` > 0 | Some requests 409'd. Either the fraud engine held them, or stock ran out. Check `SELECT status, count(*) FROM "Order" WHERE ... GROUP BY status`. **A run where the fraud gate held requests is not a clean low-risk run.** |
| `rate_limited` > 0 | Redis is throttling you. The measured latency is the limiter's latency. Raise the limit or accept the number. |
| `provider_not_configured` > 0 | The preflight missed something. The run measured 503s, not checkout. Ignore its latency numbers entirely. |
| `bad_request` > 0 | The script's payload was rejected. That is a bug in this script. |
| `server_errors` > 0 | Anything the route does not handle. Investigate before doing anything else. |

### Also worth a glance

- **`checkout_latency`** — the script's own trend. It is the same number as
  `http_req_duration`, kept under a stable name so it is easy to graph in a
  dashboard later. Read either, not both.
- **`checks`** — should be `rate>0.99`; in practice it should be `1.000`.
- **`iterations`** — if the scenario finished before `MAX_DURATION`, the run was
  short. Raising VUs without raising ITERATIONS just means more concurrency for
  the same number of real orders.
- **`http_req_failed`** — should be effectively zero. It counts statuses the
  script did *not* declare expected, which is everything from a 402 to an edge
  502 to a timeout.

---

## What this script does **not** prove

Being explicit, because these are the things people assume a "checkout load
test" covers:

- **No payment completes.** No card is charged. The provider's hosted page is
  never visited. This measures order *creation*.
- **No redeem code is allocated.** `reserveCodes` runs in the fulfillment
  pipeline and needs a verified payment webhook first.
- **Fraud traffic is not representative.** Each VU presents a distinct email
  and IP, so nearly everything is `ALLOW`. This is not a test of the fraud
  engine under load.
- **The database is barely touched.** At 10 iterations you are not measuring
  connection-pool exhaustion, lock contention, or anything the no-oversell
  guarantee depends on.

For allocation correctness under real concurrency, use
`tests/concurrency.test.ts` against a real Postgres. That is a much better
tool than anything you could push through this endpoint, because it can drive
20 genuine transactions at 5 rows of stock and assert that exactly 5 succeed.

---

## Cleaning up afterwards

The script intentionally leaves the rows it created. To inspect them:

```sql
SELECT status, count(*), min("createdAt") AS first, max("createdAt") AS last
  FROM "Order"
 WHERE "customerEmailNormalized" LIKE '%@loadtest.invalid'
   AND "createdAt" > now() - interval '1 day'
 GROUP BY status;
```

To delete them — review the row count before running the `DELETE`, and do it
only against a preview's database:

```sql
DELETE FROM "PaymentEvent"   WHERE "orderId" IN (SELECT id FROM "Order" WHERE "customerEmailNormalized" LIKE '%@loadtest.invalid' AND "createdAt" > now() - interval '1 day');
DELETE FROM "Payment"        WHERE "orderId" IN (...);
DELETE FROM "OrderStateTransition" WHERE "orderId" IN (...);
DELETE FROM "IdempotencyKey" WHERE "orderId" IN (...);
DELETE FROM "Order"          WHERE "customerEmailNormalized" LIKE '%@loadtest.invalid' AND "createdAt" > now() - interval '1 day';
```

Checkout never allocates inventory, so **no `InventoryCode` row is affected by a
load run**. There is nothing to restock afterwards.

Checkout configurations created at the provider do expire on their own, and this
script does not cancel them. If a preview is pointed at a real merchant account,
that is another reason `ALLOW_REAL_PROVIDER` should stay unset.