import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// Mirrors api/ai.js — reuses the same three env vars, no new Vercel config.
let initError = null;
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (e) {
    initError = e;
    console.error('Firebase Admin init failed:', e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// ── Date / time helpers ───────────────────────────────────────────────────────
function localDate(tzOffsetMin) {
  return new Date(Date.now() + (tzOffsetMin || 0) * 60000);
}
function localDateKey(tzOffsetMin) {
  const l = localDate(tzOffsetMin);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
}
function localHour(tzOffsetMin) { return localDate(tzOffsetMin).getUTCHours(); }
function localDow(tzOffsetMin) { return localDate(tzOffsetMin).getUTCDay(); } // 0=Sun..6=Sat
// ISO-ish week-of-month 1..4 (5th partial week reuses W1 via ((n-1)%4)).
function weekOfMonth(tzOffsetMin) {
  const l = localDate(tzOffsetMin);
  return ((Math.ceil(l.getUTCDate() / 7) - 1) % 4);
}
// YYYY-MM-DD in local tz for an arbitrary offset-days-ago.
function dateKeyDaysAgo(tzOffsetMin, daysAgo) {
  const l = new Date(Date.now() + (tzOffsetMin || 0) * 60000 - daysAgo * 86400000);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
}

// ── Habit completion logic (mirrors app's isFullDoneOn) ───────────────────────
// Uses the habit's CURRENT goalCount as a faithful approximation of goalCountAt().
function isFullDone(habit, dateKey) {
  const v = habit.log ? habit.log[dateKey] : undefined;
  if (v === 'freeze') return true;      // streak-freeze marker counts as done
  if (!v) return false;
  const gc = habit.goalCount || 0;
  if (gc > 0 && habit.goalUnit) return typeof v === 'number' && v >= gc;
  return !!v;
}

// ── Check-in notification ─────────────────────────────────────────────────────
// The one notification that reaches a CLOSED app. Content:
//   "Plan your tomorrow" + today's highlights (scheduled items, 🟢 done / 🔴 not
//   done). If the user hasn't shown up at all yet today, an encouraging line is
//   put on top of that same content. Pure calculation — no AI/API anywhere.
// A real OS push can't render coloured rows (the OS owns that chrome), so green/
// red is carried by the 🟢/🔴 markers here; the genuinely coloured neo-brutalism
// list lives in the in-app screen this notification opens (?tab=checkin).

// THE app-wide show-up rule (mirrors isShowUpDay() in index.html — keep the two in
// lockstep): a day is a show-up if AT LEAST ONE action was ticked done that day —
// a life action fully done, a goal action, or a one-off action. A streak-freeze
// marker is not a tick. Zero ticked = no show-up, and the encouraging note is added.
function showedUpToday(data, todayKey) {
  const habits = Array.isArray(data.habits) ? data.habits : [];
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const oneOffs = Array.isArray(data.standaloneActions) ? data.standaloneActions : [];
  if (habits.some(h => (h.log ? h.log[todayKey] : undefined) !== 'freeze' && isFullDone(h, todayKey))) return true;
  if (goals.some(g => (g.actions || []).some(a => a.doneAt === todayKey))) return true;
  return oneOffs.some(a => a.doneAt === todayKey);
}

// The live schedule on the server can lag one rollover behind the app: the app
// applies a "touched" Plan-Tomorrow draft the first time it opens on the new day
// (loadData). If the user hasn't opened the app yet today, mirror that here so
// the notification lists the schedule they actually planned.
function effectiveSlots(data, todayKey) {
  const draft = data.tomorrowDraft && typeof data.tomorrowDraft === 'object' ? data.tomorrowDraft : null;
  const useDraft = (data.scheduleDate || null) !== todayKey && draft && draft.date === todayKey && draft.touched;
  const assign = useDraft ? (draft.slotAssignments || {}) : null;
  return (prefix, id, own) => (assign ? (assign[prefix + id] || []) : (own || []));
}

// Today's scheduled items, earliest first: [{name, start, done}].
// Falls back to the plain list of life actions when nothing is time-boxed, so
// the notification is never empty for someone who simply doesn't schedule.
function todaysHighlights(data, todayKey) {
  const slotsOf = effectiveSlots(data, todayKey);
  const items = [];
  (Array.isArray(data.habits) ? data.habits : []).forEach(h => {
    const sl = slotsOf('h:', h.id, h.minuteSlots);
    if (sl.length) items.push({ name: h.name, start: Math.min(...sl), done: isFullDone(h, todayKey) });
  });
  (Array.isArray(data.goals) ? data.goals : []).forEach(g => {
    if (g.movedToHistory) return;
    (g.actions || []).forEach(a => {
      const sl = slotsOf('a:', a.id, a.minuteSlots);
      if (sl.length) items.push({ name: a.action || a.name, start: Math.min(...sl), done: a.doneAt === todayKey });
    });
  });
  (Array.isArray(data.standaloneActions) ? data.standaloneActions : []).forEach(a => {
    const sl = slotsOf('s:', a.id, a.minuteSlots);
    if (sl.length) items.push({ name: a.name || a.action, start: Math.min(...sl), done: a.doneAt === todayKey });
  });
  items.sort((a, b) => a.start - b.start);
  if (items.length) return { items, scheduled: true };
  const habits = (Array.isArray(data.habits) ? data.habits : []).map(h => ({ name: h.name, start: null, done: isFullDone(h, todayKey) }));
  return { items: habits, scheduled: false };
}

// Shown ONLY when there's been no show-up yet at check-in time. One per day,
// rotated by date so it doesn't read the same two days running.
const NO_SHOWUP_NOTES = [
  "You haven't shown up yet today — one small action still counts.",
  "Today's still open. Do one thing, even a small one, and you've shown up.",
  "No show-up yet today. A single action keeps your journey moving.",
  "There's still time today — one tiny win and the day counts.",
];

const MAX_LINES = 5;
function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }

function buildCheckin(data, tzOffsetMin) {
  const todayKey = localDateKey(tzOffsetMin);
  const daySeed = parseInt(todayKey.replace(/-/g, ''), 10);
  const showedUp = showedUpToday(data, todayKey);
  const { items, scheduled } = todaysHighlights(data, todayKey);

  const lines = [];
  if (!showedUp) lines.push(pick(NO_SHOWUP_NOTES, daySeed));
  lines.push('🗓️ Plan your tomorrow');
  if (items.length) {
    lines.push(scheduled ? "Today's highlights:" : 'Your life actions today:');
    items.slice(0, MAX_LINES).forEach(it => lines.push((it.done ? '🟢 ' : '🔴 ') + clip(it.name, 30)));
    if (items.length > MAX_LINES) lines.push('+' + (items.length - MAX_LINES) + ' more');
  } else {
    lines.push('Set tomorrow\'s time boxes in a minute.');
  }
  return { title: 'Habtix', body: lines.join('\n'), variantKey: showedUp ? 'showedup' : 'noshowup' };
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  const ok = secret && (auth === `Bearer ${secret}` || headerSecret === secret);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  if (initError || !db) return res.status(500).json({ error: 'Firebase Admin init failed' });

  let sent = 0, skipped = 0, failed = 0, checked = 0;
  try {
    const snap = await db.collection('users').where('notifEnabled', '==', true).get();
    const sends = [];
    snap.forEach(docSnap => {
      const data = docSnap.data() || {};
      checked++;
      const token = data.fcmToken;
      if (!token) { skipped++; return; }

      // The check-in is compulsory for every tier (not gated by notifPrefs).

      const tzOffsetMin = typeof data.tzOffsetMin === 'number' ? data.tzOffsetMin : 330;
      const checkInHour = typeof data.checkInHour === 'number' ? data.checkInHour : 20;
      if (localHour(tzOffsetMin) !== checkInHour) { skipped++; return; }

      const todayKey = localDateKey(tzOffsetMin);
      if (data.lastPushDate === todayKey) { skipped++; return; }

      const msg = buildCheckin(data, tzOffsetMin);
      sends.push({ ref: docSnap.ref, token, msg, todayKey });
    });

    for (const s of sends) {
      try {
        await admin.messaging().send({
          token: s.token,
          data: {
            title: s.msg.title,
            body: s.msg.body,
            url: '/?tab=checkin',
            tag: 'momentum_daily_' + s.todayKey,
          },
          webpush: { headers: { Urgency: 'high', TTL: '3600' }, fcmOptions: { link: '/?tab=checkin' } },
        });
        // Stamp de-dupe + remember the variant so we can avoid repeats later.
        await s.ref.update({ lastPushDate: s.todayKey, lastCheckInVariant: s.msg.variantKey }).catch(() => {});
        sent++;
      } catch (e) {
        failed++;
        const code = e?.errorInfo?.code || e?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          await s.ref.update({ fcmToken: admin.firestore.FieldValue.delete(), notifEnabled: false }).catch(() => {});
        } else {
          console.warn('Push send failed:', code || e.message);
        }
      }
    }
    return res.status(200).json({ ok: true, checked, sent, skipped, failed });
  } catch (e) {
    console.error('push cron error:', e.message);
    return res.status(500).json({ error: 'Cron failed', detail: e.message });
  }
}
