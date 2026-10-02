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

// ── What this removes, and why some of it is "legacy" ─────────────────────────
// LIVE data of the current app:
//   users/{uid}/goalHistory, momentumIdIndex entries, referral links, the main doc
//   (habits, goals, one-off actions, obstacle progress, achievement cards, completion
//   logs, manifestation field, FCM token), and the Auth record.
// LEGACY data — features that were cut (Friend Challenges, per-day Manifestation
//   photos): friends / friendRequests / publicProfiles / challenges and the
//   manifestationEntries / manifestationPhotos subcollections. firestore.rules no
//   longer lets any client touch them and nothing in the app creates them, BUT accounts
//   that existed while those features were live can still have such documents
//   (publicProfiles holds a display name + photo). Deleting an account must still erase
//   them, so those steps stay. Once a one-time purge of those collections has run and
//   no pre-cut accounts remain, steps 1b/1c and 2-5 and 7 below can be deleted.
//
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
    manifestationPhotos: false,
    friendsSubcollection: false,
    friendMirrors: false,
    friendRequests: false,
    publicProfile: false,
    momentumIdIndex: false,
    referralLinks: false,
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

    // 1b. LEGACY — manifestationEntries subcollection (B9). Can hold photos, so erasure
    // matters the same way goalHistory does. Nothing creates these any more.
    try {
      const meSnap = await userRef.collection('manifestationEntries').get();
      if (!meSnap.empty) {
        const batch = db.batch();
        meSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.manifestationEntries = true;
    } catch (e) { errors.push('manifestationEntries: ' + e.message); }

    // 1c. LEGACY — manifestationPhotos subcollection (B9 revised schema), photo bytes.
    try {
      const mpSnap = await userRef.collection('manifestationPhotos').get();
      if (!mpSnap.empty) {
        const batch = db.batch();
        mpSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.manifestationPhotos = true;
    } catch (e) { errors.push('manifestationPhotos: ' + e.message); }

    // 2. LEGACY (Friend Challenges cut) — friends subcollection; read first so we know
    // who to mirror-clean
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

    // 3. LEGACY — mirror cleanup: remove this uid from every friend's own friends list.
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

    // 4. LEGACY — friendRequests, both directions, any status (they carry the user's
    // displayName/photoURL, which must go too)
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

    // 5. LEGACY — publicProfiles snapshot (displayName, photo, score, streak). Must not
    // survive account deletion.
    try {
      await db.collection('publicProfiles').doc(uid).delete();
      done.publicProfile = true;
    } catch (e) { errors.push('publicProfile: ' + e.message); }

    // 6. momentumIdIndex — public Habtix-ID -> uid lookup, which is also the referral
    // code. Deleted by the id stored on the user doc AND by every entry that points at
    // this uid, so a regenerated ID or a half-finished write can't leave a live code that
    // still resolves to a deleted person.
    try {
      if (momentumId) {
        await db.collection('momentumIdIndex').doc(momentumId).delete();
      }
      const idxSnap = await db.collection('momentumIdIndex').where('uid', '==', uid).get();
      if (!idxSnap.empty) {
        const batch = db.batch();
        idxSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      done.momentumIdIndex = true;
    } catch (e) { errors.push('momentumIdIndex: ' + e.message); }

    // 6b. Referral links — other users whose referredBy is THIS uid keep a stored
    // identifier of the person being erased. Replace it with a marker rather than
    // null: referral-grant.js refuses a second redemption when referredBy is truthy,
    // so clearing it would let those users redeem another code and collect the
    // bonus twice.
    try {
      const refSnap = await db.collection('users').where('referredBy', '==', uid).get();
      for (let i = 0; i < refSnap.docs.length; i += 400) {
        const batch = db.batch();
        refSnap.docs.slice(i, i + 400).forEach(d => batch.update(d.ref, { referredBy: 'deleted-user' }));
        await batch.commit();
      }
      done.referralLinks = true;
    } catch (e) { errors.push('referralLinks: ' + e.message); }

    // 7. LEGACY — challenges this user participated in: drop their progress doc and
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
