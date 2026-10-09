/**
 * Role hierarchy (spec §15).
 *
 * EDGE-SAFE MODULE — imported by `src/middleware.ts`. No Prisma, no Node APIs.
 * The DB-backed guards live in `rbac.ts`; this file is only the ordering and the
 * predicates so the Edge runtime can answer "is this ADMIN or better?" from the
 * signed session token alone, without touching the database.
 *
 *   OWNER  >  ADMIN  >  SUPPORT  >  CUSTOMER
 */

import type { UserRole } from '@prisma/client';

/** Numeric rank per role. Higher outranks lower. */
export const ROLE_RANK: Readonly<Record<string, number>> = {
  CUSTOMER: 0,
  SUPPORT: 1,
  ADMIN: 2,
  OWNER: 3,
};

export const ROLES = ['CUSTOMER', 'SUPPORT', 'ADMIN', 'OWNER'] as const;

/** Union of the role names. Structurally identical to Prisma's `UserRole`. */
export type Role = (typeof ROLES)[number];

/**
 * Compile-time guard: if the Prisma enum ever gains or loses a member, this
 * stops type-checking instead of silently widening or narrowing authorisation.
 */
type PrismaRoleMatchesRole = UserRole extends Role ? (Role extends UserRole ? true : never) : never;
const prismaRoleMatchesRole: PrismaRoleMatchesRole = true;
void prismaRoleMatchesRole;

/** Narrow an arbitrary string (e.g. from a claim) to a known role. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_RANK, value);
}

/** Rank of a role; unknown roles rank lowest rather than throwing. */
export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? -1;
}

/** True when `role` is at or above `minimum`. Unknown roles never pass. */
export function hasRole(role: string, minimum: Role): boolean {
  return roleRank(role) >= roleRank(minimum);
}

/** True only for OWNER. */
export function isOwner(role: string): boolean {
  return role === 'OWNER';
}

/** True for roles that may reach the admin surface at all. */
export function isStaff(role: string): boolean {
  return roleRank(role) >= roleRank('SUPPORT');
}

/** Normalises a role name coming from the database into our union. */
export function coerceRole(value: string): Role {
  return isRole(value) ? value : 'CUSTOMER';
}
