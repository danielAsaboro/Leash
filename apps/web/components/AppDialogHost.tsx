"use client";
import { FormEvent, useEffect, useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AppDialogRequest, subscribeAppDialogs } from "../lib/prompt.ts";

function cancelValue(request: AppDialogRequest): string | boolean | null | void {
  if (request.kind === "prompt") return null;
  if (request.kind === "confirm") return false;
  return undefined;
}

export function AppDialogHost() {
  const inputId = useId();
  const [queue, setQueue] = useState<AppDialogRequest[]>([]);
  const [active, setActive] = useState<AppDialogRequest | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => subscribeAppDialogs((request) => setQueue((items) => [...items, request])), []);

  useEffect(() => {
    if (active || queue.length === 0) return;
    const [next, ...rest] = queue;
    setActive(next);
    setQueue(rest);
    if (next.kind === "prompt") setValue(next.defaultValue);
  }, [active, queue]);

  const finish = (result: string | boolean | null | void) => {
    if (!active) return;
    active.resolve(result as never);
    setActive(null);
  };

  const submitPrompt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    finish(value);
  };

  return (
    <Dialog
      open={!!active}
      onOpenChange={(open) => {
        if (!open && active) finish(cancelValue(active));
      }}
    >
      <DialogContent className="app-dialog sm:max-w-[440px]">
        {active ? (
          <>
            <DialogHeader>
              <DialogTitle>{active.title}</DialogTitle>
              {active.description ? <DialogDescription>{active.description}</DialogDescription> : null}
            </DialogHeader>

            {active.kind === "prompt" ? (
              <form className="app-dialog-form" onSubmit={submitPrompt}>
                <label className="app-dialog-label" htmlFor={inputId}>
                  {active.inputLabel}
                </label>
                <Input
                  id={inputId}
                  className="app-dialog-input"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={active.placeholder}
                  autoFocus
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => finish(null)}>
                    {active.cancelLabel ?? "Cancel"}
                  </Button>
                  <Button type="submit">{active.confirmLabel ?? "Save"}</Button>
                </DialogFooter>
              </form>
            ) : active.kind === "confirm" ? (
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => finish(false)}>
                  {active.cancelLabel ?? "Cancel"}
                </Button>
                <Button type="button" variant={active.destructive ? "destructive" : "default"} onClick={() => finish(true)}>
                  {active.confirmLabel ?? "Confirm"}
                </Button>
              </DialogFooter>
            ) : (
              <DialogFooter>
                <Button type="button" variant={active.tone === "error" ? "destructive" : "default"} onClick={() => finish(undefined)}>
                  {active.confirmLabel ?? "OK"}
                </Button>
              </DialogFooter>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
