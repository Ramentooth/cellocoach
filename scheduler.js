// Spaced-repetition rating logic — modified SM-2, capped at 21 days since
// motor skills decay faster than flashcard facts. Operates on DB.getSpot's
// plain object and persists via DB.updateSpot.
'use strict';

const MAX_INTERVAL = 21;

function rateSpot(spotId, rating) {
  const spot = DB.getSpot(spotId);
  if (!spot) throw new Error(`No spot with id ${spotId}`);
  let { ease, interval_days: interval, reps, lapses, status } = spot;

  if (rating === 0) {
    lapses += 1;
    reps = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
    status = 'struggling';
  } else if (rating === 1) {
    reps += 1;
    interval = Math.max(1, Math.round(interval * 1.2) || 1);
    ease = Math.max(1.3, ease - 0.05);
    if (status === 'struggling' || status === 'new') status = 'learning';
  } else if (rating === 2) {
    reps += 1;
    if (interval < 1) interval = 1;
    else if (interval < 2) interval = 2;
    else interval = Math.round(interval * ease);
    status = reps >= 3 && interval >= 4 ? 'review' : 'learning';
  } else {
    reps += 1;
    interval = Math.max(3, Math.round((interval || 1) * ease * 1.3));
    ease = Math.min(2.5, ease + 0.05);
    status = reps >= 2 ? 'review' : 'learning';
  }

  interval = Math.min(MAX_INTERVAL, interval);
  const due_date = DB.localDate(interval);
  const updated = DB.updateSpot(spot.id, { ease, interval_days: interval, reps, lapses, status, due_date, last_rating: rating });
  DB.addReview({ spot_id: spot.id, rating, interval_after: interval });
  return updated;
}

// Priority within a practice block: struggling/new/overdue first.
function spotPriority(s) {
  const w = { struggling: 30, new: 20, learning: 10, review: 0 }[s.status] ?? 0;
  const overdue = s.due_date <= DB.today() ? 5 : 0;
  return w + overdue + Math.min(5, s.lapses);
}
function spotsForPiece(pieceId) {
  return DB.listSpots()
    .filter((s) => (s.piece_id ?? 0) === pieceId && s.status !== 'mastered')
    .sort((a, b) => spotPriority(b) - spotPriority(a));
}

const Scheduler = { rateSpot, spotPriority, spotsForPiece, MAX_INTERVAL };
