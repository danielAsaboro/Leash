import type { Metadata } from "next";
import { fraunces, newsreader, plexMono } from "./fonts.ts";
import { LeashRail } from "../components/LeashRail.tsx";
import { SearchPalette } from "../components/SearchPalette.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leash — your private on-device assistant",
  description: "A private, on-device assistant with access to your world. Powered by your own device mesh; The Understory is one of its surfaces.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`}>
      <body className="min-h-screen">
        <LeashRail />
        <div className="leash-content relative z-10">{children}</div>
        <SearchPalette />
      </body>
    </html>
  );
}
