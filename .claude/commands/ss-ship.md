---
description: Ship the ticket on the current branch — commit, push, open PR. Integration auto-flips Linear on PR open/merge.
disable-model-invocation: true
---

# /ss-ship — commit + push + PR for the current ticket

You are in the **plugin field session** (`silent-stone-obsidian`). The operator finished work on a ticket and wants to commit + push + open a PR. This command handles both **mission sub-issues** (the common case) and **one-off tickets** (when the operator works outside a mission).

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

This command writes to git AND opens a GitHub PR. **It never writes to Linear.** The ADR-004 Linear↔GitHub integration (Approach B) owns leaf-ticket state: branch detected → `In Progress`, PR merged → `Done`. Racing the integration with manual `save_issue` calls is the documented failure mode this rewrite eliminates.

## Order of operations

**Commit → push → PR.** Any failure in the chain stops without touching Linear. The integration's branch/PR webhooks handle every leaf-ticket state flip.

If you're shipping the LAST sub-issue of a mission, you'll see a HINT to run `/ss-mission-status` afterward — that's where parent rollup happens lazily, against real merged-PR data. **Do not** flip the mission parent to Done from inside `/ss-ship`.

## Steps

### 1. Read the current branch + derive the ticket ID

```bash
git rev-parse --abbrev-ref HEAD
```

Expected format: `josemoreno801/loc-NN-<slug>` (per the existing branch convention). Parse the `loc-NN` segment → `LOC-NN` (uppercase).

**If the branch doesn't match the convention** (e.g. `main`, `chore/something`):
- Print: `Branch <name> doesn't match the LOC-NN convention. Are you on the right branch? /ss-ship needs a ticketed branch to know what to ship.`
- Stop. The operator may have forgotten to `git checkout -b`.

### 2. Confirm the ticket exists and isn't already Done

```
get_issue("LOC-NN", includeRelations: true)
```

- If 404 / not found: stop. Tell the operator the ID parsed from the branch doesn't exist in Linear.
- If `state.type === "completed"`: stop. Ticket already Done means the integration already saw a merge for this branch. Re-shipping makes no sense — the operator is on a stale branch.

(Backlog and In Progress are both acceptable here. The integration may have already flipped Backlog → In Progress when the branch was pushed; either state is fine to ship from.)

### 3. Determine mission context

Check the returned ticket's `parent` field.

- **Mission sub-issue**: `parent` is set. Confirm the parent's title starts with `Mission:` AND `parent.state.type !== "completed"`. If both true, this `/ss-ship` is a mission step.
- **One-off ticket**: `parent` is null, OR `parent.title` doesn't start with `Mission:`, OR the mission parent is already Done. Treat as a standalone ship.

### 4. Propose the commit message

Soldier-mode voice. Two lines:

```
<type>(<scope>): <short imperative subject> (LOC-NN)

<one-sentence why — what this changes for the user, not the code>
```

`<type>` from the ticket's nature: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`. Pick the closest fit; don't invent. `<scope>` is the code area touched (e.g. `plugin`, `crypto`, `ui`, `settings`, `sync`).

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
- Print the error. **Stop. Do not push. Do not touch Linear.**
- Investigate. Don't bypass hooks with `--no-verify` unless the operator explicitly asks.
- Don't `--amend` to recover from a failed hook — create a new commit.

**If commit succeeds:** print the new commit SHA + subject line. Then proceed to push.

### 6. Push + open PR

Push the branch with upstream tracking:

```bash
git push -u origin <current-branch>
```

If push fails (auth error, network, non-fast-forward) → print the error and stop. Do not force-push to recover. Do not touch Linear. The integration only flips state on a successful branch event from GitHub, so a failed push leaves Linear correctly unchanged.

If push succeeds, open the PR:

```bash
gh pr create --fill --base main --repo josemoreno801-netizen/silent-stone-obsidian
```

`--fill` populates title and body from the commit message(s) on the branch. Capture the PR URL from gh's output.

The integration will flip `LOC-NN` Backlog → In Progress within ~3s of branch push if it hadn't already. Don't poll for this — it's eventual-consistency by design.

### 7. Mission-rollup hint (lazy, read-only)

If step 3 determined this is a mission sub-issue:

```
list_issues(parentId: "<parent.id>")
```

Count Done vs total **without writing to Linear**. This is purely for the operator's awareness.

**Case A — mission still has open sub-issues**:

```
LOC-NN shipped → PR opened. <X> of <N> sub-issues complete in <parent.title>. /ss-pull for next.
```

**Case B — every other sub-issue is already Done**:

```
LOC-NN shipped → PR opened. Looks like the last sub-issue of <parent.title>.
Wait for the PR to merge (integration will flip LOC-NN to Done automatically).
Then run /ss-mission-status to lazily roll up the parent.
```

The "looks like" hedge is intentional. At this point the just-shipped PR is OPEN, not merged — the integration hasn't flipped LOC-NN to Done yet. Parent rollup MUST wait for real merge confirmation. That happens in `/ss-mission-status`.

### 8. Non-mission shipping (one-off ticket)

If step 3 determined this is a one-off:

```
LOC-NN shipped → PR opened. (one-off — not part of a mission)
```

End. No mission rollup, no parent comment. Don't refuse to ship — the operator can absolutely PR a standalone ticket via `/ss-ship`.

### 9. Final output (every path)

After the path-specific message above, always print:

```
PR:     <gh pr url>
Linear: <linear ticket url>
Status: awaiting merge — integration flips LOC-NN to Done on merge.
```

## Output discipline

- Always show the proposed commit message **before** committing. Never auto-commit without explicit `y`.
- Always print the resulting commit SHA after a successful commit.
- Always print the PR URL + Linear URL + "awaiting merge" line at the end of a successful run.
- Use the actual current date in any messaging, never placeholder dates.
- Never echo or include any API keys, tokens, or secrets in commit messages or output.

## Anti-patterns (never do)

- **Flipping the leaf ticket to Done from this command.** The ADR-004 integration owns leaf state. Any `save_issue(state:"Done")` here is the racing pattern this rewrite eliminates. If you find one in the file, delete it.
- **Flipping the mission parent to Done from this command.** Parent rollup is lazy — `/ss-mission-status`, `/ss-pull`, `/ss-status` handle it after the last sub-issue's PR actually merges, not before.
- **Pushing before commit succeeds.** Order is `commit` → verify success → `push`. Any failure stops the chain.
- **Bypassing pre-commit hooks** with `--no-verify` unless the operator asks.
- **Amending the previous commit** to recover from a failed pre-commit hook. The failed commit didn't land — amending would modify the wrong commit. Create a new commit.
- **Force-pushing** to recover from a non-fast-forward push. Investigate — the branch is likely out of sync with origin; force-push masks the real problem.
- **Refusing to ship one-off tickets.** This command handles both mission and standalone work.
- **Skipping `--repo` on `gh pr create`.** Cross-repo confusion is a real failure mode in multi-repo workflows.

## Landmines

1. Branch parsing assumes `loc-NN` lowercase. Be tolerant — match case-insensitively, normalize to `LOC-NN` for Linear.
2. `gh pr create --fill` uses the last commit's message as the PR title and body. Multi-commit branches will have a sparse body — that's fine for now; the operator can edit on GitHub.
3. The integration's branch → In Progress flip can take ~3s after `git push`. Don't poll Linear immediately after push expecting an updated state.
4. `--base main` is hardcoded. If the operator needs to PR against a feature branch, they should use raw `gh pr create` and skip this command.
5. If the PR ends up open but the operator decides not to land it, **don't** flip Linear back to Backlog manually — close the PR on GitHub and the integration will reflect it. Manual writes are still the failure mode.
