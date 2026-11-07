// Nini Daily frontend. Talks to the API on the same origin (/v1/*).
// Your API key is stored only in this browser's localStorage.

const KEY_NAME = 'chatnow_api_key';

const $ = (id) => document.getElementById(id);
const affirmationText = $('affirmation-text');
const reminderList = $('reminder-list');
const errorBox = $('error');

function getKey() {
  return localStorage.getItem(KEY_NAME) || '';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
}

async function api(path, options = {}) {
  const res = await fetch('/v1' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getKey(),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Wrong or missing API key — open Settings below and save your key.');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadAffirmation() {
  try {
    clearError();
    const a = await api('/affirmations/today');
    affirmationText.textContent = a.text;
    affirmationText.dataset.id = a.id;
  } catch (e) {
    showError(e.message);
  }
}

async function anotherAffirmation() {
  try {
    clearError();
    const all = await api('/affirmations');
    const others = all.filter((a) => a.id !== affirmationText.dataset.id);
    const pick = (others.length ? others : all)[Math.floor(Math.random() * (others.length ? others.length : all.length))];
    if (pick) {
      affirmationText.textContent = pick.text;
      affirmationText.dataset.id = pick.id;
    }
  } catch (e) {
    showError(e.message);
  }
}

function reminderItem(r) {
  const li = document.createElement('li');
  if (!r.enabled) li.classList.add('paused');

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.title = r.enabled ? 'Pause' : 'Resume';
  toggle.addEventListener('click', async () => {
    try {
      clearError();
      await api(`/reminders/${r.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      loadReminders();
    } catch (e) {
      showError(e.message);
    }
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
  del.addEventListener('click', async () => {
    try {
      clearError();
      await api(`/reminders/${r.id}`, { method: 'DELETE' });
      loadReminders();
    } catch (e) {
      showError(e.message);
    }
  });

  li.append(toggle, info, del);
  return li;
}

async function loadReminders() {
  try {
    clearError();
    const rows = await api('/reminders');
    reminderList.innerHTML = '';
    rows.forEach((r) => reminderList.appendChild(reminderItem(r)));
    // Native only: reconcile OS-level notifications with this list
    // (no-op on plain web). Covers add / edit / pause / delete, which
    // all funnel through loadReminders().
    if (window.NiniNotify) window.NiniNotify.syncReminders(rows);
  } catch (e) {
    showError(e.message);
  }
}

$('add-reminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    clearError();
    await api('/reminders', {
      method: 'POST',
      body: JSON.stringify({
        title: $('r-title').value,
        time: $('r-time').value,
        repeat: $('r-repeat').value,
      }),
    });
    $('r-title').value = '';
    loadReminders();
  } catch (err) {
    showError(err.message);
  }
});

$('new-affirmation').addEventListener('click', anotherAffirmation);

$('save-key').addEventListener('click', async () => {
  const key = $('api-key').value.trim();
  localStorage.setItem(KEY_NAME, key);
  const status = $('status');
  try {
    await api('/affirmations');
    status.textContent = 'Key works — you are connected.';
    status.className = 'status ok';
    loadAffirmation();
    loadReminders();
  } catch (e) {
    status.textContent = 'That key did not work: ' + e.message;
    status.className = 'status bad';
  }
});

// Prefill the key field if one was saved before.
$('api-key').value = getKey();

loadAffirmation();
loadReminders();
