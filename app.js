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
  if (state.tab !== 'practice') stopListening();
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

const PRACTICE_PREFS_KEY = 'cc-practice-prefs';
const PRACTICE_SESSION_KEY = 'cc-practice-session';

function prefs() {
  try { return { blockMin: 7, rounds: 2, ...JSON.parse(localStorage.getItem(PRACTICE_PREFS_KEY) || '{}') }; }
  catch { return { blockMin: 7, rounds: 2 }; }
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

function renderPractice() {
  if (practice.session) return renderSessionScreen();
  const data = refreshState();

  const t = data.today;
  const groups = [...data.pieces.filter((p) => p.status === 'active').map((p) => ({ id: p.id, title: p.title }))];
  if (data.spots.some((s) => !s.piece_id)) groups.push({ id: 0, title: '🛠 Technique & warm-ups' });
  const dueCount = (id) => Scheduler.spotsForPiece(id).filter((s) => s.due_date <= t).length;
  const strugCount = (id) => Scheduler.spotsForPiece(id).filter((s) => s.status === 'struggling').length;

  if (!state.setupSel.length) {
    state.setupSel = groups
      .map((g) => ({ id: g.id, score: strugCount(g.id) * 10 + dueCount(g.id) + (Scheduler.spotsForPiece(g.id).length ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((g) => g.score > 0)
      .map((g) => g.id);
  }
  const pf = prefs();
  const sel = state.setupSel;
  const total = sel.length * pf.rounds * pf.blockMin;

  view.innerHTML = `
    <h1 class="page-title">Practice</h1>
    <p class="page-sub">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
    <div class="stat-row">
      <div class="stat"><div class="num">${data.stats.streak}</div><div class="lbl">day streak</div></div>
      <div class="stat"><div class="num">${data.spots.filter((s) => s.due_date <= t && s.status !== 'mastered').length}</div><div class="lbl">spots due</div></div>
      <div class="stat"><div class="num">${data.stats.struggling}</div><div class="lbl">struggling</div></div>
    </div>

    <div class="card">
      <h3>Pieces this session <span class="muted">(tap to pick, max 3)</span></h3>
      ${groups.map((g) => {
        const pos = sel.indexOf(g.id);
        return `<div class="piece-pick ${pos !== -1 ? 'picked' : ''}" data-pick="${g.id}">
          <span class="pick-num">${pos !== -1 ? pos + 1 : ''}</span>
          <div class="grow">
            <div class="title">${esc(g.title)}</div>
            <div class="sub">${dueCount(g.id)} due${strugCount(g.id) ? ` · <span style="color:var(--red)">${strugCount(g.id)} struggling</span>` : ''}</div>
          </div>
        </div>`;
      }).join('') || '<p class="muted">Add pieces in Library, or tell the Coach what you\'re working on.</p>'}
    </div>

    <div class="card">
      <h3>Pacing</h3>
      <div class="row" style="margin-bottom:10px">
        <div class="grow">Minutes per block</div>
        <div class="stepper"><button data-step="blockMin:-1">−</button><b>${pf.blockMin}</b><button data-step="blockMin:1">＋</button></div>
      </div>
      <div class="row">
        <div class="grow">Rounds per piece</div>
        <div class="stepper"><button data-step="rounds:-1">−</button><b>${pf.rounds}</b><button data-step="rounds:1">＋</button></div>
      </div>
    </div>

    <button class="btn" id="start-session" ${!sel.length ? 'disabled' : ''}>▶ Start ${total ? total + '-minute' : ''} session${sel.length ? ` · ${sel.length * pf.rounds} blocks` : ''}</button>
    <p class="muted" style="text-align:center;margin-top:10px">Short and dense beats long and mushy — the forgetting between sessions is where the learning happens.</p>
  `;

  $$('[data-pick]', view).forEach((el) =>
    el.addEventListener('click', () => {
      const id = +el.dataset.pick;
      const i = state.setupSel.indexOf(id);
      if (i !== -1) state.setupSel.splice(i, 1);
      else if (state.setupSel.length < 3) state.setupSel.push(id);
      else return toast('Max 3 pieces — keep it dense');
      renderPractice();
    })
  );
  $$('[data-step]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const [key, d] = b.dataset.step.split(':');
      const p = prefs();
      p[key] = Math.max(key === 'rounds' ? 1 : 3, Math.min(key === 'rounds' ? 5 : 15, p[key] + Number(d)));
      savePrefs(p);
      renderPractice();
    })
  );
  $('#start-session')?.addEventListener('click', startSession);
}

function startSession() {
  const pf = prefs();
  const groups = new Map([[0, '🛠 Technique'], ...state.data.pieces.map((p) => [p.id, p.title])]);
  const order = state.setupSel.map((id) => ({ pieceId: id, title: groups.get(id) || 'Piece' }));
  const blocks = [];
  for (let r = 0; r < pf.rounds; r++) blocks.push(...order.map((o) => ({ ...o })));
  practice.session = {
    blocks,
    idx: 0,
    blockSecs: pf.blockMin * 60,
    endsAt: Date.now() + pf.blockMin * 60 * 1000,
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
      <div class="session-timer ${s.pausedLeft ? 'paused' : ''}" id="session-timer">--:--</div>
      <div class="progressbar"><div id="session-bar" style="width:0%"></div></div>
      <div class="session-controls">
        <button class="ctrl-btn" id="pause-btn">${s.pausedLeft ? '▶' : '⏸'}</button>
        <button class="ctrl-btn mic ${practice.listening ? 'live' : ''}" id="mic-btn">🎙️</button>
        <button class="ctrl-btn" id="skip-btn">⏭</button>
      </div>
      <p class="muted" style="text-align:center;margin:2px 0 6px" id="voice-status">${
        practice.listening ? 'Listening — just talk about what you\'re working on' : 'Tap the mic, then talk — "measures 30 to 34, that shift is really hard"'}</p>
      <div id="voice-feed"></div>
      <h3 style="margin:14px 0 8px">Work on these <span class="muted">(hardest first)</span></h3>
      <div id="block-spots"></div>
    </div>`;

  refreshBlockSpots();
  $('#end-session').addEventListener('click', () => endSession(false));
  $('#skip-btn').addEventListener('click', () => advanceBlock(true));
  $('#pause-btn').addEventListener('click', togglePause);
  $('#mic-btn').addEventListener('click', toggleListening);

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
    </div>
    ${rated ? '' : `<div class="rate-row">${[0, 1, 2, 3].map((r) => `<button class="rate-btn r${r}" data-rate="${r}" data-spot="${sp.id}">${RATING_LABELS[r]}</button>`).join('')}</div>`}
  </div>`;
}

function refreshBlockSpots() {
  const s = practice.session;
  const holder = $('#block-spots');
  if (!holder || !s) return;
  const spots = Scheduler.spotsForPiece(s.blocks[s.idx].pieceId);
  holder.innerHTML = spots.length ? spots.map((sp) => sessionSpotHtml(sp)).join('')
    : '<p class="muted">No spots for this piece yet — say one into the mic and it\'ll appear here.</p>';
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

  $('#add-piece').addEventListener('click', () => {
    openSheet(`<h3>Add piece</h3>
      <label class="field"><span class="lab">Title</span><input type="text" id="np-title" placeholder="Elgar Cello Concerto, mvt 1"></label>
      <label class="field"><span class="lab">Composer</span><input type="text" id="np-composer" placeholder="Edward Elgar"></label>
      <button class="btn" id="np-save">Add piece</button>`);
    $('#np-save').addEventListener('click', () => {
      const title = $('#np-title').value.trim();
      if (!title) return toast('Title is required');
      DB.addPiece({ title, composer: $('#np-composer').value.trim() });
      closeSheet(); toast('Piece added'); renderLibrary();
    });
  });
  $$('[data-piece]', body).forEach((el) =>
    el.addEventListener('click', () => openPieceSheet(+el.dataset.piece, data))
  );
}

function openPieceSheet(pieceId, data) {
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
    el.addEventListener('click', () => openSpotSheet(+el.dataset.spot, data))
  );
  $('#ps-add').addEventListener('click', () => openSpotSheet(null, data, pieceId));
  $('#ps-toggle')?.addEventListener('click', () => {
    DB.updatePiece(pieceId, { status: piece.status === 'active' ? 'paused' : 'active' });
    closeSheet(); renderLibrary();
  });
  $('#ps-del')?.addEventListener('click', () => {
    if (!confirm(`Delete "${piece.title}" and all its spots?`)) return;
    DB.deletePiece(pieceId);
    closeSheet(); toast('Piece deleted'); renderLibrary();
  });
}

function openSpotSheet(spotId, data, defaultPieceId = null) {
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
    closeSheet(); toast(spot ? 'Spot updated' : 'Spot added'); renderLibrary();
  });
  $('#sp-del')?.addEventListener('click', () => {
    DB.archiveSpot(spot.id);
    closeSheet(); toast('Spot archived'); renderLibrary();
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
