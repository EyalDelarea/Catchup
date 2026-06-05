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

## Local-first principle

catchup is designed so a user with no cloud account and no internet connection (beyond the initial `npm install` and model pull) can run the full pipeline. Contributions that require external services will not be merged.
