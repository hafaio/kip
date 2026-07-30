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

// Public by design — security is in the rules, not in hiding this. Blanking
// `appId` makes `firebaseConfigured()` false, so the app still runs unconfigured.
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
