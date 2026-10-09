/**
 * Ambient types for `bcryptjs@2`.
 *
 * bcryptjs 2.4.3 ships no `.d.ts` and `@types/bcryptjs` is not installed, so a
 * plain `import bcrypt from 'bcryptjs'` fails under `strict` with TS7016.
 * These declarations cover exactly the surface this codebase uses.
 *
 * If `@types/bcryptjs` is ever added to package.json, DELETE THIS FILE — two
 * declarations of the same module conflict.
 *
 * Runtime note (verified against node_modules/bcryptjs/dist/brypt.js): the
 * promise-returning overloads really do return a Promise, but the work inside
 * `_hash` is fully synchronous, so a cost-12 hash blocks the Node event loop
 * for roughly a quarter of a second. That is acceptable for an admin login and
 * is why `authConfig.bcryptCost` is configurable, but it is the reason the
 * login endpoint is rate limited rather than relying on the hash cost alone.
 */
declare module 'bcryptjs' {
  const bcrypt: {
    genSalt(rounds?: number): Promise<string>;
    genSaltSync(rounds?: number): string;
    hash(data: string, salt: string | number): Promise<string>;
    hashSync(data: string, salt: string | number): string;
    compare(data: string, encrypted: string): Promise<boolean>;
    compareSync(data: string, encrypted: string): boolean;
    getRounds(hash: string): number;
  };

  export default bcrypt;
}
