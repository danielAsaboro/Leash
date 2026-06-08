"use client";

/**
 * 👍 / 👎 (+ optional correction) under an assistant answer — the spec's "user
 * corrections/ratings" feeding Layer 4's nightly LoRA.
 *
 * Deliberately decoupled from the chat: it POSTs to /api/leash/feedback from its OWN
 * fire-and-forget fetch and never imports/touches `useChat`, streaming, or abort
 * (the house taboo: never cancel a generation). A failed POST is swallowed — feedback
 * is best-effort and must never break the conversation.
 */
import { useState } from "react";

export function MessageFeedback({
  messageId,
  chatId,
  prompt,
  answer,
}: {
  messageId: string;
  chatId?: string;
  prompt: string;
  answer: string;
}) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [askCorrection, setAskCorrection] = useState(false);
  const [correction, setCorrection] = useState("");
  const [done, setDone] = useState(false);

  const post = (r: "up" | "down", corr?: string) => {
    void fetch("/api/leash/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, chatId, rating: r, prompt, answer, correction: corr }),
    }).catch(() => {
      /* best-effort — never surface into the chat */
    });
  };

  if (done) return <span className="chat-meta">🌱 noted for tonight's training</span>;

  const onUp = () => {
    setRating("up");
    post("up");
    setDone(true);
  };
  const onDown = () => {
    setRating("down");
    setAskCorrection(true);
  };
  const submitCorrection = () => {
    post("down", correction.trim() || undefined);
    setDone(true);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}>
      <button type="button" className={`chat-regen${rating === "up" ? " is-active" : ""}`} aria-pressed={rating === "up"} onClick={onUp} title="Good answer — train on it">
        👍
      </button>
      <button type="button" className={`chat-regen${rating === "down" ? " is-active" : ""}`} aria-pressed={rating === "down"} onClick={onDown} title="Needs work — exclude it (and optionally correct it)">
        👎
      </button>
      {askCorrection && (
        <>
          <input
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCorrection();
            }}
            placeholder="What should it have said? (optional)"
            aria-label="Correction"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              padding: "0.15rem 0.4rem",
              minWidth: "16rem",
              border: "1px solid var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink-soft)",
            }}
          />
          <button type="button" className="chat-regen is-active" onClick={submitCorrection} title="Submit correction">
            Send
          </button>
        </>
      )}
    </span>
  );
}
