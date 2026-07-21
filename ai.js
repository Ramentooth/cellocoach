// CelloCoach AI layer — calls OpenAI directly from the browser with the
// user's own API key (stored only in this browser's localStorage, never in
// the published site code). No server involved.
'use strict';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

// ---------- context ----------

function practiceContext() {
  const pieces = DB.listPieces().filter((p) => p.status !== 'done');
  const spots = DB.listSpots();
  const t = DB.today();
  const reviews = JSON.parse(localStorage.getItem('cellocoach:store:v1') || '{}').reviews || [];
  const recent = [...reviews].sort((a, b) => b.id - a.id).slice(0, 20).map((r) => ({
    ...r, name: spots.find((s) => s.id === r.spot_id)?.name || `spot ${r.spot_id}`,
  }));

  const lines = [];
  lines.push(`Today: ${t}`);
  lines.push(`\nPIECES:`);
  for (const p of pieces) lines.push(`- [piece ${p.id}] ${p.title}${p.composer ? ' — ' + p.composer : ''} (${p.status})`);
  if (!pieces.length) lines.push('- (none yet)');
  lines.push(`\nPRACTICE SPOTS:`);
  for (const s of spots) {
    lines.push(
      `- [spot ${s.id}] "${s.name}" in ${s.piece_title || '(no piece)'} | ${s.kind} | status:${s.status} | due:${s.due_date} | reps:${s.reps} lapses:${s.lapses}${s.description ? ' | ' + s.description : ''}`
    );
  }
  if (!spots.length) lines.push('- (none yet)');
  if (recent.length) {
    lines.push(`\nRECENT RATINGS (newest first):`);
    for (const r of recent) lines.push(`- ${r.date} ${r.name}: ${['Again', 'Hard', 'Good', 'Easy'][r.rating]}`);
  }
  return lines.join('\n');
}

function systemPrompt() {
  return `You are CelloCoach, a warm, sharp practice coach for a cellist. You help them decide WHAT to practice using spaced repetition and interleaved, varied practice — so they don't just replay the easy parts.

Principles you apply:
- Struggling spots come first and get revisited often.
- Interleave: alternate pieces and skills instead of blocking one thing.
- Small, concrete spots ("mvt 1 mm. 32–40 shifts") beat vague goals ("work on Elgar").
- Push honest self-rating: Again / Hard / Good / Easy after each spot.
- Keep replies SHORT and phone-friendly: a few sentences or a tight list. Ask one question at a time.

You can EDIT the practice library. When the conversation calls for it, append ONE actions block at the very END of your reply, exactly in this form:

<actions>[{"type":"add_piece","title":"...","composer":"..."},{"type":"add_spot","piece":"<piece title or id>","name":"...","description":"...","kind":"spot|technique|warmup|etude","rating":0},{"type":"update_spot","id":123,"name":"...","description":"...","status":"new|learning|review|struggling|mastered"},{"type":"rate_spot","id":123,"rating":0},{"type":"archive_spot","id":123}]</actions>

Rules for actions: valid JSON array only, use real ids from the data below, never invent ids, omit the block entirely if nothing should change. The user confirms nothing — actions apply immediately — so only act when the user clearly wants it.

CURRENT PRACTICE DATA:
${practiceContext()}`;
}

// ---------- actions ----------

function extractActions(text) {
  const m = text.match(/<actions>([\s\S]*?)<\/actions>/);
  if (!m) return { clean: text.trim(), actions: [] };
  const clean = text.replace(m[0], '').trim();
  try {
    const parsed = JSON.parse(m[1]);
    return { clean, actions: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { clean, actions: [] };
  }
}

function applyActions(actions) {
  const applied = [];
  for (const a of actions) {
    try {
      if (a.type === 'add_piece' && a.title) {
        DB.addPiece({ title: a.title, composer: a.composer || '' });
        applied.push(`Added piece: ${a.title}`);
      } else if (a.type === 'add_spot' && a.name) {
        let piece = DB.resolvePiece(a.piece);
        if (!piece && a.piece && typeof a.piece === 'string') {
          piece = DB.addPiece({ title: a.piece });
          applied.push(`Added piece: ${a.piece}`);
        }
        const kind = ['spot', 'technique', 'warmup', 'etude'].includes(a.kind) ? a.kind : 'spot';
        const spot = DB.addSpot({ piece_id: piece ? piece.id : null, name: a.name, description: a.description || '', kind });
        applied.push(`Added spot: ${a.name}${piece ? ' (' + piece.title + ')' : ''}`);
        if (a.rating != null) {
          const rating = Math.max(0, Math.min(3, Number(a.rating)));
          Scheduler.rateSpot(spot.id, rating);
          applied.push(`Rated "${a.name}": ${['Again', 'Hard', 'Good', 'Easy'][rating]}`);
        }
      } else if (a.type === 'update_spot' && a.id) {
        const spot = DB.getSpot(Number(a.id));
        if (!spot) continue;
        const status = ['new', 'learning', 'review', 'struggling', 'mastered'].includes(a.status) ? a.status : spot.status;
        DB.updateSpot(spot.id, { name: a.name ?? spot.name, description: a.description ?? spot.description, status });
        applied.push(`Updated spot: ${a.name ?? spot.name}`);
      } else if (a.type === 'rate_spot' && a.id != null && a.rating != null) {
        const rating = Math.max(0, Math.min(3, Number(a.rating)));
        Scheduler.rateSpot(Number(a.id), rating);
        applied.push(`Rated spot ${a.id}: ${['Again', 'Hard', 'Good', 'Easy'][rating]}`);
      } else if (a.type === 'archive_spot' && a.id) {
        DB.archiveSpot(Number(a.id));
        applied.push(`Archived spot ${a.id}`);
      }
    } catch (e) {
      applied.push(`Failed action ${a.type}: ${e.message}`);
    }
  }
  return applied;
}

// ---------- OpenAI ----------

function requireKey() {
  const key = DB.getSettings().openai_key;
  if (!key) throw new Error('Add your OpenAI API key in Settings first.');
  return key;
}

async function streamChat(messages, onToken) {
  const s = DB.getSettings();
  const key = requireKey();
  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: s.chat_model || 'gpt-4o-mini', messages, stream: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    throw new Error(`OpenAI error ${res.status}: ${msg}`);
  }
  let full = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const tok = j.choices?.[0]?.delta?.content || '';
        if (tok) { full += tok; onToken(tok); }
      } catch { /* partial chunk */ }
    }
  }
  return full.trim();
}

async function complete(messages) {
  let full = '';
  await streamChat(messages, (t) => { full += t; });
  return full.trim();
}

// ---------- voice notes ----------

async function parseVoiceNote(pieceId, transcript) {
  const piece = pieceId ? DB.listPieces().find((p) => p.id === Number(pieceId)) : null;
  const spots = piece ? Scheduler.spotsForPiece(piece.id) : Scheduler.spotsForPiece(0);

  const prompt = `A cellist is mid-practice, hands busy, speaking notes out loud. Convert this spoken note into practice-library actions.

They are currently practicing: ${piece ? `"${piece.title}" (piece id ${piece.id})` : 'technique/warm-ups (no piece — omit the "piece" field)'}
Existing spots for this piece:
${spots.map((s) => `- [id ${s.id}] "${s.name}" status:${s.status}${s.description ? ' — ' + s.description : ''}`).join('\n') || '- (none yet)'}

SPOKEN NOTE (may have speech-recognition errors, e.g. "measure" heard as "major"):
"${transcript}"

Rules:
- New trouble spot described → {"type":"add_spot","piece":${piece ? piece.id : 'null'},"name":"<short, include measures if said>","description":"<what they said to work on>","kind":"spot"}. If they state difficulty, include "rating": 0 (really hard / can't do it), 1 (kinda hard / needs work), 2 (okay / getting better), 3 (easy / nailed it — barely needs practice).
- Note clearly refers to an EXISTING spot above → use its real id: rate it {"type":"rate_spot","id":N,"rating":0-3} if they judged how it went, and/or {"type":"update_spot","id":N,"description":"..."} if they added instructions.
- Never invent ids. If it's chit-chat with no actionable content, return an empty actions array.
- "say" = confirmation under 12 words, spoken back to them.

Respond with ONLY this JSON object, no prose:
{"actions":[...],"say":"..."}`;

  const raw = await complete([{ role: 'user', content: prompt }]);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Could not parse voice note');
  const parsed = JSON.parse(m[0]);
  const applied = applyActions(Array.isArray(parsed.actions) ? parsed.actions : []);
  return { applied, say: parsed.say || (applied.length ? 'Noted.' : 'Nothing to log.') };
}

// ---------- lesson extraction ----------

async function extractLessonSpots(lesson) {
  const prompt = `Below is a transcript/notes from a cello lesson. Extract every concrete practice assignment or trouble spot the teacher pointed out. Respond with ONLY a JSON array (no prose, no markdown fence), each element:
{"piece":"piece title or null","name":"short spot name with measures if given","description":"what to do / what the teacher said","kind":"spot|technique|warmup|etude"}

Existing pieces (reuse these exact titles when they match): ${DB.listPieces().filter((p) => p.status === 'active').map((p) => p.title).join(', ') || '(none)'}

TRANSCRIPT:
${lesson.transcript.slice(0, 24000)}`;
  const raw = await complete([{ role: 'user', content: prompt }]);
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Could not parse extraction result');
  const items = JSON.parse(m[0]);
  return items.filter((i) => i && i.name);
}

// ---------- transcription ----------

async function transcribeAudio(blob) {
  const key = requireKey();
  const form = new FormData();
  const ext = (blob.type || '').includes('webm') ? 'webm' : (blob.type || '').includes('wav') ? 'wav' : 'm4a';
  form.append('file', blob, `lesson.${ext}`);
  form.append('model', 'whisper-1');
  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    throw new Error(`Transcription failed (${res.status}): ${msg}`);
  }
  const j = await res.json();
  return j.text || '';
}

const AI = { systemPrompt, streamChat, complete, extractActions, applyActions, extractLessonSpots, transcribeAudio, parseVoiceNote };
