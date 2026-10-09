/**
 * Typed environment access.
 *
 * Two rules this module exists to enforce:
 *
 *  1. NOTHING is hard-coded. No key, URL, or price literal lives in source.
 *  2. Absence is a first-class, *reportable* state (spec §24). An unconfigured
 *     integration must surface as NOT_CONFIGURED rather than silently
 *     throwing, faking success, or degrading to a stub.
 */

import { z } from 'zod';

/** Runtime mode for a given integration. Surfaced on /api/health. */
export type IntegrationStatus = 'REAL' | 'SANDBOX' | 'NOT_CONFIGURED';

export type PaymentMethodKey = 'CARD' | 'UPI' | 'WALLET' | 'NETBANKING';

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

/**
 * Enabled payment methods. Drives the checkout UI — the frontend renders only
 * what this returns and never hard-codes a method list (spec §7).
 */
export const PAYMENT_METHODS: PaymentMethodKey[] = csv(process.env.ENABLED_PAYMENT_METHODS).filter(
  (m): m is PaymentMethodKey =>
    ['CARD', 'UPI', 'WALLET', 'NETBANKING'].includes(m),
);

/** How each payment method is actually realised by the configured provider. */
export const PAYMENT_METHOD_BINDINGS: Record<
  PaymentMethodKey,
  { provider: 'WHOP'; supported: boolean }
> = {
  // Whop's hosted checkout settles cards; it does not expose raw UPI, wallet or
  // netbanking rails through the checkout_configurations API. These are declared
  // unsupported rather than faked (spec §7 / §24).
  CARD: { provider: 'WHOP', supported: true },
  UPI: { provider: 'WHOP', supported: false },
  WALLET: { provider: 'WHOP', supported: false },
  NETBANKING: { provider: 'WHOP', supported: false },
};

export type WhopEnvironment = 'sandbox' | 'production';

export type EmailProviderKey = 'SES' | 'RESEND' | 'SMTP';

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

// --- Encryption -------------------------------------------------------------

/**
 * 32-byte key, base64 or hex encoded. Used for AES-256-GCM over redeem codes.
 * ENCRYPTION_KEY is REQUIRED in production; generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
const encryptionKey = env('ENCRYPTION_KEY');

/** Separate key for deterministic HMAC fingerprints (dedupe, PII hashing). */
const fingerprintKey = env('FINGERPRINT_KEY') ?? encryptionKey;

// --- Whop -------------------------------------------------------------------

const whopApiKey = env('WHOP_API_KEY');
const whopWebhookSecret = env('WHOP_WEBHOOK_SECRET');
const whopAccountId = env('WHOP_ACCOUNT_ID');
const whopEnvironment = (env('WHOP_ENVIRONMENT') as WhopEnvironment) ?? 'sandbox';

export const whopConfig = {
  apiKey: whopApiKey,
  webhookSecret: whopWebhookSecret,
  accountId: whopAccountId,
  environment: whopEnvironment,
  /**
   * Pinning the version is not optional in practice: unpinned requests fall
   * back to the 2025-01-01 shapes where the account field is `company_id`
   * instead of `account_id`. See WHOP_API_REFERENCE.md.
   */
  apiVersionDate: env('WHOP_API_VERSION_DATE') ?? '2026-10-07-2',
  baseUrl:
    whopEnvironment === 'production'
      ? 'https://api.whop.com/api/v1'
      : 'https://sandbox-api.whop.com/api/v1',
  checkoutBaseUrl:
    whopEnvironment === 'production' ? 'https://whop.com' : 'https://sandbox.whop.com',
  get configured(): boolean {
    return Boolean(whopApiKey && whopWebhookSecret && whopAccountId);
  },
  get status(): IntegrationStatus {
    if (!this.configured) return 'NOT_CONFIGURED';
    return whopEnvironment === 'production' ? 'REAL' : 'SANDBOX';
  },
  get kind(): 'WHOP' | 'WHOP_SANDBOX' {
    return whopEnvironment === 'production' ? 'WHOP' : 'WHOP_SANDBOX';
  },
};

// --- Email ------------------------------------------------------------------

const emailProviderKey = (env('EMAIL_PROVIDER') as EmailProviderKey) ?? undefined;

export const emailConfig = {
  provider: emailProviderKey,
  fromEmail: env('EMAIL_FROM'),
  fromName: env('EMAIL_FROM_NAME') ?? 'Redeem Store',
  replyTo: env('EMAIL_REPLY_TO'),

  ses: {
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    region: env('AWS_REGION') ?? 'us-east-1',
  },
  resend: {
    apiKey: env('RESEND_API_KEY'),
  },
  smtp: {
    host: env('SMTP_HOST'),
    port: env('SMTP_PORT') ? Number(env('SMTP_PORT')) : 587,
    user: env('SMTP_USER'),
    password: env('SMTP_PASSWORD'),
    secure: env('SMTP_SECURE') === 'true',
  },

  get configured(): boolean {
    switch (this.provider) {
      case 'SES':
        return Boolean(this.ses.accessKeyId && this.ses.secretAccessKey);
      case 'RESEND':
        return Boolean(this.resend.apiKey);
      case 'SMTP':
        return Boolean(this.smtp.host);
      default:
        return false;
    }
  },
  get status(): IntegrationStatus {
    return this.configured ? 'REAL' : 'NOT_CONFIGURED';
  },
};

// --- Other integrations -----------------------------------------------------

export const redisConfig = {
  url: env('UPSTASH_REDIS_REST_URL'),
  token: env('UPSTASH_REDIS_REST_TOKEN'),
  get configured(): boolean {
    return Boolean(this.url && this.token);
  },
  get status(): IntegrationStatus {
    return this.configured ? 'REAL' : 'NOT_CONFIGURED';
  },
};

export const inngestConfig = {
  eventKey: env('INNGEST_EVENT_KEY'),
  signingKey: env('INNGEST_SIGNING_KEY'),
  get configured(): boolean {
    return Boolean(this.eventKey && this.signingKey);
  },
  get status(): IntegrationStatus {
    return this.configured ? 'REAL' : 'NOT_CONFIGURED';
  },
};

export const appConfig = {
  url: env('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',
  nodeEnv: env('NODE_ENV') ?? 'development',
  isProduction: (env('NODE_ENV') ?? 'development') === 'production',
  encryptionKey,
  fingerprintKey,
  sessionSecret: env('SESSION_SECRET'),
  adminBootstrapEmail: env('ADMIN_BOOTSTRAP_EMAIL'),
  adminBootstrapPassword: env('ADMIN_BOOTSTRAP_PASSWORD'),

  /** Webhook signature freshness window (Whop docs: reject beyond 5 minutes). */
  webhookToleranceSeconds: Number(env('WEBHOOK_TOLERANCE_SECONDS') ?? '300'),

  /** Reconciliation look-back on first run, hours. */
  reconciliationLookbackHours: Number(env('RECONCILIATION_LOOKBACK_HOURS') ?? '72'),
};

export const isProduction = appConfig.isProduction;

/**
 * Fail fast on missing secrets in production. Called once from
 * instrumentation.ts so a misconfigured deploy fails at boot rather than at
 * the first customer's payment.
 */
export function assertProductionConfig(): void {
  if (!isProduction) return;
  const missing: string[] = [];
  if (!appConfig.encryptionKey) missing.push('ENCRYPTION_KEY');
  if (!appConfig.sessionSecret) missing.push('SESSION_SECRET');
  if (!whopConfig.configured) missing.push('WHOP_API_KEY/WEBHOOK_SECRET/ACCOUNT_ID');
  if (!redisConfig.configured) missing.push('UPSTASH_REDIS_REST_URL/TOKEN');
  if (!emailConfig.configured) missing.push('EMAIL_PROVIDER + its credentials');
  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(', ')}. ` +
        `Refusing to start — a payment platform must not boot half-configured.`,
    );
  }
}

/** Aggregate health payload for /api/health. Never includes secret values. */
export function integrationStatus() {
  return {
    payments: whopConfig.status,
    email: emailConfig.status,
    redis: redisConfig.status,
    queue: inngestConfig.status,
    encryption: appConfig.encryptionKey ? 'REAL' : ('NOT_CONFIGURED' as IntegrationStatus),
    paymentMethods: PAYMENT_METHODS,
  } satisfies Record<string, unknown>;
}

// --- Zod schemas for request bodies ----------------------------------------

export const checkoutSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(10),
  email: z.string().email().max(320),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;