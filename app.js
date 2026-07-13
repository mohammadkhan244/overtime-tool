/* ================================================================
   STATE
   _data is the in-memory cache populated from Vercel KV on load.
   All renders read synchronously from _data; writes debounce to KV.
================================================================ */

const _defaults = {
  shifts:   [],
  salary:   { gross: 0, net: 0 },
  ptoBank:  { initialBalance: 0, taken: [] },
  settings: { ptoRatio: 1, otMultipliers: [1.5, 2], weekendBonusFlat: 0 },
};

let _data       = JSON.parse(JSON.stringify(_defaults));
let _isFirstRun = false;  // true if KV empty AND no local data to migrate
let _loadError  = null;   // string or null — API failure, not empty state
let _saveTimer  = null;   // debounce handle for KV writes

let _editingShiftId = null;  // id of shift open in inline edit form
let _editRows       = [];    // single-element mirror of _shiftRows for edit state
let _editingPTOId   = null;  // id of PTO entry open in inline edit form

/* ================================================================
   KV API LAYER  — GET to load, POST to save via /api/data
================================================================ */

// Debounce writes so rapid successive saves (e.g. adding multiple shifts)
// collapse into one network request after 800 ms of silence.
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, 800);
}

async function flushSave() {
  try {
    const res = await fetch('/api/data', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        shifts:   _data.shifts,
        salary:   _data.salary,
        ptoBank:  _data.ptoBank,
        settings: _data.settings,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('[OTTracker] Save failed:', err);
    showToast('⚠ Save failed — check your connection');
  }
}

// Called once at startup. Populates _data from KV, or migrates local data.
async function fetchFromAPI() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const serverData = await res.json();

    if (serverData && Array.isArray(serverData.shifts)) {
      // KV has data — use it
      _data.shifts   = serverData.shifts   ?? _defaults.shifts;
      _data.salary   = serverData.salary   ?? _defaults.salary;
      _data.ptoBank  = serverData.ptoBank  ?? _defaults.ptoBank;
      _data.settings = serverData.settings ?? _defaults.settings;
    } else {
      // KV is empty — one-time migration from IDB/localStorage, then push to KV
      const migrated = await migrateLocalToKV();
      _isFirstRun = !migrated;
    }
  } catch (err) {
    console.error('[OTTracker] API fetch failed:', err);
    _loadError  = 'Could not reach server. Check your connection and reload.';
    _isFirstRun = true;
    readLocalFallback(); // best-effort: show any cached local data
  }
}

// One-time migration: IDB → KV, then localStorage → KV.
// Returns true if any data was found and pushed.
async function migrateLocalToKV() {
  let found = false;

  // Prefer IDB (the previous storage engine for this app)
  try {
    const idbData = await readFromIDB();
    if (idbData) { Object.assign(_data, idbData); found = true; }
  } catch {}

  // Fall back to raw localStorage
  if (!found) {
    for (const key of Object.keys(_defaults)) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) { _data[key] = JSON.parse(raw); found = true; }
      } catch {}
    }
  }

  if (found) {
    await flushSave(); // push immediately (not debounced)
    ['shifts','salary','ptoBank','settings'].forEach(k => localStorage.removeItem(k));
    console.log('[OTTracker] Migrated local data → KV');
  }
  return found;
}

// Read all four keys from the previous IndexedDB store in one shot.
function readFromIDB() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('OTTracker', 1);
      req.onupgradeneeded = () => resolve(null); // fresh DB → nothing to migrate
      req.onerror         = () => resolve(null);
      req.onsuccess = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('keyval')) { db.close(); resolve(null); return; }
        const tx    = db.transaction('keyval', 'readonly');
        const store = tx.objectStore('keyval');
        const keys  = Object.keys(_defaults);
        const out   = {};
        let pending = keys.length, found = false;
        for (const key of keys) {
          const r = store.get(key);
          r.onsuccess = ev => {
            if (ev.target.result !== undefined) { out[key] = ev.target.result; found = true; }
            if (--pending === 0) { db.close(); resolve(found ? out : null); }
          };
          r.onerror = () => { if (--pending === 0) { db.close(); resolve(found ? out : null); } };
        }
      };
    } catch { resolve(null); }
  });
}

// Silent best-effort local read used only when /api/data is unreachable.
function readLocalFallback() {
  try {
    const idbReq = indexedDB.open('OTTracker', 1);
    idbReq.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('keyval')) return;
      const tx = db.transaction('keyval', 'readonly');
      for (const key of Object.keys(_defaults)) {
        const r = tx.objectStore('keyval').get(key);
        r.onsuccess = ev => { if (ev.target.result !== undefined) _data[key] = ev.target.result; };
      }
    };
  } catch {}
  for (const key of Object.keys(_defaults)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw && _data[key] === _defaults[key]) _data[key] = JSON.parse(raw);
    } catch {}
  }
}

/* ================================================================
   SYNCHRONOUS GETTERS/SETTERS  (read from cache, write → cache + KV)
================================================================ */

function getShifts()    { return _data.shifts;   }
function getSalary()    { return _data.salary;   }
function getPtoBank()   { return _data.ptoBank;  }
function getSettings()  { return _data.settings; }

function saveShifts(s)  { _data.shifts   = s; scheduleSave(); }
function saveSalary(s)  { _data.salary   = s; scheduleSave(); }
function savePtoBank(p) { _data.ptoBank  = p; scheduleSave(); }
function saveSettings(s){ _data.settings = s; scheduleSave(); }

/* ================================================================
   EXPORT / IMPORT
================================================================ */

function exportData() {
  const payload = JSON.stringify({
    version:    1,
    exportedAt: new Date().toISOString(),
    shifts:     _data.shifts,
    salary:     _data.salary,
    ptoBank:    _data.ptoBank,
    settings:   _data.settings,
  }, null, 2);

  const blob = new Blob([payload], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ot-tracker-${localDateKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

function importData() {
  const input   = document.createElement('input');
  input.type    = 'file';
  input.accept  = '.json,application/json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.shifts)) throw new Error('Missing shifts array');

      _data.shifts   = parsed.shifts   ?? _defaults.shifts;
      _data.salary   = parsed.salary   ?? _defaults.salary;
      _data.ptoBank  = parsed.ptoBank  ?? _defaults.ptoBank;
      _data.settings = parsed.settings ?? _defaults.settings;

      clearTimeout(_saveTimer); await flushSave();

      // Clear any prior error state
      _loadError  = null;
      _isFirstRun = false;
      document.getElementById('error-banner').hidden = true;

      showToast('Data imported successfully');
      renderScreen(_activeScreen);
    } catch (err) {
      console.error('[OTTracker] Import failed:', err);
      showToast('Import failed — invalid or corrupt file');
    }
  };
  input.click();
}

/* ================================================================
   ERROR BANNER
================================================================ */

function dismissError() {
  document.getElementById('error-banner').hidden = true;
}

// Used in list renders to avoid conflating load errors with empty state
function emptyState(defaultMsg) {
  if (!_isFirstRun && _loadError) {
    return `<div class="empty" style="color:var(--warning)">⚠ Data may not have loaded — see the banner above.</div>`;
  }
  return `<div class="empty">${defaultMsg}</div>`;
}

/* ================================================================
   DATE HELPERS
================================================================ */

function localDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function todayKey() { return localDateKey(new Date()); }

function weekStartKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
  return localDateKey(d);
}

function weekEndKey(startKey) {
  const d = new Date(startKey + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return localDateKey(d);
}

function fmtDate(dateOrKey) {
  const d = typeof dateOrKey === 'string' ? new Date(dateOrKey + 'T00:00:00') : new Date(dateOrKey);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateShort(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateTime(isoStr) {
  return new Date(isoStr).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtHours(h) {
  if (!h || isNaN(h)) return '0h';
  const hrs  = Math.floor(Math.abs(h));
  const mins = Math.round((Math.abs(h) - hrs) * 60);
  const sign = h < 0 ? '-' : '';
  return mins === 0 ? `${sign}${hrs}h` : `${sign}${hrs}h ${mins}m`;
}

function fmtMoney(n) {
  if (!n || isNaN(n)) return '$0.00';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toLocalDTStr(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/* ================================================================
   SHIFT SPLITTING
================================================================ */

function splitShiftByDay(shift) {
  const start    = new Date(shift.startISO);
  const end      = new Date(shift.endISO);
  const segments = [];
  let cursor     = new Date(start);

  while (cursor < end) {
    const nextDay = new Date(cursor);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    const segEnd = nextDay <= end ? nextDay : end;
    const hours  = (segEnd - cursor) / 3600000;

    if (hours > 0.0001) {
      const dk = localDateKey(cursor);
      segments.push({ dateKey: dk, hours, dayOfWeek: cursor.getDay(), weekKey: weekStartKey(dk) });
    }
    cursor = nextDay;
  }
  return segments;
}

function getAllSegments(shifts) {
  return shifts.flatMap(s => splitShiftByDay(s));
}

/* ================================================================
   WEEK COMPUTATION
================================================================ */

function computeWeeks(segments) {
  const weeks = {};
  for (const seg of segments) {
    if (!weeks[seg.weekKey]) weeks[seg.weekKey] = { totalHours: 0, hasWeekend: false };
    weeks[seg.weekKey].totalHours += seg.hours;
    if (seg.dayOfWeek === 0 || seg.dayOfWeek === 6) weeks[seg.weekKey].hasWeekend = true;
  }
  return weeks;
}

/* ================================================================
   PERIOD FILTER
================================================================ */

function filterSegmentsByPeriod(segments, period) {
  if (period === 'all') return segments;
  const now = new Date();
  let startKey;
  if (period === 'week')       startKey = weekStartKey(localDateKey(now));
  else if (period === 'month') startKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  else if (period === 'year')  startKey = `${now.getFullYear()}-01-01`;
  return segments.filter(s => s.dateKey >= startKey);
}

/* ================================================================
   STATS
================================================================ */

function computeHourlyRate(allSegments, salary) {
  const weeksWorked = Object.keys(computeWeeks(allSegments)).length;
  if (weeksWorked === 0 || salary.gross === 0) return { gross: 0, net: 0 };
  return { gross: salary.gross / weeksWorked / 40, net: salary.net / weeksWorked / 40 };
}

function computePeriodStats(periodSegments, allSegments, salary, settings) {
  const weeks      = computeWeeks(periodSegments);
  const hourlyRate = computeHourlyRate(allSegments, salary);
  const netRatio   = salary.gross > 0 ? salary.net / salary.gross : 0;

  let totalHours = 0, totalOT = 0, totalPTO = 0, weekendWeeks = 0;
  const moneyFG  = {};
  settings.otMultipliers.forEach(m => { moneyFG[m] = { gross: 0, net: 0 }; });

  for (const wk of Object.values(weeks)) {
    totalHours += wk.totalHours;
    const ot    = Math.max(0, wk.totalHours - 40);
    totalOT    += ot;
    totalPTO   += ot * settings.ptoRatio;
    for (const m of settings.otMultipliers) {
      moneyFG[m].gross += ot * hourlyRate.gross * m;
      moneyFG[m].net   += ot * hourlyRate.net   * m;
    }
    if (wk.hasWeekend) weekendWeeks++;
  }

  return {
    weeks, totalHours, totalOT, totalPTO, hourlyRate, moneyFG,
    weekendFG: {
      gross: weekendWeeks * settings.weekendBonusFlat,
      net:   weekendWeeks * settings.weekendBonusFlat * netRatio,
    },
  };
}

function computePTOBalance(allSegments, ptoBank, settings) {
  const weeks  = computeWeeks(allSegments);
  let totalOT  = 0;
  for (const wk of Object.values(weeks)) totalOT += Math.max(0, wk.totalHours - 40);
  const earned = totalOT * settings.ptoRatio;
  const taken  = ptoBank.taken.reduce((s, t) => s + t.hours, 0);
  return { earned, taken, balance: ptoBank.initialBalance + earned - taken };
}

/* ================================================================
   TOAST
================================================================ */

let _toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/* ================================================================
   NAVIGATION
================================================================ */

let _activeScreen = 'log';

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  document.querySelector(`.nav-btn[data-screen="${name}"]`).classList.add('active');
  _activeScreen = name;
  renderScreen(name);
}

function renderScreen(name) {
  if      (name === 'log')       renderShiftList();
  else if (name === 'dashboard') renderDashboard();
  else if (name === 'pto')       renderPTO();
  else if (name === 'settings')  renderSettings();
}

/* ================================================================
   LOG SCREEN
================================================================ */

let _shiftRows = [];

function defaultStart() {
  const d = new Date(); d.setMinutes(0, 0, 0); return toLocalDTStr(d);
}
function defaultEnd(startVal) {
  const d = new Date(startVal); d.setHours(d.getHours() + 8, 0, 0, 0); return toLocalDTStr(d);
}
function shiftHours(row) {
  if (!row.startVal || !row.endVal) return 0;
  const diff = (new Date(row.endVal) - new Date(row.startVal)) / 3600000;
  return diff > 0 ? diff : 0;
}

/* ================================================================
   CALENDAR PICKER
   Date-only popup; time stays as <input type="time">.
   Internal row values remain 'YYYY-MM-DDTHH:MM' strings throughout.
================================================================ */

function valToDate(val) { return val ? val.slice(0, 10) : ''; }
function valToTime(val) { return val ? val.slice(11, 16) : '00:00'; }
function buildVal(date, time) { return `${date}T${time}`; }

function fmtDateBtn(dateStr) {
  if (!dateStr) return 'Select date';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function maybeAdjustEnd(i, rows = _shiftRows) {
  if (rows[i].startVal && rows[i].endVal) {
    if (new Date(rows[i].endVal) <= new Date(rows[i].startVal)) {
      rows[i].endVal = defaultEnd(rows[i].startVal);
    }
  }
}

const _cal = { target: null, year: null, month: null };

function _calEscClose(e) { if (e.key === 'Escape') closeCalendar(); }

function openCalendar(rowIdx, field, source = 'log') {
  closeCalendar();
  const rows   = source === 'edit' ? _editRows : _shiftRows;
  const cur    = rows[rowIdx][field];
  const d      = cur ? new Date(cur) : new Date();
  _cal.target  = { i: rowIdx, field, source };
  _cal.year    = d.getFullYear();
  _cal.month   = d.getMonth();

  const overlay = document.createElement('div');
  overlay.className = 'cal-overlay';
  overlay.id = 'cal-overlay';
  overlay.innerHTML = '<div class="cal-popup" id="cal-popup"></div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCalendar(); });
  document.addEventListener('keydown', _calEscClose);
  renderCalGrid();
}

function closeCalendar() {
  document.getElementById('cal-overlay')?.remove();
  document.removeEventListener('keydown', _calEscClose);
  _cal.target = null;
}

function renderCalGrid() {
  const popup = document.getElementById('cal-popup');
  if (!popup || !_cal.target) return;

  const _calRows = _cal.target.source === 'edit' ? _editRows : _shiftRows;
  const selKey   = valToDate(_calRows[_cal.target.i][_cal.target.field]);
  const todKey = localDateKey(new Date());

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const DOWS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const firstDow    = new Date(_cal.year, _cal.month, 1).getDay();
  const daysInMonth = new Date(_cal.year, _cal.month + 1, 0).getDate();
  let cells = '';

  // Trailing days from the previous month
  for (let d = firstDow - 1; d >= 0; d--) {
    const dt = new Date(_cal.year, _cal.month, -d);
    cells += `<button class="cal-day cal-other" data-date="${localDateKey(dt)}">${dt.getDate()}</button>`;
  }
  // Days of the current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dt  = new Date(_cal.year, _cal.month, d);
    const key = localDateKey(dt);
    let cls   = 'cal-day';
    if (key === selKey) cls += ' cal-selected';
    if (key === todKey) cls += ' cal-today';
    cells += `<button class="${cls}" data-date="${key}">${d}</button>`;
  }
  // Leading days from the next month to fill the last row
  const used      = firstDow + daysInMonth;
  const remainder = used % 7 === 0 ? 0 : 7 - (used % 7);
  for (let d = 1; d <= remainder; d++) {
    const dt = new Date(_cal.year, _cal.month + 1, d);
    cells += `<button class="cal-day cal-other" data-date="${localDateKey(dt)}">${d}</button>`;
  }

  popup.innerHTML = `
    <div class="cal-header">
      <button class="cal-nav" id="cal-prev">‹</button>
      <span class="cal-title">${MONTHS[_cal.month]} ${_cal.year}</span>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-dow">${DOWS.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;

  popup.querySelector('#cal-prev').addEventListener('click', e => {
    e.stopPropagation();
    if (--_cal.month < 0) { _cal.month = 11; _cal.year--; }
    renderCalGrid();
  });
  popup.querySelector('#cal-next').addEventListener('click', e => {
    e.stopPropagation();
    if (++_cal.month > 11) { _cal.month = 0; _cal.year++; }
    renderCalGrid();
  });
  popup.querySelectorAll('.cal-day').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { i, field, source } = _cal.target;
      const rows = source === 'edit' ? _editRows : _shiftRows;
      rows[i][field] = buildVal(btn.dataset.date, valToTime(rows[i][field]));
      maybeAdjustEnd(i, rows);
      closeCalendar();
      if (source === 'edit') renderShiftList();
      else buildShiftRowsUI();
    });
  });
}

/* ================================================================
   LOG SCREEN - shift row builder
================================================================ */

function buildShiftRowsUI() {
  const container = document.getElementById('shift-rows');
  container.innerHTML = '';

  _shiftRows.forEach((row, i) => {
    const h     = shiftHours(row);
    const label = _shiftRows.length > 1 ? `Shift ${i + 1}` : 'Shift';
    const div   = document.createElement('div');
    div.className = 'shift-row';
    div.innerHTML = `
      <div class="shift-row-header">
        <span class="shift-row-num">${label}</span>
        <span class="shift-row-computed">${h > 0 ? fmtHours(h) : '—'}</span>
        ${_shiftRows.length > 1 ? `<button class="shift-row-remove" data-remove="${i}" title="Remove">✕</button>` : ''}
      </div>
      <div class="shift-dt-pair">
        <span class="shift-dt-label">Start</span>
        <div class="dt-group">
          <button class="date-pick-btn" data-i="${i}" data-field="startVal">${fmtDateBtn(valToDate(row.startVal))}</button>
          <input type="time" class="time-pick-inp" value="${valToTime(row.startVal)}"
                 data-i="${i}" data-field="startVal">
        </div>
      </div>
      <div class="shift-dt-pair">
        <span class="shift-dt-label">End</span>
        <div class="dt-group">
          <button class="date-pick-btn" data-i="${i}" data-field="endVal">${fmtDateBtn(valToDate(row.endVal))}</button>
          <input type="time" class="time-pick-inp" value="${valToTime(row.endVal)}"
                 data-i="${i}" data-field="endVal">
        </div>
      </div>`;
    container.appendChild(div);
  });

  // Date button → open calendar overlay
  container.querySelectorAll('.date-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => openCalendar(+btn.dataset.i, btn.dataset.field));
  });

  // Time input → update time portion of the stored value
  container.querySelectorAll('.time-pick-inp').forEach(input => {
    input.addEventListener('change', e => {
      const i     = +e.target.dataset.i;
      const field = e.target.dataset.field;
      const date  = valToDate(_shiftRows[i][field]) || localDateKey(new Date());
      _shiftRows[i][field] = buildVal(date, e.target.value);
      maybeAdjustEnd(i);
      buildShiftRowsUI();
    });
  });

  container.querySelectorAll('.shift-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      _shiftRows.splice(+e.target.dataset.remove, 1);
      buildShiftRowsUI();
    });
  });
}

function initLog() {
  const s = defaultStart();
  _shiftRows = [{ startVal: s, endVal: defaultEnd(s) }];
  buildShiftRowsUI();

  document.getElementById('add-shift-btn').addEventListener('click', () => {
    const lastEnd = _shiftRows[_shiftRows.length - 1].endVal || defaultStart();
    _shiftRows.push({ startVal: lastEnd, endVal: defaultEnd(lastEnd) });
    buildShiftRowsUI();
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    const valid = _shiftRows.filter(r => r.startVal && r.endVal && shiftHours(r) > 0);
    if (valid.length === 0) { showToast('End must be after start'); return; }

    const shifts = getShifts();
    for (const r of valid) {
      shifts.push({
        id:       `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        startISO: new Date(r.startVal).toISOString(),
        endISO:   new Date(r.endVal).toISOString(),
      });
    }
    saveShifts(shifts);

    const fresh = defaultStart();
    _shiftRows = [{ startVal: fresh, endVal: defaultEnd(fresh) }];
    buildShiftRowsUI();
    renderShiftList();
    showToast(valid.length === 1 ? 'Shift saved' : `${valid.length} shifts saved`);
  });

  renderShiftList();
}

function renderShiftList() {
  const shifts = getShifts();
  const list   = document.getElementById('entries-list');

  if (shifts.length === 0) {
    list.innerHTML = emptyState('No shifts logged yet. Log your first shift above.');
    return;
  }

  const sorted = [...shifts].sort((a, b) => b.startISO.localeCompare(a.startISO));
  let html = '', lastMonth = '';

  for (const sh of sorted.slice(0, 60)) {
    const segs       = splitShiftByDay(sh);
    const total      = segs.reduce((s, g) => s + g.hours, 0);
    const spans      = segs.length > 1 ? ` · ${segs.length} days` : '';
    const monthLabel = new Date(sh.startISO).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (monthLabel !== lastMonth) {
      if (lastMonth) html += '</div>';
      html += `<div class="entry-group"><div class="entry-group-date">${monthLabel}</div>`;
      lastMonth = monthLabel;
    }
    if (sh.id === _editingShiftId) {
      const h = shiftHours(_editRows[0]);
      html += `
        <div class="entry-item-edit">
          <div class="shift-row-header">
            <span class="shift-row-num">Edit Shift</span>
            <span class="shift-row-computed">${h > 0 ? fmtHours(h) : '—'}</span>
          </div>
          <div class="shift-dt-pair">
            <span class="shift-dt-label">Start</span>
            <div class="dt-group">
              <button class="date-pick-btn" onclick="openCalendar(0,'startVal','edit')">${fmtDateBtn(valToDate(_editRows[0].startVal))}</button>
              <input type="time" class="time-pick-inp edit-time-inp" data-field="startVal" value="${valToTime(_editRows[0].startVal)}">
            </div>
          </div>
          <div class="shift-dt-pair">
            <span class="shift-dt-label">End</span>
            <div class="dt-group">
              <button class="date-pick-btn" onclick="openCalendar(0,'endVal','edit')">${fmtDateBtn(valToDate(_editRows[0].endVal))}</button>
              <input type="time" class="time-pick-inp edit-time-inp" data-field="endVal" value="${valToTime(_editRows[0].endVal)}">
            </div>
          </div>
          <div class="edit-actions">
            <button class="btn btn-primary" onclick="saveEditShift()">Save</button>
            <button class="btn btn-ghost" onclick="cancelEditShift()">Cancel</button>
          </div>
        </div>`;
    } else {
      html += `
        <div class="entry-item">
          <div class="entry-info">
            <div class="entry-day">${fmtDateTime(sh.startISO)} → ${fmtDateTime(sh.endISO)}</div>
            <div class="entry-hours">${fmtHours(total)}${spans}</div>
          </div>
          <div class="entry-actions">
            <button class="btn btn-ghost btn-sm" onclick="startEditShift('${sh.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteShift('${sh.id}')">Delete</button>
          </div>
        </div>`;
    }
  }
  if (lastMonth) html += '</div>';
  list.innerHTML = html;
  list.querySelectorAll('.edit-time-inp').forEach(input => {
    input.addEventListener('change', e => {
      const field = e.target.dataset.field;
      const date  = valToDate(_editRows[0][field]) || localDateKey(new Date());
      _editRows[0][field] = buildVal(date, e.target.value);
      maybeAdjustEnd(0, _editRows);
      renderShiftList();
    });
  });
}

function startEditShift(id) {
  const sh = getShifts().find(s => s.id === id);
  if (!sh) return;
  closeCalendar();
  _editingShiftId = id;
  _editRows = [{ startVal: toLocalDTStr(new Date(sh.startISO)), endVal: toLocalDTStr(new Date(sh.endISO)) }];
  renderShiftList();
}

function cancelEditShift() {
  _editingShiftId = null;
  _editRows = [];
  closeCalendar();
  renderShiftList();
}

function saveEditShift() {
  const row = _editRows[0];
  if (!row || !row.startVal || !row.endVal || shiftHours(row) <= 0) {
    showToast('End must be after start');
    return;
  }
  const shifts = getShifts();
  const idx = shifts.findIndex(s => s.id === _editingShiftId);
  if (idx === -1) return;
  shifts[idx].startISO = new Date(row.startVal).toISOString();
  shifts[idx].endISO   = new Date(row.endVal).toISOString();
  saveShifts(shifts);
  _editingShiftId = null;
  _editRows = [];
  renderShiftList();
  showToast('Shift updated');
}

function deleteShift(id) {
  if (_editingShiftId === id) { _editingShiftId = null; _editRows = []; }
  saveShifts(getShifts().filter(s => s.id !== id));
  renderShiftList();
  showToast('Shift deleted');
}

/* ================================================================
   DASHBOARD
================================================================ */

let _dashPeriod = 'week';

function initDashboard() {
  document.getElementById('period-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _dashPeriod = btn.dataset.period;
    renderDashboard();
  });
}

function renderDashboard() {
  const salary     = getSalary();
  const settings   = getSettings();
  const allSegs    = getAllSegments(getShifts());
  const periodSegs = filterSegmentsByPeriod(allSegs, _dashPeriod);
  const stats      = computePeriodStats(periodSegs, allSegs, salary, settings);
  const hasRate    = salary.gross > 0 && Object.keys(computeWeeks(allSegs)).length > 0;

  let multiplierHTML = '';
  for (const m of settings.otMultipliers) {
    const fg = stats.moneyFG[m] || { gross: 0, net: 0 };
    multiplierHTML += `
      <div class="money-row">
        <span class="money-label">${m}× OT pay</span>
        <div class="money-values">
          <div class="money-gross">${fmtMoney(fg.gross)}</div>
          ${salary.net > 0 ? `<div class="money-net">${fmtMoney(fg.net)} after tax</div>` : ''}
        </div>
      </div>`;
  }
  if (settings.weekendBonusFlat > 0) {
    multiplierHTML += `
      <div class="money-row">
        <span class="money-label">Weekend bonus potential</span>
        <div class="money-values">
          <div class="money-gross">${fmtMoney(stats.weekendFG.gross)}</div>
          ${salary.net > 0 ? `<div class="money-net">${fmtMoney(stats.weekendFG.net)} after tax</div>` : ''}
        </div>
      </div>`;
  }

  const noMoneyNote = hasRate
    ? '' : '<div class="empty" style="padding:0.75rem 0">Set salary in Settings to see money figures.</div>';
  const hourlyNote  = hasRate
    ? `<div class="stat-sub" style="margin-top:0.6rem">Effective rate: gross ${fmtMoney(stats.hourlyRate.gross)}/hr · net ${fmtMoney(stats.hourlyRate.net)}/hr</div>`
    : '';

  document.getElementById('dashboard-content').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Hours Worked</div>
        <div class="stat-value">${fmtHours(stats.totalHours)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Overtime</div>
        <div class="stat-value c-accent">${fmtHours(stats.totalOT)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">PTO Earned</div>
        <div class="stat-value c-success">${fmtHours(stats.totalPTO)}</div>
      </div>
    </div>
    <div class="card">
      <h2 class="card-heading">Money Foregone (OT pay you didn't receive)</h2>
      ${hasRate ? multiplierHTML : noMoneyNote}
      ${hourlyNote}
    </div>
    <div class="card">
      <h2 class="card-heading">By Week</h2>
      ${renderWeekBreakdown(stats.weeks)}
    </div>`;
}

function renderWeekBreakdown(weeks) {
  const entries = Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0]));
  if (entries.length === 0) return emptyState('No shifts in this period.');
  return entries.map(([wk, data]) => {
    const ot = Math.max(0, data.totalHours - 40);
    return `
      <div class="week-item">
        <div class="week-range">${fmtDateShort(wk)} – ${fmtDateShort(weekEndKey(wk))}</div>
        <div class="week-stats">
          <span class="week-total">${fmtHours(data.totalHours)}</span>
          ${ot > 0 ? `<span class="week-ot">+${fmtHours(ot)} OT</span>` : ''}
          ${data.hasWeekend ? `<span class="week-wknd">⚡ Weekend</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

/* ================================================================
   PTO SCREEN
================================================================ */

function renderPTO() {
  const allSegs  = getAllSegments(getShifts());
  const ptoBank  = getPtoBank();
  const settings = getSettings();
  const pto      = computePTOBalance(allSegs, ptoBank, settings);

  const taken    = [...ptoBank.taken].sort((a, b) => b.date.localeCompare(a.date));
  const histHTML = taken.length === 0
    ? emptyState('No PTO taken yet.')
    : taken.map(t => {
        if (t.id === _editingPTOId) {
          return `
            <div class="entry-item-edit" style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.3rem">
              <div style="flex:1;min-width:0">
                <input type="date" class="pto-edit-date" value="${t.date}" style="margin-bottom:0.35rem">
                <input type="number" class="pto-edit-hrs" min="0.5" max="24" step="0.5" value="${t.hours}">
              </div>
              <div class="entry-actions">
                <button class="btn btn-primary btn-sm" onclick="saveEditPTO('${t.id}')">Save</button>
                <button class="btn btn-ghost btn-sm" onclick="cancelEditPTO()">Cancel</button>
              </div>
            </div>`;
        }
        return `
          <div class="entry-item" style="margin-bottom:0.3rem">
            <div>
              <div class="entry-day">${fmtDate(t.date)}</div>
              <div class="entry-hours">${fmtHours(t.hours)}</div>
            </div>
            <div class="entry-actions">
              <button class="btn btn-ghost btn-sm" onclick="startEditPTO('${t.id}')">Edit</button>
              <button class="btn btn-danger" onclick="deletePTOTaken('${t.id}')">Delete</button>
            </div>
          </div>`;
      }).join('');

  document.getElementById('pto-content').innerHTML = `
    <div class="card">
      <div class="pto-balance-card">
        <div class="pto-balance-value">${fmtHours(pto.balance)}</div>
        <div class="pto-balance-label">PTO Balance</div>
        <div class="pto-breakdown">
          <div class="pto-bp-item">
            <div class="pto-bp-val">${fmtHours(ptoBank.initialBalance)}</div>
            <div class="pto-bp-lbl">Starting</div>
          </div>
          <div class="pto-bp-item">
            <div class="pto-bp-val" style="color:var(--success)">+${fmtHours(pto.earned)}</div>
            <div class="pto-bp-lbl">Earned</div>
          </div>
          <div class="pto-bp-item">
            <div class="pto-bp-val" style="color:var(--accent)">−${fmtHours(pto.taken)}</div>
            <div class="pto-bp-lbl">Used</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <h2 class="card-heading">Log PTO Used</h2>
      <div class="settings-row">
        <label class="settings-label" for="pto-date-inp">Date</label>
        <input type="date" id="pto-date-inp" value="${todayKey()}" style="width:145px">
      </div>
      <div class="settings-row">
        <label class="settings-label" for="pto-hrs-inp">Hours</label>
        <input type="number" id="pto-hrs-inp" min="0.5" max="24" step="0.5" value="8" style="width:100px">
      </div>
      <button class="btn btn-primary mt-1" id="pto-save-btn">Log PTO</button>
    </div>
    <div class="card">
      <h2 class="card-heading">PTO History</h2>
      ${histHTML}
    </div>`;

  document.getElementById('pto-save-btn').addEventListener('click', () => {
    const date  = document.getElementById('pto-date-inp').value;
    const hours = parseFloat(document.getElementById('pto-hrs-inp').value);
    if (!date || isNaN(hours) || hours <= 0) { showToast('Invalid entry'); return; }
    const bank = getPtoBank();
    bank.taken.push({ id: `pto-${Date.now()}`, date, hours });
    savePtoBank(bank);
    showToast('PTO logged');
    renderPTO();
  });
}

function startEditPTO(id) {
  _editingPTOId = id;
  renderPTO();
}

function cancelEditPTO() {
  _editingPTOId = null;
  renderPTO();
}

function saveEditPTO(id) {
  const dateEl = document.querySelector('.pto-edit-date');
  const hrsEl  = document.querySelector('.pto-edit-hrs');
  if (!dateEl || !hrsEl) return;
  const date  = dateEl.value;
  const hours = parseFloat(hrsEl.value);
  if (!date || isNaN(hours) || hours <= 0) { showToast('Invalid entry'); return; }
  const bank  = getPtoBank();
  const entry = bank.taken.find(t => t.id === id);
  if (!entry) return;
  entry.date  = date;
  entry.hours = hours;
  savePtoBank(bank);
  _editingPTOId = null;
  renderPTO();
  showToast('PTO entry updated');
}

function deletePTOTaken(id) {
  if (_editingPTOId === id) _editingPTOId = null;
  const bank = getPtoBank();
  bank.taken = bank.taken.filter(t => t.id !== id);
  savePtoBank(bank);
  renderPTO();
  showToast('Entry removed');
}

/* ================================================================
   SETTINGS SCREEN
================================================================ */

function renderSettings() {
  const salary   = getSalary();
  const ptoBank  = getPtoBank();
  const settings = getSettings();

  const multiplierItems = settings.otMultipliers.map((m, i) => `
    <div class="multiplier-item">
      <span>${m}×</span>
      ${settings.otMultipliers.length > 1
        ? `<button class="btn btn-danger btn-sm" onclick="removeMultiplier(${i})">Remove</button>`
        : '<span style="color:var(--text-muted);font-size:0.75rem">minimum 1</span>'}
    </div>`).join('');

  document.getElementById('settings-content').innerHTML = `
    <div class="card">
      <h2 class="card-heading">Salary</h2>
      <div class="settings-row">
        <label class="settings-label" for="s-gross">Gross Annual ($)</label>
        <input type="number" id="s-gross" value="${salary.gross}" min="0" step="1000" placeholder="0">
      </div>
      <div class="settings-row">
        <label class="settings-label" for="s-net">Net Annual ($)</label>
        <input type="number" id="s-net" value="${salary.net}" min="0" step="1000" placeholder="0">
      </div>
      <button class="btn btn-primary mt-1" onclick="saveSalarySettings()">Save Salary</button>
    </div>

    <div class="card">
      <h2 class="card-heading">PTO</h2>
      <div class="settings-row">
        <label class="settings-label" for="s-pto-init">Starting Balance (hrs)</label>
        <input type="number" id="s-pto-init" value="${ptoBank.initialBalance}" min="0" step="1" placeholder="0">
      </div>
      <div class="settings-row">
        <label class="settings-label" for="s-pto-ratio">PTO hrs earned per OT hr</label>
        <input type="number" id="s-pto-ratio" value="${settings.ptoRatio}" min="0" max="2" step="0.1" placeholder="1">
      </div>
      <button class="btn btn-primary mt-1" onclick="savePTOSettings()">Save PTO Settings</button>
    </div>

    <div class="card">
      <h2 class="card-heading">OT Multipliers</h2>
      ${multiplierItems}
      <div class="add-multiplier-row">
        <input type="number" id="s-new-mult" min="1" max="10" step="0.25" placeholder="e.g. 3">
        <button class="btn btn-ghost btn-sm" onclick="addMultiplier()">+ Add</button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-heading">Weekend Bonus</h2>
      <div class="settings-row">
        <label class="settings-label" for="s-wknd">Flat $ per weekend worked</label>
        <input type="number" id="s-wknd" value="${settings.weekendBonusFlat}" min="0" step="50" placeholder="0">
      </div>
      <button class="btn btn-primary mt-1" onclick="saveWeekendBonus()">Save</button>
      <p style="font-size:0.72rem;color:var(--text-muted);margin-top:0.5rem">
        Any week with hours on Sat or Sun counts as one weekend — not per day.
      </p>
    </div>

    <div class="card">
      <h2 class="card-heading">Data Backup</h2>
      <button class="btn btn-ghost" onclick="exportData()">⬇ Export Data (JSON)</button>
      <button class="btn btn-ghost mt-1" onclick="importData()">⬆ Import Data (JSON)</button>
      <p style="font-size:0.72rem;color:var(--text-muted);margin-top:0.6rem">
        Export a backup periodically. Import replaces all current data with the file contents.
      </p>
    </div>`;
}

function saveSalarySettings() {
  saveSalary({
    gross: parseFloat(document.getElementById('s-gross').value) || 0,
    net:   parseFloat(document.getElementById('s-net').value)   || 0,
  });
  showToast('Salary saved');
}

function savePTOSettings() {
  const bank = getPtoBank();
  bank.initialBalance = parseFloat(document.getElementById('s-pto-init').value) || 0;
  savePtoBank(bank);
  const s = getSettings();
  s.ptoRatio = parseFloat(document.getElementById('s-pto-ratio').value) || 1;
  saveSettings(s);
  showToast('PTO settings saved');
}

function addMultiplier() {
  const val = parseFloat(document.getElementById('s-new-mult').value);
  if (!val || val <= 0) { showToast('Enter a valid multiplier'); return; }
  const s = getSettings();
  if (!s.otMultipliers.includes(val)) {
    s.otMultipliers.push(val);
    s.otMultipliers.sort((a, b) => a - b);
    saveSettings(s);
  }
  renderSettings();
}

function removeMultiplier(index) {
  const s = getSettings();
  s.otMultipliers.splice(index, 1);
  saveSettings(s);
  renderSettings();
}

function saveWeekendBonus() {
  const s = getSettings();
  s.weekendBonusFlat = parseFloat(document.getElementById('s-wknd').value) || 0;
  saveSettings(s);
  showToast('Weekend bonus saved');
}

/* ================================================================
   INIT
================================================================ */

async function init() {
  // Populate _data from KV before any render
  await fetchFromAPI();

  // Hide loading screen
  const loading = document.getElementById('loading-screen');
  if (loading) loading.hidden = true;

  // Show error banner if API failed
  if (_loadError) {
    document.getElementById('error-banner-msg').textContent = `⚠ ${_loadError}`;
    document.getElementById('error-banner').hidden = false;
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  initLog();
  initDashboard();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
