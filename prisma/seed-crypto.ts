/**
 * Seed-only crypto helper.
 *
 * The seed does not create inventory, so this exists purely to fail fast: if
 * ENCRYPTION_KEY is missing or malformed, we want that discovered here rather
 * than during the operator's first real inventory import.
 */

import { createHmac } from 'node:crypto';

function key(): string {
  const raw = process.env.ENCRYPTION_KEY ?? process.env.FINGERPRINT_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return raw;
}

export function hashCodeForSeed(value: string): string {
  return createHmac('sha256', key()).update(value).digest('hex');
}