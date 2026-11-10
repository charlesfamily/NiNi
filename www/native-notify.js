// native-notify.js — Nini Daily native notification layer.
//
// Bridges the web reminder list to Capacitor's LocalNotifications plugin so
// reminders alert even when the app is closed/backgrounded — the thing the
// plain web version cannot do. On plain web (no Capacitor bridge) every
// function is a no-op and the in-page behavior is completely unchanged.
//
// Usage: app.js calls NiniNotify.syncReminders(reminders) after every
// reminder load (which already happens after add / edit / pause / delete /
// mark-done). syncReminders reconciles the OS-level scheduled notifications
// with the current reminder list: enabled reminders get (re)scheduled at
// their next due time, paused/deleted ones are cancelled.
//
// Build 7 (Nov 9, 2026) — "change how reminders work":
// Charles's verdict on Build 6 was that reminders fired but "didn't alarm
// as they should" — a single default ding, gone in a second. Build 7 makes
// a reminder an accompaniment instead of a shout:
//   1. Time-Sensitive interruption level (iOS 15+): alerts break through
//      Focus / scheduled summary the way medication-class reminders may.
//   2. A real sound: the bundled nini-chime.wav (~5 s warm chime,
//      generated at CI time by scripts/make_chime.py and bundled via the
//      Xcode project's Resources) instead of the one-blip system default.
//   3. The knock-twice loop: every reminder carries Done / "Remind me
//      later" actions, and two gentle follow-up nudges (+15 / +45 min)
//      are scheduled per occurrence. Marking Done — from the notification
//      or the in-app check button — cancels the pending nudges. Nothing
//      nags past the second nudge.
//
// Completions live in localStorage under nini_completions_v1 as
// { id, date } pairs (date = the occurrence's local YYYY-MM-DD). app.js
// writes them from its Done button; this file writes them from the
// notification Done action and reads them on every sync.

(function () {
  'use strict';

  var TRACK_KEY = 'nini_scheduled_notif_ids'; // ids we scheduled, JSON array
  var ANCHOR_KEY = 'nini_weekly_anchors';     // reminderId -> weekday (0=Sun)
  var REMINDERS_KEY = 'nini_reminders_v1';    // owned by app.js; read here
  var COMPLETIONS_KEY = 'nini_completions_v1';

  var SOUND = 'nini-chime.wav';
  var ACTION_TYPE_ID = 'NINI_ACTIONS';
  var NUDGE_1_MINUTES = 15;
  var NUDGE_2_MINUTES = 45;
  var LATER_MINUTES = 30;

  function isNative() {
    return !!(
      window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform()
    );
  }

  function plugin() {
    return window.Capacitor.Plugins.LocalNotifications;
  }

  // Reminder ids come from the API and may be strings/uuids; iOS notification
  // ids must be 32-bit integers. FNV-1a hash -> stable positive int per id.
  function notifId(reminderId) {
    var h = 0x811c9dc5;
    var s = String(reminderId);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % 2000000000; // keep comfortably inside int32
  }

  // Follow-up notifications get their own stable ids per occurrence, so a
  // Done action can cancel exactly the nudges of the occurrence it closes.
  function nudgeId(reminderId, dateKey, which) {
    return notifId(reminderId + '|' + dateKey + '|' + which);
  }

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable; scheduling still works this run */ }
  }

  // Local YYYY-MM-DD for a Date (occurrence identity for completions).
  function dateKey(d) {
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  // -------------------------------------------------------------------------
  // Completions
  // -------------------------------------------------------------------------

  function loadCompletions() {
    var rows = readJSON(COMPLETIONS_KEY, []);
    if (!Array.isArray(rows)) return [];
    // Prune anything older than 30 days; the log only feeds nudges/streaks.
    var cutoff = Date.now() - 30 * 86400000;
    return rows.filter(function (c) {
      var t = Date.parse(c && c.date ? c.date + 'T12:00:00' : '');
      return !isNaN(t) && t >= cutoff;
    });
  }

  function isDone(reminderId, dk) {
    return loadCompletions().some(function (c) {
      return c.id === reminderId && c.date === dk;
    });
  }

  function recordDone(reminderId, dk) {
    var rows = loadCompletions();
    if (!rows.some(function (c) { return c.id === reminderId && c.date === dk; })) {
      rows.push({ id: reminderId, date: dk });
      writeJSON(COMPLETIONS_KEY, rows);
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling math
  // -------------------------------------------------------------------------

  // Next Date at the reminder's HH:MM that is strictly in the future.
  function nextAt(timeStr, now) {
    var parts = String(timeStr || '09:00').split(':');
    var d = new Date(now);
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // Weekday a weekly reminder fires on. Prefer an explicit field from the
  // API, then the creation date, then a stored anchor; otherwise anchor to
  // the weekday of the next occurrence and remember it across syncs.
  function weeklyWeekday(r, now) {
    if (typeof r.weekday === 'number') return r.weekday;
    if (typeof r.dayOfWeek === 'number') return r.dayOfWeek;
    if (r.createdAt) {
      var c = new Date(r.createdAt);
      if (!isNaN(c)) return c.getDay();
    }
    var anchors = readJSON(ANCHOR_KEY, {});
    if (typeof anchors[r.id] === 'number') return anchors[r.id];
    var wd = nextAt(r.time, now).getDay();
    anchors[r.id] = wd;
    writeJSON(ANCHOR_KEY, anchors);
    return wd;
  }

  function atTimeOn(dayDate, timeStr) {
    var parts = String(timeStr || '09:00').split(':');
    var d = new Date(dayDate);
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  // The next firing datetime for a reminder, and the most recent one at or
  // before `now` (null when there is none — e.g. a fresh 'once').
  function occurrences(r, now) {
    var next;
    var prev = null;
    if (r.repeat === 'weekly') {
      var wd = weeklyWeekday(r, now);
      next = nextAt(r.time, now);
      while (next.getDay() !== wd) next.setDate(next.getDate() + 1);
      prev = atTimeOn(now, r.time);
      while (prev.getDay() !== wd || prev > now) prev.setDate(prev.getDate() - 1);
      if (prev > now) prev = null;
    } else if (r.repeat === 'daily') {
      next = nextAt(r.time, now);
      prev = atTimeOn(now, r.time);
      if (prev > now) {
        prev = new Date(prev);
        prev.setDate(prev.getDate() - 1);
      }
    } else {
      next = nextAt(r.time, now);
    }
    return { next: next, prev: prev };
  }

  // -------------------------------------------------------------------------
  // Notification builders
  // -------------------------------------------------------------------------

  function baseNotification(id, title, body, extra) {
    return {
      id: id,
      title: title,
      body: body,
      sound: SOUND,
      interruptionLevel: 'time-sensitive',
      relevanceScore: 1,
      actionTypeId: ACTION_TYPE_ID,
      extra: extra,
    };
  }

  // The full plan for one reminder: the main (repeating where applicable)
  // notification plus the follow-up nudges for the live occurrence.
  // Returns [] when the reminder should not alert at all.
  function buildPlan(r, now) {
    if (!r.enabled) return [];
    var occ = occurrences(r, now);
    var plan = [];

    // Main notification — same schedule shape as Build 6.
    var schedule;
    if (r.repeat === 'daily') {
      schedule = { at: occ.next, every: 'day', allowWhileIdle: true };
    } else if (r.repeat === 'weekly') {
      schedule = { at: occ.next, every: 'week', allowWhileIdle: true };
    } else {
      schedule = { at: occ.next, allowWhileIdle: true };
    }
    var main = baseNotification(
      notifId(r.id),
      'Nini Daily reminder',
      r.title,
      { rid: r.id, dk: dateKey(occ.next), title: r.title, kind: 'main' }
    );
    main.schedule = schedule;

    // A 'once' reminder already marked done never fires again.
    if (r.repeat !== 'daily' && r.repeat !== 'weekly' && isDone(r.id, dateKey(occ.next))) {
      return [];
    }
    plan.push(main);

    // Follow-up nudges attach to the occurrence that is "live": the one
    // that just fired (inside its +45 min window) or the next one coming.
    var liveOcc = null;
    if (
      occ.prev &&
      dateKey(occ.prev) === dateKey(now) &&
      now < new Date(occ.prev.getTime() + NUDGE_2_MINUTES * 60000) &&
      !isDone(r.id, dateKey(occ.prev))
    ) {
      liveOcc = occ.prev;
    } else if (!isDone(r.id, dateKey(occ.next))) {
      liveOcc = occ.next;
    }
    if (!liveOcc) return plan;

    var dk = dateKey(liveOcc);
    var n1At = new Date(liveOcc.getTime() + NUDGE_1_MINUTES * 60000);
    var n2At = new Date(liveOcc.getTime() + NUDGE_2_MINUTES * 60000);

    // First knock: at +15, or — if that moment already passed while the
    // app was closed — a single catch-up ten minutes from now.
    var firstAt = n1At > now ? n1At : new Date(now.getTime() + 10 * 60000);
    if (firstAt < n2At || n1At > now) {
      var n1 = baseNotification(
        nudgeId(r.id, dk, 'n1'),
        'Nini Daily — still to do',
        r.title + ' — a gentle check-in. Tap Done when it\u2019s done.',
        { rid: r.id, dk: dk, title: r.title, kind: 'nudge' }
      );
      n1.schedule = { at: firstAt, allowWhileIdle: true };
      plan.push(n1);
    }
    if (n2At > now) {
      var n2 = baseNotification(
        nudgeId(r.id, dk, 'n2'),
        'Nini Daily — last nudge today',
        r.title + ' — no more nudges after this one.',
        { rid: r.id, dk: dk, title: r.title, kind: 'nudge' }
      );
      n2.schedule = { at: n2At, allowWhileIdle: true };
      plan.push(n2);
    }
    return plan;
  }

  // -------------------------------------------------------------------------
  // Notification actions (Done / Remind me later)
  // -------------------------------------------------------------------------

  var actionsRegistered = false;
  var listenerRegistered = false;

  async function registerActions(LN) {
    if (actionsRegistered) return;
    actionsRegistered = true;
    try {
      await LN.registerActionTypes({
        types: [
          {
            id: ACTION_TYPE_ID,
            actions: [
              { id: 'DONE', title: 'Done', foreground: false },
              { id: 'LATER', title: 'Remind me later', foreground: false },
            ],
          },
        ],
      });
    } catch (e) { /* actions are an enhancement; scheduling still works */ }
  }

  function cancelNudges(LN, rid, dk) {
    return LN.cancel({
      notifications: [
        { id: nudgeId(rid, dk, 'n1') },
        { id: nudgeId(rid, dk, 'n2') },
        { id: nudgeId(rid, dk, 'later') },
      ],
    }).catch(function () { /* nothing pending is fine */ });
  }

  function registerListener(LN) {
    if (listenerRegistered) return;
    listenerRegistered = true;
    LN.addListener('localNotificationActionPerformed', async function (event) {
      try {
        var extra = (event.notification && event.notification.extra) || {};
        var rid = extra.rid;
        if (!rid) return;
        var dk = extra.dk || dateKey(new Date());
        if (event.actionId === 'DONE') {
          recordDone(rid, dk);
          await cancelNudges(LN, rid, dk);
          // A completed 'once' reminder retires: switch it off in the
          // store app.js owns, then let the UI resync if it is loaded.
          var rows = readJSON(REMINDERS_KEY, []);
          var changed = false;
          rows.forEach(function (row) {
            if (row.id === rid && row.repeat !== 'daily' && row.repeat !== 'weekly' && row.enabled) {
              row.enabled = false;
              changed = true;
            }
          });
          if (changed) writeJSON(REMINDERS_KEY, rows);
          if (typeof window.NiniReloadReminders === 'function') {
            window.NiniReloadReminders();
          } else if (Array.isArray(rows)) {
            syncReminders(rows);
          }
        } else if (event.actionId === 'LATER') {
          await cancelNudges(LN, rid, dk);
          var later = baseNotification(
            nudgeId(rid, dk, 'later'),
            'Nini Daily — checking back',
            (extra.title || 'Your reminder') + ' — whenever you\u2019re ready.',
            { rid: rid, dk: dk, title: extra.title || '', kind: 'later' }
          );
          later.schedule = {
            at: new Date(Date.now() + LATER_MINUTES * 60000),
            allowWhileIdle: true,
          };
          await LN.schedule({ notifications: [later] });
          // Track it so a later sync (or a Done) can cancel it too.
          var trackedNow = readJSON(TRACK_KEY, []);
          if (trackedNow.indexOf(later.id) < 0) {
            trackedNow.push(later.id);
            writeJSON(TRACK_KEY, trackedNow);
          }
        }
      } catch (e) {
        if (window.console) console.warn('NiniNotify action failed:', e);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  var permissionAsked = false;

  async function ensurePermission(LN) {
    var status = await LN.checkPermissions();
    if (status.display === 'granted') return true;
    if (!permissionAsked) {
      permissionAsked = true;
      var req = await LN.requestPermissions();
      return req.display === 'granted';
    }
    return false;
  }

  async function syncReminders(reminders) {
    if (!isNative()) return; // plain web: in-page behavior only
    try {
      var LN = plugin();
      var now = new Date();

      await registerActions(LN);
      registerListener(LN);

      // Cancel everything we scheduled previously, then schedule fresh.
      // Simple and idempotent: any add/edit/pause/delete/done just resyncs.
      var tracked = readJSON(TRACK_KEY, []);
      if (tracked.length) {
        await LN.cancel({
          notifications: tracked.map(function (id) { return { id: id }; }),
        });
      }

      var desired = [];
      (reminders || []).forEach(function (r) {
        buildPlan(r, now).forEach(function (n) { desired.push(n); });
      });

      // Prune weekly anchors for reminders that no longer exist as weekly.
      var anchors = readJSON(ANCHOR_KEY, {});
      var weeklyIds = {};
      (reminders || []).forEach(function (r) {
        if (r.repeat === 'weekly') weeklyIds[r.id] = true;
      });
      Object.keys(anchors).forEach(function (id) {
        if (!weeklyIds[id]) delete anchors[id];
      });
      writeJSON(ANCHOR_KEY, anchors);

      if (!desired.length) {
        writeJSON(TRACK_KEY, []);
        return;
      }

      if (!(await ensurePermission(LN))) {
        writeJSON(TRACK_KEY, []);
        return; // user declined; stay silent, in-page behavior unaffected
      }

      await LN.schedule({ notifications: desired });
      writeJSON(TRACK_KEY, desired.map(function (n) { return n.id; }));
    } catch (e) {
      // Never let notification plumbing break the app itself.
      if (window.console) console.warn('NiniNotify sync failed:', e);
    }
  }

  window.NiniNotify = {
    isNative: isNative,
    syncReminders: syncReminders,
  };
})();
