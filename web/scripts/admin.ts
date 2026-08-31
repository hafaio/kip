// Grants (or revokes) the operator role, via the Admin SDK and ADC:
//
//   cd web && bun run scripts/admin.ts you@example.com
//   cd web && bun run scripts/admin.ts you@example.com --revoke
//
// The role is a custom claim on the Auth account, which only the Admin SDK can
// set — so this script is the only way in or out of it, and running it needs GCP
// credentials rather than a kip session. That is the point: a compromised
// account cannot appoint itself.
//
// A claim reaches a live session at its next token refresh (hourly), so sign out
// and back in to see it now.
//
// Takes an address rather than a uid so nobody has to go looking one up, and so
// no uid ends up written down in a public repo.

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PROJECT_ID = "hafaio-kip-dev";
const EMAIL = process.argv[2];
const REVOKE = process.argv.includes("--revoke");

if (!EMAIL) {
  console.error("usage: bun run scripts/admin.ts <email> [--revoke]");
  process.exit(1);
}

const app = initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
});
const auth = getAuth(app);

const user = await auth.getUserByEmail(EMAIL).catch(() => null);
if (!user) {
  console.error(`no account for ${EMAIL} — sign in once first`);
  process.exit(1);
}

// Every claim at once, not a merge: this is the only claim kip sets, and a
// partial update would silently keep whatever else was there.
await auth.setCustomUserClaims(user.uid, REVOKE ? null : { admin: true });
console.log(
  REVOKE
    ? `revoked: ${EMAIL} no longer operates kip`
    : `granted: ${EMAIL} operates kip`,
);
console.log(
  "sign out and back in — a claim reaches a session on its next token",
);
