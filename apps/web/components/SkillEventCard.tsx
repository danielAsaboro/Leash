"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import type { LeashSkillEvent } from "@/lib/leash/types";

function modeLabel(mode: LeashSkillEvent["mode"]): string {
  return mode === "explicit" ? "Requested" : "Auto-matched";
}

function modeCopy(mode: LeashSkillEvent["mode"]): string {
  return mode === "explicit"
    ? "Loaded from the skill the user named directly."
    : "Loaded from the request before reasoning and tool use.";
}

export function SkillEventCard({ event }: { event: LeashSkillEvent }) {
  const count = event.skills.length;
  return (
    <Collapsible defaultOpen className="group tool-card w-full">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start justify-between gap-4 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-rule)] bg-[color:var(--color-paper)] text-[color:var(--color-sage-deep)]">
            <SparklesIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="kicker kicker-sage text-[0.66rem]">
                {count === 1 ? "Loaded skill" : `Loaded ${count} skills`}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule)] bg-[color:var(--color-paper)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-sage-deep)]">
                <BrainIcon className="size-3" />
                {modeLabel(event.mode)}
              </span>
            </div>
            <p className="mt-1 max-w-[52ch] text-xs text-[color:var(--color-muted)]">{modeCopy(event.mode)}</p>
          </div>
        </div>
        <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-[color:var(--color-faint)] transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-3 border-t border-[var(--color-rule)] pt-3 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2">
        <div className="space-y-2">
          {event.skills.map((skill) => (
            <div key={skill.slug} className="flex items-start justify-between gap-3 rounded-md border border-[var(--color-rule)] bg-[color:var(--color-cream)]/35 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium text-sm text-[color:var(--color-ink)]">{skill.name}</div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-faint)]">{skill.slug}</div>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
