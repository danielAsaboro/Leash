import type { Metadata } from "next";
import { fraunces, newsreader, plexMono } from "./fonts.ts";
import { LeashRail } from "../components/LeashRail.tsx";
import { SearchPalette } from "../components/SearchPalette.tsx";
import { OfflineHud } from "../components/OfflineHud.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leash — your private on-device assistant",
  description: "A private, on-device assistant with access to your world. Powered by your own device mesh; The Understory is one of its surfaces.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/leash-mark.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`}>
      <body className="min-h-screen">
        <LeashRail />
        <div className="leash-content relative z-10">{children}</div>
        <SearchPalette />
        <OfflineHud />
      </body>
    </html>
  );
}
