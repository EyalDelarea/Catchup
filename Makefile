.PHONY: up down dev

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
