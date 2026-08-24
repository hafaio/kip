# kip

Friends-only space sharing: list a spare room or your whole place, mark when it's free, and let
mutual friends book it for nothing. Monorepo with a Next.js web client (`web/`) and shared
Firebase rules (`firebase/`); native mobile apps are a later phase. User-facing docs live in
[README.md](./README.md); this file is for contributors and AI sessions.

## Firestore schema

```
users/{uid}                        { username, displayName, photoURL, searchable, createdAt }  # readable by self|friend|searchable; NO email (lives on the Auth account only)
users/{uid}/settings/prefs         { shareStaysWithFriends, profilePortalId, notify: {...} }  # private to owner
users/{uid}/searches/{searchId}    { label, criteria: {...SearchCriteria}, lastSeenAt, createdAt }  # private to owner;
                                     # counts are computed client-side, nothing server-side reads these
users/{uid}/friends/{friendUid}    { username, displayName, photoURL, since }  # denormalized, BOTH sides; you may
                                     # rewrite the entry describing YOU, which is how a rename heals
usernames/{handle}                 { uid }                                # handle->uid registry; GET-only, no list, no update-by-non-owner
connectRequests/{from_to}          { from, to, fromName, fromUsername, fromPhotoURL, toUsername,
                                     portalId?,   # set iff it came via a share link
                                     createdAt }  # "let's be friends" ONLY — asking to stay is a booking
listings/{listingId}               { ownerId, title, type: "ROOM"|"FLAT"|"HOUSE", description,
                                     location: { label, lat, lng, geohash }, photos[{id,url}], publicPortalId, createdAt }
listings/{listingId}/windows/{wid} { start, end (ISO dates, end exclusive), status: "OPEN"|"BOOKED",
                                     autoAccept, details, bookingId (the stay holding it, or null), publicPortalId,
                                     createdAt }  # when the SLOT was added, not its dates; 0 if written before the field
bookings/{bookingId}               { listingId, ownerId, guestId, windowId, start, end,
                                     status: "REQUESTED"|"CONFIRMED"|"CANCELLED",
                                     cancelledBy?, cancelReason?,   # stamped by whoever cancels
                                     hiddenBy[], createdAt }   # NO names/photos — read live, see knownBy
users/{uid}/knownBy/{readerUid}    { bookingId }   # reader-written POINTER; lets the two parties of a
                                     # confirmed stay read each other's profile. Re-checked live.
listings/{listingId}/guests/{uid}  { bookingId }   # guest-written POINTER; re-checked live, inert once cancelled
portals/{uuid}                     { scope: "USER"|"LISTING"|"SLOT", ownerId, ownerName, ownerPhotoURL,
                                     listingId?,                      # LISTING scope
                                     listings: [{ listingId, title, ... windowIds }]?,  # SLOT only
                                     createdAt }   # public get-by-id; rooms+dates otherwise read live
portals/{uuid}/grants/{uid}        { expires }   # visitor's proof they hold the token; unlocks live dates
debug/{autoId}                     { uid, kind, detail (JSON string), at, expires }  # write-only diagnostics;
                                     # create by any signed-in caller, NO read by anyone, TTL on expires
```

Rules: [firebase/firestore.rules](./firebase/firestore.rules), [firebase/storage.rules](./firebase/storage.rules).

## Design decisions

- **No server in the request path.** Every user-facing action — public share links included — runs
  client + rules, with `firestore.rules` as the sole enforcement. `functions/` holds exactly one
  thing, notification email, which never sits between a user and their data: it reacts to writes
  that already happened. It earns its place because it needs the Admin SDK to read an address off
  the Auth account, which is what keeps email out of Firestore. Treat any OTHER proposed function as
  a claim to disprove, not a default.
- **A rename heals every copy of your name.** Friend edges carry `displayName`/`photoURL` so
  rendering a friends list costs zero extra reads — but nothing else can reach into another user's
  friends list, so that copy was previously stale forever (there was no `update` verb on the edge at
  all). The rule now lets you rewrite **the entry describing YOU**, name and photo only, and
  `updateDisplayName` fans that out across your friends in one batch alongside `propagateProfile`
  for share links. Write-on-rename, not read-on-render. The handle is immutable so it never drifts,
  and booking copies are deliberately frozen (a record of the time).
- **Bijective, denormalized friendship.** Becoming friends writes a doc into BOTH users'
  `friends` subcollections. Visibility checks ("can this user see this listing?") are then a
  single `exists(/users/$(ownerId)/friends/$(uid))` in rules — no graph traversal, no server.
  Accepting a request is one `writeBatch`: write both edges + delete the request, so we never
  persist a half-formed friendship (`utils/friends.ts` `acceptRequest`). Either party deleting
  unfriends both sides.
- **Friend-request id is `${from}_${to}`.** Deterministic, so the rule authorizing the accepter
  to write into the requester's `friends` subcollection can look the request up by id, and
  re-sending a request is idempotent rather than duplicating.
- **Public share links = capability-URL portals.** Making something public mints a `portals/{uuid}`
  doc whose id IS an unguessable UUID; knowing it is the capability. World-readable BY ID only
  (`get: if true`, no `list` → not enumerable), revoke = delete, regenerate = new uuid + delete old
  (kills every old link). Three scopes share one spine (`utils/portals.ts`): **USER** (all your
  places, id in `prefs.profilePortalId`, control on your own PersonPage), **LISTING**
  (`listing.publicPortalId`, control in the RoomPage owner view's Sharing section), **SLOT**
  (`window.publicPortalId`, control in the per-slot Sheet on that same page).

  **Almost everything is read live; exactly one thing is copied.**
  - **Free dates** are always live, for every scope. Never copied, because the changes that matter
    aren't the owner's — a friend instant-booking flips a window to `BOOKED`, a guest cancelling
    flips it back, and neither may write the owner's portal doc (allowing it would be a forgeable
    write into a world-readable doc, and rules can't pin one element inside an array).
  - **Rooms** are live for USER and LISTING links: a USER link names no places at all and the
    visitor *queries* the owner's listings (so a room added later just appears); a LISTING link
    names one and reads it.
  - **The one copy** is the room shell (title/type/description/location label) carried by a **SLOT**
    link, because a slot grant deliberately does NOT unlock the room — sharing one set of dates is a
    narrower promise than sharing the place. It also *can't*: a rule only `get()`s paths it can
    construct, and "is this room readable because one of its date ranges is shared?" would mean
    iterating a subcollection. `propagateListing` writes that shell through on edit; it targets slot
    links only, since nothing else copies.
  - The owner's **name/photo** is copied on every scope (a visitor can't read `users/{owner}` —
    they're not a friend, and the owner may not be searchable), kept current by `propagateProfile`.

  **Live reads work through a grant** (`portals/{token}/grants/{uid}`). A read request carries only
  a path and an identity — there's nowhere to present a secret — so the visitor first *writes* a
  doc under the token; the create rule refuses a token that doesn't resolve to a live link, which
  makes the write itself the proof. Reads then compare that grant against whichever token the
  document CURRENTLY sits under — the window's own `publicPortalId`, its listing's, or the owner's
  `profilePortalId`. Three separate checks, because all three can cover one window at once and a
  rule can only compare one value at a time. **Revocation and regeneration are therefore exact and
  instant**: clear or replace the field and every old grant stops matching, with no sweep. Leftover
  grants are inert, so cleanup is a Firestore TTL policy on `expires` — hygiene, never security.

  **The load is a dependency chain, and only some of it is real.** Nothing here can be batched away:
  a Firestore transaction is a read phase plus a commit (more round trips, not fewer), the web SDK's
  `transaction.get` takes a DocumentReference so queries can't go in one at all, and even if they
  could, rules evaluate against COMMITTED state — a grant written inside the transaction would be
  invisible to the rules authorising reads in that same transaction. The grant genuinely has to land
  first. What was NOT real: `claimGrant` was queued behind the portal doc read though it needs only
  the token (a function argument) and the uid; and the "which slots do I already hold" query ran once
  per room, each behind the grant, though `guestId == uid` is the FIRST clause of the booking read
  rule and so needs no grant at all. Both now start on the sign-in alone, taking five serial round
  trips to three, with one bookings query for the page instead of one per room.

  What's left is latency nobody can remove, so the page stops hiding it: `fetchPortalPage` takes an
  `onOwner` callback that fires the moment the portal doc lands, and the page paints the host block
  then, with skeletons where the rooms will be. Skeletons and not "Nothing shared here right now" —
  that line is a statement about an empty link, and saying it to someone whose rooms are still in
  flight is worse than saying nothing. `layout.tsx` also preconnects the four Firebase hosts, since a
  stranger opening a link pays DNS and TLS for each of them with nothing warmed.

  Because a grant needs an identity, the share-link page signs visitors in **anonymously** on load
  (`ensureAnonymous` in the store). Invisible — no prompt, no account — and Firebase auto-deletes
  unused anonymous accounts after 30 days (already enabled on the dev project).

  **Two rules keep that from eating a real session**, and both were learned the hard way — opening a
  link you'd been sent while signed in silently replaced your account with an empty anonymous one
  and then asked you to pick a display name.
  1. `ensureAnonymous` awaits `authSettled()` (`utils/auth.ts`) before deciding. Firebase restores a
     persisted session ASYNCHRONOUSLY, so `auth().currentUser` is null for a beat after load even
     for someone who is signed in; reading it directly mistakes them for a stranger.

     **Only the WAIT is one-shot — the ANSWER is read fresh**, off `auth().currentUser`, every call.
     Caching the first callback's argument (which is what it used to return) meant every later call
     reported whoever was signed in AT LOAD. Pasting a second share link into the same tab changes
     only the fragment, which is not a reload, so the load effect re-ran, `authSettled()` handed back
     a stale `null`, and `signInAnonymously` replaced the visitor's real account with an empty one —
     the very bug this function exists to prevent, reintroduced by its own cache.
  2. **An anonymous session is a participant, not a signed-out one.** This USED to gate on
     `!user || anonymous`, on the reasoning that a ticket is not an account. It no longer holds:
     an anonymous account can carry a display name, a live ask and friendships, and every rule it
     meets is blind to how it signed in. `app/page.tsx` gates on `!user` alone. What replaced the
     old reasoning is `displayName` — `AuthMenu` hides until there is one, because a nameless
     visitor has no profile to show. The one thing still withheld is the EXIT: signing out of an
     account with no credential destroys it, so `signOut` refuses without `force` and only the
     Settings row (behind a confirm) passes it.

  **The store watches `onIdTokenChanged`, not `onAuthStateChanged`, and that is load-bearing.**
  `onAuthStateChanged` fires only when the **uid** changes — `notifyAuthListeners` in the SDK pushes
  to `authStateSubscription` inside `if (this.lastNotifiedUid !== currentUid)`. Linking an anonymous
  account KEEPS the uid, so signing up from a share link fired nothing at all, and Firebase compounds
  it by mutating the `User` object **in place** (`Object.assign(user, updates)` in
  `_reloadWithoutSaving`) — so even a `setUser(next)` would hand React the same reference and bail
  out of the render. The visible bug: a visitor tapped "Ask to be friends", created an account in the
  sheet, and the sheet stayed sitting over the button, because `identified` was still computing
  `false`. Reloading the page fixed it, which is why it looked intermittent.

  So the mutable fields the app branches on — `isAnonymous` and `emailVerified` — are **snapshotted
  into store state** (`anonymous`, `emailVerified`) and read from there, never off `user`. Anything
  that branches on a field Firebase can change without a uid change belongs in that pair; reading it
  off `user` at render is the bug, not the exception. Watching the token also fires on hourly
  refreshes, which is free — the `User` reference is unchanged, so `setUser` bails and no listener
  effect re-runs.

  **A tap on the share-link page is never a no-op, and that is a rule about the STATE MACHINE, not
  about one bug.** Tapping holds the ask in `ask` and lets an effect send it once the sender is
  known; two sheets cover the two reasons it can't go yet (no account, no display name). Neither
  covered the gap between "signed in" and "profile loaded" — so a tap landing there set `ask`, opened
  nothing, and the effect returned at its guard: no sheet, no spinner, no error, nothing in the
  console. `holding` closes it by making an unsent ask and a spinning control the same fact, so a
  future reason to stall can't produce a dead button either.

  Two things made that gap wide enough to hit. The profile is a Firestore listener, so it costs its
  own round trip after auth settles; and `fetchPortalPage`'s `onOwner` callback now paints the page
  one round trip in instead of three, which put the button on screen EARLIER. The perf work is right
  and the guard was always wrong — it just had nothing to be wrong in front of until then.

  **A held ask also times out** (`ASK_TIMEOUT_MS`, 10s) and says so, since a spinner that never
  stops goes on claiming work is in progress when none is. Scoped to exactly the sheet-less wait:
  a sheet up means the visitor is being asked for something, and once the SEND starts the write
  belongs to Firestore, which queues offline and lands on reconnect — so reporting a failure there
  would be wrong rather than merely early. `failed` is a reason (`refused` | `stalled`) and not a
  boolean, because the advice differs: a refusal may mean a revoked link, a stall never reached the
  server at all. Either one keeps the ask it came from and offers **Try again**, since the button it
  was tapped on may now be scrolled away or covered by the error.

  **That timeout stopped being the primary answer, because the wait it was guessing about is now
  reported.** A real visitor hit it in production: signed in, no sheet, ten seconds, "Couldn't reach
  kip". The message was true — nothing was sent — but the cause was a gate that could not settle, not
  a connection that had failed, and the page had no way to tell them apart. See the profile-gate
  note under the store bullet; the timer is now a backstop for a stall nobody named, and
  `profileUnreachable` answers the common case outright.

  **This path IS covered, and it has to be** — see *Driving the share link* below. A previous pass
  wrote a headless-Chrome suite against the emulators, proved it caught the bug, then deleted it as
  cruft because it could never gate CI, and left a note saying the guards were held by prose alone.
  That reasoning was wrong and it cost real bugs: a share link that resolved for nobody, a code step
  that swallowed a wrong code, a returning door that never signed anyone in — every one of them past
  lint, the unit suite and the rules suite, because none of those can open a page.

  **"It can't gate CI" is not a reason not to have it.** A check that has to be run by hand still
  turns a bug nobody can see into one anybody can reproduce, and that is the whole difference on
  this path. `holding` especially reads as pointless indirection next to `busy` — it is not, and
  removing it brings the dead button straight back with every other check still green.

  `emailVerified` rides along for the same structural reason, but note what that does NOT fix:
  nothing in `web/` calls `user.reload()`, the proactive token refresh doesn't reload either, and the
  verification link opens on Firebase's own action origin, so **verifying in another tab and coming
  back still leaves the Home prompt up until a reload**. Closing that would mean reloading the auth
  user on focus or visibilitychange; the snapshot is what makes such a fix land on screen at all.

  **A uid-keyed capability must survive the visitor getting an account, and there are two halves to
  that.** Creating an account **links** the anonymous one (`linkWithPopup` / `linkWithCredential` in
  `utils/auth.ts`), so the uid doesn't change and the grant still belongs to them. But linking is
  impossible when the credential already belongs to a real account — they're signing IN, not up — so
  that path falls back to a normal sign-in and the uid DOES change. Hence the second half: the grant
  is re-claimed at the point of use, immediately before the write that needs it. Either half alone
  leaves the flow broken, and it was broken: neither existed, so every share-link booking by a new
  visitor was refused by the rules, silently.

  **Rules lookups are a budget, and it binds.** Firestore allows 20 document lookups per query (10
  per single-doc read); repeats of the SAME path are free. So the cost of a query is the number of
  *distinct* paths its rule touches, not the number of documents returned. Two consequences:
  - **Clause order matters.** `isFriendOf` and the room/profile grants — one shared lookup each,
    covering a whole query — come BEFORE the per-document slot grant and guest marker.
  - **Browse is chunked at 20 friends** (`BROWSE_CHUNK`, `utils/listings.ts`), NOT the 30 an `in`
    filter allows. Each friend's listing costs one `exists()` on their friends edge, so 25 distinct
    friends in one query is refused outright — 30 places across 3 friends is fine. This was a live
    bug (the chunk was 30), found by testing the limit rather than reasoning about it. 20 is the
    exact ceiling and `web/tests/rules.test.ts` pins BOTH sides, so adding a lookup at or before the
    friend check fails a test instead of silently emptying Browse for the best-connected users.

    Separately: if ANY document in a query result is unreadable, Firestore rejects the whole query
    — Browse empties rather than dropping one place, and chunk size is irrelevant to that. Stored
    divergence can't cause it (every friend-edge write is a batch/transaction, so both edges always
    move together), but there IS a transient window: between someone unfriending you and this
    client's listener catching up, a refresh can still name them in the `in` filter. It self-heals,
    since `refreshBrowse` is keyed on the friend-uid list.

  Asking goes through `requests` — see the next bullet.

  The token rides in the URL **fragment** (`/portal/#<uuid>`) — which keeps it out of the static
  host's access logs and out of any `Referer` header, since browsers strip the fragment from the
  page request. It is NOT "off the wire": the client reads it and uses it in Firestore calls
  deliberately. The page is outside the auth gate. Proved in `web/tests/rules.test.ts` (grant
  claim/forgery, regenerate + revoke killing access instantly, a slot link exposing only its own
  dates, a room link unlocking the room live, a slot link NOT unlocking it, a profile link reaching
  a room added later, dates-less accept).
- **Asking to stay is a booking; asking to connect is a request. Two things, not one.** Whoever is
  asking — a friend browsing, or a stranger on a share link — "I'd like these dates" creates the
  SAME document: a `REQUESTED` booking. There is no parallel stay-request type. What differs is only
  what authorises the write:
  - a **friend** is authorised by friendship, and may self-confirm an `autoAccept` slot;
  - a **share-link visitor** is authorised by their portal grant, and can NEVER skip approval, even
    on an auto-accept slot — instant booking is first-come-first-served *among friends*, and a link
    is not friendship.

  This is why multiple pending asks between the same two people just work: bookings have auto-ids.
  An earlier design keyed a merged request collection on `${from}_${to}`, which silently overwrote a
  pending connect request when the same person later asked for dates.

  **The SLOT is the source of truth for the dates.** A booking references it (`windowId`) and the
  slot goes read-only once held — the rule freezes `start`/`end` while `BOOKED`. Whoever holds a
  slot can always read it (its booking names them), independent of any share-link grant, because a grant
  lapses after 30 days or the moment the host regenerates the link, long before a stay does.

  The booking *also* carries `start`/`end`, and that copy is not the authority — it's what makes the
  drift check possible. The rule requires it to match the slot at creation AND re-checks on confirm,
  since in between the window sits `OPEN` and the host may still edit it; without the second check a
  confirm could shift a stay the guest never agreed to. It also keeps a cancelled booking legible
  after its slot has been deleted.

  **Accepting a stay grants no friendship** — instead the guest gets sight of the LISTING (not its
  other slots) via `listings/{id}/guests/{uid}`, so they aren't left holding a booking against a
  place they can't read.

  That marker is a **pointer, not a grant**: it stores `{ bookingId }`, and `guestOfListing` re-reads
  that booking on every use, requiring it to still be `CONFIRMED`, to be this guest's, and to be for
  this listing. So it goes inert the moment the stay is cancelled — **no cancel path has to remember
  to tear it down**, which is what a standing grant would have required of every route (guest cancel,
  owner decline, slot cancel, listing delete) and which one of them would eventually forget. Same
  shape as portal grants going inert on rotation; leftovers are garbage, not access.

  It's **self-issued by the guest** (`claimGuestAccess`, driven off their own trips), because neither
  confirm path can write it: rules evaluate against committed state, so the booking still reads
  `REQUESTED` inside the owner's confirm batch and doesn't exist yet inside the guest's instant-book
  transaction. Safe precisely because the pointer grants nothing on its own.

  **A confirm must hand over the slot, in the same commit.** Confirming is two writes — the booking
  and the slot — and `slotHandedTo` uses `getAfter()` to require the second. Without it, confirming
  is a lone booking write the rules accept: the slot stays `OPEN`, so the next confirm passes the
  same check, and a host could promise one slot to any number of guests. Same for instant booking.
  The client transaction only guards honest races; this closes the crafted one.

  **A booking carries no names or photos — it carries a hop.** The two parties may be unable to
  read each other (a share-link guest and their host are neither friends nor searchable), which is
  why those used to be copied onto every booking and rewritten on every rename. That fan-out was
  **O(bookings), forever**, and would have blown the 500-op batch limit for a long-lived account —
  the wrong shape, however carefully bounded.

  Instead `users/{uid}/knownBy/{readerUid}` = `{ bookingId }`: the READER self-issues a pointer
  naming the stay that justifies it, and the `users` read rule passes when `sharesStayWith` finds it
  AND re-reads that booking as still `CONFIRMED` and joining exactly those two. Same shape as the
  guest marker on a listing — a pointer, not a grant — so it can't be forged to reach a stranger,
  it goes inert the moment the stay is cancelled, and no cancel path has to remember to tear it
  down. It has to be a pointer rather than a search because a rule can only look up a path it can
  construct, and "is there a booking joining these two?" is a query.

  Nothing on a booking is pinned any more, because nothing on it is an unverifiable copy.

  **Sight expires with the stay, and there is no transition to hook it to.** Nothing ever writes to
  a booking when it ends — "completed" is just `end < today`, computed at render. So a pointer left
  from a one-night stay years ago would have granted profile reads forever, the only grant in this
  schema that never decayed. `stayPermitsSight` therefore reads the date itself (`endedWithin`,
  60 days after checkout, the same ISO parsing as `stillCurrent`), which needs no state machine: a
  pointer issued while a stay was fresh simply stops matching, with no sweep and nothing to revoke.

  It also covers the other direction: a **REQUESTED** stay lets the HOST look up the GUEST, one way
  only. Confirming a stranger called "Someone" is the moment identity matters most, and asking to
  stay is initiating contact exactly as a connect request is — but being asked is not consent to be
  looked up, so the guest gets no matching read until the stay is confirmed.

  The **Cloud Functions** can't hop (a trigger has no session) but run as admin, so they read both
  profiles directly when building a notification.

  **A booking's status machine is enforced, not just its fields.** The update rule pins which keys
  may change AND the transition graph: CANCELLED is an ending, CONFIRMED is reachable only from
  REQUESTED, and REQUESTED is a birth state that nothing returns to. Without the first two an
  ordinary race walked straight through — a guest withdraws, the host's screen still says Pending,
  the host taps Confirm, and `confirmBooking`'s transaction (which read only the WINDOW) committed a
  stay that had been taken back. It now re-reads the booking too, so the honest "no longer
  available" surfaces instead of a rules refusal. Without the third, a host could push a confirmed
  stay back to pending, revoking the guest's access mid-stay while the slot stayed booked in their
  name.

  **Bookings are terminal** (`allow delete: if false`). Guest access is a pointer AT one, re-read on
  every use, so deleting a booking would strand it. Ending a stay means `CANCELLED`. Clearing one
  off your list is a **per-party hide**, never a delete: one document is the record for BOTH sides,
  so a guest deleting it would erase the host's history of a stay that was called off. `hiddenBy`
  holds uids, each party may add only their own, only once the booking is CANCELLED, and nobody can
  remove anyone else's — so the client must `arrayUnion`, since replacing the list drops the other
  party and the rule refuses it. The store filters on it at the two subscriptions, so every surface
  honours it without each one remembering to. Friendship is asked for separately, and the friend-edge rule requires a `connectRequests`
  doc, so a host can't conscript a guest into it by confirming their stay.

  **Every identity copy is pinned to the real profile — requests, bookings AND friend edges.** The
  friend edge is the longest-lived of them: unpinned, an accepter could install themselves in the
  sender's list under any name, or wearing a handle registered to someone else, in a list nobody has
  reason to re-check. `edgeMatchesWriter` covers both the accept write and the heal-on-rename
  update. Note scoping WHICH fields may change is not the same as checking their values — the heal
  rule pinned the fields and still allowed renaming yourself to "kip Support" in every friend's list.
  Because rules read committed state, `updateDisplayName` must write the profile FIRST and the edges
  second; one batch would check the new name against the old.

  **The sender's identity on a request is pinned to their real profile.** `fromName`/`fromUsername`
  are copied because the two parties may not be able to read each other — which also means the
  RECIPIENT can't check them, and they go straight into a notification email. So the rules require
  them to equal the sender's actual `users/{uid}` values. (A booking needs no such pin: it carries
  no names at all, only the `knownBy` hop.) Left free,
  anyone could ask to connect as "Chase Fraud Alert (@chase_support)" or simply wear another kip
  user's handle. Booking create also pins `cancelledBy`/`cancelReason` to null, so a stay can't be
  lodged pre-stamped as cancelled by the host.

  **`connectRequests` is "let's be friends", nothing else.** Three routes in — found by handle (the
  recipient is `searchable`); arrived via a link (`portalId`, which also marks it so the card can
  say "via your link"); or **you two already share a confirmed stay** (`bookingId`, checked
  order-free by `bookingJoins`). That third one exists because a share-link guest and their host are
  the one pair who demonstrably know each other and the one pair neither of the others can serve —
  neither is searchable to the other, and neither holds the other's link. `${from}_${to}` is the
  right key here: one pending friendship ask per pair. `utils/requests.ts` owns it.

  **The route is re-checked on re-send, not just on send** (`requestRouteOpen`, called from both
  `create` and `update`). Re-asking overwrites the same doc id, so without that a request that
  arrived through a link stayed rewritable after the recipient revoked it — `portalId` included,
  meaning the card in their inbox could claim a provenance it no longer had. One function called
  from both verbs, so the two can't drift.

  A request also carries `toName`/`toPhotoURL` — the sender's own note of who they asked, so an
  outgoing row can name a person instead of rendering a bare "@" for the two routes that learn no
  handle. Deliberately NOT pinned by the rules, unlike `fromName`: the `from` copy is checked
  because the recipient can't verify it and it goes into an email, whereas the `to` copy is rendered
  only in the sender's own list, on a document only the two parties can read. Nobody to mislead.
- **Discovery is opt-in, and a handle is optional.** A fresh account is **unreachable**: onboarding
  asks for a *display name only* — collected just in time by the identity sheet
  (`components/name-gate.tsx`, and the portal page's own copy), never a blocking screen — and
  nobody can initiate contact until you turn on one of **two independent avenues**
  in Settings → *Who can find you*:
  - **Searchable** (`users/{uid}.searchable`) — findable by handle. Requires a username, so the
    switch reveals the claim form when there isn't one; `claimUsername` writes the handle and
    `searchable: true` together, since a handle exists only to be found by.
  - **Public profile link** — a USER-scope portal (`prefs.profilePortalId`, control on your own
    PersonPage; the Settings row links through to it). A share link, not a handle.

  Both off = private. This is why a handle isn't part of onboarding: someone who arrives through a
  share link is *found by the link*, so making them invent a username was pure friction.

  **The three rules that make this real** (client hiding is not enough — a uid leaks, e.g. to
  someone you later unfriended):
  1. `users` read is `self || friend || searchable` (`list: if false` as before, so the table still
     can't be scraped). A private account is indistinguishable from a nonexistent one.
  2. `connectRequests` create requires the *recipient* to be `searchable` — unless the sender names
     a live share link of theirs (`portalId`), the other legitimate route in. Going private stops
     inbound requests from anyone who merely holds your uid.
  3. `users` write refuses `searchable: true` without a `username` — being findable and having a
     handle are one decision, enforced server-side.

  **A handle can never be claimed anonymously.** Anonymous sign-in exists so a share-link visitor
  can hold a grant, and Firebase reaps those accounts after 30 days — so an anonymous claim would
  leave a permanent registry entry owned by a dead uid, unreclaimable, and one script could take
  every good name. The create rule refuses `sign_in_provider == 'anonymous'`.

  **Handles are permanent** — `usernames/{handle}` has **no delete rule at all**. That's precisely
  what makes going private reversible: your name can't be released and re-squatted while you're
  unsearchable, so you can flip searchability back on and still be yourself. (The Settings claim
  flow confirms this before writing.) **Uniqueness is functionless:** `claimUsername`
  (`utils/username.ts`) writes the registry entry FIRST, then the profile; a collision hits the
  registry's owner-only `update` rule and is denied, so the profile write never happens.
  **Format + reserved-name checks are enforced in the rule** (`handle.matches(...)` + a denylist),
  so a crafted client can't grab `@admin`. **The displayed handle is bound to the registry:** the
  `users` write rule requires `usernames/$(username).uid == userId`, so a profile can't show a
  handle it never claimed. An idempotent owner-only registry `update` lets an interrupted claim be
  retried. The display name IS editable (Settings → Account).

  Consequence worth knowing: `acceptRequest` takes the requester's name/handle/photo off the
  **request doc** (already denormalized) rather than reading their profile — that read used to
  happen and would now fail exactly when a private person reaches out to you. Portal accepts
  already worked this way. `fetchUserProfile` swallows `permission-denied` into `null` so a private
  stranger reads as "not found" instead of throwing.

  **Email is never stored in Firestore:** it lives only on the Firebase Auth account (for sign-in /
  reset / verification) — the client simply never writes it to the profile. Your own address is read
  from `auth().currentUser` for the self-only Settings display; a friend's is not available. (Email
  *delivery* for notifications is a separate concern — see Notifications.) Enumeration risk is
  bounded by get-not-list + unguessable handles — **no App Check** (deliberate).
- **A booked slot's dates are frozen; slots never overlap.** Once a stay is confirmed, the host may
  edit that slot's notes and may cancel it outright, but **cannot move its dates** — a confirmed stay
  is an agreement about specific nights, and a host silently shifting it would be indefensible. The
  rule pins `start`/`end` whenever the EXISTING status is `BOOKED`, which still lets the OPEN→BOOKED
  confirm and the BOOKED→OPEN release through (both read a different existing status). The RoomPage
  slot sheet already hid the date fields when booked; the rule is what makes it true.

  A slot with PENDING asks is still `OPEN`, so the host CAN move it — locking on request would let
  anyone freeze a calendar just by asking. Moving it cancels those asks (`updateWindow`) and
  notifies each one (`slot-moved`), behind a confirm dialog that says so, rather than silently
  redefining what someone asked for.

  **Who is waiting is shown where the dates are.** The slot sheet lists every `REQUESTED` booking on
  that slot, oldest first, above the date fields — so the confirm that cancels them is not the first
  the host hears of them. Rows are `BookingRow` (`lead="person"`), the same component the Guests and
  Cancelled lists use, and they only navigate: confirming is a transaction with its own failure
  states, all of which live on the booking page, and CLAUDE.md's own "confirming a stranger called
  'Someone' is the moment identity matters most" argues against a one-tap confirm that skips looking.

  It renders in all three of the sheet's states, not just the open one, and the two extra cases are
  the point rather than tidiness. **Confirming does not cancel the losers** — `confirmBooking`
  touches only the winning booking and the window — so a BOOKED slot carries the asks that lost the
  race, and they can never be confirmed (`bookingMatchesOpenSlot` requires OPEN). An **expired** slot
  can hold them too. Both are answerable only by declining, which the sheet says outright, and this
  is the only surface that reaches them from the dates they are about.

  **Both Availability lists carry a count**, and without it none of the above is findable: a slot two
  people are waiting on otherwise looks exactly like one nobody has asked about, and the host would
  have to open every slot in turn. **Past dates** carries it too, and that is where it earns most —
  nothing ages an ask out, so a request for dates that have gone sits in someone's list until it is
  declined, and a past slot is the last place anyone would look.

  Opening a slot also **names it in the URL** (in place, so it adds nothing to go back through) —
  tapping a request pushes the booking on top of it, and back returns to the slot still open instead
  of a room that has forgotten which one it was. That is why a room's `windowId` is deliberately NOT
  part of `screenKey` in `app/page.tsx`: a sheet is an overlay on the room, not a different screen,
  and counting it scrolled the page under the sheet to the top on open and again on close. For the
  same family of reason `replaceEntry` now carries `historyScroll()` forward — a replace changes what
  an entry POINTS AT, not where the reader is standing in it, and defaulting to 0 meant every in-place
  rewrite silently forgot the position.

  **A slot holds at most one stay, and is born free.** `bookingMatchesOpenSlot` requires the slot to
  be `OPEN` as well as to hold the claimed dates, at BOTH ends of a stay's life — asking and
  confirming. Without the `OPEN` half, a booked slot's frozen dates would happily match a second
  ask, and confirming it would overwrite the first guest's `bookingId` and with it their right to
  release the slot. Creating a slot pins `status: 'OPEN'` and `bookingId: null` for the same family of
  reason: otherwise an owner could birth one already `BOOKED` naming anyone as the holder, handing
  them a standing read of it.

  Together with the booking-update rule allowing only `status` to change, that gives the invariant
  **you get the nights you asked for, or nothing** — enforced in rules, needing no client
  cooperation. The pending-cancel above is courtesy notification, not integrity: a stale ask is
  inert, since it can never be confirmed onto moved dates.

  There is deliberately **no HIDDEN state**. Its load-bearing step — hiding cancels every booking on
  the slot — cannot be rule-enforced, because rules can't enumerate a slot's bookings (no queries,
  no back-pointers). It would move the critical invariant from the rules to the client, which is the
  direction this schema has spent several passes escaping, and would add an invisible-but-live slot
  that still has to block overlaps and still backs a live share link.

  Overlapping slots are rejected in the CLIENT (`findOverlap`, `utils/listings.ts`), not the rules —
  a rule can't query sibling documents, and the only person a clash hurts is the owner whose own
  calendar it is, so a crafted client gains nothing by skipping the check. `end` is exclusive, so
  ranges that merely touch are allowed.
- **A slot says it's taken; the booking says by whom, and that's the guest's to give.** A slot
  carries `bookingId`, never a guest uid. It used to carry `bookedBy`, and that was a quiet leak:
  **every friend of the HOST can read the slot** (`isFriendOf(listingOwner)`), so the guest's uid
  sat in a document a whole social circle could read, and anyone who was also friends with that
  guest could turn it into a name. Rules are per-DOCUMENT, not per-field — there is no hiding one
  key from someone allowed to read the row — so the only fix was to move the identity out. Now
  "who is staying here" is reachable only by reading the booking, and `guestSharesStays` gates
  that on **being the guest's own friend AND the guest sharing** (`prefs.shareStaysWithFriends`).

  **A private prefs doc is no obstacle, because a rule's `get()` is not a client read.** The same
  move `sharesStayWith` already makes.

  **Sharing is OFF until asked for, and absent prefs reads as off.** Where someone is sleeping is
  the most sensitive thing kip holds, and a friends list is not a small audience — an account that
  has never opened Settings has not agreed to publish it. That makes the absent case the one that
  matters: it is the state of every account predating the switch and every account that never
  touched it, so a default of ON would have leaked precisely for the people who never chose. Three
  places have to agree or the rule quietly disagrees with the switch Settings draws —
  `guestSharesStays` (now `exists(prefs) && ...get('shareStaysWithFriends', false)`, where it used
  to pass on a missing doc), `DEFAULT_PREFS`, and `watchPrefs`'s `?? false`.

  **CONFIRMED only.** Where someone merely asked to go, or was turned down, stays between the two
  of them.

  Two surfaces: a friend's held slot appears on the RoomPage (dimmed, chip reads plain **"Booked"**
  — unattributed, because who it is should be a deliberate second tap), and their next five stays
  appear on their PersonPage. Tapping through reaches the booking page, which now renders read-only
  for a non-party: no confirm, no decline, no cancel, no clear. A slot whose booking can't be read
  **isn't rendered at all** rather than showing an unexplained "Booked".

  **It is one read per taken slot, and it has to be.** If any document in a query result is
  unreadable, Firestore refuses the whole query — so the misses must be taken one at a time.
  `fetchBookingIfVisible` swallows `permission-denied` into null, the same shape as
  `fetchUserProfile`: the refusal IS the answer. The reader's own stays come from `trips` and cost
  nothing.

  **The stays feed is one query, and it must pin `status`.** `fetchStaysOf` filters on `guestId`
  AND `status == 'CONFIRMED'` — dropping the second filter gets the query refused outright, however
  readable every document in it would be. (The guest's own `watchMyTrips` filters on `guestId`
  alone and is unaffected: the first clause matches before anything unpinned is read.) Both halves
  are pinned in `rules.test.ts`, since "simplifying" that filter away would empty the feed with
  nothing else failing.

  Knock-on effects worth knowing: `slotHandedTo` now pins the exact booking rather than its guest
  (tighter — one guest's second ask can't be answered with a slot promised to their first); the
  seed derives `bookingId` from `BOOKINGS` instead of declaring a holder, so a fixture has nothing
  left to contradict itself about; and a friend's stay shows dates but only names the PLACE when
  the viewer can also read that listing, which is right — the host has a privacy interest here too.
- **Window status is owner-only; bookings drive it.** A guest can't write a listing's `windows`
  (rules), so requesting a booking only creates the `bookings` doc (`OPEN` stays `OPEN`). The
  owner's **confirm** flips the window to `BOOKED` and the booking to `CONFIRMED` in one batch;
  owner **decline/cancel** reopens it. A booked window names the stay as `bookingId`, so guest
  cancel of a `CONFIRMED` stay reopens the window itself in the same batch (`BOOKED -> OPEN`,
  clear `bookingId`) — a rule clause lets the booker, and only the booker, do that release. A
  pending `REQUESTED` booking left the window `OPEN`, so guest cancel there just marks the booking
  `CANCELLED` (see `utils/bookings.ts`). Windows carry a free-form `details` string (not tags).
- **Dates that have been and gone stop being availability.** A slot is live while `end >= today`
  (`isExpired`, `utils/format.ts`) — the same boundary Trips uses to split upcoming from past, so a
  slot and a stay stop being current on the same day. Nothing else ages a window out: `status` only
  ever says OPEN or BOOKED, so without this a slot from last year stayed bookable forever, offered
  in Browse, on a place card, in a friend's view of a room, and through a share link. Filtered in
  all of them. The owner still sees theirs, in a dimmed **Past dates** section of their own room
  page (they're the only one who can clear them), exactly as past trips are shown.

  The same boundary applies to a PENDING ask: a request for dates that have gone drops out of
  "needs your attention" and can no longer be confirmed (the booking page says so and offers
  decline), since confirming would book a stay in the past.

  Filtering — deciding what to *offer* — is client-side, like the overlap check. But **taking** an
  expired slot is refused by the rules, and so is **editing** one apart from removal. `stillCurrent`
  is part of `bookingMatchesOpenSlot`, so a slot nobody has touched since it lapsed can't be asked
  for or instant-booked however the request is crafted: it's still `OPEN`, and its frozen dates
  would otherwise match an ask perfectly.
  The per-slot sheet drops the date fields, the auto-accept switch and the create-a-link control,
  leaving one line of copy and "Remove dates"; the add/edit paths also refuse dates that have already
  passed, since a typed date walks straight past an input's `min`. Behind that, `stillCurrent` pins
  `start`/`end` whenever the EXISTING slot has already ended — the same shape as the BOOKED freeze,
  for a different reason: reviving an old slot would revive the stale asks still pointing at it.
  Comparing an ISO string against `request.time` turns out to be clean enough (`split` + `int` +
  `timestamp.date`), and the boundary is deliberately **yesterday in UTC**, because `request.time` is
  UTC while `isExpired` is local — anyone west of UTC would otherwise be refused an edit the UI had
  just offered them. A slot that already carries a share link keeps its Sharing block once expired,
  or removing the whole slot would be the only way to revoke a token that's still live.
- **A taken slot reads "Booked", it doesn't disappear.** A slot-scope link always shows the slot it
  points at, whatever its state — if someone else got there first, the person you sent it to sees
  that it went rather than an empty page. Wider links list what's free and drop taken dates.
- **Dates going away take their asks with them.** Cancelling a slot (`cancelWindowAsOwner`) and
  deleting a whole listing (`deleteListing`) both cancel every live booking against them — pending
  asks included — in the same batch. Only FUTURE ones: a stay that already happened stays
  `CONFIRMED`, so clearing an old slot off your calendar doesn't retroactively cancel a visit or
  tell the guest their stay was called off after they'd been. Otherwise a guest is left holding a request, or a confirmed
  stay, against dates that no longer exist and nobody can cancel.
- **Owner can cancel a whole slot, any time, any reason.** `cancelWindowAsOwner` (one batch)
  marks every active booking on the window `CANCELLED` and **deletes the window** — distinct from
  decline/cancel above, which reopens the window for a single booking. There is no bare
  delete-window path: the store's `cancelWindow(listingId, windowId)` gathers the window's
  bookings from its live `incomingBookings` and routes through this, so a booked slot's booking
  is never orphaned. Cancelled guests get a `slot-cancelled` notification (stubbed, see below).
- **Auto-accept = first come, first served.** An owner can mark a window `autoAccept`. Booking
  such a window skips approval: `requestBooking` runs a Firestore **transaction** that re-reads
  the window and, only if still `OPEN`, atomically sets it `BOOKED` and writes a `CONFIRMED`
  booking — so two friends grabbing the same window contend on the window doc and exactly one
  wins (the loser gets `"unavailable"`). This is the one place a guest may write someone else's
  window, and the rule scopes it hard: a friend's `windows` **update** is allowed only when the
  existing doc has `autoAccept == true`, it's the `OPEN -> BOOKED` status flip, and every other
  field is unchanged. It must also name a booking **arriving in the same commit** —
  `bookingArrivingWith` uses `getAfter` to require a `CONFIRMED` booking for this caller on this
  slot, the mirror image of `slotHandedTo` checking the same pair from the booking's side. The
  flip used to stand alone, which let a friend mark any auto-accept slot taken without ever asking
  for it: no booking, nothing for the host to decline, and the dates gone. Owners still write
  windows freely (`create`/`delete`/`update`). Non-auto
  windows keep the manual REQUESTED → owner-confirm flow. `setWindowAutoAccept` (owner-only)
  toggles the flag on an existing open window.
- **Search is client-side.** Each user only sees friends' listings (a small set), so Browse
  fetches all friends' listings + windows once (`fetchFriendListings` chunks the `in` filter at
  30 uids) and filters by date/type/distance in `utils/search.ts`. This sidesteps Firestore's
  inability to combine a geo range with a date range, and keeps `firestore.indexes.json` empty.
- **Counting a saved search costs no reads, which is the whole reason it exists.** `refreshBrowse`
  runs in the store provider on mount, unconditionally — so every screen already holds every
  friend's listings and windows. A saved search is just a stored `SearchCriteria`, and its count is
  one `searchListings` pass over data that is already in memory. Ten of them are ten array passes,
  not ten queries. The feature is not literally read-free: `watchSavedSearches` is one more listener
  in the store's owned-subscriptions bundle, costing at most ten documents on attach. It's the
  *counting* that's free, which is the part that would otherwise have scaled with the number of
  searches.

  Capped at `MAX_SAVED_SEARCHES` (10) in the client, because a rule can't count a subcollection.
  Two tabs at nine can both pass the check and land you at eleven — not worth closing, since the
  only person an over-long list costs is the owner loading their own app, and the listener stays
  unbounded deliberately so a search past the cap is still visible and still removable.

  **Two surfaces, and Browse gained no new control.** Home lists them, because that's where you see
  them without going looking. `SavedSearches` (`components/saved-searches.tsx`) is the same list
  again at the BOTTOM of the filter sheet — the place a search is composed is the place to keep one
  or pick one up again. It sits below the sheet's footer on purpose: tweaking dates is the common
  reason to open it, so "Show N places" must stay reachable without scrolling past a list.

  This started as a bookmark icon in the Browse header opening a sheet of its own, and that was
  wrong twice over. One icon doing both jobs couldn't be named — its label said "Saved searches"
  and the first thing inside was a save form — and a bare unlabelled glyph next to the existing
  refresh button wasn't findable at all. Splitting it into two icons would have been worse: a third
  44px circle squeezes a filter pill that already truncates, and two bookmark-ish glyphs are a coin
  flip every time. Folding it into the filter sheet leaves the header as it was.

  Applying one closes the sheet and runs it: picking a saved search is asking for its results, not
  asking to fill the form in. The rows are NOT whole-row tap targets, unlike their neighbours
  elsewhere: removing one needs its own control, and a button can't nest inside a button.

  **Saving refuses an exact duplicate** (`sameCriteria`), shown by replacing the section's "Save
  this one" link with `Saved as "…"` rather than adding a line under it — it's the same fact the
  link would have acted on. That state is what forced `shrink-0` onto `SectionHeading`'s title: a
  user-chosen name is long enough to wrap "Saved searches" onto two lines, and a fixed title should
  never reflow to make room for its action. The guard matters because of the cap: a
  mis-tap silently spending one of ten slots on a copy is worse than the redundant row it makes.
  Compared field by field rather than by JSON, since key order isn't guaranteed and coordinates
  want a tolerance — "Lisbon" geocoded twice is the same search. Radius only counts when there's a
  location for it to be a radius around. Saving the EMPTY search is deliberately allowed even
  though Home's "Open at friends' places" section already computes exactly that set: the badge is
  the difference, and a global "anything new from anyone" watch is otherwise unreachable.

  **"New" needed a field on the slot, and it had to land with the feature.** `windows.createdAt` is
  when the SLOT was added, not what its dates are, and a saved search counts matching slots created
  after its `lastSeenAt` — no trigger, no function, arithmetic on loaded data. Retrofitting the
  field later would have been the bad version: every window written before it exists reads 0, which
  is fine as "not new" but would have meant the first digest either flooded or carried a null
  special-case forever. Opening a search marks it seen, since its results are then on screen.

  Consequence worth knowing: a search you create yourself is seen as of now, so **nothing can be new
  until a slot is added after that moment** — which is why `seed.ts` writes one with an older
  `lastSeenAt` beside a slot added yesterday. It's the only route to that badge.

  Deliberately **no notification** — see the digest note under Known limitations.
- **Geohash for distance.** Listings store a `geohash` (via `geofire-common`) computed from
  lat/lng on write; Browse ranks by `distanceBetween`. Coordinates are optional in the listing
  form for now (no geocoder yet) — distance filtering is a no-op until they're filled in.
- **Live for mine, fetched for theirs.** The store (`utils/store.tsx`) keeps live `onSnapshot`
  listeners on everything the signed-in user owns (prefs, friends, requests, my
  listings + their windows, my trips, incoming bookings) and a manual `refreshBrowse()` fetch
  for friends' listings, plus `tripListings` — a by-id fetch of any listing one of your trips points
  at that isn't already loaded. Without it a stay booked through a share link rendered as "A place":
  the guest pointer permits reading that listing, but nothing was asking for it, since the only
  other fetch is friends-only. A listing that genuinely can't be read stays missing and degrades to
  the same "A place", which is what a deleted one should look like. The user's own **profile IS a Firestore listener** now (`watchOwnProfile`
  → `profile`/`profileReady` in the store): the username and the user-chosen display name live in
  Firestore, not the Auth user, so own-profile views read them live (a display-name edit in Settings
  reflects immediately). `completeOnboarding`/`updateDisplayName` also mirror the name onto the Auth
  user for any fallback reader.

  **The gate settles off that one listener, because a metadata listener is a complete signal.**
  Every wait it can be in ends in something visible: an answer opens the gate, silence names itself,
  and both arrive on the SDK's own bounded timers. The pivot is that a cached absence is the one
  unbelievable snapshot — byte-identical for "no profile" and "offline with nothing cached", and
  believing it would put a returning user through onboarding, whose `createProfile` write merges
  over the name they already have. (A plain listener swallowing it is how a share-link visitor
  wedged on a permanent splash in production.) So `classifySnapshot` (`utils/profile-gate.ts`)
  sorts every snapshot into an ANSWER — the profile from cache or server, or a server-confirmed
  absence — or SILENCE, an absence from cache. What makes one listener sufficient is
  `includeMetadataChanges: true`, load-bearing twice over and probed against the SDK rather than
  reasoned (a previous note here claimed metadata events raise nothing useful; the probe said
  otherwise):
  - **The absent-from-cache event IS the SDK's offline verdict.** Online with a cold cache the
    listener raises nothing until the server answers; the cached miss is raised only once the SDK
    concludes it is offline — first stream failure, or its 10s handshake timer. Three latencies
    prove the reading: ~1ms after `disableNetwork`, ~40ms against a connection-refused backend,
    never on a healthy one.
  - **Recovery re-raises.** Confirming a cached absence changes no document DATA, so a plain
    listener sits on its cached miss forever — that silence is why the old design raced a
    `getDocFromServer` against it. Metadata events turn the `fromCache` flip into an event, so the
    listener that reported silence delivers the real answer ~30ms after the network returns. The
    raced read is deleted; there is no second code path to reconcile.

  **Silence is a third state, and it is never terminal.** `profileUnreachable` renders "Can't reach
  kip right now" in place of the splash, BEHIND the gate — the other reading of an unanswered
  profile is onboarding and an overwrite. It self-heals: a late answer opens the gate and the screen
  unmounts, so **Try again** (a reload) is a fallback, not the mechanism. It also offers **Sign
  out**, the only exit that changes anything when the server is refusing the SESSION itself (a
  disabled account, a revoked token) and a reload hits the same wall. Listener errors count as
  silence too — otherwise a refusal loop exhausting the re-attach budget while the gate is shut
  splashes forever, since the `listenersLost` notice renders only inside the app. The first flip
  records a `profile-unreachable` debug event; retries repeat the failure, not the incident.

  **The one timer of ours guards against the SDK not running, not against the network.**
  `GATE_BACKSTOP_MS` (15s, past the SDK's 10s handshake) fires silence for the case where no verdict
  can arrive because the machinery itself is stalled — a frozen primary tab holding the multi-tab
  cache lease. Firing late or spuriously costs a no-op event: it can never shut an open gate, and a
  later answer still opens a shut one.

  **The transitions are a pure reducer** — `gateStep` in `utils/profile-gate.ts`, pinned by
  `tests/profile-gate.test.ts`, the same split as `reattach.ts`: the effect needs React, Firebase
  and a live session to exercise, the state machine needs none of them. Its invariants are each a
  bug that existed or nearly did:
  - **An opening belongs to a session.** A `generation` re-attach for the uid the gate is open for
    repairs silently — shutting it would splash over an open sheet and any half-typed form — while a
    new uid starts over, since a stale open would render the app around the LAST session's profile.
  - **A verdict belongs to an attempt.** A retry for the same uid keeps a standing `unreachable`
    until something answers; clearing it on each attach flashed error → splash → error at every
    step of the 500ms/2s/6s ladder. A new uid starts clean.
  - **Silence once the gate is open changes nothing** — that is the re-attach machinery's problem.
  - **Never open and unreachable at once**, which is what entitles `page.tsx` to render Unreachable
    only behind a shut gate.
- **Friends-only, and nothing blocks on enrolment.** Nothing is public, so a visitor with no
  session at all only ever sees `components/welcome-screen.tsx`, which says a friend's link is the
  way in and discloses a returning door. **There is no password**, and nothing anywhere says "sign
  up". Three doors, all passwordless, all wrapped by `utils/auth.ts`: an emailed one-time link
  (`sendReturnLink` to come back, `sendAttachLink` to add an address to the account already
  asking), a texted one-time code (US numbers only — that is the SMS region allowlist, and
  `parseDestination` refuses anything else rather than letting the server bill for a refusal), and
  Google.

  Retiring the password took the whole reset flow with it, including the careful "if an account
  exists…" notice: a one-time link goes to an address whether or not kip has met it, so the flow
  has no branch that could leak, and Identity Platform's `enableImprovedEmailPrivacy` backs the
  same guarantee server-side. An address that still HAS a password from before is reached by the
  same link and lands on the same account, so nothing was stranded.

  **A texted code that turns out to belong to an existing account signs INTO it rather than
  linking**, and the uid changes. `confirmPhoneCode` reports that as `sameAccount: false`, and
  callers must branch on it: the account they have just landed in has its own name and photo, so
  writing the sheet's over them is destructive, and a held action belongs to the uid they left.
  Returned and ignored, it silently overwrote a real profile with whatever was typed in a sheet.

  `app/page.tsx` gates in order: `authReady` splash → **`WelcomeScreen`** (no session at all) →
  `profileReady` splash → the app. There is **no onboarding screen**: a missing display name is
  collected by the identity sheet (`components/name-gate.tsx`, and the portal page's own copy) at
  the first action that puts your name in front of someone, so nothing blocks. `AuthMenu` renders
  once there is a name, minus the exit — see the sign-out note in the anonymous bullet.
- **Leaving is possible, and it dismantles rather than departs.** `utils/leave.ts` cancels every
  live stay in both directions, unfriends from your side, deletes requests both ways, removes
  listing photos and the avatar (Storage objects outlive their documents, and afterwards nobody is
  permitted to delete them), then the profile portal, then the profile, then the Auth account. The
  order is load-bearing: the notification triggers read the profile, so it must survive the writes
  that fire them. Client + rules throughout — an Admin-SDK callable that dismantled an account on
  request would be the client-triggerable destructive server path this schema keeps refusing. It
  needed one new rule: `users` had no `delete`, and the `write` rule can never pass for one because
  it names `request.resource.data`, which a delete has none of — so leaving was impossible rather
  than forbidden. Every step is a no-op on what is already gone, so an interrupted teardown is
  finished by running it again, which is what `auth/requires-recent-login` asks for.

  **The handle does not come back**, and that is the one leftover worth saying out loud:
  `usernames/{handle}` has no delete rule by design, so the entry outlives the account it named.
  Nobody else can take that name — but neither can the same person returning with a new uid, since
  `users` write requires the registry entry to point at them. Retired rather than released, which
  is the same trade going private makes, applied permanently.

- **A reaper collects tickets, and Firebase's own must stay off.** `functions/src/reap.ts` runs
  weekly and deletes an anonymous Auth account only when it is idle 30 days AND has no current
  edges — no profile, no live booking either side, no request, no friend edge, no listing, no
  portal. "Current" excludes cancelled and finished stays, or one visit from years ago would keep
  an abandoned account alive forever; the booking window runs to `endedWithin(60d)` so it never
  reaps someone the rules still let a host look up. Any check that errors keeps the account.
  Deleting a real ticket is invisible — the capability was the URL, not the uid, so they come back
  and get a fresh one. **It is armed**, by `REAP_DRY_RUN` in `index.ts` — a plain constant, because
  the env var it replaces defaulted to a dry run when unset and `functions/` has no `.env`, so it
  had never once deleted anything while the privacy page promised that abandoned sessions were
  collected after thirty days. A rehearsal is that line flipped and redeployed: visible in review,
  and impossible to be in without meaning to. Two limits bite: `getUsers` caps at 100 identifiers and
  THROWS past it, and the queries are single-equality with the rest filtered in memory because
  `firestore.indexes.json` is empty and nothing deploys a composite index.

- **No secrets, runs unconfigured.** The Firebase web config is inlined in `utils/firebase.ts`
  (values are public — security is in the rules). The repo currently **ships a populated
  `hafaio-kip-dev` config**, so `firebaseConfigured()` is true and the real sign-in flow runs.
  The unconfigured fallback still exists for a fresh clone with the config cleared: blank the
  `appId` and `firebaseConfigured()` returns false — `authReady` settles immediately on the
  sign-in screen and the sign-in button shows a "not set up yet" dialog — so the app still
  builds and runs before any Firebase project exists.
- **Settings is four sections, and Privacy is one question.** Account (display name, email),
  **Privacy** (findable by username, let friends see where I'll be staying, public profile link),
  **Notifications**, Appearance. Discoverability and stay-visibility were separate sections until
  they were read as the same question — who sees what about you — and merged.
- **Tailwind v4 semantic tokens (Terra).** Warm palette as `--color-*` in `@theme`
  (`app/globals.css`) with `.dark` overrides; components use `bg-surface`, `text-muted`,
  `text-accent-ink` etc. — no raw hex in markup. Terra adds: a terracotta→amber gradient exposed as
  the `--gradient-accent` var + a `.bg-gradient-accent` utility (primary CTAs, avatar rings, Instant
  chips, badges, the wordmark tile, ON switches); `accent-ink`/`success-ink` darker text tones;
  `pending`/`danger-soft` tonal fills for chips; and **layered soft-shadow tokens** `--shadow-soft`,
  `--shadow-card`, `--shadow-panel`, `--shadow-dock`, `--shadow-glow` (Tailwind `shadow-*`
  utilities) that are the primary elevation — **borders disappear except on inputs**. Dark mode uses
  **tonal elevation** (surfaces lighten, shadows nearly vanish) instead of shadow depth. The canvas
  is a warm near-white (`#f6f1ea`) with a faint fixed sunset radial glow; `--radius-*` is bumped to
  Terra's rounder scale (pills for controls/chips, `rounded-2xl`/`3xl` for surfaces).
- **UI primitives = one source of truth for controls (`components/ui/`).** Every interactive
  control is a pill (`rounded-full`) primitive at a single **44px (`h-11`) control height**
  (thumb-friendly on mobile), so nothing looks stranded next to its neighbors: `Button` (variants
  `primary` = gradient + `shadow-glow`, `secondary` = tonal accent fill, `ghost`, `danger` =
  danger-soft fill, `dangerSolid` = solid danger for the dialog's destructive confirm; plus
  `size="lg"` = h-12 for full-width sheet/detail CTAs), `IconButton` (44px circle; `ghost`/`surface`/
  `success`/`danger`; `label` drives tooltip + a11y name), and inputs/selects that match `h-11` at
  `text-base` (≥16px so iOS Safari doesn't zoom on focus) on a **white surface with the only
  visible border + an accent focus ring**. `Sheet` is the shared modal surface (bottom sheet on
  mobile with a drag-handle bar + `rounded-t-3xl`, centered `rounded-3xl` card on ≥sm; backdrop +
  Escape dismiss, scroll-lock); the dialog renders through it. `Segmented` (tonal pill track, active
  = white thumb) and `Switch` (labeled track/thumb, ON = gradient) round out the set. Lists use
  `Group` (a `rounded-3xl bg-surface shadow-card` with near-invisible `divide-y` — the **shadow is
  the separator**, no outer border) + `Row` (`min-h-14`) + `Section`/`SectionHeading` — flat grouped
  lists (iOS-Settings style), one action per surface, whole-row tap targets, never a row that clips
  at 390px. **Status is a soft tonal `Chip`** (`components/ui/chip.tsx`, replaces the old
  editorial byline): a low-contrast pill — `pending` (amber), `confirmed` (green), `open` (accent),
  `booked` (dimmed neutral), `instant` (gradient fill + bolt, white text), `type` (neutral outline
  for `Room`/`Flat`/`House`), `neutral` (cancelled). Low-contrast fills so a chip reads as a passive
  *label*, never as a button — used for slot/booking state, the booking-detail status, and listing
  type. `CountBadge` (same file) is the gradient count pill on nav destinations. Mobile nav is a
  **floating dock** (`FloatingDock` in `nav.tsx`, `md:hidden`, inset from the edges, `rounded-3xl`,
  translucent + `backdrop-blur`, `shadow-dock`; active tab wrapped in an accent-soft pill, badges
  float over the icon); Settings lives in the `AuthMenu` profile menu. (Design was iterated by
  rendering real components via a throwaway unguarded route + headless-Chrome screenshots — see the
  `verify-ui-visually` session memory.)
- **Theming via `next-themes`.** `app/layout.tsx` wraps the app in next-themes'
  `ThemeProvider` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`), so it toggles
  the `.dark` class on `<html>` and injects a pre-paint script (no FOUC); `<html>` carries
  `suppressHydrationWarning`. `theme-button.tsx` (a cycling system → light → dark `IconButton`,
  via `utils/theme.ts` `asThemeChoice`/`nextThemeChoice`/`themeLabel`) sits beside the avatar in
  BOTH app headers (mobile and the desktop `TopBar`) as well as on the sign-in screen and the
  public portal header. Settings keeps the Appearance `Segmented` (System/Light/Dark) too — the
  toggle is the quick reach, the segmented control is where you go to be deliberate. Each is guarded by a `mounted` flag.
- **Terra identity.** One typeface — **Plus Jakarta Sans** (loaded via `next/font/google` in
  `app/layout.tsx` as `--font-jakarta`, wired to `--font-sans`, self-hosted into the static export)
  — for body AND headings; headings just heavier + tighter (`font-extrabold tracking-[-0.03em]`;
  `.font-heading` is repointed to that, not a serif). Base font size **16px**; quiet section labels
  are `text-sm font-semibold text-muted`; dates/counters use `tabular-nums`. The brand lockup is
  `components/wordmark.tsx` — a gradient disc holding a white "k" beside "kip" extrabold — used in
  the mobile top bar (Home), the desktop top bar, sign-in and portal; its `Mark` export is the same
  disc alone, pulsing, on the splash and the share-link page's loading state.

  **Every mark is a circle, and the classes now say so.** They always rendered as circles — Terra's
  radii exceed half of a box this small and CSS clamps border-radius there, so `rounded-xl` on an
  `h-8` tile WAS one. Exactly two missed the clamp and so looked wrong beside everything else: the
  favicon (`rx=18` on 64) and the splash (`rounded-3xl` on `h-16`), which is how the mismatch got
  noticed. They read `rounded-full` now, because a class that disagrees with what it draws is one
  radius-scale change away from squaring every mark off at once — and it already cost two wrong
  answers to "is that a circle or a square?", read off the class instead of the screen.

  The warm terracotta→amber gradient is the accent, applied
  only where it earns attention (CTAs, rings, Instant, badges); elevation comes from layered soft
  shadows in light and tonal lightening in dark. Chrome is borderless canvas: a **mobile top bar**
  (back + screen title or wordmark + `AuthMenu`) and, on `≥md`, a **sticky desktop top app bar**
  (`TopBar` in `nav.tsx` — wordmark + inline nav pills + avatar) that **replaces the old left
  sidebar**; content sits in a `max-w-6xl` centered container. Direction: Airbnb-grade structure,
  but a friends-first, less commercial feel — distinct from a marketplace.
- **In-app dialogs, no browser `confirm`/`alert`.** `components/dialog.tsx` provides
  `DialogProvider` + `useDialog()` returning async `confirm()` / `alert()` (mounted in
  `layout.tsx` around the app). The async API mirrors a native action sheet/dialog, and the UI is
  a **bottom sheet on mobile, centered card on desktop**. All destructive actions (delete
  listing, unfriend, cancel slot) route through it; nothing calls `window.confirm`/`alert`.
- **Every screen has a URL, in the fragment.** `#/`, `#/browse`, `#/person/<uid>`,
  `#/room/<id>`, `#/room/<id>/slot/<windowId>`, `#/room/<id>/edit`, `#/new-place`,
  `#/booking/<id>` — `screenHash`/`screenForHash` in `utils/store.tsx` are an inverse pair and the
  round trip is lossless for every variant of the `Screen` union. `navigate` pushes a real history
  entry, `replace` replaces it, `back` calls `history.back()`, and `popstate` only ever calls
  `setStack` — never a history write, which is what stops the double-entry echo. The fragment names
  the TOP screen only; the stack beneath it is the app's own memory, so a pasted link is seeded as
  `[home, entity]` and `back` at depth 0 replaces in place rather than leaving the site. An
  unparseable fragment resolves to Home and is rewritten, so a bad link never renders nothing.
  Ids in the URL are fine: every one is enforced by `firestore.rules`, and the only capability-
  bearing ids are portal tokens — which live on `/portal/`, whose fragment means something else
  entirely and which every history write skips by pathname.
- **Object-model navigation (client SPA).** The domain is four entities — Person, Room (listing),
  Slot (window), Booking — and the app is a client-side nav stack in the store (`Screen` =
  `tab | person | room | booking | listing-form`, with `navigate()`/`replace()`/`back()`; the
  bottom-bar tabs are the stack's base). `listing-form` is the full-screen listing editor
  (`{ id: string | null }`, null = new; on create, `replace()` swaps it for the new room page);
  everything else transient (filters, the slot editor, add-slot, confirms) is a `Sheet` with
  component-local state, deliberately NOT in the stack. Each entity has a compact card/row for
  lists AND a full page; both are **state-aware** (affordances from viewer-role × state), e.g.
  `SlotRow` shows book/request/pending/booked-by-you. `page.tsx` renders the current screen inside
  the `max-w-6xl` container; the mobile top bar carries the back button + the screen title (the
  wordmark only on Home) + the `AuthMenu`, and on `≥md` a back row sits above the content (the
  desktop nav is the top app bar). Detail/list screens own their desktop layouts — Home and RoomPage
  are 2-col with a right rail / sticky panel, Browse is a card grid, the rest a centered column. The **RoomPage is the single place surface**: owner view (details + an Availability
  grouped list whose rows open a per-slot `Sheet`, a Sharing section, a Guests list, Edit-details →
  `listing-form`, and a quiet Delete) absorbs the old ManageListing + AvailabilityEditor; friend
  view is host-block + an Open-dates list of bookable `SlotRow`s. Browse/Home/Person list results as
  the compact **`PlaceCard`** (host featured on top → `PersonPage`, except `showHost={false}` on the
  host's own page; the whole card taps to the room, no slot rows/buttons inside) — the old
  `RoomCard`/`ListingCard` are retired. Browse's filters live in the store's `criteria` (so they
  survive navigation) behind a filter `Sheet`. Listings have **no tags** (a marketplace pattern that
  doesn't fit a friends app); the free-text `description` carries any detail.
- **Failures that throw nothing report themselves, to a collection nobody can read.** The failures
  worth diagnosing here are silences — a wait that ended, a listener that went quiet — so there is no
  exception and a stack trace would be empty. What matters is the STATE that made the decision, which
  is why `debug` carries a `detail` JSON blob (`utils/debug.ts`, `recordDebugEvent` + `clientState`)
  rather than an error. Three sites write one: the portal ask when it is refused or stalls, the store
  when the re-attach budget runs out, and the profile gate when it turns unreachable. The latter two
  fire once per incident rather than once per retry, since the retries behind them are automatic and
  say nothing new. A portal ask is a person tapping, so every attempt is its own event.

  **The guard vector is snapshotted during render, not read in the effect.** A timer fires up to ten
  seconds after it armed, and reporting the state the effect closed over would describe the moment
  the visitor tapped rather than the moment it failed.

  **It is client-writable and nobody can read it back, which is exactly what separates it from the
  `mail` collection this schema refused.** No recipient, no delivery, nothing to read — so it can't
  be a channel to a person, which was that design's fatal problem. What it CAN do is cost money: any
  signed-in caller may create, anonymous included, and that is deliberate, since a share-link visitor
  is anonymous for most of the flow this exists to diagnose. So the rule pins the writer, the key
  set, both string lengths, `at == request.time`, and an `expires` inside the retention window; the
  TTL bounds the pile. There is **no App Check** (deliberate, project-wide), so a determined script
  can still burn writes — the budget alert is the backstop, and deleting the rules block turns the
  whole facility off with nothing else to unpick.

  **Its worst case is the case it most wants to cover**, and that is worth stating plainly: the write
  goes to the same Firestore that may be what's broken. Firestore queues writes locally and flushes
  on reconnect, so a stall that later clears does report itself — but a tab closed first loses it.
  Best-effort is the whole contract, which is why `recordDebugEvent` swallows its own errors: a
  diagnostic that can fail the thing it is diagnosing is worse than no diagnostic.

  This was chosen over a copy-diagnostics button and over gating on a Firebase Auth custom claim. A
  claim can't attach to a visitor who has no account yet, and doesn't appear client-side until the
  token refreshes — wrong population, on the one page where the population is the whole point.

## Notifications (email, sent by Cloud Functions)

`functions/src/messages.ts` decides WHAT to say and to WHOM — pure, no Firebase — and
`functions/src/index.ts` holds the four Firestore triggers plus the I/O (resolve an address from
Auth, read preferences, send). They're split because the triggers need emulators, real Auth accounts
and an SMTP server to exercise, so in practice they were never run at all; the decisions need none
of that and are covered by `web/tests/notifications.test.ts` (74 cases, incl. the two mirror-image
cancellations, which are the easiest pair to get backwards).

Each notice carries a **`path`, a `cta` label and the OTHER party's `person`**, so every email links
to the thing it's about — a booking event to `#/booking/<id>`, a connect request to `#/friends`,
joined to `SITE_ORIGIN` in `index.ts` (a plain constant, base path included). `renderEmail` is pure
too and produces both an HTML and a text part from ONE template that never branches on the event.
Email clients aren't browsers: tables, inline styles, no webfont, and every gradient painted over a
solid of the same family so a client that drops `background-image` still shows a legible button.

**A photo is attached inline (CID), never linked.** A kip-hosted avatar's URL is an unguessable
bearer capability, and a remote image in an email is fetched — and cached — by the recipient's
client, so a URL in the body hands that capability out. `index.ts` fetches the bytes instead
(https-only, 5s timeout, image content types, 512KB cap checked against the buffer as well as the
header) and nodemailer embeds them; the tests pin that no URL appears in either part. A Google
account photo is already public but goes down the same path, so there's one code path, not two.
Every failure degrades to an initial in a circle and never fails the send. **Nothing is client-triggerable**: a client
can't ask for an email at all, only cause a real state change that warrants one.

- `onBookingCreated` — someone asked to stay (or instant-booked) → the host.
- `onBookingChanged` — confirmed / declined / cancelled → whichever side didn't act.
- `onConnectRequested` — someone asked to be friends → the recipient.
- `onConnectAnswered` — they said yes → whoever asked.

**An acceptance has no event of its own, so it is read off the friend edge.** `acceptRequest` is one
batch that writes both edges and DELETES the request, and declining or withdrawing deletes the same
document — so the trigger is `onDocumentDeleted` on `connectRequests`, and what tells a yes from a
no is whether `users/{from}/friends/{to}` now exists. That one read also supplies the accepter's name
and photo, already pinned by `edgeMatchesWriter` to their real profile, so nothing further is read.

The edge must also POSTDATE the ask (`since > createdAt`, both server timestamps), or a pair who
were ALREADY friends when the request was sent would have their withdrawal reported as an
acceptance. All three routes in now refuse to offer that ask (handle search says "You're already
friends", PersonPage gates on `!friend`, and the portal page on its `Connect` state — which it did
not, and is how this case was found), but the rules don't forbid the write and the trigger can't
assume the client behaved.

**A connect control has three states and a fourth for "not yet".** `Connect` (`app/portal/page.tsx`)
is `ask` | `sent` | `none` | `unknown`, and the control reports whichever it's in WHERE IT STANDS —
a `pending` Chip reading "Friend request sent" in the button's own place, the same swap a slot row
makes between Request and its Requested chip. It used to vanish instead, with a paragraph further
down saying "Sent — they'll get back to you" that spoke for pending DATES as well and named neither.

`unknown` is the one that matters: `standing` is fetched only after the portal doc lands, so an ask
drawn before it answers is a guess, and it was wrong for anyone who had already asked. Friendship is
now read in that same `Promise.all` rather than off the store's live `friends` — one answer arriving
at one moment, no second readiness flag, and consistent with a page where nothing else is live
either. A signed-out visitor skips it entirely: they have no edge and no request, so the ask is live
from the first paint, which is the visitor this page is for.

A decline sends nothing, deliberately: the person who asked learns it by the row disappearing, and
"they said no" is not a message worth delivering to an inbox.

**Why triggers and not a client-written queue.** The old design had the client enqueue into a `mail`
collection with a rule allowing it only between two parties of a shared booking. That could gate
*who* you wrote to but never *what* — an arbitrary body to anyone you'd transacted with, i.e. a
harassment channel. And it structurally couldn't express a connect request, which has no booking to
authorise against. There is now no `mail` collection at all.

**Attribution is stamped, because a trigger can't see who wrote.** Cancelling sets `cancelledBy` and
`cancelReason` on the booking; the rule permits those two fields alongside `status` and requires
`cancelledBy == request.auth.uid`, so you can only ever stamp yourself. That's what lets one update
trigger tell "declined" from "the host moved those dates" from "your stay was called off" — very
different messages to the person receiving them.

**Addresses never touch Firestore.** The function resolves one per send via
`admin.auth().getUser(uid)`, uses it in memory, stores nothing. That's why this is a direct send
(nodemailer → Gmail SMTP) rather than the Trigger Email extension: the extension would park each
recipient's address in a `mail` document, which is the one thing this schema has consistently
refused to do.

**Verified addresses only.** An unverified address is refused outright — otherwise signing up as
`victim@example.com` and having a second account book you would deliver mail to someone who never
gave you their address. Settings says so and offers to resend the verification, since an unverified
account would otherwise just silently receive nothing.

**Per-event preferences** live at `users/{uid}/settings/prefs.notify`, surfaced as a Notifications
section in Settings. Owner-private, but the sender runs as admin so it reads them regardless.

**Every event is defined once**, in `NOTIFY_EVENTS` (`utils/types.ts`): label, description, and its
own default. The `NotifyPrefs` type, `DEFAULT_NOTIFY` and the Settings rows all derive from it, so
adding an event is a single edit and the three can't drift. (The function keeps its own copy of the
KEYS, being a separate package — they must stay in step, since a key that exists on only one side
reads as "not disabled" and always sends.)

Each default is a judgement about that event, not a blanket. They currently all start ON because
every one is transactional, and the reasoning is in the table: `bookingRequested` needs a decision
from you (off, and requests sit unanswered); `bookingTaken` is only news, which is why it's SPLIT
from the ask rather than sharing a switch — it's the most reasonable one to turn off;
`bookingDecision` decides whether you have somewhere to stay; `stayCancelled` is the one you'd
genuinely regret missing, and Settings warns when it's switched off; `connectRequest` is lower
stakes but is the only route in for a stranger holding your link; `connectAccepted` answers
something you asked for, and since a decline says nothing at all, silence would read as one.

Stored as **nothing** until changed: a user who never opens Settings has no `notify` field, and
reads merge over the defaults — so absence means the default, signup writes nothing, and an event
added later picks up its default for existing users too. The toggles stay editable while unverified
(they're preferences for later, and the banner already says nothing sends).

**The verify prompt is on Home, not just Settings.** An unverified account receives nothing at all,
and the only explanation would otherwise sit in a section they'd have no reason to visit. Google
accounts arrive verified, so it only ever appears for password sign-ups.

**One-click unsubscribe is RFC 8058 compliant, verified on a delivered message.** The requirements
are an https URI in `List-Unsubscribe`, a `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
header, a per-recipient URL, a POST that unsubscribes with no further interaction, and — the part
that isn't ours to control — a DKIM signature that COVERS both headers and aligns with the From
domain. Gmail's signature on a real send reads
`d=gmail.com … h=…:list-unsubscribe-post:list-unsubscribe:…`, so both are covered and aligned. It
also *oversigns* (each name appears twice), which means nobody downstream can append a second
`List-Unsubscribe` without breaking the signature.

**The GET acts too, and that is a trade made with eyes open.** 8058 specifies only the POST, so a
browser following the link is out of scope either way — the RFC is satisfied whichever this does.
It used to ask, which stopped a mail gateway prefetching someone into an unsubscribe; but the same
url is a link in the message body, so a page that answers "are you sure?" makes the person who
actually pressed Unsubscribe press a second button to mean it, and that is how "report spam"
happens. The click now wins. The cost is real and bounded: a gateway that fetches every link
silences ONE kind for someone who never clicked, never the account, and the page they'd have seen
carries the undo.

**The page opens with its Save button greyed out and unclickable, and it lights up the moment a
switch is moved.** That is how the page says "this already happened" without needing a second
sentence to say it, and re-ticking the row the email came from is what lights it up — so the undo
is the same control, not an extra one.

It is a real `disabled` attribute, set by `SAVE_SCRIPT` — the only script on any of these pages,
and the reason the "no script here at all" rule was dropped. CSS can *style* a disabled button but
cannot *make* one, and a CSS-only impression of one was worse than it looked: `pointer-events:none`
stops a click but not Enter on a focused button, and a screen reader still announces it as
available. `.save:disabled` then does the styling — a flat neutral fill and muted text in place of
the orange gradient, the same neutral the page gives a switch that's off, because dropping opacity
over the gradient left white text on pale orange that couldn't be read.

**Nothing depends on that script.** If it never runs, Save is simply always pressable, and pressing
it writes back the state already stored — so a blocked script costs the indication and nothing else.
Its test is the `checked` ATTRIBUTE (what the box was RENDERED with, unmoved by clicking) against
`.checked` (live), so a box where those disagree is a box someone moved.

**The row it came from carries a permanent chip and nothing else.** It used to animate its switch
off on load — pure CSS, since a keyframes animation runs on render with no trigger — and that was a
silent bug: the animation's 0.6s delay had backwards fill, so for 0.6s it DREW the thumb on over a
box that was already off. A tap landing in that window turned the row back on, appearing to do
nothing (it was drawn on before and after), silently undoing the unsubscribe. Verified with a
headless-Chrome probe, then deleted rather than patched: the heading says "Unsubscribed" outright,
so nothing was left for it to say.

One judgement call, deliberate: the RFC's model is one message per list, and one-click means "stop
this list". kip has five kinds behind one sender, and the header unsubscribes from **only the kind
that email was about** — the URL is per kind, so that kind IS the list. Someone pressing Gmail's
Unsubscribe may expect all kip mail to stop instead; if that's ever the preferred reading, it's a
one-line change in `send`, with the page keeping the finer control.

**Deliverability is the known weak spot, and a domain is the fix.** Gmail accepts everything
(`250 OK` in the logs) and then files it as spam: a brand-new sender with no history, HTML with an
embedded image, and links to a `github.io` URL is close to what filters distrust by construction.
Authentication isn't the problem — Gmail signs its own outbound, so SPF and DKIM pass. A
`List-Unsubscribe` header pointing at the Settings screen is in (notification mail without one looks
like mail that doesn't expect to be refused), but the rest is reputation, and reputation needs a
domain of kip's own plus a provider whose IPs already have one. Worth knowing that **Gmail never
displays images in a message it has filed as spam**, so the inline photo not rendering is a symptom
of the spam verdict, not a fault in the email — the MIME is `multipart/alternative` →
`multipart/related` with `Content-ID: <kip-photo>`, which is correct.

**Gmail is a starting point, not a commitment.** kip has no domain, so every transactional provider
would be stuck on a shared test sender; a Gmail App Password is already a warm, authenticated one.
Limits: ~500/day, no delivery status, no custom From. Swapping to Resend (or anything else) is this
one file plus one secret — nothing about the events depends on the transport.

The sending address (`kip.hafaio.noreply@gmail.com`) is a plain constant in
`functions/src/index.ts`, NOT a secret. It rides in the `From:` line of every email kip sends, so
there is nothing to keep — Secret Manager would only mislabel it — and it's a send-only mailbox
nobody reads, so being scrapeable from a public repo costs nothing. Only the App Password is a
secret, because it's the only thing that authenticates.

**To turn it on:** `firebase functions:secrets:set GMAIL_APP_PASSWORD` (an App Password, not the
account password), then `firebase deploy --only functions`. Until deployed, nothing sends and
nothing accumulates.

## Photos

A listing carries up to `MAX_PHOTOS` (8) entries in `photos`, each `{ id, url }`; the objects live
in Storage at `listings/{ownerId}/{listingId}/{photoId}`. `utils/photos.ts` owns the round trip.
`uploadListingPhoto` **shrinks in the browser first** (canvas, 1600px max edge, JPEG q0.82), which
keeps the bucket small and, deliberately, re-encodes away EXIF: a GPS tag on a photo of someone's
home should not ride along with a share link. It then mints the download URL once, at upload, and
returns it to be stored. `components/photo-strip.tsx` is the editable strip (owner view of RoomPage
and the listing form; drag or the per-thumbnail arrows reorder, and the first photo is the cover),
`components/cover-photo.tsx` the read-only cover used by `PlaceCard`, the RoomPage hero and the
portal page.

**A new place can carry photos, because its id is minted before it is written.** `newListingId()`
is `doc(collection(…))` — an id with no round trip and no document — so the form uploads to
`listings/{ownerId}/{draftId}/…` straight away and `createListing` `setDoc`s that same id with the
photos already on it. Nothing about the path needs the listing to exist: Storage checks only the
owner in it, and the Firestore create rule pins only `ownerId`. Photos at the moment you have them
to hand is the whole point — being sent to a second screen after saving was the wrong shape.

Two consequences the form handles. Abandoning the form strands whatever was uploaded, so
`ListingFormScreen` deletes it on unmount unless the create went through — in-app only; a closed tab
leaks objects that are owner-only and invisible, which isn't worth a `beforeunload` prompt.
And submitting mid-upload would create the place without the photo still on its way, so the strip
reports `onBusyChange` and the button waits.

**The URL is the capability, and the Firestore listing read is the gate.** `firebase/storage.rules`
is now two lines — `uid == ownerId`, with the owner in the object path — and makes **no**
cross-service calls at all. Everyone else renders a photo by following the unguessable download URL
carried on the listing, so who may see a photo is decided by who may read the listing, which
`firestore.rules` already expresses six ways (owner, friend, confirmed guest, room link, profile
link, slot link).

That is forced, not chosen. Cross-service Rules allow only **two** Firestore lookups per Cloud
Storage request, and the budget is per REQUEST, not per clause — a clause that evaluates false
still spends from it. Measured against the real project: `listing` + a grant (2) reads fine, any
third is a flat 403 with no diagnostic. Reading the listing to learn its owner was already one, so
the six-way mirror could never have worked; guests and every share-link holder got 403 and only the
owner and friends saw anything. Two consequences worth keeping in mind:

- **A photo URL is a bearer token**, like a portal link. Someone you later unfriend can't fetch new
  ones (they lose the listing read) but a URL they already saved keeps working until the photo is
  deleted. That is the same bargain share links make, and a photo they could already see was
  screenshot-able anyway.
- **`photoSrc` pins the origin in the client.** `photos` is a list of maps and rules can't iterate a
  list, so a crafted client could write any address into its own listing and have friends' browsers
  fetch it — a tracking pixel, not script, since it only ever reaches an `<img src`. The renderer
  refuses anything that isn't on our own bucket, which is the right place for it: the client doing
  the rendering is the one at risk.

This also retired `listings/{id}/viewers/{uid}`. It existed solely so a photo check starting from a
listing could name a slot's token; nothing starts from there any more.

## Web build

`cd web && bun install`, and `cd functions && npm install` once (a separate package on the Node
runtime). `bun lint` is the gate and covers BOTH: `tsc && biome check` for the site, then
`tsc --noEmit -p ../functions`. `bun dev` for local dev. `bun export` runs `next build` → static
site in `web/out/`.

## Cloud Functions

`functions/` (Node 22, npm — NOT bun; it targets the Cloud Functions runtime). `cd functions && npm
install`, `npm run build`, `firebase deploy --only functions`.

It holds exactly one thing: notification email (see Notifications). Everything user-facing — share
links included — runs on rules alone, and adding a second function should require an argument that
rules genuinely can't express. This one has one: it needs the Admin SDK to read an address off the
Auth account, which is what keeps email out of Firestore entirely.

## Driving the auth flows locally

The phone door cannot be tested against the real project: reCAPTCHA challenges automation by
design, so a headless run stops at an image puzzle. The **Auth emulator** exists for this — it
skips reCAPTCHA entirely, sends no message, bills nothing, and publishes the code it would have
texted at `GET /emulator/v1/projects/{project}/verificationCodes`.

```sh
cd web && bun dev:emulated
```

One command, and the emulators live only as long as it does — so a plain `bun dev` can never
quietly be talking to a fake backend, and nothing is left listening after Ctrl-C. It needs the same
**JRE** the rules suite does, and says so unhelpfully — `An unexpected error has occurred` with the
real reason buried above it — so export `JAVA_HOME` first. It also holds ports 8080 and 9099, which
the rules suite wants: run one or the other, not both.

**An emulated Firestore starts EMPTY**, which is the one thing worth knowing before using it: real
share links point at portal docs that do not exist there, so every one of them reads as "this link
isn't active". Nothing has been revoked — switching back to `bun dev` restores them. `EmulatorBadge`
says so on screen for exactly this reason; the symptom is otherwise indistinguishable from a bug in
the portal. (Its string is present in a production bundle but unreachable: `usingEmulators()` folds
to false there, so the badge cannot render.)

`utils/firebase.ts` reads that flag and points BOTH auth and Firestore at the emulators — both or
neither, since an emulator-issued token is scoped to the emulator's project and would be refused by
the real database. The condition is ANDed with `NODE_ENV !== "production"`, and that half is what
keeps it out of a shipped bundle: a `NEXT_PUBLIC_*` flag alone compiles to a runtime read, so the
emulator's address travels into the build and only an env var stands between production and
localhost auth. With NODE_ENV in the condition the whole thing folds to a constant and the branch
is eliminated — verified by grepping the export, not assumed.

What this is for, and what it caught: the phone path's whole point is that linking preserves the
uid, and the only way to see that is to count the accounts afterwards. One account with the number
on it means the link worked; two means it silently forked, which is the failure the design exists
to prevent. It also surfaced that a number belonging to someone else is refused at **send** with
`auth/account-exists-with-different-credential` — before any message goes out, which is what makes
falling back to a plain sign-in free rather than a second SMS.

## Driving the share link

`bun run check:portal` seeds a USER-scope portal into the emulator, opens it in headless Chrome and
asserts what a visitor actually sees AND what it leaves behind: the link resolves, the host and
room render, the ask opens the identity sheet, submitting it sends a `REQUESTED` booking — never a
confirmed one, since a link is not friendship — carrying the dates that were shown, and the guest's
profile ends up holding the name they typed. A booking carries no name by design, so the two are
checked separately; that split IS the `knownBy` design, asserted. It also pins two things about the
form itself: a phone number typed while the field reads Email is accepted — the mode sets the
keyboard, never the verdict — and Google stands BELOW the submit after the divider, since it
authenticates first and takes the name from the account rather than the form. It exits non-zero on the
first failure, so it reads like a test even though it cannot gate CI — it needs a browser and a
running dev server:

```sh
cd web && bun run dev:emulated      # one shell, serves on 3001
bun run check:portal                # another
```

It serves on **3001**, not Next's default, so an emulated server can never quietly answer for the
ordinary `bun dev` on 3000 — the two would be indistinguishable in a browser and the emulated one
has an empty database. Both the script and the check are pinned to it; `KIP_ORIGIN` still overrides.

Run it after touching the portal page, the identity sheet, or `utils/auth.ts`. Everything this path
has broken — a link that resolved for nobody, a code step that swallowed a wrong code, a returning
door that never signed anyone in — passed lint, the unit suite and the rules suite while broken,
because none of those can open a page.

**One trap it teaches, worth knowing before writing any emulator fixture:** `connectFirestoreEmulator`
does NOT change the project the SDK thinks it is talking to, and the emulator namespaces data per
project. So a fixture seeded under `--project demo-kip` is invisible to a client configured for
`hafaio-kip-dev`, and every link reads as revoked. Seed under the CLIENT's project id. This cost an
hour and looked exactly like the product being broken.

**The two emulators disagree about which project that is**, which is the same trap wearing a
different hat. Firestore namespaces under the CLIENT's id, for the reason just given. **Auth
namespaces under the id the emulator was STARTED with** (`demo-kip`), because the client
authenticates with a fake API key and there is no project in the request to honour. So a sign-in
link that was definitely sent is simply absent from
`/emulator/v1/projects/hafaio-kip-dev/oobCodes` and sitting in `demo-kip`'s.

**Never scrape a uid out of browser storage.** The SDK moves a session between `localStorage` and
IndexedDB as it sees fit, so a uid read off `firebase:authUser:` was real when read and wrong by the
next page load — and a fixture seeded against it belongs to nobody, which renders as a place that
will not load. Ask the emulator instead: `POST
/identitytoolkit.googleapis.com/v1/projects/demo-kip/accounts:query`.

**And attach to the browser's exceptions from OUTSIDE the page.** `app/error.tsx` catches a render
throw and paints "This page couldn't load" over it, so an in-page `console.error` hook installed
after navigation sees nothing — the stack survives only in CDP's own `Runtime.exceptionThrown` and
`Runtime.consoleAPICalled` events. Both checks now collect those and print them before their
assertions run, so a crash reports its cause rather than its symptom.

## Driving the host's side

`bun run check:host` is the other half of the same booking: `check:portal` is a visitor asking,
this is the person being asked. It signs a host in through the **email door** — the Auth emulator
publishes the link it would have mailed, which is what makes it unattended — seeds a place with one
slot and two asks against it, and then asserts what the host sees: a **count on the row** in
Availability, both askers **named inside the slot**, oldest first, sitting **above the date fields**,
and the open slot **named in the URL**.

```sh
cd web && bun run dev:emulated      # one shell, serves on 3001
bun run check:host                  # another
```

Then it books the slot out from under those asks and checks the losers are still listed BELOW the
stay that won, and finally that opening a slot leaves the host's scroll position alone.

Each of those is a bug the other suites cannot see. The count is what makes the requests
findable at all — without it a slot two people are waiting on looks exactly like an untouched one.
The ordering is first-come, which is the only ordering the host has reason to read. The position is
what makes the confirm that cancels those asks legible BEFORE a date is touched. And the URL is what
lets the host tap through to a request and come back to the slot they left open, since the sheet is
component state and a room page that has forgotten which slot was open is where they landed
otherwise.

One thing it caught immediately, worth keeping: **a listing with no `location` crashes the room page
outright** (`DetailBlock` reads `listing.location.label`). Unreachable in production — every write
path sets one — so this is a note about FIXTURES, not a bug: seed the field, or spend the time
reading a stack trace for a state that cannot exist.

## Security-rules tests

`firestore.rules` is the only enforcement, so the security-critical paths are tested against the
Firestore emulator with `@firebase/rules-unit-testing`: `cd web && bun run test:rules` (the suite
lives in `web/tests/rules.test.ts`; plain `bun test` won't run it).

The emulator needs a **JRE** — if `java` isn't on PATH, point it at one first, e.g.
`export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` and prepend
`$JAVA_HOME/bin` to PATH. The suite covers: **portals** (owner-only mint, public read-by-id,
non-enumerable, owner-only revoke) and **grants** (claim requires a real token, can't be claimed in
someone else's name, unlocks live dates, dies instantly on revoke/regenerate, a slot link exposes
only its own dates, one visitor's grant is useless to another); **connectRequests** by both routes
(searchable recipient, or a live link — forgery blocked, id shape, party-only read, and a pending
one can't be refreshed once its link is revoked or rewritten to claim someone else's); **bookings**
(dates must match an OPEN slot at ask AND confirm, dates that have gone can't be asked for at all,
a slot holds one stay, a slot is born free, a
link visitor can never instant-book, no client-writable mail, cancellation attribution can't be
pinned on the other party); **guest access** (a `{bookingId}` pointer, inert once the booking isn't
CONFIRMED); **slots** (a booked slot's dates are frozen, notes still editable; an expired slot's
dates are frozen too — not even by a day — while notes and delete still work, and a slot ending
TODAY stays editable, which pins the deliberate UTC-vs-local slack); **friend edges**
(you may heal only the entry describing you, you may read only your own side, and an edge that
isn't there ANSWERS rather than denying — the portal's `areFriends` asks about a stranger every
time, and a rule touching `resource.data` would refuse it and strand the connect control on
`unknown`, which is exactly what `connectRequests` does); the **usernames registry + profile integrity**; the
**discovery gate**; **saved searches** (owner-only, not listable, not plantable by anyone else);
**shared stays** (a friend of the guest reads the booking, a friend of only the host reads the SLOT
but not the booking, sharing off closes it and back on reopens it, absent prefs counts as NOT sharing,
a request or cancellation is never shared, planting a friend edge on your own side proves nothing,
and the feed's query is refused without its status filter); and
the **browse lookup budget** (20 distinct friends passes, 25 fails); and **debug events** (anyone
signed in may add one including an anonymous visitor, nobody may add one in another's name, the
shape and size caps hold, the timestamp can't be chosen, an expiry past the retention window is
refused, and nobody — the author included — can read, edit or delete one).

Any fixture the expiry rule touches uses `isoIn(days)`, not a date literal — a hard-coded date
silently changes meaning as the calendar walks past it, and "the host can freely edit an open slot"
would have started failing on its own.

If port 8080 is already held by another project's emulator, switch both `firebase.json` and the
`port:` in `rules.test.ts` to 8085 and restore them after.

## Firebase setup (do once)

1. Create a project named **`hafaio-kip`** (or rename in `.firebaserc`) at console.firebase.google.com.
2. **Authentication → Sign-in method →** enable **Google**, and **Email/Password** — the latter
   only because email-link sign-in rides on that provider; kip asks for no password anywhere.
3. **Firestore Database →** create (production mode).
4. **Project settings → Your apps → Web →** register an app; copy the config object into the
   `firebaseConfig` in `web/utils/firebase.ts` (replacing the shipped `hafaio-kip-dev` dev
   config). A blank `appId` makes `firebaseConfigured()` false and disables sign-in — the
   unconfigured fallback — so keep a real `appId` for a working build.
5. **Blaze plan** — required for Cloud Functions, which public share links now depend on. Set a
   Cloud Billing budget alert while you're there.
6. **Auth providers, and the one switch that must stay off.** Authentication → Sign-in method:
   enable **Email link (passwordless sign-in)** (it rides on the Email/Password provider) and
   **Phone**; set the **SMS region policy** to allowlist with **United States** only — the primary
   toll-fraud control, and adding a region later is the same page with nothing to redeploy. Add
   fictional **test phone numbers** there too, since phone auth refuses localhost and there is no
   other way to exercise it locally outside the Auth emulator. Optionally turn on **reCAPTCHA SMS
   defense** in audit mode; with US-only plus the per-IP caps, audit is likely enough indefinitely.
   Confirm `hafaio.github.io` and `localhost` are authorized domains — the sign-in link redirects
   there. And **anonymous account auto-deletion must be OFF** (it lives on the Anonymous provider,
   not under Settings): it cannot read Firestore, so it cannot tell a one-visit ticket from someone
   carrying a name, a live ask and friendships, and re-enabling it deletes real people on a timer
   with nothing failing loudly. `reapAnonymousTickets` is what collects tickets instead.
7. Deploy rules: `firebase deploy --only firestore:rules` (add `storage` once photos are on, and
   `functions` once notifications land). Public share links need **Anonymous** sign-in enabled and a
   Firestore **TTL policy** on the `grants` collection group, field `expires` (housekeeping only —
   an expired grant is already inert). The `debug` collection wants the same policy on the same
   field, and there it is the only thing bounding the pile.
8. **Authentication → Settings → Authorized domains:** add the deployed domain (e.g.
   `<user>.github.io`) so sign-in works in production.

`hafaio-kip-dev` is already on Blaze and already upgraded to **Identity Platform**
(`subtype: IDENTITY_PLATFORM`), with anonymous sign-in enabled and
`enableImprovedEmailPrivacy: true`. **`autodeleteAnonymousUsers` must be OFF** — it cannot read
Firestore, so it cannot tell a one-visit ticket from a participant with a name, a live ask and
friendships, and re-enabling it deletes real people on a timer with nothing failing loudly. Sign-up volume is deliberately NOT capped: kip has no public
discovery surface, so an account nobody has friended can see nothing and growth is invite-shaped by
construction. If that ever changes, a `beforeUserCreated` blocking function plus a counter doc is
the additive fix (note anonymous auth bypasses blocking functions).

## Deployment

`.github/workflows/web.yml` (manual `workflow_dispatch` or a published Release) does the whole
release: CI gate → **Firebase** (rules + functions) → GitHub Pages (`bun export` with
`NEXT_PUBLIC_BASE_PATH=/<repo>`, uploads `web/out`).

**Firebase goes first, deliberately.** The site must never publish expecting rules or triggers that
aren't live yet; if that job fails, Pages never runs and the site stays on the last good version.
Rules deploy every time (seconds, idempotent); functions too, since working out whether they changed
since the last release is more trouble than just deploying them.

**Auth is Workload Identity Federation — no key is stored anywhere.** GitHub mints a short-lived
OIDC token (that's what `id-token: write` in the workflow is for) and GCP trades it for impersonation
of `kip-deployer@hafaio-kip-dev.iam.gserviceaccount.com`. The provider only accepts tokens whose
`repository` claim is `hafaio/kip`, so no other repo — and no leaked file — can use it. Set up once
with:

```
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc kip-deploy --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository == 'hafaio/kip'"
gcloud iam service-accounts add-iam-policy-binding kip-deployer@... \
  --role=roles/iam.workloadIdentityUser \
  --member=principalSet://iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/github/attribute.repository/hafaio/kip
```

The deployer holds `firebase.admin`, `cloudfunctions.admin`, `run.admin`, `artifactregistry.admin`,
`cloudbuild.builds.editor`, `iam.serviceAccountUser`, `serviceusage.serviceUsageConsumer` and
`secretmanager.admin`. That is a powerful principal — it can deploy code that runs with admin access
to the database — which is exactly why it's reachable only from this repo and never as a stored key.

`bun run test` runs everything that needs no emulator: plain `bun test` with the rules suite
excluded by path, since that one does. It was an ALLOWLIST of filenames, and that list was copied
into `ci.yml` as well — where it then stayed behind, so `search` and `reattach` were written, passed
locally, and never once ran in CI. One exclusion beats four inclusions: a new suite is now picked up
by both without editing either. `ci.yml` runs the script rather than its own copy for the same
reason. Note the exclusion has to be the `--path-ignore-patterns` FLAG and not a `bunfig.toml`
`[test]` entry — bunfig's version also wins over an explicitly named file, which makes `test:rules`
match nothing at all. The suites: the notification
decisions above; the re-attach decision (`decideReattach`, see Known limitations); the profile-gate
decision (`gateStep`, when the gate opens, shuts and gives up — see the store bullet); the
saved-search arithmetic (`countNewSince` ignoring slots written before
`createdAt` existed and counting slots rather than places; `sameCriteria` treating one place
geocoded twice as one search); and a drift
check that pins the vocabulary the two packages share but can't import across
(`NotifyKind`, cancel reasons). That drift **fails open** — the function reads `prefs.notify[kind]`,
and a key the web side never writes is `undefined`, which `=== false` treats as "not disabled", so a
rename silently starts emailing people who opted out. The test makes it break CI instead.

CI (`ci.yml`) is one job, because `bun lint` covers BOTH packages — it ends with
`tsc --noEmit -p ../functions`, so breaking a trigger fails the same command you already run. It
does mean `functions/` must have its deps installed (`npm ci` there, which CI does before linting);
without that, tsc can't resolve the firebase-functions types.

## Shipped

kip is live at `https://hafaio.github.io/kip` (the repo is public), released by
`.github/workflows/web.yml` on 2026-07-30 — the first run of that workflow, which deployed rules and
all four functions (`onBookingCreated`, `onBookingChanged`, `onConnectRequested`, `unsubscribe`)
before publishing Pages, exactly as designed. `hafaio.github.io` is an authorized domain in Firebase
Auth, the Gmail App Password secret is set, and `SITE_ORIGIN` in `functions/src/index.ts` matches
where Pages actually serves.

**`hafaio-kip-dev` IS production**, despite the name — `.firebaserc` and the config in
`web/utils/firebase.ts` both point at it, and it carries no seed data (the seed script's output was
never left in it). Standing up a separate `hafaio-kip` would mean redoing the whole one-time setup:
rules, storage, functions, secrets, WIF, authorized domains.

**Nothing has been exercised on production by a second person.** Every state that needs two
accounts — a friendship, a booking, a notification email actually landing — has only ever been
tested locally or against the rules emulator. Notification email in particular is now live and has
never sent from the deployed functions; see the deliverability note under Notifications for what to
expect when it does.

## Known limitations / next steps

- Geocoding is via OpenStreetMap Nominatim (`utils/geocode.ts`): the listing form takes an
  address and looks up lat/lng/geohash (free, key-less, low-volume). Swap for Google/Mapbox if
  precision/volume demands. No autocomplete yet — it's a single lookup on "Find" or at submit.
- Friends' listings refresh on demand (`refreshBrowse`), not live.
- **A lost listener is re-attached, and giving up is said out loud.** A Firestore snapshot error is
  TERMINAL — the SDK drops that listener and never retries — so `onSnapshotError` (`utils/firebase.ts`)
  logging and returning left the screen frozen on its last snapshot, still styled as live. That is
  worse than an error: nothing looks wrong, and a place you just added simply never appears. It now
  also fires `onListenerLost`, and the store re-attaches every owned listener by bumping a
  `generation` counter that the three subscription effects depend on.

  **The decision of WHEN to re-attach is a pure function** (`utils/reattach.ts`, `decideReattach`),
  split out for the same reason `messages.ts` is: the effect around it needs React, Firebase and a
  clock to exercise, the decision needs none of them, and `tests/reattach.test.ts` pins it. Backoff
  is `REATTACH_DELAYS` (500ms / 2s / 6s) and the burst is **debounced to one re-attach** — the owned
  listeners all die together whenever the token is what's refused, so nine losses must buy one retry,
  not nine. **Three RETRIES, so the fourth loss is the one that gives up**: an easy thing to state
  wrongly, and the first version of this note said "three refusals" for a state machine that takes
  four. `listenersLost` then puts a notice on every screen offering a reload — a client cannot talk a
  server out of a denial, so the honest move is to stop pretending the data is live. A loss arriving
  after `REATTACH_QUIET` (60s) is a NEW incident and refills the budget, otherwise one hiccup early
  on would leave a long session permanently one loss away from the notice. Signing in or out clears
  the counters **and any pending timer** — sign-out is itself a reliable way to kill every listener
  at once, and since a live timer IS the burst guard, leaving one armed would swallow the new
  session's first real loss.

  **A re-attach must not reset `profileReady`.** `page.tsx` renders a full-screen splash whenever
  that is false, so resetting it mid-session blanks the whole app — unmounting an open sheet and any
  half-typed form — which is the exact opposite of the invisible repair this mechanism exists to be.
  Which session an opening belongs to is now `gateStep`'s job (see the store bullet) — it reopens
  the gate only when the SESSION changes, never when `generation` bumps. This was live for one
  commit and is the kind of thing that only shows up by driving the real UI.

  The two benign races the old comment named are still benign and now heal on the first retry (auth
  tearing down on sign-out; a windows listener racing a just-created listing — the windows effect
  also still skips listings with `createdAt === 0`). Verified against the emulator by swapping
  deny-all rules under live listeners: a *live* listener is proved only by changing a document
  underneath it and watching the screen follow, since a frozen screen still looks populated.
- Dev seeding: `bun run scripts/seed.ts <your-email>` (Admin SDK, ADC; needs `firebase-admin`,
  a devDependency) builds a whole world around your account — friends with and without
  handles/photos/places, incoming and outgoing connect requests, places of all three types, slots
  that are open / Instant / booked / expired, bookings from both sides in every status including
  all five cancel reasons, thirteen share links covering each scope plus a dead token, and a saved
  search whose "new" badge is live. It ends by
  **printing where to find each state**, which is the point: most of these surfaces are otherwise
  unreachable without a second real account. Set `KIP_ORIGIN` if `bun dev` isn't on port 3000.

  It is **idempotent by construction**: every document it writes is named `seed_…` or lives under
  a user that is, so the wipe at the start is a documentId range scan (plus the two cases whose ids
  the schema dictates — a `${from}_${to}` connect request, and the friend edges and saved searches
  under your real account). Dropping an entry from the file really removes it. One side effect worth knowing: it
  sets your own `prefs.profilePortalId`, so a profile link you'd already shared is replaced.

  What it can't cover, and why: onboarding and the unverified-email banner live on the Auth
  account, not Firestore; photo states need bytes in Storage, and seeding `photos` with URLs that
  point at nothing would just render broken images.
- Double-booking is closed. Confirming is a **transaction** (`confirmBooking`) that re-reads the
  slot inside the commit and aborts if anything touched it, so of two confirms racing on one slot
  exactly one wins and the other gets `"unavailable"` and an explanation. The rules also refuse the
  sequential case (`bookingMatchesOpenSlot` requires an OPEN slot), but rules alone couldn't cover
  two commits landing at the same instant — both would evaluate against a slot that was still open.
  Same guarantee instant booking has always had.
- The friends'-stays feed is capped at five rows on a PersonPage and is not on Home. Where someone
  is going is a glance, not an inbox — see the design bullet on `shareStaysWithFriends`.
- Notification email is built (`functions/src/index.ts`) but sends nothing until the Gmail secrets
  are set and the functions deployed — see Notifications above.
- `firebase/storage.rules` is owner-only and has no emulator suite, but it no longer needs one: it
  makes no cross-service calls and says one thing. The visibility it used to duplicate is tested on
  the Firestore side. Photos were verified end to end against the real project — upload, reorder,
  the cover following the reorder, and a share-link visitor loading one.
- A TTL policy on `grants` (field `expires`) IS configured on `hafaio-kip-dev`
  (`gcloud firestore fields ttls update expires --collection-group=grants --enable-ttl`). Note each
  visit slides the expiry forward, so a returning visitor's note never ages out — deletion is for
  people who stop coming back. Deletion is best-effort within ~24h of expiry, which is fine because
  an expired note already authorises nothing.
- **The `debug` TTL is configured too** and is ACTIVE on `hafaio-kip-dev`
  (`gcloud firestore fields ttls update expires --collection-group=debug --enable-ttl`). Unlike the
  grants one it is load-bearing rather than hygiene: nothing else removes an event, and nobody can
  delete one by hand — the rules refuse it to every client. Retention is **7 days**, set by the
  client (`KEEP_DAYS`) and capped at 14 by the rule, which is enough to still be there when someone
  reports a problem and short enough that this isn't a standing record of who visited. Reading them
  needs the Admin SDK or the console, by design.

  (`gcloud firestore fields ttls list` also shows an ACTIVE policy on `viewers`, left over from the
  `listings/{id}/viewers/{uid}` collection that photos retired. Harmless — it matches nothing.)
- **Rotating the unsubscribe key is unbuilt and deliberately deferred.** Each user has an
  unguessable key in their prefs; a one-click unsubscribe link carries it, so knowing it IS the
  permission (the same shape as a share link). It does NOT rotate. Rotating on a settings change
  would kill the unsubscribe link in every email already delivered, and a *broken* unsubscribe is
  worse than none — that's precisely when someone reaches for "Report spam", which is the signal
  that actually damages sender reputation. The key's whole authority is "turn off one kind of mail
  for one user", undoable in Settings in a tap, so there's little to protect. If it's ever wanted it
  belongs as an explicit "invalidate my links" control, the way regenerating a share link is
  explicit — not as a side effect of unrelated edits.
- **Share links want a revisit, and it is mostly a UI question.** A link today is a bare
  capability: one per scope, no name, no message, and control buried in the surface that owns it
  (a room's Sharing section, a slot's sheet, your own PersonPage). Three things to think about
  together, since they interact:

  **Several links per thing, each named.** One per scope means revoking is all-or-nothing — kill
  the link you sent your sister and you kill the one you sent your colleague. Named links make
  revocation precise and make an inbox of them legible. The schema barely resists: `portals/{uuid}`
  is already keyed by an unguessable id, so the constraint is the single `publicPortalId` field on
  the thing being shared, which would become a list and force the rules' `portalGrant(...)` checks
  to iterate — and a rule cannot iterate a list. That is the real obstacle and it needs a design,
  not just a field change.

  **A message from the host.** The largest remaining gap in FEEL: a share link reads as a database
  view someone unlocked rather than an invitation from a person. Partiful's warmth is mostly host
  expression, and that part transfers to kip's quiet register cheaply — one optional line on the
  portal doc, rendered under the host block. It pairs naturally with naming: the message is
  per-link, which is another argument for several.

  **Sharing should start where the thing is.** Erik's instinct: a **share icon on each date range**
  that opens the link controls in place, rather than making someone find the slot's sheet. The
  general shape is that sharing is an action ON a room or a set of dates, and today it is a
  section you navigate to. Worth thinking about whether the same treatment belongs on a room card
  and on your own profile.

- **SMS notifications are the obvious next step, and the long pole is paperwork.** A phone-only
  account is durable but unreachable: every notification kip sends is email, so someone who proved
  a number and never added an address hears nothing until they open the app. The reach card is the
  standing answer; SMS is the real one.

  It needs no new function — it rides the four triggers that already exist, and the number is read
  per send off the Auth account exactly as the address is, so it never touches Firestore. Twilio
  keeps its own message logs, which is the honest caveat: the confinement is a shade weaker than
  email's.

  **The gotcha that decides the schedule: US A2P 10DLC registration.** Unregistered
  application-to-person traffic to US numbers from a 10-digit number is a HARD BLOCK, not
  degraded delivery — [blocked since 1 September 2023](https://www.twilio.com/en-us/changelog/-u-s--a2p-10dlc--full-blocking-of-traffic-sent-from-unregistered),
  returning [error 30034](https://www.twilio.com/docs/api/errors/30034), and Twilio still bills for
  the blocked send. Brand and campaign registration runs through TCR with a vetting fee, monthly
  campaign fees, and a review measured in days — so file it FIRST; the code is not the long pole.
  Worth addressing the "but I've sent Twilio texts instantly" memory head-on, because it is a
  reasonable one: a trial account texting its own verified numbers still works, as does non-US.
  One thing this gets right that kip's email does not: a blocked SMS fails loudly with an error
  code, where Gmail accepts everything and silently files it as spam.

  **Four events would justify one**, not all six: `bookingRequested` (a decision is wanted),
  `bookingDecision` (answers your dates), `connectAccepted` (the share-link visitor's first ask,
  and they are exactly the no-address population), `stayCancelled` (the one you would regret
  missing). Out: `bookingTaken` and `connectRequest`, which are news, to people who have an
  address anyway.

  **Preferences become event × channel**, still derived from the single `NOTIFY_EVENTS` table.
  Stored as a SECOND merge-over-defaults map beside `notify`, so nothing migrates — absence
  already means the default. The cross-package drift test must then pin kind × channel, since the
  fail-open failure it exists to catch gets twice the surface.

  Also: **STOP is carrier-enforced and outranks kip's Settings**, and TCPA consent lands on the
  sheet's number field — neither maps onto the `List-Unsubscribe` machinery already built.

- **Emailing a saved-search digest is deferred, and the reasons are specific.** Saved searches ship
  without any notification: the in-app count and "new" badge are free, and the email is the
  expensive 20%. Two things to know before building it.

  **Fan-out is inverted but naturally bounded.** A trigger fires on one window write and has to find
  every saved search that matches — result→queries, not query→results. The saving grace is that only
  friends can see a listing and friend edges are denormalized both ways, so
  `users/{ownerId}/friends` enumerates every possible recipient in one query. You never scan all
  searches; the social graph bounds it. Even so, prefer a **daily scheduled digest over a per-write
  trigger**: availability isn't urgent, a host adding a week of dates writes several windows in one
  sitting, and a digest collapses that into one email and one run regardless of write volume.

  **The blocker is duplication, not cost.** `searchListings` lives in `web/utils/search.ts` and the
  two packages can't import across each other — the same reason `NotifyKind` needs a drift test.
  Reimplementing date overlap, type and `distanceBetween` in `functions/` is a far bigger drift
  surface than a handful of string keys, and a divergence is user-visible in the worst way: the
  email says "3 new places" and the app shows none. Anyone building this should pin both sides with
  shared fixtures first.

  It would also be the first non-transactional notification here — every existing one is 1:1 and
  caused by a person acting on you. That argues for its own entry in `NOTIFY_EVENTS` defaulting OFF,
  unlike the other five.
- **A calendar view is an idea on the back burner**, not a planned next step. Everything is read as
  lists today, and a month grid might make a host's own year legible in a way rows can't. Noted
  because nothing in the schema blocks it — windows are ISO date ranges, so it would be a rendering
  job rather than a migration — not because it's queued.
- Native Android/iOS apps are a future phase.
