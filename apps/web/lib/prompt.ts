/**
 * In-app replacement for `window.prompt()` — Electron's packaged renderer does NOT support
 * prompt() (it returns null with a console warning), so any native prompt silently no-ops in the
 * desktop app. This is a drop-in async equivalent: an imperative, app-styled modal that resolves to
 * the entered string, or null if cancelled. Call it from any client handler: `await appPrompt(…)`.
 */
export function appPrompt(message: string, defaultValue = ""): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(20,18,14,0.45)";
    const box = document.createElement("div");
    box.style.cssText =
      "background:var(--color-cream,#f5f1e8);border:1px solid var(--color-rule-strong,#999);padding:20px;min-width:340px;max-width:90vw";
    const label = document.createElement("p");
    label.textContent = message;
    label.style.cssText = "margin:0 0 12px;font-family:var(--font-body,system-ui);font-size:0.95rem;color:var(--color-ink,#1a1a1a)";
    const input = document.createElement("input");
    input.value = defaultValue;
    input.style.cssText =
      "width:100%;box-sizing:border-box;border:1px solid var(--color-rule-strong,#999);background:transparent;padding:8px 10px;font-family:var(--font-mono,monospace);font-size:0.9rem";
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px";
    const btnCss = "padding:6px 14px;cursor:pointer;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;font-family:var(--font-mono,monospace)";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = `${btnCss};border:1px solid var(--color-rule-strong,#999);background:transparent;color:var(--color-muted,#666)`;
    const ok = document.createElement("button");
    ok.textContent = "OK";
    ok.style.cssText = `${btnCss};border:1px solid var(--color-sage-deep,#2f5233);background:var(--color-sage-deep,#2f5233);color:var(--color-cream,#f5f1e8)`;
    let done = false;
    const close = (val: string | null): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") close(input.value);
      else if (e.key === "Escape") close(null);
    };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(input.value);
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    document.addEventListener("keydown", onKey, true);
    btns.append(cancel, ok);
    box.append(label, input, btns);
    overlay.append(box);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
