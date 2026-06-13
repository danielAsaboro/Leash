import type { Metadata } from "next";
import Link from "next/link";
import { LeashMark } from "../components/LeashMark.tsx";
import { AppEmbed } from "../components/landing/AppEmbed.tsx";
import { WaitlistForm } from "../components/landing/WaitlistForm.tsx";

/**
 * The Leash landing page (useleash.xyz) — a broadsheet front page. Public marketing surface: explain
 * what Leash is and convert to the waitlist. Served locally at `/` (the app rail hides itself here);
 * the same page deploys to the domain. The app lives at /chat, /brain, /economy, … (reach via "Open Leash").
 */

export const metadata: Metadata = {
  title: "Leash — your private, on-device assistant",
  description: "A private assistant grounded in your own data. No cloud. Powered by your personal device mesh — with a live economy of agents that pay each other for compute. QVAC Hackathon.",
};

const GITHUB_URL = "https://github.com/danielAsaboro/Leash";
const DOCS_URL = "https://docs.useleash.xyz"; // placeholder — point at the Mintlify docs / tunnel

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

export default function Landing() {
  return (
    <div className="landing">
      {/* Masthead nav */}
      <header className="landing-topbar">
        <a href="#top" className="landing-brand" aria-label="Leash">
          <LeashMark className="landing-brand-mark" cutoutColor="var(--color-ink)" />
          <span className="landing-brand-word">Leash</span>
        </a>
        <nav className="landing-topnav">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="#waitlist">Waitlist</a>
          <Link href="/chat" className="landing-topnav-cta">Open Leash →</Link>
        </nav>
      </header>

      {/* Front-page masthead */}
      <div id="top" className="landing-masthead">
        <span className="landing-masthead-side">Vol. I · No. 1</span>
        <h1 className="landing-wordmark">LEASH</h1>
        <span className="landing-masthead-side landing-masthead-side-r">On-device · Private · Est. 2026</span>
      </div>
      <div className="landing-rule-thick" />
      <div className="landing-rule-thin" />

      {/* Hero */}
      <section className="landing-hero">
        <p className="landing-kicker kicker kicker-sage">The private exocortex</p>
        <h2 className="landing-headline">Your mind, on your own devices.</h2>
        <p className="landing-dek">
          Leash is a private assistant grounded in your own data — your notes, your files, your world. It runs entirely on your devices.
          No cloud. No leak. Powered by your personal mesh.
        </p>
        <div className="landing-cta-row">
          <a href="#waitlist" className="landing-btn landing-btn-primary">Join the waitlist</a>
          <Link href="/chat" className="landing-btn">Open Leash</Link>
        </div>
      </section>

      <div className="landing-rule-thin" />

      {/* Three pillars */}
      <section className="landing-pillars">
        {PILLARS.map((p) => (
          <div key={p.kicker} className="landing-pillar">
            <h3 className="landing-pillar-kicker">{p.kicker}</h3>
            <p className="landing-pillar-body">{p.body}</p>
          </div>
        ))}
      </section>

      <div className="landing-rule-thin" />

      {/* The figures — in-app screenshots */}
      <section className="landing-figures">
        <p className="landing-section-kicker kicker">Inside Leash</p>
        <div className="landing-figures-grid">
          <AppEmbed route="/chat" caption="Chats — your assistant, grounded in your data, with a visible plan." />
          <AppEmbed route="/settings" caption="Mesh — your devices, paired and sharing models & compute." />
          <AppEmbed route="/brain" caption="Models — what you run locally, and what you can borrow." />
        </div>
      </section>

      <div className="landing-rule-thick" />

      {/* Feature spread — the Agent Economy */}
      <section className="landing-economy">
        <div className="landing-economy-copy">
          <p className="landing-section-kicker kicker kicker-sage">The feature</p>
          <h2 className="landing-economy-head">An economy of agents.</h2>
          <p className="landing-economy-dek">Your devices form a market for intelligence.</p>
          <p className="landing-economy-body">
            When a node needs more model than it can run, it doesn’t fall back to the cloud — it <strong>borrows compute</strong> from another
            device on the mesh and <strong>pays per token</strong>, <strong>settled on-chain</strong> (x402-style machine payments). Providers
            earn; small hardware runs big models. A real machine-to-machine economy, live across your own devices.
          </p>
          <Link href="/economy" className="landing-btn">See the economy</Link>
        </div>
        <AppEmbed route="/economy" caption="Economy — paid, on-chain-settled compute between your agents." />
      </section>

      <div className="landing-rule-thick" />

      {/* …and more */}
      <section className="landing-more">
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
      <section className="landing-how">
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

      {/* Waitlist */}
      <section id="waitlist" className="landing-waitlist">
        <h2 className="landing-waitlist-head">Put your AI on a leash.</h2>
        <p className="landing-waitlist-dek">Private, on-device, yours. Join the waitlist and we’ll let you in.</p>
        <WaitlistForm />
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <span className="landing-footer-mark">LEASH</span>
        <nav className="landing-footer-nav">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <Link href="/chat">Open Leash</Link>
          <a href="#waitlist">Waitlist</a>
        </nav>
        <span className="landing-footer-meta">Apache-2.0 · QVAC Hackathon · useleash.xyz</span>
      </footer>
    </div>
  );
}
