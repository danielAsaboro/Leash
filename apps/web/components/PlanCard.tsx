"use client";
import { useState } from "react";
import { CheckIcon, XIcon, CircleIcon, CircleDashedIcon, CircleSlashIcon } from "lucide-react";
import { Plan, PlanHeader, PlanTitle, PlanAction, PlanContent, PlanTrigger, PlanFooter } from "@/components/ai-elements/plan";
import { QueueItem, QueueItemContent, QueueItemDescription } from "@/components/ai-elements/queue";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import type { PlanData, PlanStep, PlanStepStatus } from "@/lib/leash/types";

/**
 * Shared renderer for a plan-mode plan (and, with no controls, a read-only plan such as a
 * deep-research run). Wraps the AI Elements `Plan` card with a status-tracked step list;
 * when the plan is still `proposed` and approval handlers are supplied, it shows the
 * Approve / Reject / Adjust gate. Built once, reused by the chat timeline and the research view.
 */

const STATUS_LABEL: Record<PlanData["status"], string> = {
  proposed: "Proposed plan",
  running: "Working the plan",
  done: "Plan complete",
  failed: "Plan stopped",
  rejected: "Plan rejected",
};

function StepGlyph({ status }: { status: PlanStepStatus }) {
  if (status === "active") return <Loader size={14} />;
  if (status === "done") return <CheckIcon className="size-3.5 text-[color:var(--color-sage-deep)]" />;
  if (status === "failed") return <XIcon className="size-3.5 text-[color:var(--color-brick)]" />;
  if (status === "skipped") return <CircleSlashIcon className="size-3.5 text-[color:var(--color-faint)]" />;
  return <CircleDashedIcon className="size-3.5 text-[color:var(--color-faint)]" />;
}

/** One plan step as a Queue todo row — ticks off (done → muted strikethrough) as the harness runs it. */
function StepRow({ step, index }: { step: PlanStep; index: number }) {
  const done = step.status === "done";
  return (
    <QueueItem className={`plan-step plan-step-${step.status}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" aria-hidden>
          <StepGlyph status={step.status} />
        </span>
        <QueueItemContent completed={done} className="!line-clamp-none whitespace-normal text-[color:var(--color-ink-soft)]">
          <span className="plan-step-n">{index + 1}.</span> {step.text}
        </QueueItemContent>
      </div>
      {step.note ? (
        <QueueItemDescription completed={done} className="ml-6">
          {step.note}
        </QueueItemDescription>
      ) : null}
    </QueueItem>
  );
}

export interface PlanCardProps {
  plan: PlanData;
  defaultOpen?: boolean;
  /** Present only when the plan is actionable (proposed, last idle message). */
  onApprove?: () => void;
  onReject?: () => void;
  onAdjust?: (note: string) => void;
  busy?: boolean;
}

export function PlanCard({ plan, defaultOpen, onApprove, onReject, onAdjust, busy }: PlanCardProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState("");
  const running = plan.status === "running";
  const actionable = plan.status === "proposed" && (!!onApprove || !!onReject || !!onAdjust);
  const open = defaultOpen ?? (plan.status === "proposed" || running);

  const submitAdjust = () => {
    const t = note.trim();
    if (!t || !onAdjust) return;
    onAdjust(t);
    setNote("");
    setAdjusting(false);
  };

  return (
    <Plan className="plan-card" defaultOpen={open} isStreaming={running}>
      <PlanHeader className="plan-card-head">
        <div className="plan-card-titlewrap">
          <span className="plan-card-kicker kicker kicker-sage" aria-hidden>
            <CircleIcon className="size-3" /> Plan
          </span>
          <PlanTitle>{plan.title || STATUS_LABEL[plan.status]}</PlanTitle>
        </div>
        <PlanAction>
          <PlanTrigger />
        </PlanAction>
      </PlanHeader>
      <PlanContent className="plan-card-content">
        <ol className="plan-steps">
          {plan.steps.map((s, i) => (
            <StepRow key={s.id} step={s} index={i} />
          ))}
        </ol>
      </PlanContent>
      {actionable && (
        <PlanFooter className="plan-card-foot">
          {adjusting ? (
            <div className="plan-adjust">
              <textarea
                className="plan-adjust-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should change? e.g. 'drop step 2, add a verification step'"
                rows={2}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitAdjust();
                }}
              />
              <div className="plan-adjust-actions">
                <Button type="button" size="sm" variant="outline" onClick={() => setAdjusting(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={!note.trim() || busy} onClick={submitAdjust}>
                  Re-plan
                </Button>
              </div>
            </div>
          ) : (
            <div className="plan-gate">
              {onReject && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReject}>
                  <XIcon className="size-4" /> Reject
                </Button>
              )}
              {onAdjust && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAdjusting(true)}>
                  Adjust…
                </Button>
              )}
              {onApprove && (
                <Button type="button" size="sm" disabled={busy} onClick={onApprove}>
                  <CheckIcon className="size-4" /> Approve &amp; run
                </Button>
              )}
            </div>
          )}
        </PlanFooter>
      )}
    </Plan>
  );
}
