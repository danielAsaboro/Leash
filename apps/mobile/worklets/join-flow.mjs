const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const secondsLabel = (timeoutMs) => Math.max(1, Math.ceil(timeoutMs / 1000));

export function pairingTimeoutError(timeoutMs) {
  const error = new Error(`pairing not confirmed within ${secondsLabel(timeoutMs)}s`);
  error.code = "PAIRING_CONFIRM_TIMEOUT";
  return error;
}

export function writableTimeoutError(timeoutMs) {
  const error = new Error(`writer promotion did not arrive within ${secondsLabel(timeoutMs)}s`);
  error.code = "WRITER_PROMOTION_TIMEOUT";
  return error;
}

async function withTimeout(promise, timeoutMs, errorFactory) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(errorFactory(timeoutMs)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForWritable(ops, timeoutMs, pollIntervalMs) {
  const sleep = ops.sleep ?? defaultSleep;
  const t0 = Date.now();
  while (!ops.isWritable()) {
    if (Date.now() - t0 >= timeoutMs) throw writableTimeoutError(timeoutMs);
    await ops.updateBase();
    if (ops.isWritable()) return;
    await sleep(pollIntervalMs);
  }
}

export async function completeJoin(ops, opts = {}) {
  const pairTimeoutMs = opts.pairTimeoutMs ?? 45_000;
  const writableTimeoutMs = opts.writableTimeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;

  try {
    const confirmPromise = Promise.resolve().then(() => ops.awaitHostConfirm());
    const result = await withTimeout(confirmPromise, pairTimeoutMs, pairingTimeoutError);
    await ops.closePairing();
    await ops.openBase(result.key);
    await ops.goOnline();
    await waitForWritable(ops, writableTimeoutMs, pollIntervalMs);
    await ops.persistJoined();
    await ops.advertise();
    return { joined: true, writable: true, result };
  } catch (error) {
    await ops.cleanupFailedJoin?.(error);
    throw error;
  }
}
