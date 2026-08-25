import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The service worker is its own compile — `sw/sw.ts` to `public/sw.js` — and it
// happens HERE because this file is the one thing every Next command loads.
// Wired into the `dev` and `export` scripts instead, a bare `next build` shipped
// a site whose sw.js 404s: no worker, no offline, and nothing said so.
//
// Anchored to this file rather than the working directory, which Next does NOT
// set to the project: `next build web` from the repo root died with ENOENT out
// of top-level evaluation, before Next printed anything — a worse failure than
// the missing worker this replaces.
const here = dirname(fileURLToPath(import.meta.url));
execFileSync(
  join(here, "node_modules", ".bin", "tsc"),
  ["-p", "tsconfig.sw.json"],
  {
    cwd: here,
    stdio: "inherit",
  },
);

// Published via GitHub Pages. NEXT_PUBLIC_BASE_PATH is set by the deploy
// workflow to /<repo-name>; change it here if a custom domain is used.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
};
