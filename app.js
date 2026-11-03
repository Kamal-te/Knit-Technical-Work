(function () {
  'use strict';

  const state = { skew: 0, options: null, tasks: [], workbook: null, rows: null, previewed: false, user: null, peopleKind: 'technician', people: [], users: [] };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- helpers ----------

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) showLogin();
      if (res.status === 403 && data.code === 'must_change') showForcePassword();
      throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    }
    return data;
  }

  // Stored times are 'YYYY-MM-DD HH:mm:ss' factory wall-clock strings.
  function wallMs(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  }

  function localWallOf(ms) {
    return ms - new Date(ms).getTimezoneOffset() * 60000;
  }

  // Phone clocks can be set to another timezone, so timers use the server's clock.
  function clientWallNow() {
    return localWallOf(Date.now()) + state.skew;
  }

  function syncClock(serverNow) {
    state.skew = wallMs(serverNow) - localWallOf(Date.now());
  }

  function todayText() {
    return new Date(clientWallNow()).toISOString().slice(0, 10);
  }

  function hhmm(wall) { return wall ? wall.slice(11, 16) : '–'; }
  function dmy(day) { return day ? `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(2, 4)}` : '–'; }
  function inputWall(wall) { return wall ? wall.slice(0, 16).replace(' ', 'T') : ''; }

  function hours(h, digits = 2) {
    return h === null || h === undefined || Number.isNaN(h) ? '–' : `${Number(h).toFixed(digits)} h`;
  }

  function signedHours(h) {
    if (h === null || h === undefined) return '–';
    const sign = h > 0.005 ? '+' : h < -0.005 ? '−' : '';
    return `${sign}${Math.abs(h).toFixed(2)} h`;
  }

  function percent(p) { return p === null || p === undefined ? '–' : `${p.toFixed(0)}%`; }

  function minutesText(m) { return m === null || m === undefined ? '–' : `${Math.round(m)} min`; }

  function efficiencyClass(p) {
    if (p === null || p === undefined) return '';
    if (p >= 100) return 'ok';
    if (p >= 85) return 'warn';
    return 'bad';
  }

  function efficiencyCell(p, title) {
    if (p === null || p === undefined) return '<span class="neutral">–</span>';
    return `<span class="eff ${efficiencyClass(p)}" title="${esc(title || '')}">${p.toFixed(0)}%</span>`;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return [h, m, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function canWrite() {
    return Boolean(state.user) && ['admin', 'user'].includes(state.user.role);
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3400);
  }

  function issueBadge(task) {
    if (!task.issues || !task.issues.length) return '';
    const text = task.issues.map((i) => i.message).join('\n');
    return `<span class="badge" title="${esc(text)}">⚠ ${task.issues.length} check</span>`;
  }

  // ---------- screens: sign in, forced password change, app ----------

  function showView(name) {
    $('#authView').hidden = name !== 'login';
    $('#forcePwView').hidden = name !== 'force';
    $('#appView').hidden = name !== 'app';
  }

  function showLogin() {
    state.user = null;
    document.body.removeAttribute('data-role');
    showView('login');
  }

  function showForcePassword() {
    showView('force');
  }

  function enterApp(user) {
    state.user = user;
    document.body.dataset.role = user.role;
    $('#meName').textContent = user.name;
    $('#meRole').textContent = user.role;
    showView('app');
    showTab(currentTab());
  }

  function currentTab() {
    const active = $('.tab.active');
    return active ? active.dataset.tab : 'dashboard';
  }

  async function signIn(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const error = $('#loginError');
    error.hidden = true;
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { email: form.elements.email.value, password: form.elements.password.value },
      });
      form.elements.password.value = '';
      if (data.user.must_change) {
        state.user = data.user;
        showForcePassword();
      } else {
        await start(data.user);
      }
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  async function changeFirstPassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const error = $('#forcePwError');
    error.hidden = true;
    if (form.elements.next.value !== form.elements.repeat.value) {
      error.textContent = 'The two new passwords do not match.';
      error.hidden = false;
      return;
    }
    try {
      const data = await api('/api/auth/password', {
        method: 'POST',
        body: { current: form.elements.current.value, next: form.elements.next.value },
      });
      form.reset();
      await start(data.user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  async function start(user) {
    await loadOptions();
    enterApp(user);
    loadTasks().catch((e) => toast(e.message, true));
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* already signed out */ }
    $('#loginForm').reset();
    showLogin();
  }

  async function restoreSession() {
    try {
      const data = await api('/api/auth/me');
      if (data.user.must_change) {
        state.user = data.user;
        showForcePassword();
      } else {
        await start(data.user);
      }
    } catch {
      showLogin();
    }
  }

  // ---------- tabs ----------

  function showTab(name) {
    if (!state.user) return;
    const allowed = $$('.tab').find((b) => b.dataset.tab === name && b.offsetParent !== null);
    if (!allowed) name = 'dashboard';
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'tasks') loadTasks().catch((e) => toast(e.message, true));
    if (name === 'dashboard' && window.Dashboard) window.Dashboard.refresh().catch((e) => toast(e.message, true));
    if (name === 'people') loadPeople().catch((e) => toast(e.message, true));
    if (name === 'skills' && window.Analytics) window.Analytics.refreshSkills().catch((e) => toast(e.message, true));
    if (name === 'machines' && window.Analytics) window.Analytics.refreshMachines().catch((e) => toast(e.message, true));
    if (name === 'users') loadUsers().catch((e) => toast(e.message, true));
  }

  // ---------- options (datalists and selects) ----------

  async function loadOptions() {
    const opts = await api('/api/options');
    state.options = opts;
    const fill = (id, values) => {
      $(id).innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
    };
    fill('#particularList', opts.particulars.map((p) => p.particular));
    const setOptions = (sel, values, allLabel) => {
      const select = $(sel);
      const current = select.value;
      select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
        values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      select.value = current;
    };
    setOptions('#dashExec', opts.executives, 'All executives');
    setOptions('#dashSup', opts.supervisors, 'All supervisors');
    setOptions('#dashTech', opts.people, 'Everyone');
    // Default to the last eight weeks of data, so the charts are not mostly empty history.
    if (!$('#dashFrom').value && opts.range.max) {
      const end = new Date(Date.UTC(...opts.range.max.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))));
      end.setUTCDate(end.getUTCDate() - 55);
      const floor = end.toISOString().slice(0, 10);
      $('#dashFrom').value = opts.range.min && opts.range.min > floor ? opts.range.min : floor;
    }
    if (!$('#dashTo').value && opts.range.max) $('#dashTo').value = opts.range.max;
  }

  // ---------- tasks board ----------

  async function loadTasks() {
    const data = await api(`/api/tasks?from=${$('#taskFrom').value}&to=${$('#taskTo').value}`);
    syncClock(data.now);
    state.tasks = data.tasks;
    renderTasks();
  }

  function jobLine(t) {
    return [t.machine_no !== null ? `M/C ${t.machine_no}` : null, t.dia_gauge, t.shift ? `Shift ${t.shift}` : null]
      .filter(Boolean).map(esc).join(' · ');
  }

  function peopleLine(t) {
    return [t.executive && `Exec: ${t.executive}`, t.responsible_person && `Tech: ${t.responsible_person}`,
      t.supervisor && `Sup: ${t.supervisor}`].filter(Boolean).map(esc).join(' · ');
  }

  function runningCard(t) {
    const actions = canWrite()
      ? `<div class="actions">
          <button class="btn success" type="button" data-act="stop" data-id="${t.id}">■ Stop</button>
          <button class="btn ghost" type="button" data-act="edit" data-id="${t.id}">Edit</button>
        </div>` : '';
    return `<article class="card running" data-id="${t.id}">
      <div class="card-head"><span class="mc">${jobLine(t)}</span>${issueBadge(t)}</div>
      <div class="card-title">${esc(t.particular)}</div>
      <div class="meta">${peopleLine(t)}</div>
      <div class="timer" data-start="${esc(t.work_start_at)}" data-std="${t.standard_hours ?? ''}">00:00:00</div>
      <div class="bar"><div class="fill"></div></div>
      <div class="meta small">Standard ${hours(t.standard_hours)} · started ${hhmm(t.work_start_at)} ${dmy(t.work_start_at)}</div>
      ${actions}
    </article>`;
  }

  function pendingCard(t) {
    const actions = canWrite()
      ? `<div class="actions">
          <button class="btn primary" type="button" data-act="start" data-id="${t.id}">▶ Start</button>
          <button class="btn ghost" type="button" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="btn ghost" type="button" data-act="delete" data-id="${t.id}">Delete</button>
        </div>` : '';
    return `<article class="card pending" data-id="${t.id}">
      <div class="card-head"><span class="mc">${jobLine(t)}</span>${issueBadge(t)}</div>
      <div class="card-title">${esc(t.particular)}</div>
      <div class="meta">${peopleLine(t)}</div>
      <div class="meta small">Standard ${hours(t.standard_hours)}</div>
      ${actions}
    </article>`;
  }

  function doneRow(t) {
    const variance = t.metrics.variance_hours;
    const cls = variance === null ? 'neutral' : variance > 0 ? 'bad' : 'good';
    return `<tr data-id="${t.id}">
      <td>${dmy(t.task_date)}</td>
      <td>${t.machine_no ?? ''}</td>
      <td class="wrap-text">${esc(t.particular)}</td>
      <td>${esc(t.responsible_person || '–')}</td>
      <td>${esc(t.executive || '–')}</td>
      <td class="num">${hours(t.standard_hours)}</td>
      <td class="num">${hours(t.metrics.actual_hours)}</td>
      <td class="num ${cls}">${signedHours(variance)}</td>
      <td>${issueBadge(t) || '<span class="neutral">OK</span>'}</td>
    </tr>`;
  }

  function renderTasks() {
    const running = state.tasks.filter((t) => t.status === 'running')
      .sort((a, b) => a.work_start_at.localeCompare(b.work_start_at));
    const pending = state.tasks.filter((t) => t.status === 'pending').sort((a, b) => a.id - b.id);
    const done = state.tasks.filter((t) => t.status === 'done')
      .sort((a, b) => b.work_end_at.localeCompare(a.work_end_at));

    $('#runningCount').textContent = running.length;
    $('#pendingCount').textContent = pending.length;
    $('#runningList').innerHTML = running.map(runningCard).join('') ||
      '<div class="empty">Nothing is running right now.</div>';
    $('#pendingList').innerHTML = pending.map(pendingCard).join('') ||
      '<div class="empty">No tasks waiting.</div>';
    $('#doneList').innerHTML = done.length
      ? `<table><thead><tr>
          <th>Date</th><th>M/C</th><th>Job</th><th>Technician</th><th>Executive</th>
          <th class="num">Standard</th><th class="num">Actual</th><th class="num">Extra / saved</th><th>Check</th>
        </tr></thead><tbody>${done.map(doneRow).join('')}</tbody></table>`
      : '<div class="empty">No finished tasks in this date range.</div>';
    tick();
  }

  // Updates each running timer every second and fills its bar against the standard.
  function tick() {
    const now = clientWallNow();
    $$('#runningList .card').forEach((card) => {
      const timer = card.querySelector('.timer');
      const start = wallMs(timer.dataset.start);
      const std = parseFloat(timer.dataset.std);
      const elapsedMs = now - start;
      const elapsedH = elapsedMs / 3600000;
      timer.textContent = fmtDuration(elapsedMs);
      const fill = card.querySelector('.fill');
      fill.style.width = std > 0 ? `${Math.min(100, (elapsedH / std) * 100)}%` : '0%';
      card.classList.toggle('over', std > 0 && elapsedH > std);
    });
  }

  async function handleTaskAction(act, id) {
    if (act === 'edit') return openTaskDialog(id);
    try {
      if (act === 'start') {
        await api(`/api/tasks/${id}/start`, { method: 'POST', body: {} });
        toast('Timer started');
      } else if (act === 'stop') {
        const current = state.tasks.find((t) => t.id === id);
        const stale = current && current.issues.some((i) => i.code === 'open_too_long');
        if (stale && !confirm('This job started over 24 hours ago. Stop now records the current time as its end. To enter the real end time, use Edit instead. Stop with the current time anyway?')) return;
        const t = await api(`/api/tasks/${id}/stop`, { method: 'POST', body: {} });
        toast(`Stopped: ${hours(t.metrics.actual_hours)} actual vs ${hours(t.standard_hours)} standard (${signedHours(t.metrics.variance_hours)})`);
      } else if (act === 'delete') {
        if (!confirm('Delete this task? This cannot be undone.')) return;
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
        toast('Task deleted');
      }
      await loadTasks();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- task form ----------

  const TEXT_FIELDS = [
    'particular', 'machine_no', 'dia_gauge', 'standard_hours', 'shift', 'executive',
    'supervisor', 'task_date', 'remark',
  ];
  const WALL_FIELDS = ['work_start_at', 'work_end_at', 'machine_stop_at', 'machine_running_at'];

  // ---------- task form pickers ----------
  // Machine, gauge and people are chosen from lists, so a name is always spelt the
  // same way. A value no longer on its list is kept and marked, so editing an old
  // task never drops it.

  function setPicked(select, value, note = 'not on the current list') {
    const text = value === null || value === undefined ? '' : String(value);
    if (text && !Array.from(select.options).some((o) => o.value === text)) {
      select.insertAdjacentHTML('beforeend', `<option value="${esc(text)}">${esc(text)} (${esc(note)})</option>`);
    }
    select.value = text;
  }

  function machineById(machineNo) {
    const text = machineNo === null || machineNo === undefined ? '' : String(machineNo);
    return state.options ? state.options.machines.find((m) => m.machine_no === text) || null : null;
  }

  function machineLabel(m) {
    return `${m.machine_no} · ${m.brand} · dia ${m.dia}${m.status === 'Active' ? '' : ' · idle'}`;
  }

  function fillMachinePicker(current) {
    const list = state.options.machines;
    const units = [...new Set(list.map((m) => m.unit))];
    $('#machineSelect').innerHTML = '<option value="">Choose a machine</option>' + units.map((unit) => `
      <optgroup label="${esc(unit)}">${list.filter((m) => m.unit === unit)
        .map((m) => `<option value="${esc(m.machine_no)}">${esc(machineLabel(m))}</option>`).join('')}</optgroup>`).join('');
    setPicked($('#machineSelect'), current, 'not in the machine list');
  }

  function fillGaugePicker(current) {
    const select = $('#gaugeSelect');
    select.innerHTML = '<option value="">–</option>' + state.options.gauges.map((g) => `<option value="${g}">${g}</option>`).join('');
    setPicked(select, current);
  }

  function fillPeoplePicker(select, names, current) {
    select.innerHTML = '<option value="">Choose</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    setPicked(select, current);
  }

  function addTechRow(value = '') {
    const row = document.createElement('div');
    row.className = 'tech-row';
    const select = document.createElement('select');
    select.className = 'tech-pick';
    select.innerHTML = '<option value="">Choose a person</option>' + state.options.people.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    setPicked(select, value);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn small ghost tech-remove';
    remove.setAttribute('aria-label', 'Remove this person');
    remove.textContent = '✕';
    row.append(select, remove);
    $('#techRows').append(row);
    return select;
  }

  function fillTechRows(names) {
    $('#techRows').innerHTML = '';
    (names.length ? names : ['']).forEach((name) => addTechRow(name));
  }

  // Several people on one job are saved as "A, B", which the dashboard counts as a team.
  function techValue() {
    const names = Array.from($('#techRows').querySelectorAll('.tech-pick'), (s) => s.value).filter(Boolean);
    return Array.from(new Set(names)).join(', ');
  }

  // Shows brand and dia from the machine list. Gauge is never fixed by the machine.
  function showMachineFacts() {
    const m = machineById($('#taskForm').elements.machine_no.value);
    $('#brandShow').value = m ? m.brand : '';
    $('#diaShow').value = m ? m.dia : '';
  }

  // Picking a machine sets its usual gauge. The gauge can then be changed for the job.
  function onMachineChange() {
    const m = machineById($('#taskForm').elements.machine_no.value);
    showMachineFacts();
    if (m) setPicked($('#gaugeSelect'), m.gauge);
    updateDiaGauge();
  }

  // Saved as "dia x gauge", the same form the old sheet uses, e.g. 34x20.
  function updateDiaGauge() {
    const form = $('#taskForm');
    const m = machineById(form.elements.machine_no.value);
    const gauge = form.elements.gauge.value;
    form.elements.dia_gauge.value = m && gauge ? `${m.dia}x${gauge}` : '';
  }

  function gaugeIn(diaGauge) {
    const match = /x\s*(\d+)/i.exec(String(diaGauge || ''));
    return match ? match[1] : '';
  }

  function fillPickers(task) {
    if (!state.options) return;
    const form = $('#taskForm');
    fillMachinePicker(task ? task.machine_no : '');
    const machine = machineById(task ? task.machine_no : '');
    fillGaugePicker(gaugeIn(task ? task.dia_gauge : '') || (machine ? machine.gauge : ''));
    fillPeoplePicker(form.elements.executive, state.options.executives, task ? task.executive : '');
    fillPeoplePicker(form.elements.supervisor, state.options.supervisors, task ? task.supervisor : '');
    fillTechRows(task && task.responsible_person ? task.responsible_person.split(', ') : []);
    showMachineFacts();
  }

  function openTaskDialog(id) {
    if (!canWrite()) return;
    const form = $('#taskForm');
    form.reset();
    const task = id ? state.tasks.find((t) => t.id === id) : null;
    form.dataset.id = task ? String(task.id) : '';
    $('#dialogTitle').textContent = task ? 'Edit task' : 'New task';
    $('#startNowRow').hidden = Boolean(task);
    $('#deleteTaskBtn').hidden = !task;
    fillPickers(task);
    if (task) {
      TEXT_FIELDS.forEach((name) => { form.elements[name].value = task[name] ?? ''; });
      WALL_FIELDS.forEach((name) => { form.elements[name].value = inputWall(task[name]); });
    } else {
      form.elements.task_date.value = todayText();
    }
    $('#taskDialog').showModal();
  }

  function fillStandardFromHistory() {
    const form = $('#taskForm');
    const typed = form.elements.particular.value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!state.options || !typed || form.elements.standard_hours.value !== '') return;
    const match = state.options.particulars.find((p) => p.particular.toLowerCase() === typed);
    if (match && match.standard_hours !== null) form.elements.standard_hours.value = match.standard_hours;
  }

  // ---------- people (admin) ----------

  async function loadPeople() {
    const data = await api('/api/people');
    state.people = data.people;
    renderPeople();
  }

  function renderPeople() {
    const rows = state.people.filter((p) => p.kind === state.peopleKind);
    $$('#kindSeg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === state.peopleKind));
    $('#peopleList').innerHTML = rows.length
      ? `<table><thead><tr>
          <th>Standard name</th><th>Also written as</th><th class="num">Tasks</th><th>Status</th><th></th>
        </tr></thead><tbody>${rows.map((p) => `<tr>
          <td><b>${esc(p.name)}</b></td>
          <td class="wrap-text">${p.aliases ? esc(p.aliases) : '<span class="neutral">–</span>'}</td>
          <td class="num">${p.task_count}</td>
          <td><span class="pill ${p.active ? 'on' : 'off'}">${p.active ? 'Active' : 'Hidden'}</span></td>
          <td><button class="btn small ghost" type="button" data-person-edit="${p.id}">Edit</button></td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No people in this group yet.</div>';
  }

  function openPersonDialog(id) {
    const form = $('#personForm');
    form.reset();
    const person = id ? state.people.find((p) => p.id === id) : null;
    form.dataset.id = person ? String(person.id) : '';
    $('#personTitle').textContent = person ? 'Edit person' : 'Add person';
    form.elements.kind.value = person ? person.kind : state.peopleKind;
    form.elements.kind.disabled = Boolean(person);
    if (person) {
      form.elements.name.value = person.name;
      form.elements.aliases.value = person.aliases;
      form.elements.active.checked = person.active;
    } else {
      form.elements.active.checked = true;
    }
    $('#personDialog').showModal();
  }

  async function savePerson(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.dataset.id;
    try {
      const body = { name: form.elements.name.value, aliases: form.elements.aliases.value, active: form.elements.active.checked };
      const data = id
        ? await api(`/api/people/${id}`, { method: 'PATCH', body })
        : await api('/api/people', { method: 'POST', body: { ...body, kind: form.elements.kind.value } });
      state.people = data.people;
      $('#personDialog').close();
      renderPeople();
      toast('Saved. Tasks now use the standard name.');
      await loadOptions();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- users (admin) ----------

  async function loadUsers() {
    const data = await api('/api/users');
    state.users = data.users;
    renderUsers();
  }

  function renderUsers() {
    const roleSelect = (u) => `<select data-user-role="${u.id}" class="role-select">
      ${['admin', 'user', 'viewer'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
    </select>`;
    $('#usersList').innerHTML = `<table><thead><tr>
        <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th>
      </tr></thead><tbody>${state.users.map((u) => `<tr>
        <td><b>${esc(u.name)}</b>${u.must_change ? ' <span class="pill">temp password</span>' : ''}</td>
        <td>${esc(u.email)}</td>
        <td>${roleSelect(u)}</td>
        <td><span class="pill ${u.active ? 'on' : 'off'}">${u.active ? 'Active' : 'Blocked'}</span></td>
        <td>${u.last_login_at ? dmy(u.last_login_at) + ' ' + hhmm(u.last_login_at) : '<span class="neutral">never</span>'}</td>
        <td class="actions-cell">
          <button class="btn small ghost" type="button" data-user-reset="${u.id}">Reset password</button>
          <button class="btn small ghost" type="button" data-user-toggle="${u.id}">${u.active ? 'Block' : 'Unblock'}</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  }

  function openUserDialog() {
    const dialog = $('#userDialog');
    $('#userForm').reset();
    $('#userFormFields').hidden = false;
    $('#userResult').hidden = true;
    $('#userSubmit').hidden = false;
    $('#userSubmit').textContent = 'Create account';
    dialog.showModal();
  }

  function showTemporaryPassword(title, user, password) {
    $('#userForm').reset();
    $('#userFormFields').hidden = true;
    $('#userSubmit').hidden = true;
    $('#userResult').hidden = false;
    $('#userResult').querySelector('p').textContent = `${title} for ${user.email}. Share this temporary password once; they must change it at first sign-in.`;
    $('#tempPass').textContent = password;
    $('#userDialog').showModal();
  }

  async function createUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await api('/api/users', {
        method: 'POST',
        body: { email: form.elements.email.value, name: form.elements.name.value, role: form.elements.role.value },
      });
      await loadUsers();
      showTemporaryPassword('Account created', data.user, data.temporary_password);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function userAction(target) {
    const id = Number(target.dataset.userRole || target.dataset.userReset || target.dataset.userToggle);
    const user = state.users.find((u) => u.id === id);
    if (!user) return;
    try {
      if (target.dataset.userReset) {
        const data = await api(`/api/users/${id}/reset-password`, { method: 'POST', body: {} });
        showTemporaryPassword('New temporary password', data.user, data.temporary_password);
      } else if (target.dataset.userToggle) {
        if (user.active && !confirm(`Block ${user.email}? They will be signed out immediately.`)) return;
        await api(`/api/users/${id}`, { method: 'PATCH', body: { active: !user.active } });
        toast(user.active ? 'User blocked' : 'User unblocked');
      }
      await loadUsers();
    } catch (err) {
      toast(err.message, true);
      await loadUsers();
    }
  }

  async function changeRole(select) {
    const id = Number(select.dataset.userRole);
    try {
      await api(`/api/users/${id}`, { method: 'PATCH', body: { role: select.value } });
      toast('Role updated');
      await loadUsers();
    } catch (err) {
      toast(err.message, true);
      await loadUsers();
    }
  }

  async function changeOwnPassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { current: form.elements.current.value, next: form.elements.next.value },
      });
      form.reset();
      $('#pwDialog').close();
      toast('Password changed');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- Excel import ----------

  function selectedSheetRows() {
    const sheet = state.workbook.Sheets[$('#importSheet').value];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  }

  function setImportBusy(busy) {
    $('#previewBtn').disabled = busy;
    $('#commitBtn').disabled = busy || !state.previewed;
  }

  const ISSUE_LABELS = {
    no_person: 'Responsible person missing',
    no_executive: 'Executive missing',
    no_standard: 'Standard time not set',
    end_before_start: 'End before start',
    start_before_stop: 'Started before machine stop',
    long_response: 'Long wait before work started',
    huge_variance: 'Over 2× standard',
    open_too_long: 'Open for over 24 h',
    over_24h: 'Work took over 24 h',
  };

  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${esc(sub || '')}</div></div>`;
  }

  async function previewImport() {
    setImportBusy(true);
    try {
      state.rows = selectedSheetRows();
      const p = await api('/api/import/preview', { method: 'POST', body: { rows: state.rows } });
      state.previewed = p.to_add > 0;
      const issueText = Object.entries(p.issue_counts).map(([code, n]) =>
        `<li><span class="what">${esc(ISSUE_LABELS[code] || code)}</span>: ${n}</li>`).join('');
      const warnings = p.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
      $('#importResult').innerHTML = `
        <div class="result-grid">
          ${kpi('Job rows found', p.rows_found)}
          ${kpi('Will be added', p.to_add)}
          ${kpi('Already in database', p.already_in_database, 'skipped, not duplicated')}
          ${kpi('Blank rows ignored', p.blank_rows)}
        </div>
        ${issueText ? `<p class="muted small">Checks on the rows that will be added:</p><ul class="issue-list">${issueText}</ul>` : ''}
        ${warnings ? `<p class="muted small">Warnings from the file:</p><ul class="issue-list">${warnings}</ul>` : ''}
        <p class="muted small">Nothing has been saved yet. Press <b>Import into database</b> to save the new rows.</p>`;
      $('#commitBtn').disabled = !state.previewed;
    } catch (err) {
      state.previewed = false;
      $('#importResult').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    } finally {
      setImportBusy(false);
    }
  }

  async function commitImport() {
    setImportBusy(true);
    try {
      const r = await api('/api/import', { method: 'POST', body: { rows: state.rows } });
      toast(`Imported ${r.inserted} job(s). ${r.skipped} skipped as duplicates.`);
      $('#importResult').innerHTML = `<div class="result-grid">${kpi('Imported', r.inserted)}${kpi('Skipped (already present)', r.skipped)}</div>`;
      state.previewed = false;
      await loadOptions();
    } catch (err) {
      toast(err.message, true);
    } finally {
      setImportBusy(false);
    }
  }

  function readWorkbook(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state.workbook = XLSX.read(reader.result, { type: 'array' });
        const select = $('#importSheet');
        select.innerHTML = state.workbook.SheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
        select.value = state.workbook.SheetNames.find((n) => /technical/i.test(n)) || state.workbook.SheetNames[0];
        $('#sheetRow').hidden = false;
        state.previewed = false;
        $('#commitBtn').disabled = true;
        $('#importResult').innerHTML = '';
      } catch (err) {
        toast('Could not read this file. Please choose an .xlsx workbook.', true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------- wiring ----------

  function init() {
    const today = todayText();
    $('#taskTo').value = today;
    const start = new Date(Date.UTC(...today.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))));
    start.setUTCDate(start.getUTCDate() - 13);
    $('#taskFrom').value = start.toISOString().slice(0, 10);

    $('#loginForm').addEventListener('submit', signIn);
    $('#forcePwForm').addEventListener('submit', changeFirstPassword);
    $('#logoutBtn').addEventListener('click', signOut);
    $('#changePwBtn').addEventListener('click', () => $('#pwDialog').showModal());
    $('#pwForm').addEventListener('submit', changeOwnPassword);

    $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#newTaskBtn').addEventListener('click', () => openTaskDialog(null));
    $('#taskFrom').addEventListener('change', () => loadTasks().catch((e) => toast(e.message, true)));
    $('#taskTo').addEventListener('change', () => loadTasks().catch((e) => toast(e.message, true)));

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        handleTaskAction(btn.dataset.act, Number(btn.dataset.id));
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (row) openTaskDialog(Number(row.dataset.id));

      const personEdit = e.target.closest('[data-person-edit]');
      if (personEdit) openPersonDialog(Number(personEdit.dataset.personEdit));

      const userBtn = e.target.closest('[data-user-reset], [data-user-toggle]');
      if (userBtn) userAction(userBtn);
    });
    document.addEventListener('change', (e) => {
      if (e.target.matches('[data-user-role]')) changeRole(e.target);
    });

    $$('#kindSeg button').forEach((b) => b.addEventListener('click', () => {
      state.peopleKind = b.dataset.kind;
      renderPeople();
    }));
    $('#newPersonBtn').addEventListener('click', () => openPersonDialog(null));
    $('#personForm').addEventListener('submit', savePerson);
    $('#newUserBtn').addEventListener('click', openUserDialog);
    $('#userForm').addEventListener('submit', (e) => {
      if ($('#userResult').hidden) createUser(e);
      else e.preventDefault();
    });
    $('#copyTemp').addEventListener('click', () => {
      navigator.clipboard?.writeText($('#tempPass').textContent).then(() => toast('Copied'), () => toast('Select and copy the password', true));
    });

    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#taskForm').elements.particular.addEventListener('change', fillStandardFromHistory);
    $('#machineSelect').addEventListener('change', onMachineChange);
    $('#gaugeSelect').addEventListener('change', updateDiaGauge);
    $('#addTechBtn').addEventListener('click', () => addTechRow('').focus());
    $('#techRows').addEventListener('click', (e) => {
      const remove = e.target.closest('.tech-remove');
      if (!remove) return;
      remove.closest('.tech-row').remove();
      if (!$('#techRows').children.length) addTechRow('');
    });
    $('#deleteTaskBtn').addEventListener('click', async () => {
      const id = $('#taskForm').dataset.id;
      if (!id || !confirm('Delete this task? This cannot be undone.')) return;
      try {
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
        $('#taskDialog').close();
        toast('Task deleted');
        await loadTasks();
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#taskForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const body = {};
      TEXT_FIELDS.forEach((name) => { body[name] = form.elements[name].value; });
      WALL_FIELDS.forEach((name) => { body[name] = form.elements[name].value; });
      body.responsible_person = techValue();
      try {
        if (form.dataset.id) {
          await api(`/api/tasks/${form.dataset.id}`, { method: 'PATCH', body });
        } else {
          await api('/api/tasks', { method: 'POST', body: { ...body, start: form.elements.start_now.checked } });
        }
        $('#taskDialog').close();
        toast('Saved');
        await loadOptions();
        await loadTasks();
      } catch (err) {
        toast(err.message, true);
      }
    });

    ['#dashFrom', '#dashTo', '#dashTech', '#dashSup', '#dashExec'].forEach((sel) => {
      $(sel).addEventListener('change', () => window.Dashboard && window.Dashboard.refresh().catch((e) => toast(e.message, true)));
    });

    $('#importFile').addEventListener('change', (e) => {
      if (e.target.files[0]) readWorkbook(e.target.files[0]);
    });
    $('#previewBtn').addEventListener('click', previewImport);
    $('#commitBtn').addEventListener('click', commitImport);
    $('#importSheet').addEventListener('change', () => { state.previewed = false; $('#commitBtn').disabled = true; });

    setInterval(tick, 1000);
    restoreSession();
  }

  // Shared with dashboard.js
  window.TT = {
    state,
    $,
    $$,
    esc,
    api,
    toast,
    dmy,
    hhmm,
    hours,
    signedHours,
    percent,
    minutesText,
    efficiencyCell,
    efficiencyClass,
    canWrite,
    clientWallNow,
    wallMs,
    todayText,
    openTaskDialog,
    showTab,
  };

  init();
})();
