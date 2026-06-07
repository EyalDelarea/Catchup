.PHONY: up down dev bench bench-fixtures bench-all

# One command for local dev: infra (rabbitmq/loki/grafana) + migrations + worker +
# web/collector together with combined logs. Refuses to start a second collector.
dev:
	bash scripts/dev.sh

# Bring up all infra, wait for postgres + rabbitmq to be healthy, then run migrations.
up:
	docker compose up -d
	@echo "Waiting for postgres to be healthy..."
	@until docker compose ps postgres | grep -q "(healthy)"; do \
		sleep 2; \
	done
	@echo "Postgres is healthy."
	@echo "Waiting for rabbitmq to be healthy..."
	@until docker compose ps rabbitmq | grep -q "(healthy)"; do \
		sleep 2; \
	done
	@echo "RabbitMQ is healthy."
	npm run migrate

# Stop and remove all infra containers (add make down ARGS=-v to wipe volumes).
down:
	docker compose down $(ARGS)

# --- Inference benchmark (see bench/README.md) -----------------------------------
# Generate neutral, license-free fixtures (idempotent; needs ffmpeg).
bench-fixtures:
	bash bench/fixtures/generate.sh

# Run the headline comparison against the CURRENTLY running Ollama (no daemon restart):
# baseline (gemma4:26b) vs vision-7b (qwen2.5vl). Override configs/runs via ARGS, e.g.
#   make bench ARGS="--configs baseline --runs 3"
bench: bench-fixtures
	npx tsx bench/run.ts --configs baseline,vision-7b $(ARGS)

# Full four-config sweep INCLUDING the Flash-Attention + KV-q8_0 server states.
# This restarts the Ollama server twice (see bench/run-all.sh) — it will momentarily
# stop the desktop app's server; relaunch Ollama.app afterwards if you use it.
bench-all: bench-fixtures
	bash bench/run-all.sh $(ARGS)
