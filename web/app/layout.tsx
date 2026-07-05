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
