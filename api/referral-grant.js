import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// Mirrors api/ai.js and api/push.js exactly — same three env vars, no new
// Vercel config needed since they're already set up for those endpoints.
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

// ── In-memory rate limiter ────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
function isRateLimited(uid) {
  const now = Date.now();
  const entry = rateLimitMap.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(uid, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(uid, entry);
  return false;
}

// ── Referral tier logic — updated ladder: 1→5d, 2→10d, 3→15d, 4→20d, 5→30d,
// capped at 30 regardless of how many referrals past 5. Ported exactly from
// index.html's REFERRAL_TIERS / referralEntitledDays / computeReferralGrant —
// if the tiers ever change, update both places. ──────────────────────────────
const REFERRAL_TIERS = [{ count: 1, days: 5 }, { count: 2, days: 10 }, { count: 3, days: 15 }, { count: 4, days: 20 }, { count: 5, days: 30 }];
const REFERRAL_LIFETIME_CAP_DAYS = 30;
// One-time bonus for the person who redeems someone else's code — separate
// from the referrer's own ladder above, granted once, the moment they redeem.
const NEW_USER_BONUS_DAYS = 5;

function referralEntitledDays(referralCount) {
  let entitled = 0;
  REFERRAL_TIERS.forEach(tier => { if (referralCount >= tier.count) entitled = tier.days; });
  return Math.min(REFERRAL_LIFETIME_CAP_DAYS, entitled);
}

function computeReferralGrant(currentPlan, currentExpiry, alreadyGranted, referralCount) {
  if (currentPlan === 'plus') return null;
  const entitled = referralEntitledDays(referralCount);
  const delta = entitled - (alreadyGranted || 0);
  if (delta <= 0) return null;
  const now = new Date();
  const curExp = currentExpiry ? new Date(currentExpiry) : null;
  const base = (curExp && curExp > now) ? curExp : now;
  const newExpiry = new Date(base.getTime() + delta * 86400000);
  return { plan: 'pro', planExpiry: newExpiry.toISOString(), referralBonusDaysGranted: entitled };
}

// Grants (or extends) NEW_USER_BONUS_DAYS of Pro on top of whatever plan/expiry
// a user already has — same "never reduces existing time" shape as the
// referrer-side grant above, just a flat one-time amount instead of a tier.
function computeNewUserBonus(currentPlan, currentExpiry) {
  const now = new Date();
  const curExp = currentExpiry ? new Date(currentExpiry) : null;
  const base = (curExp && curExp > now) ? curExp : now;
  const newExpiry = new Date(base.getTime() + NEW_USER_BONUS_DAYS * 86400000);
  return { plan: 'pro', planExpiry: newExpiry.toISOString() };
}

// Recomputes and applies a referrer-side grant for a given uid, based on their
// live referral count. Shared by both the passive (no code) path and the
// redemption path, so a referrer's reward always uses the exact same logic
// regardless of which path triggered it.
async function refreshReferrerGrant(uid) {
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return { referralCount: 0, granted: false };
  const d = userSnap.data();

  const refSnap = await db.collection('users')
    .where('referredBy', '==', uid)
    .where('onboardingCompleted', '==', true)
    .get();
  const referralCount = refSnap.size;

  const now = new Date();
  const rawPlan = d.plan || 'free';
  const rawExpiry = d.planExpiry || null;
  const isExpired = rawExpiry && new Date(rawExpiry) < now;
  const isLegacyEarly = rawPlan === 'early_access';
  const basePlan = (isExpired || isLegacyEarly) ? 'free' : rawPlan;
  const baseExpiry = (isExpired || isLegacyEarly) ? null : rawExpiry;

  const grant = computeReferralGrant(basePlan, baseExpiry, d.referralBonusDaysGranted || 0, referralCount);

  let finalWrite = null;
  if (isExpired || isLegacyEarly) finalWrite = { plan: 'free', planExpiry: null };
  if (grant) finalWrite = { ...(finalWrite || {}), ...grant };

  if (finalWrite) await userRef.set(finalWrite, { merge: true });

  return {
    referralCount,
    plan: finalWrite?.plan || basePlan,
    planExpiry: finalWrite?.planExpiry !== undefined ? finalWrite.planExpiry : baseExpiry,
    granted: finalWrite ? true : false,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (initError || !db) {
      console.error('Firebase Admin unavailable:', initError?.message);
      return res.status(500).json({ error: 'Server misconfigured (Firebase Admin init failed) — check FIREBASE_PRIVATE_KEY/FIREBASE_CLIENT_EMAIL/FIREBASE_PROJECT_ID env vars.' });
    }

    // ── Verify Firebase ID token — same pattern as api/ai.js ──────────────────
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '').trim();
    if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    if (isRateLimited(uid)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }

    // Body is optional — a plain POST with no body is the existing "just recompute
    // my own referrer-side reward" boot-time check. A body with `code` is a
    // redemption attempt.
    let body = {};
    try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } catch (e) { body = {}; }
    const code = (body.code || '').trim().toUpperCase();

    // ── Redemption path ───────────────────────────────────────────────────────
    if (code) {
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
      const d = userSnap.data();

      if (d.referredBy) {
        return res.status(400).json({ error: "You've already redeemed a code." });
      }

      const idxSnap = await db.collection('momentumIdIndex').doc(code).get();
      if (!idxSnap.exists) {
        return res.status(404).json({ error: "That code doesn't exist — double check it." });
      }
      const referrerUid = idxSnap.data().uid;
      if (!referrerUid || referrerUid === uid) {
        return res.status(400).json({ error: "You can't redeem your own code." });
      }
      const referrerSnap = await db.collection('users').doc(referrerUid).get();
      if (!referrerSnap.exists) {
        return res.status(404).json({ error: 'That code is no longer valid.' });
      }

      // Grant the new user's one-time bonus, and set referredBy — both via Admin
      // SDK, so this never depends on referredBy being client-writable (it isn't
      // protected in the rules, but routing it through here instead of a direct
      // client write means it's always validated against a real code first).
      const now = new Date();
      const rawPlan = d.plan || 'free';
      const rawExpiry = d.planExpiry || null;
      const isExpired = rawExpiry && new Date(rawExpiry) < now;
      const basePlan = isExpired ? 'free' : rawPlan;
      const baseExpiry = isExpired ? null : rawExpiry;
      const bonus = computeNewUserBonus(basePlan, baseExpiry);

      await userRef.set({
        referredBy: referrerUid,
        referralRedeemedAt: now.toISOString(),
        plan: bonus.plan,
        planExpiry: bonus.planExpiry,
      }, { merge: true });

      // Referrer's own reward won't actually move until this new user finishes
      // onboarding (the count query requires onboardingCompleted===true, same
      // as before) — so there's nothing to recompute for them yet at redemption
      // time itself. That happens naturally next time they open Refer & Earn,
      // or the next time this endpoint runs for them with no code.

      return res.status(200).json({
        redeemed: true,
        bonusDays: NEW_USER_BONUS_DAYS,
        plan: bonus.plan,
        planExpiry: bonus.planExpiry,
      });
    }

    // ── Passive path (no code) — recompute the caller's own referrer-side reward ──
    const result = await refreshReferrerGrant(uid);
    return res.status(200).json(result);
  } catch (e) {
    console.error('referral-grant error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
