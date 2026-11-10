/*
 * Nini Daily — native notification bridge (Capacitor LocalNotifications).
 *
 * v3 (Build 9): firing fixes, diagnosed from the @capacitor/local-notifications
 * 8.3.1 plugin source after Builds 6/8 tests did not fire:
 *  1. Daily/weekly mains now use schedule.on ({hour, minute[, weekday]}) — a
 *     true repeating UNCalendarNotificationTrigger. The old at+every form
 *     degrades to a ONE-SHOT interval trigger in this plugin version (the at
 *     branch wins and repeats defaults to false), so "daily" reminders armed
 *     exactly one firing per sync and then went dead.
 *  2. interruptionLevel uses the exact plugin value 'timeSensitive' (the
 *     kebab-case 'time-sensitive' is silently ignored by the plugin, which
 *     left Build 8's alerts as plain active notifications that Sleep Focus
 *     could swallow without a trace).
 *  3. Sync order flipped: schedule the new set FIRST, then cancel only the
 *     stale ids. The old cancel-first order could leave nothing armed if iOS
 *     suspended the webview mid-sync (edit a reminder, lock the phone — the
 *     cancel landed, the schedule never ran).
 *
 * Design (unchanged from v2):
 *  - Every reminder occurrence gets a main alert plus follow-up nudges at
 *    +15 and +45 minutes. Nudges are one-shot `at` notifications armed for
 *    the next occurrence (or for a live occurrence when the app opens
 *    inside its window).
 *  - Notifications carry Done / "Remind me later" actions. Done writes to a
 *    completions log (nini_completions_v1) which sync reads back to cancel
 *    that occurrence's remaining nudges. "Remind me later" schedules a
 *    single check-back nudge 30 minutes out.
 *  - The in-app Done button uses the same completions log via
 *    window.NiniCompletions.
 *  - On web there is no Capacitor bridge; sync is a no-op there.
 */
(function () {
  'use strict';

  var TRACK_KEY = 'nini_native_ids_v1';
  var COMPLETIONS_KEY = 'nini_completions_v1';
  var STORE_KEY = 'nini_reminders_v1';
  var ACTION_TYPE_ID = 'NINI_ACTIONS';
  var SOUND = 'nini-chime.wav';
  var NUDGE_1_MIN = 15;
  var NUDGE_2_MIN = 45;
  var LATER_MIN = 30;
  var SYNC_VERSION = 3;

  function plugin() {
    if (typeof window === 'undefined') return null;
    var cap = window.Capacitor;
    if (!cap || !cap.Plugins || !cap.Plugins.LocalNotifications) return null;
    return cap.Plugins.LocalNotifications;
  }

  function notifId(key) {
    var h = 2166136261;
    for (var i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 100000 + (Math.abs(h) % 1900000000);
  }

  function readJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayKey() { return dateKey(new Date()); }
  function parseHM(time) {
    var p = String(time || '08:00').split(':');
    return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 };
  }

  // ---------- completions ----------
  function loadCompletions() {
    var now = Date.now();
    var list = readJSON(COMPLETIONS_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(function (c) {
      var t = Date.parse((c && c.date ? c.date : '') + 'T12:00:00');
      return c && c.id && !isNaN(t) && now - t < 30 * 24 * 60 * 60 * 1000;
    });
  }
  function isDone(reminderId, dk) {
    return loadCompletions().some(function (c) { return c.id === reminderId && c.date === dk; });
  }
  function markDone(reminderId, dk) {
    var list = loadCompletions();
    if (!list.some(function (c) { return c.id === reminderId && c.date === dk; })) {
      list.push({ id: reminderId, date: dk });
    }
    writeJSON(COMPLETIONS_KEY, list);
  }

  // ---------- schedule math ----------
  function atTimeOn(day, time) {
    var p = parseHM(time);
    var d = new Date(day.getTime());
    d.setHours(p.h, p.m, 0, 0);
    return d;
  }
  function nextAt(time, from) {
    var d = atTimeOn(from, time);
    if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  function nextWeeklyAt(time, anchor, from) {
    var d = atTimeOn(anchor, time);
    while (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 7);
    return d;
  }
  // { prev, next } occurrence boundaries for a reminder. prev is the most
  // recent occurrence at or before `now` (may be null for a 'once' reminder
  // scheduled in the future); next is the first occurrence after `now`.
  function occurrences(r, now) {
    if (r.repeat === 'daily') {
      var next = nextAt(r.time, now);
      var prev = atTimeOn(now, r.time);
      if (prev.getTime() > now.getTime()) prev.setDate(prev.getDate() - 1);
      return { prev: prev, next: next };
    }
    if (r.repeat === 'weekly') {
      var anchor = r.createdAt ? new Date(r.createdAt) : now;
      var wNext = nextWeeklyAt(r.time, anchor, now);
      var wPrev = new Date(wNext.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { prev: wPrev, next: wNext };
    }
    var once = nextAt(r.time, now);
    return { prev: null, next: once };
  }

  function addMinutes(d, mins) { return new Date(d.getTime() + mins * 60 * 1000); }

  // ---------- notification construction ----------
  function note(r, keySuffix, title, body, schedule, occDate) {
    return {
      id: notifId(r.id + '|' + keySuffix),
      title: title,
      body: body,
      sound: SOUND,
      actionTypeId: ACTION_TYPE_ID,
      interruptionLevel: 'timeSensitive',
      relevanceScore: 1,
      schedule: schedule,
      extra: { reminderId: r.id, dateKey: dateKey(occDate) }
    };
  }

  function mainTitle(r) { return 'Nini Daily reminder'; }
  function mainBody(r) {
    return 'Time for: ' + r.title + '. Tap Done when you have done it — I will check back if not.';
  }
  function nudgeBody(r, mins) {
    return 'Still pending: ' + r.title + ' (due ' + mins + ' min ago). Tap Done if it is done — no pressure.';
  }
  function laterBody(r) {
    return 'Checking back, as you asked: ' + r.title + '. Tap Done when it is done.';
  }

  // The main alert's schedule. Daily/weekly use calendar components (`on`)
  // so iOS repeats them on its own; 'once' uses an absolute date.
  function mainSchedule(r, occ) {
    var p = parseHM(r.time);
    if (r.repeat === 'daily') {
      return { on: { hour: p.h, minute: p.m }, allowWhileIdle: true };
    }
    if (r.repeat === 'weekly') {
      var anchorDate = occ.prev || occ.next;
      return { on: { weekday: anchorDate.getDay() + 1, hour: p.h, minute: p.m }, allowWhileIdle: true };
    }
    return { at: occ.next, allowWhileIdle: true };
  }

  function buildPlan(r, now) {
    var plan = { main: null, nudges: [] };
    var occ = occurrences(r, now);

    var liveOcc = null;
    if (occ.prev && dateKey(occ.prev) === dateKey(now) &&
        now.getTime() < addMinutes(occ.prev, NUDGE_2_MIN).getTime() &&
        !isDone(r.id, dateKey(occ.prev))) {
      liveOcc = occ.prev;
    } else if (!isDone(r.id, dateKey(occ.next))) {
      liveOcc = occ.next;
    }
    if (!liveOcc) return plan;

    var isLive = liveOcc.getTime() <= now.getTime();
    if (!isLive) {
      plan.main = note(r, 'main', mainTitle(r), mainBody(r), mainSchedule(r, occ), occ.next);
    }

    var n1At = addMinutes(liveOcc, NUDGE_1_MIN);
    var n2At = addMinutes(liveOcc, NUDGE_2_MIN);
    if (isLive) {
      if (n1At.getTime() > now.getTime() || n2At.getTime() > now.getTime()) {
        var catchAt = new Date(now.getTime() + 10 * 60 * 1000);
        plan.nudges.push(note(r, 'n1', mainTitle(r), nudgeBody(r, NUDGE_1_MIN),
          { at: catchAt, allowWhileIdle: true }, liveOcc));
      }
    } else if (n1At.getTime() > now.getTime()) {
      plan.nudges.push(note(r, 'n1', mainTitle(r), nudgeBody(r, NUDGE_1_MIN),
        { at: n1At, allowWhileIdle: true }, liveOcc));
    }
    if (n2At.getTime() > now.getTime()) {
      plan.nudges.push(note(r, 'n2', mainTitle(r), nudgeBody(r, NUDGE_2_MIN),
        { at: n2At, allowWhileIdle: true }, liveOcc));
    }
    return plan;
  }

  // ---------- permission ----------
  async function ensurePermission(LN) {
    try {
      var status = await LN.checkPermissions();
      if (status && status.display === 'granted') return true;
      var req = await LN.requestPermissions();
      return !!(req && req.display === 'granted');
    } catch (e) { return false; }
  }

  // ---------- actions ----------
  var actionsRegistered = false;
  async function registerActions(LN) {
    if (actionsRegistered) return;
    actionsRegistered = true;
    try {
      await LN.registerActionTypes({
        types: [{
          id: ACTION_TYPE_ID,
          actions: [
            { id: 'done', title: 'Done', foreground: false },
            { id: 'later', title: 'Remind me later', foreground: false }
          ]
        }]
      });
    } catch (e) { /* actions are an enhancement; scheduling continues */ }
  }

  var listenerRegistered = false;
  function registerListener(LN) {
    if (listenerRegistered) return;
    listenerRegistered = true;
    LN.addListener('localNotificationActionPerformed', function (event) {
      try {
        var actionId = event && event.actionId;
        var extra = (event && event.notification && event.notification.extra) || {};
        var rid = extra.reminderId;
        if (!rid) return;
        // Repeating mains carry the first armed occurrence's dateKey in
        // extra; for daily/weekly reminders an action is tapped on the
        // firing day, so today is the right completion date.
        var dk = dateKey(new Date());
        var row = null;
        readJSON(STORE_KEY, []).forEach(function (x) { if (x.id === rid) row = x; });
        if (!(row && (row.repeat === 'daily' || row.repeat === 'weekly')) && extra.dateKey) {
          dk = extra.dateKey;
        }
        if (actionId === 'done') {
          markDone(rid, dk);
          var rows = readJSON(STORE_KEY, []);
          var hit = null;
          rows.forEach(function (x) { if (x.id === rid) hit = x; });
          if (hit && hit.repeat === 'once') {
            hit.enabled = false;
            writeJSON(STORE_KEY, rows);
            if (typeof window.NiniReloadReminders === 'function') window.NiniReloadReminders();
            return;
          }
          syncReminders();
        } else if (actionId === 'later') {
          var rows2 = readJSON(STORE_KEY, []);
          var r2 = null;
          rows2.forEach(function (x) { if (x.id === rid) r2 = x; });
          if (!r2) return;
          var at = new Date(Date.now() + LATER_MIN * 60 * 1000);
          var n = note(r2, 'later' + at.getTime(), mainTitle(r2), laterBody(r2),
            { at: at, allowWhileIdle: true }, new Date());
          LN.schedule({ notifications: [n] }).then(function () {
            var tracked = readJSON(TRACK_KEY, []);
            tracked.push(n.id);
            writeJSON(TRACK_KEY, tracked);
          }).catch(function () {});
        }
      } catch (e) { /* never throw inside a listener */ }
    });
  }

  // ---------- sync ----------
  var syncing = false;
  var syncQueued = false;

  async function syncReminders(givenRows) {
    var LN = plugin();
    if (!LN) return;
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      await registerActions(LN);
      registerListener(LN);

      var reminders = Array.isArray(givenRows) ? givenRows : readJSON(STORE_KEY, []);
      var now = new Date();
      var desired = [];
      reminders.forEach(function (r) {
        if (!r || r.enabled === false) return;
        var plan = buildPlan(r, now);
        if (plan.main) desired.push(plan.main);
        plan.nudges.forEach(function (n) { desired.push(n); });
      });

      if (!(await ensurePermission(LN))) { writeJSON(TRACK_KEY, []); return; }

      // Schedule FIRST (adding a pending request with an existing id
      // replaces it), then cancel only what is no longer wanted. There is
      // no window where a reminder has nothing armed.
      if (desired.length) await LN.schedule({ notifications: desired });

      var keep = {};
      desired.forEach(function (n) { keep[n.id] = true; });
      var tracked = readJSON(TRACK_KEY, []);
      var stale = tracked.filter(function (id) { return !keep[id]; });
      if (stale.length) {
        try {
          await LN.cancel({ notifications: stale.map(function (id) { return { id: id }; }) });
        } catch (e) { /* stale ids may already be gone */ }
      }
      writeJSON(TRACK_KEY, desired.map(function (n) { return n.id; }));
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('NiniNotify sync failed', e);
    } finally {
      syncing = false;
      if (syncQueued) { syncQueued = false; syncReminders(); }
    }
  }

  window.NiniNotify = {
    syncReminders: syncReminders,
    BUILD: SYNC_VERSION
  };
  window.NiniCompletions = {
    load: loadCompletions,
    isDone: isDone,
    markDone: markDone,
    todayKey: todayKey,
    dateKey: dateKey
  };
})();
