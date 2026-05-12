---
description: Ship the ticket on the current branch — commit, flip Linear to Done, and (if mission sub-issue) report mission progress or close the mission
disable-model-invocation: true
---

# /ss-ship — close the current ticket

You are in the **plugin field session** (`silent-stone-obsidian`). The operator finished work on a ticket and wants to commit + close it. This command handles both **mission sub-issues** (the common case) and **one-off tickets** (when the operator works outside a mission).

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

This command writes to git AND Linear. It is user-invoked only.

## Order of operations matters

**Commit first, then flip Linear to Done.** A failed `git commit` must not leave a Linear ticket falsely closed. Never reverse this order. If the commit fails, stop — do not touch Linear.

## Steps

### 1. Read the current branch + derive the ticket ID

```bash
git rev-parse --abbrev-ref HEAD
```

Expected format: `josemoreno801/loc-NN-<slug>` (per the existing branch convention). Parse the `loc-NN` segment → `LOC-NN` (uppercase).

**If the branch doesn't match the convention** (e.g. `main`, `chore/something`):
- Print: `Branch <name> doesn't match the LOC-NN convention. Are you on the right branch? /ss-ship needs a ticketed branch to know what to close.`
- Stop. The operator may have forgotten to `git checkout -b`.

### 2. Confirm the ticket exists and isn't already Done

```
get_issue("LOC-NN", includeRelations: true)
```

- If 404 / not found: stop. Tell the operator the ID parsed from the branch doesn't exist in Linear.
- If `state.type === "completed"`: stop. Tell the operator the ticket is already Done — they probably ran `/ss-ship` twice. Don't double-close.

### 3. Determine mission context

Check the returned ticket's `parent` field.

- **Mission sub-issue**: `parent` is set. Confirm the parent's title starts with `Mission:` AND `parent.state.type !== "completed"` (the mission is still in flight). If both true, this `/ss-ship` is a mission step.
- **One-off ticket**: `parent` is null, OR `parent.title` doesn't start with `Mission:`, OR the mission parent is already Done. Treat as a standalone ship.

### 4. Propose the commit message

Soldier-mode voice. Two lines:

```
<type>(<scope>): <short imperative subject> (LOC-NN)

<one-sentence why — what this changes for the user, not the code>
```

`<type>` from the ticket's nature: `feat` (new behavior), `fix` (bug), `refactor` (no behavior change), `docs`, `chore`, `test`. Pick the closest fit; don't invent. `<scope>` is the code area touched (e.g. `plugin`, `crypto`, `ui`, `settings`, `sync`).

Print the proposed message and ask: `Commit with this message? [y/N]`

**Wait for explicit `y`** before proceeding. Any other input → stop and let the operator amend the message manually.

### 5. Commit

After operator confirms:

```bash
git add -A
git commit -m "<the proposed message>"
```

Use a heredoc-style commit (see the workspace `CLAUDE.md` rules) and add the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` line.

**If `git commit` fails** (pre-commit hook, nothing to commit, signing failure):
- Print the error. **Stop. Do not touch Linear.**
- Investigate. Don't bypass hooks with `--no-verify` unless the operator explicitly asks.
- Don't `--amend` to recover from a failed hook — create a new commit.

**If commit succeeds:** print the new commit SHA + subject line. Then proceed.

### 6. Flip Linear to Done

```
save_issue(id: "LOC-NN", state: "Done")
```

Immediately verify:

```
get_issue("LOC-NN")
```

Confirm `state.type === "completed"`. If verify fails, **say so loudly** — the operator needs to know Linear didn't actually update so they can fix it by hand. The commit already happened; the ticket just didn't close.

### 7. Mission rollup (if mission sub-issue)

If step 3 determined this is a mission sub-issue:

- `list_issues(parentId: "<parent.id>")` → all sub-issues with current states.
- Count `Done` vs total.

**Case A — mission still in flight** (some sub-issues are not Done):
```
LOC-NN shipped. <X> of <N> done. /ss-pull for next.
```

**Case B — mission complete** (just-shipped sub-issue was the last Backlog/InProgress one):
1. Compose a one-paragraph wrap-up comment (soldier-mode, no bullets, ~2–4 sentences). Mention each shipped LOC-NN inline. Note what's now usable.
2. `save_comment(issueId: "<parent.id>", body: "<wrap text>")`
3. `save_issue(id: "<parent.id>", state: "Done")`
4. `get_issue("<parent.id>")` to verify — confirm `state.type === "completed"`.
5. Print:
   ```
   Mission complete — <parent.title>
   Wrap comment posted: <comment.url or parent.url>
   Return to HQ.
   ```

### 8. Non-mission shipping (one-off ticket)

If step 3 determined this is a one-off:

```
LOC-NN shipped. (one-off — not part of a mission)
```

End. No mission rollup, no parent comment. Don't refuse to ship — the operator can absolutely close a standalone ticket via `/ss-ship`.

## Output discipline

- Always show the proposed commit message **before** committing. Never auto-commit without explicit `y`.
- Always print the resulting commit SHA after a successful commit so the operator can `git log` / push / verify.
- Use the actual current date in any messaging, never placeholder dates.
- Never echo or include any API keys, tokens, or secrets in commit messages or output.

## Anti-patterns (never do)

- **Flipping Linear to Done before the commit succeeds.** Order is non-negotiable.
- **Bypassing pre-commit hooks** with `--no-verify` unless the operator asks for it. Hook failures mean something is wrong; investigate.
- **Amending the previous commit** to recover from a failed pre-commit hook. The failed commit didn't land — amending would modify the wrong commit. Create a new commit.
- **Refusing to ship one-off tickets.** The plan explicitly requires `/ss-ship` to handle non-mission shipping. Don't gate-keep.
- **Posting a wrap comment on a half-finished mission.** Wrap only fires when the LAST sub-issue ships. Re-count after the state transition.
- **Skipping the `get_issue` verify** after any Linear write. Silent-failure landmine.

## Landmines

1. Branch parsing assumes `loc-NN` lowercase in the branch. If the operator named it `LOC-NN` (uppercase mid-branch), be tolerant — match case-insensitively, normalize to `LOC-NN` for Linear.
2. `save_comment` and `save_issue` are separate MCP calls. The mission-complete path runs both — verify each independently.
3. Linear's `query: "Mission:"` is a broad search. Step 3 already has the parent in hand from `get_issue includeRelations:true`, so this command never needs to search by title. Don't fall back to title search.
