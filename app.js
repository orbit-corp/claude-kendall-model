/* =========================================================================
   M/M/1 discrete-event simulator
   ========================================================================= */

// ---- Parameters ----
const state = {
  lambda: 1.0,
  mu:     1.5,
  speed:  1.0,        // sim-seconds per real-second
  running: false,
  simTime: 0.0,
  N: 0,               // current system size X(t)
  nextArrivalT: 0.0,  // absolute sim time of next arrival
  nextDepartureT: Infinity, // Infinity if server idle
  queue: [],          // array of customer objects in the waiting line (excludes the one in service)
  inService: null,    // customer currently being served (or null)
  nextId: 1,
  // Counters
  arrivals: 0,
  departures: 0,
  // Time-averaged stats accumulators
  timeInState: [],    // timeInState[k] = cumulative sim time with X = k
  lastStateChangeT: 0,
  sumSojourn: 0.0,    // sum of (depart - arrive)
  sumWait: 0.0,       // sum of (serviceStart - arrive)
  // Event history for time-series chart (rolling)
  tsHistory: [],      // [{t, x}]
  tsMaxPoints: 2000,
  tsWindowSec: 60,    // visible window
  // Departure inter-arrivals for Burke chart
  lastDepartureT: null,
  interDepartures: [],
  interDepMax: 2000,
  // Log
  log: [],
  logMax: 100,
};

// ---- Random helpers ----
function expRand(rate) {
  // inverse-CDF sampler for Exp(rate)
  return -Math.log(1 - Math.random()) / rate;
}

// ---- Initialization / reset ----
function reset() {
  state.simTime = 0;
  state.N = 0;
  state.queue = [];
  state.inService = null;
  state.nextId = 1;
  state.arrivals = 0;
  state.departures = 0;
  state.timeInState = [];
  state.lastStateChangeT = 0;
  state.sumSojourn = 0;
  state.sumWait = 0;
  state.tsHistory = [{ t: 0, x: 0 }];
  state.lastDepartureT = null;
  state.interDepartures = [];
  state.log = [];
  document.getElementById('logList').innerHTML = '';
  scheduleNextArrival();
  state.nextDepartureT = Infinity;
  render();
}

function scheduleNextArrival() {
  state.nextArrivalT = state.simTime + expRand(state.lambda);
}

// Record time accumulated at current state before transition
function accumulateTime(toT) {
  const dt = toT - state.lastStateChangeT;
  if (dt <= 0) return;
  const k = state.N;
  while (state.timeInState.length <= k) state.timeInState.push(0);
  state.timeInState[k] += dt;
  state.lastStateChangeT = toT;
}

function pushHistory(t, x) {
  state.tsHistory.push({ t, x });
  if (state.tsHistory.length > state.tsMaxPoints) {
    state.tsHistory.splice(0, state.tsHistory.length - state.tsMaxPoints);
  }
}

function logEvent(type, info) {
  const entry = { t: state.simTime, type, info };
  state.log.unshift(entry);
  if (state.log.length > state.logMax) state.log.pop();
  const li = document.createElement('li');
  const tStr = state.simTime.toFixed(2);
  li.innerHTML = `<span class="t">t=${tStr}</span><span class="${type === 'arrive' ? 'arr' : 'dep'}">${info}</span>`;
  const ul = document.getElementById('logList');
  ul.insertBefore(li, ul.firstChild);
  while (ul.childNodes.length > state.logMax) ul.removeChild(ul.lastChild);
}

// ---- Event processing ----
function processArrival() {
  accumulateTime(state.nextArrivalT);
  state.simTime = state.nextArrivalT;
  const c = { id: state.nextId++, arriveT: state.simTime };
  state.arrivals++;
  if (state.inService === null) {
    // server is idle: start service immediately
    c.serviceStartT = state.simTime;
    c.serviceTime = expRand(state.mu);
    c.departT = state.simTime + c.serviceTime;
    state.inService = c;
    state.nextDepartureT = c.departT;
  } else {
    state.queue.push(c);
  }
  state.N++;
  pushHistory(state.simTime, state.N);
  scheduleNextArrival();
  logEvent('arrive', `arrival #${c.id} → X=${state.N}`);
}

function processDeparture() {
  accumulateTime(state.nextDepartureT);
  state.simTime = state.nextDepartureT;
  const c = state.inService;
  c.departT = state.simTime;
  state.sumSojourn += (c.departT - c.arriveT);
  state.sumWait += (c.serviceStartT - c.arriveT);
  state.departures++;
  if (state.lastDepartureT !== null) {
    state.interDepartures.push(state.simTime - state.lastDepartureT);
    if (state.interDepartures.length > state.interDepMax) {
      state.interDepartures.splice(0, state.interDepartures.length - state.interDepMax);
    }
  }
  state.lastDepartureT = state.simTime;
  state.N--;
  if (state.queue.length > 0) {
    const next = state.queue.shift();
    next.serviceStartT = state.simTime;
    next.serviceTime = expRand(state.mu);
    next.departT = state.simTime + next.serviceTime;
    state.inService = next;
    state.nextDepartureT = next.departT;
  } else {
    state.inService = null;
    state.nextDepartureT = Infinity;
  }
  pushHistory(state.simTime, state.N);
  logEvent('depart', `departure #${c.id} → X=${state.N}`);
}

// Advance simulation up to real-time target (advance clock, process events in window)
function advanceTo(targetT) {
  let safety = 0;
  while (true) {
    const nextT = Math.min(state.nextArrivalT, state.nextDepartureT);
    if (nextT > targetT) {
      // no event in this window → just roll clock forward for time averaging
      accumulateTime(targetT);
      state.simTime = targetT;
      return;
    }
    if (nextT === state.nextArrivalT) {
      processArrival();
    } else {
      processDeparture();
    }
    if (++safety > 10000) {
      // prevent lock-up at very high speed/rate
      accumulateTime(targetT);
      state.simTime = targetT;
      return;
    }
  }
}

// Manual single-event step (ignoring clock)
function stepOneEvent() {
  const nextT = Math.min(state.nextArrivalT, state.nextDepartureT);
  if (!isFinite(nextT)) return;
  if (nextT === state.nextArrivalT) processArrival(); else processDeparture();
  render();
}

function forceArrival() {
  state.nextArrivalT = state.simTime;
  processArrival();
  render();
}

function forceDeparture() {
  if (state.inService === null) return;
  state.nextDepartureT = state.simTime;
  processDeparture();
  render();
}

/* =========================================================================
   Rendering
   ========================================================================= */

// Crisp canvas sizing with devicePixelRatio
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

function renderQueueVisual() {
  const canvas = document.getElementById('queueCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fafbfc';
  ctx.fillRect(0, 0, w, h);

  const cx = w - 70;     // server center x
  const cy = h / 2;
  const r = 26;
  // Server box
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#94a3b8';
  ctx.fillStyle = state.inService ? '#2563eb' : '#e5e7eb';
  ctx.beginPath();
  ctx.roundRect(cx - r, cy - r, 2*r, 2*r, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = state.inService ? '#fff' : '#64748b';
  ctx.font = '600 11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.inService ? `#${state.inService.id}` : 'idle', cx, cy);
  // "Server" label
  ctx.fillStyle = '#64748b';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('Server', cx, cy + r + 14);

  // Arrow from queue to server
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(cx - r - 20, cy);
  ctx.lineTo(cx - r - 4, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r - 4, cy);
  ctx.lineTo(cx - r - 10, cy - 4);
  ctx.lineTo(cx - r - 10, cy + 4);
  ctx.closePath();
  ctx.fillStyle = '#cbd5e1';
  ctx.fill();

  // Waiting customers line
  const qSpacing = 22;
  const qStart = cx - r - 30;
  const qCount = state.queue.length;
  for (let i = 0; i < Math.min(qCount, 25); i++) {
    const x = qStart - i * qSpacing;
    if (x < 20) break;
    ctx.beginPath();
    ctx.arc(x, cy, 9, 0, 2 * Math.PI);
    ctx.fillStyle = '#93c5fd';
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }
  // "+N more" if overflow
  if (qCount > 25) {
    const x = qStart - 25 * qSpacing;
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(`+${qCount - 25} more`, Math.max(x, 8), cy);
  }
  // Queue label
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`Waiting: ${qCount}`, 12, 20);
  ctx.textAlign = 'right';
  ctx.fillText(`X(t) = ${state.N}`, w - 12, 20);
}

function renderStats() {
  const { lambda, mu, simTime, arrivals, departures, N } = state;
  const rho = lambda / mu;
  const setText = (id, v) => { document.getElementById(id).textContent = v; };
  setText('simTime', simTime.toFixed(2));
  setText('nArr', arrivals);
  setText('nDep', departures);
  setText('nowN', N);

  // Theory
  let LTh, LqTh, WTh, WqTh, p0Th;
  if (rho < 1) {
    LTh  = rho / (1 - rho);
    LqTh = rho*rho / (1 - rho);
    WTh  = 1 / (mu - lambda);
    WqTh = rho / (mu - lambda);
    p0Th = 1 - rho;
  } else {
    LTh = LqTh = WTh = WqTh = Infinity;
    p0Th = 0;
  }
  const fmt = (x) => !isFinite(x) ? '&infin;' : x.toFixed(3);
  setText('rhoTh', rho.toFixed(3));
  document.getElementById('LTh').innerHTML  = fmt(LTh);
  document.getElementById('LqTh').innerHTML = fmt(LqTh);
  document.getElementById('WTh').innerHTML  = fmt(WTh);
  document.getElementById('WqTh').innerHTML = fmt(WqTh);
  setText('p0Th', p0Th.toFixed(3));

  // Empirical (time-averaged)
  const total = state.timeInState.reduce((a, b) => a + b, 0);
  if (total > 0) {
    let Lemp = 0;
    state.timeInState.forEach((t, k) => { Lemp += k * t; });
    Lemp /= total;
    // Busy prob == 1 - π0
    const p0emp = (state.timeInState[0] || 0) / total;
    const rhoEmp = 1 - p0emp;
    // Lq = E[max(N-1, 0)]
    let Lq = 0;
    state.timeInState.forEach((t, k) => { if (k >= 1) Lq += (k - 1) * t; });
    Lq /= total;
    setText('rhoEmp', rhoEmp.toFixed(3));
    setText('LEmp',  Lemp.toFixed(3));
    setText('LqEmp', Lq.toFixed(3));
    setText('p0Emp', p0emp.toFixed(3));
  } else {
    setText('rhoEmp', '—'); setText('LEmp', '—');
    setText('LqEmp', '—');  setText('p0Emp', '—');
  }
  if (state.departures > 0) {
    setText('WEmp',  (state.sumSojourn / state.departures).toFixed(3));
    setText('WqEmp', (state.sumWait    / state.departures).toFixed(3));
  } else {
    setText('WEmp', '—'); setText('WqEmp', '—');
  }
}

function renderStability() {
  const rho = state.lambda / state.mu;
  const el = document.getElementById('stability');
  const text = document.getElementById('stabilityText');
  el.classList.remove('stable', 'warn', 'unstable');
  if (rho < 0.85) {
    el.classList.add('stable');
    text.innerHTML = `Stable: &rho; = ${rho.toFixed(3)} &lt; 1. Steady-state &pi;<sub>k</sub> = (1&minus;&rho;)&rho;<sup>k</sup> exists.`;
  } else if (rho < 1) {
    el.classList.add('warn');
    text.innerHTML = `Heavy traffic: &rho; = ${rho.toFixed(3)} approaching 1. Queue length and wait diverge sharply.`;
  } else {
    el.classList.add('unstable');
    text.innerHTML = `UNSTABLE: &rho; = ${rho.toFixed(3)} &ge; 1. No stationary distribution &mdash; X(t) &rarr; &infin;.`;
  }
}

// Time-series chart: step-plot of X(t) in a rolling window
function renderTimeSeries() {
  const canvas = document.getElementById('tsCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 38, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const tNow = state.simTime;
  const windowSec = state.tsWindowSec;
  const tMin = Math.max(0, tNow - windowSec);

  // Determine y-scale
  let maxX = 1;
  for (const p of state.tsHistory) {
    if (p.t >= tMin && p.x > maxX) maxX = p.x;
  }
  if (state.N > maxX) maxX = state.N;
  maxX = Math.max(5, Math.ceil(maxX * 1.15));

  // Grid
  ctx.strokeStyle = '#f1f3f7';
  ctx.lineWidth = 1;
  const yTicks = 5;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const y = padT + plotH - (i / yTicks) * plotH;
    const v = (i / yTicks) * maxX;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(0), padL - 4, y);
  }
  // Time ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const frac = i / xTicks;
    const t = tMin + frac * (tNow - tMin);
    const x = padL + frac * plotW;
    ctx.beginPath();
    ctx.moveTo(x, padT + plotH);
    ctx.lineTo(x, padT + plotH + 3);
    ctx.strokeStyle = '#cbd5e1';
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(t.toFixed(1), x, padT + plotH + 5);
  }

  // Theoretical L
  const rho = state.lambda / state.mu;
  if (rho < 1) {
    const L = rho / (1 - rho);
    if (L <= maxX) {
      const y = padT + plotH - (L / maxX) * plotH;
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ef4444';
      ctx.textAlign = 'right';
      ctx.fillText(`L=${L.toFixed(2)}`, padL + plotW - 2, y - 5);
    }
  }

  // Step plot (horizontal-then-vertical segments)
  const tToX = (t) => padL + ((t - tMin) / ((tNow - tMin) || 1)) * plotW;
  const vToY = (v) => padT + plotH - (v / maxX) * plotH;
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let prev = null;
  let pts = state.tsHistory.filter(p => p.t >= tMin);
  const prior = state.tsHistory.filter(p => p.t < tMin).pop();
  if (prior) pts = [{ t: tMin, x: prior.x }, ...pts];
  else if (pts.length === 0) pts = [{ t: tMin, x: state.N }];
  for (const p of pts) {
    const x = tToX(p.t);
    const y = vToY(p.x);
    if (prev === null) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, prev.y);
      ctx.lineTo(x, y);
    }
    prev = { x, y };
  }
  if (prev) {
    ctx.lineTo(tToX(tNow), prev.y);
    ctx.lineTo(tToX(tNow), vToY(state.N));
  }
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('X(t)', 4, padT);
  ctx.textAlign = 'right';
  ctx.fillText('t (sim-s)', w - 4, h - 12);
}

// State distribution histogram
function renderDistribution() {
  const canvas = document.getElementById('distCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const total = state.timeInState.reduce((a, b) => a + b, 0);
  const rho = state.lambda / state.mu;
  const stable = rho < 1;

  // how many bins
  let maxK = Math.max(10, state.timeInState.length);
  if (stable) {
    // show up to k such that theory ≤ 1% + a margin
    const kMax = Math.min(40, Math.max(10, Math.ceil(Math.log(0.005) / Math.log(rho || 0.01))));
    maxK = Math.max(maxK, kMax);
  }
  maxK = Math.min(maxK, 40);

  // Empirical frequencies
  const emp = new Array(maxK + 1).fill(0);
  for (let k = 0; k <= maxK; k++) {
    emp[k] = total > 0 ? (state.timeInState[k] || 0) / total : 0;
  }
  const theory = new Array(maxK + 1).fill(0);
  if (stable) {
    for (let k = 0; k <= maxK; k++) theory[k] = (1 - rho) * Math.pow(rho, k);
  }
  const maxVal = Math.max(0.05, ...emp, ...theory);

  // y-axis grid
  ctx.strokeStyle = '#f1f3f7';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const y = padT + plotH - (i / 5) * plotH;
    const v = (i / 5) * maxVal;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(2), padL - 4, y);
  }
  // bars
  const binW = plotW / (maxK + 1);
  for (let k = 0; k <= maxK; k++) {
    const barX = padL + k * binW + 2;
    const barW = Math.max(2, binW - 4);
    const barY = padT + plotH - (emp[k] / maxVal) * plotH;
    const barH = padT + plotH - barY;
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(barX, barY, barW, barH);
    // theoretical marker
    if (stable) {
      const ty = padT + plotH - (theory[k] / maxVal) * plotH;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX, ty);
      ctx.lineTo(barX + barW, ty);
      ctx.stroke();
    }
  }
  // x-axis labels
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(maxK / 10));
  for (let k = 0; k <= maxK; k += step) {
    const x = padL + k * binW + binW / 2;
    ctx.fillText(k, x, padT + plotH + 4);
  }
  ctx.textAlign = 'left';
  ctx.fillText('k', padL, h - 12);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.fillText('π_k', 4, padT);
}

// Burke's theorem: departure-interarrival histogram vs Exp(λ)
function renderBurke() {
  const canvas = document.getElementById('burkeCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const data = state.interDepartures;
  const lambda = state.lambda;
  // Choose range: up to 5/λ
  const xMax = Math.max(0.5, 5 / lambda);
  const bins = 30;
  const binW = xMax / bins;
  const counts = new Array(bins).fill(0);
  for (const v of data) {
    if (v < xMax) {
      const idx = Math.min(bins - 1, Math.floor(v / binW));
      counts[idx]++;
    }
  }
  const total = data.length;
  // empirical density: counts / (total * binW)
  const empDen = counts.map(c => total > 0 ? c / (total * binW) : 0);
  const theoryAt = (x) => lambda * Math.exp(-lambda * x);
  let maxVal = Math.max(lambda, ...empDen); // λ is pdf value at 0
  maxVal = maxVal * 1.05 || 1;

  // grid
  ctx.strokeStyle = '#f1f3f7';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (i / 4) * plotH;
    const v = (i / 4) * maxVal;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(2), padL - 4, y);
  }
  // bars
  const pxPerBin = plotW / bins;
  for (let i = 0; i < bins; i++) {
    const barX = padL + i * pxPerBin + 1;
    const bw = Math.max(2, pxPerBin - 2);
    const y = padT + plotH - (empDen[i] / maxVal) * plotH;
    ctx.fillStyle = 'rgba(16,185,129,0.75)';
    ctx.fillRect(barX, y, bw, padT + plotH - y);
  }
  // exponential pdf
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const steps = 100;
  for (let s = 0; s <= steps; s++) {
    const x = (s / steps) * xMax;
    const v = theoryAt(x);
    const px = padL + (x / xMax) * plotW;
    const py = padT + plotH - (v / maxVal) * plotH;
    if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // x-axis labels
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    const v = (i / 5) * xMax;
    ctx.fillText(v.toFixed(2), x, padT + plotH + 4);
  }
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.fillText('Δ_dep (sim-s)', w - 4, h - 12);
  ctx.textAlign = 'left';
  ctx.fillText('density', 4, padT);
  // sample size
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`n=${total}`, w - 6, padT + 4);
}

function render() {
  renderQueueVisual();
  renderStats();
  renderStability();
  renderTimeSeries();
  renderDistribution();
  renderBurke();
}

/* =========================================================================
   Main loop
   ========================================================================= */
let lastFrame = null;
function frame(now) {
  if (lastFrame === null) lastFrame = now;
  const realDt = (now - lastFrame) / 1000; // s
  lastFrame = now;
  if (state.running) {
    const simDt = realDt * state.speed;
    // Cap per-frame to avoid catastrophic catch-up after tab inactivity
    const cappedDt = Math.min(simDt, Math.max(1, state.speed * 0.1));
    advanceTo(state.simTime + cappedDt);
    render();
  }
  requestAnimationFrame(frame);
}

/* =========================================================================
   UI wiring
   ========================================================================= */
function updateLambda(v) {
  state.lambda = v;
  document.getElementById('lambdaVal').textContent = v.toFixed(2);
  // Re-schedule next arrival with new rate from NOW (memoryless: equivalent)
  scheduleNextArrival();
  render();
}
function updateMu(v) {
  state.mu = v;
  document.getElementById('muVal').textContent = v.toFixed(2);
  // Re-sample remaining service time for in-service customer (memoryless)
  if (state.inService) {
    state.nextDepartureT = state.simTime + expRand(state.mu);
    state.inService.departT = state.nextDepartureT;
  }
  render();
}
function updateSpeed(logVal) {
  const v = Math.pow(10, logVal);
  state.speed = v;
  document.getElementById('speedVal').textContent = v < 1 ? `${v.toFixed(2)}×` : `${v.toFixed(1)}×`;
}

document.getElementById('lambda').addEventListener('input', e => updateLambda(parseFloat(e.target.value)));
document.getElementById('mu').addEventListener('input',     e => updateMu(parseFloat(e.target.value)));
document.getElementById('speed').addEventListener('input',  e => updateSpeed(parseFloat(e.target.value)));

document.getElementById('playBtn').addEventListener('click', () => {
  state.running = !state.running;
  document.getElementById('playBtn').innerHTML = state.running ? '&#10074;&#10074; Pause' : '&#9654; Play';
  if (state.running) lastFrame = null;
});
document.getElementById('stepBtn').addEventListener('click', stepOneEvent);
document.getElementById('arriveBtn').addEventListener('click', forceArrival);
document.getElementById('departBtn').addEventListener('click', forceDeparture);
document.getElementById('resetBtn').addEventListener('click', () => {
  state.running = false;
  document.getElementById('playBtn').innerHTML = '&#9654; Play';
  reset();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); document.getElementById('playBtn').click(); }
  if (e.key === 's') stepOneEvent();
  if (e.key === 'a') forceArrival();
  if (e.key === 'd') forceDeparture();
  if (e.key === 'r') document.getElementById('resetBtn').click();
});

// Init
updateLambda(parseFloat(document.getElementById('lambda').value));
updateMu(parseFloat(document.getElementById('mu').value));
updateSpeed(parseFloat(document.getElementById('speed').value));
reset();
requestAnimationFrame(frame);

// Re-render on resize
window.addEventListener('resize', render);
