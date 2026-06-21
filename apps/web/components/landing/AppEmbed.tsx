"use client";
import { useState } from "react";

/**
 * A static in-app screenshot of a Leash component, in a broadsheet "photo" frame.
 *
 * It is deliberately NOT a live `<iframe>` of the route: the dashboard is gated
 * behind local onboarding, so embedding it would either break or punch a hole in
 * the device gate. Screenshots live at
 * `public/landing/<slug>.png` (one per component); until a PNG is dropped in, a
 * captioned placeholder renders via `onError` — never a 404 or a live embed.
 *
 * `route` is kept as the API (e.g. "/chat") and maps to a slug ("chat") so the
 * landing markup is unchanged; capture component shots to `public/landing/<slug>.png`.
 */
export function AppEmbed({ route, caption, plate }: { route: string; caption: string; plate?: string }) {
  const slug = route.replace(/^\//, "").replace(/\//g, "-") || "home";
  const [ok, setOk] = useState(true);
  return (
    <figure className="landing-figure">
      <div className="landing-figure-frame landing-embed">
        {plate ? <span className="landing-figure-plate">Plate №&thinsp;{plate}</span> : null}
        {ok ? (
          <img
            src={`/landing/${slug}.png`}
            alt={caption}
            className="landing-embed-shot"
            loading="lazy"
            onError={() => setOk(false)}
          />
        ) : (
          <div className="landing-embed-placeholder" aria-hidden>
            <span className="landing-embed-placeholder-title">{caption.split("—")[0].trim()}</span>
            <span className="landing-embed-placeholder-route">{route}</span>
          </div>
        )}
      </div>
      <figcaption className="landing-figure-cap">{caption}</figcaption>
    </figure>
  );
}
