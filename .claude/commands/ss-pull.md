---
description: Claim the next sub-issue from this repo's active mission — flips it to In Progress in Linear and prints the git checkout line
disable-model-invocation: true
---

# /ss-pull — claim the next sub-issue

You are in the **plugin field session** (`silent-stone-obsidian`). HQ planned a mission as a Linear parent issue with reparented sub-issues. This command claims the next one for you to work on.

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

This command writes to Linear (one state transition). It is user-invoked only.

## Steps

### 1. Find the active mission parent for THIS repo

- `list_issues(team: "LOCAL-DAILY", project: "silent-stone-obsidian (plugin)", query: "Mission:", state: "In Progress")`
- Filter results to titles that start with `Mission:` (the `query` field is broad search, not prefix match).
- For each candidate, run `list_issues(parentId: <id>)` and check if **at least one sub-issue is not Done**. Keep the one(s) that have open work.

**If zero active missions:** stop. Print:
```
No active plugin mission. Run /ss-mission at HQ first.
```

**If multiple active missions:** stop. Print all of them with URLs and tell the user to close one before pulling — discipline check.

### 2. Pick the next sub-issue

- `list_issues(parentId: <mission-id>)` → all sub-issues with priority + state.
- Filter to state `Backlog` (skip In Progress and Done).
- Sort by priority (`Urgent` > `High` > `Medium` > `Low` > `None`), then by ticket ID ascending (older / lower-numbered first when priorities tie).
- Take the first.

**If zero `Backlog` sub-issues:**
- If any sub-issue is still `In Progress`, print: `Already in flight: LOC-NN. Finish or unblock that one before pulling another.`
- If all are `Done`, print: `Mission complete — close it with /ss-ship on the last sub-issue, or run /ss-mission-status.` Stop.

### 3. Flip the sub-issue to In Progress

```
save_issue(id: "LOC-NN", state: "In Progress")
```

Immediately verify:

```
get_issue("LOC-NN")
```

Confirm `state.name === "In Progress"`. If not, **stop and surface the discrepancy** — this is the documented Linear MCP silent-failure landmine. Don't print the branch line for a ticket that didn't actually transition.

### 4. Echo the mission briefing

Read the parent's description (`get_issue(<mission-id>)` → `description`). Print it back so the operator re-anchors on the batch's intent before opening files.

```markdown
**Mission:** <parent.title> — <parent.url>

<parent.description>
```

### 5. Print the branch line + ticket card

Use the ticket's `gitBranchName` field (Linear provides it — e.g. `josemoreno801/loc-12-implement-conflict-resolution-modal`).

```markdown
**Claimed:** LOC-NN — <title>
Priority: <priority>
Linear: <ticket.url>

Run this when you're ready:
```
```bash
git checkout -b <ticket.gitBranchName>
```
```

**Do not auto-execute the `git checkout`.** Print only. The operator runs it.

End. No closing fluff.

## Output discipline

- Never invent a `gitBranchName`. If Linear returns null for some reason, fall back to the format `josemoreno801/loc-NN-<slugified-title>` and call it out as a fallback so the operator can fix it on Linear's end.
- If `get_issue` returns a different `parent.id` than the active mission you found in step 1, **stop**. Something reparented the ticket out from under you mid-command.

## Anti-patterns (never do)

- **Auto-running `git checkout`.** Print only.
- **Pulling a sub-issue from a different repo's mission.** This command is plugin-scoped. The web equivalent lives in `silent-stone/.claude/commands/ss-pull.md`.
- **Pulling while another sub-issue is In Progress.** WIP-1 discipline at the mission level. Finish the current one (via `/ss-ship`) first.
- **Skipping the `get_issue` verify** after the state transition. Linear MCP writes can lie.

## What this command does NOT do

- Run `git checkout` for you.
- Open files. The operator drives implementation; this command just hands off.
- Touch any ticket not in the active mission. One-off tickets are handled directly via `/ss-ship` after the operator picks them manually.
