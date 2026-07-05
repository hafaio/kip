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
