#!/usr/bin/env bash
#
# dev.sh — one-command local stack for Catchup.
#
# Brings up infra (RabbitMQ + Loki + Grafana), applies migrations, then runs the
# worker AND the web+collector together with combined, labeled logs. Ctrl-C stops
# everything. Refuses to start if a collector is already running (two WhatsApp
# sessions on one linked device conflict and flap).
#
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Guard: never run a second collector (the double-session WhatsApp conflict) ---
if pgrep -f "src/cli.ts (serve|collect)" >/dev/null 2>&1; then
  echo "✋ A collector/serve process is already running — refusing to start a second one"
  echo "   (two WhatsApp sessions on one device conflict). Stop it first:"
  pgrep -fl "src/cli.ts (serve|collect)" || true
  exit 1
fi

echo "▶ Bringing up infra (postgres, rabbitmq, loki, grafana)…"
docker compose up -d postgres rabbitmq loki grafana

echo "▶ Waiting for Postgres + RabbitMQ to be healthy…"
until docker compose ps postgres | grep -q "(healthy)"; do sleep 2; done
until docker compose ps rabbitmq | grep -q "(healthy)"; do sleep 2; done

echo "▶ Applying migrations…"
npm run migrate

cleanup() {
  echo
  echo "▶ Shutting down worker + serve…"
  pkill -f "src/workers/worker.ts" 2>/dev/null || true
  pkill -f "src/cli.ts serve" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "▶ Starting worker + serve --collect…"
# Media analysis (analyze.image/.video) re-enabled so NEW media gets captioned
# going forward (gemma4:26b + think:false, multi-frame video). It shares the model
# with summaries (serial worker), so to catch up history use a bounded enqueue, e.g.
# `npx tsx src/cli.ts analyze-backlog --limit 20`, rather than draining everything.
# summarize.group runs the scheduled digest (feature 011).
( npx tsx src/workers/worker.ts --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group 2>&1 \
    | while IFS= read -r l; do printf '[worker] %s\n' "$l"; done ) &
( npx tsx src/cli.ts serve --collect 2>&1 \
    | while IFS= read -r l; do printf '[serve]  %s\n' "$l"; done ) &

cat <<'EOF'

  ✅ Stack up:
     Web UI    → http://localhost:8787   (summarize + status panel)
     Grafana   → http://localhost:3000   (logs + dashboards)
     RabbitMQ  → http://localhost:15672  (guest/guest)

  Scan the QR once if prompted (read-only collector). Ctrl-C stops everything.

EOF

wait
