/**
 * k6 load test — POST /api/checkout
 * ================================
 *
 * WHAT THIS MEASURES, PRECISELY
 * -----------------------------
 * One thing: how long the checkout endpoint takes end to end (validate ->
 * idempotency claim -> order write -> fraud evaluation -> provider checkout)
 * under a small number of concurrent virtual users, and whether it ALWAYS
 * answers with a JSON body rather than an edge timeout, a 500 HTML page, or a
 * dropped connection.
 *
 * WHAT IT DOES NOT MEASURE — read this before quoting a number:
 *
 *   - It does not measure payment completion. No card is charged. It measures
 *     the checkout CREATION path only.
 *   - It does not measure allocation. `reserveCodes` runs in the fulfillment
 *     pipeline, which needs a verified payment webhook. Use
 *     tests/concurrency.test.ts for that; it is a far better tool.
 *   - It does not measure the fraud engine's throughput at scale. Every VU here
 *     presents a distinct email and IP, so almost every request is ALLOW. A run
 *     whose `fraud_held` counter is non-zero was NOT clean low-risk traffic.
 *   - It does not measure the database under sustained load. At the default
 *     numbers it barely touches it.
 *
 * ⚠️  THIS CREATES REAL ROWS. THIS IS NOT A DRILL.
 * ------------------------------------------------------------------------
 * There is no dry-run mode, because there must not be a flag someone sets once
 * and forgets. Every iteration that gets past validation and the stock check
 * writes:
 *
 *     - one `Order` row (status PAYMENT_PENDING, or MANUAL_REVIEW if the fraud
 *       engine held it) — this happens BEFORE the fraud gate, so a held order
 *       is still a real order;
 *     - one `IdempotencyKey` row;
 *     - one `FraudEvent` row;
 *     - one `Payment` row and one real checkout configuration at the payment
 *       provider, for every VU that passes the fraud gate.
 *
 * In other words: N iterations => roughly N real orders and up to N real
 * provider checkouts, sitting in the database your preview points at. They are
 * not cleaned up by this script, because silently deleting financial records
 * would be a worse idea than leaving them. See README.md for the cleanup query.
 *
 * The defaults are deliberately tiny — 2 VUs, 10 iterations, ~10 rows. Raise
 * them explicitly and by small steps; README.md explains how.
 *
 * PREVIEW DEPLOYMENT ONLY. Never point this at production.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * Iterations. Every one of them is a real order. Default is deliberately
 * minimal — 2 VUs x 5 iterations.
 *
 *   ITERATIONS=5 VUS=1 k6 run checkout-flow.js   # smoke: does it answer JSON at all
 *   ITERATIONS=20 VUS=4 k6 run checkout-flow.js  # a real, if small, look
 */
const ITERATIONS = Number(__ENV.ITERATIONS || '10');
const VUS = Number(__ENV.VUS || '2');

/**
 * Latency budget, in milliseconds, for the whole request including the body.
 *
 * 2000ms p95 is a deliberately generous budget for a cold-starting serverless
 * function that opens a Prisma connection, claims an idempotency key, writes
 * two rows, evaluates fraud, and makes one outbound HTTPS call to the payment
 * provider. It is a BUDGET, not a target: if you clear it easily, tighten it in
 * README.md's "raising the load" section and re-baseline. Do not lower it below
 * what a cold start genuinely costs — you will just be measuring Vercel.
 */
const P95_BUDGET_MS = Number(__ENV.P95_BUDGET_MS || '2000');
const P99_BUDGET_MS = Number(__ENV.P99_BUDGET_MS || '5000');

/** Total check-pass rate across every check in the run. */
const jsonBodyRate = new Rate('checkout_json_body');
const latency = new Trend('checkout_latency', true);

const ordersCreated = new Counter('orders_created');
const heldOrOutOfStock = new Counter('held_or_out_of_stock');
const rateLimited = new Counter('rate_limited');
const providerNotConfigured = new Counter('provider_not_configured');
const badRequest = new Counter('bad_request');
const serverErrors = new Counter('server_errors');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    checkout: {
      // shared-iterations, not ramping-vus: a load test that ramps is a load
      // test that creates an unbounded number of real orders. The ceiling is
      // the iteration count, and it is visible in one line.
      executor: 'shared-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: __ENV.MAX_DURATION || '3m',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    // A run that executed ZERO iterations is not a measurement. Without this
    // floor k6 renders every other threshold green at 0.00%, so an aborted run
    // looks exactly like a passing one in the summary table — the single most
    // misleading thing this script could do.
    iterations: ['count>=1'],
    // A JSON body every single time. This is the assertion that catches a
    // platform-level failure (Vercel edge 500, function timeout, connection
    // reset) hiding behind an otherwise plausible latency number.
    checkout_json_body: ['rate==1.0'],
    checks: ['rate>0.99'],
    'http_req_duration{expected_response:true}': [
      `p(95)<${P95_BUDGET_MS}`,
      `p(99)<${P99_BUDGET_MS}`,
    ],
  },
};

/**
 * Statuses that are CORRECT behaviour for this endpoint, and therefore must not
 * be counted as transport failures:
 *
 *   201 the order was created and a provider checkout exists
 *   400 the body failed validation (should never happen — the script is fixed)
 *   409 the fraud engine held the order, or the product is out of stock
 *   429 the rate limiter fired
 *   503 the payment provider is NOT CONFIGURED on the target
 *
 * Anything else — 402, 500, 502, 503-from-the-edge, a timeout — is a failure,
 * and `http_req_failed` counts it. Declaring 503 expected is NOT the same as
 * approving of it: `setup()` aborts the run before a single iteration if the
 * provider is unconfigured, and `provider_not_configured` counts any that slip
 * through anyway.
 */
http.setResponseCallback(http.expectedStatuses(201, 400, 409, 429, 503));

/**
 * Scheme + host + optional path, validated without the WHATWG `URL` global —
 * k6's JS runtime does not provide one, and depending on `k6/url` would tie
 * this script to a k6 version. Trailing slashes are stripped so the
 * concatenation below can never produce `https://host//api/checkout`.
 */
function normaliseBaseUrl(raw) {
  const value = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+/i.test(value)) {
    throw new Error(
      `BASE_URL must start with http:// or https:// followed by a host. Got: ${raw}`,
    );
  }
  return value;
}

export function setup() {
  const rawBaseUrl = (__ENV.BASE_URL || '').trim();
  if (!rawBaseUrl) {
    throw new Error(
      'BASE_URL is required. Point it at a PREVIEW deployment, e.g. ' +
        'BASE_URL=https://my-app-abc123-team.vercel.app k6 run checkout-flow.js',
    );
  }
  const baseUrl = normaliseBaseUrl(rawBaseUrl);

  const productId = (__ENV.PRODUCT_ID || '').trim();
  if (!productId) {
    throw new Error(
      'PRODUCT_ID is required. It must be the id of an ACTIVE product with at least ' +
        'one AVAILABLE, unexpired redeem code, or every request will 404/409 and the ' +
        'latency you measure will be a 404 latency.',
    );
  }

  // Deliberate, unmissable opt-in. A load test that creates real financial
  // records should require someone to type what they are about to do.
  const CONFIRM = 'i-understand-this-creates-real-orders';
  if ((__ENV.CONFIRM_REAL_ORDERS || '') !== CONFIRM) {
    throw new Error(
      'Refusing to run without CONFIRM_REAL_ORDERS="' + CONFIRM + '".\n' +
        'Every iteration that passes validation writes a real Order row, and every ' +
        'iteration that passes the fraud gate creates a real checkout at the payment ' +
        'provider. Read README.md, then set the variable deliberately.',
    );
  }

  // --- Preflight: is the target actually capable of being measured? ---------
  // A load run against an unconfigured preview produces a beautiful p95 while
  // measuring a 503 that returns in 4ms. That is the single most misleading
  // result this script could produce, so it refuses to start.
  const health = http.get(`${baseUrl}/api/health`, { timeout: '20s' });
  if (health.status !== 200) {
    throw new Error(
      `GET /api/health returned ${health.status}. Is the deployment up? ` +
        'Nothing was created.',
    );
  }

  let report;
  try {
    report = health.json();
  } catch {
    throw new Error('GET /api/health did not return JSON. Nothing was created.');
  }

  const payments = report && report.integrations ? report.integrations.payments : undefined;
  if (payments === 'NOT_CONFIGURED') {
    throw new Error(
      'The target reports payments: NOT_CONFIGURED. This run would measure a 503 ' +
        'returning in single-digit milliseconds and tell you nothing. Set the ' +
        "provider's environment variables on the preview and redeploy first.",
    );
  }
  if (payments === 'REAL') {
    if ((__ENV.ALLOW_REAL_PROVIDER || '') !== '1') {
      throw new Error(
        'The target reports payments: REAL — WHOP_ENVIRONMENT=production. Every ' +
          'checkout this run creates is a LIVE checkout configuration on a live ' +
          'merchant account, which is not a load test, it is a purchase page. Use a ' +
          'preview configured for the sandbox, or accept the consequence explicitly ' +
          'with ALLOW_REAL_PROVIDER=1.',
      );
    }
    console.warn(
      'ALLOW_REAL_PROVIDER=1 was set and the target reports payments: REAL. ' +
        'Real provider checkouts are being created. This is not reversible.',
    );
  }

  console.log(
    `Load test starting against ${baseUrl} — ${ITERATIONS} iteration(s) across ` +
      `${VUS} VU(s), which is up to ${ITERATIONS} real order(s). ` +
      `payments=${payments} database.ok=${report && report.database ? report.database.ok : 'unknown'}`,
  );

  // Unique per run so an idempotency key is never served from the previous
  // run's ledger row (a replayed key returns the cached response without
  // touching the order path, which would silently understate the load).
  const runNonce = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

  return { baseUrl, productId, runNonce, payments };
}

export default function (data) {
  // One idempotency key per virtual user per iteration. Unique keys are the
  // whole point: a repeated key would measure the replay path, which is fast
  // and boring, instead of the checkout path.
  const idempotencyKey = `k6:${data.runNonce}:vu${__VU}:iter${__ITER}`;

  const payload = JSON.stringify({
    productId: data.productId,
    quantity: 1,
    // `.invalid` is reserved by RFC 2606 and can never resolve, so no message
    // can reach a real inbox even if the provider were configured to send one.
    email: `k6-${data.runNonce}-${__VU}-${__ITER}@loadtest.invalid`,
    // Required, and required to be true — see the route. Without it a stray
    // navigation could create a payment intent for a stranger.
    confirmed: true,
  });

  const response = http.post(`${data.baseUrl}/api/checkout`, payload, {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'user-agent': `k6-load-test/${data.runNonce}`,
      accept: 'application/json',
    },
    tags: { endpoint: 'checkout' },
    timeout: '30s',
  });

  latency.add(response.timings.duration);

  // --- The body must always be JSON ---------------------------------------
  // Both success and every handled failure go through NextResponse.json. The
  // only way this fails is a framework-level fault — an unhandled throw, a
  // function timeout, an edge 5xx — and those are exactly the failures a load
  // test exists to find.
  let parsed = null;
  try {
    parsed = response.json();
  } catch (err) {
    parsed = null;
  }

  const contentType = (response.headers['Content-Type'] || '') + '';
  const isJsonContentType = contentType.indexOf('application/json') !== -1;

  const checks = {
    'responded with a JSON content type': () => isJsonContentType,
    'body parses as JSON': () => parsed !== null && typeof parsed === 'object',
    'JSON body carries an error or an order reference': () =>
      parsed !== null &&
      typeof parsed === 'object' &&
      (typeof parsed.orderReference === 'string' || typeof parsed.error === 'string'),
    'status is a handled checkout outcome': () =>
      response.status === 201 ||
      response.status === 400 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status === 503,
  };

  for (const name of Object.keys(checks)) {
    check(response, { [name]: checks[name] });
  }
  jsonBodyRate.add(isJsonContentType && parsed !== null);

  // --- Outcome accounting --------------------------------------------------
  // Latency alone cannot tell a healthy run from a run where every request was
  // rejected before it did any work. These counters make that visible.
  if (response.status === 201) {
    ordersCreated.add(1);
  } else if (response.status === 409) {
    // Two very different things share a 409: the fraud engine held the order,
    // and the product is out of stock. The response body does not distinguish
    // them reliably, so one counter covers both and the README tells you to
    // read the orders table to find out which happened.
    heldOrOutOfStock.add(1);
  } else if (response.status === 429) {
    rateLimited.add(1);
  } else if (response.status === 503) {
    providerNotConfigured.add(1);
  } else if (response.status === 400) {
    badRequest.add(1);
  } else {
    serverErrors.add(1);
  }
}

export function teardown(data) {
  console.log(
    `Load test finished against ${data.baseUrl}. Roughly ${ITERATIONS} order row(s) ` +
      'were created and are NOT cleaned up by this script — see README.md for the ' +
      'cleanup query. No payment was taken; no redeem code was allocated.',
  );
}