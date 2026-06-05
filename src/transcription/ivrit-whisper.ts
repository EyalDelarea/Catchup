import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildFfmpegArgs,
  type Transcriber,
  type TranscriptionResult,
} from "./transcriber.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKER_SCRIPT = path.resolve(__dirname, "worker.py");

export type IvritWhisperOptions = {
  pythonPath: string;
  model: string;
  ffmpegPath: string;
  /** Override the worker script path (used in tests). Defaults to worker.py. */
  workerScript?: string;
};

type WorkerMessage = {
  ready?: boolean;
  fatal?: string;
  text?: string;
  error?: string;
};

export class IvritWhisperTranscriber implements Transcriber {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private readonly workerScript: string;

  constructor(private readonly opts: IvritWhisperOptions) {
    this.workerScript = opts.workerScript ?? DEFAULT_WORKER_SCRIPT;
  }

  async open(): Promise<void> {
    const proc = spawn(this.opts.pythonPath, [this.workerScript, this.opts.model], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc = proc;
    if (!proc.stdout) throw new Error("worker has no stdout");
    this.rl = createInterface({ input: proc.stdout });
    const rl = this.rl;

    await new Promise<void>((resolve, reject) => {
      const onLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: WorkerMessage;
        try {
          msg = JSON.parse(trimmed) as WorkerMessage;
        } catch {
          return; // ignore non-JSON noise before ready
        }
        if (msg.ready) {
          rl.off("line", onLine);
          resolve();
        } else if (msg.fatal) {
          rl.off("line", onLine);
          reject(new Error(msg.fatal));
        }
      };
      rl.on("line", onLine);
      proc.once("error", reject);
      proc.once("exit", (code) =>
        reject(new Error(`transcription worker exited before ready (code ${code})`))
      );
    });
  }

  async transcribe(wavPath: string): Promise<TranscriptionResult> {
    const proc = this.proc;
    const rl = this.rl;
    if (!proc || !rl || !proc.stdin) {
      throw new Error("Transcriber.transcribe called before open()");
    }

    return new Promise<TranscriptionResult>((resolve, reject) => {
      const onLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        rl.off("line", onLine);
        let msg: WorkerMessage;
        try {
          msg = JSON.parse(trimmed) as WorkerMessage;
        } catch {
          reject(new Error(`bad worker output: ${trimmed}`));
          return;
        }
        if (typeof msg.text === "string") {
          resolve({ text: msg.text });
        } else if (msg.error) {
          reject(new Error(msg.error));
        } else {
          reject(new Error(`unexpected worker output: ${trimmed}`));
        }
      };
      rl.on("line", onLine);
      proc.stdin!.write(JSON.stringify({ wavPath }) + "\n");
    });
  }

  async close(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

/**
 * Convert an audio file to a fresh temp 16 kHz mono WAV. Returns the temp path;
 * the caller is responsible for deleting it.
 */
export async function convertToWav(
  ffmpegPath: string,
  inputPath: string
): Promise<string> {
  const outPath = path.join(os.tmpdir(), `wsum-${crypto.randomUUID()}.wav`);
  await execFileAsync(ffmpegPath, buildFfmpegArgs(inputPath, outPath));
  return outPath;
}
