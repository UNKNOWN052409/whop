/**
 * Whop runtime configuration.
 *
 * Every value here comes from `@/lib/env`. Nothing is defaulted into existence:
 * a missing key means NOT CONFIGURED, and the caller gets an honest 503 rather
 * than a request to Whop that will 401.
 *
 * Two Whop-specific facts drive the shape of this module:
 *
 *  1. `Api-Version-Date` is effectively required. Without it Whop falls back to
 *     the original 2025-01-01 shapes, where the account field is `company_id`
 *     and money fields differ. We therefore treat "no Api-Version-Date header"
 *     as a bug in the client and fail loudly rather than silently degrading.
 *  2. Base URL is environment-derived. Sandbox is a different HOST, not just a
 *     flag — there is no `?sandbox=1`.
 */

import {
  PAYMENT_METHOD_BINDINGS,
  PAYMENT_METHODS,
  type IntegrationStatus,
  type PaymentMethodKey,
  whopConfig,
} from '@/lib/env';
import { errors } from '@/lib/errors';

/** Provider name used in error messages, logs and /api/health. */
export const WHOP_PROVIDER_NAME = 'Whop';

export interface ResolvedWhopConfig {
  /** Sent as `Authorization: Bearer <apiKey>`. Never logged, never returned. */
  readonly apiKey: string;
  /** The `ws_...` secret returned ONCE by POST /webhooks. Prefix is part of the HMAC key. */
  readonly webhookSecret: string;
  /** `biz_...` — the account that owns the sales. */
  readonly accountId: string;
  /** e.g. https://api.whop.com/api/v1 */
  readonly baseUrl: string;
  /** e.g. https://whop.com — used only to rebuild a purchase_url if Whop omits it. */
  readonly checkoutBaseUrl: string;
  /** Pinned payload shape, e.g. 2026-10-07-2 */
  readonly apiVersionDate: string;
  readonly environment: 'sandbox' | 'production';
  readonly kind: 'WHOP' | 'WHOP_SANDBOX';
  readonly status: IntegrationStatus;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Returns the resolved config, or null when Whop is not configured.
 *
 * `whopConfig.configured` requires ALL THREE of API key, webhook secret and
 * account id. We treat the secret as mandatory here too: a deployment that can
 * take money but cannot verify that the money event came from Whop is worse
 * than one that refuses to start.
 */
export function resolveWhopConfig(): ResolvedWhopConfig | null {
  const { apiKey, webhookSecret, accountId } = whopConfig;
  if (!apiKey || !webhookSecret || !accountId) return null;

  const environment = whopConfig.environment;
  return {
    apiKey,
    webhookSecret,
    accountId,
    baseUrl: stripTrailingSlash(whopConfig.baseUrl),
    checkoutBaseUrl: stripTrailingSlash(whopConfig.checkoutBaseUrl),
    apiVersionDate: whopConfig.apiVersionDate,
    environment,
    kind: environment === 'production' ? 'WHOP' : 'WHOP_SANDBOX',
    status: whopConfig.status,
  };
}

/**
 * Config or throw. This is the ONLY place an unconfigured Whop turns into an
 * error, so the 503 code path is consistent everywhere.
 *
 * Hard rule: never substitute a fake provider here. A checkout that "succeeds"
 * without a real charge is the worst possible failure in this system.
 */
export function requireWhopConfig(): ResolvedWhopConfig {
  const resolved = resolveWhopConfig();
  if (!resolved) throw errors.providerNotConfigured(WHOP_PROVIDER_NAME);
  return resolved;
}

// --- Payment methods ---------------------------------------------------------

/**
 * Whop identifiers accepted in `payment_method_configuration.enabled`.
 *
 * SOURCING: `card`, `apple_pay`, `klarna` and `us_bank_account` are confirmed
 * as Whop payment-method identifiers from the `payment.payment_method_type`
 * enum in WHOP_API_REFERENCE.md §4. Anything NOT in that list is UNCONFIRMED
 * and deliberately omitted — sending a speculative identifier to the checkout
 * configuration endpoint is how you end up with a checkout that silently shows
 * the wrong rails.
 */
export const WHOP_PAYMENT_METHOD = {
  CARD: 'card',
  APPLE_PAY: 'apple_pay',
  KLARNA: 'klarna',
  US_BANK_ACCOUNT: 'us_bank_account',
} as const;

export type WhopPaymentMethod = (typeof WHOP_PAYMENT_METHOD)[keyof typeof WHOP_PAYMENT_METHOD];

/**
 * How each of OUR methods is realised by Whop's hosted checkout.
 *
 * `CARD` -> cards. `WALLET` -> Apple Pay, which Whop's hosted page surfaces as
 * a card wallet; Google Pay is not in the confirmed identifier list so it is
 * NOT offered rather than guessed at. UPI and netbanking have no equivalent in
 * `payment_method_configuration` and are declared unsupported in `@/lib/env`.
 */
const METHOD_BINDING: Record<PaymentMethodKey, readonly WhopPaymentMethod[]> = {
  CARD: [WHOP_PAYMENT_METHOD.CARD],
  WALLET: [WHOP_PAYMENT_METHOD.APPLE_PAY],
  UPI: [],
  NETBANKING: [],
};

/**
 * Payment methods this deployment can actually settle through Whop: the
 * intersection of what is enabled in env and what Whop supports. The checkout
 * is configured with EXACTLY this list, so the storefront never advertises a
 * method the hosted page cannot take.
 */
export function enabledWhopPaymentMethods(): WhopPaymentMethod[] {
  const out = new Set<WhopPaymentMethod>();
  for (const method of PAYMENT_METHODS) {
    if (!PAYMENT_METHOD_BINDINGS[method].supported) continue;
    for (const identifier of METHOD_BINDING[method]) out.add(identifier);
  }
  return [...out];
}

/** True when at least one enabled method is realisable by Whop. */
export function hasSettleableMethod(): boolean {
  return enabledWhopPaymentMethods().length > 0;
}

/**
 * The `payment_method_configuration` block sent on checkout creation.
 *
 * `include_platform_defaults: false` is deliberate: with platform defaults on,
 * Whop may add methods (BNPL at 15%!) that the storefront never enabled. BNPL
 * would quietly destroy the margin on a $3 SKU. Explicit list, no defaults.
 */
export function whopPaymentMethodConfiguration(): {
  enabled: WhopPaymentMethod[];
  disabled: never[];
  include_platform_defaults: boolean;
} {
  return {
    enabled: enabledWhopPaymentMethods(),
    disabled: [],
    include_platform_defaults: false,
  };
}
