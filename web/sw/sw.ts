/// <reference lib="webworker" />

// Cast, not redeclared: `declare const self` collides with the one
// `lib.webworker` provides, and only a module file may shadow it.
const worker = self as unknown as ServiceWorkerGlobalScope;

// The app shell, and only the app shell: Firestore already persists to IndexedDB
// and queues writes until it can reach the server, so the HTML and JS needed to
// start kip was the only thing missing. Cross-origin requests are left alone
// entirely — a worker in front of the SDK's own offline machinery could only get
// in its way.
//
// Bumping this evicts every earlier cache on activate.
const VERSION = "kip-v1";

// Content-hashed, so a hit is always correct: cache first, never revalidated.
// Documents are the opposite — the same URL means something new after every
// deploy — so those are network first, which is what stops an installed kip
// opening a build that shipped weeks ago.
const IMMUTABLE = /\/_next\/static\//;

worker.addEventListener("install", (event) => {
  // The entry point only — its URL is the scope, where the chunks it pulls in
  // are hashed and unknowable here. Registration is deferred to `load`, so the
  // visit that installs the worker is never seen by it: without this, installing
  // kip and losing signal before opening it again gives the browser's offline
  // page from the new icon.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.add(new Request(worker.registration.scope)).catch(() => {
        // A failure here must not abort the install: no worker at all is worse
        // than one whose first launch has to be online.
      });
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== VERSION) await caches.delete(name);
      }
      await worker.clients.claim();
    })(),
  );
});

// Cache Storage and Firestore's IndexedDB share ONE per-origin quota, and a
// browser under pressure evicts the origin whole — so a shell cache that grows
// without bound can cost the user the offline data this whole design leans on.
// Every deploy mints new hashed filenames and nothing ever invalidates the old
// ones, so a cap is the only thing keeping that finite. `keys()` is insertion
// order, so the oldest go first.
const MAX_ENTRIES = 120;

async function store(key: Request, response: Response): Promise<void> {
  const cache = await caches.open(VERSION);
  await cache.put(key, response);
  const held = await cache.keys();
  // Guarded rather than `slice(0, length - MAX)`: a negative end counts back
  // from the END, so under the cap that deletes almost everything instead of
  // nothing — at 119 of 120 it removed 118. Nothing would catch it either: one
  // deploy makes about 32 entries, so no check ever gets near the cap.
  if (held.length <= MAX_ENTRIES) return;
  for (const stale of held.slice(0, held.length - MAX_ENTRIES)) {
    await cache.delete(stale);
  }
}

worker.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        // Stored on `waitUntil`, never awaited before returning: the page is
        // waiting on this response, and awaiting the write — a `keys()` scan
        // among it — put the whole cache bookkeeping on the critical path of
        // every asset a cold load fetches.
        if (response.ok) event.waitUntil(store(request, response.clone()));
        return response;
      })(),
    );
    return;
  }

  if (request.mode === "navigate") {
    // Keyed on the PATH alone: a navigation's `request.url` carries the query
    // and the fragment, so caching the request as it comes writes a portal token
    // and a one-time sign-in code into a store with no expiry that any
    // same-origin script can read. The document is the same either way, so one
    // entry per path also means an offline `/portal/#anything` finds it.
    //
    // Trailing slash forced to match `trailingSlash`: online a server redirects
    // `/kip` to `/kip/` and offline nothing does, so the key written on the way
    // in would not be the one looked up on the way out.
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    const shell = new Request(`${url.origin}${path}`);
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) event.waitUntil(store(shell, response.clone()));
          return response;
        } catch (offline) {
          // This path if it has been seen. Not the app's entry point as a
          // catch-all: `/portal/` and `/continue/` are their own routes, and
          // serving Home under a share link's URL would show a stranger's own
          // signed-in kip instead of the page they opened.
          const hit = await caches.match(shell);
          if (hit) return hit;
          throw offline;
        }
      })(),
    );
  }
});
