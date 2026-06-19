"use client";

type DialogKind = "prompt" | "confirm" | "alert";

export interface AppPromptOptions {
  title?: string;
  description?: string;
  inputLabel?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AppConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface AppAlertOptions {
  title?: string;
  confirmLabel?: string;
  tone?: "info" | "error";
}

interface BaseRequest<T> {
  id: number;
  kind: DialogKind;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  tone?: "info" | "error";
  resolve: (value: T) => void;
}

export type AppDialogRequest =
  | (BaseRequest<string | null> & {
      kind: "prompt";
      defaultValue: string;
      inputLabel: string;
      placeholder?: string;
    })
  | (BaseRequest<boolean> & { kind: "confirm" })
  | (BaseRequest<void> & { kind: "alert" });

type AppDialogHandler = (request: AppDialogRequest) => void;
type AppDialogRequestInput =
  | Omit<Extract<AppDialogRequest, { kind: "prompt" }>, "id" | "resolve">
  | Omit<Extract<AppDialogRequest, { kind: "confirm" }>, "id" | "resolve">
  | Omit<Extract<AppDialogRequest, { kind: "alert" }>, "id" | "resolve">;

let nextId = 0;
let handler: AppDialogHandler | null = null;
const backlog: AppDialogRequest[] = [];

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function enqueue<T>(request: AppDialogRequestInput, fallback: T): Promise<T> {
  if (!isBrowser()) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const full = { ...request, id: ++nextId, resolve } as AppDialogRequest;
    if (handler) handler(full);
    else backlog.push(full);
  });
}

/**
 * App-styled async replacement for `window.prompt()`. Electron's packaged renderer does not support
 * native prompt(), so every prompt goes through the root-mounted AppDialogHost instead.
 */
export function appPrompt(message: string, defaultValue = "", options: AppPromptOptions = {}): Promise<string | null> {
  return enqueue<string | null>({
    kind: "prompt",
    title: options.title ?? message,
    description: options.title ? options.description ?? message : options.description,
    defaultValue,
    inputLabel: options.inputLabel ?? "Value",
    placeholder: options.placeholder,
    confirmLabel: options.confirmLabel ?? "Save",
    cancelLabel: options.cancelLabel ?? "Cancel",
  }, null);
}

/** App-styled async replacement for native confirm(). */
export function appConfirm(message: string, options: AppConfirmOptions = {}): Promise<boolean> {
  return enqueue<boolean>({
    kind: "confirm",
    title: options.title ?? message,
    description: options.title ? options.description ?? message : options.description,
    confirmLabel: options.confirmLabel ?? "Confirm",
    cancelLabel: options.cancelLabel ?? "Cancel",
    destructive: options.destructive,
  }, false);
}

/** App-styled async replacement for native alert(). */
export function appAlert(message: string, options: AppAlertOptions = {}): Promise<void> {
  return enqueue<void>({
    kind: "alert",
    title: options.title ?? (options.tone === "error" ? "Action failed" : "Notice"),
    description: message,
    confirmLabel: options.confirmLabel ?? "OK",
    tone: options.tone ?? "info",
  }, undefined);
}

export function subscribeAppDialogs(next: AppDialogHandler): () => void {
  handler = next;
  while (backlog.length > 0) {
    const request = backlog.shift();
    if (request) next(request);
  }
  return () => {
    if (handler === next) handler = null;
  };
}
