import { APP } from "../../shared/app";
import { envelopeSchema, type StateEnvelope } from "../../shared/api-types";
import { parseState, SCHEMA_VERSION, type AppState } from "../../shared/state";

export function buildExportEnvelope(data: AppState, rev: number, updatedAt: string): StateEnvelope<AppState> {
  return { appId: APP.id, schemaVersion: SCHEMA_VERSION, rev, updatedAt, data };
}

/** Accepts an exported envelope or a bare state object. Throws with a readable message. */
export function parseImportFile(text: string): AppState {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const env = envelopeSchema.safeParse(doc);
  if (env.success) {
    if (env.data.appId !== APP.id) throw new Error(`That file is from "${env.data.appId}", not ${APP.name}.`);
    return parseState(env.data.data, env.data.schemaVersion);
  }
  return parseState(doc);
}
