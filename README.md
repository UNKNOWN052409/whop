# Phase 12 — Payment Gateway + Automated Digital-Goods Fulfillment

A digital-goods storefront that sells redeem codes and gift cards at a markup.
The customer pays, the payment is independently verified against the provider,
and the redeem code is automatically delivered to their email.

```
PRODUCT → CHECKOUT → PAYMENT → VERIFICATION → ALLOCATION → EMAIL → COMPLETED
```

**Stack:** Next.js 15 (App Router) · TypeScript · Prisma + PostgreSQL · Upstash Redis · Inngest · Whop · Amazon SES / Resend / SMTP

---

## ⚠️ The pricing rule — read this first

> **The customer pays $3 and receives a $1 redeem code.**
>
> The customer pays **more** than the face value. This is a markup business, not a discount business.

Every surface — UI, database, API, email, docs — presents it the same way:

```
Product:  $1 Digital Redeem Code
Value:    $1
Price:    $3
```

It is **never** presented as "$3 redeem code for $1". If you find that phrasing
anywhere in the codebase, it is a bug. Because the catalog sells above face
value, `discountBps()` returns a **negative** number — that is correct and
intentional, and the pricing engine does not flip the sign.

---

## Build status

Verified at time of writing:

| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** (strict + `noUncheckedIndexedAccess`) |
| `next build` | **passes** — 21 App Router routes emitted |
| `vitest run` | **144 passed**, 4 skipped |

The 4 skipped are the concurrency suite. It needs `TEST_DATABASE_URL` and skips
cleanly without it, so a green run does **not** mean the no-oversell guarantee
has been exercised. Point it at a real Postgres and re-run before trusting it:

```bash
TEST_DATABASE_URL="postgres://…" pnpm test
```

Treat that first real run as a genuine unknown, not a formality.

---

## Handling high concurrent card traffic

### The webhook does no provider I/O

The webhook used to call the Whop API inline to confirm the payment. That is the
worst possible place for it under load:

- Every webhook held a function instance **and a database connection** while
  waiting on a third party.
- Responses drifted toward Whop's 5-second budget.
- A slow upstream became a **retry storm** — Whop redelivers failed webhooks up
  to 12 times over ~3 days, so one slow second multiplied itself into the load
  that caused it.

Now the handler only verifies the signature, deduplicates, records, and enqueues.
Authoritative confirmation runs as **step 0 of the durable workflow**, where a
slow call is simply retried with backoff. The invariant is unchanged: no
inventory is released until the provider confirms, because verification still
precedes allocation.

`fulfillOrder` additionally **refuses to run** on an order whose payment is not
verified, rather than falling through silently — a paid order can never be
stranded by a bug in the caller.

### Circuit breaker

Per-operation (Whop meters 600 req/min per operation per credential), so a dead
reconciliation endpoint cannot stop customers paying. While open, calls throw
`PROVIDER_UNAVAILABLE` **without touching the network** — that is the point.

Honest limitation: it is **per-process state**. On Vercel each instance has its
own breaker, so one bad instance may still probe a dead upstream. A shared
breaker would need Redis.

### Abuse limits

`/api/checkout` is limited per-IP **and** per-email — either alone is bypassable
(rotate IPs, or many buyers behind one NAT). `/api/payments/status` gets a looser
limit because it is a polling endpoint.

The webhook limiter runs **after signature verification, never before**: an
unsigned flood is already rejected as a 400, and Whop retries from rotating
infrastructure, so keying by IP would drop legitimate retries of a real payment.

### Load testing

```bash
k6 run tests/load/checkout-flow.js          # needs BASE_URL + CONFIRM_REAL_ORDERS
```

Defaults are deliberately tiny (2 VUs / 10 iterations) because every iteration
that clears the fraud gate **creates a real order**. Raise gradually.

### Not yet verified

Nothing here has run against a live Vercel project, a real Whop account, or a
real Postgres. The checklist in `DEPLOY.md` §7 is the evidence, not the document.

---

## One inventory write path

`importInventory` in `@/inventory` is the only function that writes an
`InventoryCode` row, bumps `Product.inventoryCount`, or records an
`InventoryImportBatch`. The admin CSV importer resolves rows to products and
validates them, then calls it.

If you add an importer — a supplier API feed, say — add a *resolver* in front of
`importInventory`, not a second write path behind it. Two divergent paths plus a
third is how an inventory count stops matching reality.

---

## Keys you need to supply

The system runs and reports `NOT CONFIGURED` without these. It never fakes a
success. Copy `.env.example` to `.env.local` and fill in what you have.

### Required before taking a live order

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Vercel Postgres / Neon / Supabase — any PostgreSQL 14+ |
| `ENCRYPTION_KEY` | **Generate yourself** — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `FINGERPRINT_KEY` | Generate a second, different random value (same command) |
| `SESSION_SECRET` | Generate — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `WHOP_API_KEY` | [sandbox.whop.com/dashboard/developer](https://sandbox.whop.com/dashboard/developer) |
| `WHOP_ACCOUNT_ID` | Whop dashboard → Settings → account id (`biz_…`) |
| `WHOP_WEBHOOK_SECRET` | Whop dashboard → Developers → create webhook → **shown once** |
| Email credentials | AWS SES keys, **or** a Resend API key, **or** SMTP credentials |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | [console.upstash.com](https://console.upstash.com) |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | [app.inngest.com](https://app.inngest.com) → create app |
| `CRON_SECRET` | Any random string — you choose |

### Whop API key scopes

The key needs all of these, or checkout creation and verification will fail:

```
checkout_configuration:create      create checkout links
checkout_configuration:basic:read   read checkout metadata
payment:basic:read                 verify payments + reconcile
member:email:read                  read buyer email during reconciliation
webhook_receive:payments           receive webhooks
```

### Webhook registration

Register this URL in the Whop dashboard:

```
https://yourdomain.com/api/payments/webhook
```

Subscribe to **all seven** event families:

```
payment.succeeded   payment.failed   payment.pending   payment.canceled
refund.created      refund.updated
dispute.created     dispute.updated   dispute_alert.created
```

> There is **no** `payment.refunded` and **no** `payment.chargeback` in Whop's
> API. Refunds are `refund.created` / `refund.updated`; chargebacks are
> `dispute.created` / `dispute.updated`. Subscribing to a non-existent event
> name means chargebacks are silently never delivered to you.

---

## Local setup

```bash
pnpm install
cp .env.example .env.local      # then fill it in
pnpm db:generate
pnpm db:push                   # or: pnpm db:migrate
pnpm db:seed                   # catalog + admin, NO redeem codes
pnpm dev
```

Check what is wired up:

```bash
curl http://localhost:3000/api/health
```

This reports `REAL` / `SANDBOX` / `NOT_CONFIGURED` per integration and never
prints a secret.

---

## Why the seed creates no redeem codes

Spec §24 forbids hard-coded inventory, and §3 requires inventory from an
authorized supplier feed. Seeding fake codes would mean **selling customers
codes that do not exist**.

Import real inventory through `/admin/inventory` (CSV upload). Codes are
encrypted with AES-256-GCM on the way in, fingerprinted for duplicate detection,
and never logged or returned by any public API.

The supplier costs in `prisma/seed.ts` are **placeholders**. Replace every one
with your real contracted pricing before enabling checkout — a placeholder that
understates your cost publishes products at a margin you do not actually have.

### On sourcing gift cards

These products may only be activated if the codes came from an authorized
reseller or supplier contract. Codes obtained by scraping, from leaked voucher
dumps, or by abusing consumer accounts are stolen property; reselling them is
fraud, is chargeback-prone at a $15/dispute fee, and is a criminal offence in
most jurisdictions. The risk engine and reconciliation layer will not stop you —
this is a legal constraint, not a technical one.

---

## Architecture

```
CDN → Next.js (Vercel) → API routes
                              │
      ┌───────────────────────┼───────────────────────┐
      ↓                       ↓                       ↓
  PostgreSQL              Upstash Redis            Inngest
  (orders, inventory,     (rate limits,            (durable
   events, audit)          cache)                  workflows)
      │                                            │
      └──────────── webhook verified ──────────────┘
                              ↓
                    atomic allocation ──► email ──► COMPLETED
```

### The invariants that matter

**1. The browser is never trusted.** A frontend "payment succeeded" callback
appears nowhere in the verification path. An order reaches `PAYMENT_VERIFIED`
only via a signature-verified webhook whose amount *and* currency are then
re-confirmed against the provider's own API.

**2. One code, one customer, ever.** Inventory reservation runs in a single
transaction using `SELECT … FOR UPDATE SKIP LOCKED`, with a unique index on
`InventoryCode.orderId` as defense in depth. Under concurrency the database
itself makes double-assignment impossible.

**3. One event, one fulfillment.** `PaymentEvent.providerEventId` is unique. A
webhook delivered 10 times inserts once; the duplicates return `200` immediately
without re-fulfilling.

**4. State moves only through the transition table.** `Order.status` is never
assigned directly — `assertTransition` rejects illegal moves, which is what
makes "never skip a state" enforceable rather than aspirational.

**5. A crash never loses a paid order.** The durable queue plus the stale-lease
recovery cron means a worker dying mid-fulfillment self-heals within 5 minutes.

### Whop specifics that bite

- **Webhook HMAC key** — the raw UTF-8 bytes of the *entire* `ws_…` secret,
  prefix included. Not stripped, not base64-decoded.
- **Signed string** — `webhook-id.webhook-timestamp.raw-body`, over the exact
  received bytes. Re-serialising the JSON breaks the signature.
- **Replay window** — 300 seconds.
- **Always send `Api-Version-Date`** — without it you silently get the
  `2025-01-01` shapes, where the account field is `company_id`.

### Margin reality

Whop charges **2.7% + $0.30** per transaction (+1.5% international, +1% FX).
On a low-ticket SKU the fixed component dominates: at $3, the fee is ~18% of
revenue. A **$15 dispute fee** against that is the real exposure, not the
processing rate. The admin dashboard reports *net* margin from
`Payment.netAmountMinor`, not gross, so this is visible rather than discovered.

---

## Money handling

All money is an **integer count of minor units** (cents) plus a currency code.
Never floats. Whop returns decimal *strings* (`"29.99"`), converted via
`fromProviderDecimal()` which parses exactly and rejects malformed or
over-precise input rather than silently rounding.

---

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm test` | Test suite (DB-dependent suites skip without `TEST_DATABASE_URL`) |
| `pnpm typecheck` | TypeScript strict check |
| `pnpm db:seed` | Catalog + admin |
| `pnpm inngest:dev` | Local durable-worker runner |

---

## Known limits

- **Redis absent** → rate limiting degrades to per-instance memory. Documented,
  logged, not silent.
- **Inngest absent** → fulfillment is *not* queued; `/api/health` reports
  `NOT CONFIGURED`. It does not quietly run inline and pretend.
- **Webhook gaps are recovered by reconciliation**, not prevented. If webhooks
  stop for longer than the look-back window, reconcile from the provider's
  transaction list instead.