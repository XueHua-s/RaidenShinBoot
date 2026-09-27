import { config } from "dotenv";
import { createHash } from "node:crypto";
import { closeDatabase, getSqlClient } from "@raiden/database";
import { getEffectiveBootConfig } from "@raiden/boot";
import { embedDocument } from "@raiden/shared/boot";

config({ path: new URL("../.env", import.meta.url) });
config();

type Memory = { id: string; summary: string; embedding_model: string | null; embedding_dimensions: number | null; has_embedding: boolean };

async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Stop memory writers and back up PostgreSQL, then pass --apply.");
  const bootConfig = await getEffectiveBootConfig();
  const sql = getSqlClient();
  const snapshot = await sql<Memory[]>`select id, summary, embedding_model, embedding_dimensions, embedding_local is not null as has_embedding from memories where deleted_at is null order by id`;
  const pending = snapshot.filter(row => !row.has_embedding || row.embedding_model !== bootConfig.BOOT_EMBEDDING_MODEL || row.embedding_dimensions !== bootConfig.BOOT_EMBEDDING_DIMENSIONS);
  if (!pending.length) { console.log("All active memory embeddings already match the target model."); return; }
  const replacements = [];
  for (const row of pending) {
    replacements.push({ ...row, vector: await embedDocument(row.summary, bootConfig) });
    console.log(`Prepared ${replacements.length}/${pending.length} replacement vectors.`);
  }
  // FIXED: Never publish a partially migrated vector space, even on provider failure.
  await sql.begin(async transaction => {
    await transaction`lock table memories in share row exclusive mode`;
    const current = await transaction<Memory[]>`select id, summary, embedding_model, embedding_dimensions, embedding_local is not null as has_embedding from memories where deleted_at is null order by id`;
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error("Memories changed during migration; no vectors were updated. Stop writers and retry.");
    for (const row of replacements) {
      await transaction`update memories set embedding_local = ${JSON.stringify(row.vector)}::halfvec,
        embedding_model = ${bootConfig.BOOT_EMBEDDING_MODEL}, embedding_dimensions = ${bootConfig.BOOT_EMBEDDING_DIMENSIONS},
        embedding_revision = null, embedding_normalized = true, embedding_status = 'ready', embedded_at = now(),
        content_hash = ${createHash("sha256").update(row.summary).digest("hex")} where id = ${row.id}`;
    }
  });
  console.log(`Migrated ${replacements.length} memories atomically; model=${bootConfig.BOOT_EMBEDDING_MODEL}; dimensions=${bootConfig.BOOT_EMBEDDING_DIMENSIONS}.`);
}
try { await main(); } finally { await closeDatabase(); }
