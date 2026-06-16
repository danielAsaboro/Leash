/**
 * Self-hosted fonts (next/font/local) so production builds stay fully OFFLINE — no
 * next/font/google fetch at build time. Three voices for a broadsheet:
 *   · Fraunces  — display: masthead + headlines (old-style, characterful serif)
 *   · Newsreader — body: article text + deks (Scotch-style reading serif)
 *   · IBM Plex Mono — kickers, timestamps, labels, telemetry
 * All three are OFL-licensed (see app/fonts/OFL.txt).
 */
import localFont from "next/font/local";

export const fraunces = localFont({
  src: [
    { path: "./fonts/fraunces-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/fraunces-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/fraunces-900-normal.woff2", weight: "900", style: "normal" },
    { path: "./fonts/fraunces-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/fraunces-600-italic.woff2", weight: "600", style: "italic" },
  ],
  variable: "--font-fraunces",
  display: "swap",
});

export const newsreader = localFont({
  src: [
    { path: "./fonts/newsreader-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/newsreader-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/newsreader-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/newsreader-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/newsreader-500-italic.woff2", weight: "500", style: "italic" },
  ],
  variable: "--font-newsreader",
  display: "swap",
});

export const plexMono = localFont({
  src: [
    { path: "./fonts/plexmono-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plexmono-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plexmono-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
});
