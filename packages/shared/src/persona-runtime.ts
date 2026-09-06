import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePersona, parsePersonaDsl, raidenRuntimePolicyPrompt } from "./persona.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type PersonaSnapshot = {
  id: string;
  version: number;
  hash: string;
  sourcePath: string;
  characterPrompt: string;
  systemPrompt: string;
};

let cachedSnapshot: (PersonaSnapshot & { modifiedAtMs: number }) | null = null;
let lastFailedReload: string | null = null;

export function getRaidenMakotoPersona(env: NodeJS.ProcessEnv = process.env): PersonaSnapshot {
  const configuredPath = env.RAIDEN_PERSONA_PATH?.trim();
  const sourcePath = configuredPath
    ? resolve(workspaceRoot, configuredPath)
    : fileURLToPath(new URL("../../../personas/raiden-makoto.persona", import.meta.url));
  if (!existsSync(sourcePath)) {
    if (cachedSnapshot?.sourcePath === sourcePath) {
      warnOnceForFailedReload(sourcePath, "missing", "file does not exist");
      return cachedSnapshot;
    }
    throw new Error(`Persona file does not exist: ${sourcePath}`);
  }

  let modifiedAtMs: number | null = null;
  try {
    modifiedAtMs = statSync(sourcePath).mtimeMs;
    if (cachedSnapshot?.sourcePath === sourcePath && cachedSnapshot.modifiedAtMs === modifiedAtMs) {
      return cachedSnapshot;
    }
    const source = readFileSync(sourcePath, "utf8");
    const document = parsePersonaDsl(source);
    const characterPrompt = compilePersona(document);
    const hash = createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex");
    const snapshot = {
      id: document.id,
      version: document.version,
      hash,
      sourcePath,
      characterPrompt,
      systemPrompt: `${raidenRuntimePolicyPrompt}\n\n${characterPrompt}`,
      modifiedAtMs
    };
    cachedSnapshot = snapshot;
    lastFailedReload = null;
    return snapshot;
  } catch (error) {
    if (cachedSnapshot?.sourcePath === sourcePath) {
      warnOnceForFailedReload(
        sourcePath,
        String(modifiedAtMs ?? "unreadable"),
        (error instanceof Error ? error.message : "unknown reload error").replace(/\s+/g, " ").slice(0, 500)
      );
      return cachedSnapshot;
    }
    throw error;
  }
}

export function clearPersonaSnapshotCache() {
  cachedSnapshot = null;
  lastFailedReload = null;
}

function warnOnceForFailedReload(sourcePath: string, version: string, message: string) {
  const failureKey = `${sourcePath}:${version}:${message}`;
  if (failureKey === lastFailedReload) {
    return;
  }
  lastFailedReload = failureKey;
  console.warn(`Persona reload failed; keeping the last valid snapshot: ${message}`);
}
