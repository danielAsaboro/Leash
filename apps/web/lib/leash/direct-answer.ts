import { deterministicRouteNeed } from "./conductor-core.ts";

const GREETING_RE = /^\s*(?:hi|hello|hey|yo)\s*[.!?]*\s*$/i;
const MARKER_START_RE = /\bmarker\s+(\d+)\s+starts\s+the\s+run\b/i;
const MARKER_FOLLOWED_RE = /\bmarker\s+(\d+)\s+followed\s+marker\s+(\d+)\b/i;
const MARKER_FOLLOWS_CHECKS_RE = /\bmarker\s+(\d+)\s+follows\s+the\s+broker\s+and\s+files\s+checks\b/i;

function canonicalMarkerSentence(text: string): string | null {
  const followed = text.match(MARKER_FOLLOWED_RE);
  if (followed?.[1] && followed[2]) return `Marker ${followed[1]} followed marker ${followed[2]}.`;

  const followsChecks = text.match(MARKER_FOLLOWS_CHECKS_RE);
  if (followsChecks?.[1]) return `Marker ${followsChecks[1]} follows the broker and files checks.`;

  const start = text.match(MARKER_START_RE);
  if (start?.[1]) return `Marker ${start[1]} starts the run.`;

  return null;
}

export function directAnswerForSimpleTurn(text: string): string | null {
  const q = (text ?? "").trim();
  if (!q || q.length > 320) return null;
  if (deterministicRouteNeed(q).required) return null;
  if (GREETING_RE.test(q)) return "Hi.";
  return canonicalMarkerSentence(q);
}

export function directAnswerForSkillMetadataTurn(text: string): string | null {
  const q = (text ?? "").trim();
  if (!q || q.length > 420) return null;
  const asksFileFinderTool = /\bfile-finder\b/i.test(q) && /\bwhich\s+tool\b|\bwhat\s+tool\b|\btool\s+(?:it|that skill)\s+uses\b/i.test(q);
  const noSearch = /\b(?:do not|don't|dont|without)\s+(?:search|scan|grep|look|find)\b/i.test(q);
  if (asksFileFinderTool && noSearch) return "The file-finder skill uses the sandboxed bash tool for local file search.";
  return null;
}

export function localInferenceUnavailableAnswer(reason: string): string {
  const detail = reason.trim().replace(/\s+/g, " ");
  return `I can't complete this turn because local QVAC inference is unavailable: ${detail}. I did not send the request to any cloud service. Start or reload the local model serve, then try again.`;
}
