"use client";
import { useRef, useState } from "react";

/**
 * "🔊 Read aloud" control. The narration WAV is synthesized on-device by the newsroom
 * daemon (GGML TTS) and served statically from public/audio, so this stays a plain
 * <audio> tag — `apps/web` never pulls in the SDK. `preload="none"` keeps the page
 * light until the reader actually presses play.
 *
 * Idle → a single "Read aloud" button. Once started → a Pause/Resume toggle plus a
 * Restart button (jump to 0 and replay).
 */
export function ArticleAudio({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);

  const play = () => {
    ref.current?.play().catch(() => {});
  };
  const pause = () => {
    ref.current?.pause();
  };
  const restart = () => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = 0;
    el.play().catch(() => {});
  };

  const btn =
    "kicker inline-flex items-center gap-2 rounded-full border px-4 py-1.5 transition-opacity hover:opacity-70";
  const style = { borderColor: "var(--color-rule-strong)", color: "var(--color-sage-deep)" } as const;

  return (
    <div className="mt-6 flex items-center justify-center gap-3">
      {!started ? (
        <button type="button" onClick={play} aria-label="Read article aloud" className={btn} style={style}>
          <span aria-hidden>🔊</span>
          Read aloud
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={playing ? pause : play}
            aria-label={playing ? "Pause narration" : "Resume narration"}
            className={btn}
            style={style}
          >
            <span aria-hidden>{playing ? "⏸" : "▶"}</span>
            {playing ? "Pause" : "Resume"}
          </button>
          <button type="button" onClick={restart} aria-label="Restart narration" className={btn} style={style}>
            <span aria-hidden>↺</span>
            Restart
          </button>
        </>
      )}
      <audio
        ref={ref}
        src={src}
        preload="none"
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
