/**
 * A live in-app preview — the real Leash route embedded in a broadsheet "photo" frame, scaled down
 * and non-interactive. The app is always reachable (locally, or via tunnel at useleash.xyz), so the
 * preview IS the actual app layout, never a screenshot to capture or a file to 404.
 */
export function AppEmbed({ route, caption }: { route: string; caption: string }) {
  return (
    <figure className="landing-figure">
      <div className="landing-figure-frame landing-embed">
        <iframe src={route} title={caption} className="landing-embed-iframe" loading="lazy" tabIndex={-1} scrolling="no" />
      </div>
      <figcaption className="landing-figure-cap">{caption}</figcaption>
    </figure>
  );
}
