---
name: preflight
description: Run Catchup's full local CI gate (biome → typecheck → build → test) and get the branch review-ready before opening or updating a PR. Use before committing/pushing, before opening a PR, or whenever the user says "preflight", "get it ready", "ship it", "make it green", or "prep the PR".
---

# Preflight — prepare a green, review-ready PR

Mirror the CI `ci-ok` gate locally so the human reviewer (step 6 of the ship
lifecycle) receives a branch that already passes, and only has to run and verify
behavior. Do the agent's part of the flow: get to green, then hand off.

## Run the gate in order

Run each step; **stop at the first hard failure**, fix it, then resume from the top.

1. **Lint/format** — `npm run check`
   - On failure, autofix: `npm run check -- --write` (or `npm run format`), then re-run.
   - Unused imports and unformatted code are the most common offenders — clear them here,
     not in a later "fix unused import" commit.
2. **Typecheck** — `npm run typecheck`
3. **Build** — `npm run build`
4. **Test** — `npm test`
   - Vitest uses Testcontainers (Postgres + RabbitMQ), so **Docker must be running**.
     If Docker is unavailable in this environment, say so explicitly, run the other three
     steps, and flag tests as *not run* — do not claim a clean pass you didn't observe.

## Sync with main

If the branch is behind `origin/main`, merge it in before declaring green:
`git fetch origin && git merge origin/main`. Resolve conflicts, and if two branches
added migrations with the same number, **renumber** yours to the next free number and
re-run the gate.

## Commit & hand off

- Stage and commit any fixes as **atomic, scoped conventional commits** (`type(scope):`),
  using the established scope vocabulary in `CLAUDE.md`. Don't fold unrelated fixes together.
- Push to the working branch with `git push -u origin <branch>`.
- Report the gate result plainly: which steps passed, which were skipped (e.g. tests with
  no Docker), and what you changed. **Do not open or merge a PR unless the user asks.**

## Report format

End with a short checklist so the reviewer sees live state, e.g.:

```
✅ biome check    ✅ typecheck    ✅ build    ✅ test (12 files)    ✅ synced with main
```

Use ⚠️ / ❌ for skipped or failing steps and name the reason.
