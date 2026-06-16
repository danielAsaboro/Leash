import type { Metadata } from "next";
import { fraunces, newsreader, plexMono } from "./fonts.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leash — your private, on-device assistant",
  description:
    "A private assistant grounded in your own data. No cloud. Powered by your personal device mesh — with a live economy of agents that pay each other for compute. QVAC Hackathon.",
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
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
