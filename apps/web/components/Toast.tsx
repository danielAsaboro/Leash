"use client";
import { useEffect, useState } from "react";
import { CheckCircleIcon, XCircleIcon, XIcon } from "lucide-react";

/**
 * A tiny dependency-free toast system (broadsheet-styled). A module-level pub/sub — shared across
 * the CLIENT bundle (unlike per-route server modules), so `toast.success(...)` from anywhere reaches
 * the single <Toaster/> mounted in the root layout. Built in-house to avoid pulling another package
 * (the ai-elements/shadcn CLIs keep clobbering node_modules on install).
 */

type ToastKind = "success" | "error" | "info";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let counter = 0;
const listeners = new Set<(t: ToastItem) => void>();
function emit(kind: ToastKind, message: string) {
  const item: ToastItem = { id: ++counter, kind, message };
  for (const l of listeners) l(item);
}

export const toast = {
  success: (message: string) => emit("success", message),
  error: (message: string) => emit("error", message),
  info: (message: string) => emit("info", message),
};

const DURATION_MS = 3500;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const onToast = (t: ToastItem) => {
      setItems((prev) => [...prev, t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), DURATION_MS);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  const dismiss = (id: number) => setItems((prev) => prev.filter((x) => x.id !== id));

  if (items.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-icon" aria-hidden>
            {t.kind === "success" ? <CheckCircleIcon className="size-4" /> : t.kind === "error" ? <XCircleIcon className="size-4" /> : null}
          </span>
          <span className="toast-msg">{t.message}</span>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
