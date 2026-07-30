import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ThemeProvider } from "next-themes";
import type { ReactElement, ReactNode } from "react";
import DialogProvider from "../components/dialog";
import { KipProvider } from "../utils/store";
import "./globals.css";

// Plus Jakarta Sans carries the whole Terra identity — body and headings alike,
// headings just heavier and tighter. Self-hosted into the static export and
// exposed as the --font-jakarta CSS var (wired to --font-sans in globals.css).
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "kip",
  description: "Share a spare room or your whole place with friends, for free.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning className={jakarta.variable}>
      {/* Every screen's first act is to sign in and read, and each host costs a
          DNS lookup and a TLS handshake before a byte of that moves. Starting
          them alongside the bundle download matters most on the share-link page,
          which a stranger opens cold with nothing warmed by a previous visit.

          `crossOrigin` has to MATCH how the request is eventually made or the
          socket lands in the wrong pool and is never reused — the hint then
          costs a connection and saves nothing. The SDK reaches the three API
          hosts by CORS fetch/XHR with no credentials; photos are plain <img
          src>, so that one takes no attribute. */}
      <head>
        <link
          rel="preconnect"
          href="https://firestore.googleapis.com"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://identitytoolkit.googleapis.com"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://securetoken.googleapis.com"
          crossOrigin="anonymous"
        />
        <link rel="preconnect" href="https://firebasestorage.googleapis.com" />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <DialogProvider>
            <KipProvider>{children}</KipProvider>
          </DialogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
