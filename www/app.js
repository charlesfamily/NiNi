// Nini Daily frontend — ON-DEVICE data layer (native build).
//
// v1 ships with no server: affirmations are bundled in affirmations.js
// (window.NINI_AFFIRMATIONS) and reminders live in this device's
// localStorage. Nothing leaves the phone, which matches the App Store
// privacy declaration ("Data Not Collected").
//
// app.js still calls window.NiniNotify.syncReminders(rows) after every
// reminder change, so OS-level notifications stay reconciled exactly as
// before (see native-notify.js).

const REMINDERS_KEY = 'nini_reminders_v1';

const $ = (id) => document.getElementById(id);
const affirmationText = $('affirmation-text');
const reminderList = $('reminder-list');
const errorBox = $('error');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
}

// ---------------------------------------------------------------------------
// Affirmations (bundled)
// ---------------------------------------------------------------------------

const AFFIRMATIONS = Array.isArray(window.NINI_AFFIRMATIONS)
  ? window.NINI_AFFIRMATIONS
  : [];

function todaysAffirmation() {
  if (!AFFIRMATIONS.length) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  return AFFIRMATIONS[dayOfYear % AFFIRMATIONS.length];
}

function loadAffirmation() {
  const a = todaysAffirmation();
  if (a) {
    affirmationText.textContent = a.text;
    affirmationText.dataset.id = a.id;
  }
}

function anotherAffirmation() {
  if (!AFFIRMATIONS.length) return;
  const others = AFFIRMATIONS.filter((a) => a.id !== affirmationText.dataset.id);
  const pool = others.length ? others : AFFIRMATIONS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) {
    affirmationText.textContent = pick.text;
    affirmationText.dataset.id = pick.id;
  }
}

// ---------------------------------------------------------------------------
// Reminders (localStorage)
// ---------------------------------------------------------------------------

// First-run seed: the same five reminders the API version shipped with.
const SEED_REMINDERS = [
  { id: 'c1662597-b125-4ff1-9d08-e1154e64ebd2', title: 'Take medication', time: '08:00', repeat: 'daily', enabled: true, createdAt: '2026-09-22T21:59:33.523Z' },
  { id: '7e5324a1-85ad-4370-a587-c38e57408b99', title: 'Team sync', time: '09:30', repeat: 'daily', enabled: true, createdAt: '2026-09-22T21:59:33.523Z' },
  { id: '6a7cda25-3ee6-4c9f-ad0c-329b20a7f901', title: 'Lunch break', time: '12:30', repeat: 'daily', enabled: true, createdAt: '2026-09-22T21:59:33.523Z' },
  { id: '2c4f84d5-eafe-4ca4-b662-be183c9bedcc', title: 'Gym workout', time: '18:00', repeat: 'weekly', enabled: true, createdAt: '2026-09-22T21:59:33.523Z' },
  { id: '8313448e-0387-4dc3-a8f9-3edc17e72305', title: 'Call mom', time: '19:00', repeat: 'weekly', enabled: false, createdAt: '2026-09-22T21:59:33.523Z' },
];

function loadStore() {
  try {
    const raw = localStorage.getItem(REMINDERS_KEY);
    if (raw) {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) return rows;
    }
  } catch (e) { /* fall through to seed */ }
  const seed = SEED_REMINDERS.map((r) => ({ ...r }));
  saveStore(seed);
  return seed;
}

function saveStore(rows) {
  try {
    localStorage.setItem(REMINDERS_KEY, JSON.stringify(rows));
  } catch (e) { /* storage unavailable; list still renders this run */ }
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'r-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

function reminderItem(r, rows) {
  const li = document.createElement('li');
  if (!r.enabled) li.classList.add('paused');

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.title = r.enabled ? 'Pause' : 'Resume';
  toggle.addEventListener('click', () => {
    r.enabled = !r.enabled;
    saveStore(rows);
    renderReminders(rows);
  });

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = r.title;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${r.time} · ${r.repeat}${r.enabled ? '' : ' · paused'}`;
  info.append(title, meta);

  const del = document.createElement('button');
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', () => {
    const i = rows.indexOf(r);
    if (i >= 0) rows.splice(i, 1);
    saveStore(rows);
    renderReminders(rows);
  });

  li.append(toggle, info, del);
  return li;
}

function renderReminders(rows) {
  reminderList.innerHTML = '';
  rows.forEach((r) => reminderList.appendChild(reminderItem(r, rows)));
  // Native only: reconcile OS-level notifications with this list
  // (no-op on plain web). Covers add / pause / resume / delete, which
  // all funnel through renderReminders().
  if (window.NiniNotify) window.NiniNotify.syncReminders(rows);
}

function loadReminders() {
  try {
    clearError();
    renderReminders(loadStore());
  } catch (e) {
    showError(e.message);
  }
}

$('add-reminder').addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    clearError();
    const rows = loadStore();
    rows.push({
      id: newId(),
      title: $('r-title').value.trim(),
      time: $('r-time').value || '09:00',
      repeat: $('r-repeat').value,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    saveStore(rows);
    $('r-title').value = '';
    renderReminders(rows);
  } catch (err) {
    showError(err.message);
  }
});

$('new-affirmation').addEventListener('click', anotherAffirmation);

// Drop the retired API key from the server-based version, if present.
try { localStorage.removeItem('chatnow_api_key'); } catch (e) { /* ignore */ }

loadAffirmation();
loadReminders();
