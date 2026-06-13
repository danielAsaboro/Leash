"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { LeashSkillEvent, LeashSkillRef } from "@/lib/leash/types";

function modeLabel(mode: LeashSkillEvent["mode"]): string {
  return mode === "explicit" ? "requested" : "auto-matched";
}

/** The slug only when it adds information beyond the name (i.e. it isn't just the slugified name). */
function usefulSlug(s: LeashSkillRef): string | null {
  const norm = s.name.trim().toLowerCase();
  if (!s.slug) return null;
  const slug = s.slug.toLowerCase();
  return slug === norm || slug === norm.replace(/\s+/g, "-") ? null : s.slug;
}

const ModeTag = ({ mode }: { mode: LeashSkillEvent["mode"] }) => (
  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-sage-deep)]">{modeLabel(mode)}</span>
);

/**
 * A loaded-skill timeline node — rendered as the LABEL of a ChainOfThought step (the spine already
 * carries the ✦ icon). One skill = a single muted line ("Loaded skill · name · mode"), no collapse,
 * no repeated slug. Many skills = a collapsible count that expands to the names (slug shown only when
 * it differs from the name). Inherits the broadsheet shadcn tokens like every other timeline element.
 */
export function SkillEventCard({ event }: { event: LeashSkillEvent }) {
  const count = event.skills.length;

  if (count === 1) {
    const s = event.skills[0] as LeashSkillRef;
    return (
      <span className="flex items-center gap-2 text-muted-foreground text-sm">
        <span className="truncate">
          Loaded skill · <span className="text-[color:var(--color-ink-soft)]">{s.name}</span>
        </span>
        <ModeTag mode={event.mode} />
      </span>
    );
  }

  return (
    <Collapsible className="group not-prose w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <span className="truncate">Loaded {count} skills</span>
        <ModeTag mode={event.mode} />
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "mt-2 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        )}
      >
        <ul className="flex flex-col gap-1.5">
          {event.skills.map((skill) => {
            const slug = usefulSlug(skill);
            return (
              <li key={skill.slug} className="flex items-baseline gap-2">
                <span className="text-sm text-[color:var(--color-ink-soft)]">{skill.name}</span>
                {slug && <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-faint)]">{slug}</span>}
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
