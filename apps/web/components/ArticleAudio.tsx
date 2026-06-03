"use client";
import { useRef, useState } from "react";

/**
 * "🔊 Read aloud" control. The narration WAV is synthesized on-device by the newsroom
 * daemon (GGML TTS) and served statically from public/audio, so this stays a plain
 * <audio> tag — `apps/web` never pulls in the SDK. `preload="none"` keeps the page
 * light until the reader actually presses play.
 */
export function ArticleAudio({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play();
  };

  return (
    <div className="mt-6 flex items-center justify-center">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause narration" : "Read article aloud"}
        className="kicker inline-flex items-center gap-2 rounded-full border px-4 py-1.5 transition-opacity hover:opacity-70"
        style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-sage-deep)" }}
      >
        <span aria-hidden>{playing ? "⏸" : "🔊"}</span>
        {playing ? "Pause narration" : "Read aloud"}
      </button>
      <audio
        ref={ref}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
