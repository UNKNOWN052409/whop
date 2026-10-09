import { PAYMENT_METHODS, PAYMENT_METHOD_BINDINGS, whopConfig, emailConfig, type IntegrationStatus, type PaymentMethodKey } from '@/lib/env';
import type { PublicProduct } from '@/catalog';

/**
 * Checkout readiness — computed on the server from real configuration.
 *
 * The storefront must never offer a payment path that cannot actually take
 * money. Unconfigured is surfaced, not faked: an unconfigured Whop key, an
 * empty enabled-method list, or an unconfigured email provider all produce
 * `canPay: false` plus an honest, human-readable reason.
 */
export interface CheckoutReadiness {
  providerName: string;
  providerStatus: IntegrationStatus;
  /** Enabled AND supported by the provider. Never the full enum. */
  methods: PaymentMethodKey[];
  emailStatus: IntegrationStatus;
  canPay: boolean;
  /** null when canPay is true. Human-readable, safe to render. */
  blockedReason: string | null;
}

/** Methods that are enabled in env AND actually supported by the provider. */
export function availablePaymentMethods(): PaymentMethodKey[] {
  return PAYMENT_METHODS.filter((method) => PAYMENT_METHOD_BINDINGS[method].supported);
}

export function checkoutReadiness(): CheckoutReadiness {
  const providerName = 'Whop';
  const providerStatus = whopConfig.status;
  const methods = availablePaymentMethods();
  const emailStatus = emailConfig.status;

  if (providerStatus === 'NOT_CONFIGURED') {
    return {
      providerName,
      providerStatus,
      methods,
      emailStatus,
      canPay: false,
      blockedReason:
        'Payment provider not configured. Set WHOP_API_KEY, WHOP_WEBHOOK_SECRET and WHOP_ACCOUNT_ID to enable checkout.',
    };
  }

  if (methods.length === 0) {
    return {
      providerName,
      providerStatus,
      methods,
      emailStatus,
      canPay: false,
      blockedReason:
        'No payment method is enabled. Set ENABLED_PAYMENT_METHODS to a provider-supported method (CARD).',
    };
  }

  if (emailStatus === 'NOT_CONFIGURED') {
    return {
      providerName,
      providerStatus,
      methods,
      emailStatus,
      canPay: false,
      blockedReason:
        'Email delivery is not configured, so a code could not be delivered after payment. Checkout is disabled rather than taking money it cannot deliver.',
    };
  }

  return {
    providerName,
    providerStatus,
    methods,
    emailStatus,
    canPay: true,
    blockedReason: null,
  };
}

export interface ProductCardModel {
  product: PublicProduct;
  readiness: CheckoutReadiness;
  purchasable: boolean;
}

/** Shared projection so every surface shows the same buy-button state. */
export function productCardModel(product: PublicProduct): ProductCardModel {
  const readiness = checkoutReadiness();
  return {
    product,
    readiness,
    purchasable: readiness.canPay && product.availability === 'IN_STOCK',
  };
}