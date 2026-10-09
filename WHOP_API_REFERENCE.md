# Whop API — Implementation Reference (verified 2026-10)

Primary sources: `docs.whop.com` (Current API = `/api/v1`, "beta" doc namespace) plus the official
`@whop/sdk@2.2.0` published source. Everything below is quoted or taken from the OpenAPI schemas
Whop embeds in its docs. Anything I could not confirm is marked **UNCONFIRMED**.

> **Spec version observed:** `x-api-version-date: 2026-10-07-2`

---

## 0. TL;DR for a digital-goods storefront

Hosted checkout creation **is publicly available**. The endpoint is `POST /api/v1/checkout_configurations`.
You can pass an **inline price** — you do NOT need to pre-create a Whop product. You get back
`id` (`ch_…`) and `purchase_url` (`https://whop.com/checkout/ch_…/`). Attach your order reference via
the request's `metadata` object; it is copied onto the resulting payment and membership. Fulfill from
the `payment.succeeded` webhook.

---

## 1. AUTHENTICATION

### Header

`Authorization: Bearer <API_KEY>` — nothing else. There is **no** `X-Api-Key` style header.

OpenAPI security scheme (verbatim from the spec):

```yaml
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    description: >-
      An Account API key, an App API key, an account access token, an
      account-scoped user token, or a user OAuth token. Prepend the key or
      token with `Bearer`, for example `Bearer ***************************`.
```

API keys are prefixed `whop_` (Quickstart: `WHOP_API_KEY=whop_xxxxxxxxxxxxxxxxx`).

### Base URLs

| Environment | API base URL | Dashboard |
|---|---|---|
| Production | `https://api.whop.com/api/v1` | `https://whop.com` |
| Sandbox | `https://sandbox-api.whop.com/api/v1` | `https://sandbox.whop.com` |

These are also declared in the OpenAPI `servers` block of every endpoint:
`https://api.whop.com/api/v1` and `https://sandbox-api.whop.com/api/v1`.

### Other request headers

| Header | Required | Notes |
|---|---|---|
| `Api-Version-Date` | **Effectively required** | Pins request/response shapes. Omitting it falls back to the **original `2025-01-01` shapes** — where the account field is `company_id` and money fields differ. Latest observed: `2026-10-07-2`. |
| `Idempotency-Key` | No | Makes a POST safe to retry. `maxLength: 255`. |

### Sandbox

Keys created at `https://sandbox.whop.com/dashboard/developer`. Sandbox and production keys look
identical — store under different names. Sandbox limitations: **no payouts**, **no apps/messaging**,
**cards only** (no Apple Pay / Google Pay). Whop Elements sandbox environment is not yet available.

Test cards:

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 0341` | Setup succeeds, later charges decline |
| `5385 3083 6013 5181` | Requires 3DS (enter `Checkout1!`) |

Any future expiry (e.g. `12/34`), any CVC, any billing address.

### Credential types

Five, all sent identically as `Authorization: Bearer`:

1. **API key** — Account API key (your account + its connected accounts) or App API key (every
   account that installed your app). Server-side only.
2. **Account-scoped user token** — one user inside one account; mint with `POST /api/v1/access_tokens`
   passing `company_id`, `user_id`, `scoped_actions`. Expires in **1 hour** by default, max 3 hours.
3. **Account access token** — the account itself, narrowed; mint with `account_id` + `scoped_actions`.
4. **`iframe` user token** — short-lived JWT Whop sends in the `x-whop-user-token` header. You verify it.
5. **OAuth token** — user-granted. OAuth 2.1 + PKCE.

> Warning from docs: if you omit `scoped_actions` on a minted token, it **inherits every permission the
> minting credential has**. Always pass an explicit list.

### Auth scopes / permission levels

Whop uses **per-operation permission strings**, colon-separated, surfaced in the OpenAPI
`security` block as `bearerAuth: [<scope>]`. Examples:

| Scope | Grants |
|---|---|
| `checkout_configuration:create` | `POST /checkout_configurations` |
| `checkout_configuration:basic:read` | `GET /checkout_configurations/{id}`; also required for `metadata` to be non-null |
| `payment:basic:read` | `GET /payments/{id}`, `GET /payments`, `GET /refunds`, `GET /payments/{id}/fees` |
| `member:basic:read` | `member_id`, `membership_id`, `recovery_url`, `client_secret` on a payment |
| `member:email:read` | `customer_email` |
| `member:phone:read` | `customer_phone` |
| `plan:basic:read` | variant data on a payment |
| `shipment:basic:read` | `shipment_id`, `needs_tracking` |
| `promo_code:basic:read`, `access_pass:basic:read`, `payment:dispute:read`, `payment:resolution_center_case:read` | related payment sub-objects |
| `webhook_receive:payments` | Receiving `payment.*` events |

Required permissions for `payment.succeeded` (verbatim list from the event page):
`payment:basic:read`, `plan:basic:read`, `access_pass:basic:read`, `member:email:read`,
`member:basic:read`, `member:phone:read`, `promo_code:basic:read`, `shipment:basic:read`,
`payment:dispute:read`, `payment:resolution_center_case:read`, `webhook_receive:payments`.

**Yes — different keys can be scoped differently.** A key carries either a system role (e.g. `Admin`)
or an explicit permission set. The authoritative catalog is the endpoint
**List the Permission Catalog** → `GET /api/v1/permissions`
(<https://docs.whop.com/api-reference/beta/api-keys/list-the-permission-catalog>).
Read it at runtime rather than hardcoding.

`scoped_actions` strings documented for minted tokens: `chat:read`, `chat:message:create`, `dms:read`,
`dms:message:manage`, `dms:channel:manage`, `support_chat:read`, `support_chat:message:create`,
`company:balance:read`. Docs note the API does not publish a fixed complete list.

---

## 2. CHECKOUT CREATION

Resource: **Checkout Configurations** — "a reusable checkout link owned by an account."
<https://docs.whop.com/api-reference/beta/checkout-configurations/checkout-configuration>

| Endpoint | Request | Scope |
|---|---|---|
| List | `GET /checkout_configurations` | — |
| Retrieve | `GET /checkout_configurations/{id}` | **public** (or `checkout_configuration:basic:read`) |
| Create | `POST /checkout_configurations` | `checkout_configuration:create` |
| Delete | `DELETE /checkout_configurations/{id}` | — |

### The create call

```
POST https://api.whop.com/api/v1/checkout_configurations
Authorization: Bearer $WHOP_API_KEY
Content-Type: application/json
Idempotency-Key: <uuid>            # optional, max 255
Api-Version-Date: 2026-10-07-2     # strongly recommended
```

`operationId: createCheckoutConfiguration`. **Success returns HTTP `200`** (not 201). Errors: `401`, `409`.

### Request body — full schema

**The OpenAPI request schema declares NO `required` array** — every property is optional/nullable at
the schema level. In practice you must supply `account_id` (or rely on the key's account) plus
**exactly one** of `plan_id` or `plan`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `account_id` | string (`biz_…`) | practically yes | Account ID |
| `plan_id` | string\|null (`plan_…`) | one of | **Existing variant.** Mutually exclusive with `plan` |
| `plan` | object\|null | one of | **Inline variant attributes** — Whop creates or finds a variant for this checkout |
| `affiliate_code` | string\|null | no | Affiliate code applied at checkout |
| `currency` | string\|null | no | Currency for setup-mode payment method availability (defaults `usd`) |
| `metadata` | object\|null | no | **Custom key-value metadata copied to payments and memberships** |
| `mode` | `"payment"`\|`"setup"` | no | Defaults to `payment` |
| `payment_method_configuration` | object\|null | no | `{enabled[], disabled[], include_platform_defaults}` |
| `redirect_url` | string\|null | no | Where the buyer lands after checkout |
| `three_ds_level` | enum\|null | no | `mandate_challenge` \| `mandate_if_required` \| `frictionless_if_required` |

Inline `plan` object — all fields optional/nullable:

| Field | Type | Notes |
|---|---|---|
| `account_id` | string\|null | Defaults to the account resolved from the request |
| `billing_period` | integer\|null | Days (30 monthly, 365 annual); null for one-time |
| `currency` | string\|null | Three-letter ISO code |
| `description` | string\|null | Customer-visible |
| `expiration_days` | integer\|null | Access duration for expiration-based variants |
| `force_create_new_plan` | boolean\|null | **Create a new variant instead of reusing a matching one** |
| `initial_price` | number\|null | **The price** |
| `metadata` | object\|null | Metadata stored on the variant |
| `override_tax_type` | string\|null | e.g. `inclusive` |
| `payment_method_configuration` | object\|null | Overrides on the inline variant |
| `plan_type` | `renewal`\|`one_time`\|null | Billing model |
| `product_id` | string\|null (`prod_…`) | Optional — the inline variant need not belong to a product |
| `release_method` | `buy_now`\|`waitlist`\|null | |
| `renewal_price` | number\|null | Recurring price |
| `stock` | integer\|null | Units available |
| `three_ds_level` | enum\|null | |
| `title` | string\|null | Variant display name |
| `trial_period_days` | integer\|null | |
| `unlimited_stock` | boolean\|null | |
| `visibility` | `visible`\|`hidden`\|`archived`\|`quick_link`\|null | |

### Amount / currency — can you pass a dynamic price?

**Yes.** You do not have to reference a pre-created Whop product or variant. The official Quickstart
does exactly this with no `product_id` and no `account_id`:

```ts
const checkout = await client.checkoutConfigurations.create({
  plan: {
    title: "Starter",
    plan_type: "one_time",
    initial_price: 10.0,
    currency: "usd",
  },
});
console.log(checkout.purchase_url);
```

Raw HTTP equivalent:

```json
{
  "account_id": "biz_xxxxxxxxxxxxxx",
  "plan": { "title": "Starter", "plan_type": "one_time", "initial_price": 10.0, "currency": "usd" },
  "metadata": { "order_ref": "SHOP-4417" }
}
```

**Caution:** `force_create_new_plan` defaults to *reusing a matching variant*. If you price the same
SKU at different amounts, set `force_create_new_plan: true` or you may collide with an existing
variant. This is a real risk for a storefront with per-cart pricing — **UNCONFIRMED** exactly how
Whop decides "matching"; test it.

If you already have a variant, send `plan_id` instead. You cannot send both.

### Metadata / client-supplied order reference

Top-level `metadata` on the request. Documented as: *"Custom key-value metadata copied to payments
and memberships."* It surfaces as `payment.metadata` (and on the membership). This is the hook for
mapping a Whop payment back to your own order.

Reading it back off a retrieved checkout configuration requires `checkout_configuration:basic:read`;
without it `metadata` is `null`.

### Response shape

```
200 OK  →  CheckoutConfiguration
```

| Field | Type | Notes |
|---|---|---|
| `id` | string **(required)** | **`ch_…`** — the checkout configuration ID |
| `account_id` | string **(required)** | `biz_…` |
| `created_at` | string **(required)** | ISO 8601 |
| `updated_at` | string **(required)** | ISO 8601 |
| `mode` | string **(required)** | `payment` \| `setup` |
| `purchase_url` | string\|null | **Redirect the customer here.** e.g. `https://whop.com/checkout/ch_xxxxxxxxxxxxxx/` |
| `redirect_url` | string\|null | Post-checkout destination |
| `metadata` | object\|null | null without `checkout_configuration:basic:read` |
| `affiliate_code` | string\|null | |
| `currency` | string\|null | |
| `payment_method_configuration` | object\|null | This configuration's own editable override |
| `effective_payment_method_configuration` | object\|null | Resolved through all layers |
| `plan` | object\|null | Full nested variant; `null` in `setup` mode |
| `three_ds_level` | enum\|null | |

So: **the id you get back is the `ch_…` checkout-configuration id, and the hosted URL is
`purchase_url`, of the form `https://whop.com/checkout/ch_…/`.**

Note: an older variant-based path also yields a `purchase_url` (one doc example shows
`https://whop.com/checkout/plan_…/?session=ch_…`). `POST /checkout_configurations` is the current,
documented path.

### Expiry on the checkout URL

**UNCONFIRMED / no documented expiry.** The `CheckoutConfiguration` object has **no** expiry,
`expires_at`, or TTL field. The docs describe it as "**reusable**", and the only documented way to
disable it is `DELETE /checkout_configurations/{id}` ("Deletes a checkout configuration so its
checkout URL can no longer be used").

Practical reading: treat the `ch_…` link as **durable until you delete it**, not a per-session object.
Do not build per-order ephemeral links on this endpoint expecting them to rot. (Contrast: the
*Payment Quote* resource explicitly carries `expires_at`, and the browser-side checkout *sessions*
used by Whop Elements are a different concept.)

**UNCONFIRMED:** whether Whop applies any implicit server-side expiry not surfaced in the schema.
Validate against the sandbox before relying on long-lived links.

---

## 3. WEBHOOKS

Guide: <https://docs.whop.com/developer/guides/webhooks>

Whop webhooks follow the **Standard Webhooks** spec
(<https://github.com/standard-webhooks/standard-webhooks>).

### Event names — literal strings

Verified against the authoritative `WebhookEvent` enum in the published SDK
(`@whop/sdk@2.2.0/dist/esm/api/types/WebhookEvent.d.mts`).

**Payment lifecycle:**

```
payment.created
payment.succeeded      ← successful one-time payment
payment.failed
payment.pending
payment.authorized
payment.canceled
payment.requires_action
```

**Refund / reversal:**

```
refund.created         ← a refund was issued
refund.updated
```

**Chargeback / dispute:**

```
dispute.created        ← chargeback / dispute opened
dispute.updated
dispute_alert.created  ← early issuer warning (pre-chargeback)
```

**Resolution Center (buyer-filed claims, pre-chargeback):**

```
resolution_center_case.created
resolution_center_case.updated
resolution_center_case.decided
```

Other reversal-ish events (not applicable to a simple storefront):
`payout.reversed`, `card_transaction.reversed`, `withdrawal.reversed` (legacy, superseded by
`payout.*`).

> ⚠️ **There is no `payment.refunded` and no `payment.chargeback` event.** Refunds arrive as
> `refund.created` / `refund.updated`; chargebacks as `dispute.created` / `dispute.updated`; early
> warnings as `dispute_alert.created`. Subscribe to all three families.
>
> `refund.updated` is the one to watch for the *terminal* state — a refund starts `pending` or
> `requires_action` and can end `failed` or `canceled`.

Other events you may also want: `membership.activated`, `membership.updated`,
`membership.trial_ending_soon`, `member.created`, `member.updated`, `plan.created` (variants),
`product.created`, `ledger_account.funds_available`, `financial_activity.funds_available`.

### Signature verification — exact algorithm

**HTTP headers** (case-insensitive; Whop sends them lowercase):

```http
POST /webhooks/whop HTTP/1.1
content-type: application/json
webhook-id: msg_bQPHmO2eBnHYtWWuxAN9K3Xd
webhook-timestamp: 1786381404
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pCPljWFR61G0P0=
```

**The exact signed string** (verbatim from the docs):

```
{webhook-id}.{webhook-timestamp}.{raw request body}
```

Three parts joined by literal `.` — the message id, the Unix-seconds timestamp as sent in the
header, then the **raw, unmodified request body**.

**Algorithm:** `HMAC-SHA256`, result **base64-encoded**, header format `v1,<base64>` (comma-separated;
multiple `v1,…` entries may appear during key rotation — accept any that verifies).

**The secret:** the `webhook_secret` returned **once** by `POST /api/v1/webhooks`, prefixed `ws_`.
**Not** your API key, **not** a signing secret derived from it.

**🔴 The key derivation — this is the part people get wrong.**

The HMAC key is the **raw UTF-8 bytes of the entire `ws_…` secret string, prefix included.**

I confirmed this from Whop's own published SDK source
(`@whop/sdk@2.2.0/dist/esm/helpers/verifyWebhook.mjs`), whose comment states it outright:

> *"Whop's backend HMACs with the literal bytes of the secret it issued (`WebhooksManager::SignWebhook`
> passes `webhook.webhook_secret` straight to `OpenSSL::HMAC`)… The whole secret is encoded, prefix
> included, because the backend never strips a prefix either."*

The SDK base64-encodes the secret **only** because the `standard-webhooks` library base64-*decodes*
whatever key it is handed, and that cancels out. So for a hand-rolled implementation:

```python
import hmac, hashlib, base64

key  = WHOP_WEBHOOK_SECRET.encode("utf-8")     # e.g. b"ws_0123...cdef"  — WHOLE string, prefix kept
msg  = f"{webhook_id}.{webhook_ts}.{raw_body}"  # raw_body = exact bytes received
sig  = base64.b64encode(hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()).decode()
expected = f"v1,{sig}"
assert hmac.compare_digest(sig_header, expected)   # constant-time
```

Do **NOT** strip the `ws_` prefix. Do **NOT** base64-decode the secret. Do **NOT** re-serialize the
JSON — sign the exact bytes received.

### Replay protection

`webhook-timestamp` is a **separate header** (Unix seconds) **and** is part of the signed string.
Docs: *"Reject a request if its `webhook-timestamp` is more than 5 minutes from the current time.
This prevents replay attacks. The SDK verifiers apply this limit automatically."* → tolerance = **300 s**.

### Envelope

Verbatim from the webhooks guide:

```json
{
  "id": "msg_bQPHmO2eBnHYtWWuxAN9K3Xd",
  "type": "payment.succeeded",
  "api_version": "v1",
  "api_version_date": "2026-08-14",
  "timestamp": "2026-08-10T17:03:24.291Z",
  "account_id": "biz_XXXXXXXX",
  "data": {
    "id": "pay_XXXXXXXX",
    "...": "the full payment object"
  }
}
```

- `data` for `payment.*` events **is the full Payment object** (schema in §4) — so your
  checkout-configuration `metadata` arrives as `data.metadata`.
- **`account_id` vs `company_id`:** webhooks pinned before `2026-08-14`, and unpinned webhooks,
  carry `company_id` instead of `account_id`. **Handle both.**
- Optional `previous_attributes` — present on `.updated` events that capture changes
  (`account.updated`, `product.updated`, `plan.updated`, `shipment.updated`).
- `api_version: "v1"` is the Standard-Webhooks-signed envelope. Legacy `v2` and `v5` exist but **do not
  use Standard Webhooks signatures** — do not use them for new integrations.

### Registering a webhook

```bash
curl -X POST "https://api.whop.com/api/v1/webhooks" \
  -H "Authorization: Bearer $WHOP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/webhooks/whop", "events": ["payment.succeeded"]}'
```

The response contains **`webhook_secret`**, shown **only once**. Store it immediately.
Set `api_version_date` at creation time to pin the payload shape.
Other webhook endpoints: `GET /webhooks`, `GET /webhooks/{id}`, `PATCH /webhooks/{id}`
(`{"enabled": true}` re-enables), `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`,
`POST /webhooks/{id}/deliveries/replay`, `DELETE /webhooks/{id}`.

### Delivery semantics (design your handler around these)

- Respond **2xx in under 5 seconds**. Anything else is a failed attempt. Whop does **not** follow redirects.
- **At least once.** Dedupe on the `webhook-id` header.
- Retries for ~3 days: first attempt, then 12 retries at 30s, 2m, 8m, 30m, 1h, 3h, 6h, then every 12h (≈71 h total).
- **Ordering is not guaranteed** — a newer event can arrive first. Process independently.
- Webhook URL must be publicly reachable; `localhost` and private networks are rejected.
- Disabled if all deliveries fail for 24 h (warning email) then 72 h with ≥10 failures (second email, webhook disabled). Events during downtime are **not** replayed automatically.
- Deliveries are retained **30 days** (`GET /webhooks/{id}/deliveries`).

### SDK helpers

```ts
import { unwrapWebhook } from "@whop/sdk/helpers";
const payload = await request.text();          // RAW body
const event = unwrapWebhook(payload, {
  headers: Object.fromEntries(request.headers),
  key: process.env.WHOP_WEBHOOK_SECRET!,
});
if (event.type === "payment.succeeded") { /* event.data */ }
```

```python
from whop_sdk.lib.verify_webhook import unwrap
event = unwrap(raw_body, dict(request.headers), os.environ["WHOP_WEBHOOK_SECRET"])
```

⚠️ The docs warn that **`webhooks.unwrap` and the `webhookKey` client option are REMOVED** from the
current SDKs — those belonged to the 1.x SDKs. Use the `helpers` export shown above.

---

## 4. PAYMENT VERIFICATION / LOOKUP

### Fetch a single payment

`GET https://api.whop.com/api/v1/payments/{id}` — scope `payment:basic:read`. Returns the Payment object.

### Payment object

> **All money fields are Money objects, and `amount` is a decimal STRING in major units** —
> `"29.99"`, not `29.99`. Parse with a decimal type, never a float.
>
> `Money = { amount: string, currency: string (lowercase ISO 4217), decimals: int, display_decimals: int }`
> `decimals` = precision the charge runs at; `display_decimals` = precision to display (differs for COP).

| Field | Type | Notes |
|---|---|---|
| `id` | string | **`pay_…`** |
| `account_id` | string\|null | `biz_…` |
| `status` | enum | `draft`\|`open`\|`authorized`\|**`paid`**\|`pending`\|`uncollectible`\|`unresolved`\|`void` |
| `substatus` | enum | `succeeded`, `requires_capture`, `pending`, `failed`, `blocked`, `past_due`, `canceled`, `price_too_low`, `uncollectible`, `refunded`, `auto_refunded`, `partially_refunded`, `dispute_warning`, `dispute_needs_response`, `dispute_warning_needs_response`, `resolution_needs_response`, `dispute_under_review`, `dispute_warning_under_review`, `resolution_under_review`, `dispute_won`, `dispute_warning_closed`, `resolution_won`, `dispute_lost`, `dispute_closed`, `resolution_lost`, `drafted`, `incomplete`, `unresolved`, `open_dispute`, `open_resolution` |
| `total` | Money\|null | Account-facing total: price after discounts + tax on top. **Excludes buyer fees.** |
| `amount_after_fees` | Money | **What you keep** = total less Whop's fees |
| `subtotal` | Money\|null | Before discounts, tax, fees |
| `tax_amount` | Money\|null | |
| `tax_behavior` | `exclusive`\|`inclusive`\|null | Whether tax was added on top or already inside |
| `tax_refunded_amount` | Money | Portion of tax returned |
| `usd_total` | Money\|null | Converted to USD at charge time |
| `presentment_total` | Money\|null | Currency presented to the buyer, before conversion |
| `currency` | enum | Settlement currency, lowercase (e.g. `usd`) |
| `metadata` | object\|null | **Your order reference** |
| `checkout_configuration_id` | string\|null | Your `ch_…` |
| `plan_id` / `product_id` | string\|null | `plan_…` / `prod_…` |
| `member_id` / `membership_id` | string\|null | `mber_…` / `mem_…` |
| `user` | object\|null | `{id, name, username, profile_picture:{url}}` |
| `customer_email` / `customer_phone` | string\|null | Need `member:email:read` / `member:phone:read` |
| `line_items[]` | object[] | `{id: li_…, label, plan_id, plan_title, product_id, product_title, quantity, sku, subtotal: Money}` |
| `paid_at` | string\|null | When money was collected |
| `settlement_time_at` | string\|null | When funds post to available balance. **null on list rows — retrieve the payment.** |
| `refunded_amount` | Money\|null | |
| `refunded_at` | string\|null | |
| `refundable` | boolean | |
| `auto_refunded` | boolean | Whop refunded automatically (e.g. on dispute alert) |
| `payment_method_type` | string\|null | `card`, `apple_pay`, `klarna`, `us_bank_account`, … |
| `payment_method_id` | string\|null | `payt_…` |
| `payment_instrument` | object\|null | `{payment_method_type, display_name, icons, card:{brand,last4,issuer_identification_number,exp_month,exp_year}, installment_count}` |
| `decline_code` / `failure_message` | string\|null | On failures |
| `billing_reason` | string\|null | `subscription_create`\|`subscription_cycle`\|`subscription_update`\|`one_time`\|`manual`\|`subscription` |
| `client_secret` | string\|null | Only on token-created payments; **always null in list responses** |
| `recovery_url` | string\|null | 3DS recovery link for off-session charges; **null in list responses** |
| `holds[]` | object[] | `{type: reserve\|bnpl\|sequra\|fraud_hold\|preshipment_hold, amount: Money, percentage, release_at}` |
| `holds` type | | Reserve % e.g. `3.5` means 3.5% |
| `risk_score` | number\|null | 0–100 published risk index (**not** a fraud probability) |
| `three_ds_verified` | boolean | |
| `verification_checks` | object\|null | `{address_line1, zip_code, card_holder_name, card_security_code, authorization_code, arn}` |
| `pdf_url` | string\|null | Receipt PDF |
| `created_at` / `updated_at` | string | ISO 8601 |

**Success check:** `status === "paid"` (and typically `substatus === "succeeded"`).

### Collection status polling

`GET /api/v1/payments/{payment_id}/status` — how far collection got and what the buyer must do next.
Accepts a secret key **or** the payment's own `client_secret`. Relevant for API-created payments
(off-session), not for checkout links.

### Per-payment fee breakdown (for margin)

`GET /api/v1/payments/{id}/fees` — scope `payment:basic:read`. Complete in one page.
Returns `{ data: PaymentFee[], page_info }`.

```jsonc
{
  "type": "whop_fee" | "processing_fee" | "affiliate_program_fee" | "other_fee",
  "origin": "payment_processing_percentage_fee",   // 32-value enum
  "label": "Processing fee",
  "description": null,
  "amount":            { "amount": "-0.27", "currency": "usd", "decimals": 2, "display_decimals": 2 },
  "settlement_amount": { "amount": "-0.27", "currency": "usd", "decimals": 2, "display_decimals": 2 },
  "collected_at": "2026-01-01T12:00:00.000Z"
}
```

Full `origin` enum (all 32): `stripe_domestic_processing_fee`,
`stripe_international_processing_fee`, `stripe_fixed_processing_fee`, `stripe_billing_fee`,
`stripe_radar_fee`, `sales_tax_remittance`, `sales_tax_remittance_reversal`, `stripe_sales_tax_fee`,
`whop_processing_fee`, `marketplace_affiliate_fee`, `affiliate_fee`, `crypto_fee`,
`stripe_standard_processing_fee`, `paypal_fee`, `stripe_payout_fee`, `dispute_fee`,
`dispute_alert_fee`, `dispute_representment_fee`, `apple_processing_fee`, `buyer_fee`,
`sezzle_processing_fee`, `splitit_processing_fee`, `platform_balance_processing_fee`,
`payment_processing_percentage_fee`, `payment_processing_fixed_fee`, `cross_border_percentage_fee`,
`fx_percentage_fee`, `orchestration_percentage_fee`, `three_ds_fixed_fee`,
`billing_percentage_fee`, `revshare_percentage_fee`, `application_fee`,
`high_risk_merchant_fee`, `economic_intelligence_percentage_fee`.

`amount` is in the collected currency; `settlement_amount` is converted to the payment's settlement
currency so lines total against the payment.

### Listing for a reconciliation worker

#### `GET /api/v1/payments`

Newest first. Default scope = account sales.

| Param | Type | Notes |
|---|---|---|
| `mode` | `account_sales` (default) \| `user_sales` | `user_sales` needs a user login session; cannot combine with `account_id` |
| `account_id` | string | `biz_…` |
| `status` | enum | `open`\|`authorized`\|`paid`\|`pending`\|`uncollectible`\|`unresolved`\|`void` |
| `billing_reason` | enum | `subscription_create`\|`subscription_cycle`\|`subscription_update`\|`one_time`\|`manual`\|`subscription` |
| `currency` | string | 3-letter |
| `user_id` | string | `user_…` |
| `query` | string | user ID, membership ID, email, name, username (email needs `member:email:read`) |
| `member_id` | string | `mber_…` |
| `membership_id` | string | `mem_…` |
| `product_id` | string | `prod_…` |
| `plan_id` | string | `plan_…` |
| **`created_after`** | ISO 8601 date-time | **Lower bound of your date range** |
| **`created_before`** | ISO 8601 date-time | **Upper bound** |
| `order` | `created_at` \| `paid_at` | Sort field |
| `direction` | `asc` \| `desc` | |
| `first` | integer | **Default 20, max 100** |
| `after` | string | Cursor from `page_info.end_cursor` |
| `last` | integer | max 100 |
| `before` | string | Cursor from `page_info.start_cursor` |

Notes: `settlement_time_at` is always `null` on list rows — retrieve individually if you need it.
`billing_reason=subscription_cycle` also matches renewals recorded as `subscription_update`.

#### `GET /api/v1/refunds`

Newest first. Scope `payment:basic:read`.

Params: `account_id` (`biz_…`), `payment_id` (`pay_…`), `user_id` (`user_…`),
**`created_after`**, **`created_before`** (ISO 8601), `order` (`created_at`), `direction`
(`asc`\|`desc`), `first` (default **20**, max **100**), `after`, `last` (max 100), `before`.
Errors: `400` unsupported sort field, `401`, `404` unknown payment filter.

Refund object:

| Field | Type | Notes |
|---|---|---|
| `id` | string | **`rf_…`** |
| `payment_id` | string | `pay_…` |
| `account_id` | string\|null | `biz_…` |
| `status` | enum | `pending`\|`requires_action`\|`succeeded`\|`failed`\|`canceled` |
| `amount` | Money\|null | **In the payment's settlement currency** — nets against the payment's `total` |
| `original_amount` | Money | What the processor actually moved |
| `provider` | string | e.g. `stripe`, `paypal`, `coinbase` |
| `reason` | enum\|null | `duplicate`\|`fraudulent`\|`requested_by_customer`\|`expired_uncaptured_charge`\|`dispute_alert` |
| `failure_reason` | enum\|null | `bank_declined`, `expired_or_canceled_card`, `lost_or_stolen_card`, `insufficient_funds`, `charge_disputed`, `not_refundable`, `merchant_request`, `unknown` |
| `failure_message` | string\|null | |
| `visa_rdr` | boolean | Visa Rapid Dispute Resolution |
| `reference_status` / `reference_type` / `reference_value` | | Banking-network tracking reference |
| `provider_created_at`, `created_at`, `updated_at` | string | |

#### Pagination shape — Relay-style cursors

```json
{
  "data": [ /* … */ ],
  "page_info": {
    "start_cursor": "WyJjdXJzb3IiLDFd",
    "end_cursor":   "WyJjdXJzb3IiLDJd",
    "has_next_page": true,
    "has_previous_page": false
  }
}
```

Loop: request with `first` (≤100) → while `page_info.has_next_page`, re-request with
`after = page_info.end_cursor`. Reverse pagination uses `last` + `before = page_info.start_cursor`.

#### Bulk export (recommended for large ranges)

`POST /api/v1/exports` → async CSV of `members`, `payments`, `disputes`, `ads`, etc.
Returns `pending` → poll `GET /exports/{id}` until `download_url` is set. **CSVs retained 30 days**,
then the export moves to `expired`.

`GET /api/v1/ledgers` (List Financial Activity) is the ledger-level alternative: signed `amount` in
smallest precision units, plus `posted_at` and `available_at`.

### Errors

```json
{ "error": { "type": "invalid_parameters", "message": "initial_price must be greater than 0" } }
```

Sometimes with an extra `code` (e.g. `bank_warning_not_acknowledged`).
Statuses: `400` bad shape/missing field · `401` no auth · `403` valid credential, lacks permission ·
`404` not found · `409` state conflict · `422` validation · `429` rate limited · `5xx` Whop-side.

---

## 5. FEES

<https://docs.whop.com/payments-and-billing/fees>. Page states pricing "applies to new merchants that
sign up today".

### Accepting payments — baseline

| Item | Rate |
|---|---|
| **Cards & wallets (base)** | **2.7% + $0.30** per successful transaction, domestic cards |
| International cards | **+ 1.5%** |
| Transaction requires currency conversion | **+ 1%** |
| Financing / BNPL | **15%** (20% for ClarityPay No Interest) |
| ACH direct debit (US) | **1.5%, max $5** |

### Fraud & security (flat, no % of transaction amount)

| Item | Fee |
|---|---|
| 3DS | **$0.03** per transaction |
| Radar (ML fraud detection) | **$0.07** per transaction |
| Dispute (chargeback) | **$15.00** per dispute |
| Early dispute alert (RDR) | **$29.00** per alert |

### Revenue optimization (opt-in; **stacks on top of the base rate**)

| Item | Fee |
|---|---|
| Orchestration (multi-processor routing) | 0.8% per transaction when enabled |
| Billing (invoices, retries) | 0.5% per transaction when enabled |
| Tax & remittance | 2% per transaction when enabled **and** tax is collected |

Whop's own worked example — **domestic card, everything on**:

```
Card processing                 2.7% + $0.30
+ Orchestration (enabled)            0.8%
+ Billing (enabled)                  0.5%
+ Tax and remittance (enabled, tax collected)  2.0%
─────────────────────────────────────────────
Everything enabled, tax collected        6% + $0.30
```

### Payouts (getting your money out)

| Method | Fee |
|---|---|
| Next-day ACH (US) | $2.50 per payout |
| Instant Bank Deposit (RTP) | 4% + $2.50 |
| Crypto | 5% + $1.00 |
| Venmo | 5% + $2.50 |
| Bank wire | $23.00 |
| International local banks | Varies by country |

### Modeling margin — programmatic sources

1. **`payment.amount_after_fees`** on every payment — the number you actually keep. Use this for
   per-order margin.
2. **`GET /api/v1/payments/{id}/fees`** — exact fee lines with `origin` codes. Best for audits.
3. **`GET /api/v1/accounts/{account_id}/fees`** — the account's effective fee document. Contains
   `markups` / `child_markups` (for platforms), each with `adjustable` and `unadjustable_reason`.
   `GET`/`PATCH /accounts/{account_id}/fees`.

### Caveats for a digital-goods store

- Base **2.7% + $0.30** is the honest floor. On a $9.99 item that is ~5.7% effective — the $0.30
  fixed component dominates low-price goods. Price accordingly.
- The **$0.30 fixed component is per successful transaction** — it is not amortized across a cart.
- A **$15 chargeback fee** against a low-margin item is catastrophic. Budget dispute rate explicitly.
- Financing at **15%** will destroy thin margins — disable BNPL or price it differently.
- `tax_type` / `tax_remitted_by` on the account determine whether the 2% remittance fee applies.

---

## 6. LIMITS

**Rate limit — verbatim:** *"For `/api/v1` requests, Whop limits authenticated API calls to
**600 requests per minute per operation and API credential**."*

- The counter is keyed by **(operation, credential)** — so a per-endpoint budget, not a global one.
- On breach, HTTP `429`:

```json
{ "error": { "type": "rate_limit_exceeded", "message": "Try again in 12 seconds." } }
```

- Back off for the delay stated in `message`. Retry with exponential backoff for idempotent requests.
  Do **not** retry `401`, `403`, or validation errors without changing the request.

**Other documented limits**

- `first` / `last` on list endpoints: **max 100** (default 20).
- `Idempotency-Key`: max **255** characters.
- Webhook: respond **2xx in < 5 s**.
- Webhook URL must be publicly reachable (no `localhost`, no private networks).
- Webhook deliveries retained **30 days**; exports (CSVs) retained **30 days**.

---

## 7. SDK NOTES

- **TypeScript**: `@whop/sdk`, latest **2.2.0**. `pnpm add @whop/sdk`
  - 2.x: `import { WhopClient } from "@whop/sdk"` → `new WhopClient({ token })`
  - 1.x (Quickstart form): `import Whop from "@whop/sdk"` → `new Whop({ apiKey })`
  - `client.checkoutConfigurations.create({...})`
  - Webhook: `import { unwrapWebhook } from "@whop/sdk/helpers"`
  - `webhooks.unwrap` and the `webhookKey` client option are **removed** in current SDKs.
- **Python**: `whop-sdk`; `from whop_sdk import Whop`; `client.checkout_configurations.create(...)`;
  webhook `from whop_sdk.lib.verify_webhook import unwrap`.
- **Ruby**: `gem install whop_sdk`; `WhopSDK::Client.new(api_key:)`;
  `WhopSDK::Helpers::VerifyWebhook.unwrap(request.raw_post, headers:, key:)`.
- **Go**: `github.com/whopio/whopsdk-go/v2`.
- **Rust**: `whop_sdk` (still 1.x).
- SDK sandbox switch (2.0+): `environment: WhopEnvironment.Sandbox`. On 1.x use `baseUrl`.
- SDKs auto-send `Api-Version-Date` for the version they were generated against.

---

## 8. UNCONFIRMED / OPEN ITEMS

State these explicitly rather than guessing:

1. **Checkout URL expiry** — no expiry field exists; docs say "reusable"; only `DELETE` disables it.
   Whether Whop enforces any implicit server-side TTL is **UNCONFIRMED**.
2. **`force_create_new_plan` matching semantics** — how Whop decides a variant "matches" is
   **UNCONFIRMED**. With variable per-cart pricing, set it to `true` and verify in sandbox.
3. **Whether `account_id` is mandatory on `POST /checkout_configurations`** — the schema has no
   `required` array and the Quickstart omits it, but every doc example that passes one includes it.
   Send it.
4. **A verbatim `payment.succeeded` payload sample** — the event doc page renders with `paths: {}`
   and carries no example. The envelope above is verbatim from the webhooks guide; `data` is the
   Payment object documented in §4. Field names are confirmed; the assembled example is a
   reconstruction, not a captured sample.
5. **Exact per-checkout-link amount caps** — the Help Center has a separate
   ["Higher Checkout Links"](https://docs.whop.com/manage-your-business/payment-processing/access-higher-checkout-links)
   page for links above $2,500; the numeric limit was not confirmed from the API docs.
6. **The complete permission catalog** — not enumerated here. Fetch it from `GET /api/v1/permissions`.
7. **Response status for `POST /checkout_configurations`** — the spec lists only `200`. If you rely on
   2xx, that is safe; do not assert `201`.

---

## 9. SOURCES

- Auth & API keys — <https://docs.whop.com/developer/guides/auth-scoping>
- Sandbox — <https://docs.whop.com/developer/guides/sandbox>
- Quickstart — <https://docs.whop.com/developer/quickstart>
- API Overview — <https://docs.whop.com/api-reference/beta/overview>
- Accept payments — <https://docs.whop.com/developer/guides/accept-payments>
- Checkout Configuration — <https://docs.whop.com/api-reference/beta/checkout-configurations/checkout-configuration>
- Create a Checkout Configuration — <https://docs.whop.com/api-reference/beta/checkout-configurations/create-a-checkout-configuration>
- Retrieve a Checkout Configuration — <https://docs.whop.com/api-reference/beta/checkout-configurations/retrieve-a-checkout-configuration>
- Webhooks guide — <https://docs.whop.com/developer/guides/webhooks>
- `payment.succeeded` event — <https://docs.whop.com/api-reference/beta/payments/payment-succeeded>
- Payment resource — <https://docs.whop.com/api-reference/beta/payments/payment>
- List Payments — <https://docs.whop.com/api-reference/beta/payments/list-payments>
- List Payment Fees — <https://docs.whop.com/api-reference/beta/payments/list-payment-fees>
- List Refunds — <https://docs.whop.com/api-reference/beta/refunds/list-refunds>
- Refunds resource — <https://docs.whop.com/api-reference/beta/refunds/list-refunds>
- Fees — <https://docs.whop.com/payments-and-billing/fees/fees>
- Troubleshooting (rate limits) — <https://docs.whop.com/developer/troubleshooting>
- Webhook event enum (SDK) — <https://cdn.jsdelivr.net/npm/@whop/sdk@2.2.0/dist/esm/api/types/WebhookEvent.d.mts>
- Webhook verify helper (SDK) — <https://cdn.jsdelivr.net/npm/@whop/sdk@2.2.0/dist/esm/helpers/verifyWebhook.mjs>
- Standard Webhooks spec — <https://github.com/standard-webhooks/standard-webhooks>