import type { ConflictHandler, ConflictInfo, ConflictResolution } from './engine';
import type { ConflictModalChoice } from '../ui/sync-modal';

export interface ConflictHandlerDeps {
  /** Read the user's chosen strategy at decision time, not at construction. */
  getStrategy: () => 'ask' | 'keep-local' | 'keep-server' | 'keep-both';
  /**
   * Open the conflict modal for one file and resolve with the user's choice.
   * `null` means the modal was dismissed without a pick — the factory
   * defaults that to `keep-local` (preserve the user's local copy).
   */
  openConflictModal: (info: ConflictInfo) => Promise<ConflictModalChoice | null>;
}

export interface ConflictHandlerWithReset {
  handler: ConflictHandler;
  /**
   * Clear the apply-to-all memory so the next conflict opens the modal again.
   * Call between sync rounds — the user's "apply to all" choice should not
   * leak into a future round they didn't consent to.
   */
  reset: () => void;
}

/**
 * Build the engine's conflict handler from injectable deps. Pure factory:
 * no Obsidian, no plugin types, easy to test.
 *
 * Behavior:
 * - Strategy `keep-local`/`keep-server`/`keep-both` → return that, never opens modal.
 * - Strategy `ask` → open modal per file. If the user picked "apply to all",
 *   remember the resolution and return it for every subsequent call until reset().
 * - Modal dismissed (null) → `keep-local` (safe default, never destroys local work).
 */
export function createConflictHandler(deps: ConflictHandlerDeps): ConflictHandlerWithReset {
  let appliedToAll: ConflictResolution | null = null;

  const handler: ConflictHandler = async (info) => {
    const strategy = deps.getStrategy();
    if (strategy !== 'ask') return strategy;

    if (appliedToAll) return appliedToAll;

    const choice = await deps.openConflictModal(info);
    if (choice === null) return 'keep-local';

    if (choice.applyToAll) appliedToAll = choice.resolution;
    return choice.resolution;
  };

  return {
    handler,
    reset: () => {
      appliedToAll = null;
    },
  };
}
