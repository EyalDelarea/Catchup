<p align="center">
  <img src="assets/banner.png" alt="Catchup — local-first WhatsApp summaries" width="720" />
</p>

<p align="center">
  <a href="#-requirements"><img src="https://img.shields.io/badge/node-%E2%89%A522-3c873a?logo=node.js&logoColor=white" alt="Node ≥ 22" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-38bdf8" alt="MIT License" /></a>
  <a href="https://github.com/EyalDelarea/Catchup/actions/workflows/ci.yml"><img src="https://github.com/EyalDelarea/Catchup/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/privacy-100%25%20local-0ea5e9" alt="100% local" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

# 🧊 Catchup

> 📨 **Wake up to 200 unread messages?** Catchup reads them for you — overnight, locally — so you open your phone to *the gist*, not the scroll.

A **local-first** personal WhatsApp summarizer. Messages are collected passively via a read-only linked device (using [Baileys](https://github.com/WhiskeySockets/Baileys)), stored in your own Postgres, transcribed locally (faster-whisper), captioned locally (Ollama vision), and summarized locally (Ollama) — then displayed in a mobile-first, RTL Hebrew web UI. **Nothing leaves your machine.** No cloud API keys, no hosted service, no data sharing.

<p align="center">
  <img src="assets/screenshot.png" alt="Catchup web UI — a structured Hebrew catch-up summary of a group" width="380" />
</p>

<p align="center"><sub>📱 The mobile web UI showing a structured "what I missed" summary (demo data).</sub></p>

---

## ✨ How it works

```mermaid
flowchart LR
    WA["📲 WhatsApp<br/>Baileys · read-only"] --> PG[("🗄️ Postgres<br/>your database")]
    PG --> W["🎙️ Whisper<br/>voice → text"]
    PG --> V["👁️ Ollama vision<br/>images/video → captions"]
    W --> S["🧠 Ollama<br/>structured summary"]
    V --> S
    S --> UI["📱 Web UI<br/>mobile · RTL · Hebrew"]
```

Every box runs on **your machine**. The only thing that touches the network is the read-only WhatsApp link itself.

### 📊 Total summary (סיכום כללי)

In addition to per-chat summaries, Catchup can produce a single digest across **all** your chats at once. It summarizes each active group and DM for the chosen time range, then reduces those into cross-cutting highlights — flagging things that need your attention — followed by a per-chat breakdown.

- **On demand in the web UI:** a pinned "📊 סיכום כללי" card sits at the top of the chat list; pick a range (24 h / 3 days / week) and the summary streams in live.
- **Automatically:** the twice-daily scheduler produces a total summary alongside the per-chat digests, so it's ready when you wake up.

---

## ⚠️ Disclaimer

Catchup uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**, reverse-engineered WhatsApp library. This project is **not affiliated with, endorsed by, or approved by WhatsApp or Meta**. Using unofficial clients may violate WhatsApp's Terms of Service. You are solely responsible for ensuring your use complies with applicable terms and laws. Use at your own risk, for personal use only.

---

## 📋 Requirements

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | `package.json` engines field (and `.nvmrc`, which CI reads) |
| Docker + Docker Compose v2 | any recent | `docker compose` (v2 syntax); runs Postgres, RabbitMQ, Loki, Grafana |
| ffmpeg | any | On PATH; used for audio normalization and video frame extraction |
| Python | ≥ 3.10 | With `faster-whisper` installed (Hebrew voice-note transcription) |
| Ollama | any | Local LLM server; runs summaries and vision captioning |

### 🧠 RAM — the #1 gotcha

The default model (`gemma4:26b`) is used for both summaries and image/video captioning. It requires significant memory:

| Setup | Minimum RAM | Notes |
|---|---|---|
| `gemma4:26b` (default) | ~16 GB unified / ~26 GB system | Best quality; Hebrew OCR; multi-frame video |
| `gemma4:12b` | ~10 GB | Good quality; set `SUMMARY_MODEL=gemma4:12b` and `VISION_MODEL=gemma4:12b` |
| `gemma4:4b` | ~4 GB | Lighter; quality degrades for Hebrew |

To use a smaller model, set `SUMMARY_MODEL` and/or `VISION_MODEL` in your `.env`:

```bash
SUMMARY_MODEL=gemma4:12b
VISION_MODEL=gemma4:12b
VISION_VIDEO_MODEL=gemma4:12b
```

Both summaries and vision run on the same Ollama instance. The worker is single-threaded by default (`WORKER_CONCURRENCY=1`), so they run serially and share one model residency.

---

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/EyalDelarea/Catchup.git
cd Catchup
npm install

# 2. Configure (all keys have sane defaults)
cp .env.example .env

# 3. Install Python transcription dependencies
python3 -m venv .venv
.venv/bin/pip install -r src/transcription/requirements.txt
# TRANSCRIPTION_PYTHON already defaults to ./.venv/bin/python

# 4. Pull the Ollama model (needs Ollama: https://ollama.com)
ollama pull gemma4:26b

# 5. Start everything
make dev

# 6. Open the web UI → http://localhost:8787
```

`make dev` brings up Postgres, RabbitMQ, Loki, and Grafana via Docker Compose; applies database migrations; and starts the background worker and the web server + live collector together. Ctrl-C stops everything cleanly.

---

## 🩺 Verify with `doctor`

Before linking WhatsApp, confirm all 7 prerequisites pass:

```bash
npx tsx src/cli.ts doctor
```

The doctor checks, in order:

1. **Docker running** — `docker info` exits 0
2. **Compose services up** — at least one container is running
3. **Postgres reachable + migrations applied** — connects and verifies the `job_runs` and `service_status` tables exist
4. **RabbitMQ reachable** — opens and closes an AMQP connection
5. **Ollama reachable + model pulled** — hits `/api/tags` and checks that `SUMMARY_MODEL` is present
6. **Python + faster-whisper importable** — spawns `python -c "import faster_whisper"`
7. **ffmpeg on PATH** — spawns `ffmpeg -version`

Each line prints `✅ <check>` or `❌ <check> — fix: <command>`. The process exits 1 if any check fails.

---

## 🔗 Linking WhatsApp (QR walkthrough)

This is the most important step. On first run (`make dev` or `npx tsx src/cli.ts serve --collect`), a QR code prints in the terminal.

**Before the QR appears, a safety banner prints:**

```
🔒 Read-only mode: this tool will NOT send messages, read receipts, or presence.
   It is a passive observer. (Sending stays off unless you set WHATSAPP_ALLOW_SEND=true.)
```

**To link:**

1. Open WhatsApp on your phone.
2. Tap the menu (three dots, top-right on Android) or **Settings** (bottom-right on iOS).
3. Tap **Linked Devices** → **Link a Device**.
4. Point your camera at the QR in the terminal.

**Tips:**
- The QR expires in about 20 seconds. If it expires, a new one is printed automatically.
- If the QR looks broken or garbled, maximize your terminal window and try again.
- Once linked, the session is saved to `data/baileys-auth/` and resumes automatically on restart — no re-scan needed.

**If you get logged out** (WhatsApp logs out linked devices after inactivity or if you unlink manually):

```bash
rm -rf data/baileys-auth/
# Then restart make dev or serve --collect — a new QR will print
```

**Outbound safety:** The linked device is hardened to never send anything. `sendMessage` and `relayMessage` throw if called. Presence updates, read receipts, and typing indicators are silenced to no-ops. This cannot be accidentally bypassed. To explicitly enable sending, set `WHATSAPP_ALLOW_SEND=true` in `.env`.

---

## 🛠️ CLI commands

<details>
<summary><strong>Expand the full command reference</strong> — serve, collect, summarize, groups, transcribe, analyze-backlog, digest-run, import, doctor</summary>

<br/>

All commands run via `npx tsx src/cli.ts <command>` in development, or `node dist/cli.js <command>` after `npm run build`.

### `serve` — start the web UI

```bash
npx tsx src/cli.ts serve
npx tsx src/cli.ts serve --port 9000
npx tsx src/cli.ts serve --collect   # also run the live WhatsApp collector
```

Opens the mobile-first web UI at `http://localhost:8787`. The `--collect` flag starts the live collector in the same process (links via QR on first run). The scheduler for twice-daily digests also starts here.

**Access from your phone (same Wi-Fi):**

```bash
ipconfig getifaddr en0   # macOS — find your machine's LAN IP
# Then open http://<ip>:8787 in your phone's browser
```

### `collect` — standalone live collector

```bash
npx tsx src/cli.ts collect
```

Links your WhatsApp account (QR on first run) and continuously stores incoming group messages. Usually you run `serve --collect` instead (both in one process). Run standalone only if you need the collector without the web UI.

### `summarize` — summarize a chat from the CLI

```bash
npx tsx src/cli.ts summarize "Family"                        # last 25 messages (default)
npx tsx src/cli.ts summarize "Family" --last 100             # last N messages
npx tsx src/cli.ts summarize "Family" --since 2026-05-30     # since a date (YYYY-MM-DD)
npx tsx src/cli.ts summarize "Family" --last 50 --out summary.txt  # write to a file
```

Generates a structured Hebrew markdown summary locally via Ollama. Voice-note transcripts are folded in automatically (run `transcribe` first if needed). An empty selection prints `Nothing to summarize for that selection.`

### `groups` — list stored chats

```bash
npx tsx src/cli.ts groups
```

Prints a numbered list of all stored groups and chats, e.g.:
```
1. Family (live, 12045 messages)
2. Work Chat (import, 5430 messages)
```

### `transcribe` — transcribe pending voice notes

```bash
npx tsx src/cli.ts transcribe
npx tsx src/cli.ts transcribe --group "Family"   # only this group
```

Runs `faster-whisper` locally on any voice notes that haven't been transcribed yet. The first run downloads the model (~1.5 GB). Safe to run multiple times (skips already-transcribed notes).

### `analyze-backlog` — enqueue vision analysis for existing media

```bash
npx tsx src/cli.ts analyze-backlog
npx tsx src/cli.ts analyze-backlog --limit 20
npx tsx src/cli.ts analyze-backlog --types analyze.image
```

Enqueues `analyze.image` and/or `analyze.video` jobs for media that has no completed analysis. Useful after enabling vision for the first time. Requires the worker to be running.

### `digest-run` — manually trigger a digest run

```bash
npx tsx src/cli.ts digest-run
npx tsx src/cli.ts digest-run --all   # enqueue all groups, not just those with new messages
```

Manually triggers the scheduled digest (enqueues `summarize.group` jobs for groups that have received new messages). Normally the digest runs automatically at `DIGEST_TIMES`.

### `import` — import a WhatsApp chat export

```bash
npx tsx src/cli.ts import ./chat.txt --name "Family"
npx tsx src/cli.ts import ./chat.zip --name "Family"        # includes media
npx tsx src/cli.ts import --folder ./exports                # bulk: enqueues all .txt/.zip files
```

Imports a WhatsApp export (`.txt` or `.zip`) into Postgres. Re-importing the same file is safe — messages are deduplicated by a stable key. Bulk mode enqueues background jobs; requires the worker to be running.

To export a chat from WhatsApp: open the chat → tap the group/contact name → scroll down to **Export Chat** → choose **Without Media** (`.txt`) or **Include Media** (`.zip`).

### `doctor` — verify prerequisites

```bash
npx tsx src/cli.ts doctor
```

See [Verify with `doctor`](#-verify-with-doctor) above.

</details>

---

## ⚙️ Configuration

<details>
<summary><strong>Expand the full <code>.env</code> reference</strong> — every key has a default</summary>

<br/>

Copy `.env.example` to `.env`. All keys have defaults; the table below lists every option.

| Key | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/whatsapp_sum` | Postgres connection string |
| `DATA_DIR` | `./data` | Directory for auth state, media downloads, and exports |
| `TRANSCRIPTION_PYTHON` | `./.venv/bin/python` | Python interpreter with `faster-whisper` installed |
| `TRANSCRIPTION_MODEL` | `ivrit-ai/whisper-large-v3-turbo-ct2` | HuggingFace model for Hebrew speech-to-text (downloaded on first use) |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `OLLAMA_HOST` | `http://localhost:11434` | Local Ollama server base URL |
| `SUMMARY_MODEL` | `gemma4:26b` | Ollama model for generating summaries |
| `SUMMARY_NUM_CTX` | `32768` | Context window size (Ollama defaults to 2048 — this must be raised) |
| `SUMMARY_TOKEN_BUDGET` | `24000` | Max estimated input tokens before a selection is rejected as too large |
| `VISION_MODEL` | `gemma4:26b` | Ollama model for image captioning and OCR |
| `VISION_VIDEO_MODEL` | `gemma4:26b` | Ollama model for video analysis (defaults to `VISION_MODEL` if unset) |
| `VISION_VIDEO_FPS` | `1` | Frames per second sampled from videos |
| `VISION_VIDEO_MAX_FRAMES` | `8` | Maximum frames sent per video (caps memory usage) |
| `VISION_MAX_VIDEO_MB` | `25` | Maximum video file size (MB) accepted for analysis |
| `VISION_NUM_CTX` | `8192` | Context window for the vision model (kept small to control KV-cache memory) |
| `WEB_PORT` | `8787` | Port for the local web UI |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ AMQP connection URL |
| `LOKI_URL` | `http://localhost:3100` | Loki log-shipping endpoint |
| `LOG_LEVEL` | `info` | pino log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) |
| `WORKER_CONCURRENCY` | `1` | Concurrent jobs per worker process |
| `WHATSAPP_ALLOW_SEND` | `false` | Set `true` only to allow outbound WhatsApp messages. Leave `false` for passive collection. |
| `RETAIN_MEDIA` | `false` | Set `true` to keep media files on disk after analysis/transcription. By default files are pruned after captioning. |
| `DIGEST_ENABLED` | `true` | Enable scheduled twice-daily pre-summarization (so opening a group feels instant) |
| `DIGEST_TIMES` | `08:00,18:00` | Comma-separated HH:MM times (local timezone) for the digest runs |

</details>

---

## 🏗️ Architecture

<details>
<summary><strong>Expand the architecture diagram and notes</strong></summary>

<br/>

```mermaid
flowchart TB
    imp["import / import --folder<br/>(.txt / .zip)"] --> norm["normalize + dedupe<br/>by stable key"]
    live["serve --collect / collect<br/>(Baileys QR, live)"] --> norm
    norm --> PG[("PostgreSQL<br/>source of truth")]

    PG --> voice["faster-whisper<br/>voice notes → transcripts"]
    PG --> media["Ollama vision<br/>images/video → captions"]
    voice --> llm["Ollama LLM<br/>structured summary"]
    media --> llm
    llm --> out["web UI · CLI · digest<br/>http://localhost:8787"]

    PG -. job refs only .-> mq{{"RabbitMQ work queue<br/>import · transcribe · analyze · summarize"}}
    mq -. competing consumers .-> worker["worker pool<br/>retries + dead-letter"]
    worker --> PG
```

- **Postgres** is the sole source of truth. The broker carries only job references (IDs), never message content.
- **Node.js** runs the CLI, web server, collector (Baileys), and worker.
- **Python + faster-whisper** runs as a subprocess for Hebrew voice-note transcription (local, nothing sent to any API).
- **Ollama** hosts the LLM and vision model locally.
- **Docker Compose** manages Postgres, RabbitMQ, Loki, and Grafana — the app itself runs on the host for GPU/CPU access.

</details>

---

## 📊 Observability

<details>
<summary><strong>Expand dashboards, ports, and the live jobs view</strong></summary>

<br/>

`make dev` starts Loki (log aggregation) and Grafana alongside the app stack.

| Dashboard | URL | Credentials |
|---|---|---|
| Grafana (logs + job dashboards) | http://localhost:3000 | anonymous admin (no login) |
| RabbitMQ management | http://localhost:15672 | guest / guest |
| App status API | http://localhost:8787/api/status | — |

The **Jobs Status (live)** Grafana dashboard shows per-job-type throughput, latency, failure rates, and queue depths in real time. Use it to monitor bulk imports, transcription backlogs, and vision analysis progress.

### Ports

| Service | Port | Notes |
|---|---|---|
| Web UI | 8787 | Configurable via `WEB_PORT` or `--port` |
| Grafana | 3000 | Logs and job dashboards |
| Postgres | 5432 | If you already run Postgres on 5432, stop it or point `DATABASE_URL` elsewhere |
| RabbitMQ AMQP | 5672 | — |
| RabbitMQ management | 15672 | guest/guest |
| Loki | 3100 | Log ingestion |

</details>

---

## 🧯 Troubleshooting

<details>
<summary><strong>Expand common issues and fixes</strong></summary>

<br/>

**Out of memory / Ollama crashes**
The default `gemma4:26b` needs ~16 GB unified memory. Switch to a smaller model:
```bash
SUMMARY_MODEL=gemma4:12b
VISION_MODEL=gemma4:12b
```
See the [RAM table](#-ram--the-1-gotcha).

**QR code won't scan**
- Maximize your terminal — a small window breaks the QR rendering.
- The QR expires after ~20 seconds. Wait for the next one.
- Ensure your phone's WhatsApp is up to date.

**Session logged out**
WhatsApp may log out the linked device after inactivity. Delete the saved session and re-link:
```bash
rm -rf data/baileys-auth/
```
Then restart `make dev` or `serve --collect` and scan the new QR.

**Port conflicts**
If something already uses 5432 (Postgres) or 5672 (RabbitMQ), either stop the conflicting service or update `DATABASE_URL` / `RABBITMQ_URL` in `.env` to point at your existing instances.

**Docker not running**
`make dev` and `npm test` both require Docker. Start Docker Desktop (or the Docker daemon) and try again. Verify with `npx tsx src/cli.ts doctor`.

**Postgres migrations not applied**
If `doctor` reports `Postgres reachable + migrations applied ❌`, run:
```bash
npm run migrate
```

**`faster-whisper` not found**
```bash
python3 -m venv .venv
.venv/bin/pip install -r src/transcription/requirements.txt
# TRANSCRIPTION_PYTHON defaults to ./.venv/bin/python
```

</details>

---

## 💻 Development

<details>
<summary><strong>Expand build, test, and worker commands</strong></summary>

<br/>

```bash
npm run typecheck     # TypeScript type-check (tsc --noEmit)
npm test              # Vitest test suite
npm run build         # Compile TypeScript to dist/
npm run migrate       # Apply database migrations
```

Tests use [Testcontainers](https://testcontainers.com/) for ephemeral Postgres and RabbitMQ — **Docker must be running** to run the full test suite.

The worker can be started independently for debugging:

```bash
npx tsx src/workers/worker.ts --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group,summarize.total
```

</details>

---

## License

[MIT](LICENSE)
