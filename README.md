# CelloCoach 🎻

A personal, hands-free practice coach for cello. It runs your practice session for you — timer-driven blocks that rotate between up to 3 pieces, spaced repetition so struggling spots come back sooner, and voice notes so you can log trouble spots by just talking while you play instead of typing.

**Fully static** — no server, no database to run. Hosted on GitHub Pages. AI runs through the OpenAI API using your own key, called directly from your browser.

## Using it

Open the GitHub Pages URL in Safari or Chrome (phone or desktop), then Share → **Add to Home Screen** on iPhone for an app-like icon. Add your OpenAI API key in **Settings** — nothing works without it (chat, voice-note parsing, lesson extraction, and audio transcription all call `api.openai.com` directly from your browser with that key).

### Your data lives in your browser, not in the cloud

There is no backend. Pieces, spots, ratings, chat history, and lesson notes are stored in this browser's `localStorage`; recordings and lesson audio are stored in this browser's IndexedDB. That means:

- Your practice data is **private** — it's never sent anywhere except OpenAI (for AI features) and never touches GitHub.
- It does **not sync** between devices. Your Mac browser and your phone's browser each keep their own separate copy.
- Clearing site data/history for this page wipes it. **Use Settings → Backup → Export** periodically, and Import on another device to move data over.
- Your OpenAI key is stored the same way — only in this browser, only sent to OpenAI.

## How it works

- **Practice tab** — pick up to 3 pieces (or let it pre-pick based on what's struggling/due), set minutes-per-block (default 7) and rounds, tap Start. It rotates through your pieces block by block with a big countdown, and **chimes + speaks the next piece name out loud** when it's time to switch — no need to look at the phone.
- **Voice notes** — tap the mic once at the start of a block and just talk while you play: *"measures 30 to 34, that shift is really hard."* Speech recognition transcribes it, the AI turns it into a practice spot on whatever piece that block belongs to, rates its difficulty from how you described it, and speaks back a short confirmation. No typing.
- **Spaced repetition** — spots are rated Again / Hard / Good / Easy (modified SM-2, capped at 21 days since motor skills decay faster than flashcard facts). Within a block, spots for that piece show hardest-first — easy ones naturally fall out of rotation.
- **Coach tab** — a chat that sees your pieces, spots, due dates, and recent ratings, and can edit your library directly from conversation (add pieces/spots, rate/update spots) — shown as ✓ chips.
- **Lessons** — paste a transcript or upload lesson audio (transcribed via Whisper), then extract the assignments your teacher gave as ready-to-add spots.
- **Record** — tap once, leave it running while you practice, tap to stop; stored locally, playback in the same tab.

## Local development

No build step, no dependencies. Serve the folder statically and open it:

```bash
python3 -m http.server 4747
```

Visit `http://localhost:4747`. `localhost` is treated as a secure context by browsers, so the microphone works without HTTPS locally.

## Layout

```
index.html      shell + tab bar
style.css       iPhone-styled dark UI
db.js           client-side storage: localStorage (structured data) + IndexedDB (audio blobs)
scheduler.js    SM-2 rating logic + hardest-first spot ordering
ai.js           OpenAI chat streaming, coach prompt, voice-note & lesson parsing, transcription
app.js          all UI: Practice / Coach / Record / Library / Settings
```

## Iteration ideas (v3+)

- Cross-device sync (a small serverless function or a sync service) instead of manual export/import
- Auto-transcribe practice recordings and let the coach comment on them
- Weekly progress review chat ("what improved, what's stuck")
- Intonation/tempo analysis of recordings
- Push the day's plan as a notification
