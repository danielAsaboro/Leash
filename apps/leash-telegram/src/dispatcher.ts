/**
 * A shared undici dispatcher with ALL timeouts disabled — the same wedge-safe posture as
 * leash-broker. Two long-lived call shapes need it: Telegram `getUpdates` long-polling holds
 * the connection ~30s, and a Leash agent turn can stream for minutes (cold model load + tool
 * loop). A default body/headers timeout would abort either mid-flight.
 */
import { Agent } from "undici";

export const noTimeoutDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 15_000 });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
