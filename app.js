/* ================= Todoist API v1 client (My Tasks + one-time import only) ================= */
const API_BASE = 'https://api.todoist.com/api/v1';
const TASK_FILTER = '(today | overdue | next 7 days) & !@Cleaning and Chores';
const LS_CONFIG_KEY = 'cassie_home_base_config_v1';
const LS_CHORES_DATA_KEY = 'cassie_home_base_chores_data_v2';
// legacy keys from the Todoist-backed version, read once during import to preserve progress
const LS_LEGACY_STATE_KEY = 'cassie_home_base_chore_state_v1';
const LS_LEGACY_TIMELOG_KEY = 'cassie_home_base_timelog_v1';

/* ================= GitHub Gist sync client ================= */
const GITHUB_API_BASE = 'https://api.github.com';
const GIST_FILENAME = 'cassie-home-base-sync.json';

const CHORE_ICONS = {
  'House Chores': '🪴',
  'House Cleaning': '🧽',
  'Bedroom🛏️': '🛏️',
  'Kitchen🍽️': '🍽️',
  'Bathroom🚿': '🚿'
};

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
}
function getConfig() { return loadJson(LS_CONFIG_KEY, null); }
function saveConfig(cfg) { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(cfg)); }
function getToken() { const c = getConfig(); return c && c.token; }

function genId() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function loadChoresData() { return loadJson(LS_CHORES_DATA_KEY, { categories: [], chores: [], updatedAt: 0 }); }
let syncPushTimer = null;
let syncPending = false;
function saveChoresData(data) {
  data.updatedAt = Date.now();
  localStorage.setItem(LS_CHORES_DATA_KEY, JSON.stringify(data));
  scheduleSyncPush();
}

let categories = [];   // cache of data.categories, refreshed each render, used by the edit modal's select
let modalChoreId = null;

async function todoistFetch(path, options) {
  options = options || {};
  const token = getToken();
  const headers = { 'Authorization': 'Bearer ' + token };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) {}
    throw new Error('Todoist API error ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function fetchAllPages(path, params) {
  let out = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const qp = new URLSearchParams(params || {});
    qp.set('limit', '200');
    if (cursor) qp.set('cursor', cursor);
    const data = await todoistFetch(path + '?' + qp.toString());
    out = out.concat((data && data.results) || []);
    cursor = data && data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/* ---- GitHub Gist helpers ---- */
async function githubFetch(path, options) {
  options = options || {};
  const cfg = getConfig();
  const token = cfg && cfg.githubToken;
  const headers = { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(GITHUB_API_BASE + path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) {}
    throw new Error('GitHub API error ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  return res.json();
}
async function findOrCreateSyncGist(token) {
  const cfgSnapshot = getConfig() || {};
  saveConfig({ ...cfgSnapshot, githubToken: token }); // needed so githubFetch can authenticate below
  const gists = await githubFetch('/gists?per_page=100');
  const existing = gists.find(g => g.files && g.files[GIST_FILENAME]);
  if (existing) return existing.id;
  const created = await githubFetch('/gists', {
    method: 'POST',
    body: {
      description: "Cassie's Home Base sync data — do not delete",
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ categories: [], chores: [], updatedAt: 0 }) } }
    }
  });
  return created.id;
}
async function pullFromGist() {
  const cfg = getConfig();
  const gist = await githubFetch('/gists/' + cfg.gistId);
  return JSON.parse(gist.files[GIST_FILENAME].content);
}
async function pushToGist(data) {
  const cfg = getConfig();
  await githubFetch('/gists/' + cfg.gistId, {
    method: 'PATCH',
    body: { files: { [GIST_FILENAME]: { content: JSON.stringify(data) } } }
  });
}
function scheduleSyncPush() {
  const cfg = getConfig();
  if (!cfg || !cfg.githubToken || !cfg.gistId) return;
  syncPending = true;
  updateSyncStatusUI();
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(async () => {
    try {
      await pushToGist(loadChoresData());
      syncPending = false;
      recordSyncTime();
    } catch (e) {
      showToast('Could not sync to the cloud', true);
      updateSyncStatusUI();
    }
  }, 1500);
}
async function syncNow(verbose) {
  const cfg = getConfig();
  if (!cfg || !cfg.githubToken || !cfg.gistId) {
    if (verbose) showToast("Sync isn't set up — see Settings", true);
    return;
  }
  try {
    const remote = await pullFromGist();
    const local = loadChoresData();
    const remoteUpdated = remote.updatedAt || 0;
    const localUpdated = local.updatedAt || 0;
    if (remoteUpdated > localUpdated) {
      localStorage.setItem(LS_CHORES_DATA_KEY, JSON.stringify(remote));
      renderChores();
      syncPending = false;
      recordSyncTime();
      if (verbose) showToast('Synced — pulled changes from your other device');
    } else if (localUpdated > remoteUpdated) {
      await pushToGist(local);
      syncPending = false;
      recordSyncTime();
      if (verbose) showToast('Synced — pushed your changes');
    } else {
      syncPending = false;
      recordSyncTime();
      if (verbose) showToast('Already up to date');
    }
  } catch (e) {
    syncPending = true;
    updateSyncStatusUI();
    if (verbose) showToast('Sync failed — check your connection', true);
  }
}
function recordSyncTime() {
  const cfg = getConfig();
  if (!cfg) return;
  cfg.lastSyncedAt = Date.now();
  saveConfig(cfg);
  updateSyncStatusUI();
}
function updateSyncStatusUI() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const cfg = getConfig();
  if (!cfg || !cfg.githubToken || !cfg.gistId) { el.textContent = 'Sync not set up'; return; }
  if (syncPending) { el.textContent = '⚠️ Sync pending — will retry'; return; }
  el.textContent = cfg.lastSyncedAt ? ('🔄 Synced ' + fmtRelative(new Date(cfg.lastSyncedAt).toISOString())) : 'Sync enabled — not synced yet';
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function armConfirm(btn, onConfirm, label) {
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer));
    btn.dataset.armed = '0';
    onConfirm();
    return;
  }
  const original = btn.dataset.original || btn.textContent;
  btn.dataset.original = original;
  btn.dataset.armed = '1';
  btn.textContent = label || 'Sure?';
  btn.classList.add('confirming');
  const timer = setTimeout(() => {
    btn.dataset.armed = '0';
    btn.textContent = original;
    btn.classList.remove('confirming');
  }, 4000);
  btn.dataset.timer = String(timer);
}

function fmtRelative(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) {
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    return Math.floor(mins / 60) + 'h ago';
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 14) return '1 week ago';
  if (days < 30) return Math.floor(days / 7) + ' weeks ago';
  return Math.floor(days / 30) + ' months ago';
}
function staleness(iso) {
  if (!iso) return 'stale';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 3) return 'fresh';
  if (days <= 10) return '';
  return 'stale';
}
function getDueDateStr(task) {
  if (!task.due) return null;
  return task.due.date || (task.due.datetime ? task.due.datetime.slice(0, 10) : null);
}
function fmtDueChip(dueDateStr, baseCls) {
  if (!dueDateStr) return null;
  baseCls = baseCls || 'chip';
  const today = todayStr();
  const d = new Date(dueDateStr + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diffDays = Math.round((d - t) / 86400000);
  let cls = baseCls, label;
  if (diffDays < 0) { cls += ' due-overdue'; label = 'Overdue'; }
  else if (diffDays === 0) { cls += ' due-today'; label = 'Today'; }
  else if (diffDays === 1) { label = 'Tomorrow'; }
  else { label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  return { cls, label, diffDays };
}
function priorityLabel(p) {
  if (!p || p <= 1) return null;
  return 'P' + (5 - p);
}
function formatDurationFromTodoist(dur) {
  if (!dur || !dur.amount) return '';
  if (dur.unit === 'day') return dur.amount + 'd';
  const amt = dur.amount;
  if (amt < 60) return amt + 'm';
  const h = Math.floor(amt / 60), m = amt % 60;
  return h + 'h' + (m ? m + 'm' : '');
}

/* ---- local recurrence & due-date helpers ---- */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function advanceDueDate(dueDateStr, every, unit) {
  const d = new Date((dueDateStr || todayStr()).slice(0, 10) + 'T00:00:00');
  if (unit === 'days') d.setDate(d.getDate() + every);
  else if (unit === 'weeks') d.setDate(d.getDate() + every * 7);
  else if (unit === 'months') d.setMonth(d.getMonth() + every);
  // use local date components rather than toISOString() (which round-trips through UTC
  // and would shift the date by a day in timezones ahead of UTC)
  return formatLocalDate(d);
}
function recurLabel(chore) {
  if (!chore.recurEvery || !chore.recurUnit) return '';
  const n = chore.recurEvery;
  const unit = chore.recurUnit.replace(/s$/, '');
  return `every ${n} ${unit}${n === 1 ? '' : 's'}`;
}
// backfills chore.dueDate for chores saved before the due-date field existed
function migrateDueDates(data) {
  let changed = false;
  data.chores.forEach(c => {
    if (c.dueDate === undefined) {
      if (c.recurEvery && c.recurUnit) {
        const base = (c.lastDone || c.startDate || todayStr()).slice(0, 10);
        c.dueDate = advanceDueDate(base, c.recurEvery, c.recurUnit);
      } else {
        c.dueDate = null;
      }
      changed = true;
    }
  });
  return changed;
}
function applyAutoReset() {
  const data = loadChoresData();
  let changed = migrateDueDates(data);
  const today = new Date(todayStr() + 'T00:00:00');
  data.chores.forEach(c => {
    if (c.checked && c.recurEvery && c.recurUnit && c.dueDate) {
      let due = new Date(c.dueDate + 'T00:00:00');
      if (today >= due) {
        c.checked = false;
        let safety = 0;
        do {
          c.dueDate = advanceDueDate(c.dueDate, c.recurEvery, c.recurUnit);
          due = new Date(c.dueDate + 'T00:00:00');
          safety++;
        } while (today >= due && safety < 500);
        changed = true;
      }
    }
  });
  if (changed) saveChoresData(data);
}

/* ---- best-effort mapping of a Todoist recurring string to {every, unit} ---- */
function guessRecurFromTodoist(due) {
  if (!due || !due.is_recurring || !due.string) return { recurEvery: null, recurUnit: null };
  const s = due.string.toLowerCase().trim();
  let m;
  if ((m = s.match(/^every\s+(\d+)\s+day/))) return { recurEvery: parseInt(m[1], 10), recurUnit: 'days' };
  if ((m = s.match(/^every\s+(\d+)\s+week/))) return { recurEvery: parseInt(m[1], 10), recurUnit: 'weeks' };
  if ((m = s.match(/^every\s+(\d+)\s+month/))) return { recurEvery: parseInt(m[1], 10), recurUnit: 'months' };
  if (s === 'every day') return { recurEvery: 1, recurUnit: 'days' };
  if (s === 'every week') return { recurEvery: 1, recurUnit: 'weeks' };
  if (s === 'every month') return { recurEvery: 1, recurUnit: 'months' };
  if (s.startsWith('every other ')) return { recurEvery: 2, recurUnit: 'weeks' };
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  if (weekdays.some(d => s === 'every ' + d)) return { recurEvery: 1, recurUnit: 'weeks' };
  return { recurEvery: null, recurUnit: null };
}

/* ---------------- My Tasks (still Todoist-backed) ---------------- */

async function loadTasks() {
  const el = document.getElementById('tasksArea');
  try {
    const tasks = await fetchAllPages('/tasks/filter', { query: TASK_FILTER });
    renderTasks(tasks);
  } catch (e) {
    el.innerHTML = '<div class="error">Couldn\'t load tasks. Try reloading.</div>';
  }
}
function renderTasks(tasks) {
  const el = document.getElementById('tasksArea');
  document.getElementById('taskCount').textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
  if (!tasks.length) {
    el.innerHTML = '<div class="task-group"><div class="empty-note">Nothing due in the next week. 🎉</div></div>';
    return;
  }
  const groups = { overdue: [], today: [], upcoming: [] };
  tasks.forEach(t => {
    const chip = fmtDueChip(getDueDateStr(t));
    if (!chip) { groups.upcoming.push(t); return; }
    if (chip.diffDays < 0) groups.overdue.push(t);
    else if (chip.diffDays === 0) groups.today.push(t);
    else groups.upcoming.push(t);
  });
  [groups.overdue, groups.today, groups.upcoming].forEach(g =>
    g.sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''))
  );
  const sections = [
    { key: 'overdue', label: 'Overdue', cls: 'overdue' },
    { key: 'today', label: 'Today', cls: '' },
    { key: 'upcoming', label: 'Upcoming', cls: '' }
  ];
  el.innerHTML = sections
    .filter(s => groups[s.key].length)
    .map(s => {
      const rows = groups[s.key].map(t => {
        const chip = fmtDueChip(getDueDateStr(t));
        const chipHtml = chip ? `<span class="${chip.cls}">${chip.label}</span>` : '';
        const label = priorityLabel(t.priority);
        const priorityHtml = label ? `<span class="chip">${label}</span>` : '';
        return `
          <div class="task-row" data-id="${t.id}">
            <div class="checkbox" data-action="complete" data-id="${t.id}" role="checkbox" aria-checked="false" tabindex="0" aria-label="Mark task complete"></div>
            <div class="task-content">${escapeHtml(t.content)}</div>
            <div class="task-meta">${priorityHtml}${chipHtml}</div>
          </div>`;
      }).join('');
      return `
        <div class="task-group">
          <div class="task-group-header ${s.cls}">${s.label} · ${groups[s.key].length}</div>
          ${rows}
        </div>`;
    }).join('');
}
async function onCompleteTask(box) {
  const id = box.dataset.id;
  const row = box.closest('.task-row');
  box.classList.add('checked');
  box.textContent = '✓';
  box.setAttribute('aria-checked', 'true');
  row.classList.add('done');
  try {
    await todoistFetch(`/tasks/${id}/close`, { method: 'POST' });
    showToast('Task completed');
  } catch (err) {
    box.classList.remove('checked');
    box.textContent = '';
    box.setAttribute('aria-checked', 'false');
    row.classList.remove('done');
    showToast('Could not complete that task — try again', true);
  }
}

/* ---------------- House Cleaning (fully local) ---------------- */

function loadChores() {
  applyAutoReset();
  renderChores();
}

function computeProgressSummary(chores) {
  const todayD = new Date(todayStr() + 'T00:00:00');
  let todayTotal = 0, todayDone = 0, weekTotal = 0, weekDone = 0;
  chores.forEach(c => {
    if (!c.dueDate) return; // unscheduled chores don't count toward either bar
    const due = new Date(c.dueDate + 'T00:00:00');
    const diff = Math.round((due - todayD) / 86400000);
    if (diff <= 6) {
      weekTotal++;
      if (c.checked) weekDone++;
    }
    if (diff <= 0) {
      todayTotal++;
      if (c.checked) todayDone++;
    }
  });
  return { todayTotal, todayDone, weekTotal, weekDone };
}
function renderProgressSummary(chores) {
  const s = computeProgressSummary(chores);
  const weekPct = s.weekTotal ? Math.round((s.weekDone / s.weekTotal) * 100) : 0;
  const todayPct = s.todayTotal ? Math.round((s.todayDone / s.todayTotal) * 100) : 0;
  document.getElementById('weekBarFill').style.width = weekPct + '%';
  document.getElementById('weekPct').textContent = weekPct + '%';
  document.getElementById('todayBarFill').style.width = todayPct + '%';
  document.getElementById('todayPct').textContent = todayPct + '%';
  document.getElementById('cleanSubLabel').textContent = (s.todayTotal || s.weekTotal)
    ? `${s.todayDone} of ${s.todayTotal} due today · ${s.weekDone} of ${s.weekTotal} due this week`
    : 'No due dates set yet — edit a chore to add one';
}

// a chore row's markup, shared between the per-category list, Today, and Upcoming sections.
// categoryLabel is only shown when the row appears outside its own category's card (Today/Upcoming).
function buildChoreRowHtml(s, todayStrVal, categoryLabel) {
  const stale = staleness(s.lastDone);
  const estBadge = s.duration ? `<span class="est-badge" title="Time estimate">⏱ ${escapeHtml(s.duration)}</span>` : '';
  const recur = recurLabel(s);
  const recurBadge = recur ? `<span class="recur-badge" title="Recurring cycle">🔁 ${escapeHtml(recur)}</span>` : '';
  const todaysMinutes = (s.timelog || []).filter(l => l.date === todayStrVal).reduce((sum, l) => sum + l.minutes, 0);
  const logBadge = todaysMinutes ? `<span class="log-badge" title="Logged today">✅ ${todaysMinutes}m</span>` : '';
  const noteBadge = s.notes ? `<span class="est-badge" title="${escapeHtml(s.notes)}">📝</span>` : '';
  const dueChip = fmtDueChip(s.dueDate, 'due-badge');
  const dueBadge = dueChip ? `<span class="${dueChip.cls}" title="Due date">📅 ${dueChip.label}</span>` : '';
  const catBadge = categoryLabel ? `<span class="cat-badge">${escapeHtml(categoryLabel)}</span>` : '';
  return `
    <div class="sub-row" data-id="${s.id}">
      <div class="sub-checkbox ${s.checked ? 'checked' : ''}" data-action="toggle-sub" data-id="${s.id}" role="checkbox" aria-checked="${s.checked ? 'true' : 'false'}" tabindex="0" aria-label="${escapeHtml(s.name)}">${s.checked ? '✓' : ''}</div>
      <div class="sub-name ${s.checked ? 'checked' : ''}">${escapeHtml(s.name)}</div>
      <div class="badge-row">${catBadge}${dueBadge}${estBadge}${recurBadge}${logBadge}${noteBadge}</div>
      <div class="last-cleaned ${stale}">${fmtRelative(s.lastDone)}</div>
      <button class="icon-btn" data-action="edit-task" data-id="${s.id}" title="Edit chore">✏️</button>
    </div>`;
}

function renderTodaySection(chores, categoriesList) {
  const el = document.getElementById('todayArea');
  const catNameById = {};
  categoriesList.forEach(c => { catNameById[c.id] = c.name; });
  const todayStrVal = todayStr();
  const items = chores
    .filter(c => c.dueDate === todayStrVal)
    .sort((a, b) => {
      const catA = catNameById[a.categoryId] || '';
      const catB = catNameById[b.categoryId] || '';
      return catA.localeCompare(catB) || a.name.localeCompare(b.name);
    });
  document.getElementById('todayChoreCount').textContent = items.length + (items.length === 1 ? ' chore' : ' chores');
  el.innerHTML = items.length
    ? `<div class="task-group">${items.map(c => buildChoreRowHtml(c, todayStrVal, catNameById[c.categoryId])).join('')}</div>`
    : '<div class="task-group"><div class="empty-note">Nothing due today. 🎉</div></div>';
}

function groupChoresByDay(chores) {
  const groups = {};
  chores.forEach(c => {
    if (!c.dueDate) return;
    (groups[c.dueDate] = groups[c.dueDate] || []).push(c);
  });
  return Object.keys(groups).sort().map(dateStr => ({ dateStr, chores: groups[dateStr] }));
}
function dayHeaderLabel(dateStr) {
  const chip = fmtDueChip(dateStr);
  if (!chip) return dateStr;
  if (chip.diffDays < 0) return 'Overdue · ' + new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (chip.diffDays === 0) return 'Today';
  if (chip.diffDays === 1) return 'Tomorrow';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function renderUpcomingSection(chores, categoriesList) {
  const el = document.getElementById('upcomingArea');
  const catNameById = {};
  categoriesList.forEach(c => { catNameById[c.id] = c.name; });
  const todayStrVal = todayStr();
  const scheduled = chores.filter(c => c.dueDate);
  document.getElementById('upcomingCount').textContent = scheduled.length + (scheduled.length === 1 ? ' chore' : ' chores');
  if (!scheduled.length) {
    el.innerHTML = '<div class="empty-note">No upcoming chores scheduled yet.</div>';
    return;
  }
  const groups = groupChoresByDay(scheduled);
  el.innerHTML = groups.map(g => {
    const chip = fmtDueChip(g.dateStr);
    const headerCls = 'task-group-header' + (chip && chip.diffDays < 0 ? ' overdue' : '');
    const rows = g.chores
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => buildChoreRowHtml(c, todayStrVal, catNameById[c.categoryId]))
      .join('');
    return `
      <div class="task-group">
        <div class="${headerCls}">${dayHeaderLabel(g.dateStr)} · ${g.chores.length}</div>
        ${rows}
      </div>`;
  }).join('');
}

function renderChores() {
  const el = document.getElementById('choreArea');
  const data = loadChoresData();
  categories = data.categories;
  const todayStrVal = todayStr();

  renderProgressSummary(data.chores);
  renderTodaySection(data.chores, data.categories);
  renderUpcomingSection(data.chores, data.categories);

  const cards = categories.map(cat => {
    const subs = data.chores.filter(c => c.categoryId === cat.id);
    const icon = CHORE_ICONS[cat.name] || '🧹';
    const headActions = `
      <div class="head-actions">
        <button class="icon-btn" data-action="rename-cat" data-id="${cat.id}" title="Rename category">✏️</button>
        <button class="icon-btn danger" data-action="delete-cat" data-id="${cat.id}" title="Delete category">🗑</button>
        <button class="reset-btn" data-action="reset-card" data-id="${cat.id}">New cycle</button>
      </div>`;

    if (!subs.length) {
      return `
        <div class="chore-card">
          <div class="chore-card-head">
            <div class="chore-card-title"><span>${icon}</span><span class="cat-title-text" id="cat-title-${cat.id}">${escapeHtml(cat.name)}</span></div>
            ${headActions}
          </div>
          <div class="no-subs">No chores added under this yet.</div>
          <div class="add-row"><button class="ghost-btn" data-action="show-add-task" data-id="${cat.id}">+ Add chore</button></div>
        </div>`;
    }

    let checkedCount = 0;
    subs.forEach(c => { if (c.checked) checkedCount++; });
    const pct = Math.round((checkedCount / subs.length) * 100);
    // recurring chores that are completed disappear from this list until their next occurrence
    const visibleSubs = subs.filter(c => !(c.checked && c.recurEvery && c.recurUnit));
    const bodyHtml = visibleSubs.length
      ? visibleSubs.map(s => buildChoreRowHtml(s, todayStrVal, null)).join('')
      : '<div class="no-subs">All done for now — nothing due until the next cycle. 🎉</div>';
    return `
      <div class="chore-card">
        <div class="chore-card-head">
          <div class="chore-card-title"><span>${icon}</span><span class="cat-title-text" id="cat-title-${cat.id}">${escapeHtml(cat.name)}</span></div>
          ${headActions}
        </div>
        <div class="chore-bar-wrap"><div class="chore-bar-fill" style="width:${pct}%"></div></div>
        ${bodyHtml}
        <div class="add-row"><button class="ghost-btn" data-action="show-add-task" data-id="${cat.id}">+ Add chore</button></div>
      </div>`;
  }).join('');

  el.innerHTML = cards || '<div class="empty-note">No categories yet. Add one below, or import from Todoist via Settings.</div>';
}

function onToggleSub(choreId) {
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === choreId);
  if (!chore) return;
  chore.checked = !chore.checked;
  if (chore.checked) {
    chore.lastDone = new Date().toISOString();
    if (chore.recurEvery && chore.recurUnit && chore.dueDate) {
      const due = new Date(chore.dueDate + 'T00:00:00');
      const today = new Date(todayStr() + 'T00:00:00');
      if (today >= due) {
        // completing on/after the due date starts the next cycle right away
        chore.dueDate = advanceDueDate(chore.dueDate, chore.recurEvery, chore.recurUnit);
      }
      // completing early keeps the same due date; it stays checked until that date arrives
    }
  }
  saveChoresData(data);
  renderChores();
}
function onResetCard(categoryId) {
  const data = loadChoresData();
  data.chores.forEach(c => {
    if (c.categoryId === categoryId) {
      c.checked = false;
      if (c.recurEvery && c.recurUnit && c.dueDate) {
        c.dueDate = advanceDueDate(c.dueDate, c.recurEvery, c.recurUnit);
      }
    }
  });
  saveChoresData(data);
  renderChores();
}

/* ---- category rename / delete ---- */

function startRenameCategory(id) {
  const span = document.getElementById('cat-title-' + id);
  if (!span || span.tagName === 'INPUT') return;
  const current = span.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'cat-title-input';
  input.id = 'cat-title-' + id;
  span.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (newName && newName !== current) {
      const data = loadChoresData();
      const cat = data.categories.find(c => c.id === id);
      if (cat) { cat.name = newName; saveChoresData(data); showToast('Category renamed'); }
    }
    renderChores();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { settled = true; renderChores(); }
  });
  input.addEventListener('blur', commit);
}
function deleteCategoryConfirmed(id) {
  const data = loadChoresData();
  data.categories = data.categories.filter(c => c.id !== id);
  data.chores = data.chores.filter(c => c.categoryId !== id);
  saveChoresData(data);
  showToast('Category deleted');
  renderChores();
}

/* ---- add category / add chore (inline forms) ---- */

function showAddCategoryForm() {
  const wrap = document.getElementById('addCategoryWrap');
  wrap.innerHTML = `
    <div class="inline-form">
      <input type="text" class="inline-add-input" placeholder="Category name">
      <button class="save-btn" data-action="submit-add-category">Add</button>
      <button class="cancel-btn" data-action="cancel-add-category">Cancel</button>
    </div>`;
  wrap.querySelector('.inline-add-input').focus();
}
function restoreAddCategoryButton() {
  document.getElementById('addCategoryWrap').innerHTML =
    '<button class="ghost-btn" data-action="show-add-category">+ Add category</button>';
}
function submitAddCategory() {
  const wrap = document.getElementById('addCategoryWrap');
  const input = wrap.querySelector('.inline-add-input');
  const name = input ? input.value.trim() : '';
  if (name) {
    const data = loadChoresData();
    data.categories.push({ id: genId(), name });
    saveChoresData(data);
    showToast('Category added');
  }
  restoreAddCategoryButton();
  renderChores();
}
function showAddTaskForm(btn) {
  const wrap = btn.closest('.add-row');
  const catId = btn.dataset.id;
  wrap.innerHTML = `
    <div class="inline-form">
      <input type="text" class="inline-add-input" placeholder="Chore name">
      <button class="save-btn" data-action="submit-add-task" data-parent="${catId}">Add</button>
      <button class="cancel-btn" data-action="cancel-add-task" data-parent="${catId}">Cancel</button>
    </div>`;
  wrap.querySelector('.inline-add-input').focus();
}
function submitAddTask(categoryId, wrap) {
  const input = wrap.querySelector('.inline-add-input');
  const name = input ? input.value.trim() : '';
  if (name) {
    const data = loadChoresData();
    data.chores.push({
      id: genId(), categoryId, name, notes: '', duration: '',
      recurEvery: null, recurUnit: null, startDate: todayStr(), dueDate: null,
      checked: false, lastDone: null, timelog: []
    });
    saveChoresData(data);
    showToast('Chore added');
  }
  renderChores();
}

/* ---- task edit modal ---- */

function openTaskModal(id) {
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === id);
  if (!chore) return;
  modalChoreId = id;
  document.getElementById('modalName').value = chore.name || '';
  populateCategorySelect(chore.categoryId);
  document.getElementById('modalNotes').value = chore.notes || '';
  document.getElementById('modalDuration').value = chore.duration || '';
  document.getElementById('modalRecurEvery').value = chore.recurEvery || '';
  document.getElementById('modalRecurUnit').value = chore.recurUnit || 'weeks';
  document.getElementById('modalDueDate').value = chore.dueDate || '';
  document.getElementById('modalStartDate').value = chore.startDate || todayStr();
  document.getElementById('timelogDate').value = todayStr();
  document.getElementById('timelogMinutes').value = '';
  renderTimelogList(id);
  updateDueDateFieldState();
  const delBtn = document.querySelector('#taskModalOverlay [data-action="delete-task"]');
  delBtn.dataset.armed = '0';
  delBtn.textContent = delBtn.dataset.original || 'Delete';
  delBtn.classList.remove('confirming');
  document.getElementById('taskModalOverlay').classList.add('open');
  document.getElementById('modalName').focus();
}
function closeModal() {
  document.getElementById('taskModalOverlay').classList.remove('open');
  modalChoreId = null;
}
function populateCategorySelect(currentCategoryId) {
  const sel = document.getElementById('modalCategory');
  sel.innerHTML = categories.map(c =>
    `<option value="${c.id}" ${c.id === currentCategoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
}
function updateDueDateFieldState() {
  const everyVal = parseInt(document.getElementById('modalRecurEvery').value, 10);
  const isRecurring = everyVal > 0;
  const dueInput = document.getElementById('modalDueDate');
  const hint = document.getElementById('modalDueDateHint');
  dueInput.disabled = isRecurring;
  hint.textContent = isRecurring
    ? 'Auto-calculated from the recurrence — advances automatically each time a cycle completes.'
    : "Leave blank if this chore doesn't need a due date.";
}
function renderTimelogList(choreId) {
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === choreId);
  const logs = (chore && chore.timelog) || [];
  const el = document.getElementById('timelogList');
  if (!logs.length) { el.innerHTML = '<div class="hint">No logged sessions yet.</div>'; return; }
  el.innerHTML = logs.slice().reverse().map(l => {
    const idx = logs.indexOf(l);
    return `
      <div class="timelog-row">
        <span style="flex:1;">${escapeHtml(l.date)}</span>
        <span>${l.minutes} min</span>
        <button class="icon-btn danger" data-action="remove-timelog" data-idx="${idx}">✕</button>
      </div>`;
  }).join('');
}
function saveTaskFromModal() {
  if (!modalChoreId) return;
  const name = document.getElementById('modalName').value.trim();
  if (!name) { showToast('Name cannot be empty', true); return; }
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === modalChoreId);
  if (!chore) return;
  chore.name = name;
  chore.categoryId = document.getElementById('modalCategory').value || chore.categoryId;
  chore.notes = document.getElementById('modalNotes').value;
  chore.duration = document.getElementById('modalDuration').value.trim();
  const recurEveryVal = parseInt(document.getElementById('modalRecurEvery').value, 10);
  const recurUnitVal = document.getElementById('modalRecurUnit').value;
  chore.startDate = document.getElementById('modalStartDate').value || chore.startDate || todayStr();
  if (recurEveryVal > 0 && recurUnitVal) {
    chore.recurEvery = recurEveryVal;
    chore.recurUnit = recurUnitVal;
    // due date for a recurring chore is auto-managed; seed it once if it doesn't have one yet
    if (!chore.dueDate) chore.dueDate = chore.startDate;
  } else {
    chore.recurEvery = null;
    chore.recurUnit = null;
    chore.dueDate = document.getElementById('modalDueDate').value || null;
  }
  saveChoresData(data);
  showToast('Chore updated');
  closeModal();
  renderChores();
}
function deleteTaskFromModal() {
  if (!modalChoreId) return;
  const data = loadChoresData();
  data.chores = data.chores.filter(c => c.id !== modalChoreId);
  saveChoresData(data);
  showToast('Chore deleted');
  closeModal();
  renderChores();
}
function addTimelogFromModal() {
  if (!modalChoreId) return;
  const date = document.getElementById('timelogDate').value || todayStr();
  const minutes = parseInt(document.getElementById('timelogMinutes').value, 10);
  if (!minutes || minutes <= 0) { showToast('Enter minutes first', true); return; }
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === modalChoreId);
  if (!chore) return;
  chore.timelog = chore.timelog || [];
  chore.timelog.push({ date, minutes });
  saveChoresData(data);
  document.getElementById('timelogMinutes').value = '';
  renderTimelogList(modalChoreId);
  showToast('Logged');
}
function removeTimelogEntry(idx) {
  if (!modalChoreId) return;
  const data = loadChoresData();
  const chore = data.chores.find(c => c.id === modalChoreId);
  if (!chore) return;
  (chore.timelog || []).splice(idx, 1);
  saveChoresData(data);
  renderTimelogList(modalChoreId);
}

/* ---- backup & restore (full local dataset) ---- */

function buildBackupPayload() {
  const data = loadChoresData();
  return { app: 'cassie-home-base', version: 2, exportedAt: new Date().toISOString(), categories: data.categories, chores: data.chores };
}
function exportBackup() {
  const json = JSON.stringify(buildBackupPayload(), null, 2);
  let downloadWorked = false;
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cassie-home-base-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    downloadWorked = true;
  } catch (e) { downloadWorked = false; }
  showToast(downloadWorked ? 'Backup downloaded' : 'Download blocked — copy the JSON below');
  showExportFallback(json);
}
function showExportFallback(json) {
  const panel = document.getElementById('exportFallback');
  document.getElementById('exportText').value = json;
  panel.style.display = 'block';
}
function copyExportText() {
  const ta = document.getElementById('exportText');
  ta.focus();
  ta.select();
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(ta.value); copied = true; }
  } catch (e) { copied = false; }
  if (!copied) { try { copied = document.execCommand('copy'); } catch (e) { copied = false; } }
  showToast(copied ? 'Copied to clipboard' : 'Select the text above and copy manually', !copied);
}
function toggleImportPanel() {
  const panel = document.getElementById('importPanel');
  panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
}
function hideImportPanel() {
  document.getElementById('importPanel').style.display = 'none';
  document.getElementById('importText').value = '';
  document.getElementById('importFile').value = '';
}
function doRestoreBackup() {
  const raw = document.getElementById('importText').value.trim();
  if (!raw) { showToast('Choose a file or paste backup JSON first', true); return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { showToast("That doesn't look like valid JSON", true); return; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.categories) || !Array.isArray(parsed.chores)) {
    showToast('Invalid or outdated backup file (needs a v2 backup)', true);
    return;
  }
  saveChoresData({ categories: parsed.categories, chores: parsed.chores });
  hideImportPanel();
  renderChores();
  showToast('Backup restored');
}

/* ---- setup / settings wizard ---- */

function showSetup() {
  document.getElementById('appScreen').style.display = 'none';
  document.getElementById('setupScreen').style.display = 'block';
  document.getElementById('setupStepToken').style.display = 'block';
  document.getElementById('setupStepImportChoice').style.display = 'none';
  document.getElementById('setupStepProject').style.display = 'none';
  document.getElementById('setupStepSection').style.display = 'none';
  document.getElementById('setupStepSync').style.display = 'none';
  document.getElementById('setupError').style.display = 'none';
  const cfg = getConfig();
  document.getElementById('setupToken').value = (cfg && cfg.token) || '';
  document.getElementById('cancelSetupLink').style.display = (cfg && cfg.token) ? 'inline' : 'none';
  document.getElementById('setupSubtitle').textContent = (cfg && cfg.token) ? 'Settings' : 'One-time setup';
  document.getElementById('jumpToSyncWrap').style.display = (cfg && cfg.token) ? 'block' : 'none';
}
function jumpToSync() {
  document.getElementById('setupStepToken').style.display = 'none';
  document.getElementById('setupStepImportChoice').style.display = 'none';
  goToSyncStep();
}
function showApp() {
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  updateSyncStatusUI();
  init();
}
function boot() {
  const cfg = getConfig();
  if (cfg && cfg.token) showApp();
  else showSetup();
}
function cancelSetup() { showApp(); }

async function setupConnect() {
  const token = document.getElementById('setupToken').value.trim();
  const errEl = document.getElementById('setupError');
  errEl.style.display = 'none';
  if (!token) return;
  const prevCfg = getConfig() || {};
  saveConfig({ ...prevCfg, token });
  try {
    await fetchAllPages('/projects', {});
    document.getElementById('setupStepToken').style.display = 'none';
    document.getElementById('setupStepImportChoice').style.display = 'block';
  } catch (e) {
    errEl.textContent = 'Could not connect — double-check the token and try again.';
    errEl.style.display = 'block';
  }
}
function setupImportNo() {
  document.getElementById('setupStepImportChoice').style.display = 'none';
  goToSyncStep();
}
async function setupImportYes() {
  try {
    const projects = await fetchAllPages('/projects', {});
    if (!projects.length) { showToast('No projects found on that account', true); return; }
    const cfg = getConfig();
    document.getElementById('setupProjectSelect').innerHTML =
      projects.map(p => `<option value="${p.id}" ${cfg && p.id === cfg.projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    document.getElementById('setupStepImportChoice').style.display = 'none';
    document.getElementById('setupStepProject').style.display = 'block';
  } catch (e) {
    showToast('Could not load projects', true);
  }
}
async function setupPickProject() {
  const sel = document.getElementById('setupProjectSelect');
  const projectId = sel.value;
  const projectName = sel.options[sel.selectedIndex].textContent;
  const cfg = getConfig();
  cfg.projectId = projectId;
  cfg.projectName = projectName;
  saveConfig(cfg);
  try {
    const sectionsList = await fetchAllPages('/sections', { project_id: projectId });
    if (!sectionsList.length) { showToast('That project has no sections — pick one that does', true); return; }
    document.getElementById('setupSectionSelect').innerHTML =
      sectionsList.map(s => `<option value="${s.id}" ${cfg && s.id === cfg.sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    document.getElementById('setupStepProject').style.display = 'none';
    document.getElementById('setupStepSection').style.display = 'block';
  } catch (e) {
    showToast('Could not load sections', true);
  }
}
async function setupImportRun() {
  const sel = document.getElementById('setupSectionSelect');
  const sectionId = sel.value;
  const cfg = getConfig();
  cfg.sectionId = sectionId;
  cfg.sectionName = sel.options[sel.selectedIndex].textContent;
  saveConfig(cfg);
  try {
    const tasks = await fetchAllPages('/tasks', { section_id: sectionId });
    importTodoistChoreTasks(tasks);
    showToast('Imported from Todoist');
  } catch (e) {
    showToast('Import failed — you can try again later from Settings', true);
  }
  goToSyncStep();
}
function importTodoistChoreTasks(tasks) {
  const legacyState = loadJson(LS_LEGACY_STATE_KEY, {});
  const legacyTimelog = loadJson(LS_LEGACY_TIMELOG_KEY, {});
  const parents = tasks.filter(t => !t.parent_id);
  const childrenByParent = {};
  tasks.filter(t => t.parent_id).forEach(t => (childrenByParent[t.parent_id] = childrenByParent[t.parent_id] || []).push(t));

  const data = loadChoresData();
  const nameToCatId = {};
  data.categories.forEach(c => { nameToCatId[c.name] = c.id; });

  parents.forEach(p => {
    let catId = nameToCatId[p.content];
    if (!catId) {
      catId = genId();
      data.categories.push({ id: catId, name: p.content });
      nameToCatId[p.content] = catId;
    }
    const kids = childrenByParent[p.id] || [];
    kids.forEach(k => {
      const alreadyImported = data.chores.some(c => c.categoryId === catId && c.name === k.content);
      if (alreadyImported) return;
      const recur = guessRecurFromTodoist(k.due);
      const legacy = legacyState[k.id] || {};
      const importedDueDate = recur.recurEvery ? todayStr() : (getDueDateStr(k) || null);
      data.chores.push({
        id: genId(),
        categoryId: catId,
        name: k.content,
        notes: k.description || '',
        duration: formatDurationFromTodoist(k.duration),
        recurEvery: recur.recurEvery,
        recurUnit: recur.recurUnit,
        startDate: todayStr(),
        dueDate: importedDueDate,
        checked: !!legacy.checked,
        lastDone: legacy.lastDone || null,
        timelog: legacyTimelog[k.id] || []
      });
    });
  });
  saveChoresData(data);
}
function goToSyncStep() {
  document.getElementById('setupStepProject').style.display = 'none';
  document.getElementById('setupStepSection').style.display = 'none';
  document.getElementById('setupStepImportChoice').style.display = 'none';
  const cfg = getConfig();
  document.getElementById('setupGithubToken').value = (cfg && cfg.githubToken) || '';
  document.getElementById('enableSyncBtn').textContent = (cfg && cfg.githubToken) ? 'Reconnect' : 'Enable sync';
  document.getElementById('syncSetupError').style.display = 'none';
  document.getElementById('setupStepSync').style.display = 'block';
}
async function setupEnableSync() {
  const token = document.getElementById('setupGithubToken').value.trim();
  const errEl = document.getElementById('syncSetupError');
  errEl.style.display = 'none';
  if (!token) { setupFinish(); return; }
  try {
    const gistId = await findOrCreateSyncGist(token);
    const cfg = getConfig();
    cfg.githubToken = token;
    cfg.gistId = gistId;
    saveConfig(cfg);
    await syncNow(false);
    showToast('Sync enabled');
  } catch (e) {
    errEl.textContent = 'Could not enable sync — check the token has the "gist" scope.';
    errEl.style.display = 'block';
    return;
  }
  setupFinish();
}
function setupSkipSync() { setupFinish(); }
function setupFinish() {
  showApp();
}
function forgetSetup() {
  localStorage.removeItem(LS_CONFIG_KEY);
  document.getElementById('setupToken').value = '';
  showToast('Setup cleared on this device');
}

/* ---------------- event delegation ---------------- */

document.body.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  switch (action) {
    case 'complete': onCompleteTask(t); break;
    case 'toggle-sub': onToggleSub(t.dataset.id); break;
    case 'reset-card': onResetCard(t.dataset.id); break;
    case 'rename-cat': startRenameCategory(t.dataset.id); break;
    case 'delete-cat': armConfirm(t, () => deleteCategoryConfirmed(t.dataset.id), '🗑 Sure?'); break;
    case 'edit-task': openTaskModal(t.dataset.id); break;
    case 'show-add-category': showAddCategoryForm(); break;
    case 'submit-add-category': submitAddCategory(); break;
    case 'cancel-add-category': restoreAddCategoryButton(); break;
    case 'show-add-task': showAddTaskForm(t); break;
    case 'submit-add-task': submitAddTask(t.dataset.parent, t.closest('.add-row')); break;
    case 'cancel-add-task': renderChores(); break;
    case 'close-modal': closeModal(); break;
    case 'save-task': saveTaskFromModal(); break;
    case 'delete-task': armConfirm(t, () => deleteTaskFromModal(), 'Sure?'); break;
    case 'add-timelog': addTimelogFromModal(); break;
    case 'remove-timelog': removeTimelogEntry(parseInt(t.dataset.idx, 10)); break;
    case 'export-backup': exportBackup(); break;
    case 'show-import': toggleImportPanel(); break;
    case 'cancel-import': hideImportPanel(); break;
    case 'restore-backup': armConfirm(t, () => doRestoreBackup(), 'Overwrite? Click again'); break;
    case 'copy-export': copyExportText(); break;
    case 'open-settings': showSetup(); break;
    case 'sync-now': syncNow(true); break;
    case 'setup-connect': setupConnect(); break;
    case 'jump-to-sync': jumpToSync(); break;
    case 'setup-import-yes': setupImportYes(); break;
    case 'setup-import-no': setupImportNo(); break;
    case 'setup-pick-project': setupPickProject(); break;
    case 'setup-import-run': setupImportRun(); break;
    case 'setup-enable-sync': setupEnableSync(); break;
    case 'setup-skip-sync': setupSkipSync(); break;
    case 'cancel-setup': cancelSetup(); break;
    case 'forget-setup': armConfirm(t, () => forgetSetup(), 'Sure?'); break;
  }
});
// keyboard equivalent of a click for the custom checkbox controls (role="checkbox"),
// so task/chore toggles are operable without a mouse
document.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-action="complete"], [data-action="toggle-sub"]');
  if (!t) return;
  e.preventDefault();
  t.click();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('taskModalOverlay').classList.contains('open')) {
    closeModal();
  }
});
document.getElementById('taskModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'taskModalOverlay') closeModal();
});
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById('importText').value = reader.result; };
  reader.onerror = () => showToast('Could not read that file', true);
  reader.readAsText(file);
});
document.getElementById('modalRecurEvery').addEventListener('input', updateDueDateFieldState);
document.getElementById('modalRecurUnit').addEventListener('change', updateDueDateFieldState);

async function init() {
  document.getElementById('subtitle').textContent = 'Loading…';
  await syncNow(false);
  loadChores();
  updateSyncStatusUI();
  document.getElementById('subtitle').textContent = 'Live from Todoist · last refreshed ' + new Date().toLocaleTimeString();
  await loadTasks();
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
