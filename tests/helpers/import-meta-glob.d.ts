/**
 * Ambient typing for Vite's `import.meta.glob`.
 *
 * `vitest.config.ts` already runs the suite through Vite, but the project's
 * tsconfig pins `"types": ["node", "vitest/globals"]` and deliberately does not
 * pull in `vite/client`. Rather than edit a file this workstream does not own,
 * the one API the suite relies on is declared here.
 *
 * Declared without top-level import/export so the file stays a global script and
 * merges with the built-in `ImportMeta` interface.
 */
interface ImportMeta {
  /**
   * Statically-known module map. Keys are project-root-relative paths; values are
   * async loaders. Unlike a bare `import(specifier)` this NEVER throws for a
   * path that does not exist — a missing module is simply absent from the map,
   * which is what lets a suite report "not implemented yet" instead of erroring
   * the whole run.
   */
  glob(pattern: string, options?: { eager?: boolean }): Record<string, () => Promise<unknown>>;
}
