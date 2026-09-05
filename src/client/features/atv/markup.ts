/**
 * The toolkit's markup, verbatim from the original index.html (minus the h1,
 * which the Outpost header now provides). The vanilla modules in ./js find
 * their elements by id, so this must be in the DOM before they run.
 */
export const MARKUP = `
  <header class="masthead">
    <p class="tagline" id="tagline-validator">
      <strong>Validator:</strong> the 60-minute heart-rate drift test — hold a steady effort at your
      suspected aerobic-threshold heart rate; if HR rises more than 5% from where it started,
      the effort was above threshold. Files are analysed in your browser and never uploaded.
    </p>
    <p class="tagline" id="tagline-tracker" hidden>
      <strong>Tracker:</strong> Zone 2 run/walk progress over time — every activity is split into
      walk and run periods at a pace threshold, then measured over fixed windows (30, 45, 60&nbsp;min…)
      so walk counts, pace and distance can be compared run to run. History is saved in this
      browser, synced to your account when you sign in, and can be exported.
    </p>
  </header>

  <nav class="tabs" role="tablist" aria-label="Tools">
    <button type="button" class="tab active" id="tab-btn-validator" role="tab"
      aria-selected="true" aria-controls="panel-validator">Validator</button>
    <button type="button" class="tab" id="tab-btn-tracker" role="tab"
      aria-selected="false" aria-controls="panel-tracker" tabindex="-1">Tracker</button>
  </nav>

  <!-- ============================ VALIDATOR ============================ -->
  <div class="tab-panel" id="panel-validator" role="tabpanel" aria-labelledby="tab-btn-validator">
  <section id="dropzone" class="dropzone" aria-label="Upload activity file">
    <div class="dropzone-inner">
      <p class="dropzone-title">Drop a Garmin <code>.fit</code> or <code>.zip</code> file here, or a
        <code>timestamp,heartrate</code> <code>.csv</code></p>
      <p class="dropzone-sub">Garmin&nbsp;Connect → activity → gear icon → “Export Original” — the downloaded zip works as-is</p>
      <div class="dropzone-actions">
        <label class="btn primary" for="file-input">Choose file<input id="file-input" type="file" accept=".fit,.zip,.csv,.txt,application/octet-stream,application/zip" hidden></label>
        <button class="btn" id="demo-btn" type="button">Try demo data</button>
      </div>
      <p id="load-error" class="load-error" role="alert" hidden></p>
    </div>
  </section>

  <section id="analysis-section" hidden>
    <p id="activity-meta" class="activity-meta"></p>
    <details id="file-details" class="file-details" hidden>
      <summary>File details (raw device metadata)</summary>
      <pre id="file-details-pre"></pre>
    </details>

    <div id="verdict" class="verdict">
      <div class="verdict-title"></div>
      <div class="verdict-body"></div>
    </div>

    <form id="settings-form" class="settings" aria-label="Test settings">
      <div class="setting">
        <label for="set-window">Window</label>
        <div class="setting-input"><input id="set-window" type="number" min="5" max="600" step="5" value="60"><span>min</span></div>
      </div>
      <div class="setting">
        <label for="set-threshold">Allowed rise</label>
        <div class="setting-input"><input id="set-threshold" type="number" min="0.5" max="25" step="0.5" value="5"><span>%</span></div>
      </div>
      <div class="setting">
        <label for="set-split">Splits</label>
        <div class="setting-input"><input id="set-split" type="number" min="1" max="120" step="1" value="10"><span>min</span></div>
      </div>
      <div class="setting">
        <label for="set-smooth">Baseline avg</label>
        <div class="setting-input"><input id="set-smooth" type="number" min="5" max="600" step="5" value="30"><span>s</span></div>
      </div>
      <div class="setting">
        <label for="set-aet" title="The AeT ceiling you're testing — gates what the verdict may claim">Suspected AeT</label>
        <div class="setting-input"><input id="set-aet" type="number" min="60" max="220" step="1" placeholder="&#8212;"><span>bpm</span></div>
      </div>
      <div class="settings-actions">
        <button class="btn subtle" id="apply-detected" type="button" hidden
          title="Move the window back to the detected plateau and restore the detected baseline">
          Re-apply detected</button>
        <button class="btn subtle" id="reset-settings" type="button">Reset defaults</button>
      </div>
    </form>

    <div class="chart-card">
      <div class="chart-hint-row">
        <div class="chart-hint">Drag the shaded window to move it · drag its edges to resize · arrow keys nudge (⇧ = 5&nbsp;min) ·
          vertical slider refines the baseline HR</div>
        <div id="speed-toggle" class="speed-toggle" role="group" aria-label="Pace or speed display" hidden>
          <button type="button" id="mode-pace" class="active" aria-pressed="true">Pace</button>
          <button type="button" id="mode-speed" aria-pressed="false">Speed</button>
        </div>
        <div id="units-toggle" class="speed-toggle" role="group" aria-label="Distance units" hidden>
          <button type="button" id="unit-km" class="active" aria-pressed="true">km</button>
          <button type="button" id="unit-mi" aria-pressed="false">mi</button>
        </div>
      </div>
      <div class="chart-flex">
        <div class="baseline-col" title="Baseline heart rate">
          <input id="baseline-slider" type="range" min="60" max="200" step="1" value="140"
            aria-label="Baseline heart rate in beats per minute">
        </div>
        <div id="chart" class="chart viz-root"></div>
      </div>
      <div id="slider-row" class="slider-row" hidden>
        <input id="window-slider" type="range" min="0" max="0" step="10" value="0" aria-label="Window start position">
        <span id="window-readout" class="window-readout"></span>
      </div>
      <div class="baseline-row">
        <span id="baseline-readout" class="window-readout"></span>
        <button id="baseline-reset" class="btn subtle small" type="button" hidden>Reset to auto</button>
      </div>
      <p id="baseline-warning" class="baseline-warning" role="status" hidden></p>
    </div>

    <h2>Window stats</h2>
    <div id="stats" class="stats"></div>

    <h2>Splits</h2>
    <div class="table-wrap">
      <table id="splits-table" class="splits">
        <thead>
          <tr>
            <th>Split</th><th>Time</th><th class="num">Avg HR</th><th class="num">Range</th>
            <th class="num">Δ vs start</th><th class="num">Time over</th><th class="num">Headroom</th>
          </tr>
        </thead>
        <tbody id="splits-body"></tbody>
      </table>
    </div>
    <p class="footnote">* partial split (window not evenly divisible) · Δ vs start compares the split’s average
      heart rate to the window’s starting (baseline) heart rate · headroom is how far the split average sits
      below the threshold, as a percent of threshold.</p>
  </section>
  </div>

  <!-- ============================= TRACKER ============================= -->
  <div class="tab-panel" id="panel-tracker" role="tabpanel" aria-labelledby="tab-btn-tracker" hidden>
    <section id="tracker-dropzone" class="dropzone" aria-label="Add activities to the tracker">
      <div class="dropzone-inner">
        <p class="dropzone-title">Drop one or more Garmin <code>.fit</code> or <code>.zip</code> files here</p>
        <p class="dropzone-sub">Each activity is split into walk and run periods and added to your history —
          saved in this browser (and to your account when signed in), exportable as JSON</p>
        <div class="dropzone-actions">
          <label class="btn primary" for="trk-file-input">Add activities<input id="trk-file-input" type="file" multiple accept=".fit,.zip,.csv,.txt,application/octet-stream,application/zip" hidden></label>
          <button class="btn" id="trk-demo-btn" type="button">Add demo block</button>
        </div>
        <p id="trk-status" class="tracker-status" role="status" hidden></p>
      </div>
    </section>

    <form id="trk-settings" class="settings" aria-label="Tracker settings">
      <div class="setting">
        <label for="trk-threshold" title="Speed at or above this counts as running; below it counts as walking">Walk / run threshold</label>
        <div class="setting-input">
          <input id="trk-threshold" type="number" min="0.5" max="20" step="0.1" value="4">
          <span id="trk-threshold-unit">mph</span>
        </div>
      </div>
      <div class="setting">
        <label for="trk-min-seg" title="Periods shorter than this merge into their neighbour, so a brief dip is not counted as a walk break">Min period</label>
        <div class="setting-input"><input id="trk-min-seg" type="number" min="5" max="300" step="5" value="20"><span>s</span></div>
      </div>
      <div class="setting">
        <label>Window</label>
        <div class="setting-checks">
          <label class="check"><input id="trk-trim-lead" type="checkbox" checked> Skip opening walk</label>
          <label class="check"><input id="trk-trim-tail" type="checkbox" checked> Drop closing walk</label>
        </div>
      </div>
      <div class="setting">
        <label>Units</label>
        <div class="speed-toggle" role="group" aria-label="Distance units">
          <button type="button" id="trk-unit-mi" class="active" aria-pressed="true">mi</button>
          <button type="button" id="trk-unit-km" aria-pressed="false">km</button>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn subtle" id="trk-reset" type="button">Reset defaults</button>
      </div>
    </form>

    <h2>Trends</h2>
    <div class="chart-card">
      <div class="chart-hint-row">
        <div class="chart-hint" id="trk-trend-hint">Each point is one activity, in date order; one line per
          fixed window measured from the start of the run.</div>
        <div class="setting compact">
          <label for="trk-metric">Metric</label>
          <select id="trk-metric" class="select">
            <option value="walks">Walk breaks</option>
            <option value="walksPerDist">Walk breaks per mile</option>
            <option value="pace">Average pace</option>
            <option value="runPace">Running pace (run periods only)</option>
            <option value="distance">Distance</option>
            <option value="avgRun">Average run period</option>
            <option value="avgWalk">Average walk period</option>
            <option value="runPct">Time spent running</option>
            <option value="avgHr">Average heart rate</option>
          </select>
        </div>
      </div>
      <div class="bucket-picker" id="trk-buckets" role="group" aria-label="Windows to plot"></div>
      <div class="trend-chart-flex">
        <div id="trk-chart" class="chart viz-root"></div>
      </div>
      <div class="chart-legend" id="trk-legend"></div>
      <p class="footnote" id="trk-trend-note"></p>
    </div>

    <h2>History <span class="count" id="trk-count"></span></h2>
    <div class="history-actions">
      <button class="btn subtle small" id="trk-export" type="button">Export JSON</button>
      <label class="btn subtle small" for="trk-import-input">Import JSON<input id="trk-import-input" type="file" accept=".json,application/json" hidden></label>
      <button class="btn subtle small" id="trk-clear" type="button">Clear history</button>
    </div>
    <div class="table-wrap">
      <table class="splits" id="trk-history">
        <thead>
          <tr>
            <th>Date</th><th>Activity</th><th class="num">Window</th><th class="num">Distance</th>
            <th class="num">Avg pace</th><th class="num">Walks</th><th class="num">Walks/<span class="unit-word">mi</span></th>
            <th class="num">Avg run</th><th class="num">Avg walk</th><th class="num">Avg HR</th><th></th>
          </tr>
        </thead>
        <tbody id="trk-history-body"></tbody>
      </table>
    </div>
    <p class="footnote">Click a row to see that activity's walk/run timeline, fixed-window table and
      per-<span class="unit-word-long">mile</span> segments. The window is the measured portion of the activity
      after the opening and closing walks are trimmed.</p>

    <section id="trk-detail" hidden>
      <h2 id="trk-detail-title">Activity detail</h2>
      <p class="activity-meta" id="trk-detail-meta"></p>
      <div class="timeline-wrap">
        <div class="timeline" id="trk-timeline" aria-label="Walk and run periods across the activity"></div>
        <div class="timeline-key">
          <span class="tl-key run"></span> run
          <span class="tl-key walk"></span> walk
          <span class="tl-key pause"></span> recording gap
          <span class="tl-key trimmed"></span> outside the measured window
        </div>
      </div>
      <div id="trk-detail-stats" class="stats"></div>

      <h3>Fixed windows</h3>
      <div class="table-wrap">
        <table class="splits" id="trk-buckets-table">
          <thead>
            <tr>
              <th>Window</th><th class="num">Distance</th><th class="num">Avg pace</th>
              <th class="num">Walks</th><th class="num">Walks/<span class="unit-word">mi</span></th>
              <th class="num">Avg run</th><th class="num">Avg walk</th><th class="num">Run time</th>
              <th class="num">Avg HR</th>
            </tr>
          </thead>
          <tbody id="trk-buckets-body"></tbody>
        </table>
      </div>

      <h3>Per-<span class="unit-word-long">mile</span> segments</h3>
      <div class="table-wrap">
        <table class="splits" id="trk-splits-table">
          <thead>
            <tr>
              <th><span class="unit-word-cap">Mile</span></th><th class="num">Elapsed</th><th class="num">Split time</th>
              <th class="num">Pace</th><th class="num">Walks</th><th class="num">Walk time</th><th class="num">Avg HR</th>
            </tr>
          </thead>
          <tbody id="trk-splits-body"></tbody>
        </table>
      </div>
      <p class="footnote">* partial segment. Walks counted in a segment are the walk periods that begin
        inside it.</p>
    </section>
  </div>

  <footer class="footer">
    <p>Method after Scott Johnston (Uphill Athlete) — a field test, not medical advice.
      Activity files are processed locally and never uploaded; only the compact tracker history syncs when you sign in.</p>
  </footer>
`;
