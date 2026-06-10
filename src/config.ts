import path from "node:path";

export type TranscriptionConfig = {
  /** Path to the Python interpreter that has faster-whisper installed. */
  pythonPath: string;
  /** HuggingFace model id for the faster-whisper engine. */
  model: string;
  /** Path to the ffmpeg binary used for audio normalization. */
  ffmpegPath: string;
};

export type SummarizationConfig = {
  /** Base URL of the local Ollama server. */
  ollamaHost: string;
  /** Ollama model tag used to generate summaries. */
  model: string;
  /** Context window requested per call (Ollama defaults to 2048 — must raise). */
  numCtx: number;
  /** Max estimated input tokens before a selection is rejected as too large. */
  tokenBudget: number;
  /** Sampling temperature (default 0.7 — 0.2 produced terse summaries). */
  temperature: number;
  /** repeat_penalty (default 1.1 — 1.3 was too aggressive and suppressed detail). */
  repeatPenalty: number;
  /** Max tokens to generate (default 4096 — generous cap so summaries aren't truncated). */
  numPredict: number;
};

export type WebConfig = {
  /** Port the local web UI server binds to. */
  port: number;
};

export type BrokerConfig = {
  /** AMQP connection URL for RabbitMQ. */
  url: string;
};

export type LoggingConfig = {
  /** HTTP endpoint where pino-loki ships logs. */
  lokiUrl: string;
  /** pino log level (trace | debug | info | warn | error | fatal). */
  level: string;
};

export type WorkerConfig = {
  /** Default prefetch (concurrent jobs) per worker process. */
  concurrency: number;
};

export type VisionConfig = {
  /** Ollama vision model tag used to describe images and video frames. */
  model: string;
  /**
   * Ollama model tag used specifically for VIDEO (multi-frame) analysis.
   * Defaults to `model` so video uses the same engine as images unless overridden.
   * Point this at a Gemma 4 multimodal tag (e.g. gemma4:12b / gemma4:26b) to use
   * Gemma's video understanding while leaving image analysis on `model`.
   */
  videoModel: string;
  /** Frames per second to sample from a video (Gemma 4 guidance: ~1fps). */
  videoFps: number;
  /** Maximum number of frames sent per video (caps KV-cache memory). */
  videoMaxFrames: number;
  /** Maximum video file size in megabytes accepted for analysis. */
  maxVideoMb: number;
  /** Context window for the vision model. Small by default — image description needs little
   *  context, and a large num_ctx blows up KV-cache memory (32k ≈ 17GB). */
  numCtx: number;
};

export type WhatsAppConfig = {
  /**
   * Whether the live collector is permitted to SEND anything to WhatsApp
   * (messages, receipts, presence). Default false — the linked device is a
   * strictly passive, read-only observer. Must be explicitly opted into.
   */
  allowSend: boolean;
};

export type DigestConfig = {
  /** When false, the scheduled digest runner does not start. Default true. */
  enabled: boolean;
  /**
   * Comma-separated HH:MM times (local timezone) at which the digest runs.
   * Default "08:00,18:00".
   */
  times: string;
};

export type OpsSweepConfig = {
  /** When false, the ops-sweep scheduler does not start. Default true. */
  enabled: boolean;
  /**
   * Comma-separated HH:MM times (local timezone) at which the ops sweep runs.
   * Default "08:00,18:00".
   */
  times: string;
  /** Maximum auto re-drives per work-item before flagging. Default 2. */
  redriveCap: number;
};

export type AuthConfig = {
  /**
   * Master switch for multi-tenant mode (MULTI_TENANT=true): the web UI requires a
   * session, registration is open, and requests are scoped to the session's tenant.
   * Default false — single-user local mode, everything runs as the default tenant
   * with no login (the backward-compat guarantee).
   */
  enabled: boolean;
  /**
   * Secure attribute on the session cookie. Defaults to `enabled` (multi-tenant is
   * internet-facing behind HTTPS; local single-user dev is plain http).
   */
  cookieSecure: boolean;
  /** Session lifetime in seconds (SESSION_TTL_DAYS, default 30 days). */
  sessionTtlSeconds: number;
  /** Verify/reset email-token lifetime in seconds (EMAIL_TOKEN_TTL_MINUTES, default 60). */
  emailTokenTtlSeconds: number;
  /** ToS version stamped on the user row at registration (consent gate). */
  tosVersion: string;
  /** Base URL used to build verify/reset links in emails. */
  publicBaseUrl: string;
  /**
   * Emails (lowercased) allowed to reach the operator/admin dashboard — the
   * cross-tenant view. A logged-in user whose email is in this list is the operator;
   * everyone else gets 403 on /api/admin/*. Empty = no operator (admin disabled).
   */
  operatorEmails: string[];
};

export type AppConfig = {
  databaseUrl: string;
  dataDir: string;
  transcription: TranscriptionConfig;
  summarization: SummarizationConfig;
  vision: VisionConfig;
  web: WebConfig;
  broker: BrokerConfig;
  logging: LoggingConfig;
  worker: WorkerConfig;
  whatsapp: WhatsAppConfig;
  digest: DigestConfig;
  opsSweep: OpsSweepConfig;
  auth: AuthConfig;
  /**
   * When true, keep media files on disk even after a successful
   * analysis/transcription. Default false (prune after caption).
   *
   * Set RETAIN_MEDIA=true to opt in to keeping files.
   */
  retainMedia: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/whatsapp_sum",
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    transcription: {
      pythonPath: env.TRANSCRIPTION_PYTHON ?? "python3",
      model: env.TRANSCRIPTION_MODEL ?? "ivrit-ai/whisper-large-v3-turbo-ct2",
      ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    },
    summarization: {
      ollamaHost: env.OLLAMA_HOST ?? "http://localhost:11434",
      model: env.SUMMARY_MODEL ?? "gemma4:26b",
      numCtx: Number(env.SUMMARY_NUM_CTX ?? 32768),
      tokenBudget: Number(env.SUMMARY_TOKEN_BUDGET ?? 24000),
      temperature: Number(env.SUMMARY_TEMPERATURE ?? 0.7),
      repeatPenalty: Number(env.SUMMARY_REPEAT_PENALTY ?? 1.1),
      numPredict: Number(env.SUMMARY_NUM_PREDICT ?? 4096),
    },
    vision: {
      model: env.VISION_MODEL ?? "gemma4:26b",
      videoModel: env.VISION_VIDEO_MODEL ?? env.VISION_MODEL ?? "gemma4:26b",
      videoFps: Number(env.VISION_VIDEO_FPS ?? 1),
      videoMaxFrames: Number(env.VISION_VIDEO_MAX_FRAMES ?? 8),
      maxVideoMb: Number(env.VISION_MAX_VIDEO_MB ?? 25),
      numCtx: Number(env.VISION_NUM_CTX ?? 8192),
    },
    web: {
      port: Number(env.WEB_PORT ?? 8787),
    },
    broker: {
      url: env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672",
    },
    logging: {
      lokiUrl: env.LOKI_URL ?? "http://localhost:3100",
      level: env.LOG_LEVEL ?? "info",
    },
    worker: {
      concurrency: Number(env.WORKER_CONCURRENCY ?? 1),
    },
    whatsapp: {
      // Off by default — sending must be explicitly opted into.
      allowSend: env.WHATSAPP_ALLOW_SEND === "true",
    },
    // Default false → prune after successful analysis/transcription.
    // Set RETAIN_MEDIA=true to keep files on disk.
    retainMedia: env.RETAIN_MEDIA === "true",
    digest: {
      // Default true — disable with DIGEST_ENABLED=false.
      enabled: env.DIGEST_ENABLED !== "false",
      times: env.DIGEST_TIMES ?? "08:00,18:00",
    },
    opsSweep: {
      // Default true — disable with OPS_SWEEP_ENABLED=false.
      enabled: env.OPS_SWEEP_ENABLED !== "false",
      times: env.OPS_SWEEP_TIMES ?? "08:00,18:00",
      redriveCap: Number(env.OPS_REDRIVE_CAP ?? 2),
    },
    auth: loadAuthConfig(env),
  };
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  // Exactly "true", same strict convention as WHATSAPP_ALLOW_SEND.
  const enabled = env.MULTI_TENANT === "true";
  return {
    enabled,
    // Secure-by-default exactly when internet-facing; SESSION_COOKIE_SECURE overrides both ways.
    cookieSecure:
      env.SESSION_COOKIE_SECURE !== undefined ? env.SESSION_COOKIE_SECURE === "true" : enabled,
    sessionTtlSeconds: Number(env.SESSION_TTL_DAYS ?? 30) * 24 * 3600,
    emailTokenTtlSeconds: Number(env.EMAIL_TOKEN_TTL_MINUTES ?? 60) * 60,
    tosVersion: env.TOS_VERSION ?? "1",
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:8787",
    operatorEmails: (env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  };
}
