/* ================================================================
   STORAGE
   shifts:  [{ id, startISO, endISO }]
   salary:  { gross, net }
   ptoBank: { initialBalance, taken:[{ id, date, hours }] }
   settings:{ ptoRatio, otMultipliers:[], weekendBonusFlat }
================================================================ */

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getShifts()   { return load('shifts',  []); }
function saveShifts(s) { save('shifts', s); }

function getSalary()   { return load('salary',  { gross: 0, net: 0 }); }
function saveSalary(s) { save('salary', s); }

function getPtoBank()  { return load('ptoBank', { initialBalance: 0, taken: [] }); }
function savePtoBank(p){ save('ptoBank', p); }

function getSettings() {
  return load('settings', { ptoRatio: 1, otMultipliers: [1.5, 2], weekendBonusFlat: 0 });
}
function saveSettings(s){ save('settings', s); }

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

// Format a date object or dateKey as "Mon, Jun 24"
function fmtDate(dateOrKey) {
  const d = typeof dateOrKey === 'string' ? new Date(dateOrKey + 'T00:00:00') : new Date(dateOrKey);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Format a date for short display: "Jun 24"
function fmtDateShort(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Format an ISO string as "Mon, Jun 24, 3:00 PM"
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

// Convert a Date to datetime-local string "YYYY-MM-DDTHH:MM"
function toLocalDTStr(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/* ================================================================
   SHIFT SPLITTING
   Any shift spanning midnight is split into per-calendar-day
   segments attributed to the local calendar day they fall in.
================================================================ */

function splitShiftByDay(shift) {
  const start = new Date(shift.startISO);
  const end   = new Date(shift.endISO);
  const segments = [];
  let cursor = new Date(start);

  while (cursor < end) {
    // Next midnight in local time
    const nextDay = new Date(cursor);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    const segEnd = nextDay <= end ? nextDay : end;
    const hours  = (segEnd - cursor) / 3600000;

    if (hours > 0.0001) {
      const dk = localDateKey(cursor);
      segments.push({
        dateKey:  dk,
        hours,
        dayOfWeek: cursor.getDay(),   // 0=Sun … 6=Sat
        weekKey:  weekStartKey(dk),
      });
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
   PERIOD FILTER  (operates on segments, not shifts)
================================================================ */

function filterSegmentsByPeriod(segments, period) {
  if (period === 'all') return segments;
  const now = new Date();
  let startKey;
  if (period === 'week') {
    startKey = weekStartKey(localDateKey(now));
  } else if (period === 'month') {
    startKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  } else if (period === 'year') {
    startKey = `${now.getFullYear()}-01-01`;
  }
  return segments.filter(s => s.dateKey >= startKey);
}

/* ================================================================
   STATS
================================================================ */

function computeHourlyRate(allSegments, salary) {
  const weeksWorked = Object.keys(computeWeeks(allSegments)).length;
  if (weeksWorked === 0 || salary.gross === 0) return { gross: 0, net: 0 };
  return {
    gross: salary.gross / weeksWorked / 40,
    net:   salary.net   / weeksWorked / 40,
  };
}

function computePeriodStats(periodSegments, allSegments, salary, settings) {
  const weeks      = computeWeeks(periodSegments);
  const hourlyRate = computeHourlyRate(allSegments, salary);
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

  return {
    weeks, totalHours, totalOT, totalPTO, hourlyRate,
    moneyFG,
    weekendFG: {
      gross: weekendWeeks * settings.weekendBonusFlat,
      net:   weekendWeeks * settings.weekendBonusFlat * netRatio,
    },
  };
}

function computePTOBalance(allSegments, ptoBank, settings) {
  const weeks = computeWeeks(allSegments);
  let totalOT = 0;
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
   _shiftRows: [{ startVal: 'YYYY-MM-DDTHH:MM', endVal: '...' }]
================================================================ */

let _shiftRows = [];

function defaultStart() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return toLocalDTStr(d);
}

function defaultEnd(startVal) {
  const d = new Date(startVal);
  d.setHours(d.getHours() + 8, 0, 0, 0);
  return toLocalDTStr(d);
}

function shiftHours(row) {
  if (!row.startVal || !row.endVal) return 0;
  const diff = (new Date(row.endVal) - new Date(row.startVal)) / 3600000;
  return diff > 0 ? diff : 0;
}

function buildShiftRowsUI() {
  const container = document.getElementById('shift-rows');
  container.innerHTML = '';

  _shiftRows.forEach((row, i) => {
    const h = shiftHours(row);
    const label = _shiftRows.length > 1 ? `Shift ${i + 1}` : 'Shift';

    const div = document.createElement('div');
    div.className = 'shift-row';
    div.innerHTML = `
      <div class="shift-row-header">
        <span class="shift-row-num">${label}</span>
        <span class="shift-row-computed">${h > 0 ? fmtHours(h) : '—'}</span>
        ${_shiftRows.length > 1
          ? `<button class="shift-row-remove" data-remove="${i}" title="Remove">✕</button>`
          : ''}
      </div>
      <div class="shift-dt-pair">
        <span class="shift-dt-label">Start</span>
        <input type="datetime-local" value="${row.startVal}"
               data-i="${i}" data-field="startVal" class="srow-input">
      </div>
      <div class="shift-dt-pair">
        <span class="shift-dt-label">End</span>
        <input type="datetime-local" value="${row.endVal}"
               data-i="${i}" data-field="endVal" class="srow-input">
      </div>
    `;
    container.appendChild(div);
  });

  // Bind changes
  container.querySelectorAll('.srow-input').forEach(input => {
    input.addEventListener('change', e => {
      const i     = +e.target.dataset.i;
      const field = e.target.dataset.field;
      _shiftRows[i][field] = e.target.value;

      // Auto-adjust end if start moved past it
      if (field === 'startVal' && _shiftRows[i].endVal) {
        const s = new Date(_shiftRows[i].startVal);
        const en = new Date(_shiftRows[i].endVal);
        if (en <= s) _shiftRows[i].endVal = defaultEnd(_shiftRows[i].startVal);
      }
      buildShiftRowsUI();
    });
  });

  // Bind remove buttons
  container.querySelectorAll('.shift-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      _shiftRows.splice(+e.target.dataset.remove, 1);
      buildShiftRowsUI();
    });
  });
}

function initLog() {
  const start = defaultStart();
  _shiftRows = [{ startVal: start, endVal: defaultEnd(start) }];
  buildShiftRowsUI();

  document.getElementById('add-shift-btn').addEventListener('click', () => {
    // New shift starts where the last one ended
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
        id:       `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        startISO: new Date(r.startVal).toISOString(),
        endISO:   new Date(r.endVal).toISOString(),
      });
    }
    saveShifts(shifts);

    // Reset to single blank shift
    const s = defaultStart();
    _shiftRows = [{ startVal: s, endVal: defaultEnd(s) }];
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
    list.innerHTML = '<div class="empty">No shifts logged yet.</div>';
    return;
  }

  const sorted = [...shifts].sort((a, b) => b.startISO.localeCompare(a.startISO));

  let html = '';
  let lastMonth = '';

  for (const sh of sorted.slice(0, 50)) {
    const segs  = splitShiftByDay(sh);
    const total = segs.reduce((s, g) => s + g.hours, 0);
    const spans = segs.length > 1 ? ` · ${segs.length} days` : '';
    const d     = new Date(sh.startISO);
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (monthLabel !== lastMonth) {
      if (lastMonth) html += '</div>';
      html += `<div class="entry-group"><div class="entry-group-date">${monthLabel}</div>`;
      lastMonth = monthLabel;
    }

    const ot = segs.reduce((s, g) => {
      // We can't know per-shift OT in isolation; just flag if any day > 8h
      return s;
    }, 0);

    html += `
      <div class="entry-item">
        <div>
          <div class="entry-day">${fmtDateTime(sh.startISO)} → ${fmtDateTime(sh.endISO)}</div>
          <div class="entry-hours">${fmtHours(total)}${spans}</div>
        </div>
        <button class="btn btn-danger" onclick="deleteShift('${sh.id}')">Delete</button>
      </div>`;
  }
  if (lastMonth) html += '</div>';
  list.innerHTML = html;
}

function deleteShift(id) {
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
  const salary      = getSalary();
  const settings    = getSettings();
  const allShifts   = getShifts();
  const allSegs     = getAllSegments(allShifts);
  const periodSegs  = filterSegmentsByPeriod(allSegs, _dashPeriod);
  const stats       = computePeriodStats(periodSegs, allSegs, salary, settings);
  const hasRate     = salary.gross > 0 && Object.keys(computeWeeks(allSegs)).length > 0;

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

  const hourlyNote = hasRate
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
    </div>
  `;
}

function renderWeekBreakdown(weeks) {
  const entries = Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0]));
  if (entries.length === 0) return '<div class="empty">No shifts in this period.</div>';

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
  const allSegs = getAllSegments(getShifts());
  const ptoBank = getPtoBank();
  const settings = getSettings();
  const pto = computePTOBalance(allSegs, ptoBank, settings);

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
  `;
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
