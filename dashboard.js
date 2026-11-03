(function () {
  'use strict';

  const T = window.TT;
  const { $, $$, esc, api, dmy, hours, signedHours, percent, minutesText, efficiencyClass } = T;
  const MIN_JOBS_FOR_PODIUM = 3;
  const PALETTE = ['#22d3ee', '#8b5cf6', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a3e635', '#f97316', '#e879f9'];

  const view = { period: 'week', data: null, charts: {} };

  // ---------- small visual helpers ----------

  function periodLabel(key, period) {
    if (period === 'month') {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }
    if (period === 'week') return `Wk ${dmy(key)}`;
    return dmy(key);
  }

  // Smooth sparkline with a glowing area. Gaps (null) break the line.
  function sparkline(values, color) {
    const w = 120;
    const h = 40;
    const clean = values.map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v));
    if (clean.length < 2) return '<svg viewBox="0 0 120 40" preserveAspectRatio="none"></svg>';
    const min = Math.min(...clean.map((p) => p.v));
    const max = Math.max(...clean.map((p) => p.v));
    const span = max - min || 1;
    const x = (i) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * w);
    const y = (v) => h - 4 - ((v - min) / span) * (h - 10);
    const pts = clean.map((p) => [x(p.i), y(p.v)]);
    const line = pts.map((p, idx) => `${idx ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" style="filter:drop-shadow(0 0 4px ${color})"/>
    </svg>`;
  }

  // Circular gauge for an efficiency percentage.
  function ring(pct, size = 64) {
    const r = 26;
    const c = 2 * Math.PI * r;
    const value = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(pct, 150));
    const dash = (Math.min(value, 100) / 100) * c;
    const color = efficiencyClass(pct) === 'ok' ? '#34d399' : efficiencyClass(pct) === 'warn' ? '#fbbf24' : pct === null || pct === undefined ? '#64748b' : '#fb7185';
    const id = `r${Math.random().toString(36).slice(2, 8)}`;
    return `<div class="ring" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 64 64">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient></defs>
        <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/>
        <circle cx="32" cy="32" r="${r}" fill="none" stroke="url(#${id})" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" style="filter:drop-shadow(0 0 6px ${color}55)"/>
      </svg>
      <div class="ring-value">${pct === null || pct === undefined ? '–' : `${Math.round(pct)}%`}</div>
    </div>`;
  }

  function deltaBadge(change) {
    if (change === null || change === undefined) return '<span class="delta flat">no change data</span>';
    if (Math.abs(change) < 0.5) return '<span class="delta flat">▬ steady</span>';
    return change > 0
      ? `<span class="delta up">▲ ${change.toFixed(0)} pts</span>`
      : `<span class="delta down">▼ ${Math.abs(change).toFixed(0)} pts</span>`;
  }

  // Tilt towards the pointer. Used on KPI cards and technician cards.
  function bindTilt(root) {
    root.querySelectorAll('.kpi, .tech-card').forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        el.style.setProperty('--ry', `${(px - 0.5) * 14}deg`);
        el.style.setProperty('--rx', `${(0.5 - py) * 12}deg`);
        el.style.setProperty('--mx', `${px * 100}%`);
        el.style.setProperty('--my', `${py * 100}%`);
      });
      el.addEventListener('mouseleave', () => {
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    });
  }

  // ---------- charts (ECharts, optional: the page works without them) ----------

  function chartReady() {
    return typeof window.echarts !== 'undefined';
  }

  function drawChart(id, option, height) {
    const el = document.getElementById(id);
    if (!el || !chartReady()) return;
    el.style.height = height || el.style.height;
    let chart = window.echarts.getInstanceByDom(el);
    if (chart) chart.dispose();
    chart = window.echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(option, true);
    view.charts[id] = chart;
    window.addEventListener('resize', () => chart.resize());
  }

  const axisText = { color: '#8ea0c4', fontSize: 11 };
  const splitLine = { lineStyle: { color: 'rgba(148,170,220,0.12)' } };

  function techBar3D(d) {
    const techs = d.technicians.filter((t) => !t.team && t.measured > 0).sort((a, b) => b.measured - a.measured).slice(0, 10);
    const keys = d.period_keys.slice(-8);
    if (!techs.length || !keys.length) return null;
    const data = [];
    techs.forEach((t, x) => {
      keys.forEach((key, y) => {
        const idx = d.period_keys.indexOf(key);
        const point = t.trend.points[idx];
        const value = point && point.efficiency_pct !== null ? Math.min(point.efficiency_pct, 180) : 0;
        data.push([x, y, Number(value.toFixed(1))]);
      });
    });
    return {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (p) => `${techs[p.value[0]].name}<br>${periodLabel(keys[p.value[1]], view.period)}: <b>${p.value[2]}%</b>`,
      },
      visualMap: {
        show: true, min: 0, max: 130, dimension: 2, orient: 'horizontal', left: 'center', bottom: 0,
        textStyle: { color: '#8ea0c4' }, inRange: { color: ['#fb7185', '#fbbf24', '#34d399', '#22d3ee'] },
      },
      xAxis3D: { type: 'category', data: techs.map((t) => t.name), axisLabel: { textStyle: axisText } },
      yAxis3D: { type: 'category', data: keys.map((k) => periodLabel(k, view.period)), axisLabel: { textStyle: axisText } },
      zAxis3D: { type: 'value', name: 'Efficiency %', nameTextStyle: axisText, axisLabel: { textStyle: axisText } },
      grid3D: {
        boxWidth: 230, boxDepth: 120, boxHeight: 90,
        viewControl: { alpha: 22, beta: 35, distance: 260, autoRotate: true, autoRotateSpeed: 6, rotateSensitivity: 1.2 },
        light: { main: { intensity: 1.3, shadow: true }, ambient: { intensity: 0.45 } },
        environment: 'transparent',
        axisPointer: { show: false },
        splitLine: { lineStyle: { color: 'rgba(148,170,220,0.2)' } },
      },
      series: [{
        type: 'bar3D',
        shading: 'realistic',
        barSize: 14,
        realisticMaterial: { roughness: 0.25, metalness: 0.2 },
        itemStyle: { opacity: 0.95 },
        emphasis: { itemStyle: { color: '#f8fafc' } },
        data,
      }],
    };
  }

  function executiveTrend(d) {
    const keys = d.period_keys;
    if (!keys.length) return null;
    return {
      backgroundColor: 'transparent',
      color: PALETTE,
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null ? '–' : `${Number(v).toFixed(1)}%`) },
      legend: { textStyle: { color: '#c7d2fe' }, top: 0, icon: 'roundRect' },
      grid: { left: 44, right: 16, top: 42, bottom: 28 },
      xAxis: { type: 'category', data: keys.map((k) => periodLabel(k, view.period)), axisLabel: axisText, axisLine: { lineStyle: { color: 'rgba(148,170,220,.3)' } } },
      yAxis: { type: 'value', axisLabel: { ...axisText, formatter: '{value}%' }, splitLine },
      series: d.executives.map((e, i) => ({
        name: e.name,
        type: 'line',
        smooth: true,
        symbolSize: 7,
        lineStyle: { width: 3, shadowBlur: 12, shadowColor: PALETTE[i % PALETTE.length] },
        areaStyle: { opacity: 0.12 },
        connectNulls: true,
        data: e.trend.points.map((p) => (p.efficiency_pct === null ? null : Number(p.efficiency_pct.toFixed(1)))),
      })),
    };
  }

  function supervisorBars(d) {
    const rows = d.supervisors.filter((s) => s.measured >= MIN_JOBS_FOR_PODIUM).slice(0, 12).reverse();
    if (!rows.length) return null;
    return {
      backgroundColor: 'transparent',
      grid: { left: 110, right: 40, top: 10, bottom: 20 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${Number(v).toFixed(1)}%` },
      xAxis: { type: 'value', axisLabel: { ...axisText, formatter: '{value}%' }, splitLine },
      yAxis: { type: 'category', data: rows.map((s) => s.name), axisLabel: { color: '#c7d2fe', fontSize: 12 } },
      series: [{
        type: 'bar',
        barWidth: 14,
        data: rows.map((s) => ({
          value: Number((s.efficiency_pct ?? 0).toFixed(1)),
          itemStyle: {
            borderRadius: [0, 10, 10, 0],
            color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#8b5cf6' }, { offset: 1, color: '#22d3ee' }] },
          },
        })),
        label: { show: true, position: 'right', color: '#e8eefc', formatter: '{c}%', fontSize: 11 },
      }],
    };
  }

  // ---------- sections ----------

  function renderKpis(d) {
    const s = d.summary;
    const spark = (key) => d.periods.map((p) => p.summary[key]);
    const cards = [
      { label: 'Jobs measured', value: s.measured, cls: 'grad', sub: `${s.done} finished · ${s.running} running`, spark: spark('measured'), color: '#22d3ee' },
      { label: 'Efficiency', value: percent(s.efficiency_pct), cls: '', sub: 'standard ÷ actual', spark: spark('efficiency_pct'), color: '#34d399' },
      { label: 'Net time', value: signedHours(s.variance_hours), cls: s.variance_hours > 0 ? 'bad' : 'good', sub: 'negative = saved overall', spark: spark('variance_hours'), color: '#8b5cf6' },
      { label: 'Extra time', value: hours(s.extra_hours), cls: 'bad', sub: `${s.over_jobs} job(s) over standard`, spark: spark('extra_hours'), color: '#fb7185' },
      { label: 'Time saved', value: hours(s.saved_hours), cls: 'good', sub: 'finished before standard', spark: spark('saved_hours'), color: '#34d399' },
      { label: 'Wait before work', value: minutesText(d.delays.response_avg_min), cls: '', sub: `average · ${d.delays.response_count} jobs`, spark: [], color: '#f472b6' },
    ];
    return `<div class="kpis">${cards.map((c, i) => `
      <div class="kpi" style="animation: rise .6s ${i * 0.07}s both">
        <div class="label">${esc(c.label)}</div>
        <div class="value ${c.cls}">${esc(c.value)}</div>
        <div class="sub">${esc(c.sub)}</div>
        <div class="spark">${c.spark.length > 1 ? sparkline(c.spark, c.color) : ''}</div>
      </div>`).join('')}</div>`;
  }

  function renderPodium(d) {
    const top = d.technicians.filter((t) => !t.team && t.measured >= MIN_JOBS_FOR_PODIUM).slice(0, 3);
    if (top.length < 3) {
      return `<div class="podium"><div class="podium-empty">The podium needs at least three technicians with finished jobs in this range.</div></div>`;
    }
    const slot = (t, cls, rank) => `
      <div class="podium-slot ${cls}">
        <div class="podium-name">${esc(t.name)}</div>
        <div class="podium-stat">${percent(t.efficiency_pct)} · ${t.measured} jobs</div>
        <div class="podium-block"><div class="face">${rank}</div></div>
      </div>`;
    return `<div class="podium">
      ${slot(top[1], 'second', 2)}
      ${slot(top[0], 'first', 1)}
      ${slot(top[2], 'third', 3)}
    </div>`;
  }

  function techCard(t, rank) {
    const rankCls = rank && rank <= 3 ? `r${rank}` : '';
    const extraPct = t.measured ? Math.min(100, (t.extra_hours / Math.max(t.extra_hours, t.saved_hours, 1)) * 100) : 0;
    const savedPct = t.measured ? Math.min(100, (t.saved_hours / Math.max(t.extra_hours, t.saved_hours, 1)) * 100) : 0;
    const color = efficiencyClass(t.efficiency_pct) === 'ok' ? '#34d399' : efficiencyClass(t.efficiency_pct) === 'warn' ? '#fbbf24' : '#fb7185';
    return `<article class="tech-card" data-tech="${esc(t.name)}" style="animation: rise .6s ${Math.min(rank, 12) * 0.04}s both">
      <div class="tech-top">
        <span class="rank ${rankCls}">${rank ?? '–'}</span>
        ${ring(t.efficiency_pct, 60)}
        <div style="min-width:0">
          <div class="tech-name">${esc(t.name)}</div>
          <div class="tech-sub">${t.measured} measured · ${t.jobs} total</div>
        </div>
      </div>
      <div class="tech-metrics">
        <div>Actual<b>${hours(t.actual_hours, 1)}</b></div>
        <div>Standard<b>${hours(t.standard_hours, 1)}</b></div>
        <div>Extra<b style="color:#fb7185">${hours(t.extra_hours, 1)}</b></div>
        <div>Saved<b style="color:#34d399">${hours(t.saved_hours, 1)}</b></div>
      </div>
      <div class="mini-bars">
        <div class="mini-bar"><span>Extra</span><div class="track"><div class="fill extra" style="width:${extraPct.toFixed(0)}%"></div></div><span>${t.over_jobs} jobs</span></div>
        <div class="mini-bar"><span>Saved</span><div class="track"><div class="fill saved" style="width:${savedPct.toFixed(0)}%"></div></div><span>${t.measured - t.over_jobs} jobs</span></div>
      </div>
      <div class="tech-foot">
        ${deltaBadge(t.trend.change_pts)}
        <div class="spark" style="flex:1;margin-left:10px">${sparkline(t.trend.points.map((p) => p.efficiency_pct), color)}</div>
      </div>
    </article>`;
  }

  function renderTechnicians(d) {
    const people = d.technicians.filter((t) => !t.team && t.measured > 0);
    const ranked = people.filter((t) => t.measured >= MIN_JOBS_FOR_PODIUM);
    const notRanked = people.filter((t) => t.measured < MIN_JOBS_FOR_PODIUM);
    const team = d.technicians.find((t) => t.team);
    const rankedCards = ranked.map((t, i) => techCard(t, i + 1)).join('');
    const smallCards = notRanked.map((t) => techCard(t, null)).join('');
    const divider = notRanked.length
      ? `<div class="grid-divider">Not ranked yet · fewer than ${MIN_JOBS_FOR_PODIUM} finished jobs</div>`
      : '';
    const teamCard = team && team.measured > 0 ? `
      <article class="tech-card" data-tech="Team jobs" style="border-style:dashed">
        <div class="tech-top">
          <span class="rank">T</span>
          ${ring(team.efficiency_pct, 60)}
          <div><div class="tech-name">Team jobs</div><div class="tech-sub">Several people on one job. Not split between people.</div></div>
        </div>
        <div class="tech-metrics">
          <div>Jobs<b>${team.measured}</b></div>
          <div>Extra<b style="color:#fb7185">${hours(team.extra_hours, 1)}</b></div>
        </div>
      </article>` : '';
    const empty = !rankedCards && !smallCards ? '<div class="empty">No technicians with finished jobs in this range.</div>' : '';
    return `<div class="tech-grid">${rankedCards}${divider}${smallCards}${teamCard}${empty}</div>`;
  }

  function renderExecutives(d) {
    if (!d.executives.length) return '<div class="empty">No executive data.</div>';
    return `<div class="tech-grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">
      ${d.executives.map((e) => `
        <div class="tech-card" style="cursor:default">
          <div class="tech-top">${ring(e.efficiency_pct, 56)}
            <div><div class="tech-name">${esc(e.name)}</div><div class="tech-sub">${e.measured} measured</div></div></div>
          <div class="tech-metrics">
            <div>Extra<b style="color:#fb7185">${hours(e.extra_hours, 1)}</b></div>
            <div>Saved<b style="color:#34d399">${hours(e.saved_hours, 1)}</b></div>
          </div>
        </div>`).join('')}
    </div>`;
  }

  function renderInsights(d) {
    const topJobs = d.technicians
      .flatMap((t) => t.top_extra.map((j) => ({ ...j, who: t.name })))
      .sort((a, b) => b.extra_hours - a.extra_hours)
      .slice(0, 6);
    const watch = d.technicians.filter((t) => !t.team && t.measured >= 2 && t.efficiency_pct !== null && t.efficiency_pct < 85);
    const standards = d.particulars.filter((p) => p.standards.length > 1).slice(0, 6);
    const waitVsRestart = d.delays.response_avg_min !== null && d.delays.restart_avg_min !== null
      && d.delays.restart_avg_min > d.delays.response_avg_min;
    const issues = d.issues.total;

    const card = (tag, title, body, alert) => `
      <div class="insight ${alert ? 'alert' : ''}"><div class="tag">${esc(tag)}</div><h4>${esc(title)}</h4>${body}</div>`;

    return `<div class="insights">
      ${card('Extra time', 'Biggest overruns', topJobs.length
        ? `<ul>${topJobs.map((j) => `<li><b>${esc(j.who)}</b> · ${esc(j.particular)} (M/C ${j.machine_no ?? '–'}, ${dmy(j.task_date)}): <b>+${j.extra_hours.toFixed(1)} h</b></li>`).join('')}</ul>`
        : '<p class="muted">No job went over standard in this range.</p>', topJobs.length > 0)}
      ${card('Coaching', 'Below 85% efficiency', watch.length
        ? `<ul>${watch.map((t) => `<li><b>${esc(t.name)}</b>: ${percent(t.efficiency_pct)} on ${t.measured} jobs, ${hours(t.extra_hours, 1)} extra</li>`).join('')}</ul>`
        : '<p class="muted">Nobody is below 85% in this range.</p>', watch.length > 0)}
      ${card('Standards', 'Same job, different standard', standards.length
        ? `<ul>${standards.map((p) => `<li><b>${esc(p.particular)}</b>: ${p.standards.map((v) => `${v} h`).join(' / ')}</li>`).join('')}</ul><p class="muted small">Agree one standard per job type, so the numbers stay fair.</p>`
        : '<p class="muted">Each job name has one standard.</p>', standards.length > 0)}
      ${card('Machines', 'Waiting time', `<p class="muted">Machine waits <b>${minutesText(d.delays.response_avg_min)}</b> before work starts and <b>${minutesText(d.delays.restart_avg_min)}</b> to run again after work ends.</p>${waitVsRestart ? '<p class="muted small">The restart gap is longer than the start wait. Check the hand-back step after work finishes.</p>' : ''}`, waitVsRestart)}
      ${card('Data', 'Records to check', `<p class="muted"><b>${issues}</b> job(s) in this range need a look. Common causes: no end time, a missing person, or a stop time that does not fit.</p>`, issues > 0)}
    </div>`;
  }

  function renderPage(d) {
    const s = d.summary;
    const range = d.filters.from || d.filters.to ? `${dmy(d.filters.from)} → ${dmy(d.filters.to)}` : 'all dates';
    const focus = d.filters.technician ? ` · ${esc(d.filters.technician)}` : '';
    $('#dashContent').innerHTML = `
      <div class="panel" style="padding:22px 22px 18px;margin-bottom:16px;background:linear-gradient(120deg,rgba(139,92,246,.25),rgba(34,211,238,.12) 60%,rgba(244,114,182,.1))">
        <div class="panel-head" style="margin:0;justify-content:flex-start;gap:18px"><div class="logo-tile logo-hero tilt3d"><img src="brand/logo.jpg" alt="Impress Newtex"></div>
          <div>
            <h2 style="margin:0;font-size:26px;letter-spacing:-.02em">Technician performance${focus}</h2>
            <div class="muted small" style="margin-top:4px">${esc(d.filters.period === 'month' ? 'Monthly' : d.filters.period === 'week' ? 'Weekly (weeks start Saturday)' : 'Daily')} · ${esc(range)} · ${s.measured} jobs measured</div>
          </div>
          <div class="pill on">Standard ${hours(s.standard_hours, 1)} vs actual ${hours(s.actual_hours, 1)}</div>
        </div>
      </div>
      ${renderKpis(d)}
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h3>Top three technicians</h3><span class="muted small">min ${MIN_JOBS_FOR_PODIUM} measured jobs for the podium</span></div>
          ${renderPodium(d)}
        </div>
        <div class="panel">
          <div class="panel-head"><h3>3D: efficiency by technician and period</h3><span class="muted small">drag to rotate · taller = more efficient</span></div>
          <div id="chart3d" class="chart tall"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Technician leaderboard</h3><span class="muted small">Tap a card for the full breakdown</span></div>
        ${renderTechnicians(d)}
      </div>
      <div class="grid-2 even">
        <div class="panel">
          <div class="panel-head"><h3>Executives</h3><span class="muted small">efficiency and extra time</span></div>
          ${renderExecutives(d)}
          <div id="execTrend" class="chart" style="margin-top:12px"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Supervisors</h3><span class="muted small">efficiency on their shifts · groups with ${MIN_JOBS_FOR_PODIUM}+ jobs</span></div>
          <div id="supBars" class="chart"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Improvement focus</h3><span class="muted small">generated from this range's data</span></div>
        ${renderInsights(d)}
      </div>`;

    if (!d.technicians.length) {
      $('#dashContent').insertAdjacentHTML('beforeend', '<div class="empty">No jobs in this range. Try a wider date range.</div>');
    }
    bindTilt($('#dashContent'));
    if (!chartReady()) {
      $$('#dashContent .chart').forEach((c) => { c.innerHTML = '<div class="empty">Charts need internet access to load ECharts.</div>'; });
      return;
    }
    const t3 = techBar3D(d);
    if (t3) drawChart('chart3d', t3); else $('#chart3d').innerHTML = '<div class="empty">No technician data for the 3D view.</div>';
    const tr = executiveTrend(d);
    if (tr) drawChart('execTrend', tr); else $('#execTrend').innerHTML = '<div class="empty">No trend yet.</div>';
    const sb = supervisorBars(d);
    if (sb) drawChart('supBars', sb); else $('#supBars').innerHTML = '<div class="empty">No supervisor data.</div>';
  }

  // ---------- detail window for one technician ----------

  async function openTechnician(name) {
    const d = view.data;
    const tech = d.technicians.find((t) => t.name === name);
    if (!tech) return;
    $('#techTitle').textContent = name;
    const tasks = await api(`/api/tasks?from=${d.filters.from || '2000-01-01'}&to=${d.filters.to || '2100-12-31'}`);
    const jobs = tasks.tasks
      .filter((t) => (name === 'Team jobs' ? t.responsible_person && t.responsible_person.includes(',') : t.responsible_person === name))
      .filter((t) => t.status === 'done')
      .sort((a, b) => b.work_end_at.localeCompare(a.work_end_at));
    const rows = jobs.slice(0, 80).map((t) => {
      const v = t.metrics.variance_hours;
      return `<tr>
        <td>${dmy(t.task_date)}</td><td>${t.machine_no ?? ''}</td><td class="wrap-text">${esc(t.particular)}</td>
        <td>${esc(t.executive || '–')}</td><td class="num">${hours(t.standard_hours)}</td>
        <td class="num">${hours(t.metrics.actual_hours)}</td>
        <td class="num ${v === null ? 'neutral' : v > 0 ? 'bad' : 'good'}">${signedHours(v)}</td>
      </tr>`;
    }).join('');
    $('#techBody').innerHTML = `
      <div class="detail-kpis">
        <div class="kpi"><div class="label">Efficiency</div><div class="value grad">${percent(tech.efficiency_pct)}</div></div>
        <div class="kpi"><div class="label">Jobs measured</div><div class="value">${tech.measured}</div></div>
        <div class="kpi"><div class="label">Extra time</div><div class="value bad">${hours(tech.extra_hours, 1)}</div></div>
        <div class="kpi"><div class="label">Time saved</div><div class="value good">${hours(tech.saved_hours, 1)}</div></div>
      </div>
      <div class="panel" style="margin:0 0 12px"><div class="panel-head"><h3>Efficiency trend</h3>${deltaBadge(tech.trend.change_pts)}</div>
        <div id="techTrend" class="chart short"></div></div>
      <div class="table-wrap"><table><thead><tr>
        <th>Date</th><th>M/C</th><th>Job</th><th>Executive</th><th class="num">Standard</th><th class="num">Actual</th><th class="num">Extra / saved</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7" class="neutral">No finished jobs in this range.</td></tr>'}</tbody></table></div>`;
    $('#techDialog').showModal();
    if (chartReady()) {
      drawChart('techTrend', {
        backgroundColor: 'transparent',
        grid: { left: 44, right: 16, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null ? '–' : `${Number(v).toFixed(1)}%`) },
        xAxis: { type: 'category', data: d.period_keys.map((k) => periodLabel(k, view.period)), axisLabel: axisText },
        yAxis: { type: 'value', axisLabel: { ...axisText, formatter: '{value}%' }, splitLine },
        series: [{
          type: 'line', smooth: true, symbolSize: 8, connectNulls: true,
          lineStyle: { width: 3, color: '#22d3ee', shadowBlur: 14, shadowColor: '#22d3ee' },
          itemStyle: { color: '#8b5cf6' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(34,211,238,.45)' }, { offset: 1, color: 'rgba(34,211,238,0)' }] } },
          markLine: { silent: true, symbol: 'none', data: [{ yAxis: 100, lineStyle: { color: '#34d399', type: 'dashed' } }], label: { color: '#34d399', formatter: 'standard' } },
          data: tech.trend.points.map((p) => (p.efficiency_pct === null ? null : Number(p.efficiency_pct.toFixed(1)))),
        }],
      });
    }
  }

  // The leaderboard is shown with `deltaBadge` too, so keep one definition.
  function deltaBadgeInline(change) { return deltaBadge(change); }

  // ---------- loading and filters ----------

  function currentQuery() {
    return new URLSearchParams({
      from: $('#dashFrom').value,
      to: $('#dashTo').value,
      period: view.period,
      technician: $('#dashTech').value,
      supervisor: $('#dashSup').value,
      executive: $('#dashExec').value,
    });
  }

  async function refresh() {
    $('#dashContent').innerHTML = '<div class="empty">Loading performance…</div>';
    const d = await api(`/api/dashboard?${currentQuery()}`);
    view.data = d;
    renderPage(d);
  }

  function bindFilters() {
    $$('#periodSeg button').forEach((b) => b.addEventListener('click', () => {
      view.period = b.dataset.period;
      $$('#periodSeg button').forEach((x) => x.classList.toggle('on', x === b));
      refresh().catch((e) => T.toast(e.message, true));
    }));
    $('#dashContent').addEventListener('click', (e) => {
      const card = e.target.closest('[data-tech]');
      if (card) openTechnician(card.dataset.tech).catch((err) => T.toast(err.message, true));
    });
    window.addEventListener('resize', () => Object.values(view.charts).forEach((c) => c.resize()));
  }

  bindFilters();

  window.Dashboard = { refresh, deltaBadgeInline };
})();
