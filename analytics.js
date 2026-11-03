(function () {
  'use strict';

  const T = window.TT;
  const { $, esc, api, hours, percent, dmy, signedHours } = T;

  const LEVEL = {
    expert: ['Expert', 'lvl-expert'],
    proficient: ['Proficient', 'lvl-proficient'],
    competent: ['Competent', 'lvl-competent'],
    developing: ['Developing', 'lvl-developing'],
    new: ['1 job', 'lvl-new'],
    none: ['—', 'lvl-none'],
  };
  const STATUS = {
    train: ['Train', 'st-train'],
    watch: ['Watch', 'st-watch'],
    good: ['On track', 'st-good'],
    new: ['Too few jobs', 'st-new'],
  };

  const state = { skills: null, machines: null, machineSel: null };

  function chartReady() { return typeof window.echarts !== 'undefined'; }

  function defaultRange(fromId, toId) {
    if (!$(fromId).value) $(fromId).value = $('#dashFrom').value;
    if (!$(toId).value) $(toId).value = $('#dashTo').value;
  }

  function query(fromId, toId) {
    return new URLSearchParams({ from: $(fromId).value, to: $(toId).value });
  }

  // ---------- skill matrix ----------

  async function refreshSkills() {
    defaultRange('#skillFrom', '#skillTo');
    state.skills = await api(`/api/skills?${query('#skillFrom', '#skillTo')}`);
    renderSkills(state.skills);
  }

  function renderSkills(d) {
    const head = d.families.map((f) => `
      <th class="fam">${esc(f.name)}<span class="fam-n">${f.qualified_count} proficient+ · ${f.jobs} jobs</span></th>`).join('');

    const rows = d.technicians.map((t) => `<tr>
        <td class="name-cell"><b>${esc(t.name)}</b>
          <div class="muted small">${t.measured} measured · ${percent(t.efficiency_pct)} overall</div></td>
        ${d.families.map((f) => {
          const c = t.cells[f.name];
          if (!c || (!c.measured && !c.jobs)) return '<td class="lvl-cell"><span class="lvl lvl-none">—</span></td>';
          const [label, cls] = LEVEL[c.level] || LEVEL.none;
          const eff = c.efficiency_pct === null ? 'no rating yet' : percent(c.efficiency_pct);
          return `<td class="lvl-cell" title="${c.measured} measured of ${c.jobs} jobs">
            <span class="lvl ${cls}">${label}</span>
            <div class="muted small">${eff} · ${c.jobs} job${c.jobs === 1 ? '' : 's'}</div>
          </td>`;
        }).join('')}
      </tr>`).join('');

    const gaps = d.gaps.length
      ? d.gaps.map((g) => `<li><b>${esc(g.family)}</b>: ${g.qualified === 0 ? 'nobody' : `only ${g.qualified} person`} rated Proficient or better (${g.practised} practised). Train a second person before this is needed.</li>`).join('')
      : '<li class="muted">Every job family has at least two proficient people in this range.</li>';

    $('#skillContent').innerHTML = `
      <div class="panel">
        <div class="panel-head"><h3>Technician skill matrix</h3><span class="muted small">rated on weighted efficiency (standard ÷ actual)</span></div>
        <div class="legend">
          <span class="lvl lvl-expert">Expert</span> 115%+ ·
          <span class="lvl lvl-proficient">Proficient</span> 100–114% ·
          <span class="lvl lvl-competent">Competent</span> 85–99% ·
          <span class="lvl lvl-developing">Developing</span> under 85% ·
          <span class="lvl lvl-new">1 job</span> not rated yet
        </div>
        <p class="muted small">Needs at least ${d.thresholds.min_jobs} finished jobs in a family to be rated. Families come from keywords in the job name (for example “Servicing”, “Rib”, “Miss”).</p>
        ${d.technicians.length ? `<div class="table-wrap matrix-wrap"><table class="matrix"><thead><tr><th class="name-head">Technician</th>${head}</tr></thead>
          <tbody>${rows}</tbody></table></div>` : '<div class="empty">No technician has finished jobs in this range.</div>'}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Cover gaps</h3><span class="muted small">where one absence would hurt</span></div>
        <ul class="issue-list">${gaps}</ul>
      </div>`;
  }

  // ---------- machines ----------

  async function refreshMachines() {
    defaultRange('#machFrom', '#machTo');
    state.machines = await api(`/api/machines?${query('#machFrom', '#machTo')}`);
    renderMachines(state.machines);
  }

  function machineReason(m) {
    if (m.status !== 'train') return '';
    return m.reason === 'machine' ? 'Machine below 85% overall' : 'One person below 85% on this machine';
  }

  function renderMachines(d) {
    const s = d.summary;
    const worst = d.machines.filter((m) => m.measured >= 3).sort((a, b) => a.efficiency_pct - b.efficiency_pct)[0];
    const most = d.machines[0];
    const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${esc(sub || '')}</div></div>`;

    const rows = d.machines.map((m) => {
      const [label, cls] = STATUS[m.status];
      return `<tr data-mc="${m.machine_no}" class="${state.machineSel === String(m.machine_no) ? 'selected' : ''}">
        <td><b>M/C ${m.machine_no}</b></td>
        <td><span class="pill-status ${cls}">${label}</span><div class="muted small">${esc(machineReason(m))}</div></td>
        <td class="num">${m.jobs}</td>
        <td class="num">${m.efficiency_pct === null ? '–' : efficiencyCell(m.efficiency_pct)}</td>
        <td class="num bad">${hours(m.extra_hours, 1)}</td>
        <td class="num good">${hours(m.saved_hours, 1)}</td>
        <td class="num">${m.over_jobs}</td>
        <td class="num">${m.response_avg_min === null ? '–' : `${Math.round(m.response_avg_min)} min`}</td>
        <td>${m.training_focus ? esc(m.training_focus) : '<span class="neutral">–</span>'}</td>
      </tr>`;
    }).join('');

    $('#machContent').innerHTML = `
      <div class="kpis">
        ${kpi('Machines in use', s.machines, `${d.machines.reduce((a, m) => a + m.jobs, 0)} jobs`)}
        ${kpi('Need training', s.train_count, 'machine or person below 85%')}
        ${kpi('Lowest efficiency', worst ? `M/C ${worst.machine_no}` : '–', worst ? `${percent(worst.efficiency_pct)} on ${worst.measured} jobs` : 'needs 3+ jobs')}
        ${kpi('Most extra time', most ? `M/C ${most.machine_no}` : '–', most ? `${hours(most.extra_hours, 1)} over standard` : '')}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Efficiency by machine</h3><span class="muted small">red = train · amber = watch · green = on track · line = 100% · bars capped at 200%</span></div>
        <div id="machChart" class="chart"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Machine table</h3><span class="muted small">tap a machine for its technicians and overrun jobs</span></div>
        ${d.machines.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Machine</th><th>Status</th><th class="num">Jobs</th><th class="num">Efficiency</th>
          <th class="num">Extra</th><th class="num">Saved</th><th class="num">Over std</th><th class="num">Avg wait</th><th>Training focus</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : '<div class="empty">No machine data in this range.</div>'}
      </div>
      <div id="machDetail"></div>`;

    drawMachineChart(d);
    if (state.machineSel !== null) renderMachineDetail(state.machineSel);
  }

  function efficiencyCell(p) {
    const cls = p >= 100 ? 'ok' : p >= 85 ? 'warn' : 'bad';
    return `<span class="eff ${cls}">${p.toFixed(0)}%</span>`;
  }

  function drawMachineChart(d) {
    const el = document.getElementById('machChart');
    if (!el) return;
    if (!chartReady()) { el.innerHTML = '<div class="empty">Charts need internet access to load ECharts.</div>'; return; }
    const rows = d.machines.filter((m) => m.efficiency_pct !== null)
      .sort((a, b) => String(a.machine_no).localeCompare(String(b.machine_no), undefined, { numeric: true }));
    if (!rows.length) { el.innerHTML = '<div class="empty">No rated machines in this range.</div>'; return; }
    const colorOf = { train: '#fb7185', watch: '#fbbf24', good: '#34d399', new: '#64748b' };
    let chart = window.echarts.getInstanceByDom(el);
    if (chart) chart.dispose();
    chart = window.echarts.init(el);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 52, right: 18, top: 24, bottom: 46 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (p) => {
          const m = rows[p[0].dataIndex];
          return `<b>M/C ${m.machine_no}</b><br>Efficiency ${m.efficiency_pct.toFixed(1)}%<br>${m.measured} measured jobs<br>Extra ${m.extra_hours.toFixed(1)} h`;
        },
      },
      xAxis: { type: 'category', data: rows.map((m) => m.machine_no), axisLabel: { color: '#8ea0c4', fontSize: 11, rotate: rows.length > 14 ? 45 : 0 } },
      yAxis: { type: 'value', max: 200, axisLabel: { color: '#8ea0c4', formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(148,170,220,.12)' } } },
      series: [{
        type: 'bar',
        barMaxWidth: 26,
        data: rows.map((m) => ({
          value: Number(Math.min(m.efficiency_pct, 200).toFixed(1)), // capped so one tiny job does not flatten the rest
          itemStyle: { borderRadius: [8, 8, 0, 0], color: colorOf[m.status], shadowBlur: 14, shadowColor: colorOf[m.status] },
        })),
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 100, lineStyle: { color: '#e8eefc', type: 'dashed' } }] },
      }],
    });
    chart.on('click', (p) => {
      const m = rows[p.dataIndex];
      state.machineSel = String(m.machine_no);
      renderMachines(state.machines);
    });
    window.addEventListener('resize', () => chart.resize());
  }

  function renderMachineDetail(machineNo) {
    const d = state.machines;
    const m = d && d.machines.find((x) => String(x.machine_no) === machineNo);
    const box = $('#machDetail');
    if (!box || !m) return;
    const people = m.people.map((p) => {
      const width = Math.min(100, (p.efficiency_pct ?? 0) / 1.5);
      const cls = p.efficiency_pct === null ? '' : p.efficiency_pct >= 100 ? 'ok' : p.efficiency_pct >= 85 ? 'warn' : 'bad';
      return `<div class="person-row">
        <div class="person-name">${esc(p.name)}</div>
        <div class="person-track"><div class="person-fill ${cls}" style="width:${width.toFixed(0)}%"></div></div>
        <div class="person-val">${p.efficiency_pct === null ? '–' : percent(p.efficiency_pct)} <span class="muted small">${p.measured} jobs</span></div>
      </div>`;
    }).join('');
    const overruns = m.top_extra.length
      ? `<ul class="issue-list">${m.top_extra.map((j) => `<li><b>${dmy(j.task_date)}</b> · ${esc(j.particular)} · ${esc(j.responsible || 'no person')} · <span class="bad">+${j.extra_hours.toFixed(1)} h</span></li>`).join('')}</ul>`
      : '<p class="muted">No overrun jobs on this machine in this range.</p>';
    const families = m.families.map((f) => `<span class="pill">${esc(f.family)} · ${f.jobs}</span>`).join(' ');
    box.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h3>M/C ${m.machine_no} · who works here</h3>
          <span class="pill-status ${STATUS[m.status][1]}">${STATUS[m.status][0]}</span></div>
        <p class="muted small">${esc(machineReason(m)) || 'Lowest first. Coach from the bottom of this list.'}</p>
        ${people || '<p class="muted">No rated technicians on this machine yet.</p>'}
        <div class="panel-head" style="margin-top:14px"><h3>Overrun jobs</h3></div>
        ${overruns}
        <div style="margin-top:8px">${families}</div>
      </div>`;
  }

  // Clicking a row selects that machine and shows its detail below the table.
  document.addEventListener('click', (e) => {
    const row = e.target.closest('#machContent tr[data-mc]');
    if (!row) return;
    state.machineSel = row.dataset.mc;
    renderMachines(state.machines);
    $('#machDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  ['#skillFrom', '#skillTo'].forEach((sel) => $(sel).addEventListener('change', () => refreshSkills().catch((e) => T.toast(e.message, true))));
  ['#machFrom', '#machTo'].forEach((sel) => $(sel).addEventListener('change', () => refreshMachines().catch((e) => T.toast(e.message, true))));

  window.Analytics = { refreshSkills, refreshMachines };
})();
