/* ================================================================
   STORAGE
   entries: [{ id, date:'YYYY-MM-DD', hours:number }]
   salary:  { gross:number, net:number }
   ptoBank: { initialBalance:number, taken:[{ id, date, hours }] }
   settings:{ ptoRatio, otMultipliers:[], weekendBonusFlat }
================================================================ */

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getEntries()  { return load('entries',  []); }
function saveEntries(e){ save('entries', e); }

function getSalary()   { return load('salary',   { gross: 0, net: 0 }); }
function saveSalary(s) { save('salary', s); }

function getPtoBank()  { return load('ptoBank',  { initialBalance: 0, taken: [] }); }
function savePtoBank(p){ save('ptoBank', p); }

function getSettings() {
  return load('settings', { ptoRatio: 1, otMultipliers: [1.5, 2], weekendBonusFlat: 0 });
}
function saveSettings(s){ save('settings', s); }

/* ================================================================
   DATE HELPERS
================================================================ */

function todayKey() {
  const d = new Date();
  return localDateKey(d);
}

function localDateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function nextDateKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

function weekStartKey(dateKey) {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  return localDateKey(d);
}

function weekEndKey(weekStartKey) {
  const d = new Date(weekStartKey + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return localDateKey(d);
}

function dayOfWeek(dateKey) {
  return new Date(dateKey + 'T00:00:00').getDay(); // 0=Sun, 6=Sat
}

function isWeekend(dateKey) {
  const dow = dayOfWeek(dateKey);
  return dow === 0 || dow === 6;
}

function fmtDate(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function fmtDateShort(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  });
}

function fmtHours(h) {
  if (h == null || isNaN(h)) return '0h';
  const hrs = Math.floor(Math.abs(h));
  const mins = Math.round((Math.abs(h) - hrs) * 60);
  const sign = h < 0 ? '-' : '';
  if (mins === 0) return `${sign}${hrs}h`;
  return `${sign}${hrs}h ${mins}m`;
}

function fmtMoney(n) {
  if (!n || isNaN(n)) return '$0.00';
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ================================================================
   WEEK COMPUTATION
   Returns: { [weekStartKey]: { totalHours, hasWeekend } }
================================================================ */

function computeWeeks(entries) {
  const weeks = {};
  for (const e of entries) {
    const wk = weekStartKey(e.date);
    if (!weeks[wk]) weeks[wk] = { totalHours: 0, hasWeekend: false };
    weeks[wk].totalHours += e.hours;
    if (isWeekend(e.date)) weeks[wk].hasWeekend = true;
  }
  return weeks;
}

/* ================================================================
   PERIOD FILTER
================================================================ */

function filterEntriesByPeriod(entries, period) {
  if (period === 'all') return entries;
  const now = new Date();
  let startKey;
  if (period === 'week') {
    startKey = weekStartKey(localDateKey(now));
  } else if (period === 'month') {
    startKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  } else if (period === 'year') {
    startKey = `${now.getFullYear()}-01-01`;
  }
  return entries.filter(e => e.date >= startKey);
}

/* ================================================================
   STATS COMPUTATION
================================================================ */

function computeHourlyRate(allEntries, salary) {
  const weeks = computeWeeks(allEntries);
  const weeksWorked = Object.keys(weeks).length;
  if (weeksWorked === 0 || salary.gross === 0) return { gross: 0, net: 0 };
  return {
    gross: salary.gross / weeksWorked / 40,
    net:   salary.net   / weeksWorked / 40,
  };
}

function computePeriodStats(periodEntries, allEntries, salary, settings) {
  const weeks      = computeWeeks(periodEntries);
  const hourlyRate = computeHourlyRate(allEntries, salary);
  const netRatio   = salary.gross > 0 ? salary.net / salary.gross : 0;

  let totalHours = 0, totalOT = 0, totalPTO = 0, weekendWeeks = 0;
  const moneyFG = {};
  settings.otMultipliers.forEach(m => { moneyFG[m] = { gross: 0, net: 0 }; });

  for (const wk of Object.values(weeks)) {
    totalHours += wk.totalHours;
    const ot = Math.max(0, wk.totalHours - 40);
    totalOT  += ot;
    totalPTO += ot * settings.ptoRatio;
    for (const m of settings.otMultipliers) {
      moneyFG[m].gross += ot * hourlyRate.gross * m;
      moneyFG[m].net   += ot * hourlyRate.net   * m;
    }
    if (wk.hasWeekend) weekendWeeks++;
  }

  const weekendFG = {
    gross: weekendWeeks * settings.weekendBonusFlat,
    net:   weekendWeeks * settings.weekendBonusFlat * netRatio,
  };

  return { weeks, totalHours, totalOT, totalPTO, moneyFG, weekendFG, hourlyRate };
}

function computePTOBalance(allEntries, ptoBank, settings) {
  const weeks = computeWeeks(allEntries);
  let totalOT = 0;
  for (const wk of Object.values(weeks)) {
    totalOT += Math.max(0, wk.totalHours - 40);
  }
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
  if (name === 'log')       renderLog();
  else if (name === 'dashboard') renderDashboard();
  else if (name === 'pto')      renderPTO();
  else if (name === 'settings') renderSettings();
}

/* ================================================================
   LOG SCREEN
================================================================ */

let _dayRows = []; // [{ date, hours }]

function buildDayRowsUI() {
  const container = document.getElementById('day-rows');
  container.innerHTML = '';
  _dayRows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'day-row';
    div.innerHTML = `
      <input type="date" value="${row.date}" data-i="${i}" data-field="date" class="row-input">
      <input type="number" min="0.5" max="24" step="0.5" value="${row.hours}" placeholder="hrs"
             data-i="${i}" data-field="hours" class="row-input">
      ${_dayRows.length > 1
        ? `<button class="day-row-remove" data-remove="${i}" title="Remove day">✕</button>`
        : '<span style="width:1.5rem"></span>'}
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('.row-input').forEach(input => {
    input.addEventListener('change', e => {
      const i = +e.target.dataset.i;
      const field = e.target.dataset.field;
      _dayRows[i][field] = field === 'hours' ? parseFloat(e.target.value) || 0 : e.target.value;
    });
  });

  container.querySelectorAll('.day-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = +e.target.dataset.remove;
      _dayRows.splice(i, 1);
      buildDayRowsUI();
    });
  });
}

function initLog() {
  _dayRows = [{ date: todayKey(), hours: 8 }];
  buildDayRowsUI();

  document.getElementById('add-day-btn').addEventListener('click', () => {
    const lastDate = _dayRows[_dayRows.length - 1].date;
    _dayRows.push({ date: nextDateKey(lastDate), hours: 8 });
    buildDayRowsUI();
  });

  document.getElementById('save-shift-btn').addEventListener('click', () => {
    const valid = _dayRows.filter(r => r.date && r.hours > 0);
    if (valid.length === 0) { showToast('Enter at least one day with hours'); return; }

    const entries = getEntries();
    for (const r of valid) {
      // Merge into existing entry for same date, or add new
      const existing = entries.find(e => e.date === r.date);
      if (existing) {
        existing.hours += r.hours;
      } else {
        entries.push({ id: `${r.date}-${Date.now()}`, date: r.date, hours: r.hours });
      }
    }
    saveEntries(entries);

    // Reset to single row for today
    _dayRows = [{ date: todayKey(), hours: 8 }];
    buildDayRowsUI();
    renderEntriesList();
    showToast(valid.length === 1 ? 'Day saved' : `${valid.length} days saved`);
  });

  renderEntriesList();
}

function renderEntriesList() {
  const entries = getEntries();
  const list = document.getElementById('entries-list');

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty">No entries yet. Log your first day above.</div>';
    return;
  }

  // Sort descending by date
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month label
  let html = '';
  let lastMonth = '';

  for (const e of sorted.slice(0, 60)) {
    const d = new Date(e.date + 'T00:00:00');
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (monthLabel !== lastMonth) {
      if (lastMonth !== '') html += '</div>';
      html += `<div class="entry-group"><div class="entry-group-date">${monthLabel}</div>`;
      lastMonth = monthLabel;
    }
    const overtime = Math.max(0, e.hours - 8);
    html += `
      <div class="entry-item">
        <div>
          <div class="entry-day">${fmtDate(e.date)}</div>
          <div class="entry-hours">
            ${fmtHours(e.hours)}
            ${overtime > 0 ? `<span class="chip chip-accent" style="margin-left:0.4rem">+${fmtHours(overtime)} OT</span>` : ''}
            ${isWeekend(e.date) ? `<span class="chip chip-success" style="margin-left:0.4rem">Weekend</span>` : ''}
          </div>
        </div>
        <button class="btn btn-danger" onclick="deleteEntry('${e.id}')">Delete</button>
      </div>
    `;
  }
  if (lastMonth) html += '</div>';

  list.innerHTML = html;
}

function deleteEntry(id) {
  saveEntries(getEntries().filter(e => e.id !== id));
  renderEntriesList();
  showToast('Entry deleted');
}

/* ================================================================
   DASHBOARD SCREEN
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
  const allEntries = getEntries();
  const salary     = getSalary();
  const settings   = getSettings();
  const periodEntries = filterEntriesByPeriod(allEntries, _dashPeriod);
  const stats = computePeriodStats(periodEntries, allEntries, salary, settings);
  const hasRate = salary.gross > 0 && Object.keys(computeWeeks(allEntries)).length > 0;

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
    ? ''
    : '<div class="empty" style="padding:0.75rem 0">Set salary in Settings to see money figures.</div>';

  const weeksHTML = renderWeekBreakdown(stats.weeks);

  const hourlyNote = hasRate
    ? `<div class="stat-sub">Gross ${fmtMoney(stats.hourlyRate.gross)}/hr · Net ${fmtMoney(stats.hourlyRate.net)}/hr</div>`
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
      <h2 class="card-heading">Money Foregone (if you were paid OT)</h2>
      ${hasRate ? multiplierHTML : noMoneyNote}
      ${hourlyNote}
    </div>

    <div class="card">
      <h2 class="card-heading">By Week</h2>
      ${weeksHTML}
    </div>
  `;
}

function renderWeekBreakdown(weeks) {
  const entries = Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0]));
  if (entries.length === 0) return '<div class="empty">No entries in this period.</div>';

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
  const allEntries = getEntries();
  const ptoBank    = getPtoBank();
  const settings   = getSettings();
  const pto = computePTOBalance(allEntries, ptoBank, settings);

  const taken = [...ptoBank.taken].sort((a, b) => b.date.localeCompare(a.date));
  const histHTML = taken.length === 0
    ? '<div class="empty">No PTO taken yet.</div>'
    : taken.map(t => `
        <div class="entry-item" style="margin-bottom:0.3rem">
          <div>
            <div class="entry-day">${fmtDate(t.date)}</div>
            <div class="entry-hours">${fmtHours(t.hours)}</div>
          </div>
          <button class="btn btn-danger" onclick="deletePTOTaken('${t.id}')">Delete</button>
        </div>`).join('');

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
    </div>
  `;

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

function deletePTOTaken(id) {
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
        <input type="number" id="s-new-mult" min="1" max="10" step="0.25" placeholder="e.g. 3×">
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
        A weekend = any week where Sat or Sun has logged hours. Counted once per week, not per day.
      </p>
    </div>
  `;
}

function saveSalarySettings() {
  const gross = parseFloat(document.getElementById('s-gross').value) || 0;
  const net   = parseFloat(document.getElementById('s-net').value)   || 0;
  saveSalary({ gross, net });
  showToast('Salary saved');
}

function savePTOSettings() {
  const initial = parseFloat(document.getElementById('s-pto-init').value)  || 0;
  const ratio   = parseFloat(document.getElementById('s-pto-ratio').value) || 1;
  const bank = getPtoBank();
  bank.initialBalance = initial;
  savePtoBank(bank);
  const s = getSettings();
  s.ptoRatio = ratio;
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
  const val = parseFloat(document.getElementById('s-wknd').value) || 0;
  const s = getSettings();
  s.weekendBonusFlat = val;
  saveSettings(s);
  showToast('Weekend bonus saved');
}

/* ================================================================
   INIT
================================================================ */

function init() {
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
