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

// Recompute the TRUE current streak from the log — never trust the stored
// habit.streak, which only updates when the user interacts with the app and is
// stale for anyone who's been away. This is what prevents "9-day streak!" when
// the streak actually broke days ago.
function trueStreak(habit, tzOffsetMin) {
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    if (isFullDone(habit, dateKeyDaysAgo(tzOffsetMin, i))) streak++;
    else break;
  }
  return streak;
}

// Was there ANY habit activity in the last N days? (for dormant/broken split)
function activeWithin(habits, tzOffsetMin, days) {
  for (let i = 0; i < days; i++) {
    const key = dateKeyDaysAgo(tzOffsetMin, i);
    for (const h of habits) {
      const v = h.log ? h.log[key] : undefined;
      if (v) return true;
    }
  }
  return false;
}

// ── State classification ──────────────────────────────────────────────────────
// Returns { state, maxStreak, undoneCount, allDone, habitCount }
function classify(data, tzOffsetMin) {
  const habits = Array.isArray(data.habits) ? data.habits : [];
  const todayKey = localDateKey(tzOffsetMin);
  const habitCount = habits.length;

  const maxStreak = habits.reduce((m, h) => Math.max(m, trueStreak(h, tzOffsetMin)), 0);
  const undone = habits.filter(h => !isFullDone(h, todayKey));
  const undoneCount = undone.length;
  const allDone = habitCount > 0 && undoneCount === 0;

  let state;
  if (habitCount === 0) {
    state = 'building';                         // no habits yet → gentle setup nudge
  } else if (!activeWithin(habits, tzOffsetMin, 3)) {
    state = 'dormant';                          // gone 3+ days → comeback
  } else if (maxStreak === 0) {
    state = 'broken';                           // active recently but streak lapsed
  } else if (maxStreak < 3) {
    state = 'building';                         // early momentum
  } else {
    state = 'thriving';                         // real streak
  }
  return { state, maxStreak, undoneCount, allDone, habitCount };
}

// ── Message library ────────────────────────────────────────────────────────────
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Thriving: [dow][week 0..3]. {name}{streak}{undone}{score} filled later.
const THRIVING = {
  mon: [
    "⚡ New week, {name}. Your {streak}-day streak is waiting. What's one win you'll lock in today?",
    "⚡ Fresh week, fresh momentum. {streak} days strong — let's add one more.",
    "⚡ Monday reset, {name}. The streak's at {streak}. Time to build on it.",
    "⚡ New week starts now. {streak} days behind you — what's next?",
  ],
  tue: [
    "🔥 {name}, you're {streak} days deep. Consistency is quietly compounding — keep rolling.",
    "🔥 {streak} days and counting. Every rep stacks. Don't break the chain today.",
    "🔥 Momentum's building, {name} — {streak} days in. Keep feeding it.",
    "🔥 You've shown up {streak} days straight. That's not luck, that's you.",
  ],
  wed: [
    "📊 Midweek check-in. {undone} habits left today. Small steps now beat regrets later.",
    "📊 Halfway through the week, {name}. {undone} to go today — you've got this.",
    "📊 Wednesday pulse-check: {undone} habits pending. Knock one out now?",
    "📊 Midweek, {name}. Momentum at {score}. Steady wins the week.",
  ],
  thu: [
    "💪 Almost through the week, {name}. Your future self is thanking you for showing up.",
    "💪 Thursday grind. {streak} days proves you can do hard things. Keep going.",
    "💪 You're closer than you think, {name}. One more strong day.",
    "💪 Showing up on the tired days is what makes you different. Proud of you.",
  ],
  fri: [
    "🎯 Friday. Don't let the streak slip before the weekend — {undone} to go.",
    "🎯 Finish the week strong, {name}. {undone} habits between you and a clean week.",
    "🎯 It's Friday — {streak} days deep. End the week on a high.",
    "🎯 Last push of the workweek, {name}. Make it count.",
  ],
  sat: [
    "🌤️ Weekend, {name}. Even one small habit today keeps momentum alive.",
    "🌤️ Saturday. No pressure — just don't ghost your streak. 🔥",
    "🌤️ Relax, {name}, but keep the chain going. One habit's enough today.",
    "🌤️ Weekends count too. A little today beats zero.",
  ],
  sun: [
    "🧘 Sunday reset. Momentum at {score}. Ready to set up a strong week?",
    "🧘 Week's winding down, {name}. Look back proud, look ahead ready.",
    "🧘 Sunday reflection: {streak} days this run. What's next week's focus?",
    "🧘 Rest and reset, {name}. Tomorrow, we build again.",
  ],
};
const THRIVING_FALLBACK = {
  mon: "⚡ New week, fresh momentum. Let's make today count, {name}.",
  tue: "🔥 Keep building, {name}. Every day stacks.",
  wed: "📊 Midweek check-in, {name}. How's today shaping up?",
  thu: "💪 Keep showing up, {name}. It's working.",
  fri: "🎯 Finish strong, {name}. The weekend's earned.",
  sat: "🌤️ Keep it light today, {name} — but keep it going.",
  sun: "🧘 Sunday reset, {name}. Ready for a fresh week?",
};
// Thriving + all habits already done today (no {undone} contradiction).
const ALLDONE = {
  mon: "✅ Monday done and dusted, {name}. {streak}-day streak alive. Strong start.",
  tue: "✅ All done today — {streak} days now. You're making this look easy, {name}.",
  wed: "✅ Midweek and everything's checked off. {streak} days. Unstoppable.",
  thu: "✅ Perfect Thursday, {name}. Streak's at {streak}. Coast into the weekend.",
  fri: "✅ Week sealed — all habits done. {streak} days. Enjoy that weekend, {name}.",
  sat: "✅ Even on Saturday you showed up. {streak} days. Respect, {name}.",
  sun: "✅ Full week, fully done. {streak} days and counting. Proud of you, {name}.",
};
const BUILDING = [
  "⚡ Every streak starts with day one, {name}. Keep it going today.",
  "🌱 Small start, big potential. One more habit today keeps it rolling.",
  "💫 You're just getting started, {name} — and that's the hardest part. Keep going.",
  "🔨 Momentum's built one day at a time. Lay another brick today.",
  "🌤️ Early days, {name} — this is exactly when consistency counts most.",
  "✨ Two days beats one. One beats zero. Just add today.",
  "🎯 Consistency is a muscle, {name}. Today's a rep. Let's go.",
];
const RECOVERY = [
  "🤗 Streaks break — that's normal, {name}. What matters is the restart. Today?",
  "💛 Yesterday's gone. Today's a fresh streak waiting. Let's go, {name}.",
  "🌅 Every comeback starts with a single day. This is it, {name}.",
  "🌱 A broken streak isn't a broken habit. Pick one thing, restart today.",
  "💪 The best don't never fall — they just get back up faster. Your turn, {name}.",
  "✨ Slate's clean, {name}. New streak, day one, starts whenever you're ready.",
  "🔄 Reset, not regret. One habit today and you're back in motion.",
];
// Dormant → warm comeback (separate from recovery; user's been gone 3+ days).
const COMEBACK = [
  "🤗 Missed you, {name}. Your habits are right where you left them — one gets you rolling again.",
  "🌅 Welcome back, {name}. Today's a perfect day to restart. One small habit?",
  "💛 It's been a few days, {name}. No guilt — just a fresh page. Let's begin again.",
];

// ── Mo pose map — verified against the actual /mo/ asset library (50 poses).
// The original stub used mo-presentation.png / mo-warm.png / mo-urgent.png, none of
// which exist — every push notification icon was 404ing silently. Remapped to real
// files matching each state's intent.
const MO_POSE = {
  thriving: '/mo/mo-presenting.png',
  building: '/mo/mo-thumbs-up.png',
  broken: '/mo/mo-concerned.png',
  dormant: '/mo/mo-comeback.png',
  alldone: '/mo/mo-proud.png',
  atrisk: '/mo/mo-clock.png',
};
const DEFAULT_ICON = '/icon-192.png';

// ── Message selection ──────────────────────────────────────────────────────────
function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }

function fill(tpl, ctx) {
  let s = tpl;
  // Name: if missing, gracefully strip ", {name}" / "{name}, " / "{name}".
  if (ctx.name) {
    s = s.replace(/\{name\}/g, ctx.name);
  } else {
    s = s.replace(/,?\s*\{name\}/g, '').replace(/\{name\}/g, '');
  }
  s = s.replace(/\{streak\}/g, ctx.streak != null ? ctx.streak : '')
       .replace(/\{undone\}/g, ctx.undone != null ? ctx.undone : '')
       .replace(/\{score\}/g, ctx.score != null ? ctx.score : '');
  // Tidy any doubled spaces / stray leading punctuation from stripped tokens.
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.!?])/g, '$1').trim();
}

// Builds the final {title, body, pose, variantKey}. Handles priorities-fold.
function buildCheckin(data, tzOffsetMin) {
  const cls = classify(data, tzOffsetMin);
  const dow = DOW[localDow(tzOffsetMin)];
  const wk = weekOfMonth(tzOffsetMin);
  const name = (data.displayName || '').trim().split(' ')[0] || '';
  const score = typeof data.momentumScore === 'number' ? data.momentumScore : null;
  const daySeed = parseInt(localDateKey(tzOffsetMin).replace(/-/g, ''), 10);
  const ctx = { name, streak: cls.maxStreak, undone: cls.undoneCount, score };

  // Streak-at-risk OVERRIDE: real streak, still undone, late in their day (>=17h local).
  const late = localHour(tzOffsetMin) >= 17;
  if (cls.state === 'thriving' && !cls.allDone && cls.maxStreak >= 3 && late) {
    return {
      title: '⚡ Habtix',
      body: fill("🔥 {name}, your {streak}-day streak is on the line — {undone} left before the day ends.", ctx),
      pose: MO_POSE.atrisk, variantKey: 'atrisk',
    };
  }

  let body, variantKey, pose;
  if (cls.state === 'dormant') {
    body = fill(pick(COMEBACK, daySeed), ctx); variantKey = 'comeback'; pose = MO_POSE.dormant;
  } else if (cls.state === 'broken') {
    body = fill(pick(RECOVERY, daySeed), ctx); variantKey = 'recovery'; pose = MO_POSE.broken;
  } else if (cls.state === 'building') {
    body = fill(pick(BUILDING, daySeed), ctx); variantKey = 'building'; pose = MO_POSE.building;
  } else { // thriving
    if (cls.allDone) {
      body = fill(ALLDONE[dow] || THRIVING_FALLBACK[dow], ctx); variantKey = 'alldone_' + dow; pose = MO_POSE.alldone;
    } else {
      let tpl = THRIVING[dow][wk];
      // If the chosen message needs {undone} but there are 0 undone, or needs
      // {score} with no score, fall back to that day's safe fallback line.
      const needsUndone = /\{undone\}/.test(tpl) && cls.undoneCount === 0;
      const needsScore = /\{score\}/.test(tpl) && score == null;
      if (needsUndone || needsScore) tpl = THRIVING_FALLBACK[dow];
      body = fill(tpl, ctx); variantKey = 'thriving_' + dow + '_w' + wk; pose = MO_POSE.thriving;
    }
  }

  // Priorities-fold: if check-in hour ∈ [5,10] and habits are pending, append a
  // short priorities line (first pending habit) so the morning push does double duty.
  if (cls.state !== 'dormant' && cls.undoneCount > 0) {
    const ch = typeof data.checkInHour === 'number' ? data.checkInHour : 20;
    if (ch >= 5 && ch <= 10) {
      const habits = Array.isArray(data.habits) ? data.habits : [];
      const todayKey = localDateKey(tzOffsetMin);
      const firstPending = habits.find(h => !isFullDone(h, todayKey));
      if (firstPending && firstPending.name) {
        body += ` First up: ${firstPending.icon ? firstPending.icon + ' ' : ''}${firstPending.name}.`;
      }
    }
  }

  return { title: '⚡ Habtix', body, pose, variantKey };
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

      // notifPrefs: check-in is compulsory, but respect an explicit false for it
      // only if the user is Pro/Plus (Free cannot disable). Check-in default = on.
      // (Per spec §9, check-in is compulsory for ALL tiers — so we do NOT gate it.)

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
            url: '/?tab=dashboard',
            icon: s.msg.pose || DEFAULT_ICON,
            tag: 'momentum_daily_' + s.todayKey,
          },
          webpush: { headers: { Urgency: 'high', TTL: '3600' }, fcmOptions: { link: '/?tab=dashboard' } },
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
