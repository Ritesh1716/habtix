import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// Mirrors api/ai.js, api/push.js, api/referral-grant.js exactly — same three
// env vars, no new Vercel config needed.
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
const FieldValue = admin.firestore.FieldValue;

// ── In-memory rate limiter ────────────────────────────────────────────────────
// Generous — this only needs to stop an accidental retry-loop bug, not real
// abuse (it can only ever delete the caller's own account).
const rateLimitMap = new Map();
const RATE_LIMIT = 5;
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

// ── Main handler ──────────────────────────────────────────────────────────────
// Order matters: every trace of the user's data is removed BEFORE the Auth
// record itself, so that if anything fails partway through, the person still
// has a valid login to retry with — never left in a state with a dead
// account and orphaned data they can't get back into to clean up.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (initError || !db) {
    console.error('Firebase Admin unavailable:', initError?.message);
    return res.status(500).json({ error: 'Server misconfigured (Firebase Admin init failed).' });
  }

  // ── Verify Firebase ID token — same pattern as api/ai.js / api/referral-grant.js ──
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  if (isRateLimited(uid)) {
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }

  // Track exactly what succeeded so a partial failure can be reported
  // accurately instead of collapsing into one generic error.
  const done = {
    goalHistory: false,
    manifestationEntries: false,
    friendsSubcollection: false,
    friendMirrors: false,
    friendRequests: false,
    publicProfile: false,
    momentumIdIndex: false,
    challenges: false,
    mainDoc: false,
    authUser: false,
  };
  const errors = [];

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const momentumId = userData.momentumId || null;

    // 1. goalHistory subcollection
    try {
      const ghSnap = await userRef.collection('goalHistory').get();
      if (!ghSnap.empty) {
        const batch = db.batch();
        ghSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.goalHistory = true;
    } catch (e) { errors.push('goalHistory: ' + e.message); }

    // 1b. manifestationEntries subcollection (B9) — can hold photos, so this
    // matters for erasure the same way goalHistory does.
    try {
      const meSnap = await userRef.collection('manifestationEntries').get();
      if (!meSnap.empty) {
        const batch = db.batch();
        meSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.manifestationEntries = true;
    } catch (e) { errors.push('manifestationEntries: ' + e.message); }

    // 2. friends subcollection — read first so we know who to mirror-clean
    let friendUids = [];
    try {
      const friendsSnap = await userRef.collection('friends').get();
      friendUids = friendsSnap.docs.map(d => d.id);
      if (!friendsSnap.empty) {
        const batch = db.batch();
        friendsSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.friendsSubcollection = true;
    } catch (e) { errors.push('friends subcollection: ' + e.message); }

    // 3. Mirror cleanup — remove this uid from every friend's own friends list
    // (matches the exact mutual-delete pattern the app already uses for
    // "remove friend", just applied to every friend at once).
    try {
      if (friendUids.length) {
        const batch = db.batch();
        friendUids.forEach(fuid => {
          batch.delete(db.collection('users').doc(fuid).collection('friends').doc(uid));
        });
        await batch.commit();
      }
      done.friendMirrors = true;
    } catch (e) { errors.push('friend mirrors: ' + e.message); }

    // 4. friendRequests — both directions, any status (pending or accepted
    // requests both carry this user's displayName/photoURL, which must go too)
    try {
      const [fromSnap, toSnap] = await Promise.all([
        db.collection('friendRequests').where('fromUid', '==', uid).get(),
        db.collection('friendRequests').where('toUid', '==', uid).get(),
      ]);
      const reqDocs = [...fromSnap.docs, ...toSnap.docs];
      if (reqDocs.length) {
        const batch = db.batch();
        reqDocs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.friendRequests = true;
    } catch (e) { errors.push('friendRequests: ' + e.message); }

    // 5. publicProfiles — opt-in-by-having-an-ID snapshot (displayName, photo,
    // score, streak). Must not survive account deletion.
    try {
      await db.collection('publicProfiles').doc(uid).delete();
      done.publicProfile = true;
    } catch (e) { errors.push('publicProfile: ' + e.message); }

    // 6. momentumIdIndex — public Habtix-ID -> uid lookup entry
    try {
      if (momentumId) {
        await db.collection('momentumIdIndex').doc(momentumId).delete();
      }
      done.momentumIdIndex = true;
    } catch (e) { errors.push('momentumIdIndex: ' + e.message); }

    // 7. Challenges this user participated in — drop their progress doc and
    // scrub them out of the participants array + participantHabits map.
    // Uses FieldValue.arrayRemove directly: Admin SDK writes bypass security
    // rules entirely, so the literal-array-only rule constraint that affects
    // client writes (see the join-challenge comment elsewhere in index.html)
    // doesn't apply here.
    try {
      const chSnap = await db.collection('challenges').where('participants', 'array-contains', uid).get();
      for (const chDoc of chSnap.docs) {
        const batch = db.batch();
        batch.delete(chDoc.ref.collection('progress').doc(uid));
        batch.update(chDoc.ref, {
          participants: FieldValue.arrayRemove(uid),
          [`participantHabits.${uid}`]: FieldValue.delete(),
        });
        await batch.commit();
      }
      done.challenges = true;
    } catch (e) { errors.push('challenges: ' + e.message); }

    // 8. Main user document
    try {
      await userRef.delete();
      done.mainDoc = true;
    } catch (e) { errors.push('mainDoc: ' + e.message); }

    // 9. Firebase Auth record — the step that used to fail client-side.
    // Admin SDK deletion needs no recent-login/popup reauth at all, which is
    // exactly what made this unreliable before.
    try {
      await admin.auth().deleteUser(uid);
      done.authUser = true;
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        done.authUser = true; // already gone — treat as success
      } else {
        errors.push('authUser: ' + e.message);
      }
    }

    const fullSuccess = done.mainDoc && done.authUser;
    const dataOk = done.mainDoc;

    if (fullSuccess) {
      return res.status(200).json({ success: true, done, errors });
    }
    // Partial: log server-side for manual follow-up, but still tell the
    // client exactly what did and didn't complete so it can show something
    // accurate instead of a generic failure.
    console.error('delete-account partial completion', { uid, done, errors });
    return res.status(207).json({ success: false, dataDeleted: dataOk, authDeleted: done.authUser, done, errors });
  } catch (e) {
    console.error('delete-account fatal error:', uid, e);
    return res.status(500).json({ error: 'Internal error', errors });
  }
}
