/**
 * Role-based access control (spec §15).
 *
 *   OWNER  >  ADMIN  >  SUPPORT  >  CUSTOMER
 *
 * `roles.ts` holds the ordering itself and is edge-safe; this module holds the
 * DB-backed guards and the list of actions that are OWNER-only. `requireRole`
 * itself lives in `session.ts` (it needs the session) and is re-exported here,
 * so there is exactly ONE implementation of the hierarchy check in the codebase
 * and no import cycle.
 *
 * OWNER-ONLY ACTIONS
 *   These are the operations where "an admin could do this" is a security
 *   incident rather than a policy preference:
 *
 *     - writing or reading supplier API credentials,
 *     - refunds at or above the large-refund threshold,
 *     - disabling MFA on an account (including your own),
 *     - changing a role, and
 *     - anything that moves money out of the platform.
 *
 *   They are enumerated as data so a route states `requireOwnerAction('...')`
 *   and the audit trail can record which rule fired, rather than every call site
 *   re-deriving the same judgement.
 */

import {
  ROLE_RANK,
  ROLES,
  coerceRole,
  hasRole as hasRoleRank,
  isOwner,
  isRole,
  isStaff,
  roleRank,
  type Role,
} from '@/auth/roles';
import {
  requireRole,
  requireSession,
  type AdminSession,
  type RequireRoleResult,
  type Session,
  type SessionLike,
} from '@/auth/session';
import { errors } from '@/lib/errors';
import { logger } from '@/lib/logger';

// Re-exported so callers have one obvious import for authorisation.
export { ROLE_RANK, ROLES, coerceRole, hasRoleRank, isOwner, isRole, isStaff, roleRank };
export type { Role };
export type { AdminSession, Session, SessionLike, RequireRoleResult };

/** The single implementation of the role guard. See `session.ts`. */
export { requireRole, requireUser, requireSession, getSession } from '@/auth/session';

/** Roles that may reach the admin surface at all. */
export const STAFF_ROLES: readonly Role[] = ['SUPPORT', 'ADMIN', 'OWNER'];

/** The hierarchy, rendered for error messages and documentation. */
export const ROLE_HIERARCHY = 'OWNER > ADMIN > SUPPORT > CUSTOMER' as const;

// ---------------------------------------------------------------------------
// OWNER-only actions
// ---------------------------------------------------------------------------

export const OWNER_ONLY_ACTIONS = [
  'supplier.credentials.write',
  'supplier.credentials.read',
  'refund.large',
  'refund.manual',
  'mfa.disable',
  'mfa.enrol',
  'role.change',
  'account.disable',
  'payouts.manage',
  'admin.bootstrap',
] as const;

export type OwnerOnlyAction = (typeof OWNER_ONLY_ACTIONS)[number];

const OWNER_ONLY_SET: ReadonlySet<string> = new Set(OWNER_ONLY_ACTIONS);

export function isOwnerOnlyAction(action: string): action is OwnerOnlyAction {
  return OWNER_ONLY_SET.has(action);
}

/**
 * True when `role` may perform an OWNER-only action. Always OWNER — never
 * "ADMIN unless configured", because a flag that silently widens this is how
 * supplier credentials end up readable by a support contractor.
 */
export function canPerformOwnerAction(role: string, action: string): boolean {
  if (!isOwnerOnlyAction(action)) return true;
  return isOwner(role);
}

/** Throws FORBIDDEN unless `role` is OWNER. */
export function assertOwnerRole(role: string, action?: string): void {
  if (isOwner(role)) return;
  logger.warn('OWNER-only action refused', {
    role,
    action: action ?? 'unspecified',
  });
  throw errors.forbidden(
    action
      ? `The "${action}" action requires the OWNER role`
      : 'This action requires the OWNER role',
  );
}

/** True when `role` is at or above `minimum`. Unknown roles never pass. */
export function canPerform(role: string, minimum: Role): boolean {
  return hasRoleRank(role, minimum);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Requires OWNER against the current request's session. Throws otherwise. */
export async function requireOwner(session?: SessionLike): Promise<AdminSession> {
  const result = await requireRole('OWNER', session ?? undefined);
  return { userId: result.userId, email: result.email, name: result.name, role: result.role };
}

/**
 * Requires OWNER for a named OWNER-only action. The action name is included in
 * the thrown message and the log line so an audit can tell which rule fired.
 */
export async function requireOwnerAction(
  action: OwnerOnlyAction,
  session?: SessionLike,
): Promise<AdminSession> {
  const result = await requireRole('OWNER', session ?? undefined);
  assertOwnerRole(result.role, action);
  return { userId: result.userId, email: result.email, name: result.name, role: result.role };
}

/** Non-throwing variant, for UI that should hide a control rather than 403. */
export function isAllowed(session: AdminSession | null | undefined, minimum: Role): boolean {
  if (!session) return false;
  return hasRoleRank(session.role, minimum);
}

/** Non-throwing OWNER-only check, for the same reason. */
export function isOwnerAllowed(session: AdminSession | null | undefined, action: string): boolean {
  if (!session) return false;
  return canPerformOwnerAction(session.role, action);
}

/**
 * The authoritative staff guard for a request: loads the session, refuses
 * customers, and honours the MFA policy. Throws.
 */
export async function requireStaff(minimum: Role = 'SUPPORT'): Promise<Session> {
  return requireSession(minimum);
}

/** Rank of a role as a number, for callers that need to sort or compare. */
export function rankOf(role: string): number {
  return roleRank(role);
}
