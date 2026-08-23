"use client";

import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, connectAuthEmulator, getAuth } from "firebase/auth";
import {
  connectFirestoreEmulator,
  type Firestore,
  type FirestoreError,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { type Functions, getFunctions } from "firebase/functions";
import { type FirebaseStorage, getStorage } from "firebase/storage";

// Public by design — security is in the rules, not in hiding this. Blanking
// `appId` makes `firebaseConfigured()` false, so the app still runs unconfigured.
export const firebaseConfig = {
  apiKey: "AIzaSyDvsK-HqXYuHuYlxO_IFh8aGWly6c7_yDI",
  authDomain: "hafaio-kip-dev.firebaseapp.com",
  projectId: "hafaio-kip-dev",
  storageBucket: "hafaio-kip-dev.firebasestorage.app",
  messagingSenderId: "230290747847",
  appId: "1:230290747847:web:668272c876910b0ea0a9e2",
};

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let cachedStorage: FirebaseStorage | null = null;
let cachedFunctions: Functions | null = null;

function app(): FirebaseApp {
  if (cachedApp) return cachedApp;
  cachedApp = getApps()[0] ?? initializeApp(firebaseConfig);
  return cachedApp;
}

export function auth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(app());
  // Opt-in, and only in dev: the Auth emulator is the one way to exercise the
  // phone door automatically, because it skips reCAPTCHA — which exists to stop
  // exactly the automation a test is. It sends no message and bills nothing.
  //
  // The NODE_ENV half is what keeps it out of a production bundle. Next inlines
  // that one as a literal, so the whole condition folds to false and the branch
  // is eliminated; the public flag alone compiles to a RUNTIME read, which ships
  // the emulator's address in the bundle and leaves a build one env var away
  // from pointing at localhost.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_AUTH_EMULATOR === "1"
  ) {
    connectAuthEmulator(cachedAuth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
  }
  return cachedAuth;
}

export function db(): Firestore {
  if (cachedDb) return cachedDb;
  try {
    cachedDb = initializeFirestore(app(), {
      // The default takes an exclusive lock, so a second tab silently falls back
      // to a memory cache and re-reads everything.
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (e) {
    // Already initialized, e.g. HMR reusing the app instance.
    console.warn("firestore: reusing existing instance", e);
    cachedDb = getFirestore(app());
  }
  // Both or neither: an emulator-issued token is scoped to the emulator's
  // project, so leaving Firestore on the real backend would refuse every write
  // the flow under test makes.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_AUTH_EMULATOR === "1"
  ) {
    connectFirestoreEmulator(cachedDb, "127.0.0.1", 8080);
  }
  return cachedDb;
}

export function storage(): FirebaseStorage {
  if (!cachedStorage) cachedStorage = getStorage(app());
  return cachedStorage;
}

// Region must match the one the function declares (functions/src/index.ts).
export function functions(): Functions {
  if (!cachedFunctions) cachedFunctions = getFunctions(app(), "us-central1");
  return cachedFunctions;
}

// True when this build is talking to local emulators rather than the real
// project. Exposed so the UI can SAY so: an emulated Firestore is empty, which
// makes every real share link read as revoked — a symptom with no visible cause
// unless something on screen admits which backend is behind it.
export function usingEmulators(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_AUTH_EMULATOR === "1"
  );
}

export function firebaseConfigured(): boolean {
  return firebaseConfig.appId !== "";
}

// Every Firebase error carries one, auth and Firestore alike, and it is the only
// part of one worth keeping — the message is prose that changes between releases.
export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

// A snapshot error is TERMINAL: the SDK drops that listener and never retries
// it. So logging alone leaves the screen frozen on its last snapshot, still
// styled as live — worse than an error, because nothing looks wrong. Whoever
// attached the listener has to attach a new one, hence this signal. It carries
// no name because the store re-attaches all of them together anyway.
const listenerLosses = new Set<() => void>();

export function onListenerLost(handler: () => void): () => void {
  listenerLosses.add(handler);
  return () => {
    listenerLosses.delete(handler);
  };
}

export function onSnapshotError(
  context: string,
): (error: FirestoreError) => void {
  return (error) => {
    // A permission-denied is usually a race a re-attach settles — auth tearing
    // down, or a listener beating its parent's create. Anything else is worth
    // the stack. Both kinds leave the listener equally dead.
    if (error.code === "permission-denied") {
      console.warn(`snapshot(${context}): permission-denied`);
    } else {
      console.error(`snapshot(${context})`, error);
    }
    for (const handler of listenerLosses) handler();
  };
}
