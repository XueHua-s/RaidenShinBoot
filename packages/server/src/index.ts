import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { getServerEnv } from "./env.js";
import { app } from "./app.js";

config({ path: new URL("../../../.env", import.meta.url) });
config();

const env = getServerEnv();

serve(
  {
    fetch: app.fetch,
    hostname: env.SERVER_HOST,
    port: env.SERVER_PORT
  },
  (info) => {
    console.log(`RaidenShinBoot API listening on http://${info.address}:${info.port}`);
  }
);
