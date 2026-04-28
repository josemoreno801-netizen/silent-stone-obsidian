/**
 * Shared ignore-path filter used by both the file watcher and the sync engine's
 * vault enumerator. Keeps both layers consistent on what counts as syncable.
 *
 * Currently only supports the `dir/**` prefix form. Glob expansion can be added
 * later if real users need it.
 */

export const DEFAULT_IGNORE_PATHS = ['.obsidian/**', '.trash/**', '.git/**'];

export function compileIgnorePrefixes(patterns: string[] | undefined): string[] {
  return (patterns ?? DEFAULT_IGNORE_PATHS)
    .filter((p) => p.endsWith('/**'))
    .map((p) => p.slice(0, -3));
}

export function isIgnored(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}
