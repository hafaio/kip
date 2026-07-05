"use client";

import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";
import {
  type Firestore,
  type FirestoreError,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { type Functions, getFunctions } from "firebase/functions";
import { type FirebaseStorage, getStorage } from "firebase/storage";

// Firebase web config for the `hafaio-kip` project. These values ship in the
// client bundle by design — security is enforced by Firestore/Storage rules
// (firebase/*.rules), not by hiding the config. Paste your project's Web app
// config here; the app runs with an empty config (sign-in disabled, see
// firebaseConfigured()) so the UI is browsable before Firebase exists.
const firebaseConfig = {
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
  if (!cachedAuth) cachedAuth = getAuth(app());
  return cachedAuth;
}

export function db(): Firestore {
  if (cachedDb) return cachedDb;
  try {
    cachedDb = initializeFirestore(app(), {
      // Multi-tab, because the default takes an exclusive lock on the persistence
      // layer: a second tab can't get it, silently falls back to a memory cache,
      // and re-reads everything it already had. A trip page left open in one tab
      // is an ordinary thing to do.
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (e) {
    // Firestore was already initialized (e.g. HMR reusing the app instance) —
    // fall back to the existing handle so we don't crash.
    console.warn("firestore: reusing existing instance", e);
    cachedDb = getFirestore(app());
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

export function firebaseConfigured(): boolean {
  return firebaseConfig.appId !== "";
}

// onSnapshot error sink. A permission-denied here is almost always benign — a
// listener firing for a tick as auth tears down on sign-out, or attaching to a
// just-created doc before the parent is server-visible — so log it with context
// instead of letting it surface as an uncaught error.
export function onSnapshotError(
  context: string,
): (error: FirestoreError) => void {
  return (error) => {
    if (error.code === "permission-denied") {
      console.warn(`snapshot(${context}): permission-denied (transient)`);
      return;
    }
    console.error(`snapshot(${context})`, error);
  };
}
