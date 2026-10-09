import { decrypt } from '@/lib/crypto';
import { errors } from '@/lib/errors';

/**
 * THE ONLY PLACE A PLAINTEXT REDEEM CODE IS DECRYPTED.
 *
 * Everything else in the system deals exclusively in encrypted ciphertext or
 * opaque ids. This module is the narrow waist through which a plaintext code
 * reaches a customer.
 *
 * RULES FOR CALLERS:
 *  - Call ONLY from the delivery path (building the fulfilment email).
 *  - NEVER log the returned value, not even at debug level.
 *  - NEVER include it in an error message, an analytics event, or an HTTP
 *    response body.
 */

export interface RevealedCode {
  code: string;
  productName: string;
  faceValueMinor: number;
  currency: string;
  region: string;
  redemptionInstructions: string | null;
}

export async function revealCodeForOrder(orderId: string): Promise<RevealedCode[]> {
  // Imported lazily to keep this module importable in environments without a
  // database client (e.g. pure unit tests of crypto).
  const { prisma } = await import('@/db/prisma');

  const codes = await prisma.inventoryCode.findMany({
    where: { orderId },
    include: {
      product: { select: { productName: true, faceValueMinor: true, currency: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (codes.length === 0) {
    throw errors.notFound('Inventory for order');
  }

  return codes.map((row) => ({
    code: decrypt(row.codeCiphertext),
    productName: row.product.productName,
    faceValueMinor: row.product.faceValueMinor,
    currency: row.product.currency,
    region: row.region,
    redemptionInstructions: row.redemptionInstructions,
  }));
}