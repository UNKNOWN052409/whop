/**
 * Public surface of the inventory module.
 *
 * `revealCodeForOrder` is deliberately NOT re-exported here. It returns a
 * PLAINTEXT redeem code, and the only legitimate caller is the delivery path
 * (src/email/reveal.ts). Keeping it out of the barrel file means reaching it
 * requires a deliberate, greppable import — "what can expose a code?" has a
 * one-line answer.
 */

export { reserveCodes, markAssigned } from './allocate';
export type {
  ReserveCodesInput,
  ReserveCodesResult,
  ReservedCodeRef,
} from './allocate';

export { releaseExpiredReservations } from './release';

export { revokeCode, revokeCodeForOrder, markDelivered } from './revoke';

export { importInventory } from './import';
export type {
  ImportBatchStatus,
  ImportOptions,
  ImportProductFacts,
  ImportRow,
  ImportRowResult,
  ImportRowStatus,
  ImportResult,
} from './import';

export { inventorySummary, totalAvailable } from './stats';
export type { ProductInventorySummary } from './stats';