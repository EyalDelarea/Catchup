import { describe, expect, it } from "vitest";
import { OllamaEmbedder } from "./embedder.js";

describe("OllamaEmbedder", () => {
  const okResponse = (embeddings: number[][]) =>
    Promise.resolve(new Response(JSON.stringify({ embeddings }), { status: 200 }));

  it("returns one vector per input, in order", async () => {
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 3,
      fetchImpl: () =>
        okResponse([
          [1, 0, 0],
          [0, 1, 0],
        ]),
    });
    const out = await embedder.embed(["a", "b"]);
    expect(out).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("short-circuits empty input without calling the model", async () => {
    let called = false;
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 3,
      fetchImpl: () => {
        called = true;
        return okResponse([]);
      },
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("sends model + input array to /api/embed", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434/",
      model: "bge-m3",
      dimension: 2,
      fetchImpl: (url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body);
        return okResponse([[1, 2]]);
      },
    });
    await embedder.embed(["hi"]);
    expect(seenUrl).toBe("http://localhost:11434/api/embed"); // trailing slash trimmed
    expect(seenBody).toEqual({ model: "bge-m3", input: ["hi"] });
  });

  it("throws when the returned dimension does not match config", async () => {
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 1024,
      fetchImpl: () => okResponse([[1, 2, 3]]),
    });
    await expect(embedder.embed(["x"])).rejects.toThrow(/dim 3, expected 1024/);
  });

  it("throws when the vector count does not match the input count", async () => {
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 2,
      fetchImpl: () => okResponse([[1, 2]]),
    });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("wraps transport failures with a reachability hint", async () => {
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 2,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(embedder.embed(["a"])).rejects.toThrow(/not reachable.*ollama serve/s);
  });

  it("throws on a non-2xx HTTP status", async () => {
    const embedder = new OllamaEmbedder({
      host: "http://localhost:11434",
      model: "bge-m3",
      dimension: 2,
      fetchImpl: () => Promise.resolve(new Response("nope", { status: 500 })),
    });
    await expect(embedder.embed(["a"])).rejects.toThrow(/HTTP 500/);
  });
});
