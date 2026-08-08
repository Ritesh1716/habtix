import admin from 'firebase-admin';

// ── One-time backfill: patches every EXISTING user doc that predates the
// displayName / dpdpConsented fixes in index.html's signup flow. Safe to
// re-run — anything already correct is skipped, so accidentally calling this
// twice does no harm.
//
// displayName is recovered from Firebase Auth directly (admin.auth().getUser),
// which stores it independently of Firestore and survives regardless of what
// Firestore ever had — so this is a genuine recovery, not a guess.
//
// dpdpConsented/dpdpConsentDate get an honest false/null default for accounts
// that never reached the consent step, rather than leaving the field absent —
// makes every account consistently queryable for DPDP auditing (B2/B3).
//
// Admin-only: gated to the founder's own account, verified via ID token —
// same verification pattern as delete-account.js / referral-grant.js.
const ADMIN_EMAIL = "riteshpol1716@gmail.com";

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (initError || !db) return res.status(500).json({ error: 'Server misconfigured (Firebase Admin init failed).' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
  if (decoded.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  const results = { scanned: 0, patched: 0, displayNameRecovered: 0, dpdpDefaulted: 0, errors: [] };

  try {
    const usersSnap = await db.collection('users').get();
    results.scanned = usersSnap.size;

    for (const docSnap of usersSnap.docs) {
      const uid = docSnap.id;
      const d = docSnap.data();
      const patch = {};

      if (!d.displayName) {
        try {
          const authUser = await admin.auth().getUser(uid);
          if (authUser.displayName) {
            patch.displayName = authUser.displayName;
            results.displayNameRecovered++;
          }
        } catch (e) {
          // Auth record gone (deleted separately from Firestore doc) — skip, not an error worth failing the batch over.
        }
      }

      if (d.dpdpConsented === undefined) {
        patch.dpdpConsented = false;
        patch.dpdpConsentDate = null;
        results.dpdpDefaulted++;
      }

      if (Object.keys(patch).length > 0) {
        patch.backfilledAt = new Date().toISOString();
        try {
          await docSnap.ref.set(patch, { merge: true });
          results.patched++;
        } catch (e) {
          results.errors.push(`${uid}: ${e.message}`);
        }
      }
    }

    return res.status(200).json({ success: true, ...results });
  } catch (e) {
    console.error('backfill-profiles fatal error:', e);
    return res.status(500).json({ error: 'Internal error', results });
  }
}
