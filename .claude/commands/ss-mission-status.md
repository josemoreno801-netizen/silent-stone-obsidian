---
description: Show where this repo's active mission stands — sub-issue checklist with [x]/[~]/[ ] markers and a one-line verdict
---

# /ss-mission-status — where the field session stands

You are in the **plugin field session** (`silent-stone-obsidian`). This command prints a read-only checklist of the active mission's sub-issues so the operator knows what's done, what's in flight, and what's left.

**Read-only. No Linear writes. No git mutations.** Low-risk; usable by the model on its own initiative too (no `disable-model-invocation` flag).

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

## Steps

### 1. Find the active mission parent for THIS repo

- `list_issues(team: "LOCAL-DAILY", project: "silent-stone-obsidian (plugin)", query: "Mission:", state: "In Progress")`
- Filter results to titles that start with `Mission:` (the `query` field is broad search, not prefix match).
- For each, check via `list_issues(parentId: <id>)` that at least one sub-issue isn't Done.

**If zero active missions:**
```
No active plugin mission. Run /ss-mission at HQ to plan one.
```
Stop.

**If multiple:** print all of them (title + URL + sub-issue count). Don't pick one for the operator.

### 2. Render the checklist

For the active mission:

```markdown
**Mission:** <parent.title> — <parent.url>

- [x] LOC-NN — <title>  (Done)
- [~] LOC-NN — <title>  (In Progress)
- [ ] LOC-NN — <title>  (Backlog)

<X of N shipped>
```

Use the markers exactly:
- `[x]` for `state.type === "completed"` (Done)
- `[~]` for `state.type === "started"` (In Progress)
- `[ ]` for anything else (Backlog or Cancelled — though cancelled inside a mission would be unusual)

Sort sub-issues by priority (Urgent first), then by ticket ID ascending when priorities tie.

### 3. Verdict (one line at the bottom)

Pick the first matching condition:

- **All sub-issues Done** → `Mission ready to close. /ss-ship the last one already.`  
  *(If you see this state, something's odd — `/ss-ship` should have auto-closed the parent when the last sub-issue shipped. Surface it.)*
- **One sub-issue In Progress, the rest Done** → `<N-1> of <N> shipped. Finish LOC-NN to close the mission.`
- **One sub-issue In Progress, others Backlog** → `LOC-NN in flight. /ss-ship when ready, then /ss-pull next.`
- **All Backlog, none In Progress** → `Nothing claimed yet. /ss-pull to start.`
- **Mixed (multiple in progress)** → `WIP-N (<list of in-progress LOC-NNs>). WIP-1 discipline says finish one before the next.`

End. No closing fluff.

## Output discipline

- Use the actual current date if you need to reference time (e.g. mission age), never placeholders.
- The checklist is markdown so it renders cleanly in any terminal that pretty-prints. No tables, no emoji.
- Don't echo the parent issue's description (the mission briefing) — that's `/ss-pull`'s job. `/ss-mission-status` is a glance, not a re-brief.

## Anti-patterns (never do)

- **Writing to Linear.** This command is read-only. If the operator wants to act on what they see, they invoke `/ss-pull` or `/ss-ship`.
- **Crossing repos.** Plugin field session shows the plugin mission only. Web mission status lives in `silent-stone/.claude/commands/ss-mission-status.md`.
- **Padding verdicts.** Pick one condition and print it. Don't append "consider also…" — the verdict carries the read.
