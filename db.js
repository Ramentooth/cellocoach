// CelloCoach client-side storage. Runs entirely in the browser (GitHub Pages
// has no backend): structured data lives in one localStorage JSON document;
// audio blobs (recordings, lesson audio) live in IndexedDB.
'use strict';

const STORE_KEY = 'cellocoach:store:v1';
const MEDIA_DB_NAME = 'cellocoach-media';

function defaultStore() {
  return {
    settings: { openai_key: '', chat_model: 'gpt-4o-mini', daily_minutes: 60, block_min: 7, rounds: 2 },
    pieces: [],
    spots: [],
    reviews: [],
    practice_log: [],
    conversations: [],
    messages: [],
    lessons: [],
    next_id: { piece: 1, spot: 1, review: 1, log: 1, conversation: 1, message: 1, lesson: 1, recording: 1 },
  };
}

let _store = null;

function load() {
  if (_store) return _store;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    _store = raw ? { ...defaultStore(), ...JSON.parse(raw) } : seedFirstRun();
  } catch {
    _store = seedFirstRun();
  }
  if (!localStorage.getItem(STORE_KEY)) save();
  return _store;
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(_store));
}

function nextId(kind) {
  const id = _store.next_id[kind]++;
  save();
  return id;
}

// First-run seed: carries over Simon's real pieces from the old localhost
// version so the hosted app doesn't start completely empty.
function seedFirstRun() {
  const s = defaultStore();
  for (const title of ['The Eccles Sonata', 'Sicilienne', 'Gavotte']) {
    s.pieces.push({ id: s.next_id.piece++, title, composer: '', status: 'active', created_at: new Date().toISOString() });
  }
  return s;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- settings ----------

function getSettings() { return { ...load().settings }; }
function setSettings(patch) {
  Object.assign(load().settings, patch);
  save();
  return getSettings();
}

// ---------- pieces ----------

function listPieces() { return [...load().pieces].sort((a, b) => (b.status === 'active') - (a.status === 'active') || b.id - a.id); }
function addPiece({ title, composer = '' }) {
  const s = load();
  const p = { id: nextId('piece'), title, composer, status: 'active', created_at: new Date().toISOString() };
  s.pieces.push(p);
  save();
  return p;
}
function updatePiece(id, patch) {
  const p = load().pieces.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  save();
  return p;
}
function deletePiece(id) {
  const s = load();
  s.pieces = s.pieces.filter((p) => p.id !== id);
  s.spots = s.spots.filter((sp) => sp.piece_id !== id);
  save();
}
function resolvePiece(ref) {
  if (ref == null) return null;
  const s = load();
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return s.pieces.find((p) => p.id === Number(ref)) || null;
  const lower = String(ref).toLowerCase();
  return s.pieces.find((p) => p.title.toLowerCase() === lower) || s.pieces.find((p) => p.title.toLowerCase().includes(lower)) || null;
}

// ---------- spots ----------

function listSpots() {
  const s = load();
  return s.spots
    .filter((sp) => !sp.archived)
    .map((sp) => ({ ...sp, piece_title: s.pieces.find((p) => p.id === sp.piece_id)?.title || '' }));
}
function addSpot({ piece_id = null, name, description = '', kind = 'spot', methods = '' }) {
  const s = load();
  const sp = {
    // `methods` is how you practise this spot (slow with drones, dotted rhythms, …) as
    // opposed to `description`, which is what's wrong with it. Older spots have no
    // methods key at all; every reader coalesces to '' rather than migrating the save.
    id: nextId('spot'), piece_id, name, description, methods, kind, status: 'new',
    ease: 1.8, interval_days: 0, due_date: today(), reps: 0, lapses: 0,
    last_rating: null, archived: 0, created_at: new Date().toISOString(),
  };
  s.spots.push(sp);
  save();
  return sp;
}
function updateSpot(id, patch) {
  const sp = load().spots.find((x) => x.id === id);
  if (!sp) return null;
  Object.assign(sp, patch);
  save();
  return sp;
}
function archiveSpot(id) { return updateSpot(id, { archived: 1 }); }
function getSpot(id) { return load().spots.find((x) => x.id === id) || null; }

// ---------- conversations / messages ----------

function listConversations() { return [...load().conversations].sort((a, b) => b.id - a.id); }
function updateConversation(id, patch) {
  const c = load().conversations.find((x) => x.id === id);
  if (!c) return null;
  Object.assign(c, patch);
  save();
  return c;
}
function createConversation(title = 'New chat') {
  const s = load();
  const c = { id: nextId('conversation'), title, created_at: new Date().toISOString() };
  s.conversations.push(c);
  save();
  return c;
}
function deleteConversation(id) {
  const s = load();
  s.conversations = s.conversations.filter((c) => c.id !== id);
  s.messages = s.messages.filter((m) => m.conversation_id !== id);
  save();
}
function listMessages(conversationId) {
  return load().messages.filter((m) => m.conversation_id === conversationId).sort((a, b) => a.id - b.id);
}
function addMessage(conversationId, role, content, actions = null) {
  const s = load();
  const m = { id: nextId('message'), conversation_id: conversationId, role, content, actions, created_at: new Date().toISOString() };
  s.messages.push(m);
  save();
  return m;
}

// ---------- lessons ----------

function listLessons() { return [...load().lessons].sort((a, b) => b.id - a.id); }
function addLesson({ title = 'Lesson', date = today(), transcript = '', audio_blob_id = null }) {
  const s = load();
  const l = { id: nextId('lesson'), title, date, transcript, audio_blob_id, extracted: null, created_at: new Date().toISOString() };
  s.lessons.push(l);
  save();
  return l;
}
function updateLesson(id, patch) {
  const l = load().lessons.find((x) => x.id === id);
  if (!l) return null;
  Object.assign(l, patch);
  save();
  return l;
}
function deleteLesson(id) {
  const s = load();
  const l = s.lessons.find((x) => x.id === id);
  s.lessons = s.lessons.filter((x) => x.id !== id);
  save();
  if (l?.audio_blob_id) deleteBlob(l.audio_blob_id).catch(() => {});
}
function getLesson(id) { return load().lessons.find((x) => x.id === id) || null; }

// ---------- reviews ----------

function addReview({ spot_id, rating, interval_after }) {
  const s = load();
  const r = { id: nextId('review'), spot_id, date: today(), rating, interval_after };
  s.reviews.push(r);
  save();
  return r;
}

// ---------- practice log ----------

function addPracticeLog(detail) {
  const s = load();
  s.practice_log.push({ id: nextId('log'), date: today(), created_at: new Date().toISOString(), ...detail });
  save();
}
function stats() {
  const s = load();
  const byDate = {};
  for (const r of s.reviews) (byDate[r.date] ||= []).push(r);
  let streak = 0;
  let offset = byDate[localDate(0)] ? 0 : -1;
  while (byDate[localDate(offset)]) { streak += 1; offset -= 1; }
  const struggling = s.spots.filter((sp) => sp.status === 'struggling' && !sp.archived).length;
  return { streak, struggling };
}

// ---------- IndexedDB blob storage (recordings + lesson audio) ----------

function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MEDIA_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveBlob(blob, meta = {}) {
  const id = nextId('recording');
  const idb = await openMediaDB();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ id, blob, created_at: new Date().toISOString(), ...meta });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return id;
}
async function getBlob(id) {
  const idb = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function listBlobMeta() {
  const idb = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').getAll();
    req.onsuccess = () => resolve((req.result || []).map(({ blob, ...meta }) => meta));
    req.onerror = () => reject(req.error);
  });
}
async function deleteBlob(id) {
  const idb = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- backup export / import ----------

function exportBackup() {
  return JSON.stringify(load(), null, 2);
}
function importBackup(json) {
  const parsed = JSON.parse(json);
  _store = { ...defaultStore(), ...parsed };
  save();
}

const DB = {
  today, localDate, getSettings, setSettings,
  listPieces, addPiece, updatePiece, deletePiece, resolvePiece,
  listSpots, addSpot, updateSpot, archiveSpot, getSpot, addReview,
  listConversations, createConversation, updateConversation, deleteConversation, listMessages, addMessage,
  listLessons, addLesson, updateLesson, deleteLesson, getLesson,
  addPracticeLog, stats,
  saveBlob, getBlob, listBlobMeta, deleteBlob,
  exportBackup, importBackup,
};
