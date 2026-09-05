/**
 * App identity and display metadata (Outpost ★ boundary file).
 * APP_ID is used for the localStorage key, the envelope guard, and the MCP
 * server name; keep it equal to the Worker name in wrangler.jsonc.
 */
export const APP = {
  id: "at-validator",
  name: "Aerobic Threshold Toolkit",
  shortName: "AT Toolkit",
  description: "Validate your aerobic threshold and track Zone 2 run/walk progress from Garmin .fit files.",
  themeColor: "#2a78d6",
  backgroundColor: "#f9f9f7",
  /** Tracker history is ~10 kB per activity; allow a few hundred activities. */
  maxStateBytes: 6 * 1024 * 1024,
} as const;

export const APP_ID: string = APP.id;
export const APP_NAME: string = APP.name;
