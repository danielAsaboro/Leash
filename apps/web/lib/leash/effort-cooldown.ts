const DEFAULT_COOLDOWN_MS = 60_000;

let cooldownUntil = 0;

function configuredCooldownMs(): number {
  const raw = Number(process.env["LEASH_EFFORT_FAILURE_COOLDOWN_MS"] ?? DEFAULT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COOLDOWN_MS;
}

export function effortFailureCooldownRemaining(now = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

export function recordEffortFailure(now = Date.now(), cooldownMs = configuredCooldownMs()): boolean {
  const alreadyCoolingDown = effortFailureCooldownRemaining(now) > 0;
  cooldownUntil = Math.max(cooldownUntil, now + cooldownMs);
  return !alreadyCoolingDown;
}

export function clearEffortFailureCooldown(): void {
  cooldownUntil = 0;
}
