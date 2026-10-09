/**
 * Email provider selection.
 *
 * THE RULE: there is no fallback. If EMAIL_PROVIDER is unset, or the named
 * provider has no credentials, `getEmailProvider()` returns null and the caller
 * surfaces NOT CONFIGURED. There is deliberately no console sender, no
 * jsonTransport, no "dev mode writes to stdout" branch — a fake sender means a
 * paid order silently never receives its code while the system reports success.
 * A loud NOT CONFIGURED is strictly better than a quiet lie.
 */

import { emailConfig } from '@/lib/env';
import type { EmailProviderKey, IntegrationStatus } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createResendEmailProvider } from './resend';
import { createSesEmailProvider } from './ses';
import { createSmtpEmailProvider } from './smtp';
import type { EmailProvider } from './types';

type Factory = () => EmailProvider;

const FACTORIES: Record<EmailProviderKey, Factory> = {
  SES: createSesEmailProvider,
  RESEND: createResendEmailProvider,
  SMTP: createSmtpEmailProvider,
};

let cached: EmailProvider | null = null;
let cachedKey: string | null = null;
let warnedKey: string | null = null;

/**
 * Cache key. Includes the credential *presence* (never the values) so a test or
 * a runtime config change rebuilds the client instead of reusing a stale one.
 */
function cacheKey(provider: EmailProviderKey | undefined): string {
  switch (provider) {
    case 'SES':
      return `SES:${emailConfig.ses.accessKeyId ? 'k' : '-'}:${emailConfig.ses.region}`;
    case 'RESEND':
      return `RESEND:${emailConfig.resend.apiKey ? 'k' : '-'}`;
    case 'SMTP':
      return `SMTP:${emailConfig.smtp.host ?? '-'}:${emailConfig.smtp.port}:${emailConfig.smtp.user ? 'u' : '-'}`;
    default:
      return 'NONE';
  }
}

/**
 * The configured adapter, or null when the integration is NOT CONFIGURED.
 *
 * Callers must handle null. `requireEmailProvider` is the convenience form that
 * throws EMAIL_NOT_CONFIGURED (HTTP 503) instead.
 */
export function getEmailProvider(): EmailProvider | null {
  const key = emailConfig.provider;
  const signature = cacheKey(key);

  if (cachedKey === signature) return cached;

  if (!key) {
    if (warnedKey !== signature) {
      warnedKey = signature;
      logger.warn('EMAIL_PROVIDER is not set — email is NOT CONFIGURED', {
        hint: 'Set EMAIL_PROVIDER to SES, RESEND or SMTP and its credentials.',
      });
    }
    cached = null;
    cachedKey = signature;
    return null;
  }

  const factory = FACTORIES[key];
  if (!factory) {
    if (warnedKey !== signature) {
      warnedKey = signature;
      logger.error('EMAIL_PROVIDER is not a supported value — email is NOT CONFIGURED', {
        requested: key,
        supported: ['SES', 'RESEND', 'SMTP'],
      });
    }
    cached = null;
    cachedKey = signature;
    return null;
  }

  const provider = factory();
  if (provider.status === 'NOT_CONFIGURED') {
    if (warnedKey !== signature) {
      warnedKey = signature;
      logger.warn(`Email provider ${key} selected but NOT CONFIGURED`, { provider: key });
    }
    cached = null;
    cachedKey = signature;
    return null;
  }

  cached = provider;
  cachedKey = signature;
  return provider;
}

/** Same selection, but throws EMAIL_NOT_CONFIGURED (503) instead of returning null. */
export function requireEmailProvider(): EmailProvider {
  const provider = getEmailProvider();
  if (!provider) {
    throw new AppError(
      'Email is NOT CONFIGURED. Set EMAIL_PROVIDER and its credentials before sending.',
      503,
      'EMAIL_NOT_CONFIGURED',
      { details: { provider: emailConfig.provider ?? null } },
    );
  }
  return provider;
}

/** Integration status for /api/health. Mirrors emailConfig.status exactly. */
export function emailProviderStatus(): IntegrationStatus {
  return emailConfig.status;
}

/**
 * Redacted configuration summary for diagnostics. Contains no credential
 * values — only whether each one is present.
 */
export function describeEmailConfig(): {
  provider: EmailProviderKey | null;
  status: IntegrationStatus;
  fromEmail: string | null;
  replyTo: string | null;
  hasCredentials: boolean;
} {
  const provider = emailConfig.provider ?? null;
  return {
    provider,
    status: emailConfig.status,
    fromEmail: emailConfig.fromEmail ?? null,
    replyTo: emailConfig.replyTo ?? null,
    hasCredentials: emailConfig.configured,
  };
}

/** Drops the memoised client. For tests and for credential rotation in-process. */
export function resetEmailProviderCache(): void {
  cached = null;
  cachedKey = null;
  warnedKey = null;
}