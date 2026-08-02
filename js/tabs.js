/*
 * Tab switching between the two tools. The choice is remembered and mirrored
 * in the URL hash, so a bookmark or reload lands on the same tool.
 */
(function () {
  'use strict';

  var KEY = 'atv-active-tab';
  var TABS = [
    { id: 'validator', btn: 'tab-btn-validator', panel: 'panel-validator', tagline: 'tagline-validator' },
    { id: 'tracker', btn: 'tab-btn-tracker', panel: 'panel-tracker', tagline: 'tagline-tracker' }
  ];

  function el(id) { return document.getElementById(id); }

  function select(id, focus) {
    var found = TABS.some(function (t) { return t.id === id; });
    if (!found) id = TABS[0].id;
    TABS.forEach(function (t) {
      var active = t.id === id;
      var btn = el(t.btn);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
      el(t.panel).hidden = !active;
      el(t.tagline).hidden = !active;
      if (active && focus) btn.focus();
    });
    try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ }
    if (location.hash.replace('#', '') !== id) {
      history.replaceState(null, '', '#' + id);
    }
    // Panels are display:none while hidden, so anything that measures itself
    // (canvas charts) needs a nudge once it is on screen again.
    document.dispatchEvent(new CustomEvent('atv:tabshown', { detail: { id: id } }));
  }

  TABS.forEach(function (t, i) {
    el(t.btn).addEventListener('click', function () { select(t.id, false); });
    el(t.btn).addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      select(TABS[next].id, true);
    });
  });

  var initial = location.hash.replace('#', '');
  if (!initial) {
    try { initial = localStorage.getItem(KEY) || ''; } catch (e) { initial = ''; }
  }
  select(initial || TABS[0].id, false);

  window.addEventListener('hashchange', function () {
    select(location.hash.replace('#', ''), false);
  });
})();
