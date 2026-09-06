import { config } from "dotenv";
import {
  closeDatabase,
  listMemoriesPendingLocalEmbedding,
  updateMemoryLocalEmbedding
} from "@raiden/database";
import { embedDocument, getBootConfig } from "@raiden/shared/boot";

config({ path: new URL("../.env", import.meta.url) });
config();

function readBatchSize(argv: string[]) {
  const raw = argv.find((argument) => argument.startsWith("--batch-size="))?.split("=", 2)[1];
  const value = raw ? Number(raw) : 25;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("--batch-size must be an integer between 1 and 100");
  }
  return value;
}

async function main() {
  const batchSize = readBatchSize(process.argv.slice(2));
  const bootConfig = getBootConfig();
  let updated = 0;

  while (true) {
    const pending = await listMemoriesPendingLocalEmbedding(batchSize);
    if (pending.length === 0) {
      break;
    }

    for (const memory of pending) {
      const embedding = await embedDocument(memory.summary, bootConfig);
      await updateMemoryLocalEmbedding({
        id: memory.id,
        embedding,
        embeddingModel: bootConfig.BOOT_EMBEDDING_MODEL
      });
      updated += 1;
    }

    console.log(`Backfilled ${updated} local memory embeddings.`);
  }

  console.log(
    `Memory embedding backfill complete: updated=${updated}, model=${bootConfig.BOOT_EMBEDDING_MODEL}, dimensions=${bootConfig.BOOT_EMBEDDING_DIMENSIONS}`
  );
}

try {
  await main();
} finally {
  await closeDatabase();
}
