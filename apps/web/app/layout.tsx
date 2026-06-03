import type { Metadata } from "next";
import { fraunces, newsreader, plexMono } from "./fonts.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { SearchPalette } from "../components/SearchPalette.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Understory — your private daily paper",
  description: "A private, on-device daily paper. Discovered, written, fact-checked and illustrated by your own device mesh.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`}>
      <body className="min-h-screen">
        <div className="relative z-10">{children}</div>
        <BrandMark />
        <SearchPalette />
      </body>
    </html>
  );
}
