import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

let cachedDatabase: Database | undefined;
let cachedSql: postgres.Sql | undefined;

function createSqlClient(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 10,
    prepare: false
  });
}

export function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = createSqlClient(databaseUrl);
  return drizzle(client, { schema });
}

export function getDatabase() {
  if (!cachedDatabase) {
    cachedDatabase = drizzle(getSqlClient(), { schema });
  }

  return cachedDatabase;
}

export function getSqlClient(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  cachedSql ??= createSqlClient(databaseUrl);

  return cachedSql;
}

export async function closeDatabase() {
  await cachedSql?.end({ timeout: 5 });
  cachedSql = undefined;
  cachedDatabase = undefined;
}
