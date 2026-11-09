// native-notify.js — Nini Daily native notification layer.
//
// Bridges the web reminder list to Capacitor's LocalNotifications plugin so
// reminders alert even when the app is closed/backgrounded — the thing the
// plain web version cannot do. On plain web (no Capacitor bridge) every
// function is a no-op and the in-page behavior is completely unchanged.
//
// Usage: app.js calls NiniNotify.syncReminders(reminders) after every
// reminder load (which already happens after add / edit / pause / delete).
// syncReminders reconciles the OS-level scheduled notifications with the
// current reminder list: enabled reminders get (re)scheduled at their next
// due time, paused/deleted ones are cancelled.

(function () {
  'use strict';

  var TRACK_KEY = 'nini_scheduled_notif_ids'; // ids we scheduled, JSON array
  var ANCHOR_KEY = 'nini_weekly_anchors';     // reminderId -> weekday (0=Sun)

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

  // Build the Capacitor schedule for one reminder, or null to skip it.
  function buildNotification(r, now) {
    if (!r.enabled) return null;
    var schedule;
    if (r.repeat === 'daily') {
      schedule = { at: nextAt(r.time, now), every: 'day', allowWhileIdle: true };
    } else if (r.repeat === 'weekly') {
      var wd = weeklyWeekday(r, now);
      var d = nextAt(r.time, now);
      while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
      schedule = { at: d, every: 'week', allowWhileIdle: true };
    } else {
      // 'once' (or anything unrecognized): single shot at next occurrence.
      schedule = { at: nextAt(r.time, now), allowWhileIdle: true };
    }
    return {
      id: notifId(r.id),
      title: 'Nini Daily reminder',
      body: r.title,
      // iOS delivers a local notification SILENTLY when no sound is set
      // (Capacitor LocalNotifications docs). 'default' asks iOS for the
      // system alert sound. Added Nov 9, 2026 — before this, reminders
      // arrived as banners with no alarm.
      sound: 'default',
      schedule: schedule,
    };
  }

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

      // Cancel everything we scheduled previously, then schedule fresh.
      // Simple and idempotent: any add/edit/pause/delete just re-syncs.
      var tracked = readJSON(TRACK_KEY, []);
      if (tracked.length) {
        await LN.cancel({
          notifications: tracked.map(function (id) { return { id: id }; }),
        });
      }

      var desired = [];
      (reminders || []).forEach(function (r) {
        var n = buildNotification(r, now);
        if (n) desired.push(n);
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
