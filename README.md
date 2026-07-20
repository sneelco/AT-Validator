# Aerobic Threshold Validator

**Live app: <https://sneelco.github.io/AT-Validator/>**

Validate your aerobic threshold (AeT) from a Garmin activity file — entirely in
your browser. No backend, no build step, no data ever leaves your machine.

## The method

Based on the heart-rate drift field test popularized by coach Scott Johnston
(Uphill Athlete): hold a steady effort at your *suspected* aerobic-threshold
heart rate for **60 minutes**. If heart rate rises **more than 5%** from where
it started, the effort was above your aerobic threshold; if it stays within 5%,
you were at or below it.

This tool graphs your heart rate, overlays the +5% threshold line computed from
the heart rate at the start of an adjustable 60-minute window, and gives you a
verdict plus supporting statistics and splits.

## Features

- **Garmin `.fit` files parsed natively** — including the `.zip` that Garmin
  Connect's "Export Original" hands you (unzipped in-browser). A simple
  `timestamp,heartrate` CSV works too.
- **Interactive chart** — drag the shaded 60-minute window anywhere in a longer
  activity; the threshold line recomputes from the heart rate at the window
  start as you drag. Drag the window's edges to resize it, or use arrow keys
  (Shift = 5-minute steps).
- **Color-coded heart rate** — blue below the threshold, red above it, gray
  outside the analysis window.
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
- **Verdict + stats** — end-of-window rise vs. start, average/min/max HR,
  percent of time over/under threshold, headroom below the threshold, and
  first-half vs. second-half HR drift.
- **Splits** — 10-minute splits by default, each with average HR, range, rise
  vs. start, time over threshold, and headroom, plus an overall row.
- **Adjustable settings** — window length (60 min), allowed rise (5%), split
  length (10 min), and baseline smoothing (30 s) are all defaults you can change.
- **Dark mode** — follows your OS preference.
- **Demo data** — a "Try demo data" button loads a synthetic 90-minute run so
  you can explore without a file.

## Using it

Open the [hosted page](https://sneelco.github.io/AT-Validator/), or just open
`index.html` locally in any modern browser — there is nothing to install or
build.

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

## Hosting on GitHub Pages

The site is hosted at <https://sneelco.github.io/AT-Validator/>. The included
workflow (`.github/workflows/deploy-pages.yml`) runs the tests and redeploys it
automatically on every push to `main` — no branches to manage and no build
configuration.

If you fork this repo, turn Pages on once: **Settings** → **Pages** → under
**Build and deployment → Source**, choose **GitHub Actions**. Your copy then
deploys to `https://<your-username>.github.io/AT-Validator/`.

## Development

Plain HTML/CSS/JS, no dependencies.

```
index.html          page shell
css/style.css       theme-aware styling (light + dark)
js/fit-parser.js    minimal FIT decoder (record messages: timestamp, HR, …)
js/zip.js           in-browser unzip for Garmin "Export Original" zips
js/csv-parser.js    CSV fallback input
js/analysis.js      time-weighted drift analysis, splits, verdict
js/chart.js         canvas chart: draggable window, threshold, tooltip
js/app.js           UI wiring
js/demo.js          synthetic demo activity
tests/run-tests.js  Node test suite
```

Run the tests with:

```sh
node tests/run-tests.js
```

The FIT parser's expectations in the test suite were cross-checked against the
official `garmin-fit-sdk` Python package; the fixture files (stored base64-encoded
to keep the repo text-only) come from the
[python-fitparse](https://github.com/dtcooper/python-fitparse) test suite.

## Notes & caveats

- The test assumes steady effort on flat/consistent terrain; hills, wind, heat,
  dehydration, and caffeine all move heart rate independently of threshold.
- Recording gaps are handled (per-sample weight is capped at 30 s), but a
  fragmented recording gives an "insufficient data" verdict rather than a
  possibly-wrong pass/fail.
- This is a training field test, not medical advice.
