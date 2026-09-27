import assert from "node:assert/strict";
import { embedDocument, embedQuery, getBootConfig } from "@raiden/shared/boot";

const config = getBootConfig({ BOOT_EMBEDDING_API_KEY: "embedding-test-key" });
assert.equal(config.BOOT_EMBEDDING_MODEL, "qwen3.7-text-embedding-flash");
assert.equal(config.BOOT_EMBEDDING_QUERY_PREFIX, "");
const originalFetch = globalThis.fetch;
let vector: number[] = Array.from({ length: 512 }, (_, index) => index === 0 ? 3 : index === 1 ? 4 : 0);
const inputs: unknown[] = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { model: string; dimensions: number; input: unknown };
  assert.equal(body.model, config.BOOT_EMBEDDING_MODEL);
  assert.equal(body.dimensions, 512);
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer embedding-test-key");
  inputs.push(body.input);
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { "content-type": "application/json" } });
};
try {
  assert.equal((await embedDocument("memory document", config))[0], 0.6);
  assert.equal((await embedQuery("memory query", config))[1], 0.8);
  assert.deepEqual(inputs, [["memory document"], ["memory query"]]);
  vector = [1];
  await assert.rejects(embedDocument("bad dimensions", config), /512 dimensions/);
  vector = Array(512).fill(0) as number[];
  await assert.rejects(embedDocument("zero vector", config), /invalid or zero/);
  await assert.rejects(embedDocument("missing key", { ...config, BOOT_EMBEDDING_API_KEY: undefined }), /API_KEY/);
  console.log("Embedding smoke passed: remote request, dimensions, query prefix, normalization and invalid responses.");
} finally { globalThis.fetch = originalFetch; }
