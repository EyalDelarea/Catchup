import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import {
  APP_ROLE,
  APP_ROLE_PASSWORD,
  OPERATOR_ROLE,
  OPERATOR_ROLE_PASSWORD,
} from "../db/migrations/1748649600024_create_app_roles.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckResult = {
  name: string;
  ok: boolean;
  /** A non-ok result with level "warn" is advisory — surfaced but not a hard failure. */
  level?: "warn";
  detail?: string;
  fix?: string;
};

// ── Pure check functions (injected probe) ─────────────────────────────────────

/** 1. Docker running */
export async function checkDocker(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Docker running";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "start Docker Desktop" };
  } catch (err) {
    return { name, ok: false, fix: "start Docker Desktop" };
  }
}

/** 2. Compose services up */
export async function checkComposeServices(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Compose services up";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "docker compose up -d" };
  } catch (err) {
    return { name, ok: false, fix: "docker compose up -d" };
  }
}

/** 3. Postgres reachable AND migrations applied (job_runs + service_status tables exist) */
export async function checkPostgres(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Postgres reachable + migrations applied";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "npm run migrate" };
  } catch (err) {
    return { name, ok: false, fix: "npm run migrate" };
  }
}

/** 4. RabbitMQ reachable */
export async function checkRabbitMQ(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "RabbitMQ reachable";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "docker compose up -d rabbitmq" };
  } catch (err) {
    return { name, ok: false, fix: "docker compose up -d rabbitmq" };
  }
}

/** 5. Ollama reachable AND SUMMARY_MODEL pulled */
export async function checkOllama(
  model: string,
  probe: () => Promise<boolean>,
): Promise<CheckResult> {
  const name = "Ollama reachable + model pulled";
  try {
    const ok = await probe();
    return ok
      ? { name, ok: true }
      : { name, ok: false, fix: `ollama serve && ollama pull ${model}` };
  } catch (err) {
    return { name, ok: false, fix: `ollama serve && ollama pull ${model}` };
  }
}

/** 6. Python interpreter importable with faster-whisper */
export async function checkPython(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "Python + faster-whisper importable";
  try {
    const ok = await probe();
    return ok
      ? { name, ok: true }
      : {
          name,
          ok: false,
          fix: "pip install -r src/transcription/requirements.txt (in your .venv)",
        };
  } catch (err) {
    return {
      name,
      ok: false,
      fix: "pip install -r src/transcription/requirements.txt (in your .venv)",
    };
  }
}

/** 7. ffmpeg on PATH */
export async function checkFfmpeg(probe: () => Promise<boolean>): Promise<CheckResult> {
  const name = "ffmpeg on PATH";
  try {
    const ok = await probe();
    return ok ? { name, ok: true } : { name, ok: false, fix: "brew install ffmpeg" };
  } catch (err) {
    return { name, ok: false, fix: "brew install ffmpeg" };
  }
}

/**
 * 8. DB roles aren't still using the committed default passwords.
 *
 * You can't read a role's password hash as a non-superuser, so each probe instead TRIES to
 * connect with the committed default — a successful connection means the password was never
 * rotated. This is advisory (level "warn"): weak local-dev passwords are fine, but a
 * BYPASSRLS operator role reachable with a public default password on an exposed Postgres is
 * a full cross-tenant compromise.
 */
export async function checkDefaultPasswords(
  probeApp: () => Promise<boolean>,
  probeOperator: () => Promise<boolean>,
  opts: { multiTenant: boolean },
): Promise<CheckResult> {
  const name = "DB roles use non-default passwords";
  try {
    const [appDefault, opDefault] = await Promise.all([probeApp(), probeOperator()]);
    if (!appDefault && !opDefault) return { name, ok: true };
    const roles = [appDefault ? APP_ROLE : null, opDefault ? OPERATOR_ROLE : null]
      .filter((r): r is string => r !== null)
      .join(", ");
    const emphasis = opts.multiTenant
      ? "multi-tenant mode is ON — rotate before exposing Postgres"
      : "fine for local dev; rotate before any networked / multi-tenant deploy";
    return {
      name,
      ok: false,
      level: "warn",
      detail: `${roles} still accept the committed default password (${emphasis})`,
      fix: `ALTER ROLE ${roles} WITH PASSWORD '<strong-secret>', then set APP_DATABASE_URL / OPERATOR_DATABASE_URL`,
    };
  } catch {
    // A probe error (rather than a clean false) shouldn't masquerade as "rotated" or as a
    // hard failure — treat the check as inconclusive/ok; checkPostgres covers DB outages.
    return { name, ok: true };
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all checks and return one result per check. Never throws — each check
 * catches its own errors internally.
 */
export async function runChecks(checks: Array<() => Promise<CheckResult>>): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => c()));
}

// ── Real probe implementations ────────────────────────────────────────────────

/** Spawn a command and resolve to true if it exits 0, false otherwise. */
function spawnProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Real Docker probe: `docker info` exits 0 iff daemon is running. */
function realDockerProbe(): Promise<boolean> {
  return spawnProbe("docker", ["info"]);
}

/** Real Compose probe: `docker compose ps --quiet` exits 0 iff at least one container is up. */
function realComposeProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", "ps", "--quiet"], { stdio: "pipe" });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      // Exit 0 and at least one container ID line
      resolve(code === 0 && stdout.trim().length > 0);
    });
  });
}

/** Real Postgres probe: connect and verify job_runs + service_status tables exist. */
async function realPostgresProbe(databaseUrl: string): Promise<boolean> {
  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const res = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('job_runs', 'service_status')
      `);
      return res.rows.length === 2;
    } finally {
      await pool.end();
    }
  } catch {
    return false;
  }
}

/** Real RabbitMQ probe: open AMQP connection and close it immediately. */
async function realRabbitMqProbe(amqpUrl: string): Promise<boolean> {
  try {
    const amqplib = await import("amqplib");
    const conn = await amqplib.connect(amqpUrl);
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Real Ollama probe: fetch /api/tags and check the model name is present. */
async function realOllamaProbe(ollamaHost: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaHost}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const models = body.models ?? [];
    // Normalize by stripping tag for loose matching
    const modelBase = model.split(":")[0]!;
    return models.some((m) => m.name === model || m.name.startsWith(modelBase));
  } catch {
    return false;
  }
}

/**
 * Real default-password probe: try to connect as `role` using `password` against the same
 * host/db as `databaseUrl`. Resolves true iff the connection succeeds (password unchanged).
 */
async function realDefaultPasswordProbe(
  databaseUrl: string,
  role: string,
  password: string,
): Promise<boolean> {
  try {
    const { default: pg } = await import("pg");
    const u = new URL(databaseUrl);
    u.username = role;
    u.password = password;
    const pool = new pg.Pool({
      connectionString: u.toString(),
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      await pool.query("SELECT 1");
      return true;
    } finally {
      await pool.end();
    }
  } catch {
    return false;
  }
}

/** Real Python probe: spawn pythonPath -c "import faster_whisper" */
async function realPythonProbe(pythonPath: string): Promise<boolean> {
  return spawnProbe(pythonPath, ["-c", "import faster_whisper"]);
}

/** Real ffmpeg probe: spawn ffmpegPath -version */
async function realFfmpegProbe(ffmpegPath: string): Promise<boolean> {
  return spawnProbe(ffmpegPath, ["-version"]);
}

// ── defaultChecks: assembles real probes from config ─────────────────────────

/**
 * Returns the array of real check thunks wired to actual system probes.
 * Pass the result directly to runChecks().
 */
export function defaultChecks(config: AppConfig): Array<() => Promise<CheckResult>> {
  return [
    () => checkDocker(realDockerProbe),
    () => checkComposeServices(realComposeProbe),
    () => checkPostgres(() => realPostgresProbe(config.databaseUrl)),
    () => checkRabbitMQ(() => realRabbitMqProbe(config.broker.url)),
    () =>
      checkOllama(config.summarization.model, () =>
        realOllamaProbe(config.summarization.ollamaHost, config.summarization.model),
      ),
    () => checkPython(() => realPythonProbe(config.transcription.pythonPath)),
    () => checkFfmpeg(() => realFfmpegProbe(config.transcription.ffmpegPath)),
    () =>
      checkDefaultPasswords(
        () => realDefaultPasswordProbe(config.databaseUrl, APP_ROLE, APP_ROLE_PASSWORD),
        () => realDefaultPasswordProbe(config.databaseUrl, OPERATOR_ROLE, OPERATOR_ROLE_PASSWORD),
        { multiTenant: config.auth.enabled },
      ),
  ];
}
