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

# Colored source prefixes (only when stdout is a real terminal — keep pipes/files clean).
if [ -t 1 ]; then
  C_WORKER=$'\033[1;35m'   # bold magenta
  C_SERVE=$'\033[1;36m'    # bold cyan
  C_RESET=$'\033[0m'
else
  C_WORKER='' ; C_SERVE='' ; C_RESET=''
fi
WORKER_PREFIX="${C_WORKER}[worker]${C_RESET}"
SERVE_PREFIX="${C_SERVE}[serve] ${C_RESET}"

# Pretty-print pino JSON logs into readable, colored lines. Non-JSON lines pass
# through unchanged, so plain console.log output and the QR survive. Falls back
# to a passthrough (cat) if pino-pretty is somehow unavailable.
# A function (not a var) so the multi-word --messageFormat survives unquoted
# pipe expansion. Renders the source inline: "[12:20:24] INFO (collector): connected".
pretty() {
  if [ -x node_modules/.bin/pino-pretty ]; then
    # --singleLine keeps each log on ONE line (extra fields as a compact trailing
    # object instead of an indented block). `component` is ignored from that
    # object since it's already shown inline as "(component)" via messageFormat.
    node_modules/.bin/pino-pretty --translateTime SYS:HH:MM:ss --ignore pid,hostname,component \
      --colorize --singleLine --messageFormat '{if component}({component}) {end}{msg}'
  else
    cat
  fi
}

# Media analysis (analyze.image/.video) re-enabled so NEW media gets captioned
# going forward (gemma4:26b + think:false, multi-frame video). It shares the model
# with summaries (serial worker), so to catch up history use a bounded enqueue, e.g.
# `npx tsx src/cli.ts analyze-backlog --limit 20`, rather than draining everything.
# summarize.group runs the scheduled per-chat digest (feature 011);
# summarize.total runs the scheduled cross-chat total summary.
( npx tsx src/workers/worker.ts --types import.file,transcribe.voicenote,analyze.image,analyze.video,summarize.group,summarize.total,suggest.generate 2>&1 \
    | pretty \
    | while IFS= read -r l; do printf '%s %s\n' "$WORKER_PREFIX" "$l"; done ) &
( npx tsx src/cli.ts serve --collect 2>&1 \
    | pretty \
    | while IFS= read -r l; do printf '%s %s\n' "$SERVE_PREFIX" "$l"; done ) &

cat <<'EOF'

  ✅ Stack up:
     Web UI    → http://localhost:8787   (summarize + status panel)
     Grafana   → http://localhost:3000   (logs + dashboards)
     RabbitMQ  → http://localhost:15672  (guest/guest)

  Scan the QR once if prompted (read-only collector). Ctrl-C stops everything.

EOF

wait
