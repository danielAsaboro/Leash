import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Download Leash — every platform",
  description:
    "Get Leash for macOS, Windows, Linux, Android, iOS, iPadOS, or open it in your browser. Private, on-device, yours.",
};

const GITHUB_URL = "https://github.com/danielAsaboro/Leash";
const RELEASES_URL = "https://github.com/danielAsaboro/Leash/releases/latest";
const X_URL = "https://x.com/useLeash";

/**
 * One entry per platform. `href` null → a dimmed "Coming soon" card. To ship a real
 * installer later, set `href` to the GitHub Release asset / store URL. `web` opens the
 * user's own locally-running Leash (local-first: there is no cloud-hosted app).
 */
type Platform = { name: string; note: string; href: string | null; cta: string };

const PLATFORMS: Platform[] = [
  { name: "macOS", note: ".dmg · Apple Silicon & Intel", href: RELEASES_URL, cta: "Get from Releases" },
  { name: "Windows", note: ".exe installer", href: null, cta: "" },
  { name: "Linux", note: ".AppImage · .deb", href: null, cta: "" },
  { name: "Android", note: "Play Store · .apk", href: null, cta: "" },
  { name: "iOS", note: "App Store · TestFlight", href: null, cta: "" },
  { name: "iPadOS", note: "App Store · TestFlight", href: null, cta: "" },
  { name: "Web", note: "Open your running instance", href: "http://localhost:6801", cta: "Open localhost:6801" },
];

export default function Downloads() {
  return (
    <div className="landing">
      {/* Masthead nav */}
      <header className="landing-topbar">
        <Link href="/" className="landing-brand" aria-label="Leash">
          <Image src="/icon-512.png" alt="" width={32} height={32} className="landing-brand-mark" priority />
          <span className="landing-brand-word">Leash</span>
        </Link>
        <nav className="landing-topnav">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
          <Link href="/" className="landing-topnav-cta">Home →</Link>
        </nav>
      </header>

      <div className="landing-rule-thick" />
      <div className="landing-masthead">
        <span className="landing-masthead-side">Get Leash</span>
        <h1 className="landing-wordmark" aria-label="Download">DOWNLOAD</h1>
        <span className="landing-masthead-side landing-masthead-side-r">On-device · Private</span>
      </div>
      <div className="landing-rule-thin" />

      <section className="landing-reveal" style={{ padding: "2.5rem 1.5rem" }}>
        <p className="dl-intro">
          Leash runs entirely on your own hardware. Desktop installers come from{" "}
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">GitHub Releases</a>;
          mobile ships through the app stores. The Web option opens Leash in your browser against
          the instance running on your own machine — there is no cloud version, by design.
        </p>

        <div className="dl-grid">
          {PLATFORMS.map((p) => (
            <div key={p.name} className="dl-card">
              <span className="dl-card-name">{p.name}</span>
              <span className="dl-card-note">{p.note}</span>
              <div className="dl-card-action">
                {p.href ? (
                  <a className="dl-btn" href={p.href} target="_blank" rel="noopener noreferrer">
                    {p.cta} <span aria-hidden>→</span>
                  </a>
                ) : (
                  <span className="dl-soon">Coming soon</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="landing-rule-thick" />
      <footer className="landing-footer">
        <span className="landing-footer-mark">LEASH</span>
        <nav className="landing-footer-nav">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
          <Link href="/">Home</Link>
        </nav>
        <span className="landing-footer-meta">Apache-2.0 · QVAC Hackathon · useleash.xyz</span>
      </footer>
    </div>
  );
}
