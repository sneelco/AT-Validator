/**
 * ★ APP BOUNDARY ★ — the Aerobic Threshold Toolkit.
 *
 * The toolkit is vanilla JS that finds its elements by id and binds listeners
 * once at load. Rather than rewrite it in React, the markup is mounted into a
 * DOM subtree that is created once and re-attached whenever this route is
 * shown, so the modules keep their state and listeners across navigation
 * (e.g. to /account and back).
 */
import { useEffect, useRef } from "react";
import { MARKUP } from "./markup";
import { installBridge } from "./bridge";
import "./atv.css";

let host: HTMLDivElement | null = null;
let booted: Promise<void> | null = null;

// The toolkit modules are classic scripts (no exports), loaded for their side
// effects after the markup exists. Order matters: each reads the ATV.*
// namespaces the previous ones attach at evaluation time (same order as the
// original index.html's script tags).
const modules = { ...import.meta.glob("../../../shared/atv/*.js"), ...import.meta.glob("./js/*.js") };
const ORDER = [
  "../../../shared/atv/fit-parser.js",
  "../../../shared/atv/zip.js",
  "../../../shared/atv/csv-parser.js",
  "../../../shared/atv/analysis.js",
  "./js/chart.js",
  "../../../shared/atv/demo.js",
  "./js/app.js",
  "../../../shared/atv/tracker-analysis.js",
  "../../../shared/atv/tracker-store.js",
  "./js/tracker-chart.js",
  "./js/tracker.js",
  "./js/tabs.js",
];

async function boot() {
  installBridge();
  for (const path of ORDER) {
    const load = modules[path];
    if (!load) throw new Error(`Missing toolkit module ${path}`);
    await load();
  }
}

export function ATValidatorFeature() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    if (!host) {
      host = document.createElement("div");
      host.className = "page";
      host.innerHTML = MARKUP;
      mount.appendChild(host);
      booted ??= boot();
    } else {
      mount.appendChild(host);
      // Canvases re-measure themselves via ResizeObserver; nudge the visible tab too.
      document.dispatchEvent(new CustomEvent("atv:tabshown", { detail: { id: location.hash.replace("#", "") || "validator" } }));
    }
    return () => {
      host?.remove();
    };
  }, []);

  return <div ref={ref} className="atv" />;
}
