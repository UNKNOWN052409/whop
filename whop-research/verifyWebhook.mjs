import { Webhook, WebhookVerificationError } from "standardwebhooks";
export const MISSING_KEY_MESSAGE = "Cannot verify a webhook without a key. Pass the endpoint's signing secret as `key`.";
/**
 * Base64-encode the secret so `Webhook` derives the key Whop actually signs with.
 *
 * Whop's backend HMACs with the *literal bytes* of the secret it issued
 * (`WebhooksManager::SignWebhook` passes `webhook.webhook_secret` straight to
 * `OpenSSL::HMAC`). `standardwebhooks`' `Webhook` instead base64-decodes whatever it is
 * handed to derive its key, so handing it the secret raw derives the wrong key — and,
 * because its decoder is strict, a `ws_` secret does not even fail as a verification
 * error: `_` is outside the base64 alphabet, so the constructor throws
 * `Base64Coder: incorrect characters for decoding`. Encoding here cancels that decode
 * out, leaving exactly the bytes the backend signed with.
 *
 * The whole secret is encoded, prefix included, because the backend never strips a prefix
 * either. That also disarms the library's own `whsec_` stripping: base64 output cannot
 * begin with `whsec_`, since `_` is not in the base64 alphabet.
 *
 * `TextEncoder`/`btoa` rather than `Buffer` so this holds outside Node too — the secret is
 * encoded as UTF-8, not latin1, which `btoa` alone would get wrong for a non-ASCII secret.
 */
function hmacKey(key) {
    const bytes = new TextEncoder().encode(key);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
/**
 * Verifies `payload` against the signature headers and returns the parsed body.
 *
 * @param payload The raw, unmodified request body. Verifying a re-serialized body fails:
 * the signature covers the exact bytes sent. In Next.js that is `await request.text()`,
 * never `await request.json()`.
 * @throws {Error} when `key` is missing or empty.
 * @throws {WebhookVerificationError} when a signature header is missing or malformed, the
 * timestamp is outside the tolerance window, or no signature matches.
 *
 * `TEvent` is an unchecked assertion on the parsed body, not a validated shape — nothing
 * here checks the payload against it.
 */
export function unwrapWebhook(payload, { headers, key }) {
    if (!key) {
        throw new Error(MISSING_KEY_MESSAGE);
    }
    return new Webhook(hmacKey(key)).verify(payload, headers);
}
export { WebhookVerificationError };
