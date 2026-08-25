import type { MetadataRoute } from "next";

// Pages serves the site under /<repo>, and nothing here is prefixed for us:
// `start_url`, `scope` and every icon path are taken literally.
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// A static export has no request to vary on.
export const dynamic = "force-static";

// `scope` deliberately covers the whole app, so /portal/ and /continue/ open
// inside an installed kip too — a share link handed to someone who has it
// installed should not bounce them out to a browser tab.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "kip",
    short_name: "kip",
    description:
      "Share a spare room or your whole place with friends, for free.",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    background_color: "#f6f1ea",
    theme_color: "#f6f1ea",
    icons: [
      { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png" },
      // Full-bleed, with the mark inside the safe circle: Android crops a
      // non-maskable icon to whatever shape the launcher uses, which would take
      // the edges off the disc.
      {
        src: `${base}/icon-maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
