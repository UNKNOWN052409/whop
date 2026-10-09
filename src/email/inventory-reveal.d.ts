/**
 * Cross-workstream type bridge for `@/inventory/reveal`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plaintext redeem code is decrypted by src/inventory/reveal.ts, which is
 * owned by the inventory workstream, not this one. The email delivery service
 * needs exactly one thing from it: `revealCodeForOrder(orderId)`, which returns
 * the order's assigned code(s).
 *
 * TypeScript only consults ambient module declarations when ordinary module
 * resolution has already FAILED, so this declaration is inert the moment
 * src/inventory/reveal.ts lands: the real module and its real signature win.
 * Until then it keeps this workstream compiling instead of littering the tree
 * with "Cannot find module" errors in a file the lead has to triage.
 *
 * The return type is deliberately `unknown`. The exact shape of the revealed
 * record is the inventory workstream's contract, not ours, so
 * src/email/reveal.ts normalises it defensively at runtime rather than
 * pretending to know it. If the real export is narrower, tighten this line —
 * do not delete the file without replacing the import.
 *
 * Invariant enforced by this workstream: the value returned here is never
 * logged, never persisted, and never leaves src/email through anything other
 * than the outbound provider request.
 */

declare module '@/inventory/reveal' {
  /**
   * Reveal the plaintext redeem code(s) assigned to an order.
   *
   * Expected to resolve to one of:
   *   - a single record with a `code` string,
   *   - an array of such records (Order.quantity can exceed 1),
   *   - `{ codes: [...] }`,
   *   - a bare code string,
   *   - or null/undefined when the order has nothing assigned.
   */
  export function revealCodeForOrder(orderId: string): Promise<unknown>;
}