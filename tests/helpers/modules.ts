/**
 * Module discovery for suites that target code owned by another workstream.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several areas under test (the Whop adapter, the pricing engine, the fraud
 * engine, reconciliation) are written by other workstreams in parallel with
 * this one. A static `import { foo } from '@/catalog/pricing'` would make the
 * ENTIRE run fail to collect the moment that file is absent, which is exactly
 * the "errors rather than skips" outcome the suite is required to avoid.
 *
 * `import.meta.glob` gives the opposite guarantee: it enumerates the files that
 * exist at transform time, so a module that has not landed yet yields `null`
 * instead of a module-resolution crash. Each suite then either runs for real or
 * skips with a title that names exactly what was missing.
 *
 * This is a deliberate trade-off, not a convenience: a suite that cannot find its
 * subject SKIPS rather than passes. The titles make that visible in the reporter
 * output, and the missing-module list is reported in the workstream's return
 * value. Nothing here weakens an assertion — the skip decision is made once, at
 * collection time, before a single assertion runs.
 */

export interface LoadedModule {
  /** Project-root-relative path that was found, e.g. "/src/lib/money.ts". */
  path: string;
  /** The evaluated module namespace. */
  exports: Record<string, unknown>;
}

type ModuleLoader = () => Promise<unknown>;

const registry = import.meta.glob('/src/**/*.ts') as Record<string, ModuleLoader>;

/** Every source module Vitest can see. Useful for the security scan. */
export function sourceModulePaths(): string[] {
  return Object.keys(registry).sort();
}

function normalise(candidate: string): string {
  return candidate.startsWith('/') ? candidate : `/${candidate.replace(/^\.\//, '')}`;
}

/**
 * Loads the first candidate path that exists. Candidates are tried in order, so
 * list the canonical location first and fallbacks after.
 */
export async function loadFirstModule(candidates: readonly string[]): Promise<LoadedModule | null> {
  const wanted = candidates.map(normalise);
  for (const path of wanted) {
    const loader = registry[path];
    if (!loader) continue;
    const namespace = (await loader()) as Record<string, unknown>;
    return { path, exports: namespace };
  }
  return null;
}

/**
 * Finds the first named export present on a loaded module.
 *
 * @param names Ordered export-name candidates. Using a list rather than one hard
 *              name is what lets these suites survive a rename during parallel
 *              development; the resolved name is reported in the return value so
 *              a rename can never go unnoticed.
 */
export function pickExport<T>(
  module: LoadedModule | null,
  names: readonly string[],
): { name: string; value: T } | null {
  if (!module) return null;
  for (const name of names) {
    const value = module.exports[name];
    if (value !== undefined) return { name, value: value as T };
  }
  return null;
}

/** Human-readable explanation used in a skipped suite title. */
export function describeMissing(subject: string, missing: string): string {
  return `${subject} — SKIPPED, not implemented yet (${missing})`;
}

/** Pick the first present key of an object, for provider status unions. */
export function firstOf<T extends Record<string, unknown>>(source: T, keys: readonly (keyof T)[]): T[keyof T] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) return value;
  }
  return undefined;
}
