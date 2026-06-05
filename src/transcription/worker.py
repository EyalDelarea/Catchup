#!/usr/bin/env python3
"""Long-lived faster-whisper worker for Hebrew transcription.

Protocol (NDJSON over stdin/stdout, UTF-8):
  - On startup, emits one of:
      {"ready": true}                  once the model is loaded
      {"fatal": "<message>"}           if the model fails to load
  - Then, for each line read from stdin (a JSON object {"wavPath": "..."}),
    emits exactly one line:
      {"text": "<transcript>"}         on success
      {"error": "<message>"}           on a per-file failure

The model name is argv[1]. Language is pinned to Hebrew.
"""
import json
import sys


def main() -> int:
    model_name = (
        sys.argv[1] if len(sys.argv) > 1 else "ivrit-ai/whisper-large-v3-turbo-ct2"
    )

    try:
        from faster_whisper import WhisperModel

        # CPU + int8 is the portable default (CTranslate2 has no Metal GPU path).
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001
        sys.stdout.write(json.dumps({"fatal": f"model load failed: {exc}"}) + "\n")
        sys.stdout.flush()
        return 1

    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            wav_path = request["wavPath"]
            segments, _info = model.transcribe(wav_path, language="he")
            text = "".join(segment.text for segment in segments).strip()
            sys.stdout.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            sys.stdout.write(json.dumps({"error": str(exc)}, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
