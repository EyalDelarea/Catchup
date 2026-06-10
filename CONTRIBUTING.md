# Contributing

catchup is a local-first project — all processing (collection, transcription, captioning, summarization) runs on your own machine. No cloud services are used, and no data should ever leave the device. Please keep that principle intact in any contribution.

## Getting started

1. Fork the repository and create a feature branch.
2. Follow the [Quick Start](README.md#quick-start) to get the stack running locally.
3. Make your changes.

## Before opening a PR

```bash
npm run typecheck     # must pass — zero TypeScript errors
npm test              # must pass — Docker must be running (Testcontainers)
```

Both checks are required. Docker must be running for the test suite because tests spin up ephemeral Postgres and RabbitMQ containers via Testcontainers.

## Pull request guidelines

- Keep PRs focused on a single concern.
- Add or update tests for any changed behavior.
- Do not introduce dependencies on external APIs, cloud services, or any network calls from production code paths. Everything must work fully offline.
- Update the relevant section of `README.md` if you add or change CLI commands, configuration keys, or ports.

## Database migrations

Migrations live in `src/db/migrations/`, named `<number>_<description>.ts`, and run
in ascending numeric order by `node-pg-migrate`. Their numbers must be **unique** —
two files with the same number break deploys (the later one sorts before an applied
migration and `checkOrder` aborts).

**Always create migrations with `npm run migrate:create -- <name>`.** It prefixes the
filename with a millisecond timestamp, so parallel branches/agents can't pick the same
number — collisions are prevented by construction. Never hand-number a file.

As a backstop, `src/db/migrations.test.ts` fails CI on any duplicate number, on the
PR's merged state — so even a hand-numbered collision is caught before it reaches
`main` (renumber and push if it goes red).

## Local-first principle

catchup is designed so a user with no cloud account and no internet connection (beyond the initial `npm install` and model pull) can run the full pipeline. Contributions that require external services will not be merged.
