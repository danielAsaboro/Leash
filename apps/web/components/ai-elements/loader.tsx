"use client";

import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

/**
 * AI Elements `Loader` — the canonical pending-state spinner rendered after the
 * message list while the model hasn't produced output yet. Vendored like the other
 * ai-elements components; spins via Tailwind's `animate-spin`, inherits `currentColor`.
 */
export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

const LoaderIcon = ({ size = 16 }: { size?: number }) => (
  <svg height={size} width={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
    <path
      d="M8 0C8.36 0 8.65.29 8.65.65V3.24a.65.65 0 1 1-1.3 0V.65C7.35.29 7.64 0 8 0Z"
      fill="currentColor"
      opacity="0.95"
    />
    <path d="M11.7 1.4a.65.65 0 0 1 .24.89l-1.3 2.25a.65.65 0 1 1-1.12-.65l1.3-2.25a.65.65 0 0 1 .88-.24Z" fill="currentColor" opacity="0.85" />
    <path d="M14.6 4.3a.65.65 0 0 1-.24.89l-2.25 1.3a.65.65 0 1 1-.65-1.13l2.25-1.3a.65.65 0 0 1 .89.24Z" fill="currentColor" opacity="0.75" />
    <path d="M16 8c0 .36-.29.65-.65.65h-2.59a.65.65 0 1 1 0-1.3h2.59c.36 0 .65.29.65.65Z" fill="currentColor" opacity="0.65" />
    <path d="M14.6 11.7a.65.65 0 0 1-.89.24l-2.25-1.3a.65.65 0 0 1 .65-1.12l2.25 1.3c.31.18.42.58.24.88Z" fill="currentColor" opacity="0.55" />
    <path d="M11.7 14.6a.65.65 0 0 1-.88-.24l-1.3-2.25a.65.65 0 1 1 1.12-.65l1.3 2.25a.65.65 0 0 1-.24.89Z" fill="currentColor" opacity="0.45" />
    <path d="M8 16a.65.65 0 0 1-.65-.65v-2.59a.65.65 0 1 1 1.3 0v2.59c0 .36-.29.65-.65.65Z" fill="currentColor" opacity="0.35" />
    <path d="M4.3 14.6a.65.65 0 0 1-.24-.89l1.3-2.25a.65.65 0 1 1 1.13.65l-1.3 2.25a.65.65 0 0 1-.89.24Z" fill="currentColor" opacity="0.3" />
    <path d="M1.4 11.7a.65.65 0 0 1 .24-.88l2.25-1.3a.65.65 0 1 1 .65 1.12l-2.25 1.3a.65.65 0 0 1-.89-.24Z" fill="currentColor" opacity="0.25" />
    <path d="M0 8c0-.36.29-.65.65-.65h2.59a.65.65 0 1 1 0 1.3H.65A.65.65 0 0 1 0 8Z" fill="currentColor" opacity="0.2" />
    <path d="M1.4 4.3a.65.65 0 0 1 .89-.24l2.25 1.3a.65.65 0 1 1-.65 1.13L1.64 5.19a.65.65 0 0 1-.24-.89Z" fill="currentColor" opacity="0.15" />
    <path d="M4.3 1.4a.65.65 0 0 1 .88.24l1.3 2.25a.65.65 0 1 1-1.12.65L4.06 2.29a.65.65 0 0 1 .24-.89Z" fill="currentColor" opacity="0.1" />
  </svg>
);

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <div className={cn("inline-flex animate-spin items-center justify-center", className)} {...props}>
    <LoaderIcon size={size} />
  </div>
);
