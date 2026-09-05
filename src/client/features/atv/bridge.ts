import { useAppState, setAppData } from "../../store/useAppState";
import type { AtvActivity } from "../../../shared/atv/globals";
import { settingsSchema } from "../../../shared/state";

/**
 * Connects the vanilla tracker (which talks to `ATV.trackerStore`) to the
 * Outpost store: the tracker's saves become store updates (→ localStorage →
 * sync), and store updates that did not originate here (a pull from another
 * device, an MCP write, an import on the account page) make the tracker
 * re-read and re-render.
 */
let installed = false;
let applying = false;

export function installBridge() {
  if (installed) return;
  installed = true;

  globalThis.ATV.trackerStore.setBackend({
    loadActivities: () => useAppState.getState().data.activities,
    saveActivities: (list: AtvActivity[]) => {
      applying = true;
      try {
        setAppData((d) => ({ ...d, activities: list }));
      } finally {
        applying = false;
      }
    },
    loadSettings: () => useAppState.getState().data.settings,
    saveSettings: (settings) => {
      applying = true;
      try {
        setAppData((d) => ({ ...d, settings: settingsSchema.parse({ ...d.settings, ...settings }) }));
      } finally {
        applying = false;
      }
    },
  });

  useAppState.subscribe((s, prev) => {
    if (applying) return;
    if (s.data.activities !== prev.data.activities || s.data.settings !== prev.data.settings) {
      globalThis.ATV.tracker?.reload();
    }
  });
}
