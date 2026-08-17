/* =========================================================================
   M/M/1 discrete-event simulator
   ========================================================================= */

// ---- Parameters ----
const state = {
  lambda: 1.0,
  mu:     1.5,
  releaseRate: 0.9,
  protectedMode: false,
  speed:  1.0,        // sim-seconds per real-second
  running: false,
  simTime: 0.0,
  N: 0,               // current system size X(t)
  nextArrivalT: 0.0,  // absolute sim time of next arrival
  nextAdmissionT: Infinity,
  nextDepartureT: Infinity, // Infinity if server idle
  waitingRoom: [],    // users waiting outside the protected application
  queue: [],          // array of customer objects in the waiting line (excludes the one in service)
  inService: null,    // customer currently being served (or null)
  nextId: 1,
  // Counters
  rawArrivals: 0,
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

const transientCache = {
  key: null,
  computedAt: 0,
  result: null,
};

const THEME_STORAGE_KEY = 'mm1-theme';

function getThemeValue(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function getThemePalette() {
  return {
    canvasBg: getThemeValue('--canvas-bg'),
    grid: getThemeValue('--canvas-grid'),
    axis: getThemeValue('--canvas-axis'),
    text: getThemeValue('--canvas-text'),
    muted: getThemeValue('--canvas-muted'),
    line: getThemeValue('--canvas-line'),
    accent: getThemeValue('--accent'),
    err: getThemeValue('--err'),
    ok: getThemeValue('--ok'),
    okFill: getThemeValue('--ok-fill'),
    server: getThemeValue('--server'),
    customer: getThemeValue('--customer'),
    customerWait: getThemeValue('--customer-wait'),
    serverIdle: getThemeValue('--server-idle'),
    onAccent: getThemeValue('--canvas-on-accent'),
    arrow: getThemeValue('--arrow'),
  };
}

function syncThemeToggle() {
  const button = document.getElementById('themeToggle');
  if (!button) return;
  const isDark = document.body.dataset.theme !== 'light';
  button.textContent = isDark ? 'Light mode' : 'Dark mode';
  button.setAttribute('aria-pressed', String(isDark));
  button.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
}

function applyTheme(mode, persist = true) {
  const nextTheme = mode === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = nextTheme;
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  syncThemeToggle();
  render();
}

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(stored === 'light' ? 'light' : 'dark', false);
}

// ---- Random helpers ----
function expRand(rate) {
  // inverse-CDF sampler for Exp(rate)
  return -Math.log(1 - Math.random()) / rate;
}

function getEffectiveLambda() {
  return state.protectedMode ? Math.min(state.lambda, state.releaseRate) : state.lambda;
}

// ---- Initialization / reset ----
function reset() {
  state.simTime = 0;
  state.N = 0;
  state.waitingRoom = [];
  state.queue = [];
  state.inService = null;
  state.nextId = 1;
  state.rawArrivals = 0;
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
  transientCache.key = null;
  transientCache.result = null;
  document.getElementById('logList').innerHTML = '';
  scheduleNextArrival();
  state.nextAdmissionT = Infinity;
  state.nextDepartureT = Infinity;
  render();
}

function scheduleNextArrival() {
  state.nextArrivalT = state.simTime + expRand(state.lambda);
}

function scheduleNextAdmission() {
  if (!state.protectedMode || state.waitingRoom.length === 0) {
    state.nextAdmissionT = Infinity;
    return;
  }
  state.nextAdmissionT = state.simTime + expRand(state.releaseRate);
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

function createDemandAt(time) {
  const demand = { id: state.nextId++, demandArriveT: time };
  state.rawArrivals++;
  state.waitingRoom.push(demand);
  if (state.nextAdmissionT === Infinity) scheduleNextAdmission();
  return demand;
}

function createArrivalAt(time, seed = null) {
  const c = seed ? { ...seed, arriveT: time } : { id: state.nextId++, demandArriveT: time, arriveT: time };
  state.arrivals++;
  if (state.inService === null) {
    c.serviceStartT = time;
    c.serviceTime = expRand(state.mu);
    c.departT = time + c.serviceTime;
    state.inService = c;
    state.nextDepartureT = c.departT;
  } else {
    state.queue.push(c);
  }
  state.N++;
  pushHistory(time, state.N);
  return c;
}

// ---- Event processing ----
function processArrival() {
  accumulateTime(state.nextArrivalT);
  state.simTime = state.nextArrivalT;
  let c;
  if (state.protectedMode) {
    c = createDemandAt(state.simTime);
    logEvent('arrive', `demand #${c.id} → waiting room=${state.waitingRoom.length}`);
  } else {
    state.rawArrivals++;
    c = createArrivalAt(state.simTime);
    logEvent('arrive', `arrival #${c.id} → X=${state.N}`);
  }
  scheduleNextArrival();
}

function processAdmission() {
  if (state.waitingRoom.length === 0) {
    state.nextAdmissionT = Infinity;
    return;
  }
  accumulateTime(state.nextAdmissionT);
  state.simTime = state.nextAdmissionT;
  const demand = state.waitingRoom.shift();
  const c = createArrivalAt(state.simTime, demand);
  if (state.waitingRoom.length > 0) scheduleNextAdmission(); else state.nextAdmissionT = Infinity;
  logEvent('arrive', `admit #${c.id} → app X=${state.N}, room=${state.waitingRoom.length}`);
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
    const nextT = Math.min(state.nextArrivalT, state.nextAdmissionT, state.nextDepartureT);
    if (nextT > targetT) {
      // no event in this window → just roll clock forward for time averaging
      accumulateTime(targetT);
      state.simTime = targetT;
      return;
    }
    if (nextT === state.nextArrivalT) {
      processArrival();
    } else if (nextT === state.nextAdmissionT) {
      processAdmission();
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
  const nextT = Math.min(state.nextArrivalT, state.nextAdmissionT, state.nextDepartureT);
  if (!isFinite(nextT)) return;
  if (nextT === state.nextArrivalT) processArrival();
  else if (nextT === state.nextAdmissionT) processAdmission();
  else processDeparture();
  render();
}

function sanitizeForcedArrivalCount(rawValue) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getForcedArrivalCount() {
  const input = document.getElementById('arrivalsPerForce');
  const count = sanitizeForcedArrivalCount(input.value);
  input.value = String(count);
  return count;
}

function forceArrival(count = getForcedArrivalCount()) {
  const batchSize = sanitizeForcedArrivalCount(count);
  const startId = state.nextId;
  if (!state.protectedMode) state.rawArrivals += batchSize;
  for (let i = 0; i < batchSize; i++) {
    if (state.protectedMode) createDemandAt(state.simTime);
    else createArrivalAt(state.simTime);
  }
  const endId = state.nextId - 1;
  const label = state.protectedMode
    ? (batchSize === 1
      ? `forced demand #${startId} → waiting room=${state.waitingRoom.length}`
      : `forced demand #${startId}–#${endId} (${batchSize}) → waiting room=${state.waitingRoom.length}`)
    : (batchSize === 1
      ? `forced arrival #${startId} → X=${state.N}`
      : `forced arrivals #${startId}–#${endId} (${batchSize}) → X=${state.N}`);
  logEvent('arrive', label);
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
  const colors = getThemePalette();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = colors.canvasBg;
  ctx.fillRect(0, 0, w, h);

  const cy = h / 2;
  const r = 26;

  const drawArrow = (fromX, toX) => {
    ctx.strokeStyle = colors.arrow;
    ctx.beginPath();
    ctx.moveTo(fromX, cy);
    ctx.lineTo(toX, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX, cy);
    ctx.lineTo(toX - 6, cy - 4);
    ctx.lineTo(toX - 6, cy + 4);
    ctx.closePath();
    ctx.fillStyle = colors.arrow;
    ctx.fill();
  };

  const drawServer = (cx) => {
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.line;
    ctx.fillStyle = state.inService ? colors.server : colors.serverIdle;
    ctx.beginPath();
    ctx.roundRect(cx - r, cy - r, 2 * r, 2 * r, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = state.inService ? colors.onAccent : colors.muted;
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.inService ? `#${state.inService.id}` : 'idle', cx, cy);
    ctx.fillStyle = colors.muted;
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('Server', cx, cy + r + 14);
  };

  if (!state.protectedMode) {
    const cx = w - 70;
    drawServer(cx);
    drawArrow(cx - r - 20, cx - r - 4);

    const qSpacing = 22;
    const qStart = cx - r - 30;
    const qCount = state.queue.length;
    for (let i = 0; i < Math.min(qCount, 25); i++) {
      const x = qStart - i * qSpacing;
      if (x < 20) break;
      ctx.beginPath();
      ctx.arc(x, cy, 9, 0, 2 * Math.PI);
      ctx.fillStyle = colors.customerWait;
      ctx.strokeStyle = colors.customer;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
    if (qCount > 25) {
      const x = qStart - 25 * qSpacing;
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'left';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText(`+${qCount - 25} more`, Math.max(x, 8), cy);
    }
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(`Waiting: ${qCount}`, 12, 20);
    ctx.textAlign = 'right';
    ctx.fillText(`X(t) = ${state.N}`, w - 12, 20);
    return;
  }

  const roomCount = state.waitingRoom.length;
  const appQueueCount = state.queue.length;
  const serverX = w - 70;
  const gateX = Math.floor(w * 0.5);
  const roomStart = 34;
  const roomEnd = gateX - 60;
  const roomSpacing = 18;
  const roomVisible = Math.max(1, Math.floor((roomEnd - roomStart) / roomSpacing));
  const appQueueStart = serverX - r - 36;
  const appSpacing = 22;
  const topLabelY = 20;
  const stageLabelY = cy - 46;

  // Waiting room band
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(roomStart - 12, cy - 34, roomEnd - roomStart + 24, 68, 14);
  ctx.stroke();
  for (let i = 0; i < Math.min(roomCount, roomVisible); i++) {
    const x = roomEnd - i * roomSpacing;
    if (x < roomStart) break;
    ctx.beginPath();
    ctx.arc(x, cy, 8, 0, 2 * Math.PI);
    ctx.fillStyle = colors.customer;
    ctx.fill();
  }
  if (roomCount > roomVisible) {
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(`+${roomCount - roomVisible} more`, roomStart - 2, cy + 24);
  }
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'left';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`Waiting room: ${roomCount}`, 12, topLabelY);
  ctx.fillText('External waiting room', roomStart, stageLabelY);

  // Gate
  ctx.beginPath();
  ctx.roundRect(gateX - 12, cy - 42, 24, 84, 8);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = colors.onAccent;
  ctx.textAlign = 'center';
  ctx.font = '600 10px -apple-system, sans-serif';
  ctx.fillText('Gate', gateX, cy);

  drawArrow(roomEnd + 18, gateX - 16);
  drawArrow(gateX + 16, serverX - r - 12);

  // App queue
  for (let i = 0; i < Math.min(appQueueCount, 16); i++) {
    const x = appQueueStart - i * appSpacing;
    if (x < gateX + 26) break;
    ctx.beginPath();
    ctx.arc(x, cy, 9, 0, 2 * Math.PI);
    ctx.fillStyle = colors.customerWait;
    ctx.strokeStyle = colors.customer;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }
  if (appQueueCount > 16) {
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(`+${appQueueCount - 16} more`, gateX + 28, cy - 16);
  }

  drawServer(serverX);
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'right';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`App queue: ${appQueueCount} • X(t) = ${state.N}`, w - 12, topLabelY);
  ctx.textAlign = 'left';
  ctx.fillText('Protected application', gateX + 42, stageLabelY);
}

function renderStats() {
  const { lambda, mu, releaseRate, simTime, rawArrivals, arrivals, departures, N } = state;
  const effectiveLambda = getEffectiveLambda();
  const rho = effectiveLambda / mu;
  const setText = (id, v) => { document.getElementById(id).textContent = v; };
  setText('modeVal', state.protectedMode ? 'Protected waiting room' : 'Plain M/M/1');
  setText('simTime', simTime.toFixed(2));
  setText('nRawArr', rawArrivals);
  setText('nArr', arrivals);
  setText('nDep', departures);
  setText('waitingRoomVal', state.waitingRoom.length);
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
  setText('rawLambdaTh', lambda.toFixed(3));
  setText('lambdaRealTh', (state.protectedMode ? Math.min(lambda, releaseRate) : lambda).toFixed(3));
  document.getElementById('LTh').innerHTML  = fmt(LTh);
  document.getElementById('LqTh').innerHTML = fmt(LqTh);
  document.getElementById('WTh').innerHTML  = fmt(WTh);
  document.getElementById('WqTh').innerHTML = fmt(WqTh);
  setText('p0Th', p0Th.toFixed(3));

  // Empirical (time-averaged)
  const total = state.timeInState.reduce((a, b) => a + b, 0);
  if (total > 0) {
    const rawLambdaEmp = rawArrivals / total;
    const lambdaRealEmp = arrivals / total;
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
    setText('rawLambdaEmp', rawLambdaEmp.toFixed(3));
    setText('lambdaRealEmp', lambdaRealEmp.toFixed(3));
    setText('LEmp',  Lemp.toFixed(3));
    setText('LqEmp', Lq.toFixed(3));
    setText('p0Emp', p0emp.toFixed(3));
  } else {
    setText('rhoEmp', '—'); setText('rawLambdaEmp', '—');
    setText('lambdaRealEmp', '—'); setText('LEmp', '—');
    setText('LqEmp', '—');
    setText('p0Emp', '—');
  }
  if (state.departures > 0) {
    setText('WEmp',  (state.sumSojourn / state.departures).toFixed(3));
    setText('WqEmp', (state.sumWait    / state.departures).toFixed(3));
  } else {
    setText('WEmp', '—'); setText('WqEmp', '—');
  }
}

function renderStability() {
  const rawRho = state.lambda / state.mu;
  const backendRho = getEffectiveLambda() / state.mu;
  const el = document.getElementById('stability');
  const text = document.getElementById('stabilityText');
  el.classList.remove('stable', 'warn', 'unstable');
  if (!state.protectedMode) {
    if (rawRho < 0.85) {
      el.classList.add('stable');
      text.innerHTML = `Stable: &rho; = ${rawRho.toFixed(3)} &lt; 1. Steady-state &pi;<sub>k</sub> = (1&minus;&rho;)&rho;<sup>k</sup> exists.`;
    } else if (rawRho < 1) {
      el.classList.add('warn');
      text.innerHTML = `Heavy traffic: &rho; = ${rawRho.toFixed(3)} approaching 1. Queue length and wait diverge sharply.`;
    } else {
      el.classList.add('unstable');
      text.innerHTML = `UNSTABLE: &rho; = ${rawRho.toFixed(3)} &ge; 1. No stationary distribution &mdash; X(t) &rarr; &infin;.`;
    }
    return;
  }
  if (backendRho >= 1) {
    el.classList.add('unstable');
    text.innerHTML = `UNSTABLE backend: &rho;<sub>app</sub> = ${backendRho.toFixed(3)} &ge; 1. Even with a waiting-room gate, the protected application queue has no stationary distribution.`;
  } else if (state.lambda > state.releaseRate) {
    el.classList.add('warn');
    text.innerHTML = `Protected backend stable at &rho;<sub>app</sub> = ${backendRho.toFixed(3)}, but the waiting room grows because &lambda;<sub>raw</sub> = ${state.lambda.toFixed(3)} exceeds gate rate g = ${state.releaseRate.toFixed(3)}.`;
  } else if (backendRho < 0.85) {
    el.classList.add('stable');
    text.innerHTML = `Protected backend stable: &rho;<sub>app</sub> = ${backendRho.toFixed(3)} with demand admitted fast enough that the waiting room does not build.`;
  } else if (backendRho < 1) {
    el.classList.add('warn');
    text.innerHTML = `Protected backend in heavy traffic: &rho;<sub>app</sub> = ${backendRho.toFixed(3)} approaching 1. The gate prevents overload, but admitted users still experience sharp queueing effects.`;
  }
}

// Time-series chart: step-plot of X(t) in a rolling window
function renderTimeSeries() {
  const canvas = document.getElementById('tsCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const colors = getThemePalette();
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
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  const yTicks = 5;
  ctx.fillStyle = colors.axis;
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
    ctx.strokeStyle = colors.line;
    ctx.stroke();
    ctx.fillStyle = colors.axis;
    ctx.fillText(t.toFixed(1), x, padT + plotH + 5);
  }

  // Theoretical L
  const rho = getEffectiveLambda() / state.mu;
  if (rho < 1) {
    const L = rho / (1 - rho);
    if (L <= maxX) {
      const y = padT + plotH - (L / maxX) * plotH;
      ctx.strokeStyle = colors.err;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.err;
      ctx.textAlign = 'right';
      ctx.fillText(`L=${L.toFixed(2)}`, padL + plotW - 2, y - 5);
    }
  }

  // Step plot (horizontal-then-vertical segments)
  const tToX = (t) => padL + ((t - tMin) / ((tNow - tMin) || 1)) * plotW;
  const vToY = (v) => padT + plotH - (v / maxX) * plotH;
  ctx.strokeStyle = colors.accent;
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
  ctx.fillStyle = colors.text;
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
  const colors = getThemePalette();
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const total = state.timeInState.reduce((a, b) => a + b, 0);
  const rho = getEffectiveLambda() / state.mu;
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
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.axis;
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
    ctx.fillStyle = colors.customer;
    ctx.fillRect(barX, barY, barW, barH);
    // theoretical marker
    if (stable) {
      const ty = padT + plotH - (theory[k] / maxVal) * plotH;
      ctx.strokeStyle = colors.err;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX, ty);
      ctx.lineTo(barX + barW, ty);
      ctx.stroke();
    }
  }
  // x-axis labels
  ctx.fillStyle = colors.axis;
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
  ctx.fillStyle = colors.text;
  ctx.fillText('π_k', 4, padT);
}

function applyEmbeddedBirthDeathStep(dist, upP, downP) {
  const K = dist.length - 1;
  const next = new Array(dist.length).fill(0);
  next[0] = dist[0] * (1 - upP) + (dist[1] || 0) * downP;
  for (let k = 1; k < K; k++) {
    next[k] = dist[k - 1] * upP + dist[k + 1] * downP;
  }
  next[K] = dist[K - 1] * upP + dist[K] * upP;
  return next;
}

function propagateUniformizedChunk(dist, lambda, mu, dt) {
  const nu = lambda + mu;
  if (dt <= 0 || nu <= 0) return dist.slice();
  const upP = lambda / nu;
  const downP = mu / nu;
  const mean = nu * dt;
  const maxTerms = Math.max(18, Math.ceil(mean + 10 * Math.sqrt(mean + 1) + 10));
  let weight = Math.exp(-mean);
  let usedWeight = weight;
  let chain = dist.slice();
  const accum = chain.map((v) => v * weight);
  for (let n = 1; n <= maxTerms; n++) {
    weight *= mean / n;
    chain = applyEmbeddedBirthDeathStep(chain, upP, downP);
    usedWeight += weight;
    for (let i = 0; i < accum.length; i++) {
      accum[i] += weight * chain[i];
    }
    if (n > mean + 6 * Math.sqrt(mean + 1) && weight < 1e-12) break;
  }
  if (usedWeight > 0 && Math.abs(usedWeight - 1) > 1e-9) {
    const scale = 1 / usedWeight;
    for (let i = 0; i < accum.length; i++) accum[i] *= scale;
  }
  return accum;
}

function computeTransientDistribution(lambda, mu, t) {
  const rho = lambda / mu;
  const stable = rho < 1;
  const safeT = Math.max(0, t);
  const steadyMean = stable ? rho / Math.max(1e-9, 1 - rho) : 0;
  const steadyVar = stable ? rho / Math.max(1e-9, (1 - rho) * (1 - rho)) : 0;
  const supportGuess = stable
    ? steadyMean + 8 * Math.sqrt(steadyVar + 1) + 18
    : Math.max(40, lambda * safeT + 8 * Math.sqrt(lambda * safeT + 1) + 18);
  const internalK = Math.max(40, Math.min(320, Math.ceil(supportGuess)));
  let dist = new Array(internalK + 1).fill(0);
  dist[0] = 1;

  const nu = lambda + mu;
  const meanPerChunk = 28;
  let remaining = safeT;
  while (remaining > 1e-9) {
    const dt = nu > 0 ? Math.min(remaining, meanPerChunk / nu) : remaining;
    dist = propagateUniformizedChunk(dist, lambda, mu, dt);
    const total = dist.reduce((sum, value) => sum + value, 0);
    if (total > 0) dist = dist.map((value) => value / total);
    remaining -= dt;
  }

  const minDisplayK = 10;
  const maxDisplayK = stable ? 18 : 32;
  let idealK = minDisplayK;
  let cumulative = 0;
  for (let k = 0; k < dist.length; k++) {
    cumulative += dist[k];
    if (k >= minDisplayK && cumulative >= 0.995) {
      idealK = k;
      break;
    }
    idealK = k;
  }
  if (stable) {
    let steadyK = minDisplayK;
    while (steadyK < dist.length - 1 && (1 - rho) * Math.pow(rho, steadyK) > 0.002) steadyK++;
    idealK = Math.max(idealK, steadyK);
  }
  const displayK = Math.min(maxDisplayK, Math.max(minDisplayK, idealK));
  const transient = dist.slice(0, displayK + 1);
  const steady = stable
    ? Array.from({ length: displayK + 1 }, (_, k) => (1 - rho) * Math.pow(rho, k))
    : [];
  const shownMass = transient.reduce((sum, value) => sum + value, 0);
  const hiddenMass = Math.max(0, 1 - shownMass);
  let maxDiff = 0;
  if (stable) {
    for (let k = 0; k < transient.length; k++) {
      maxDiff = Math.max(maxDiff, Math.abs(transient[k] - steady[k]));
    }
  }
  return {
    transient,
    steady,
    displayK,
    hiddenMass,
    stable,
    rho,
    sampleTime: safeT,
    closeToSteady: stable && maxDiff < 0.015,
  };
}

function drawTransientOverflowNotice(ctx, colors, x, y, width, hiddenMass, displayK) {
  const pct = hiddenMass * 100;
  const message = `Most transient mass lies above k=${displayK} (${pct.toFixed(0)}% hidden)`;
  const boxHeight = 24;
  ctx.fillStyle = colors.canvasBg;
  ctx.globalAlpha = 0.88;
  ctx.fillRect(x, y, width, boxHeight);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.warn || colors.err;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, boxHeight);
  ctx.fillStyle = colors.warn || colors.err;
  ctx.font = '600 11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, x + 8, y + boxHeight / 2);
}

function getTransientSnapshot() {
  const tQuantum = state.running ? 0.25 : 0.05;
  const sampledT = Math.max(0, Math.round(state.simTime / tQuantum) * tQuantum);
  const lambda = getEffectiveLambda();
  const key = `${lambda.toFixed(3)}|${state.mu.toFixed(3)}|${sampledT.toFixed(2)}|${state.protectedMode ? 'protected' : 'plain'}`;
  const now = performance.now();
  if (transientCache.key === key && transientCache.result) return transientCache.result;
  if (state.running && transientCache.result && now - transientCache.computedAt < 120) {
    return transientCache.result;
  }
  const result = computeTransientDistribution(lambda, state.mu, sampledT);
  transientCache.key = key;
  transientCache.computedAt = now;
  transientCache.result = result;
  return result;
}

function renderTransientDistribution() {
  const canvas = document.getElementById('transientCanvas');
  if (!canvas) return;
  const hint = document.getElementById('transientHint');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const colors = getThemePalette();
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padR = 10, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const snapshot = getTransientSnapshot();
  const { transient, steady, displayK, hiddenMass, stable, rho, sampleTime, closeToSteady } = snapshot;
  const maxVal = Math.max(0.05, ...transient, ...steady);

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.axis;
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

  const binW = plotW / (displayK + 1);
  for (let k = 0; k <= displayK; k++) {
    const barX = padL + k * binW + 2;
    const barW = Math.max(2, binW - 4);
    const barY = padT + plotH - (transient[k] / maxVal) * plotH;
    const barH = padT + plotH - barY;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(barX, barY, barW, barH);
    if (stable) {
      const ty = padT + plotH - (steady[k] / maxVal) * plotH;
      ctx.strokeStyle = colors.err;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX, ty);
      ctx.lineTo(barX + barW, ty);
      ctx.stroke();
    }
  }

  ctx.fillStyle = colors.axis;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(displayK / 10));
  for (let k = 0; k <= displayK; k += step) {
    const x = padL + k * binW + binW / 2;
    ctx.fillText(k, x, padT + plotH + 4);
  }
  ctx.textAlign = 'left';
  ctx.fillText('k', padL, h - 12);
  ctx.fillStyle = colors.text;
  ctx.fillText('P_k(t)', 4, padT);
  ctx.textAlign = 'right';
  ctx.fillStyle = colors.axis;
  ctx.fillText(`t=${sampleTime.toFixed(2)}`, w - 6, padT + 4);

  if (!stable && hiddenMass > 0.25) {
    drawTransientOverflowNotice(ctx, colors, padL + 8, padT + 8, Math.min(plotW - 16, 280), hiddenMass, displayK);
  }

  if (hint) {
    let message;
    if (sampleTime === 0) {
      message = 'At t=0 the queue starts empty, so all of the probability mass sits at k=0: P0(0)=1.';
    } else if (!stable) {
      message = `This is the transient law P(X(t)=k) from X(0)=0 under the current λ and μ. Because ρ=${rho.toFixed(3)} ≥ 1, there is no steady-state πk to converge to.`;
    } else if (closeToSteady) {
      message = 'At this t, the transient bars are already close to the steady-state reference πk = (1−ρ)ρ^k.';
    } else {
      message = 'These bars show the exact time-t distribution P(X(t)=k) from an empty start. Unlike the πk panel, this is about one chosen time, not long-run occupancy.';
    }
    if (hiddenMass > 0.01) {
      const pct = hiddenMass * 100;
      message += ` About ${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% of the mass lies above the largest state shown.`;
    }
    message += ' Reset after changing λ or μ if you want this panel to match the live run exactly.';
    hint.textContent = message;
  }
}

// Burke's theorem: departure-interarrival histogram vs Exp(λ)
function renderBurke() {
  const canvas = document.getElementById('burkeCanvas');
  const { w, h } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const colors = getThemePalette();
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const data = state.interDepartures;
  const lambda = getEffectiveLambda();
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
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.axis;
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
    ctx.fillStyle = colors.okFill;
    ctx.fillRect(barX, y, bw, padT + plotH - y);
  }
  // exponential pdf
  ctx.strokeStyle = colors.err;
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
  ctx.fillStyle = colors.axis;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) {
    const x = padL + (i / 5) * plotW;
    const v = (i / 5) * xMax;
    ctx.fillText(v.toFixed(2), x, padT + plotH + 4);
  }
  ctx.fillStyle = colors.text;
  ctx.textAlign = 'right';
  ctx.fillText('Δ_dep (sim-s)', w - 4, h - 12);
  ctx.textAlign = 'left';
  ctx.fillText('density', 4, padT);
  // sample size
  ctx.fillStyle = colors.axis;
  ctx.textAlign = 'right';
  ctx.fillText(`n=${total}`, w - 6, padT + 4);
}

function render() {
  renderQueueVisual();
  renderStats();
  renderStability();
  renderTimeSeries();
  renderDistribution();
  renderTransientDistribution();
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
function updateReleaseRate(v) {
  state.releaseRate = v;
  document.getElementById('releaseRateVal').textContent = v.toFixed(2);
  if (state.protectedMode) {
    scheduleNextAdmission();
    render();
  }
}
function updateSpeed(logVal) {
  const v = Math.pow(10, logVal);
  state.speed = v;
  document.getElementById('speedVal').textContent = v < 1 ? `${v.toFixed(2)}×` : `${v.toFixed(1)}×`;
}

function syncModeControls() {
  const modeButton = document.getElementById('modeToggle');
  const modeHint = document.getElementById('modeHint');
  const releaseInput = document.getElementById('releaseRate');
  const releaseHint = document.getElementById('releaseHint');
  const headerSubtitle = document.getElementById('headerSubtitle');
  const lambdaLabel = document.getElementById('lambdaLabel');
  const forceLabel = document.getElementById('forceArrivalsLabel');
  const arriveButton = document.getElementById('arriveBtn');
  const queueTitle = document.getElementById('queueTitle');
  const legendBusyText = document.getElementById('legendBusyText');
  const legendQueueText = document.getElementById('legendQueueText');
  const legendIdleText = document.getElementById('legendIdleText');
  const legendQueueSw = document.getElementById('legendQueueSw');
  const legendIdleSw = document.getElementById('legendIdleSw');

  modeButton.textContent = state.protectedMode ? 'Protected waiting room' : 'Plain M/M/1';
  modeButton.setAttribute('aria-pressed', String(state.protectedMode));
  modeButton.classList.toggle('active', state.protectedMode);
  releaseInput.disabled = !state.protectedMode;

  if (state.protectedMode) {
    modeHint.textContent = 'Raw demand enters an external waiting room, then a gate admits users into the protected app.';
    releaseHint.textContent = 'The gate releases users from the waiting room into the app at rate g.';
    headerSubtitle.innerHTML = 'Raw demand &lambda; &middot; admission gate g &middot; protected app service &mu;';
    lambdaLabel.innerHTML = 'Raw demand rate &lambda; (per sim-second)';
    forceLabel.textContent = 'Forced demand at once';
    arriveButton.textContent = 'Force demand';
    queueTitle.innerHTML = 'Protected app &mdash; live state';
    legendBusyText.textContent = 'Server (busy)';
    legendQueueText.textContent = 'App queue';
    legendIdleText.textContent = 'Waiting room';
    legendQueueSw.style.background = 'var(--customer-wait)';
    legendIdleSw.style.background = 'var(--customer)';
  } else {
    modeHint.textContent = 'Arrivals go directly into the application queue.';
    releaseHint.textContent = 'Used only in protected mode to admit users from the waiting room.';
    headerSubtitle.innerHTML = 'Poisson arrivals &lambda; &middot; Exponential service &mu; &middot; single server, FCFS, infinite buffer';
    lambdaLabel.innerHTML = 'Arrival rate &lambda; (per sim-second)';
    forceLabel.textContent = 'Forced arrivals at once';
    arriveButton.textContent = 'Force arrivals';
    queueTitle.innerHTML = 'Queue &mdash; live state';
    legendBusyText.textContent = 'Server (busy)';
    legendQueueText.textContent = 'Waiting customers';
    legendIdleText.textContent = 'Server (idle)';
    legendQueueSw.style.background = 'var(--customer-wait)';
    legendIdleSw.style.background = 'var(--server-idle)';
  }
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const nextTheme = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme);
});

document.getElementById('lambda').addEventListener('input', e => updateLambda(parseFloat(e.target.value)));
document.getElementById('mu').addEventListener('input',     e => updateMu(parseFloat(e.target.value)));
document.getElementById('releaseRate').addEventListener('input', e => updateReleaseRate(parseFloat(e.target.value)));
document.getElementById('speed').addEventListener('input',  e => updateSpeed(parseFloat(e.target.value)));
document.getElementById('modeToggle').addEventListener('click', () => {
  state.running = false;
  document.getElementById('playBtn').innerHTML = '&#9654; Play';
  state.protectedMode = !state.protectedMode;
  syncModeControls();
  reset();
});

document.getElementById('playBtn').addEventListener('click', () => {
  state.running = !state.running;
  document.getElementById('playBtn').innerHTML = state.running ? '&#10074;&#10074; Pause' : '&#9654; Play';
  if (state.running) lastFrame = null;
});
document.getElementById('stepBtn').addEventListener('click', stepOneEvent);
document.getElementById('arriveBtn').addEventListener('click', () => forceArrival());
document.getElementById('arrivalsPerForce').addEventListener('change', (e) => {
  e.target.value = String(sanitizeForcedArrivalCount(e.target.value));
});
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
initTheme();
syncModeControls();
updateLambda(parseFloat(document.getElementById('lambda').value));
updateMu(parseFloat(document.getElementById('mu').value));
updateReleaseRate(parseFloat(document.getElementById('releaseRate').value));
updateSpeed(parseFloat(document.getElementById('speed').value));
reset();
requestAnimationFrame(frame);

// Re-render on resize
window.addEventListener('resize', render);
