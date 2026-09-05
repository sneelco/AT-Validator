# Aerobic Threshold Toolkit

**Live app: <https://at-validator.sneelco.workers.dev>** (Cloudflare Workers; see Deployment)

Two tools for aerobic-base training, in one page. Activity files are parsed and
analysed in your browser and are never uploaded. Signing in is optional: it syncs
the tracker's history and settings across devices and opens an MCP endpoint so
Claude can read your trends.

| Tab | What it does |
|---|---|
| **Validator** | The 60-minute heart-rate drift test — is this effort at or below your aerobic threshold? |
| **Tracker** | Zone 2 run/walk progress over many activities — are the walk breaks going away? |

## Validator — the method

Based on the heart-rate drift field test popularized by coach Scott Johnston
(Uphill Athlete): hold a steady effort at your *suspected* aerobic-threshold
heart rate for **60 minutes** and see whether heart rate stays coupled to the
work, or drifts away from it.

**Primary metric — Pa:HR decoupling.** When the file carries *trustworthy*
speed data, the verdict is driven by aerobic decoupling: speed per heartbeat in
the first half of the window vs the second half, as a percent decline. This is
the standard decoupling formulation, and it self-corrects for small pace
changes — slowing down to hold heart rate flat no longer flatters the result.

Whether speed is trustworthy depends on **who wrote the file**, not what sport
it says: the tool reads the FIT file's `file_id`/`device_info` provenance
(manufacturer, product, GPS fixes) and applies a trust matrix. A treadmill file
written by Peloton (or another fitness-equipment maker) carries true
belt/machine speed — trusted, arguably better than GPS. An outdoor file with
GPS fixes is trusted. The same treadmill workout recorded natively on a watch
carries a wrist-accelerometer *estimate* — untrusted, so the verdict falls back
to HR-only drift with the estimated-pace decoupling shown for reference only.
Unknown provenance is untrusted by default, and the verdict says why.
Equipment like Peloton writes cumulative distance rather than per-record speed;
the tool derives speed from the distance channel in that case (it inherits the
belt's trust). A collapsible "File details" section shows the raw device
metadata so unrecognized manufacturer IDs can be reported and added.

Regardless of source, when Pa:HR and HR-only drift disagree by more than 2.5
percentage points a warning surfaces the implied pace change and the verdict
falls back to HR-only: belts are accurate, but a mid-run speed change is still
a protocol violation worth knowing about. Files with no speed at all (e.g. a
bare CSV) use HR-only drift and say so.

**Bands.** The decoupling percentage maps to a three-band verdict:

| Decoupling | Verdict |
|---|---|
| < 3.5% | **Aerobic** (green) — at or below AeT |
| 3.5–6% | **Borderline** (amber) — at the edge; retest slightly slower |
| > 6% | **Above threshold** (red) — started above AeT |

A result within 0.5% of a band edge is flagged so it isn't over-read. The
classic presentation — end-of-window heart-rate rise vs the +5% threshold
line — is still computed and shown, and the chart still draws the threshold
overlay.

**Findings.** Alongside the band, the verdict lists computed findings that
qualify it: second-half slowdown (corrupts the test in the flattering
direction), heart rate still climbing at the window end (a longer window would
read worse), drift concentrated in the final minutes (late-run breakdown), a
plateau-then-break time ("held ~135 until ~50:00" — the durability limit),
short windows, recording-gap coverage, and manual-vs-detected baseline
mismatches. Warnings cap the reported confidence.

## Validator features

- **Garmin `.fit` files parsed natively** — including the `.zip` that Garmin
  Connect's "Export Original" hands you (unzipped in-browser). A simple
  `timestamp,heartrate` CSV works too.
- **Interactive chart** — drag the shaded 60-minute window anywhere in a longer
  activity; the threshold line recomputes from the heart rate at the window
  start as you drag. Drag the window's edges to resize it, or use arrow keys
  (Shift = 5-minute steps).
- **Color-coded heart rate** — blue below the threshold, red above it, gray
  outside the analysis window.
- **Slim pace/speed strip** — a compact panel under the HR chart (only when the
  file has a speed channel) with pace ↔ speed and km ↔ mi
  toggles (the units choice is remembered), up = faster in both modes. Segments deviating more than ±5% from the window's median pace are
  highlighted in amber, with a dotted median guide — so a mid-test pace change
  is visible at a glance without stealing attention from the HR trace.
- **Automatic plateau detection** — the app finds the first "settled" heart-rate
  plateau after your warm-up (robust slope + spread tests on a smoothed series),
  uses it as the default baseline, and suggests the analysis-window start.
  Detection degrades gracefully: interval workouts or unsettled runs fall back
  to the window-start average, labeled accordingly — analysis is never blocked.
- **Refinable baseline** — a vertical slider beside the chart refines the
  baseline to your designated AeT heart rate; the threshold, verdict, stats,
  and splits all follow. If your manual value strays more than 2 bpm from the
  detected plateau, an inline note shows the counterfactual verdict at the
  detected value. Moving or resizing the window resets the baseline to the
  detected plateau ("Reset to auto" does the same), and a **Re-apply detected**
  button in the settings bar restores both the detected window placement and
  baseline after any manual exploring.
- **Layered verdict + stats** — banded verdict (aerobic / borderline / above
  threshold) driven by Pa:HR decoupling with computed findings and a
  next-step suggestion, plus end-of-window rise, average/min/max HR, percent
  of time over/under threshold, and headroom below the threshold.
- **Splits** — 10-minute splits by default, each with average HR, range, rise
  vs. start, time over threshold, and headroom, plus an overall row.
- **Adjustable settings** — window length (60 min), allowed rise (5%), split
  length (10 min), and baseline smoothing (30 s) are all defaults you can change.
- **Suspected AeT** — optionally enter the ceiling you're testing (bpm,
  remembered). The verdict then says what the run can actually claim: a pass
  well below your suspected AeT is flagged as not testing the threshold, a
  baseline at it makes the result a true threshold test, and staying aerobic
  above it is flagged as evidence the ceiling may be conservative. A subtle
  reference line marks it on the chart. Left blank, a green verdict is careful
  to claim only "at or below AeT at this heart rate."
- **Dark mode** — follows your OS preference.
- **Demo data** — a "Try demo data" button loads a synthetic 90-minute run so
  you can explore without a file.

## Tracker — Zone 2 run/walk trends

Zone 2 base building is usually run/walk: you run until heart rate creeps out of
the zone, walk it back down, and repeat. Progress looks like *fewer and shorter
walk breaks over the same distance*, then a faster pace at the same heart rate.
That trend is invisible in any single activity, so the Tracker keeps a history
and measures every run the same way.

**Walk vs run.** Each activity is split into walk and run periods at a speed
threshold — **4 mph by default**, adjustable (shown in mph or km/h to match the
units toggle). The speed channel is smoothed with a rolling median first, and
periods shorter than the **minimum period** (20 s by default) are merged into
their neighbour, so a brief dip at a road crossing is not counted as a walk
break. Stretches with no recording (gaps longer than 30 s) become "recording
gap" periods and are excluded from moving time rather than counted as walking.

**The measured window.** A Zone 2 session usually opens with a warm-up walk and
closes with a cool-down walk; neither is a walk *break*, and leaving them in
would inflate the walk count and drag the pace down. So by default the measured
window **starts at the first run period and ends at the last** — both trimming
rules are individually switchable ("Skip opening walk" / "Drop closing walk"),
and the activity detail says how much was trimmed at each end. Everything below
is measured inside that window.

**What is measured**, for the whole window and for every fixed window that fits:

- number of walk breaks, and walk breaks per mile/km
- average walk-period and run-period duration (plus the longest of each)
- average pace across the window, and running pace over the run periods only
- distance covered, share of time spent running, average heart rate

**Fixed windows.** Metrics are recomputed over the first **30, 45, 60, 75, 90 …
minutes** of the window (15-minute steps). Comparing like with like is the point:
a 50-minute run and an 80-minute run still share a 30- and a 45-minute window, so
their walk counts are comparable. A window only appears for an activity long
enough to fill it (with 30 s of slack, so a 59:40 run still counts as an hour).

**Per-mile segments.** The window is also cut into 1-mile (or 1-km) segments,
each with its split time, pace, walk breaks and walk time — so a fade in the
back half shows up.

**Trends.** Pick a metric (walk breaks, walks per mile, average pace, running
pace, distance, average run/walk period, time spent running, average heart rate)
and up to five windows to plot; each point is one activity in date order, one
line per window, with the same data in the history table below.

**Storage, export, import.** History lives in this browser's `localStorage`. What
is stored is a compact 5-second series (speed, heart rate, cumulative distance —
roughly 10 kB per hour of running), *not* the derived numbers, so changing the
threshold or the trimming rules re-measures the entire history at once instead of
leaving old rows computed under settings you no longer use. **Export JSON** writes
the whole history to a file; **Import JSON** merges one back in. An activity is
identified by its start time and duration, so importing the same file twice
updates the existing rows rather than duplicating them.

**Demo block.** "Add demo block" loads six synthetic weekly sessions with the
progression the tool is meant to reveal — run periods lengthening, walk breaks
fewer and shorter, pace improving — so the trend view is worth looking at before
you have a history of your own. It is deterministic, so adding it twice updates
the same six activities rather than piling up duplicates; remove them with the ✕
on each row.

Uploads accept the same files as the validator (`.fit`, Garmin's "Export
Original" `.zip`, or CSV), several at once, and the tracker needs a pace channel:
a file with heart rate only is refused with that reason. Equipment that records
cumulative distance but no per-record speed (Peloton and friends) works — speed
comes from the distance deltas.

## Using it

Open the [live app](https://at-validator.sneelco.workers.dev), or run it
locally with `pnpm dev` (see Development).

**Getting your file from Garmin Connect:** open the activity → gear icon →
**Export Original**. Drop the downloaded zip (or the `.fit` inside it) onto the
page.

**CSV format:** two columns, `timestamp,heartrate`. The timestamp can be
ISO-8601 (`2026-07-19T06:00:00Z`), Unix epoch seconds/milliseconds, elapsed
seconds, or `h:mm:ss`. A header row is optional.

**Reading the result:** the app places the window at the detected post-warm-up
plateau and uses the plateau's median heart rate as the baseline; drag the
window or the baseline slider to explore alternatives. The verdict compares the
average heart rate of the final 5 minutes of the window against the baseline.
When no plateau is found (e.g. an interval workout), the baseline falls back to
the first 30 seconds of the window, averaged to smooth sensor noise.

## Accounts, sync and MCP

The app is built on [Outpost](https://github.com/sneelco/outpost): a Cloudflare
Worker serves the page, a small API, Better Auth on D1, and a per-user state blob
in KV. What syncs is only the tracker's compact history (about 10 kB per
activity) and its settings. The validator never stores an activity, and its two
device preferences (units, suspected AeT) stay in this browser's localStorage.

- **Without an account** everything works as before; history is saved in this
  browser and can be exported/imported as JSON.
- **Signed in**, the history on this device is uploaded on first sign-in and kept
  in step afterwards. The dot in the header shows the sync state. If two devices
  add runs while offline, the histories are merged by activity identity (same
  start time and duration), so nothing is duplicated or lost. History from the
  standalone version (`atv-tracker-activities-v1`) is picked up automatically.
- **MCP:** account menu → **Account** → **API keys** → **New key**, then point an
  MCP client at `https://<host>/mcp` with `Authorization: Bearer <key>`
  ([docs/MCP.md](docs/MCP.md)). Besides the generic state tools, the toolkit
  exposes `list_activities` and `tracker_metrics` (runs the walk/run analysis
  under your settings and returns per-activity and per-window numbers).

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars     # set BETTER_AUTH_SECRET
pnpm db:migrate:local              # create the local auth tables (once)
pnpm dev                           # http://localhost:5173 (Vite + Worker in workerd)
pnpm test                          # Vitest (schema, sync, Worker API) + node tests/run-tests.js
pnpm typecheck && pnpm lint
pnpm build && pnpm preview
```

The toolkit itself is still plain JavaScript with no dependencies; the Outpost
shell around it is React + TypeScript.

```
src/shared/atv/fit-parser.js         minimal FIT decoder (record messages: timestamp, HR, …)
src/shared/atv/zip.js                in-browser unzip for Garmin "Export Original" zips
src/shared/atv/csv-parser.js         CSV fallback input
src/shared/atv/analysis.js           time-weighted drift analysis, splits, verdict
src/shared/atv/demo.js               synthetic demo activity + demo Zone 2 block
src/shared/atv/tracker-analysis.js   walk/run segmentation, fixed windows, per-mile segments
src/shared/atv/tracker-store.js      history model, compact series, export/import, storage backend
src/shared/state.ts                  Outpost state schema: { activities, settings }, legacy pickup, merge
src/client/features/atv/markup.ts    the page markup (from the old index.html)
src/client/features/atv/atv.css      theme-aware styling (light + dark), scoped to the toolkit
src/client/features/atv/js/chart.js  canvas chart: draggable window, threshold, tooltip
src/client/features/atv/js/app.js    validator UI wiring
src/client/features/atv/js/tabs.js   tab switching (remembered, mirrored in the URL hash)
src/client/features/atv/js/tracker-chart.js  canvas trend chart across activities
src/client/features/atv/js/tracker.js        tracker UI wiring
src/client/features/atv/bridge.ts    routes the tracker's storage through the Outpost store
src/client/features/atv/ATValidatorFeature.tsx  mounts the markup once and boots the modules
src/server/mcp/tools.app.ts          list_activities and tracker_metrics MCP tools
src/client/, src/server/             Outpost shell: store, sync, auth, account page, Worker, MCP
tests/run-tests.js                   the toolkit's Node test suite (parsers, analysis, tracker)
```

Run just the toolkit's suite with `pnpm test:legacy`. The FIT parser's
expectations were cross-checked against the official `garmin-fit-sdk` Python
package; the fixture files (stored base64-encoded to keep the repo text-only)
come from the [python-fitparse](https://github.com/dtcooper/python-fitparse)
test suite.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`: install, typecheck,
lint, test, build, apply D1 migrations, `wrangler deploy`, then check
`/api/health` reports the deployed commit. Pull requests get a preview URL from
`.github/workflows/ci.yml` (previews share the production KV and D1).

First-time setup (create the KV namespace and D1 database, paste their ids into
`wrangler.jsonc`, set the `BETTER_AUTH_*` secrets, add the Cloudflare token and
account id to the repo secrets) is described step by step in the
[Outpost README](https://github.com/sneelco/outpost#first-time-setup). Roll back
with `pnpm exec wrangler rollback` or by reverting the commit.

## Notes & caveats

- Without an account, tracker history is per-browser and clearing site data
  clears it. Export the JSON if you want a copy, or sign in to keep it synced.
- Walk/run splitting is only as good as the speed channel. GPS pace wanders in
  trees and cities; a treadmill file recorded on the wrist carries an
  accelerometer estimate. If the walk count looks wrong, check the activity's
  timeline strip and adjust the threshold or the minimum period.
- Time spent standing still (a road crossing, a drinks stop) counts as walking
  unless the device paused recording, in which case it is a recording gap and
  counts as neither.
- The test assumes steady effort on flat/consistent terrain; hills, wind, heat,
  dehydration, and caffeine all move heart rate independently of threshold.
- Recording gaps are handled (per-sample weight is capped at 30 s), but a
  fragmented recording gives an "insufficient data" verdict rather than a
  possibly-wrong pass/fail.
- This is a training field test, not medical advice.
