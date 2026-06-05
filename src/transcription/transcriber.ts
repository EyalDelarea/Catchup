export type TranscriptionResult = {
  text: string;
};

/**
 * A transcription engine. Lifecycle: open() once, transcribe() per file
 * (sequentially), close() at the end. transcribe() throws on per-file failure;
 * the caller records the failure and continues (FR-013).
 */
export interface Transcriber {
  open(): Promise<void>;
  /** Transcribe a single 16 kHz mono WAV file to Hebrew text. */
  transcribe(wavPath: string): Promise<TranscriptionResult>;
  close(): Promise<void>;
}

/** ffmpeg args to convert any audio file to a 16 kHz mono WAV (overwrites output). */
export function buildFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return ["-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", outputPath];
}
