# Grafana — provisioned observability

Grafana here is **fully provisioned from this folder** — no manual UI clicking, no
saved-to-database state. Everything (datasources + dashboards) is declared as files and
loaded on startup. Edit the files, not the running UI. This doc tells people and agents how it
fits together and how to add a dashboard.

## How it loads (the chain)

1. **`docker-compose.yml`** mounts this folder read-only into the container:
   `./ops/grafana/provisioning → /etc/grafana/provisioning:ro`. Grafana runs at
   **http://localhost:3000** (anonymous admin, no login — see the env in the compose service).
2. **`provisioning/datasources/*.yml`** declare the datasources. The Loki datasource has
   **`uid: loki`** and Postgres has its own uid. Dashboards reference datasources *by uid*, so
   the uid in a panel's `datasource` must match these exactly or the panel shows
   "datasource not found".
3. **`provisioning/dashboards/dashboards.yml`** is a single *file provider* named `catchup`
   that watches `/etc/grafana/provisioning/dashboards` and reloads every
   `updateIntervalSeconds: 10`. **Any `*.json` in that folder is auto-loaded** — adding a
   dashboard means adding a file, nothing else.

So: drop a valid dashboard JSON in `provisioning/dashboards/`, and on the next `make dev` /
`make up` it appears in Grafana within ~10s. No import step, no registration.

## Adding or editing a dashboard

- Put the JSON in `provisioning/dashboards/<name>.json`. Give it a **unique `uid`**
  (kebab-case, e.g. `catchup-ask`) and a clear `title`.
- **Copy an existing dashboard as your template** (`pipeline-logs.json`, `jobs-status.json`,
  `ask.json`) so you match the current `schemaVersion`, datasource refs, and templating style.
  Mismatched schemaVersion or datasource uid is the usual reason a panel renders blank.
- Reference Loki panels against `{service_name="catchup", ...}` and datasource `uid: "loki"`.
- **Validate before committing:** `python3 -c "import json;json.load(open('ops/grafana/provisioning/dashboards/<name>.json'))"`
  for JSON validity, and (if the stack is up) hit the Loki API to confirm each LogQL query
  parses — a query with a parse error fails silently as an empty panel.
- **Caveat — the running Grafana mounts from the *repo working tree*, not your branch/worktree.**
  A dashboard added on a feature branch only shows up once it's merged to the checkout Grafana
  is mounted from (or you copy the file there manually). This is expected; don't "fix" it.

## Where the data comes from

App logs are shipped by **pino → Loki** (`src/logging/logger.ts`). `component` and `level` are
promoted to Loki **stream labels** (low cardinality), so dashboards filter with
`{service_name="catchup", component="<area>"}`. High-cardinality fields (ids, durations) stay in
the JSON body — parse them in LogQL with `| json` and `unwrap`. To make a new field filterable
as a label, add it to `propsToLabels` in the logger (only for low-cardinality values).

## Dashboards in this folder

| File | uid | What it shows | Log source |
|---|---|---|---|
| `pipeline-logs.json` | `catchup-pipeline` | Raw log explorer across components | all `{service_name="catchup"}` |
| `jobs-status.json` | — | Per-job-type throughput, latency, failures, queue depth | job logs |
| `ops-history.json` | — | Operational history snapshots | ops logs |
| `ask.json` | `catchup-ask` | Ask / AMA: volume (scoped vs all-chats), zero-result rate, TTFB & total latency, retriever effectiveness, errors/aborts, live ask logs | `component="ask"` |

### Ask / AMA log fields (emitted by `handleAsk` in `src/web/server.ts`)

The `ask.json` dashboard reads these — keep them in sync if you change the logging:

- `evt: "ask_start"` — on request arrival: `chat`, `scoped` (bool). Lets a *hung* ask still show up.
- `evt: "ask"` — on completion: `chat`, `scoped`, `candidateCount` (messages fed to synthesis),
  `ttfbMs` (time-to-first-token, may be `null`), `totalMs`, `aborted` (bool).
- `evt: "ask_error"` — on exception: `message`.

`candidateCount = 0` is the "feature feels broken" signal; a high `ttfbMs`/`totalMs` is the
"feels stuck" signal — both have dedicated panels.
