/* CelloCoach front-end — vanilla JS single-page app. Fully static: all data
   lives in this browser (db.js) and AI calls go straight to OpenAI (ai.js). */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

const state = {
  tab: 'practice',
  data: null,
  conversationId: null,
  libraryMode: 'pieces',
  setupSel: [],
  setupSpotSel: [],
};

const RATING_LABELS = ['Again', 'Hard', 'Good', 'Easy'];

// ---------- tiny helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function openSheet(html) {
  $('#sheet').innerHTML = '<div class="grabber"></div>' + html;
  $('#sheet').classList.remove('hidden');
  $('#sheet-backdrop').classList.remove('hidden');
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet-backdrop').classList.add('hidden');
}
$('#sheet-backdrop').addEventListener('click', closeSheet);

function refreshState() {
  state.data = {
    settings: DB.getSettings(),
    pieces: DB.listPieces(),
    spots: DB.listSpots(),
    stats: DB.stats(),
    today: DB.today(),
  };
  return state.data;
}

// ---------- tabs ----------

$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    render();
  })
);

function render() {
  if (state.tab !== 'practice') { stopListening(); stopTuner(); }
  ({ practice: renderPractice, chat: renderChat, record: renderRecord, library: renderLibrary, settings: renderSettings }[state.tab])();
}

// ============================================================
// PRACTICE — timer-driven interleaved session with voice notes
// ============================================================

const practice = {
  session: null,
  timer: null,
  recog: null,
  listening: false,
  wakeLock: null,
};

const tuner = {
  context: null,
  analyser: null,
  stream: null,
  source: null,
  frame: null,
  buffer: null,
  running: false,
  starting: false,
  status: 'Tuner is off',
  lastPitch: null,
  lastAnalysis: 0,
};

const NOTE_NAMES = ['C', 'C\u266f', 'D', 'D\u266f', 'E', 'F', 'F\u266f', 'G', 'G\u266f', 'A', 'A\u266f', 'B'];

function tunerMarkup() {
  return `
    <section class="tuner-card" aria-labelledby="tuner-title">
      <div class="tuner-head">
        <div><div class="tuner-kicker">Live pitch</div><h3 id="tuner-title">Chromatic tuner</h3></div>
        <button class="btn small ${tuner.running ? 'danger' : 'secondary'}" id="tuner-toggle">${tuner.running ? 'Stop' : 'Start'}</button>
      </div>
      <div class="tuner-readout" aria-live="polite">
        <div class="tuner-direction" id="tuner-direction">${tuner.running ? 'Play a steady note' : esc(tuner.status)}</div>
        <div class="tuner-note" id="tuner-note">\u2014<span></span></div>
        <div class="tuner-frequency" id="tuner-frequency">\u2014 Hz</div>
      </div>
      <div class="tuner-gauge" id="tuner-gauge" aria-label="Pitch deviation from minus 50 to plus 50 cents">
        <div class="tuner-zone"></div>
        <div class="tuner-center"></div>
        <div class="tuner-needle" id="tuner-needle"></div>
        <span class="tuner-tick left">\u221250</span><span class="tuner-tick mid">0</span><span class="tuner-tick right">+50</span>
      </div>
      <div class="tuner-cents" id="tuner-cents">0 cents</div>
      <p class="tuner-status" id="tuner-status">${esc(tuner.status)}</p>
    </section>`;
}

function bindTunerControls() {
  $('#tuner-toggle')?.addEventListener('click', () => tuner.running ? stopTuner() : startTuner());
  if (tuner.running) updateTunerDisplay(tuner.lastPitch);
}

async function startTuner() {
  if (tuner.running || tuner.starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setTunerStatus('Microphone tuning is not supported in this browser.', true);
    return;
  }
  tuner.starting = true;
  const startButton = $('#tuner-toggle');
  if (startButton) { startButton.textContent = 'Starting\u2026'; startButton.disabled = true; }
  setTunerStatus('Requesting microphone access\u2026');
  let stream;
  let context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!practice.session) { stream.getTracks().forEach((track) => track.stop()); return; }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    context = new AudioCtx();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    Object.assign(tuner, {
      context, analyser, stream, source, running: true,
      buffer: new Float32Array(analyser.fftSize), status: 'Listening', lastPitch: null,
    });
    const btn = $('#tuner-toggle');
    if (btn) { btn.textContent = 'Stop'; btn.disabled = false; btn.classList.add('danger'); btn.classList.remove('secondary'); }
    setTunerStatus('Listening \u00b7 play one note at a time');
    tuner.frame = requestAnimationFrame(tunerLoop);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    try { context?.close(); } catch {}
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    setTunerStatus(denied
      ? 'Microphone access was blocked. Allow it in browser settings, then tap Start.'
      : 'Could not start the microphone. Check that it is available, then try again.', true);
  } finally {
    tuner.starting = false;
    const btn = $('#tuner-toggle');
    if (btn && !tuner.running) { btn.textContent = 'Start'; btn.disabled = false; }
  }
}

function stopTuner() {
  cancelAnimationFrame(tuner.frame);
  tuner.stream?.getTracks().forEach((track) => track.stop());
  try { tuner.source?.disconnect(); } catch {}
  try { tuner.context?.close(); } catch {}
  Object.assign(tuner, {
    context: null, analyser: null, stream: null, source: null, frame: null,
    buffer: null, running: false, starting: false, status: 'Tuner is off', lastPitch: null,
  });
  const btn = $('#tuner-toggle');
  if (btn) { btn.textContent = 'Start'; btn.classList.remove('danger'); btn.classList.add('secondary'); }
  updateTunerDisplay(null);
  setTunerStatus('Tuner is off');
}

function setTunerStatus(message, isError = false) {
  tuner.status = message;
  const status = $('#tuner-status');
  if (status) { status.textContent = message; status.classList.toggle('error', isError); }
  const direction = $('#tuner-direction');
  if (direction && !tuner.lastPitch) direction.textContent = message;
}

function tunerLoop() {
  if (!tuner.running || !tuner.analyser) return;
  const now = performance.now();
  if (now - tuner.lastAnalysis >= 80) {
    tuner.lastAnalysis = now;
    tuner.analyser.getFloatTimeDomainData(tuner.buffer);
    const frequency = detectPitch(tuner.buffer, tuner.context.sampleRate);
    tuner.lastPitch = frequency ? pitchDetails(frequency) : null;
    updateTunerDisplay(tuner.lastPitch);
  }
  tuner.frame = requestAnimationFrame(tunerLoop);
}

// Autocorrelation with parabolic interpolation. The RMS gate rejects room noise;
// choosing the first strong correlation peak reduces octave jumps on bowed strings.
function detectPitch(samples, sampleRate) {
  const sampleCount = Math.min(samples.length, 2048);
  let rms = 0;
  for (let i = 0; i < sampleCount; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / sampleCount);
  if (rms < 0.012) return null;

  const minLag = Math.floor(sampleRate / 2000);
  const maxLag = Math.min(Math.floor(sampleRate / 40), sampleCount >> 1);
  const correlations = new Float32Array(maxLag + 1);
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, normA = 0, normB = 0;
    const limit = sampleCount - lag;
    for (let i = 0; i < limit; i++) {
      const a = samples[i], b = samples[i + lag];
      sum += a * b; normA += a * a; normB += b * b;
    }
    const corr = sum / Math.sqrt(normA * normB || 1);
    correlations[lag] = corr;
    if (corr > best) { best = corr; bestLag = lag; }
  }
  if (best < 0.82 || bestLag < 0) return null;

  // Prefer the earliest local peak near the global maximum (the fundamental period).
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    if (correlations[lag] > best * 0.92 && correlations[lag] >= correlations[lag - 1] && correlations[lag] > correlations[lag + 1]) {
      bestLag = lag; break;
    }
  }
  const y1 = correlations[bestLag - 1] || correlations[bestLag];
  const y2 = correlations[bestLag];
  const y3 = correlations[bestLag + 1] || correlations[bestLag];
  const denom = y1 - 2 * y2 + y3;
  const refinedLag = bestLag + (denom ? 0.5 * (y1 - y3) / denom : 0);
  const hz = sampleRate / refinedLag;
  return hz >= 40 && hz <= 2000 ? hz : null;
}

function pitchDetails(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const target = 440 * 2 ** ((midi - 69) / 12);
  return {
    frequency,
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: 1200 * Math.log2(frequency / target),
  };
}

function updateTunerDisplay(pitch) {
  const note = $('#tuner-note');
  const frequency = $('#tuner-frequency');
  const cents = $('#tuner-cents');
  const needle = $('#tuner-needle');
  const direction = $('#tuner-direction');
  const gauge = $('#tuner-gauge');
  if (!note) return;
  if (!pitch) {
    note.innerHTML = '\u2014<span></span>';
    frequency.textContent = '\u2014 Hz'; cents.textContent = '0 cents';
    needle.style.transform = 'translateX(-50%) rotate(0deg)';
    direction.textContent = tuner.running ? 'Play a steady note' : tuner.status;
    gauge.classList.remove('in-tune');
    return;
  }
  const rounded = Math.round(pitch.cents);
  const clamped = clamp(pitch.cents, -50, 50);
  note.innerHTML = `${pitch.name}<span>${pitch.octave}</span>`;
  frequency.textContent = `${pitch.frequency.toFixed(1)} Hz`;
  cents.textContent = `${rounded > 0 ? '+' : ''}${rounded} cent${Math.abs(rounded) === 1 ? '' : 's'}`;
  needle.style.transform = `translateX(-50%) rotate(${clamped * 0.9}deg)`;
  const inTune = Math.abs(pitch.cents) <= 5;
  gauge.classList.toggle('in-tune', inTune);
  direction.textContent = inTune ? 'In tune' : pitch.cents < 0 ? 'Tune up \u00b7 flat' : 'Tune down \u00b7 sharp';
}

const PRACTICE_PREFS_KEY = 'cc-practice-prefs';
const PRACTICE_SESSION_KEY = 'cc-practice-session';

const PREF_DEFAULTS = { totalMin: 30, reps: 2, mode: 'pieces' };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// You set the TOTAL length; block length is derived from it. Saves from the older
// "minutes per block x rounds" model are converted rather than thrown away — two
// rounds of 7 minutes was really a ~28-minute session, so that's what it becomes.
function prefs() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(PRACTICE_PREFS_KEY) || '{}') || {}; } catch {}
  const p = { ...PREF_DEFAULTS, ...raw };
  if (raw.totalMin == null && Number.isFinite(raw.blockMin) && Number.isFinite(raw.rounds)) {
    p.totalMin = clamp(raw.blockMin * raw.rounds * 2, 10, 120);
    p.reps = raw.rounds;
  }
  p.totalMin = clamp(Math.round(Number(p.totalMin) || PREF_DEFAULTS.totalMin), 5, 180);
  p.reps = clamp(Math.round(Number(p.reps) || PREF_DEFAULTS.reps), 1, 6);
  if (p.mode !== 'spots') p.mode = 'pieces';
  delete p.blockMin; delete p.rounds;
  return p;
}

// Split `totalMin` across `n` blocks in whole seconds, handing the leftover seconds to
// the earliest blocks. 30 minutes over 4 becomes four 7:30 blocks — not four 7:00 blocks
// and three minutes quietly lost off the end of the session.
function splitBlockSecs(totalMin, n) {
  if (n <= 0) return [];
  const total = Math.round(totalMin * 60);
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}
function savePrefs(p) { localStorage.setItem(PRACTICE_PREFS_KEY, JSON.stringify(p)); }
function saveSession() {
  if (practice.session) localStorage.setItem(PRACTICE_SESSION_KEY, JSON.stringify(practice.session));
  else localStorage.removeItem(PRACTICE_SESSION_KEY);
}

function beep(times = 3) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.35 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.35 + 0.25);
      o.start(ctx.currentTime + i * 0.35);
      o.stop(ctx.currentTime + i * 0.35 + 0.3);
    }
  } catch {}
}
function say(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
async function grabWakeLock() {
  try { practice.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

// ---------- setup screen ----------

// "due 2026-09-01" wraps a narrow row onto a second line and reads slower than the
// thing you actually want to know, which is whether it's waiting on you right now.
function dueLabel(dateStr) {
  const today = DB.today();
  if (!dateStr) return '';
  if (dateStr <= today) return dateStr < today ? 'overdue' : 'due today';
  const days = Math.round((new Date(dateStr + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  return days === 1 ? 'due tomorrow' : `due in ${days}d`;
}

// Everything the setup screen and startSession() need to agree on: what you picked,
// how many blocks that becomes, and how long each one runs.
function sessionPlan() {
  const pf = prefs();
  const data = state.data || refreshState();
  if (pf.mode === 'spots') {
    const chosen = state.setupSpotSel
      .map((id) => data.spots.find((sp) => sp.id === id))
      .filter(Boolean);
    const order = chosen.map((sp) => ({
      kind: 'spot', spotId: sp.id, pieceId: sp.piece_id ?? 0,
      title: sp.name, sub: sp.piece_title || 'Technique',
    }));
    return { pf, order, unit: 'spot' };
  }
  const titles = new Map([[0, '🛠 Technique'], ...data.pieces.map((p) => [p.id, p.title])]);
  const order = state.setupSel.map((id) => ({
    kind: 'piece', pieceId: id, spotId: null,
    title: titles.get(id) || 'Piece', sub: '',
  }));
  return { pf, order, unit: 'piece' };
}

// One block per pick, the whole set repeated `reps` times. Repeating the set rather
// than each item keeps the same thing from running back-to-back — the interleaving is
// the point, so two reps of A,B is A,B,A,B and never A,A,B,B.
function buildBlocks() {
  const { pf, order } = sessionPlan();
  if (!order.length) return [];
  const blocks = [];
  for (let r = 0; r < pf.reps; r++) blocks.push(...order.map((o) => ({ ...o })));
  const secs = splitBlockSecs(pf.totalMin, blocks.length);
  blocks.forEach((b, i) => { b.secs = secs[i]; });
  return blocks;
}

// ---------- setup screen ----------

function renderPractice() {
  if (practice.session) return renderSessionScreen();
  const data = refreshState();

  const t = data.today;
  const pf = prefs();
  const spotsMode = pf.mode === 'spots';

  const groups = [...data.pieces.filter((p) => p.status === 'active').map((p) => ({ id: p.id, title: p.title }))];
  if (data.spots.some((s) => !s.piece_id)) groups.push({ id: 0, title: '🛠 Technique & warm-ups' });
  const dueCount = (id) => Scheduler.spotsForPiece(id).filter((s) => s.due_date <= t).length;
  const strugCount = (id) => Scheduler.spotsForPiece(id).filter((s) => s.status === 'struggling').length;

  // First visit of the day: pre-pick what needs the work, so the common case is
  // "set the time, hit start". Only ever seeds an empty selection.
  if (!spotsMode && !state.setupSel.length) {
    state.setupSel = groups
      .map((g) => ({ id: g.id, score: strugCount(g.id) * 10 + dueCount(g.id) + (Scheduler.spotsForPiece(g.id).length ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((g) => g.score > 0)
      .map((g) => g.id);
  }

  // Spots mode lists every live spot, hardest and most overdue first, grouped by piece.
  const allSpots = spotsMode
    ? [...data.spots.filter((sp) => sp.status !== 'mastered')]
        .sort((a, b) => Scheduler.spotPriority(b) - Scheduler.spotPriority(a))
    : [];
  state.setupSpotSel = state.setupSpotSel.filter((id) => allSpots.some((sp) => sp.id === id));

  const picked = spotsMode ? state.setupSpotSel : state.setupSel;
  const blocks = buildBlocks();
  const perBlock = blocks.length ? blocks[0].secs : 0;
  const thin = blocks.length && perBlock < 90;

  const pickerRows = spotsMode
    ? (allSpots.map((sp) => {
        const pos = state.setupSpotSel.indexOf(sp.id);
        return `<div class="piece-pick ${pos !== -1 ? 'picked' : ''}" data-pickspot="${sp.id}">
          <span class="pick-num">${pos !== -1 ? pos + 1 : ''}</span>
          <div class="grow">
            <div class="title">${esc(sp.name)}</div>
            <div class="sub"><span class="status-pill ${esc(sp.status)}">${esc(sp.status)}</span> ${esc(sp.piece_title || 'Technique')} · ${esc(dueLabel(sp.due_date))}</div>
          </div>
          <button class="pick-dots" data-editspot="${sp.id}" title="Edit spot" aria-label="Edit spot">⋯</button>
        </div>`;
      }).join('') || '<p class="muted">No practice spots yet — add one below, or say one into the mic during a session.</p>')
    : (groups.map((g) => {
        const pos = state.setupSel.indexOf(g.id);
        return `<div class="piece-pick ${pos !== -1 ? 'picked' : ''}" data-pick="${g.id}">
          <span class="pick-num">${pos !== -1 ? pos + 1 : ''}</span>
          <div class="grow">
            <div class="title">${esc(g.title)}</div>
            <div class="sub">${dueCount(g.id)} due${strugCount(g.id) ? ` · <span style="color:var(--red)">${strugCount(g.id)} struggling</span>` : ''}</div>
          </div>
          <button class="pick-dots" data-editpiece="${g.id}" title="Edit piece" aria-label="Edit piece">⋯</button>
        </div>`;
      }).join('') || '<p class="muted">No songs yet — add one below, or tell the Coach what you\'re working on.</p>');

  view.innerHTML = `
    <h1 class="page-title">Practice</h1>
    <p class="page-sub">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
    <div class="stat-row">
      <div class="stat"><div class="num">${data.stats.streak}</div><div class="lbl">day streak</div></div>
      <div class="stat"><div class="num">${data.spots.filter((s) => s.due_date <= t && s.status !== 'mastered').length}</div><div class="lbl">spots due</div></div>
      <div class="stat"><div class="num">${data.stats.struggling}</div><div class="lbl">struggling</div></div>
    </div>

    <div class="card">
      <h3>How long today?</h3>
      <div class="row">
        <div class="grow"><span class="big-num">${pf.totalMin}</span> <span class="muted">minutes</span></div>
        <div class="stepper"><button data-step="totalMin:-5">−</button><button data-step="totalMin:5">＋</button></div>
      </div>
      <div class="quick-mins">
        ${[15, 20, 30, 45, 60].map((m) => `<button class="chip ${m === pf.totalMin ? 'on' : ''}" data-mins="${m}">${m}</button>`).join('')}
      </div>
    </div>

    <div class="seg">
      <button data-mode="pieces" class="${spotsMode ? '' : 'active'}">Songs</button>
      <button data-mode="spots" class="${spotsMode ? 'active' : ''}">Spots</button>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <h3 style="margin:0" class="grow">${spotsMode ? 'Spots to drill' : 'Songs this session'}</h3>
        <button class="btn small secondary" id="add-item">＋ ${spotsMode ? 'Spot' : 'Song'}</button>
      </div>
      ${pickerRows}
    </div>

    <div class="card">
      <div class="row">
        <div class="grow">Repetitions of each ${spotsMode ? 'spot' : 'song'}</div>
        <div class="stepper"><button data-step="reps:-1">−</button><b>${pf.reps}</b><button data-step="reps:1">＋</button></div>
      </div>
    </div>

    ${picked.length ? `<div class="card setup-readout">
      <div class="ro-main">${blocks.length} block${blocks.length === 1 ? '' : 's'} × ${fmtTime(perBlock)}</div>
      <div class="muted">${picked.length} ${spotsMode ? 'spot' : 'song'}${picked.length === 1 ? '' : 's'} · ${pf.reps} rep${pf.reps === 1 ? '' : 's'} each · ${pf.totalMin} min total</div>
      ${thin ? `<div class="warn">Blocks under 1:30 — fewer ${spotsMode ? 'spots' : 'songs'}, fewer reps, or more time would give each one room to land.</div>` : ''}
    </div>` : ''}

    <button class="btn" id="start-session" ${!picked.length ? 'disabled' : ''}>▶ Start ${pf.totalMin}-minute session${blocks.length ? ` · ${blocks.length} blocks` : ''}</button>
    <p class="muted" style="text-align:center;margin-top:10px">Short and dense beats long and mushy — the forgetting between sessions is where the learning happens.</p>
  `;

  // Picking. The ⋯ is checked first: it lives inside the row, and without this
  // tapping it would toggle the selection on the way to opening the editor.
  $$('[data-pick]', view).forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-editpiece]')) return;
      const id = +el.dataset.pick;
      const i = state.setupSel.indexOf(id);
      if (i !== -1) state.setupSel.splice(i, 1); else state.setupSel.push(id);
      renderPractice();
    })
  );
  $$('[data-pickspot]', view).forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-editspot]')) return;
      const id = +el.dataset.pickspot;
      const i = state.setupSpotSel.indexOf(id);
      if (i !== -1) state.setupSpotSel.splice(i, 1); else state.setupSpotSel.push(id);
      renderPractice();
    })
  );

  // Editing in place — the Library's own sheets, told to come back here when done.
  $$('[data-editpiece]', view).forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openPieceSheet(+b.dataset.editpiece, data, renderPractice); })
  );
  $$('[data-editspot]', view).forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openSpotSheet(+b.dataset.editspot, data, null, renderPractice); })
  );
  $('#add-item').addEventListener('click', () => {
    if (spotsMode) openSpotSheet(null, data, null, renderPractice);
    else openPieceCreateSheet(renderPractice);
  });

  $$('.seg button', view).forEach((b) =>
    b.addEventListener('click', () => { savePrefs({ ...pf, mode: b.dataset.mode }); renderPractice(); })
  );
  $$('[data-mins]', view).forEach((b) =>
    b.addEventListener('click', () => { savePrefs({ ...pf, totalMin: +b.dataset.mins }); renderPractice(); })
  );
  $$('[data-step]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const [key, d] = b.dataset.step.split(':');
      savePrefs({ ...pf, [key]: pf[key] + Number(d) });   // prefs() clamps on the way back out
      renderPractice();
    })
  );
  $('#start-session')?.addEventListener('click', startSession);
}

function startSession() {
  const blocks = buildBlocks();
  if (!blocks.length) return toast('Pick something to practice first');
  practice.session = {
    blocks,
    idx: 0,
    blockSecs: blocks[0].secs,
    endsAt: Date.now() + blocks[0].secs * 1000,
    pausedLeft: null,
    startedAt: new Date().toISOString(),
    voiceLog: [],
    ratedThisBlock: [],
  };
  saveSession();
  grabWakeLock();
  beep(1);
  say(`Starting with ${blocks[0].title.replace(/^[^\w]*/, '')}`);
  renderSessionScreen();
  startTuner();
}

// ---------- session screen ----------

function renderSessionScreen() {
  const s = practice.session;
  const block = s.blocks[s.idx];

  view.innerHTML = `
    <div class="session">
      <div class="session-top">
        <span class="muted">Block ${s.idx + 1} of ${s.blocks.length}</span>
        <button class="btn small danger" id="end-session">End</button>
      </div>
      <div class="session-piece">${esc(block.title)}</div>
      ${block.sub ? `<div class="session-sub">${esc(block.sub)}</div>` : ''}
      <div class="session-timer ${s.pausedLeft ? 'paused' : ''}" id="session-timer">--:--</div>
      <div class="progressbar"><div id="session-bar" style="width:0%"></div></div>
      ${tunerMarkup()}
      <div class="session-controls">
        <button class="ctrl-btn" id="pause-btn">${s.pausedLeft ? '▶' : '⏸'}</button>
        <button class="ctrl-btn mic ${practice.listening ? 'live' : ''}" id="mic-btn">🎙️</button>
        <button class="ctrl-btn" id="skip-btn">⏭</button>
      </div>
      <p class="muted" style="text-align:center;margin:2px 0 6px" id="voice-status">${
        practice.listening ? 'Listening — just talk about what you\'re working on' : 'Tap the mic, then talk — "measures 30 to 34, that shift is really hard"'}</p>
      <div id="voice-feed"></div>
      <h3 style="margin:14px 0 8px">${(block.kind || 'piece') === 'spot' ? 'This spot' : 'Work on these <span class="muted">(hardest first)</span>'}</h3>
      <div id="block-spots"></div>
    </div>`;

  refreshBlockSpots();
  $('#end-session').addEventListener('click', () => endSession(false));
  $('#skip-btn').addEventListener('click', () => advanceBlock(true));
  $('#pause-btn').addEventListener('click', togglePause);
  $('#mic-btn').addEventListener('click', toggleListening);
  bindTunerControls();

  clearInterval(practice.timer);
  practice.timer = setInterval(tickSession, 250);
  tickSession();
}

function sessionSpotHtml(sp) {
  const rated = practice.session.ratedThisBlock.includes(sp.id);
  return `
  <div class="plan-item ${rated ? 'done' : ''}">
    <div class="row">
      <div class="grow">
        <div class="title">${esc(sp.name)}</div>
        ${sp.description ? `<div class="desc">${esc(sp.description)}</div>` : ''}
      </div>
      <span class="status-pill ${esc(sp.status)}">${esc(sp.status)}</span>
      <button class="pick-dots" data-editspot="${sp.id}" title="Edit this spot" aria-label="Edit this spot">⋯</button>
    </div>
    ${rated ? '' : `<div class="rate-row">${[0, 1, 2, 3].map((r) => `<button class="rate-btn r${r}" data-rate="${r}" data-spot="${sp.id}">${RATING_LABELS[r]}</button>`).join('')}</div>`}
  </div>`;
}

function refreshBlockSpots() {
  const s = practice.session;
  const holder = $('#block-spots');
  if (!holder || !s) return;
  const block = s.blocks[s.idx];
  const data = refreshState();

  let spots;
  let empty;
  if ((block.kind || 'piece') === 'spot') {
    // A spot block is about exactly one spot. It can still go missing mid-session if
    // it was archived from the ⋯ editor, so say so rather than showing a blank block.
    const one = data.spots.find((sp) => sp.id === block.spotId);
    spots = one ? [one] : [];
    empty = '<p class="muted">This spot was removed from your library. Skip ahead when you\'re ready.</p>';
  } else {
    spots = Scheduler.spotsForPiece(block.pieceId);
    empty = '<p class="muted">No spots for this piece yet — say one into the mic and it\'ll appear here.</p>';
  }

  holder.innerHTML = spots.length ? spots.map((sp) => sessionSpotHtml(sp)).join('') : empty;

  $$('#block-spots .rate-btn', view).forEach((b) =>
    b.addEventListener('click', () => {
      b.disabled = true;
      try {
        const r = Scheduler.rateSpot(+b.dataset.spot, +b.dataset.rate);
        s.ratedThisBlock.push(+b.dataset.spot);
        saveSession();
        toast(`${RATING_LABELS[+b.dataset.rate]} — back in ${r.interval_days} day${r.interval_days === 1 ? '' : 's'}`);
        refreshState();
        if (practice.session) refreshBlockSpots();
      } catch (e) { toast(e.message); b.disabled = false; }
    })
  );
  // Fix a spot's wording mid-session without stopping the clock — the sheet is an
  // overlay and the timer runs on its own interval, so the block keeps counting down.
  $$('#block-spots [data-editspot]', view).forEach((b) =>
    b.addEventListener('click', () => {
      openSpotSheet(+b.dataset.editspot, data, null, () => { if (practice.session) refreshBlockSpots(); });
    })
  );
}

function tickSession() {
  const s = practice.session;
  if (!s) return clearInterval(practice.timer);
  const left = s.pausedLeft ?? Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
  const el = $('#session-timer');
  if (el) el.textContent = fmtTime(left);
  const bar = $('#session-bar');
  if (bar) bar.style.width = `${100 - Math.round((left / s.blockSecs) * 100)}%`;
  if (left <= 0 && !s.pausedLeft) advanceBlock(false);
}

function togglePause() {
  const s = practice.session;
  if (s.pausedLeft) {
    s.endsAt = Date.now() + s.pausedLeft * 1000;
    s.pausedLeft = null;
  } else {
    s.pausedLeft = Math.max(1, Math.round((s.endsAt - Date.now()) / 1000));
  }
  saveSession();
  renderSessionScreen();
}

function advanceBlock(manual) {
  const s = practice.session;
  if (s.idx + 1 >= s.blocks.length) return endSession(true);
  s.idx += 1;
  s.blockSecs = s.blocks[s.idx].secs || s.blockSecs;   // each block carries its own length
  s.endsAt = Date.now() + s.blockSecs * 1000;
  s.pausedLeft = null;
  s.ratedThisBlock = [];
  saveSession();
  beep(manual ? 1 : 3);
  say(`Switch to ${s.blocks[s.idx].title.replace(/^[^\w]*/, '')}`);
  if (state.tab === 'practice') renderSessionScreen();
}

function endSession(completed) {
  const s = practice.session;
  clearInterval(practice.timer);
  stopListening();
  stopTuner();
  try { practice.wakeLock?.release(); } catch {}
  practice.session = null;
  saveSession();
  if (s) {
    DB.addPracticeLog({
      started_at: s.startedAt,
      ended_at: new Date().toISOString(),
      detail: { blocks: s.blocks, completedBlocks: completed ? s.blocks.length : s.idx, blockSecs: s.blockSecs, voiceNotes: s.voiceLog.length },
    });
    if (completed) { beep(3); say('Session complete. Nice work.'); }
  }
  state.setupSel = [];
  state.setupSpotSel = [];
  if (state.tab === 'practice') renderPractice();
  if (completed) toast('🎉 Session complete');
}

// ---------- voice notes ----------

function toggleListening() {
  if (practice.listening) stopListening();
  else startListening();
  if (state.tab === 'practice' && practice.session) {
    $('#mic-btn')?.classList.toggle('live', practice.listening);
    const st = $('#voice-status');
    if (st) st.textContent = practice.listening ? 'Listening — just talk about what you\'re working on' : 'Mic off';
  }
}

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice input needs Safari/Chrome with speech recognition.');
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = (e) => {
    let finalText = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const st = $('#voice-status');
    if (st && interim) st.textContent = `“${interim.trim().slice(-80)}”`;
    if (finalText.trim().split(/\s+/).length >= 3) handleVoiceNote(finalText.trim());
  };
  r.onend = () => { if (practice.listening) { try { r.start(); } catch {} } };
  r.onerror = (e) => {
    if (e.error === 'not-allowed') { stopListening(); toast('Mic permission denied'); }
  };
  practice.recog = r;
  practice.listening = true;
  try { r.start(); } catch {}
}

function stopListening() {
  practice.listening = false;
  try { practice.recog?.stop(); } catch {}
  practice.recog = null;
}

async function handleVoiceNote(transcript) {
  const s = practice.session;
  if (!s) return;
  const pieceId = s.blocks[s.idx].pieceId || null;
  const feed = $('#voice-feed');
  const entry = document.createElement('div');
  entry.className = 'voice-entry';
  entry.innerHTML = `<div class="muted">“${esc(transcript)}”</div><div class="muted">…thinking</div>`;
  feed?.prepend(entry);
  try {
    const out = await AI.parseVoiceNote(pieceId, transcript);
    s.voiceLog.push(transcript);
    saveSession();
    entry.querySelector('div:last-child').outerHTML =
      out.applied.length
        ? `<div class="action-chips" style="margin:6px 0 0">${out.applied.map((a) => `<span class="action-chip">✓ ${esc(a)}</span>`).join('')}</div>`
        : '<div class="muted">(nothing to log)</div>';
    if (out.applied.length) {
      say(out.say);
      refreshState();
      if (practice.session) refreshBlockSpots();
    }
  } catch (e) {
    entry.querySelector('div:last-child').textContent = '⚠️ ' + e.message;
  }
}

// Resume a session that survived a reload.
(function resumeSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRACTICE_SESSION_KEY) || 'null');
    if (saved && (saved.pausedLeft || saved.endsAt > Date.now() - 10 * 60 * 1000)) {
      // Sessions written before blocks carried a kind and their own length: fill both
      // in so an in-flight session survives the update instead of throwing.
      (saved.blocks || []).forEach((b) => {
        if (!b.kind) b.kind = 'piece';
        if (!Number.isFinite(b.secs)) b.secs = saved.blockSecs;
      });
      practice.session = saved;
      if (!saved.pausedLeft && saved.endsAt < Date.now()) saved.pausedLeft = saved.blockSecs;
      refreshState();
      if (state.tab === 'practice') renderSessionScreen();
    } else {
      localStorage.removeItem(PRACTICE_SESSION_KEY);
    }
  } catch {}
})();

// ============================================================
// CHAT (Coach)
// ============================================================

function renderChat() {
  view.innerHTML = `
  <div class="chat-wrap">
    <div class="chat-head">
      <h2 id="chat-title">Coach</h2>
      <button class="btn small secondary" id="chats-btn">Chats</button>
      <button class="btn small secondary" id="new-chat-btn">＋ New</button>
    </div>
    <div class="chat-scroll" id="chat-scroll"></div>
    <div class="chat-input-row">
      <textarea id="chat-input" rows="1" placeholder="Tell me what you're practicing…"></textarea>
      <button class="send-btn" id="send-btn">↑</button>
    </div>
  </div>`;

  const scroll = $('#chat-scroll');
  const input = $('#chat-input');
  const sendBtn = $('#send-btn');

  const addMsg = (role, text) => {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    scroll.appendChild(div);
    scroll.scrollTop = scroll.scrollHeight;
    return div;
  };
  const addChips = (applied) => {
    if (!applied || !applied.length) return;
    const div = document.createElement('div');
    div.className = 'action-chips';
    div.innerHTML = applied.map((a) => `<span class="action-chip">✓ ${esc(a)}</span>`).join('');
    scroll.appendChild(div);
    scroll.scrollTop = scroll.scrollHeight;
  };

  function loadConversation(id) {
    state.conversationId = id;
    scroll.innerHTML = '';
    if (!id) {
      scroll.innerHTML = `<div class="empty"><div class="big">🎻</div>
        Hi! I'm your practice coach.<br>Tell me what pieces you're working on, how practice went, or what your teacher said — I'll plan around it.</div>`;
      return;
    }
    for (const msg of DB.listMessages(id)) {
      addMsg(msg.role, msg.content);
      if (msg.actions) addChips(msg.actions);
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = '';
    input.style.height = '';
    sendBtn.disabled = true;
    addMsg('user', text);
    const asst = addMsg('assistant', '');
    asst.classList.add('thinking');
    try {
      if (!state.conversationId) state.conversationId = DB.createConversation('New chat').id;
      const isFirst = DB.listMessages(state.conversationId).length === 0;
      DB.addMessage(state.conversationId, 'user', text);
      if (isFirst) DB.updateConversation(state.conversationId, { title: text.slice(0, 48) });

      const history = DB.listMessages(state.conversationId).slice(-24).map((m) => ({ role: m.role, content: m.content }));
      const messages = [{ role: 'system', content: AI.systemPrompt() }, ...history];

      let buf = '';
      const full = await AI.streamChat(messages, (tok) => {
        buf += tok;
        asst.textContent = buf.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/<act[\s\S]*$/g, '').trimStart();
        scroll.scrollTop = scroll.scrollHeight;
      });
      asst.classList.remove('thinking');
      const { clean, actions } = AI.extractActions(full);
      const applied = actions.length ? AI.applyActions(actions) : [];
      DB.addMessage(state.conversationId, 'assistant', clean, applied.length ? applied : null);
      asst.textContent = clean;
      addChips(applied);
    } catch (e) {
      asst.classList.remove('thinking');
      asst.textContent = `⚠️ ${e.message}`;
    }
    sendBtn.disabled = false;
    scroll.scrollTop = scroll.scrollHeight;
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  });

  $('#new-chat-btn').addEventListener('click', () => loadConversation(null));
  $('#chats-btn').addEventListener('click', () => {
    const convs = DB.listConversations();
    openSheet(`<h3>Chats</h3>${
      convs.length
        ? convs.map((c) => `
          <div class="list-item" data-conv="${c.id}">
            <div class="grow"><div class="title">${esc(c.title)}</div><div class="sub">${esc(c.created_at.slice(0, 16))}</div></div>
            <button class="btn small danger" data-del="${c.id}">✕</button>
          </div>`).join('')
        : '<p class="muted">No chats yet.</p>'
    }`);
    $$('#sheet [data-conv]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        closeSheet();
        loadConversation(+el.dataset.conv);
      })
    );
    $$('#sheet [data-del]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        DB.deleteConversation(+el.dataset.del);
        if (state.conversationId === +el.dataset.del) loadConversation(null);
        el.closest('.list-item').remove();
      })
    );
  });

  loadConversation(state.conversationId);
}

// ============================================================
// RECORD
// ============================================================

const rec = { recorder: null, chunks: [], start: 0, timer: null };

function renderRecord() {
  const recording = !!rec.recorder && rec.recorder.state === 'recording';
  view.innerHTML = `
    <h1 class="page-title">Record</h1>
    <p class="page-sub">Leave it running while you practice.</p>
    <div class="rec-hero">
      <button class="rec-btn ${recording ? 'recording' : ''}" id="rec-btn">${recording ? '■' : '●'}</button>
      <div class="rec-timer" id="rec-timer">${recording ? fmtTime((Date.now() - rec.start) / 1000) : '0:00'}</div>
      <p class="muted" id="rec-hint">${recording ? 'Recording… tap to stop & save' : 'Tap to start recording'}</p>
    </div>
    <div id="rec-list"></div>`;

  if (recording) startTimerLoop();
  $('#rec-btn').addEventListener('click', toggleRecording);
  loadRecordings();

  if (!window.isSecureContext) {
    $('#rec-hint').innerHTML = '⚠️ Microphone needs HTTPS.';
  }
}

function fmtTime(s) {
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function startTimerLoop() {
  clearInterval(rec.timer);
  rec.timer = setInterval(() => {
    const el = $('#rec-timer');
    if (el) el.textContent = fmtTime((Date.now() - rec.start) / 1000);
  }, 500);
}

async function toggleRecording() {
  if (rec.recorder && rec.recorder.state === 'recording') {
    rec.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.chunks = [];
    rec.start = Date.now();
    rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.recorder.onstop = async () => {
      clearInterval(rec.timer);
      stream.getTracks().forEach((t) => t.stop());
      const seconds = Math.round((Date.now() - rec.start) / 1000);
      const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/mp4' });
      rec.recorder = null;
      if (seconds < 1) { renderRecord(); return; }
      toast('Saving recording…');
      try {
        await DB.saveBlob(blob, { kind: 'recording', label: 'Practice ' + new Date().toLocaleString(), seconds, mime: blob.type });
        toast(`Saved ${fmtTime(seconds)} recording`);
      } catch (e) { toast('Save failed: ' + e.message); }
      if (state.tab === 'record') renderRecord();
    };
    rec.recorder.start(1000);
    renderRecord();
  } catch (e) {
    toast('Mic unavailable: ' + e.message);
  }
}

async function loadRecordings() {
  const list = $('#rec-list');
  if (!list) return;
  const recs = (await DB.listBlobMeta()).filter((r) => r.kind === 'recording').sort((a, b) => b.id - a.id);
  if (!recs.length) {
    list.innerHTML = '<div class="empty">No recordings yet.</div>';
    return;
  }
  list.innerHTML = '<h3 style="margin:8px 0 10px;font-size:1rem">Recordings</h3>' + recs.map((r) => `
    <div class="card" style="padding:12px 14px">
      <div class="row">
        <div class="grow">
          <div style="font-weight:700;font-size:.9rem">${esc(r.label || 'Recording ' + r.id)}</div>
          <div class="muted">${r.seconds ? fmtTime(r.seconds) + ' · ' : ''}${esc(r.created_at.slice(0, 16))}</div>
        </div>
        <button class="btn small secondary" data-play="${r.id}">▶</button>
        <button class="btn small danger" data-delrec="${r.id}">✕</button>
      </div>
      <div data-player="${r.id}"></div>
    </div>`).join('');
  $$('#rec-list [data-play]').forEach((b) =>
    b.addEventListener('click', async () => {
      const holder = $(`#rec-list [data-player="${b.dataset.play}"]`);
      const existing = holder.querySelector('audio');
      if (existing) { URL.revokeObjectURL(existing.src); holder.innerHTML = ''; return; }
      const rec = await DB.getBlob(+b.dataset.play);
      if (!rec) return toast('Recording not found');
      holder.innerHTML = `<audio controls autoplay src="${URL.createObjectURL(rec.blob)}"></audio>`;
    })
  );
  $$('#rec-list [data-delrec]').forEach((b) =>
    b.addEventListener('click', async () => {
      await DB.deleteBlob(+b.dataset.delrec);
      loadRecordings();
    })
  );
}

// ============================================================
// LIBRARY (pieces, spots, lessons)
// ============================================================

function renderLibrary() {
  const data = refreshState();
  view.innerHTML = `
    <h1 class="page-title">Library</h1>
    <p class="page-sub">Pieces, spots and lessons.</p>
    <div class="seg">
      <button data-mode="pieces" class="${state.libraryMode === 'pieces' ? 'active' : ''}">Pieces</button>
      <button data-mode="lessons" class="${state.libraryMode === 'lessons' ? 'active' : ''}">Lessons</button>
    </div>
    <div id="lib-body"></div>`;
  $$('.seg button', view).forEach((b) =>
    b.addEventListener('click', () => { state.libraryMode = b.dataset.mode; renderLibrary(); })
  );
  if (state.libraryMode === 'pieces') renderPieces(data);
  else renderLessons();
}

function renderPieces(data) {
  const body = $('#lib-body');
  const spotsByPiece = {};
  for (const s of data.spots) (spotsByPiece[s.piece_id ?? 0] ||= []).push(s);
  const technique = spotsByPiece[0] || [];

  let html = '<button class="btn" id="add-piece">＋ Add piece</button><div class="spacer"></div>';
  for (const p of data.pieces) {
    const spots = spotsByPiece[p.id] || [];
    html += `
      <div class="list-item" data-piece="${p.id}">
        <div class="grow">
          <div class="title">${esc(p.title)} ${p.status !== 'active' ? `<span class="muted">(${p.status})</span>` : ''}</div>
          <div class="sub">${esc(p.composer || '')}${p.composer ? ' · ' : ''}${spots.length} spot${spots.length === 1 ? '' : 's'}</div>
        </div><span class="chev">›</span>
      </div>`;
  }
  if (technique.length || data.pieces.length) {
    html += `
      <div class="list-item" data-piece="0">
        <div class="grow"><div class="title">🛠 Technique &amp; warm-ups</div><div class="sub">${technique.length} item${technique.length === 1 ? '' : 's'}</div></div>
        <span class="chev">›</span>
      </div>`;
  }
  if (!data.pieces.length) {
    html += `<div class="empty"><div class="big">🎼</div>No pieces yet. Add one, or just tell the Coach what you're working on.</div>`;
  }
  body.innerHTML = html;

  $('#add-piece').addEventListener('click', () => openPieceCreateSheet());
  $$('[data-piece]', body).forEach((el) =>
    el.addEventListener('click', () => openPieceSheet(+el.dataset.piece, data))
  );
}

// Shared by the Library's ＋ Add piece and the Practice screen's ＋ Song.
function openPieceCreateSheet(onDone = renderLibrary) {
  openSheet(`<h3>Add piece</h3>
    <label class="field"><span class="lab">Title</span><input type="text" id="np-title" placeholder="Elgar Cello Concerto, mvt 1"></label>
    <label class="field"><span class="lab">Composer</span><input type="text" id="np-composer" placeholder="Edward Elgar"></label>
    <button class="btn" id="np-save">Add piece</button>`);
  $('#np-save').addEventListener('click', () => {
    const title = $('#np-title').value.trim();
    if (!title) return toast('Title is required');
    DB.addPiece({ title, composer: $('#np-composer').value.trim() });
    closeSheet(); toast('Piece added'); onDone();
  });
}

function openPieceSheet(pieceId, data, onDone = renderLibrary) {
  const piece = pieceId ? data.pieces.find((p) => p.id === pieceId) : { id: 0, title: 'Technique & warm-ups' };
  const spots = data.spots.filter((s) => (s.piece_id ?? 0) === pieceId);
  openSheet(`
    <h3>${esc(piece.title)}</h3>
    ${spots.map((s) => `
      <div class="list-item" data-spot="${s.id}">
        <div class="grow">
          <div class="title">${esc(s.name)}</div>
          <div class="sub">${esc(s.kind)} · due ${esc(s.due_date)} · ${s.reps} reps${s.lapses ? ' · ' + s.lapses + ' lapses' : ''}</div>
        </div>
        <span class="status-pill ${esc(s.status)}">${esc(s.status)}</span>
      </div>`).join('') || '<p class="muted" style="margin-bottom:12px">No spots yet.</p>'}
    <div class="spacer"></div>
    <button class="btn" id="ps-add">＋ Add spot</button>
    ${pieceId ? `<div class="spacer"></div>
      <div class="row">
        <button class="btn small secondary grow" id="ps-toggle">${piece.status === 'active' ? 'Pause piece' : 'Reactivate piece'}</button>
        <button class="btn small danger" id="ps-del">Delete</button>
      </div>` : ''}
  `);
  $$('#sheet [data-spot]').forEach((el) =>
    el.addEventListener('click', () => openSpotSheet(+el.dataset.spot, data, null, onDone))
  );
  $('#ps-add').addEventListener('click', () => openSpotSheet(null, data, pieceId, onDone));
  $('#ps-toggle')?.addEventListener('click', () => {
    DB.updatePiece(pieceId, { status: piece.status === 'active' ? 'paused' : 'active' });
    closeSheet(); onDone();
  });
  $('#ps-del')?.addEventListener('click', () => {
    if (!confirm(`Delete "${piece.title}" and all its spots?`)) return;
    DB.deletePiece(pieceId);
    closeSheet(); toast('Piece deleted'); onDone();
  });
}

function openSpotSheet(spotId, data, defaultPieceId = null, onDone = renderLibrary) {
  const spot = spotId ? data.spots.find((s) => s.id === spotId) : null;
  const pieceOpts = ['<option value="">— Technique / no piece —</option>']
    .concat(data.pieces.map((p) => `<option value="${p.id}" ${((spot ? spot.piece_id : defaultPieceId) === p.id) ? 'selected' : ''}>${esc(p.title)}</option>`))
    .join('');
  openSheet(`
    <h3>${spot ? 'Edit spot' : 'Add spot'}</h3>
    <label class="field"><span class="lab">Name</span><input type="text" id="sp-name" value="${esc(spot?.name || '')}" placeholder="mvt 1, mm. 32–40 shifts"></label>
    <label class="field"><span class="lab">Piece</span><select id="sp-piece">${pieceOpts}</select></label>
    <label class="field"><span class="lab">Kind</span><select id="sp-kind">
      ${['spot', 'technique', 'warmup', 'etude'].map((k) => `<option ${spot?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select></label>
    ${spot ? `<label class="field"><span class="lab">Status</span><select id="sp-status">
      ${['new', 'learning', 'review', 'struggling', 'mastered'].map((s) => `<option ${spot.status === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select></label>` : ''}
    <label class="field"><span class="lab">Notes</span><textarea id="sp-desc" placeholder="What to focus on…">${esc(spot?.description || '')}</textarea></label>
    <button class="btn" id="sp-save">${spot ? 'Save' : 'Add spot'}</button>
    ${spot ? '<div class="spacer"></div><button class="btn danger" id="sp-del">Archive spot</button>' : ''}
  `);
  $('#sp-save').addEventListener('click', () => {
    const payload = {
      name: $('#sp-name').value.trim(),
      piece_id: $('#sp-piece').value ? +$('#sp-piece').value : null,
      kind: $('#sp-kind').value,
      description: $('#sp-desc').value.trim(),
    };
    if (!payload.name) return toast('Name is required');
    if (spot) {
      payload.status = $('#sp-status').value;
      DB.updateSpot(spot.id, payload);
    } else {
      DB.addSpot(payload);
    }
    closeSheet(); toast(spot ? 'Spot updated' : 'Spot added'); onDone();
  });
  $('#sp-del')?.addEventListener('click', () => {
    DB.archiveSpot(spot.id);
    closeSheet(); toast('Spot archived'); onDone();
  });
}

function renderLessons() {
  const body = $('#lib-body');
  const lessons = DB.listLessons();
  body.innerHTML = `
    <button class="btn" id="add-lesson">＋ Add lesson</button><div class="spacer"></div>
    ${lessons.map((l) => `
      <div class="list-item" data-lesson="${l.id}">
        <div class="grow">
          <div class="title">${esc(l.title)} · ${esc(l.date)}</div>
          <div class="sub">${l.audio_blob_id ? '🎙 audio · ' : ''}${esc((l.transcript || '').slice(0, 80)) || 'No transcript'}</div>
        </div><span class="chev">›</span>
      </div>`).join('') || '<div class="empty"><div class="big">📝</div>Upload lesson transcripts or audio and I\'ll pull out what your teacher assigned.</div>'}
  `;
  $('#add-lesson').addEventListener('click', () => {
    openSheet(`<h3>Add lesson</h3>
      <label class="field"><span class="lab">Title</span><input type="text" id="ls-title" placeholder="Lesson with Ms. Park"></label>
      <label class="field"><span class="lab">Date</span><input type="text" id="ls-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="field"><span class="lab">Transcript / notes</span><textarea id="ls-text" placeholder="Paste the lesson transcript or your notes…"></textarea></label>
      <button class="btn" id="ls-save">Save lesson</button>
      <div class="spacer"></div>
      <label class="field"><span class="lab">…or upload lesson audio (needs OpenAI key for transcription)</span>
        <input type="file" id="ls-audio" accept="audio/*"></label>`);
    $('#ls-save').addEventListener('click', () => {
      const transcript = $('#ls-text').value.trim();
      if (!transcript) return toast('Paste a transcript first (or upload audio below)');
      DB.addLesson({ title: $('#ls-title').value.trim() || 'Lesson', date: $('#ls-date').value.trim(), transcript });
      closeSheet(); toast('Lesson saved'); renderLibrary();
    });
    $('#ls-audio').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      toast('Uploading & transcribing…');
      const title = $('#ls-title').value.trim() || 'Lesson (audio)';
      const date = $('#ls-date').value.trim();
      const audio_blob_id = await DB.saveBlob(file, { kind: 'lesson-audio', mime: file.type });
      let transcript = '';
      let err = '';
      try { transcript = await AI.transcribeAudio(file); } catch (e) { err = e.message; }
      DB.addLesson({ title, date, transcript, audio_blob_id });
      closeSheet();
      toast(transcript ? 'Transcribed ✓ — open the lesson to extract spots' : `Saved audio. ${err}`);
      renderLibrary();
    });
  });
  $$('[data-lesson]', body).forEach((el) =>
    el.addEventListener('click', () => openLessonSheet(+el.dataset.lesson))
  );
}

function openLessonSheet(id) {
  const l = DB.getLesson(id);
  openSheet(`
    <h3>${esc(l.title)} · ${esc(l.date)}</h3>
    <p class="muted" style="max-height:130px;overflow-y:auto;margin-bottom:14px;white-space:pre-wrap">${esc(l.transcript || '(no transcript)')}</p>
    <div id="extract-area">${l.extracted ? renderExtracted(l.extracted) : ''}</div>
    <button class="btn" id="ls-extract" ${!l.transcript ? 'disabled' : ''}>${l.extracted ? '↻ Re-extract spots' : '✨ Extract practice spots'}</button>
    <div class="spacer"></div>
    <button class="btn danger" id="ls-del">Delete lesson</button>
  `);
  const wireApply = () => {
    $('#apply-spots')?.addEventListener('click', () => {
      const checked = $$('#sheet .ex-item input:checked').map((c) => JSON.parse(c.dataset.item));
      if (!checked.length) return toast('Nothing selected');
      const applied = AI.applyActions(checked.map((i) => ({ type: 'add_spot', piece: i.piece, name: i.name, description: i.description, kind: i.kind })));
      closeSheet(); toast(`Added ${applied.filter((a) => a.startsWith('Added spot')).length} spots`); renderLibrary();
    });
  };
  wireApply();
  $('#ls-extract').addEventListener('click', async () => {
    const btn = $('#ls-extract');
    btn.disabled = true; btn.textContent = 'Extracting… (this can take a minute)';
    try {
      const items = await AI.extractLessonSpots(l);
      DB.updateLesson(id, { extracted: items });
      $('#extract-area').innerHTML = renderExtracted(items);
      wireApply();
      btn.textContent = '↻ Re-extract spots';
    } catch (e) { toast(e.message); btn.textContent = '✨ Extract practice spots'; }
    btn.disabled = false;
  });
  $('#ls-del').addEventListener('click', () => {
    DB.deleteLesson(id);
    closeSheet(); renderLibrary();
  });
}

function renderExtracted(items) {
  if (!items.length) return '<p class="muted">No assignments found in this transcript.</p>';
  return `<div style="margin-bottom:12px">
    ${items.map((i) => `
      <label class="list-item ex-item" style="cursor:pointer">
        <input type="checkbox" checked data-item='${esc(JSON.stringify(i))}'>
        <div class="grow">
          <div class="title">${esc(i.name)}</div>
          <div class="sub">${esc(i.piece || 'technique')} · ${esc(i.description || '')}</div>
        </div>
      </label>`).join('')}
    <div class="spacer"></div>
    <button class="btn" id="apply-spots">Add selected to practice spots</button>
    <div class="spacer"></div>
  </div>`;
}

// ============================================================
// SETTINGS
// ============================================================

function renderSettings() {
  const data = refreshState();
  const s = data.settings;
  view.innerHTML = `
    <h1 class="page-title">Settings</h1>
    <p class="page-sub">AI, pacing &amp; backup.</p>

    <div class="card">
      <h3>AI coach</h3>
      <label class="field"><span class="lab">OpenAI API key</span>
        <input type="password" id="st-key" value="${esc(s.openai_key)}" placeholder="sk-…"></label>
      <label class="field"><span class="lab">Chat model</span>
        <input type="text" id="st-model" value="${esc(s.chat_model)}"></label>
      <p class="muted">Your key is stored only in this browser and sent directly to OpenAI — never to any server of mine.</p>
    </div>

    <div class="card">
      <h3>Pacing</h3>
      <label class="field"><span class="lab">Daily practice minutes</span>
        <input type="number" id="st-minutes" value="${esc(s.daily_minutes)}" min="10" max="360"></label>
    </div>

    <div class="card">
      <h3>📱 Add to your phone</h3>
      <p class="muted" style="line-height:1.6">Open this same address in Safari, then Share → <b>Add to Home Screen</b>. HTTPS is automatic here, so the mic works right away.</p>
      <div class="spacer"></div>
      <div style="font-weight:700;font-size:1.02rem;color:var(--accent);word-break:break-all">${esc(location.href.replace(/[?#].*$/, ''))}</div>
    </div>

    <div class="card">
      <h3>Backup</h3>
      <p class="muted">Your practice data lives only in this browser. Export it to move to another device or keep a safety copy.</p>
      <div class="row" style="gap:10px;margin-top:12px">
        <button class="btn small secondary grow" id="bk-export">⬇ Export</button>
        <button class="btn small secondary grow" id="bk-import">⬆ Import</button>
      </div>
      <input type="file" id="bk-file" accept="application/json" style="display:none">
    </div>

    <button class="btn" id="st-save">Save settings</button>
    <div class="spacer"></div>
    <button class="btn secondary" id="st-test">Test AI connection</button>
  `;
  $('#st-save').addEventListener('click', () => {
    DB.setSettings({
      openai_key: $('#st-key').value.trim(),
      chat_model: $('#st-model').value.trim() || 'gpt-4o-mini',
      daily_minutes: $('#st-minutes').value,
    });
    toast('Settings saved');
  });
  $('#st-test').addEventListener('click', async () => {
    const btn = $('#st-test');
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const reply = await AI.complete([{ role: 'user', content: 'Reply with exactly: Ready to practice!' }]);
      toast('✓ AI responded: ' + reply.slice(0, 60));
    } catch (e) { toast('✗ ' + e.message); }
    btn.disabled = false; btn.textContent = 'Test AI connection';
  });
  $('#bk-export').addEventListener('click', () => {
    const blob = new Blob([DB.exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cellocoach-backup-${DB.today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#bk-import').addEventListener('click', () => $('#bk-file').click());
  $('#bk-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('This replaces all current practice data in this browser with the backup file. Continue?')) return;
    try {
      DB.importBackup(await file.text());
      toast('Backup imported');
      renderSettings();
    } catch (err) { toast('Import failed: ' + err.message); }
  });
}

// ---------- boot ----------
render();
