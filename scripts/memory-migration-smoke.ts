import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeDatabase, getSqlClient } from "@raiden/database";

// Run only against a dedicated scratch database, never the production memory store.
if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_embedding_test')) {
  throw new Error('DATABASE_URL must point to a dedicated *_embedding_test database');
}
const sql = getSqlClient();
let calls = 0;
let fail = true;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { dimensions: number };
  assert.equal(body.dimensions, 512);
  calls++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [{ index: 0, embedding: fail && calls === 2 ? [1] : Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0) }] }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
async function migrate(script = "db:reembed-memories", args = ["--", "--apply"]) {
  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn('pnpm', [script, ...args], { env: { ...process.env, BOOT_EMBEDDING_BASE_URL: `http://127.0.0.1:${port}/v1`, BOOT_EMBEDDING_API_KEY: 'test-only', BOOT_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash' }, stdio: 'pipe' });
    child.stdout.resume(); child.stderr.resume(); child.once('error', reject); child.once('exit', resolve);
  });
}
try {
  await sql`insert into telegram_users (telegram_id) values ('embedding-migration-test')`;
  const original = JSON.stringify(Array.from({ length: 512 }, (_, i) => i === 1 ? 1 : 0));
  for (const summary of ['first memory', 'second memory']) {
    await sql`insert into memories (telegram_user_id, summary, embedding_local, embedding_model, embedding_dimensions) values ('embedding-migration-test', ${summary}, ${original}::halfvec, 'old-model', 512)`;
  }
  assert.notEqual(await migrate("db:backfill-embeddings", []), 0);
  assert.equal(calls, 0, "Backfill refuses a mixed model before making requests");
  assert.notEqual(await migrate(), 0);
  const failed = await sql`select embedding_model, embedding_local::text as vector from memories`;
  assert.equal(failed.length, 2);
  assert(failed.every(row => row.embedding_model === 'old-model' && row.vector === original));
  fail = false;
  assert.equal(await migrate(), 0);
  const migrated = await sql`select embedding_model, embedding_dimensions, vector_dims(embedding_local) as dimensions from memories`;
  assert(migrated.every(row => row.embedding_model === 'qwen3.7-text-embedding-flash' && row.embedding_dimensions === 512 && row.dimensions === 512));
  const previousCalls = calls;
  assert.equal(await migrate(), 0);
  assert.equal(calls, previousCalls);
  console.log('Memory migration smoke passed: failed batch leaves all vectors unchanged, success migrates all, rerun makes no API calls.');
} finally {
  server.close(); await closeDatabase();
}
