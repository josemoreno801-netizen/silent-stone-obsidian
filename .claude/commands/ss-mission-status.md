---
description: Show where this repo's active mission stands — runs a lazy mission-parent rollup first, then prints the sub-issue checklist with [x]/[~]/[ ] markers and a one-line verdict
---

# /ss-mission-status — where the field session stands

You are in the **plugin field session** (`silent-stone-obsidian`). This command prints a checklist of the active mission's sub-issues so the operator knows what's done, what's in flight, and what's left. Before rendering, it runs a **lazy mission-parent rollup pass**: if any in-flight mission has all sub-issues Done but the parent isn't yet, this command flips the parent Done — covering the gap that the ADR-004 integration doesn't (the integration auto-closes leaf tickets, not parents).

**One bounded Linear write only** — the rollup. Everything else is read-only. No git mutations. Usable by the model on its own initiative (no `disable-model-invocation` flag) because the rollup write is gated on "all children Done" — it never closes a parent that has open work.

**Scope:** plugin project only — `silent-stone-obsidian (plugin)` / project id `90f7de75-e92b-4287-84f0-0d5b703d9730` / team `LOCAL-DAILY` / key `LOC`.

## Steps

### 0. Lazy mission-parent rollup pass

Before rendering anything, check whether any in-flight mission needs to be closed:

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

If no parent needs rollup, this step is silent — no output. Continue to step 1.

This is the ONLY Linear write this command makes. It is bounded — fires only when the integration has already flipped every child Done.

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

- **All sub-issues Done** → `All sub-issues Done but parent still In Progress. Step 0's rollup didn't fire — Linear write may have failed. Investigate or manually flip the parent.`  
  *(In normal flow this branch is unreachable: step 0 would have closed the parent, and step 1's filter would exclude already-closed missions. Reaching here implies an MCP write failure earlier in the same run.)*
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

- **Writing to Linear outside the bounded rollup in step 0.** The rollup fires only when EVERY sub-issue is already Done. Don't expand the write surface — no flipping leaf tickets here (that's the integration's job via `/ss-ship`), no flipping In Progress missions, nothing else.
- **Crossing repos.** Plugin field session shows the plugin mission only. Web mission status lives in `silent-stone/.claude/commands/ss-mission-status.md`.
- **Padding verdicts.** Pick one condition and print it. Don't append "consider also…" — the verdict carries the read.
- **Skipping step 0.** The lazy rollup is the whole reason this command coexists with `/ss-pull`'s rollup — multiple entry points ensure the parent eventually closes. Don't optimize the rollup away if "the operator usually does it via /ss-pull anyway."
