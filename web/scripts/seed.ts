// Dev-only seed, via the Admin SDK and ADC:
//
//   cd web && bun run scripts/seed.ts [your-email@example.com]
//
// Sign into the app once first, so your users/{uid} profile exists.
//
// Everything is named after the case it tests, so the names are a checklist you
// read off the screen. Every document is `seed_…` or lives under one, which is
// the whole cleanup story — a re-run wipes by prefix, so dropping an entry from
// this file really removes it. Shapes are the ones the CLIENT writes, not merely
// ones the rules accept; seeding a shape the app can't produce is worse than
// useless.

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  FieldPath,
  type Firestore,
  getFirestore,
  type QueryDocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { geohashForLocation } from "geofire-common";
import type {
  BookingStatus,
  CancelReason,
  ListingPhoto,
  ListingType,
  WindowStatus,
} from "../utils/types";

const PROJECT_ID = "hafaio-kip-dev";
// `photoSrc` compares against exactly this name, so any other spelling renders
// as a blank card.
const BUCKET = `${PROJECT_ID}.firebasestorage.app`;
const REAL_EMAIL = (process.argv[2] ?? "erik.brinkman@gmail.com").toLowerCase();

// Their uid isn't known until the account is resolved.
const ME = "{me}";

// Override to build a second world alongside the first. Every id, and the whole
// cleanup range, derives from it.
const SEED = process.env.KIP_SEED_PREFIX ?? "seed_";
// One past the prefix, for the id-range queries that find the previous run.
const SEED_END = `${SEED}`;

// Overridable because `bun dev` moves off 3000 whenever it's taken.
const APP_ORIGIN = process.env.KIP_ORIGIN ?? "http://localhost:3000";

// Firestore caps a batch at 500 and this world is bigger, so the all-or-nothing
// commit is given up — a half-built world is repaired by re-running.
const BATCH_LIMIT = 400;

// An `in` filter takes at most 30 values, and the cast is close to that.
const IN_LIMIT = 30;

// From the day the seed runs, on the same UTC boundary `todayIso()` uses, so
// "expired" here means expired to the app.
function day(offset: number): string {
  const when = new Date();
  when.setUTCDate(when.getUTCDate() + offset);
  return when.toISOString().slice(0, 10);
}

function daysAgo(count: number): Timestamp {
  return Timestamp.fromMillis(Date.now() - count * 86_400_000);
}

// A real object, because `photoSrc` only renders trusted origins. The URL is
// minted before the object exists, since every copy of this person carries it —
// `uploadAvatars` then writes the same token into the object's metadata.
type SeedAvatar = {
  readonly token: string;
  readonly initial: string;
  readonly background: string;
};

const AVATARS = new Map<string, SeedAvatar>();

function avatarUrl(uid: string, initial: string, background: string): string {
  const token = crypto.randomUUID();
  AVATARS.set(uid, { token, initial, background });
  return objectUrl(avatarPath(uid), token);
}

function avatarPath(uid: string): string {
  return `avatars/${uid}`;
}

// The token IS the capability, so it must match the object's metadata.
function objectUrl(path: string, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`
  );
}

async function uploadAvatars(): Promise<number> {
  const bucket = getStorage().bucket(BUCKET);
  for (const [uid, avatar] of AVATARS) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" fill="${avatar.background}"/>` +
      `<text x="32" y="43" text-anchor="middle" fill="#ffffff"` +
      ` font-family="sans-serif" font-size="30" font-weight="700">${avatar.initial}</text>` +
      `</svg>`;
    await bucket.file(avatarPath(uid)).save(Buffer.from(svg), {
      metadata: {
        contentType: "image/svg+xml",
        metadata: { firebaseStorageDownloadTokens: avatar.token },
      },
    });
  }
  return AVATARS.size;
}

type SeedPerson = {
  readonly uid: string;
  readonly displayName: string;
  // "" leaves the profile with neither field, as onboarding does.
  readonly username: string;
  readonly photoURL: string | null;
  readonly searchable: boolean;
  readonly joined: number; // days ago
  // null = not a friend; undefined leaves `since` unwritten, as old edges are.
  readonly friendSince: number | null | undefined;
};

// The registry keys on the handle alone, so a second world must not reuse one.
const HANDLE_SUFFIX = SEED === "seed_" ? "" : `_${SEED.replace(/_+$/, "")}`;

// Eight friends, more than Home's rails show, so the caps are visible.
const CAST: readonly SeedPerson[] = [
  {
    uid: `${SEED}fr_photo`,
    displayName: "Friend · photo and handle",
    username: "fr_photo",
    photoURL: avatarUrl(`${SEED}fr_photo`, "F", "#dd5f38"),
    searchable: true,
    joined: 400,
    friendSince: 240,
  },
  {
    uid: `${SEED}fr_plain`,
    displayName: "Friend · no photo",
    username: "fr_plain",
    photoURL: null,
    searchable: true,
    joined: 300,
    friendSince: 120,
  },
  {
    // Arrived through a share link, so there was never any reason to claim one.
    uid: `${SEED}fr_nohandle`,
    displayName: "Friend · no handle",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 90,
    friendSince: 30,
  },
  {
    uid: `${SEED}fr_empty`,
    displayName: "Friend · shares nothing",
    username: "fr_empty",
    photoURL: avatarUrl(`${SEED}fr_empty`, "E", "#2e9c6d"),
    searchable: true,
    joined: 500,
    friendSince: 380,
  },
  {
    // `since` deliberately unwritten, so the host block reads "You're friends"
    // with no year behind it.
    uid: `${SEED}fr_nosince`,
    displayName: "Friend · no since date",
    username: "fr_nosince",
    photoURL: null,
    searchable: true,
    joined: 200,
    friendSince: undefined,
  },
  {
    uid: `${SEED}fr_host`,
    displayName: "Friend · hosts my stays",
    username: "fr_host",
    photoURL: avatarUrl(`${SEED}fr_host`, "H", "#8a5cf6"),
    searchable: true,
    joined: 250,
    friendSince: 200,
  },
  {
    uid: `${SEED}fr_guest`,
    displayName: "Friend · stays at mine",
    username: "fr_guest",
    photoURL: null,
    searchable: true,
    joined: 180,
    friendSince: 160,
  },
  {
    uid: `${SEED}fr_guest2`,
    displayName: "Friend · the second asker",
    username: "fr_guest2",
    photoURL: avatarUrl(`${SEED}fr_guest2`, "S", "#c98a1a"),
    searchable: true,
    joined: 120,
    friendSince: 90,
  },

  // One per route in. Only the handle route needs them searchable.
  {
    uid: `${SEED}out_handle`,
    displayName: "Asked them · found by handle",
    username: "out_handle",
    photoURL: avatarUrl(`${SEED}out_handle`, "A", "#dd5f38"),
    searchable: true,
    joined: 45,
    friendSince: null,
  },
  {
    uid: `${SEED}out_user`,
    displayName: "Asked them · via their profile link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 40,
    friendSince: null,
  },
  {
    uid: `${SEED}out_room`,
    displayName: "Asked them · via their room link",
    username: "",
    photoURL: avatarUrl(`${SEED}out_room`, "R", "#2e9c6d"),
    searchable: false,
    joined: 38,
    friendSince: null,
  },
  {
    uid: `${SEED}out_slot`,
    displayName: "Asked them · via their date link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 36,
    friendSince: null,
  },

  // The mirror image, by the same four routes.
  {
    uid: `${SEED}in_handle`,
    displayName: "Asked me · found by handle",
    username: "in_handle",
    photoURL: avatarUrl(`${SEED}in_handle`, "I", "#8a5cf6"),
    searchable: true,
    joined: 30,
    friendSince: null,
  },
  {
    uid: `${SEED}in_user`,
    displayName: "Asked me · via my profile link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 28,
    friendSince: null,
  },
  {
    uid: `${SEED}in_room`,
    displayName: "Asked me · via my room link",
    username: "",
    photoURL: avatarUrl(`${SEED}in_room`, "M", "#c98a1a"),
    searchable: false,
    joined: 26,
    friendSince: null,
  },
  {
    uid: `${SEED}in_slot`,
    displayName: "Asked me · via my date link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 24,
    friendSince: null,
  },

  // Not friends and never will be: a link is all that authorises each booking.
  {
    uid: `${SEED}via_room`,
    displayName: "Guest · via my room link",
    username: "",
    photoURL: avatarUrl(`${SEED}via_room`, "G", "#dd5f38"),
    searchable: false,
    joined: 20,
    friendSince: null,
  },
  {
    uid: `${SEED}via_slot`,
    displayName: "Guest · via my date link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 18,
    friendSince: null,
  },
  {
    uid: `${SEED}via_user`,
    displayName: "Guest · via my profile link",
    username: "",
    photoURL: avatarUrl(`${SEED}via_user`, "P", "#2e9c6d"),
    searchable: false,
    joined: 16,
    friendSince: null,
  },

  // Not searchable, so every surface leans on the copies their link carries.
  {
    uid: `${SEED}host_room`,
    displayName: "Host · their room link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 150,
    friendSince: null,
  },
  {
    uid: `${SEED}host_slot`,
    displayName: "Host · their date link",
    username: "",
    photoURL: avatarUrl(`${SEED}host_slot`, "D", "#8a5cf6"),
    searchable: false,
    joined: 145,
    friendSince: null,
  },
  {
    uid: `${SEED}host_user`,
    displayName: "Host · their profile link",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 140,
    friendSince: null,
  },
  {
    uid: `${SEED}host_empty`,
    displayName: "Host · shares nothing",
    username: "",
    photoURL: avatarUrl(`${SEED}host_empty`, "N", "#c98a1a"),
    searchable: false,
    joined: 135,
    friendSince: null,
  },

  // A BOOKED slot with no booking behind it is a shape the app can't produce.
  {
    uid: `${SEED}other`,
    displayName: "Someone else · not you",
    username: "",
    photoURL: null,
    searchable: false,
    joined: 60,
    friendSince: null,
  },
];

const PEOPLE: readonly SeedPerson[] = CAST.map((person) => ({
  ...person,
  username: person.username ? `${person.username}${HANDLE_SUFFIX}` : "",
}));

type SeedWindow = {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly status: WindowStatus;
  readonly autoAccept: boolean;
  readonly details: string;
  readonly bookedBy: string | null;
  readonly publicPortalId: string | null;
  // Age of the slot itself, not of its dates. A slot counts as new against a
  // saved search when it was added after that search was last opened, so the
  // default sits well behind `writeSearches`' `lastSeenAt` and one slot doesn't.
  readonly addedDaysAgo: number;
};

// Defaults to the shape `addWindow` writes.
function slot(
  id: string,
  from: number,
  to: number,
  extra: Partial<Omit<SeedWindow, "id" | "start" | "end">> = {},
): SeedWindow {
  return {
    id,
    start: day(from),
    end: day(to),
    status: "OPEN",
    autoAccept: false,
    details: "",
    bookedBy: null,
    publicPortalId: null,
    addedDaysAgo: 30,
    ...extra,
  };
}

type SeedListing = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly type: ListingType;
  readonly description: string;
  readonly label: string;
  // 0/0 is what the form writes when the address never resolved.
  readonly lat: number;
  readonly lng: number;
  // Zero on the signed-in account's own places, so there's somewhere to upload.
  readonly photoCount: number;
  readonly publicPortalId: string | null;
  readonly windows: readonly SeedWindow[];
};

const MY_LOFT = `${SEED}me_loft`;
const MY_HOUSE = `${SEED}me_house`;
const MY_STUDIO = `${SEED}me_studio`;

// So a past stay can render against nothing.
const DELETED_LISTING = `${SEED}deleted_place`;
const DELETED_WINDOW = `${SEED}w_vanished`;

const PORTAL_ME_USER = `${SEED}portal_me_user`;
const PORTAL_ME_ROOM = `${SEED}portal_me_room`;
const PORTAL_ME_SLOT = `${SEED}portal_me_slot`;
const PORTAL_ME_SLOT_GONE = `${SEED}portal_me_slot_gone`;
const PORTAL_OUT_USER = `${SEED}portal_out_user`;
const PORTAL_OUT_ROOM = `${SEED}portal_out_room`;
const PORTAL_OUT_SLOT = `${SEED}portal_out_slot`;
const PORTAL_HOST_ROOM = `${SEED}portal_host_room`;
const PORTAL_HOST_SLOT_OPEN = `${SEED}portal_host_slot_open`;
const PORTAL_HOST_SLOT_TAKEN = `${SEED}portal_host_slot_taken`;
const PORTAL_HOST_SLOT_MINE = `${SEED}portal_host_slot_mine`;
const PORTAL_HOST_USER = `${SEED}portal_host_user`;
const PORTAL_HOST_EMPTY = `${SEED}portal_host_empty`;

// `ownerId` is filled in once the account is resolved.
const MY_LISTINGS: readonly Omit<SeedListing, "ownerId">[] = [
  {
    id: MY_LOFT,
    title: "My loft · every slot state",
    type: "ROOM",
    description:
      "Bright room at the back with its own key, a desk, and the fire escape for coffee.",
    label: "Park Slope, Brooklyn, NY",
    lat: 40.6782,
    lng: -73.9442,
    photoCount: 0,
    publicPortalId: PORTAL_ME_ROOM,
    windows: [
      slot(`${SEED}w_gone_link`, -90, -86, {
        publicPortalId: PORTAL_ME_SLOT_GONE,
      }),
      slot(`${SEED}w_stayed`, -60, -55, {
        status: "BOOKED",
        bookedBy: `${SEED}fr_guest`,
      }),
      slot(`${SEED}w_expired`, -30, -26),
      slot(`${SEED}w_today`, -1, 3, {
        status: "BOOKED",
        bookedBy: `${SEED}via_room`,
        details: "In progress right now",
      }),
      slot(`${SEED}w_open`, 10, 14),
      slot(`${SEED}w_notes`, 16, 19, {
        details: "Notes ride along with the dates",
      }),
      slot(`${SEED}w_instant`, 21, 25, {
        autoAccept: true,
        details: "Flexible on check-in — the key's in the lockbox",
        publicPortalId: PORTAL_ME_SLOT,
      }),
      slot(`${SEED}w_confirmed`, 30, 34, {
        status: "BOOKED",
        bookedBy: `${SEED}fr_guest`,
      }),
      slot(`${SEED}w_link`, 40, 44, {
        status: "BOOKED",
        bookedBy: `${SEED}via_slot`,
      }),
      slot(`${SEED}w_ask_link`, 46, 50),
    ],
  },
  {
    // No description, no coordinates and no share link: the quiet half of every
    // owner surface.
    id: MY_HOUSE,
    title: "My house · no description or link",
    type: "HOUSE",
    description: "",
    label: "Hudson, NY",
    lat: 0,
    lng: 0,
    photoCount: 0,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_open`, 28, 35, {
        details: "The dog comes with the house",
      }),
      slot(`${SEED}w_guest`, 52, 56, {
        status: "BOOKED",
        bookedBy: `${SEED}via_user`,
      }),
      // An instant slot that HAS been taken: the owner row shows Booked, not
      // Instant, even though the flag is still set.
      slot(`${SEED}w_instant_taken`, 60, 63, {
        status: "BOOKED",
        autoAccept: true,
        bookedBy: `${SEED}fr_guest2`,
      }),
    ],
  },
  {
    // A title long enough to clip at 390px, and no dates at all.
    id: MY_STUDIO,
    title:
      "My flat · a title long enough to clip on a narrow phone, and no dates at all",
    type: "FLAT",
    description: "",
    label: "9e arrondissement, Paris",
    lat: 48.8789,
    lng: 2.3402,
    photoCount: 0,
    publicPortalId: null,
    windows: [],
  },
];

const FR_ROOM = `${SEED}fr_room`;
const FR_FLAT = `${SEED}fr_flat`;
const FR_NOGEO = `${SEED}fr_nogeo`;
const FR_FULL = `${SEED}fr_full`;
const FR_NOW = `${SEED}fr_now`;
const FR_TRIPS = `${SEED}fr_trips`;
const FR_GUEST_ROOM = `${SEED}fr_guest_room`;
const FR_GUEST2_FLAT = `${SEED}fr_guest2_flat`;
const HOST_ROOM_FLAT = `${SEED}host_room_flat`;
const HOST_SLOT_ROOM = `${SEED}host_slot_room`;
const HOST_USER_FLAT = `${SEED}host_user_flat`;
const OUT_ROOM_HOUSE = `${SEED}out_room_house`;
const OUT_SLOT_ROOM = `${SEED}out_slot_room`;
const OUT_USER_FLAT = `${SEED}out_user_flat`;
const OUT_USER_ROOM = `${SEED}out_user_room`;

const OTHER_LISTINGS: readonly SeedListing[] = [
  {
    id: FR_ROOM,
    ownerId: `${SEED}fr_photo`,
    title: "Friend's room · every slot state",
    type: "ROOM",
    description: "Quiet brownstone, your own key, coffee downstairs.",
    label: "Park Slope, Brooklyn, NY",
    lat: 40.6712,
    lng: -73.9776,
    photoCount: 3,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_gone`, -20, -16),
      slot(`${SEED}w_instant`, 8, 12, {
        autoAccept: true,
        details: "Instant — book without asking",
      }),
      slot(`${SEED}w_ask`, 14, 18, { details: "Ask first" }),
      slot(`${SEED}w_pending`, 20, 24),
      slot(`${SEED}w_mine`, 26, 30, { status: "BOOKED", bookedBy: ME }),
      slot(`${SEED}w_theirs`, 33, 37, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
      }),
    ],
  },
  {
    id: FR_FLAT,
    ownerId: `${SEED}fr_plain`,
    title: "Friend's flat · three photos",
    type: "FLAT",
    description: "One bedroom, walkable to everything, while I'm travelling.",
    label: "Mission District, San Francisco, CA",
    lat: 37.7599,
    lng: -122.4148,
    photoCount: 3,
    publicPortalId: null,
    windows: [
      // Started yesterday and still running: a slot spanning today is open, not
      // expired, and has to read that way everywhere.
      slot(`${SEED}w_now`, -1, 4, { details: "Started yesterday, still open" }),
      // Added after the saved search below last looked, which is the only way
      // to reach its "new" badge — one you create yourself is seen as of now.
      slot(`${SEED}w_open`, 15, 20, { autoAccept: true, addedDaysAgo: 1 }),
    ],
  },
  {
    // Never geocoded, so it's invisible to a distance search and fine everywhere
    // else.
    id: FR_NOGEO,
    ownerId: `${SEED}fr_nohandle`,
    title: "Friend's place · no coordinates",
    type: "HOUSE",
    description: "",
    label: "Graça, Lisbon",
    lat: 0,
    lng: 0,
    photoCount: 1,
    publicPortalId: null,
    windows: [slot(`${SEED}w_open`, 11, 15), slot(`${SEED}w_gone`, -25, -21)],
  },
  {
    // Nothing free: taken now, and everything else already gone.
    id: FR_FULL,
    ownerId: `${SEED}fr_nosince`,
    title: "Friend's room · nothing free",
    type: "ROOM",
    description: "Water still runs under the floor.",
    label: "Hebden Bridge, West Yorkshire",
    lat: 53.7422,
    lng: -2.0129,
    photoCount: 0,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_taken`, 17, 21, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
      }),
      slot(`${SEED}w_past`, -40, -35),
    ],
  },
  {
    id: FR_NOW,
    ownerId: `${SEED}fr_host`,
    title: "Host friend · my stay in progress",
    type: "HOUSE",
    description: "Wood stove, no wifi, swim before breakfast.",
    label: "Mount Tabor, Portland, OR",
    lat: 45.5118,
    lng: -122.5949,
    photoCount: 0,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_today`, -2, 2, { status: "BOOKED", bookedBy: ME }),
      slot(`${SEED}w_open`, 25, 29, { details: "Trails start at the door" }),
    ],
  },
  {
    id: FR_TRIPS,
    ownerId: `${SEED}fr_host`,
    title: "Host friend · my future and past stays",
    type: "ROOM",
    description: "Steep stairs, good light, better view.",
    label: "Sellwood, Portland, OR",
    lat: 45.4643,
    lng: -122.6531,
    photoCount: 2,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_past`, -70, -64, { status: "BOOKED", bookedBy: ME }),
      slot(`${SEED}w_free`, 9, 13, { autoAccept: true }),
      slot(`${SEED}w_soon`, 45, 50, { status: "BOOKED", bookedBy: ME }),
    ],
  },
  {
    id: FR_GUEST_ROOM,
    ownerId: `${SEED}fr_guest`,
    title: "Guest friend · hosts one range",
    type: "ROOM",
    description: "Boats at six, gulls at five.",
    label: "Onomichi, Hiroshima",
    lat: 34.4088,
    lng: 133.2049,
    photoCount: 0,
    publicPortalId: null,
    windows: [slot(`${SEED}w_open`, 12, 17, { details: "One open range" })],
  },
  {
    id: FR_GUEST2_FLAT,
    ownerId: `${SEED}fr_guest2`,
    title: "Second asker · hosts too",
    type: "FLAT",
    description: "Two rooms over the square, noisy on Saturdays.",
    label: "Södermalm, Stockholm",
    lat: 59.3145,
    lng: 18.0722,
    photoCount: 3,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_open`, 19, 23),
      slot(`${SEED}w_instant`, 31, 35, { autoAccept: true }),
    ],
  },

  {
    id: HOST_ROOM_FLAT,
    ownerId: `${SEED}host_room`,
    title: "Room link · you already asked",
    type: "FLAT",
    description: "Two rooms and a balcony over the market street.",
    label: "Kreuzberg, Berlin",
    lat: 52.4989,
    lng: 13.4033,
    photoCount: 4,
    publicPortalId: PORTAL_HOST_ROOM,
    windows: [
      slot(`${SEED}w_gone`, -15, -11),
      slot(`${SEED}w_open`, 12, 16, { details: "Boats at six" }),
      slot(`${SEED}w_asked`, 19, 23),
      slot(`${SEED}w_taken`, 26, 29, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
      }),
    ],
  },
  {
    // No listing link at all: three of its four ranges are shared one at a time,
    // which is the whole point of a date link.
    id: HOST_SLOT_ROOM,
    ownerId: `${SEED}host_slot`,
    title: "Date links · one range each",
    type: "ROOM",
    description: "Wood stove, no wifi, swim before breakfast.",
    label: "Siljan, Dalarna",
    lat: 60.8794,
    lng: 14.8145,
    photoCount: 1,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_shared`, 24, 28, {
        details: "Firewood included",
        publicPortalId: PORTAL_HOST_SLOT_OPEN,
      }),
      slot(`${SEED}w_taken`, 30, 33, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
        publicPortalId: PORTAL_HOST_SLOT_TAKEN,
      }),
      slot(`${SEED}w_mine`, 36, 40, {
        status: "BOOKED",
        bookedBy: ME,
        publicPortalId: PORTAL_HOST_SLOT_MINE,
      }),
      slot(`${SEED}w_hidden`, 44, 48, { details: "Never shared with anyone" }),
    ],
  },
  {
    id: HOST_USER_FLAT,
    ownerId: `${SEED}host_user`,
    title: "Profile link · your stay is here",
    type: "FLAT",
    description: "Top floor, lift, long balcony.",
    label: "Södermalm, Stockholm",
    lat: 59.3181,
    lng: 18.0721,
    photoCount: 3,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_open`, 14, 19, { details: "Free on the profile link" }),
      slot(`${SEED}w_mine`, 52, 57, { status: "BOOKED", bookedBy: ME }),
    ],
  },
  {
    id: OUT_ROOM_HOUSE,
    ownerId: `${SEED}out_room`,
    title: "Room link · nothing asked yet",
    type: "HOUSE",
    description: "Cabin above the lake, swim before breakfast.",
    label: "Siljan, Dalarna",
    lat: 60.8801,
    lng: 14.812,
    photoCount: 1,
    publicPortalId: PORTAL_OUT_ROOM,
    windows: [
      slot(`${SEED}w_gone`, -12, -8),
      slot(`${SEED}w_open`, 10, 15, { details: "Firewood included" }),
      slot(`${SEED}w_instant`, 20, 24, { autoAccept: true }),
      slot(`${SEED}w_taken`, 27, 30, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
      }),
    ],
  },
  {
    id: OUT_SLOT_ROOM,
    ownerId: `${SEED}out_slot`,
    title: "Date link · nothing asked yet",
    type: "ROOM",
    description: "Steep stairs, good light, better view.",
    label: "Onomichi, Hiroshima",
    lat: 34.41,
    lng: 133.2,
    photoCount: 0,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_shared`, 13, 17, {
        details: "Only these dates are shared",
        publicPortalId: PORTAL_OUT_SLOT,
      }),
      slot(`${SEED}w_hidden`, 21, 25, { details: "Not on the link" }),
    ],
  },
  {
    id: OUT_USER_FLAT,
    ownerId: `${SEED}out_user`,
    title: "Profile link · place one",
    type: "FLAT",
    description: "One bedroom, walkable to everything.",
    label: "Alfama, Lisbon",
    lat: 38.7118,
    lng: -9.1305,
    photoCount: 3,
    publicPortalId: null,
    windows: [slot(`${SEED}w_open`, 11, 16)],
  },
  {
    id: OUT_USER_ROOM,
    ownerId: `${SEED}out_user`,
    title: "Profile link · place two",
    type: "ROOM",
    description: "",
    label: "Graça, Lisbon",
    lat: 38.7208,
    lng: -9.1288,
    photoCount: 0,
    publicPortalId: null,
    windows: [
      slot(`${SEED}w_open`, 18, 22, {
        details: "Two places on one profile link",
      }),
      slot(`${SEED}w_taken`, 25, 28, {
        status: "BOOKED",
        bookedBy: `${SEED}other`,
      }),
    ],
  },
];

type SeedBooking = {
  readonly id: string;
  readonly listingId: string;
  readonly ownerId: string;
  readonly guestId: string;
  readonly windowId: string;
  readonly start: string;
  readonly end: string;
  readonly status: BookingStatus;
  readonly cancelledBy: string | null;
  readonly cancelReason: CancelReason | null;
  readonly createdDaysAgo: number;
};

function stay(
  id: string,
  fields: Omit<SeedBooking, "id" | "cancelledBy" | "cancelReason"> &
    Partial<Pick<SeedBooking, "cancelledBy" | "cancelReason">>,
): SeedBooking {
  return { id, cancelledBy: null, cancelReason: null, ...fields };
}

// A link visitor can never instant-book, so every link stay here was REQUESTED
// first and confirmed by me.
const HOSTING: readonly SeedBooking[] = [
  stay(`${SEED}bk_in_ask`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_open`,
    start: day(10),
    end: day(14),
    status: "REQUESTED",
    createdDaysAgo: 2,
  }),
  // Two people waiting on one answer — the "those dates just went" race.
  stay(`${SEED}bk_in_ask_2`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_open`,
    start: day(10),
    end: day(14),
    status: "REQUESTED",
    createdDaysAgo: 1,
  }),
  // Asked for dates that have since passed: it drops off Home but still badges
  // Places, and its page says it can no longer be confirmed.
  stay(`${SEED}bk_in_ask_gone`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_expired`,
    start: day(-30),
    end: day(-26),
    status: "REQUESTED",
    createdDaysAgo: 40,
  }),
  stay(`${SEED}bk_in_house_ask`, {
    listingId: MY_HOUSE,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_open`,
    start: day(28),
    end: day(35),
    status: "REQUESTED",
    createdDaysAgo: 5,
  }),
  stay(`${SEED}bk_in_confirmed`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_confirmed`,
    start: day(30),
    end: day(34),
    status: "CONFIRMED",
    createdDaysAgo: 9,
  }),
  stay(`${SEED}bk_in_today`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}via_room`,
    windowId: `${SEED}w_today`,
    start: day(-1),
    end: day(3),
    status: "CONFIRMED",
    createdDaysAgo: 20,
  }),
  stay(`${SEED}bk_in_past`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_stayed`,
    start: day(-60),
    end: day(-55),
    status: "CONFIRMED",
    createdDaysAgo: 75,
  }),
  stay(`${SEED}bk_in_slotlink`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}via_slot`,
    windowId: `${SEED}w_link`,
    start: day(40),
    end: day(44),
    status: "CONFIRMED",
    createdDaysAgo: 12,
  }),
  stay(`${SEED}bk_in_userlink_ask`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}via_user`,
    windowId: `${SEED}w_ask_link`,
    start: day(46),
    end: day(50),
    status: "REQUESTED",
    createdDaysAgo: 3,
  }),
  stay(`${SEED}bk_in_userlink`, {
    listingId: MY_HOUSE,
    ownerId: ME,
    guestId: `${SEED}via_user`,
    windowId: `${SEED}w_guest`,
    start: day(52),
    end: day(56),
    status: "CONFIRMED",
    createdDaysAgo: 6,
  }),
  // The one stay nobody approved: an auto-accept slot taken by a friend, born
  // CONFIRMED in a single transaction.
  stay(`${SEED}bk_in_instant`, {
    listingId: MY_HOUSE,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_instant_taken`,
    start: day(60),
    end: day(63),
    status: "CONFIRMED",
    createdDaysAgo: 4,
  }),

  stay(`${SEED}bk_in_declined`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_open`,
    start: day(10),
    end: day(14),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "DECLINED",
    createdDaysAgo: 14,
  }),
  stay(`${SEED}bk_in_withdrawn`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_open`,
    start: day(10),
    end: day(14),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_guest`,
    cancelReason: "WITHDRAWN",
    createdDaysAgo: 12,
  }),
  // Differing from the slot's current dates IS what "moved" looks like.
  stay(`${SEED}bk_in_moved`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_notes`,
    start: day(15),
    end: day(18),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "SLOT_MOVED",
    createdDaysAgo: 8,
  }),
  stay(`${SEED}bk_in_slot_gone`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}via_room`,
    windowId: DELETED_WINDOW,
    start: day(38),
    end: day(42),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "SLOT_CANCELLED",
    createdDaysAgo: 10,
  }),
  // Same reason, same two people, opposite `cancelledBy` — the only thing that
  // tells the UI and the mail who called it off.
  stay(`${SEED}bk_in_stay_off_by_me`, {
    listingId: MY_HOUSE,
    ownerId: ME,
    guestId: `${SEED}fr_guest`,
    windowId: `${SEED}w_open`,
    start: day(28),
    end: day(35),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "STAY_CANCELLED",
    createdDaysAgo: 11,
  }),
  stay(`${SEED}bk_in_stay_off_by_them`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}fr_guest2`,
    windowId: `${SEED}w_notes`,
    start: day(16),
    end: day(19),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_guest2`,
    cancelReason: "STAY_CANCELLED",
    createdDaysAgo: 7,
  }),
  stay(`${SEED}bk_in_link_declined`, {
    listingId: MY_LOFT,
    ownerId: ME,
    guestId: `${SEED}via_room`,
    windowId: `${SEED}w_ask_link`,
    start: day(46),
    end: day(50),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "DECLINED",
    createdDaysAgo: 16,
  }),
];

// Where I'm the guest.
const STAYING: readonly SeedBooking[] = [
  stay(`${SEED}bk_my_ask`, {
    listingId: FR_ROOM,
    ownerId: `${SEED}fr_photo`,
    guestId: ME,
    windowId: `${SEED}w_pending`,
    start: day(20),
    end: day(24),
    status: "REQUESTED",
    createdDaysAgo: 3,
  }),
  stay(`${SEED}bk_my_confirmed`, {
    listingId: FR_ROOM,
    ownerId: `${SEED}fr_photo`,
    guestId: ME,
    windowId: `${SEED}w_mine`,
    start: day(26),
    end: day(30),
    status: "CONFIRMED",
    createdDaysAgo: 8,
  }),
  stay(`${SEED}bk_my_today`, {
    listingId: FR_NOW,
    ownerId: `${SEED}fr_host`,
    guestId: ME,
    windowId: `${SEED}w_today`,
    start: day(-2),
    end: day(2),
    status: "CONFIRMED",
    createdDaysAgo: 30,
  }),
  stay(`${SEED}bk_my_future`, {
    listingId: FR_TRIPS,
    ownerId: `${SEED}fr_host`,
    guestId: ME,
    windowId: `${SEED}w_soon`,
    start: day(45),
    end: day(50),
    status: "CONFIRMED",
    createdDaysAgo: 20,
  }),
  stay(`${SEED}bk_my_past`, {
    listingId: FR_TRIPS,
    ownerId: `${SEED}fr_host`,
    guestId: ME,
    windowId: `${SEED}w_past`,
    start: day(-70),
    end: day(-64),
    status: "CONFIRMED",
    createdDaysAgo: 100,
  }),
  stay(`${SEED}bk_my_ask_gone`, {
    listingId: FR_NOGEO,
    ownerId: `${SEED}fr_nohandle`,
    guestId: ME,
    windowId: `${SEED}w_gone`,
    start: day(-25),
    end: day(-21),
    status: "REQUESTED",
    createdDaysAgo: 30,
  }),
  // Deleting a listing cancels only future bookings, so a past one is stranded.
  stay(`${SEED}bk_my_deleted`, {
    listingId: DELETED_LISTING,
    ownerId: `${SEED}fr_host`,
    guestId: ME,
    windowId: DELETED_WINDOW,
    start: day(-150),
    end: day(-145),
    status: "CONFIRMED",
    createdDaysAgo: 200,
  }),

  stay(`${SEED}bk_my_declined`, {
    listingId: FR_FLAT,
    ownerId: `${SEED}fr_plain`,
    guestId: ME,
    windowId: `${SEED}w_open`,
    start: day(15),
    end: day(20),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_plain`,
    cancelReason: "DECLINED",
    createdDaysAgo: 6,
  }),
  stay(`${SEED}bk_my_withdrawn`, {
    listingId: FR_FLAT,
    ownerId: `${SEED}fr_plain`,
    guestId: ME,
    windowId: `${SEED}w_now`,
    start: day(-1),
    end: day(4),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "WITHDRAWN",
    createdDaysAgo: 11,
  }),
  stay(`${SEED}bk_my_moved`, {
    listingId: FR_NOGEO,
    ownerId: `${SEED}fr_nohandle`,
    guestId: ME,
    windowId: `${SEED}w_open`,
    start: day(9),
    end: day(13),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_nohandle`,
    cancelReason: "SLOT_MOVED",
    createdDaysAgo: 4,
  }),
  stay(`${SEED}bk_my_slot_gone`, {
    listingId: FR_GUEST_ROOM,
    ownerId: `${SEED}fr_guest`,
    guestId: ME,
    windowId: DELETED_WINDOW,
    start: day(31),
    end: day(34),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_guest`,
    cancelReason: "SLOT_CANCELLED",
    createdDaysAgo: 7,
  }),
  stay(`${SEED}bk_my_stay_off_by_host`, {
    listingId: FR_GUEST2_FLAT,
    ownerId: `${SEED}fr_guest2`,
    guestId: ME,
    windowId: `${SEED}w_open`,
    start: day(19),
    end: day(23),
    status: "CANCELLED",
    cancelledBy: `${SEED}fr_guest2`,
    cancelReason: "STAY_CANCELLED",
    createdDaysAgo: 9,
  }),
  stay(`${SEED}bk_my_stay_off_by_me`, {
    listingId: FR_GUEST2_FLAT,
    ownerId: `${SEED}fr_guest2`,
    guestId: ME,
    windowId: `${SEED}w_instant`,
    start: day(31),
    end: day(35),
    status: "CANCELLED",
    cancelledBy: ME,
    cancelReason: "STAY_CANCELLED",
    createdDaysAgo: 5,
  }),

  // Asked through a room link, which is what makes that link open in the
  // "already sent" state.
  stay(`${SEED}bk_my_roomlink_ask`, {
    listingId: HOST_ROOM_FLAT,
    ownerId: `${SEED}host_room`,
    guestId: ME,
    windowId: `${SEED}w_asked`,
    start: day(19),
    end: day(23),
    status: "REQUESTED",
    createdDaysAgo: 2,
  }),
  stay(`${SEED}bk_my_roomlink_no`, {
    listingId: HOST_ROOM_FLAT,
    ownerId: `${SEED}host_room`,
    guestId: ME,
    windowId: `${SEED}w_open`,
    start: day(12),
    end: day(16),
    status: "CANCELLED",
    cancelledBy: `${SEED}host_room`,
    cancelReason: "DECLINED",
    createdDaysAgo: 15,
  }),
  stay(`${SEED}bk_my_slotlink`, {
    listingId: HOST_SLOT_ROOM,
    ownerId: `${SEED}host_slot`,
    guestId: ME,
    windowId: `${SEED}w_mine`,
    start: day(36),
    end: day(40),
    status: "CONFIRMED",
    createdDaysAgo: 10,
  }),
  stay(`${SEED}bk_my_userlink`, {
    listingId: HOST_USER_FLAT,
    ownerId: `${SEED}host_user`,
    guestId: ME,
    windowId: `${SEED}w_mine`,
    start: day(52),
    end: day(57),
    status: "CONFIRMED",
    createdDaysAgo: 13,
  }),
];

// Nothing renders these; they exist so no slot is BOOKED without a body.
const ELSEWHERE: readonly SeedBooking[] = (
  [
    [
      `${SEED}bk_other_fr_room`,
      FR_ROOM,
      `${SEED}fr_photo`,
      `${SEED}w_theirs`,
      33,
      37,
    ],
    [
      `${SEED}bk_other_fr_full`,
      FR_FULL,
      `${SEED}fr_nosince`,
      `${SEED}w_taken`,
      17,
      21,
    ],
    [
      `${SEED}bk_other_host_room`,
      HOST_ROOM_FLAT,
      `${SEED}host_room`,
      `${SEED}w_taken`,
      26,
      29,
    ],
    [
      `${SEED}bk_other_host_slot`,
      HOST_SLOT_ROOM,
      `${SEED}host_slot`,
      `${SEED}w_taken`,
      30,
      33,
    ],
    [
      `${SEED}bk_other_out_room`,
      OUT_ROOM_HOUSE,
      `${SEED}out_room`,
      `${SEED}w_taken`,
      27,
      30,
    ],
    [
      `${SEED}bk_other_out_user`,
      OUT_USER_ROOM,
      `${SEED}out_user`,
      `${SEED}w_taken`,
      25,
      28,
    ],
  ] as const
).map(([id, listingId, ownerId, windowId, from, to]) =>
  stay(id, {
    listingId,
    ownerId,
    guestId: `${SEED}other`,
    windowId,
    start: day(from),
    end: day(to),
    status: "CONFIRMED",
    createdDaysAgo: 15,
  }),
);

const BOOKINGS: readonly SeedBooking[] = [...HOSTING, ...STAYING, ...ELSEWHERE];

type SeedPortal =
  | { readonly id: string; readonly scope: "USER"; readonly ownerId: string }
  | {
      readonly id: string;
      readonly scope: "LISTING";
      readonly ownerId: string;
      readonly listingId: string;
    }
  | {
      readonly id: string;
      readonly scope: "SLOT";
      readonly ownerId: string;
      readonly listingId: string;
      readonly windowId: string;
    };

// Named rather than random, so a re-run replaces them and the tour can print them.
const PORTALS: readonly SeedPortal[] = [
  { id: PORTAL_ME_USER, scope: "USER", ownerId: ME },
  {
    id: PORTAL_ME_ROOM,
    scope: "LISTING",
    ownerId: ME,
    listingId: MY_LOFT,
  },
  {
    id: PORTAL_ME_SLOT,
    scope: "SLOT",
    ownerId: ME,
    listingId: MY_LOFT,
    windowId: `${SEED}w_instant`,
  },
  // Still revocable long after its dates have gone.
  {
    id: PORTAL_ME_SLOT_GONE,
    scope: "SLOT",
    ownerId: ME,
    listingId: MY_LOFT,
    windowId: `${SEED}w_gone_link`,
  },
  { id: PORTAL_OUT_USER, scope: "USER", ownerId: `${SEED}out_user` },
  {
    id: PORTAL_OUT_ROOM,
    scope: "LISTING",
    ownerId: `${SEED}out_room`,
    listingId: OUT_ROOM_HOUSE,
  },
  {
    id: PORTAL_OUT_SLOT,
    scope: "SLOT",
    ownerId: `${SEED}out_slot`,
    listingId: OUT_SLOT_ROOM,
    windowId: `${SEED}w_shared`,
  },
  {
    id: PORTAL_HOST_ROOM,
    scope: "LISTING",
    ownerId: `${SEED}host_room`,
    listingId: HOST_ROOM_FLAT,
  },
  {
    id: PORTAL_HOST_SLOT_OPEN,
    scope: "SLOT",
    ownerId: `${SEED}host_slot`,
    listingId: HOST_SLOT_ROOM,
    windowId: `${SEED}w_shared`,
  },
  // Points at a range someone else took, so the link says so.
  {
    id: PORTAL_HOST_SLOT_TAKEN,
    scope: "SLOT",
    ownerId: `${SEED}host_slot`,
    listingId: HOST_SLOT_ROOM,
    windowId: `${SEED}w_taken`,
  },
  {
    id: PORTAL_HOST_SLOT_MINE,
    scope: "SLOT",
    ownerId: `${SEED}host_slot`,
    listingId: HOST_SLOT_ROOM,
    windowId: `${SEED}w_mine`,
  },
  { id: PORTAL_HOST_USER, scope: "USER", ownerId: `${SEED}host_user` },
  { id: PORTAL_HOST_EMPTY, scope: "USER", ownerId: `${SEED}host_empty` },
];

type SeedRequest = {
  readonly from: string;
  readonly to: string;
  // Authorises the write and marks how they arrived; null for the handle route.
  readonly portalId: string | null;
  readonly createdDaysAgo: number;
};

// Keyed `${from}_${to}`, so each route in needs its own person.
const REQUESTS: readonly SeedRequest[] = [
  { from: ME, to: `${SEED}out_handle`, portalId: null, createdDaysAgo: 4 },
  {
    from: ME,
    to: `${SEED}out_user`,
    portalId: PORTAL_OUT_USER,
    createdDaysAgo: 5,
  },
  {
    from: ME,
    to: `${SEED}out_room`,
    portalId: PORTAL_OUT_ROOM,
    createdDaysAgo: 6,
  },
  {
    from: ME,
    to: `${SEED}out_slot`,
    portalId: PORTAL_OUT_SLOT,
    createdDaysAgo: 7,
  },
  { from: `${SEED}in_handle`, to: ME, portalId: null, createdDaysAgo: 1 },
  {
    from: `${SEED}in_user`,
    to: ME,
    portalId: PORTAL_ME_USER,
    createdDaysAgo: 2,
  },
  {
    from: `${SEED}in_room`,
    to: ME,
    portalId: PORTAL_ME_ROOM,
    createdDaysAgo: 3,
  },
  {
    from: `${SEED}in_slot`,
    to: ME,
    portalId: PORTAL_ME_SLOT,
    createdDaysAgo: 4,
  },
];

function person(uid: string): SeedPerson {
  const found = PEOPLE.find((candidate) => candidate.uid === uid);
  if (!found) throw new Error(`no seeded person ${uid}`);
  return found;
}

// Real objects, because a reader just follows the recorded download URL. SVG
// needs no encoder and can say on its face which place and position it is.
function photoSvg(title: string, index: number, total: number): string {
  const palette = [
    ["#dd5f38", "#f2a93b"],
    ["#2e9c6d", "#7fd1a0"],
    ["#8a5cf6", "#c4a5ff"],
    ["#2b6cb0", "#63b3ed"],
  ];
  const [from, to] = palette[index % palette.length];
  const lines = wrap(title.replace(/[<>&]/g, ""), 22);
  const rows = lines
    .map(
      (line, row) =>
        `<text x="60" y="${300 + row * 58}" fill="#ffffff" font-family="sans-serif"` +
        ` font-size="46" font-weight="700">${line}</text>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="1200" height="800" fill="url(#g)"/>` +
    rows +
    `<text x="60" y="700" fill="#ffffff" font-family="sans-serif" font-size="64"` +
    ` font-weight="800" opacity="0.85">photo ${index + 1} of ${total}</text>` +
    `</svg>`
  );
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

// Mint the objects and return what the listing has to record.
async function uploadListingPhotos(
  listing: SeedListing,
  ownerId: string,
): Promise<ListingPhoto[]> {
  const bucket = getStorage().bucket(BUCKET);
  const photos: ListingPhoto[] = [];
  for (let index = 0; index < listing.photoCount; index += 1) {
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const path = `listings/${ownerId}/${listing.id}/${id}`;
    await bucket
      .file(path)
      .save(Buffer.from(photoSvg(listing.title, index, listing.photoCount)), {
        metadata: {
          contentType: "image/svg+xml",
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
    photos.push({ id, url: objectUrl(path, token) });
  }
  return photos;
}

// Every document of a root collection this seed owns — listed rather than
// queried, because a document can be MISSING and still hold subcollections, and
// a query never returns one of those. That is not a hypothetical: the app itself
// writes `listings/{id}/guests/{uid}` from the guest's own client, so a place
// this file has since dropped leaves a live pointer under a parent that no
// longer exists, which an id-range wipe would walk straight past forever.
async function seedRefs(
  collection: CollectionReference,
): Promise<DocumentReference[]> {
  const refs = await collection.listDocuments();
  return refs.filter((ref) => ref.id.startsWith(SEED));
}

async function seedDocs(
  collection: CollectionReference,
): Promise<QueryDocumentSnapshot[]> {
  const snap = await collection
    .where(FieldPath.documentId(), ">=", SEED)
    .where(FieldPath.documentId(), "<", SEED_END)
    .get();
  return snap.docs;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// Found by prefix, except the two whose id the schema dictates: a connect
// request keyed `${from}_${to}`, and the subcollections under the real account.
async function wipe(db: Firestore, realUid: string): Promise<number> {
  let removed = 0;
  for (const name of ["users", "listings", "bookings", "portals"]) {
    for (const ref of await seedRefs(db.collection(name))) {
      // recursiveDelete takes the subcollections too.
      await db.recursiveDelete(ref);
      removed += 1;
    }
  }
  for (const name of ["friends", "searches"]) {
    for (const snap of await seedDocs(
      db.collection(`users/${realUid}/${name}`),
    )) {
      await snap.ref.delete();
      removed += 1;
    }
  }
  // Permanent to the app, but the Admin SDK is outside that — and a seeded
  // handle has to go with its user or the next run inherits a squatter.
  const handles = await db
    .collection("usernames")
    .where("uid", ">=", SEED)
    .where("uid", "<", SEED_END)
    .get();
  for (const snap of handles.docs) {
    await snap.ref.delete();
    removed += 1;
  }
  const uids = PEOPLE.map((candidate) => candidate.uid);
  for (const field of ["from", "to"]) {
    for (const chunk of chunked(uids, IN_LIMIT)) {
      const requests = await db
        .collection("connectRequests")
        .where(field, "in", chunk)
        .get();
      for (const snap of requests.docs) {
        await snap.ref.delete();
        removed += 1;
      }
    }
  }
  // The loop above finds these by the other party, which misses anyone dropped
  // from the cast — leaving an incoming ask stuck at the top of Home forever.
  for (const field of ["from", "to"]) {
    const involving = await db
      .collection("connectRequests")
      .where(field, "==", realUid)
      .get();
    for (const snap of involving.docs) {
      if (!snap.id.includes(SEED)) continue;
      await snap.ref.delete();
      removed += 1;
    }
  }
  return removed;
}

// Listing every object under `listings/`, rather than deleting per known owner,
// is what makes dropping a place from this file actually remove its photos.
async function wipeObjects(realUid: string): Promise<number> {
  const bucket = getStorage().bucket(BUCKET);
  const [files] = await bucket.getFiles({ prefix: "listings/" });
  const doomed = files.filter((file) => {
    const [, ownerId, listingId] = file.name.split("/");
    if (!ownerId || !listingId) return false;
    return (
      ownerId.startsWith(SEED) ||
      (ownerId === realUid && listingId.startsWith(SEED))
    );
  });
  // Named by uid, so the prefix can't reach the real account's own photo.
  const [avatars] = await bucket.getFiles({ prefix: avatarPath(SEED) });
  await Promise.all([...doomed, ...avatars].map((file) => file.delete()));
  return doomed.length + avatars.length;
}

type RealUser = {
  readonly uid: string;
  readonly displayName: string;
  readonly username: string;
  readonly photoURL: string | null;
};

// Gathered rather than written as we go, so they can be flushed in batches.
type Write = {
  readonly path: string;
  readonly data: DocumentData;
  readonly merge: boolean;
};

function put(
  writes: Write[],
  path: string,
  data: DocumentData,
  merge = false,
): void {
  writes.push({ path, data, merge });
}

async function commitAll(
  db: Firestore,
  writes: readonly Write[],
): Promise<void> {
  for (const chunk of chunked(writes, BATCH_LIMIT)) {
    const batch = db.batch();
    for (const write of chunk) {
      batch.set(db.doc(write.path), write.data, { merge: write.merge });
    }
    await batch.commit();
  }
}

function writePeople(writes: Write[], real: RealUser): void {
  for (const seeded of PEOPLE) {
    const profile: DocumentData = {
      displayName: seeded.displayName,
      photoURL: seeded.photoURL,
      createdAt: daysAgo(seeded.joined),
    };
    // One decision, so a profile without a claim carries neither field.
    if (seeded.username) {
      profile.username = seeded.username;
      profile.searchable = seeded.searchable;
      put(writes, `usernames/${seeded.username}`, { uid: seeded.uid });
    }
    put(writes, `users/${seeded.uid}`, profile);

    if (seeded.friendSince === null) continue;
    // Bijective: both edges, or neither.
    const mine: DocumentData = {
      username: seeded.username,
      displayName: seeded.displayName,
      photoURL: seeded.photoURL,
    };
    const theirs: DocumentData = {
      username: real.username,
      displayName: real.displayName,
      photoURL: real.photoURL,
    };
    if (seeded.friendSince !== undefined) {
      mine.since = daysAgo(seeded.friendSince);
      theirs.since = daysAgo(seeded.friendSince);
    }
    put(writes, `users/${real.uid}/friends/${seeded.uid}`, mine);
    put(writes, `users/${seeded.uid}/friends/${real.uid}`, theirs);
  }
}

// Last looked at before the SF flat's newest slot was added, so Home shows the
// count AND the new badge. Both are computed client-side from the browse set.
function writeSearches(writes: Write[], real: RealUser): void {
  put(writes, `users/${real.uid}/searches/${SEED}search_sf`, {
    label: "San Francisco, any time",
    criteria: {
      start: null,
      end: null,
      near: { lat: 37.7749, lng: -122.4194 },
      nearLabel: "San Francisco, CA",
      radiusKm: 50,
      type: null,
    },
    lastSeenAt: daysAgo(3),
    createdAt: daysAgo(20),
  });
}

function writeListings(
  writes: Write[],
  listings: readonly SeedListing[],
  photos: ReadonlyMap<string, readonly ListingPhoto[]>,
): void {
  for (const listing of listings) {
    const doc: DocumentData = {
      ownerId: listing.ownerId,
      title: listing.title,
      type: listing.type,
      description: listing.description,
      location: {
        label: listing.label,
        lat: listing.lat,
        lng: listing.lng,
        geohash: geohashForLocation([listing.lat, listing.lng]),
      },
      photos: photos.get(listing.id) ?? [],
      createdAt: daysAgo(60),
    };
    // Absent until shared; the client reads a missing field as null.
    if (listing.publicPortalId) doc.publicPortalId = listing.publicPortalId;
    put(writes, `listings/${listing.id}`, doc);

    for (const window of listing.windows) {
      put(writes, `listings/${listing.id}/windows/${window.id}`, {
        start: window.start,
        end: window.end,
        status: window.status,
        autoAccept: window.autoAccept,
        details: window.details,
        bookedBy: window.bookedBy,
        publicPortalId: window.publicPortalId,
        createdAt: daysAgo(window.addedDaysAgo),
      });
    }
  }
}

function writeBookings(
  writes: Write[],
  real: RealUser,
  listings: readonly SeedListing[],
): void {
  function resolve(uid: string): string {
    return uid === ME ? real.uid : uid;
  }

  for (const booking of BOOKINGS) {
    const ownerId = resolve(booking.ownerId);
    const guestId = resolve(booking.guestId);
    put(writes, `bookings/${booking.id}`, {
      listingId: booking.listingId,
      ownerId,
      guestId,
      windowId: booking.windowId,
      start: booking.start,
      end: booking.end,
      status: booking.status,
      cancelledBy: booking.cancelledBy === ME ? real.uid : booking.cancelledBy,
      cancelReason: booking.cancelReason,
      createdAt: daysAgo(booking.createdDaysAgo),
    });
  }

  // A booking carries no names, so without these a seeded stay with a non-friend
  // shows as "Someone". Both sides, since either may be the one looking.
  const seen = new Map<string, SeedBooking>();
  for (const booking of BOOKINGS) {
    if (booking.status !== "CONFIRMED") continue;
    const ownerId = resolve(booking.ownerId);
    const guestId = resolve(booking.guestId);
    for (const path of [
      `users/${ownerId}/knownBy/${guestId}`,
      `users/${guestId}/knownBy/${ownerId}`,
    ]) {
      const held = seen.get(path);
      if (!held || booking.end > held.end) seen.set(path, booking);
    }
  }
  for (const [path, booking] of seen) {
    put(writes, path, { bookingId: booking.id });
  }

  // Derived, because the client issues one per confirmed stay and the path
  // allows only one per (listing, guest) — so the latest stay wins.
  const known = new Set(listings.map((listing) => listing.id));
  const pointers = new Map<string, SeedBooking>();
  for (const booking of BOOKINGS) {
    if (booking.status !== "CONFIRMED") continue;
    if (!known.has(booking.listingId)) continue;
    const path = `listings/${booking.listingId}/guests/${resolve(booking.guestId)}`;
    const held = pointers.get(path);
    if (!held || booking.end > held.end) pointers.set(path, booking);
  }
  for (const [path, booking] of pointers) {
    put(writes, path, { bookingId: booking.id });
  }
}

function writePortals(
  writes: Write[],
  real: RealUser,
  listings: readonly SeedListing[],
  photos: ReadonlyMap<string, readonly ListingPhoto[]>,
): void {
  for (const portal of PORTALS) {
    const ownerId = portal.ownerId === ME ? real.uid : portal.ownerId;
    const owner =
      portal.ownerId === ME
        ? { displayName: real.displayName, photoURL: real.photoURL }
        : person(portal.ownerId);
    const doc: DocumentData = {
      scope: portal.scope,
      ownerId,
      ownerName: owner.displayName,
      ownerPhotoURL: owner.photoURL,
      createdAt: daysAgo(3),
    };
    // Only a date-range link carries a copy, since its grant doesn't unlock the
    // room it belongs to.
    if (portal.scope === "LISTING") doc.listingId = portal.listingId;
    if (portal.scope === "SLOT") {
      const listing = listings.find(
        (candidate) => candidate.id === portal.listingId,
      );
      if (!listing) throw new Error(`no seeded listing ${portal.listingId}`);
      doc.listings = [
        {
          listingId: listing.id,
          title: listing.title,
          type: listing.type,
          description: listing.description,
          locationLabel: listing.label,
          photos: photos.get(listing.id) ?? [],
          windowIds: [portal.windowId],
        },
      ];
    }
    put(writes, `portals/${portal.id}`, doc);
  }

  // Merged, so the real account's other prefs aren't lost.
  for (const portal of PORTALS) {
    if (portal.scope !== "USER") continue;
    const ownerId = portal.ownerId === ME ? real.uid : portal.ownerId;
    put(
      writes,
      `users/${ownerId}/settings/prefs`,
      { profilePortalId: portal.id },
      portal.ownerId === ME,
    );
  }
}

function writeRequests(writes: Write[], real: RealUser): void {
  for (const request of REQUESTS) {
    const fromId = request.from === ME ? real.uid : request.from;
    const toId = request.to === ME ? real.uid : request.to;
    const sender =
      request.from === ME
        ? {
            displayName: real.displayName,
            username: real.username,
            photoURL: real.photoURL,
          }
        : person(request.from);
    // Both routes end up with the same name and photo; only the handle route
    // learns a handle, since a link records no claim.
    const recipient = request.to === ME ? real : person(request.to);
    put(writes, `connectRequests/${fromId}_${toId}`, {
      from: fromId,
      to: toId,
      fromName: sender.displayName,
      fromUsername: sender.username,
      fromPhotoURL: sender.photoURL,
      toName: recipient.displayName,
      toUsername: request.portalId ? "" : recipient.username,
      toPhotoURL: recipient.photoURL,
      portalId: request.portalId,
      createdAt: daysAgo(request.createdDaysAgo),
    });
  }
}

function portalUrl(portalId: string): string {
  return `${APP_ORIGIN}/portal/#${portalId}`;
}

// The point of the whole script: where to click to see each state.
function printTour(): void {
  const sections: readonly (readonly [string, readonly string[]])[] = [
    [
      "Home",
      [
        'Needs your attention — 4 connect requests (one per route in: handle, profile link, room link, date link; the three link ones carry the "via your link" chip) plus 4 booking asks',
        '"Asked me · found by handle" is the only one with an @handle under the name; the other three show an initial avatar and no handle line',
        "Coming up — 12 rows: your 7 live trips (one in progress since 2 days ago, three asks still waiting) then your 5 confirmed guests",
        'Your searches — "San Francisco, any time" with a place count and a 1-new badge (a slot added yesterday, after it was last opened). Tapping it applies the filters, jumps to Browse, and clears the badge',
        "Open at friends' places — 7 places match, so it shows 4 and a Browse all",
        "Friends rail (desktop) — 4 of your 8",
      ],
    ],
    [
      "Friends",
      [
        "Requests — the same 4 incoming asks on the same cards Home shows, chip and Manage link included: this is where you're sent to answer all of them",
        'Pending — 4 outgoing asks, each naming who you asked. Only "Asked them · found by handle" carries an @handle under the name; the three link routes have none to show, since a link records a name and photo but no claim',
        "8 friends: photo+handle, no photo, no handle (no @ line), shares nothing, no since date, hosts my stays, stays at mine, the second asker",
      ],
    ],
    [
      "Browse",
      [
        "7 matching places across 6 friends; 4 carry an Instant chip, 3 don't",
        '"Friend\'s place · no coordinates" drops out the moment you set a location filter — everything else stays',
        '"Friend\'s room · nothing free" never appears: taken now, expired otherwise',
        "Covers with photos vs none: the room, the flat, the no-coordinates place, the trips room and the second asker's flat carry them",
        "Filter to House / Flat / Room, or a date range, to watch the count in the sheet's button change",
      ],
    ],
    [
      "Places → My loft · every slot state (owner view)",
      [
        "Availability — open, open+notes, Instant (with its own date link), 3 booked (one in progress today), and one open range holding a link guest's ask",
        'Past dates — 3 of them: "Nobody booked these", "Someone stayed", and an expired range that still has a live link on it',
        "Sharing — a live room link; the Instant slot's sheet has its own; the expired slot's sheet shows only the link and a Remove",
        "Guests — 8 rows: two friends asking for the SAME range, an ask whose dates have gone, a link guest's ask, and 4 confirmed stays. The 6 cancelled ones are hidden",
        "Tap the open range and change the dates: the confirm warns it cancels 2 pending asks",
        "Tap the booked range: no date fields, just who has it and a cancel",
      ],
    ],
    [
      "Places → the rest",
      [
        "My house · no description or link — no description, no coordinates, no share link, a confirmed link guest and an instant slot that's already taken (reads Booked, not Instant)",
        "My flat · long title — clips at 390px, no dates at all, so Availability is empty and the card says No open dates",
        "The list rows show N open · M booked and a pending-requests chip (the expired ask still counts there, by design)",
      ],
    ],
    [
      "Trips",
      [
        "Upcoming — 7: in progress today, a friend ask, a friend stay, a room-link ask, a date-link stay, a profile-link stay, a later friend stay",
        'Past — a completed stay, an ask whose dates went, and one against a place that no longer exists ("A place" / "Address unavailable")',
        'A stay booked through a link names its real place: the store fetches listings your trips point at, not just friends\' — the only "A place" left is the one that was actually deleted',
        "Cancelled is its own section below Past — most called-off stays are still in the future, so filing them under Past would read as a mistake. Tap through for who cancelled and why",
      ],
    ],
    [
      "A friend's room (Browse → Friend's room · every slot state)",
      [
        "Five slot states in one list: Instant (Book), open (Request), Pending (your ask), Booked by you, and Booked by someone else (dimmed)",
        "Its expired range is filtered out — only the owner sees that",
        "Host block reads You're friends; on Friend · no since date it reads the same with no year behind it",
      ],
    ],
    [
      "People",
      [
        'Friend · shares nothing → "…isn\'t sharing any places right now"',
        "Friend · photo and handle → a place card with cover, handle under the name, Remove friend at the bottom",
        "Your own page → display name editor, the searchable switch, your public profile link, and your 3 places",
      ],
    ],
    [
      "Booking pages",
      [
        "Owner + pending → Confirm / Decline (Home → any ask)",
        'Owner + pending + dates gone → "These dates have passed" and Decline only (My loft → Guests → the expired ask)',
        "Owner + confirmed → Cancel booking",
        "Guest + pending → Cancel request; guest + confirmed → Cancel stay",
        "The person row taps through to their page only when they're a friend — a link guest has no page to reach",
      ],
    ],
    [
      "Settings",
      [
        "Privacy — public profile link is ON (it's the link two people used to reach you); searchable + handle reflect your real account",
      ],
    ],
  ];

  for (const [screen, lines] of sections) {
    console.log(`\n${screen}`);
    for (const line of lines) console.log(`  · ${line}`);
  }

  console.log(
    "\nShare links (open in a private window to visit as a stranger)",
  );
  const links: readonly (readonly [string, string])[] = [
    [
      "yours, profile scope (owner view: no Request, no ask-to-connect)",
      PORTAL_ME_USER,
    ],
    ["yours, room scope — the loft", PORTAL_ME_ROOM],
    ["yours, date scope — your Instant range", PORTAL_ME_SLOT],
    [
      "yours, date scope — a range that has already passed (still live)",
      PORTAL_ME_SLOT_GONE,
    ],
    [
      "profile link, fresh — two places, live dates, Request + Ask to be friends",
      PORTAL_OUT_USER,
    ],
    [
      "room link, fresh — open dates only; the taken and expired ones are dropped",
      PORTAL_OUT_ROOM,
    ],
    ["date link, fresh — one range, and only that one", PORTAL_OUT_SLOT],
    [
      'room link, already asked — reads "Sent — … will get back to you"',
      PORTAL_HOST_ROOM,
    ],
    [
      "date link — free, on a place whose other ranges aren't shared",
      PORTAL_HOST_SLOT_OPEN,
    ],
    ['date link — already taken, so it reads "Booked"', PORTAL_HOST_SLOT_TAKEN],
    [
      "date link — the range you hold, so it reads Booked and Sent",
      PORTAL_HOST_SLOT_MINE,
    ],
    ["profile link — the host of one of your stays", PORTAL_HOST_USER],
    [
      'profile link — shares nothing ("Nothing shared here right now")',
      PORTAL_HOST_EMPTY,
    ],
  ];
  for (const [what, id] of links)
    console.log(`  · ${what}\n      ${portalUrl(id)}`);
  console.log(
    `  · a dead link (revoked or regenerated): ${APP_ORIGIN}/portal/#not-a-real-token`,
  );

  // States no amount of seeding reaches, so nobody goes hunting.
  console.log("\nSeeded but not reachable by clicking");
  for (const line of [
    "nothing — the 14 cancelled bookings reach their pages from Trips (Cancelled) as guest and a room's dimmed Cancelled section as host",
    "a link you have already asked to connect through reads Sent, rather than offering the ask again",
    "a portal deliberately shows no Instant chip: instant booking is first-come-first-served among FRIENDS, and the rules refuse it to a link visitor, so the chip would promise something that cannot happen",
  ]) {
    console.log(`  · ${line}`);
  }

  console.log("\nNot reachable from seeded data at all");
  for (const line of [
    "the onboarding gate and the unverified-email banner — both live on the Auth account, not in Firestore",
    "photo add / delete / reorder, the Cover badge and the max-photos note — your own places are left photo-less on purpose, so upload one and they all appear",
    'the "just taken by someone else" races on booking and confirming — they need two clients at once',
    "the stay-cancelled warning in Settings — that's your own preference, one tap away in Notifications",
  ]) {
    console.log(`  · ${line}`);
  }
}

async function main(): Promise<void> {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  // Email lives on the Auth account only, so resolve there and read by uid.
  let uid: string;
  try {
    uid = (await getAuth().getUserByEmail(REAL_EMAIL)).uid;
  } catch {
    console.error(
      `No account with email ${REAL_EMAIL}. Sign into the app once, then re-run (or pass your email as an arg).`,
    );
    process.exit(1);
  }
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) {
    console.error(
      `Account ${REAL_EMAIL} has no profile yet — finish onboarding (pick a display name) in the app, then re-run.`,
    );
    process.exit(1);
  }
  const data = snap.data() ?? {};
  const real: RealUser = {
    uid,
    displayName: data.displayName ?? "You",
    username: data.username ?? "",
    photoURL: data.photoURL ?? null,
  };
  console.log(`Found you: ${real.displayName} (${uid})`);

  const removed = await wipe(db, uid);
  const removedObjects = await wipeObjects(uid);
  console.log(
    `Cleared ${removed} document(s) and ${removedObjects} photo object(s) from the previous run.`,
  );

  // Resolve the sentinel.
  const listings: readonly SeedListing[] = [
    ...MY_LISTINGS.map((listing) => ({ ...listing, ownerId: uid })),
    ...OTHER_LISTINGS,
  ].map((listing) => ({
    ...listing,
    windows: listing.windows.map((window) =>
      window.bookedBy === ME ? { ...window, bookedBy: uid } : window,
    ),
  }));

  const avatarCount = await uploadAvatars();
  const photos = new Map<string, readonly ListingPhoto[]>();
  for (const listing of listings) {
    if (listing.photoCount === 0) continue;
    photos.set(listing.id, await uploadListingPhotos(listing, listing.ownerId));
  }

  const writes: Write[] = [];
  writePeople(writes, real);
  writeListings(writes, listings, photos);
  writeBookings(writes, real, listings);
  writePortals(writes, real, listings, photos);
  writeRequests(writes, real);
  writeSearches(writes, real);
  await commitAll(db, writes);

  const windows = listings.reduce(
    (total, listing) => total + listing.windows.length,
    0,
  );
  const friends = PEOPLE.filter((seeded) => seeded.friendSince !== null).length;
  const photoCount = [...photos.values()].reduce(
    (total, list) => total + list.length,
    0,
  );
  console.log(
    `Seeded ${PEOPLE.length} people (${friends} of them friends), ${listings.length} places, ` +
      `${windows} date ranges, ${BOOKINGS.length} bookings, ${PORTALS.length} share links, ` +
      `${REQUESTS.length} connect requests, ${photoCount} photos and ${avatarCount} avatars, ` +
      `in ${writes.length} writes.`,
  );
  printTour();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
