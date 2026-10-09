/**
 * Tiny class-name joiner. Falsy entries are dropped so conditional Tailwind
 * classes can be written inline without a dependency.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}