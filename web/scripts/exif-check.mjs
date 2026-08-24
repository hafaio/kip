// Proves what the privacy page promises: a photo's EXIF — the GPS tag included —
// does not survive `shrink`, and the two ways re-encoding can fail now refuse the
// upload instead of quietly shipping the original.
//
//   cd web && bun run check:exif
//
// A browser, not a unit test, and that is not a shortcut: the promise rests on
// Chrome's own canvas encoder, so a DOM shim in bun would be testing a different
// encoder than the one people upload through. It needs no dev server and no
// emulator — the real `shrink` is bundled and evaluated on about:blank.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));

const failures = [];
function expect(what, ok, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
}

const MARKER = "KIP-EXIF-PROBE";

// An EXIF APP1 carrying a GPS IFD and a findable string, so "is it gone?" is a
// byte search rather than a judgement. Little-endian TIFF, offsets from its head.
function exifSegment() {
  const IFD0 = 8;
  const GPS = IFD0 + 2 + 2 * 12 + 4;
  const LATITUDE = GPS + 2 + 3 * 12 + 4;
  const MAKE = LATITUDE + 24;
  const tiff = new DataView(new ArrayBuffer(MAKE + 16));
  const u8 = new Uint8Array(tiff.buffer);
  const set16 = (at, value) => tiff.setUint16(at, value, true);
  const set32 = (at, value) => tiff.setUint32(at, value, true);
  const entry = (at, tag, type, count, value) => {
    set16(at, tag);
    set16(at + 2, type);
    set32(at + 4, count);
    set32(at + 8, value);
  };

  u8.set([0x49, 0x49], 0); // "II"
  set16(2, 42);
  set32(4, IFD0);

  set16(IFD0, 2);
  entry(IFD0 + 2, 0x010f, 2, MARKER.length + 1, MAKE); // Make
  entry(IFD0 + 14, 0x8825, 4, 1, GPS); // GPSInfoIFDPointer
  set32(IFD0 + 26, 0);

  set16(GPS, 3);
  entry(GPS + 2, 0x0000, 1, 4, 0x00000302); // GPSVersionID 2.3.0.0
  entry(GPS + 14, 0x0001, 2, 2, 0x0000004e); // GPSLatitudeRef "N"
  entry(GPS + 26, 0x0002, 5, 3, LATITUDE); // GPSLatitude
  set32(GPS + 38, 0);

  for (const [at, [numerator, denominator]] of [
    [52, 1],
    [22, 1],
    [0, 1],
  ].entries()) {
    set32(LATITUDE + at * 8, numerator);
    set32(LATITUDE + at * 8 + 4, denominator);
  }
  u8.set(new TextEncoder().encode(MARKER), MAKE);

  const payload = new Uint8Array(6 + u8.length);
  payload.set(new TextEncoder().encode("Exif\0\0"), 0);
  payload.set(u8, 6);

  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return segment;
}

function withExif(jpeg) {
  const segment = exifSegment();
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0); // SOI
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

// Every marker segment in the file, so "no EXIF" is checked over the whole
// structure rather than over the one segment this script happens to write.
function markers(jpeg) {
  const found = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    found.push(marker);
    at += 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
  }
  return found;
}

// The entry has to sit under `web/` for `firebase/...` to resolve, and the app's
// own tsc and biome must never see it — hence a scratch dir inside node_modules.
const bundle = (() => {
  const dir = join(WEB, "node_modules", ".cache", "kip-exif");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.js");
  writeFileSync(
    entry,
    `import { shrink, PhotoEncodeError } from ${JSON.stringify(join(WEB, "utils", "photos.ts"))};\n` +
      "globalThis.__shrink = shrink;\n" +
      "globalThis.__PhotoEncodeError = PhotoEncodeError;\n",
  );
  const built = spawn("bun", ["build", entry, "--target=browser", "--outfile", out], {
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    built.on("exit", (code) =>
      code === 0
        ? resolve(readFileSync(out, "utf8"))
        : reject(new Error("bun build failed")),
    );
  });
})();

let chrome;
async function browser() {
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9337",
      "--user-data-dir=/tmp/kip-exif-check",
      "--disable-gpu",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 5000));
  const targets = await (await fetch("http://127.0.0.1:9337/json/list")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message.result ?? message.error);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}) => {
    const at = ++id;
    ws.send(JSON.stringify({ id: at, method, params }));
    return new Promise((r) => waiting.set(at, r));
  };
  await send("Runtime.enable");
  return async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page threw");
    }
    return result?.result?.value;
  };
}

const evaluate = await browser();
await evaluate(await bundle);

await evaluate(`
globalThis.__bytes = (blob) => blob.arrayBuffer().then((buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))));
globalThis.__blob = (base64) => new Blob(
  [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
  { type: "image/jpeg" },
);
`);

// Chrome writes the fixture, so it is a JPEG its own decoder will accept — the
// EXIF is then spliced in here, which is what a camera does.
const plain = Buffer.from(
  await evaluate(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const context = canvas.getContext("2d");
    context.fillStyle = "#c96";
    context.fillRect(0, 0, 120, 90);
    context.fillStyle = "#333";
    context.fillRect(20, 20, 60, 40);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return __bytes(blob);
  })()`),
  "base64",
);
const fixture = withExif(new Uint8Array(plain));
const fixtureText = Buffer.from(fixture).toString("latin1");

expect("the fixture carries an EXIF APP1", markers(fixture).includes(0xe1));
expect("...with a GPS tag in it", fixtureText.includes(MARKER) && fixtureText.includes("Exif\0\0"));

const shrunk = Buffer.from(
  await evaluate(
    `__shrink(__blob(${JSON.stringify(Buffer.from(fixture).toString("base64"))}), 1600).then(__bytes)`,
  ),
  "base64",
);
const shrunkText = shrunk.toString("latin1");

expect("shrink returns a JPEG", shrunk[0] === 0xff && shrunk[1] === 0xd8, [...shrunk.subarray(0, 4)].join(","));
expect("no APP1 segment survives", !markers(shrunk).includes(0xe1), markers(shrunk).map((m) => m.toString(16)).join(" "));
expect("no EXIF header anywhere in the bytes", !shrunkText.includes("Exif\0\0"));
expect("no GPS block anywhere in the bytes", !shrunkText.includes(MARKER));

const decoded = await evaluate(
  `createImageBitmap(__blob(${JSON.stringify(shrunk.toString("base64"))})).then((b) => b.width + "x" + b.height)`,
);
expect("and it is still a picture", decoded === "120x90", String(decoded));

console.log("\nand the ways re-encoding can fail refuse the upload");
const noContext = await evaluate(`(async () => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => null;
  try {
    await __shrink(__blob(${JSON.stringify(plain.toString("base64"))}), 1600);
    return "returned";
  } catch (caught) {
    return caught instanceof __PhotoEncodeError ? "threw" : "wrong error";
  } finally {
    HTMLCanvasElement.prototype.getContext = getContext;
  }
})()`);
expect("a canvas with no 2d context throws", noContext === "threw", String(noContext));

const noBlob = await evaluate(`(async () => {
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  try {
    await __shrink(__blob(${JSON.stringify(plain.toString("base64"))}), 1600);
    return "returned";
  } catch (caught) {
    return caught instanceof __PhotoEncodeError ? "threw" : "wrong error";
  } finally {
    HTMLCanvasElement.prototype.toBlob = toBlob;
  }
})()`);
expect("a source that will not re-encode throws", noBlob === "threw", String(noBlob));

console.log(failures.length === 0 ? "\nall good\n" : `\n${failures.length} failed\n`);
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);
