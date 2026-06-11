# Catchup — Project Overview (for agent collaboration / brainstorming)

> **Purpose of this document:** a single, self-contained briefing on what Catchup
> *is*, what it *does*, and what already exists (functionality + tooling), so another
> agent can use it as a grounding source for product ideation. Written 2026-06-07.

---

## 1. One-line summary

**Catchup** is a **local-first personal WhatsApp summarizer.** You wake up
to 200 unread messages; Catchup reads them for you — overnight, on your own machine — so
you open your phone to *the gist*, not the scroll. **Nothing leaves your machine** except
the read-only WhatsApp link itself. No cloud API keys, no hosted service, no data sharing.

It runs **single-user by default** (no login — the original product). An **optional
multi-tenant mode** (`MULTI_TENANT=true`) turns one self-hosted instance into an
operator-run platform serving several isolated accounts, each behind its own login, with
all inference still 100% local. See §7 (shipped features) and the README's "Multi-tenant"
section. Multi-tenant is fully shipped; single-user remains the zero-config default.

---

## 2. Core value proposition

- **The product is the summary.** Everything else (collection, transcription, vision,
  queueing, observability) is plumbing in service of producing a high-quality, structured
  "what I missed" summary of a WhatsApp group.
- **Privacy is a hard constraint, not a feature.** All inference (LLM summarization,
  speech-to-text, image/video captioning) runs locally via Ollama + faster-whisper.
  Message content never leaves the device.
- **Hebrew is first-class.** Transcription, OCR, and summaries all target Hebrew (RTL UI,
  Hebrew Whisper model, Hebrew-capable vision/LLM). The system must not assume English.
- **Mobile-first consumption.** The output is a mobile web app ("Glacier" redesign),
  RTL, designed to be opened on your phone over LAN.

---

## 3. How it works (end-to-end pipeline)

```
WhatsApp ──(Baileys, read-only live link)──┐
                                           ├─► normalize + dedupe ─► PostgreSQL (source of truth)
WhatsApp export (.txt/.zip) ──(importer)───┘                              │
                                                                          ├─► faster-whisper (voice notes → Hebrew transcripts)
                                                                          ├─► Ollama vision (images/video → Hebrew captions + OCR)
                                                                          │
                                                            transcripts + captions + text
                                                                          │
                                                                          ▼
                                                          Ollama LLM (structured Hebrew summary)
                                                                          │
                                                          ┌───────────────┼───────────────┐
                                                          ▼               ▼               ▼
                                                     Web UI (mobile)   CLI output   scheduled digest
```

- **Postgres is the sole source of truth.** The message broker (RabbitMQ) carries only job
  *references* (IDs), never message content.
- **Two ingestion paths, one schema.** The export importer and the live Baileys collector
  both normalize into the *same* `messages` table. Dedup is an explicit documented contract
  (exports lack stable IDs).
- **Single-threaded worker by default** (`WORKER_CONCURRENCY=1`): summaries and vision share
  one Ollama model residency and run serially.

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 22, TypeScript, ES modules |
| Storage | PostgreSQL (sole persistent store); media/exports on disk under `data/` |
| Live collection | [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp lib), hardened read-only |
| LLM (summaries) | **Local Ollama**, default `gemma4:26b`, ~32k context |
| Vision (images/video) | Local Ollama vision, default `gemma4:26b` (multi-frame video) |
| Speech-to-text | Python `faster-whisper`, model `ivrit-ai/whisper-large-v3-turbo-ct2` (Hebrew) |
| Job queue | RabbitMQ (competing consumers, retries, dead-letter) |
| Observability | Loki (logs) + Grafana (dashboards) |
| Web front-end | Vanilla JS/HTML/CSS (no framework), mobile-first, RTL, SSE streaming |
| Media tooling | ffmpeg (audio normalization + video frame extraction) |
| Infra | Docker Compose (Postgres, RabbitMQ, Loki, Grafana); the app runs on the host for CPU/GPU access |
| Tests | Vitest + Testcontainers (ephemeral Postgres & RabbitMQ); ~423+ automated tests |
| Lint/format | Biome |

---

## 5. CLI surface (`npx tsx src/cli.ts <command>`)

| Command | What it does |
|---|---|
| `serve [--port N] [--collect]` | Start the mobile web UI (default :8787). `--collect` also runs the live collector; the digest scheduler also starts here. |
| `collect` | Standalone live collector (QR link on first run), stores incoming group messages. |
| `summarize <name> [--last N] [--since DATE] [--out file]` | Generate a structured Hebrew summary of a chat from the CLI. |
| `ask <question> [--chat name]` | Hybrid (lexical + semantic) RAG question-answering over stored messages, with `[n]` citations. |
| `groups` | List all stored groups/chats with source + message counts. |
| `transcribe [--group name]` | Run faster-whisper on pending (untranscribed) voice notes. |
| `analyze-backlog [--limit N] [--types ...]` | Enqueue vision analysis (`analyze.image`/`analyze.video`) for media lacking a completed analysis. |
| `digest-run [--all]` | Manually trigger the scheduled digest (enqueues `summarize.group` jobs). |
| `ops-sweep` | Ops maintenance: self-heal dead jobs, record status history (feature 012). |
| `import <file> [--name N] [--folder dir]` | Import a WhatsApp export (`.txt`/`.zip`); dedupes; `--folder` for bulk. |
| `media-backfill [--limit N]` | Download + analyze media descriptors stored at ingest but not yet fetched. |
| `embed-backfill [--limit N] [--batch N] [--chat name]` | Embed stored messages for semantic `ask` retrieval (recent-first, resumable). |
| `full-sync` | Pull deep WhatsApp history on a freshly-linked session (onboarding push sync). |
| `merge-duplicate-chats` | Merge duplicate group rows (e.g. LID/PN identity splits) into one. |
| `doctor` | Verify prerequisites (Docker, compose, Postgres+migrations, RabbitMQ, Ollama+model, faster-whisper, ffmpeg) plus an advisory default-DB-password check. |

`make dev` is the everyday entry point: brings up the Docker stack, applies migrations, and
starts the worker + web server + live collector together.

---

## 6. Key subsystems (where things live in `src/`)

| Dir | Responsibility |
|---|---|
| `collector/` | Baileys live collector, message mapping, name resolution, **outbound-guard** (hardened so it can never send), backfill, session. |
| `importer/` | WhatsApp `.txt`/`.zip` parsing, normalization, dedupe, bulk import, media extraction. |
| `db/` | Postgres client, migrations, repositories (tenants, users, sessions, email-tokens, audit-log, groups, messages, summaries, transcripts, media-analyses, job-runs, watermarks, scheduler-state, status-snapshots, service-status). **Tenancy:** a `tenants` table + mandatory `tenant_id` on every tenant-scoped table, isolated by Postgres RLS (policy keys off the `app.tenant_id` GUC) plus an app-layer `withTenant()`. In single-user mode the app connects as the DB owner and all data runs as the fixed default tenant (RLS dormant by design). In `MULTI_TENANT=true` mode the cutover is **live**: the app connects as the restricted `catchup_app` role and every request/job/ingest is scoped via `withTenant()`, so isolation is enforced. Two pools: `catchup_app` (NOBYPASSRLS, runtime) + `catchup_operator` (BYPASSRLS, pre-tenant lookups + operator dashboard). |
| `auth/` | Multi-tenant auth brain (`service.ts`): argon2id password hashing, opaque session/email tokens (SHA-256 at rest), cookie helpers, register/login/verify/reset/logout. Cross-tenant pre-tenant reads (login lookup, session resolution) quarantined to the operator pool; everything else runs in `withTenant()`. No-op unless `MULTI_TENANT=true`. |
| `jobs/` | Job bus abstraction — in-memory bus (tests) + RabbitMQ bus (prod), job types, run recorder. |
| `workers/` | Worker process + handlers: `import-file`, `transcribe-voicenote`, `analyze-media`, `summarize-group`, `summarize-total`. |
| `transcription/` | Python `faster-whisper` worker (`worker.py`), Node wrapper, ivrit-whisper integration. |
| `vision/` | Ollama image/video analyzer, media-kind detection, multi-frame video analysis. |
| `summarization/` | Selection, catch-up prep, prompt assembly, Ollama summarizer, rendering. |
| `scheduler/` | Twice-daily digest scheduler (pre-summaries), enqueue-run, runner, schedule logic. |
| `service/` | Always-on service: heartbeat, liveness, status. |
| `ops/` | Operational tooling: `sweep` (self-heal dead jobs), `redrive` (re-queue failures). |
| `media/` | Prune-after-caption (delete media files after analysis unless `RETAIN_MEDIA=true`). |
| `doctor/` | Prerequisite checks. |
| `web/` | HTTP server, SSE (streaming summaries), static mobile UI under `public/` (vanilla JS libs: api, health, markdown, open-state, progress, time). |
| `logging/` | pino logger + Loki shipping. |

---

## 7. Shipped features (all merged to `main`)

| # | Feature | Delivers |
|---|---------|----------|
| 001 | MVP core pipeline | import → store → transcribe → summarize (CLI) |
| 002 | Summarize web UI | local streaming summary page |
| 003 | Always-on pipeline | RabbitMQ job queue + workers, bulk import, auto-transcribe, Loki/Grafana |
| 004 | On-demand catch-up | per-group read **watermark**, "what I missed", instant cache |
| 005 | Always-current summaries | on-demand bounded backfill, collector-down resilience, display names |
| 006 | Mobile "Glacier" web app | mobile-first RTL redesign, read-only history endpoint, 3D loader |
| 007 | Media understanding | local image/video analysis + Hebrew OCR into summaries, prune-after-caption, analyze-backlog, per-op Grafana monitor |
| 008 | Structured summaries | structured output (topics/decisions/open questions/action items/per-person), Reader loader, livelier streaming |
| 010 | Gemma-4 multi-frame video | multi-frame video understanding via gemma4 |
| 011 | Scheduled pre-summaries | twice-daily proactive summaries + instant-open + abort-on-disconnect + Grafana Jobs Status dashboard |
| 012 | Ops sweep | self-healing dead jobs + observable status history |
| Ask | RAG querying ("AMA") | hybrid lexical + semantic (bge-m3) retrieval, gemma `[n]` citations, SSE answers — constitution amended to permit it |
| 019 + T1–T6 | **Multi-tenant platform (opt-in)** | tenancy substrate (RLS) · auth + open registration (argon2, verify/reset) · per-tenant WhatsApp orchestration + fair-share scheduling · web QR onboarding · operator cross-tenant dashboard · append-only audit log. **Off unless `MULTI_TENANT=true`; single-user stays the default.** |

Spec-kit artifacts for each live under `specs/<NNN-feature>/` (`spec.md`, `plan.md`, `tasks.md`).

**Inference benchmark harness (`bench/`):** measures real production request paths for vision +
summarization, median-of-runs, with a results report. Notable finding: on M3 Pro hardware,
`gemma4:26b` behaves like an MoE (~5B active params, ~34 tok/s) and the research-recommended swap
to a smaller 7B vision model was *slower and lower quality* — the harness prevented a regression.

---

## 8. Observability & ops

- **Grafana** (http://localhost:3000, anonymous admin): dashboards for pipeline logs,
  ops history, and **Jobs Status (live)** — per-job-type throughput, latency, failure
  rates, queue depths.
- **RabbitMQ management** (http://localhost:15672, guest/guest).
- **App status API** (http://localhost:8787/api/status).
- **Self-healing**: `ops-sweep` redrives/reaps dead jobs; status snapshots give an
  observable history.

---

## 9. Privacy & safety posture

- **100% local inference.** The only network touch is the read-only WhatsApp link — true in
  single-user *and* multi-tenant mode (an operator instance still sends nothing to any cloud).
- **Outbound hardening.** `sendMessage`/`relayMessage` throw; presence, read receipts,
  typing indicators are silenced to no-ops. Cannot be accidentally bypassed. Sending
  requires explicit `WHATSAPP_ALLOW_SEND=true`.
- **Tenant isolation (multi-tenant mode).** When `MULTI_TENANT=true`, one tenant can never
  read or modify another's data — enforced in two independent layers (Postgres RLS via the
  restricted `catchup_app` role + app-layer `withTenant()`). Cross-tenant reads are
  quarantined to a separate operator pool; operator access is itself audited. The operator
  can hard-delete any tenant's data, and the append-only audit trail survives the purge.
- **Media pruning.** Media files are deleted after captioning by default (`RETAIN_MEDIA=false`).
- **Unofficial library disclaimer.** Baileys is reverse-engineered; not affiliated with
  WhatsApp/Meta; personal use only, at your own risk.

---

## 10. Governance / constitution (constraints any new idea must respect)

The project is governed by a versioned **Constitution** (`.specify/memory/constitution.md` —
gitignored; check the file for the exact current version). It was amended (MAJOR bump to
**v2.0.0**) to permit **operator self-hosting with hard tenant isolation**, and separately to
permit **RAG-based querying** (the Ask/AMA feature). Core principles:

1. **Local-First & Private by Default** — all inference runs on the operator's own hardware;
   no third-party cloud, content never leaves the box. The original prohibition on
   hosting/multi-user/auth was **lifted in v2.0.0, scoped narrowly** to single-operator
   self-hosting where tenant isolation is a hard, two-layer guarantee. Single-user local mode
   remains the zero-config default.
2. **Postgres Is the Source of Truth** — persist on ingestion; never query WhatsApp on
   demand for history (one bounded exception: anchor-based, count-capped, time-boxed,
   best-effort backfill that *populates* Postgres before any read).
3. **One Normalized Schema, Many Sources** — import and live paths normalize into one
   schema; dedupe is an explicit contract.
4. **Test-First (NON-NEGOTIABLE)** — deterministic logic developed test-first; typecheck +
   tests must pass before any merge.
5. **CLI-First, Smallest Useful System (YAGNI)** — build the smallest useful slice first.

Workflow: all non-trivial work flows through **spec-kit**
(`/speckit-constitution → specify → clarify → plan → tasks → implement`).

**Now PERMITTED (via amendments):** single-operator self-hosting + multi-tenancy + auth
(scoped to hard two-layer tenant isolation, no third-party cloud); RAG-based querying
(Ask/AMA). **Still explicitly DEFERRED (forbidden without amending the constitution):**
managed/cloud/SaaS services, extra brokers (Redis/Kafka), Telegram, WhatsApp bot commands,
**posting summaries back to groups**, and broad unread-message tracking (badges/counts,
read-state sync). The narrow catch-up watermark is the *only* permitted read-state.

> **For ideation:** any product idea that touches the deferred list collides with the
> constitution and would need a formal amendment + rationale + version bump. Ideas that
> keep all inference local and Postgres-sourced — single-user *or* within the
> isolated-multi-tenant envelope — fit naturally.

---

## 11. Known gaps / backlog (opportunity surface for new ideas)

- **Import ↔ live group merge (deferred 009, highest real-world value):** imported groups
  have no WhatsApp JID, so the live collector creates a *separate* row for the same real
  group → stale cache when summarizing. Needs a manual "link group A ↔ B" action +
  UI surface.
- **Summary quality** is the open frontier: better Hebrew, topic threading, model choice
  (quality vs. speed), evaluation. Length scaling is currently prompt-guidance only.
- **Media analysis quality WIP:** earlier vision model had preamble leakage + degeneration
  on text-heavy Hebrew images; re-enabled with gemma4:26b but quality tuning continues.
- **Hebrew name overrides** (deferred); `@lid` opaque IDs can't always resolve to a name.
- **Ultra-short-video frame extraction** (deferred): sub-second clips break `fps=1`
  extraction → should grab 1 frame.
- **No packaged deploy / prod story:** day-to-day is `make dev`.
- **Off-LAN / true PWA** (optional, infra-leaning): needs HTTPS (mkcert) or Tailscale;
  deliberately HTTP-only today.
- **Memory tuning:** summary + vision models co-resident is tight on a 36GB Mac.

---

## 12. Quick repo facts

- **Repo:** `EyalDelarea/Catchup` · MIT license · TypeScript.
- **236 tracked files**, ~423+ automated tests, CI via GitHub Actions (`ci.yml`, `codeql.yml`).
- **Entry points:** `make dev` (everything) · `src/cli.ts` (CLI) · `src/web/server.ts` (UI)
  · `src/workers/worker.ts` (jobs).
- **Default ports:** Web 8787 · Grafana 3000 · Postgres 5432 · RabbitMQ 5672/15672 · Loki 3100.
- **Design docs:** spec-kit artifacts under `specs/<NNN-feature>/` (gitignored — local to each feature branch).
```
