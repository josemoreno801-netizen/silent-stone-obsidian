#!/usr/bin/env bash
# Symlink the built plugin into a target Obsidian vault for live development.
# Run `npm run dev` in another terminal first so main.js stays fresh.
# Reload Obsidian (Cmd/Ctrl+R or "Reload app without saving" command) to pick
# up rebuilt code.
#
# Usage:
#   bash scripts/install-to-vault.sh /path/to/your/vault
#   # or:
#   npm run install-to-vault -- /path/to/your/vault

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <vault-path>" >&2
  exit 64  # EX_USAGE
fi

VAULT_PATH="$1"
PLUGIN_ID="silent-stone-sync"

# Resolve plugin root from this script's location (works whether called via
# bash, npm run, or symlink).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -d "$VAULT_PATH" ]; then
  echo "Error: vault path does not exist: $VAULT_PATH" >&2
  exit 66  # EX_NOINPUT
fi

if [ ! -d "$VAULT_PATH/.obsidian" ]; then
  echo "Error: $VAULT_PATH does not look like an Obsidian vault (no .obsidian/ directory)." >&2
  echo "Open the folder in Obsidian once to initialize it, then re-run." >&2
  exit 66
fi

TARGET_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$TARGET_DIR"

# Replace any existing symlinks/files for an idempotent re-run.
for f in main.js manifest.json styles.css; do
  if [ ! -f "$PLUGIN_ROOT/$f" ]; then
    echo "Error: $PLUGIN_ROOT/$f not found. Run 'npm run build' or 'npm run dev' first." >&2
    exit 1
  fi
  rm -f "$TARGET_DIR/$f"
  ln -s "$PLUGIN_ROOT/$f" "$TARGET_DIR/$f"
done

echo "Linked $PLUGIN_ID into $TARGET_DIR"
echo "Next: open Obsidian, enable Community Plugins, then enable 'Silent Stone Sync'."
echo "After code changes, reload Obsidian with Cmd/Ctrl+R."
