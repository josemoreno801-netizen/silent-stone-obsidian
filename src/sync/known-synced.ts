/**
 * Read the persisted knownSynced blob and return it as a `Map<path, hash>`.
 *
 * Three input shapes we accept:
 *   - Legacy `string[]` (pre-LOC-47): paths only. Hydrate every path with the
 *     empty-string sentinel — the engine treats that as "no reliable history,
 *     preserve local, record the real hash next round" so an upgrade across
 *     plugin versions can't false-positive into a conflict storm.
 *   - Current `Record<path, hash>` (post-LOC-47): JSON-safe serialization of
 *     `Object.fromEntries(map)`. Round-trip into a Map.
 *   - Missing / null / unknown shape: fresh empty Map.
 *
 * Lives in its own module (not main.ts) so it can be unit-tested without pulling
 * in the `obsidian` runtime, which isn't bundled.
 */
export function hydrateKnownSynced(raw: unknown): Map<string, string> {
  if (Array.isArray(raw)) {
    return new Map(raw.filter((p): p is string => typeof p === 'string').map((p) => [p, '']));
  }
  if (raw && typeof raw === 'object') {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') m.set(k, v);
    }
    return m;
  }
  return new Map();
}
