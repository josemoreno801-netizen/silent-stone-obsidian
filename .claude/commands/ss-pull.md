---
description: Claim the next sub-issue from this repo's active mission — sweep stale worktrees, roll up done missions lazily, then spawn a fresh worktree + tmux window with the ticket briefing
disable-model-invocation: true
---

# /ss-pull — claim next sub-issue into a worktree session

You are in the **plugin field session** (`silent-stone-obsidian`). HQ planned a mission as a Linear parent issue with reparented sub-issues. This command:

1. Sweeps any stale `.claude/worktrees/loc-*` from previously-shipped tickets.
2. Lazily rolls up any mission parent whose sub-issues are all Done.
3. Enforces WIP-1 by checking active worktrees, not Linear state.
4. Claims the next `Backlog` sub-issue.
5. Spawns a fresh git worktree + tmux window for it, briefed via `WORKTREE_PROMPT.md`.

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

This command **does not write to Linear for the leaf ticket.** The ADR-004 Linear↔GitHub integration (Approach B) flips the leaf Backlog → In Progress when the worktree's PR is opened by `/ss-ship`. The only Linear write this command can make is the lazy mission-parent close in step 2 (if applicable).

## Steps

### 1. Stale-worktree sweep

```bash
git worktree list --porcelain
```

For every worktree at `<repo-root>/.claude/worktrees/loc-NN-<slug>`:

- Parse `loc-NN` → `LOC-NN`.
- `get_issue("LOC-NN")` → check `state.type`.
- `git branch --merged main` → check if `josemoreno801/loc-NN-<slug>` is in the list.

If BOTH `state.type === "completed"` AND the branch is merged into main, sweep:

```bash
git worktree remove --force ".claude/worktrees/loc-NN-<slug>"
git branch -D josemoreno801/loc-NN-<slug>
```

If only ONE is true (Linear Done but branch unmerged, or branch merged but Linear still In Progress), **do not sweep**. Print a one-line warning:

```
Stale-but-inconsistent worktree: <path>. Linear=<state>, branch merged=<bool>. Leaving in place.
```

This is a soldier check — when the two systems disagree, surface it instead of silently picking one.

### 2. Lazy mission-parent rollup

```
list_issues(team: "LOCAL-DAILY", project: "silent-stone-obsidian (plugin)", query: "Mission:", state: "In Progress")
```

Filter to titles starting with `Mission:`. For each parent:

- `list_issues(parentId: <parent.id>)` → all sub-issues + states.
- If EVERY sub-issue has `state.type === "completed"` AND the parent itself is `state.type !== "completed"`:
  - `save_issue(id: <parent.id>, state: "Done")`
  - Immediately verify: `get_issue(<parent.id>)` — confirm `state.type === "completed"`.
  - If verify fails, **surface the discrepancy loudly**. Linear MCP silent-failure landmine.
  - Print: `Mission rolled up: <parent.title> — <parent.url>`

This is the ONLY Linear write this command makes. It is intentional — the integration doesn't auto-close parents, so we do it lazily here.

### 3. WIP-1 enforcement via worktrees

After the sweep (step 1), count remaining `.claude/worktrees/loc-*` directories. If ≥ 1 active worktree exists, **stop**:

```
WIP-1 breach — active worktree at <path>. Finish or sweep it before pulling another.
Run /ss-ship in that worktree, or sweep manually if you abandoned the work.
```

The discipline is enforced at the file-system level, not Linear. A leaf ticket can be Backlog (per integration timing) but its worktree still represents active work.

### 4. Find the active mission parent

```
list_issues(team: "LOCAL-DAILY", project: "silent-stone-obsidian (plugin)", query: "Mission:", state: "In Progress")
```

Filter to titles starting with `Mission:` (broad search, not prefix match). For each candidate, run `list_issues(parentId: <id>)` and keep only those with **at least one sub-issue not Done**.

- **Zero active missions:** stop. Print `No active plugin mission. Run /ss-mission at HQ first.`
- **Multiple active missions:** stop. Print all candidates with URLs. Tell the operator to close one before pulling — discipline check.

### 5. Pick the next sub-issue

- `list_issues(parentId: <mission-id>)` → all sub-issues with priority + state.
- Filter to `state.type === "unstarted"` (Backlog). Skip In Progress and Done.
- Sort by priority (`Urgent` > `High` > `Medium` > `Low` > `None`), then ticket ID ascending.
- Take the first.

**If zero Backlog sub-issues:**
- If any sub-issue is still `In Progress` (in flight via integration), print `Already in flight: LOC-NN. Wait for its PR to merge, then pull again.` Stop.
- If all are Done, print `Mission complete — run /ss-mission-status to roll it up.` Stop.

### 6. Echo the mission briefing

Read the parent's description (`get_issue(<mission-id>)` → `description`). Print it back so the operator re-anchors on the batch's intent before opening files.

```markdown
**Mission:** <parent.title> — <parent.url>

<parent.description>
```

### 7. `$TMUX` guard

```bash
[ -z "$TMUX" ]
```

If the env var is unset → stop. Print:

```
/ss-pull requires you to be running inside a tmux session.
Spawn one with `tmux new -s plugin-dd` and re-run.
```

No fallback. Option A safety — hard-fail per ADR-004 implementation plan.

### 8. Create the worktree

Use the ticket's `gitBranchName` from Linear (e.g. `josemoreno801/loc-12-implement-conflict-resolution-modal`). If Linear returns null, fall back to `josemoreno801/loc-NN-<slugified-title>` and print a warning.

```bash
git worktree add ".claude/worktrees/loc-NN-<slug>" -b "<ticket.gitBranchName>" origin/main
```

Run from the repo root. The path is relative; the branch is created off origin/main (not local main — origin is the source of truth).

If `git worktree add` fails (path already exists, branch already exists), **stop**. Don't force. The stale-worktree sweep in step 1 should have prevented this — if it didn't, something is wrong; investigate manually.

### 9. Write `WORKTREE_PROMPT.md` to the worktree root

Compute the absolute worktree path: `<repo-root>/.claude/worktrees/loc-NN-<slug>`.

Write a file at `<worktree-path>/WORKTREE_PROMPT.md` with this content (substitute the real ticket data):

```markdown
# Worktree session — LOC-NN

You are in the plugin worktree for `LOC-NN — <ticket.title>`.

**Linear:** <ticket.url>
**Parent mission:** <parent.title> — <parent.url>
**Branch:** <ticket.gitBranchName>

## Ticket body

<ticket.description>

## Your move

1. Read the ticket body above. Re-anchor on intent.
2. Implement the change. Run tests as you go: `npm test`, `npm run typecheck`, `npm run lint`.
3. When done, run `/ss-ship` to commit + push + open PR. The Linear↔GitHub integration flips LOC-NN to Done when the PR merges. Do NOT manually flip Linear from this session.

Soldier-mode is on. The play is in front of you. Move.
```

The CLAUDE.md auto-load convention (see project root) tells the spawned claude session to read this file on session start, execute its contents as the initial prompt, then delete it.

### 10. Spawn the tmux window

```bash
tmux new-window -n "loc-NN" -c "<absolute-worktree-path>" "claude --debug"
```

- `-n` names the window (e.g. `loc-12`) so the operator can swap to it with `Ctrl-b N` or `Ctrl-b ,`.
- `-c` sets the window's working directory to the worktree's absolute path. **Absolute, not relative** — `tmux new-window -c` breaks on relative.
- The trailing command is `claude --debug` — debug mode hardcoded per ADR-004 implementation plan.

If `tmux new-window` fails (no `$TMUX`, but you should have caught that in step 7), print the error and stop. The worktree and `WORKTREE_PROMPT.md` are already created — the operator can `cd` and `claude --debug` manually as a fallback.

### 11. Final output

```
Claimed: LOC-NN — <ticket.title>
Priority: <ticket.priority>
Linear:   <ticket.url>
Worktree: <absolute-worktree-path>
Branch:   <ticket.gitBranchName>

Spawned tmux window "loc-NN". Swap with Ctrl-b N or Ctrl-b ,.
Linear stays Backlog until the PR opens — the integration flips it then.
```

End.

## Output discipline

- Never invent a `gitBranchName`. If Linear returns null, fall back and call it out as a warning.
- If `get_issue` returns a different `parent.id` than the active mission you found in step 4, stop — something reparented mid-command.
- Always print the absolute worktree path so the operator can `cd` to it manually if needed.

## Anti-patterns (never do)

- **Writing the leaf ticket to In Progress here.** The integration handles that on PR open. Manual writes from this command bring back the race condition we eliminated.
- **Skipping the stale-worktree sweep.** If you leave dead worktrees in place, WIP-1 stops working.
- **Skipping the lazy mission-parent rollup.** The integration doesn't close parents; if `/ss-pull` doesn't roll them up, nothing will.
- **Pulling without an active tmux session.** Hard-fail. Print the spawn instruction and stop.
- **Force-flipping the WIP-1 check.** If a worktree is in flight, finish it (`/ss-ship` inside the worktree) or sweep it manually. Don't override.
- **Auto-`cd`-ing the operator's main session into the worktree.** Spawn the tmux window instead. The operator's main session stays where it is.

## Landmines

1. `list_issues` `state` parameter expects the state NAME (e.g. `"In Progress"`), not `state.type`. Don't pass `"started"`.
2. `git worktree add` with `-b` creates the branch from the `<commit-ish>` argument (here, `origin/main`). If you accidentally pass `main` (local), you may branch off a stale or divergent commit. Use `origin/main` explicitly.
3. `tmux new-window` runs the command in the operator's shell context (zsh/bash), so the working directory `-c` must be a real path the shell can `cd` into. Absolute path only.
4. The `WORKTREE_PROMPT.md` file is auto-deleted by the spawned session per CLAUDE.md convention. Don't write it expecting it to persist — it's transient.
5. If the operator runs `/ss-pull` from inside an existing worktree session (not the main session), step 7's `$TMUX` guard will pass but the spawn will create a window in whatever tmux session they're in, not the main session. That's usually fine, but worth knowing.
