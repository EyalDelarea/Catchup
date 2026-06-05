import { defineConfig } from "vitest/config";

// Many tests use Testcontainers (Postgres, RabbitMQ). Container startup — especially
// on a cold image pull in CI — can exceed Vitest's default 5s hook timeout. Give
// setup/teardown and slow integration tests generous headroom.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
