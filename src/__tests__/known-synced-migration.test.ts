import { describe, expect, it } from 'vitest';
import { hydrateKnownSynced } from '../sync/known-synced';

// hydrateKnownSynced is the boundary between persisted state and the engine.
// It must accept three shapes — legacy paths-only array, post-LOC-47 record,
// and absent / garbage — and never throw, so an upgrade across plugin versions
// degrades gracefully instead of locking the user out of sync.

describe('hydrateKnownSynced — legacy paths-only array', () => {
  it('maps every path to the empty-string sentinel ("preserve local, record real hash next round")', () => {
    const result = hydrateKnownSynced(['a.md', 'subfolder/b.md']);
    expect(result.size).toBe(2);
    expect(result.get('a.md')).toBe('');
    expect(result.get('subfolder/b.md')).toBe('');
  });

  it('drops non-string entries defensively', () => {
    const result = hydrateKnownSynced(['ok.md', 42, null, undefined, { broken: true }]);
    expect([...result.keys()]).toEqual(['ok.md']);
  });

  it('returns an empty Map for an empty array', () => {
    const result = hydrateKnownSynced([]);
    expect(result.size).toBe(0);
  });
});

describe('hydrateKnownSynced — current Record<path, hash> shape', () => {
  it('round-trips a JSON-serialized Map back into a Map', () => {
    const original = new Map<string, string>([
      ['a.md', 'abc123'],
      ['nested/b.md', 'def456'],
    ]);
    const serialized = Object.fromEntries(original);
    const result = hydrateKnownSynced(serialized);
    expect(result).toEqual(original);
  });

  it('drops entries whose value is not a string', () => {
    const result = hydrateKnownSynced({
      'good.md': 'hash',
      'broken.md': 42,
      'alsoBroken.md': null,
      'object.md': { nested: true },
    });
    expect([...result.keys()]).toEqual(['good.md']);
    expect(result.get('good.md')).toBe('hash');
  });
});

describe('hydrateKnownSynced — absent or unknown shapes', () => {
  it('returns empty Map for null', () => {
    expect(hydrateKnownSynced(null).size).toBe(0);
  });
  it('returns empty Map for undefined', () => {
    expect(hydrateKnownSynced(undefined).size).toBe(0);
  });
  it('returns empty Map for a string', () => {
    expect(hydrateKnownSynced('garbage').size).toBe(0);
  });
  it('returns empty Map for a number', () => {
    expect(hydrateKnownSynced(42).size).toBe(0);
  });
});
