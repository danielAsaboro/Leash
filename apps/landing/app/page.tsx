import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { AppEmbed } from "../components/AppEmbed.tsx";

/**
 * The Leash landing page (useleash.xyz) — a broadsheet front page. Public marketing surface: explain
 * what Leash is and convert to a download. This is the standalone `apps/landing` deploy (Vercel); it
 * ships only `/` and `/downloads` — no app routes. CTAs point to /downloads, GitHub, and X.
 */

export const metadata: Metadata = {
  title: "Leash — your private, on-device assistant",
  description: "A private assistant grounded in your own data. No cloud. Powered by your personal device mesh — with a live economy of agents that pay each other for compute. QVAC Hackathon.",
};

const GITHUB_URL = "https://github.com/danielAsaboro/Leash";
const DOCS_URL = "https://docs.useleash.xyz"; // placeholder — point at the Mintlify docs / tunnel
const X_URL = "https://x.com/useLeash";

const PILLARS = [
  { kicker: "Private", body: "End-to-end encrypted, and yours. Your data never leaves your devices — no server to subpoena, no model trained on you." },
  { kicker: "On-device", body: "Every token, embedding, and fine-tune runs on your own hardware via QVAC. It works in airplane mode." },
  { kicker: "Your mesh", body: "Your phone, laptop, and desktop become one brain. Borrow a bigger model or more compute from whichever device has it." },
];

const MORE = [
  { name: "The Understory", note: "your private newspaper, written from your world" },
  { name: "Brain & Memory", note: "RAG grounded in your own notes" },
  { name: "Research", note: "deep, cited, on-device" },
  { name: "Skills", note: "teach it new workflows" },
  { name: "Voice & Call", note: "hands-free, fully local" },
  { name: "Plan mode", note: "approve a plan, then it runs" },
  { name: "On-device LoRA", note: "fine-tunes that stay yours" },
];

const HOW = [
  { n: "01", h: "Inference & embeddings", b: "GGUF models run locally through QVAC — chat, RAG, and vision, all on your hardware." },
  { n: "02", h: "Encrypted P2P mesh", b: "Devices pair over an end-to-end-encrypted DHT — no broker, no cloud relay." },
  { n: "03", h: "Delegated compute", b: "A node that needs more model borrows it from another and pays per token." },
  { n: "04", h: "On-device fine-tuning", b: "LoRA adapters (QVAC Fabric) personalize the model without sending a byte off-device." },
];

const WORDMARK = "LEASH".split("");

export default function Landing() {
  return (
    <div className="landing">
      {/* Masthead nav */}
      <header className="landing-topbar">
        <a href="#top" className="landing-brand" aria-label="Leash">
          <Image src="/icon-512.png" alt="" width={32} height={32} className="landing-brand-mark" priority />
          <span className="landing-brand-word">Leash</span>
        </a>
        <nav className="landing-topnav">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <Link href="/downloads" className="landing-topnav-cta">Download →</Link>
        </nav>
      </header>

      {/* Front-page masthead */}
      <div id="top" className="landing-masthead">
        <span className="landing-masthead-side">Vol. I · No. 1</span>
        <h1 className="landing-wordmark" aria-label="Leash">
          {WORDMARK.map((c, i) => (
            <span key={i} className="landing-wordmark-char" style={{ animationDelay: `${0.12 + i * 0.08}s` }}>
              {c}
            </span>
          ))}
        </h1>
        <span className="landing-masthead-side landing-masthead-side-r">On-device · Private · Est. 2026</span>
      </div>
      <div className="landing-rule-thick" />
      <div className="landing-dateline">
        <span className="landing-dateline-end">Late Edition</span>
        <span className="landing-dateline-mid">Private · On-device · Encrypted end-to-end · No cloud, ever</span>
        <span className="landing-dateline-end landing-dateline-r">Price: your privacy, kept</span>
      </div>
      <div className="landing-rule-thin" />

      {/* Hero */}
      <section className="landing-hero">
        <p className="landing-kicker kicker kicker-sage rise" style={{ animationDelay: "0.5s" }}>The private exocortex</p>
        <h2 className="landing-headline rise" style={{ animationDelay: "0.6s" }}>Your mind, on your own devices.</h2>
        <p className="landing-dek rise" style={{ animationDelay: "0.72s" }}>
          Leash is a private assistant grounded in your own data — Apple Notes, files, memory, and your world. It runs entirely on your devices.
          No cloud. No leak. Powered by your personal mesh.
        </p>
        <div className="landing-cta-row rise" style={{ animationDelay: "0.84s" }}>
          <Link href="/downloads" className="landing-btn landing-btn-primary">
            Download Leash<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Star on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
      </section>

      <div className="landing-rule-thin" />

      {/* Three pillars */}
      <section className="landing-pillars landing-reveal">
        {PILLARS.map((p, i) => (
          <div key={p.kicker} className="landing-pillar">
            <span className="landing-pillar-folio">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="landing-pillar-kicker">{p.kicker}</h3>
            <p className="landing-pillar-body">{p.body}</p>
          </div>
        ))}
      </section>

      <div className="landing-rule-thin" />

      {/* The figures — in-app screenshots */}
      <section className="landing-figures landing-reveal">
        <p className="landing-section-kicker kicker">Inside Leash</p>
        <div className="landing-figures-grid">
          <AppEmbed plate="I" route="/chat" caption="Chats — your assistant, grounded in your data, with a visible plan." />
          <AppEmbed plate="II" route="/mesh" caption="Mesh — your devices, paired and sharing models & compute." />
          <AppEmbed plate="III" route="/brain" caption="Models — what you run locally, and what you can borrow." />
        </div>
      </section>

      <div className="landing-rule-thick" />

      {/* Feature spread — the Agent Economy */}
      <section className="landing-economy landing-reveal">
        <div className="landing-economy-copy">
          <p className="landing-section-kicker landing-section-kicker-left kicker kicker-sage">The feature</p>
          <h2 className="landing-economy-head">An economy of agents.</h2>
          <p className="landing-economy-dek">Your devices form a market for intelligence.</p>
          <p className="landing-economy-body">
            When a node needs more model than it can run, it doesn’t fall back to the cloud — it <strong>borrows compute</strong> from another
            device on the mesh and <strong>pays per token</strong>, <strong>settled on-chain</strong> (x402-style machine payments). Providers
            earn; small hardware runs big models. A real machine-to-machine economy, live across your own devices.
          </p>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            See it on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
        <AppEmbed plate="IV" route="/economy" caption="Economy — paid, on-chain-settled compute between your agents." />
      </section>

      <div className="landing-rule-thick" />

      {/* …and more */}
      <section className="landing-more landing-reveal">
        <p className="landing-section-kicker kicker">…and more</p>
        <div className="landing-more-grid">
          {MORE.map((m) => (
            <div key={m.name} className="landing-more-item">
              <span className="landing-more-name">{m.name}</span>
              <span className="landing-more-note">{m.note}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="landing-rule-thin" />

      {/* How it works / QVAC */}
      <section className="landing-how landing-reveal">
        <p className="landing-section-kicker kicker">How it works</p>
        <div className="landing-how-grid">
          {HOW.map((s) => (
            <div key={s.n} className="landing-how-step">
              <span className="landing-how-n">{s.n}</span>
              <h3 className="landing-how-h">{s.h}</h3>
              <p className="landing-how-b">{s.b}</p>
            </div>
          ))}
        </div>
        <p className="landing-how-foot">Built for <strong>QVAC Hackathon I — “Unleash Edge AI”</strong>. All on-device, by design.</p>
      </section>

      <div className="landing-rule-thick" />

      {/* Get Leash */}
      <section id="get" className="landing-waitlist landing-reveal">
        <h2 className="landing-waitlist-head">Put your AI on a leash.</h2>
        <p className="landing-waitlist-dek">Private, on-device, yours. Download Leash for your platform.</p>
        <div className="landing-cta-row" style={{ justifyContent: "center" }}>
          <Link href="/downloads" className="landing-btn landing-btn-primary">
            Download Leash<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Star on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Follow on X<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <span className="landing-footer-mark">LEASH</span>
        <nav className="landing-footer-nav">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <Link href="/downloads">Download</Link>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
        </nav>
        <span className="landing-footer-meta">Apache-2.0 · QVAC Hackathon · useleash.xyz</span>
      </footer>
    </div>
  );
}
