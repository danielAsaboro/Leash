import assert from "node:assert/strict";
import { completeJoin } from "../worklets/join-flow.mjs";

async function testPairingTimeoutCleansUpWithoutPersisting(): Promise<void> {
  let persisted = false;
  let cleaned = 0;

  await assert.rejects(
    () =>
      completeJoin(
        {
          awaitHostConfirm: () => new Promise<never>(() => {}),
          closePairing: async () => {
            throw new Error("closePairing should not run after a pairing timeout");
          },
          openBase: async () => {
            throw new Error("openBase should not run after a pairing timeout");
          },
          goOnline: async () => {
            throw new Error("goOnline should not run after a pairing timeout");
          },
          isWritable: () => false,
          updateBase: async () => {
            throw new Error("updateBase should not run after a pairing timeout");
          },
          persistJoined: async () => {
            persisted = true;
          },
          advertise: async () => {
            throw new Error("advertise should not run after a pairing timeout");
          },
          cleanupFailedJoin: async () => {
            cleaned += 1;
          },
        },
        { pairTimeoutMs: 5, writableTimeoutMs: 5, pollIntervalMs: 1 },
      ),
    /pairing not confirmed within 1s/i,
  );

  assert.equal(cleaned, 1);
  assert.equal(persisted, false);
}

async function testJoinPersistsOnlyAfterWritable(): Promise<void> {
  const calls: string[] = [];
  let writable = false;

  await completeJoin(
    {
      awaitHostConfirm: async () => ({ key: Buffer.from("mesh") }),
      closePairing: async () => {
        calls.push("closePairing");
      },
      openBase: async () => {
        calls.push("openBase");
      },
      goOnline: async () => {
        calls.push("goOnline");
      },
      isWritable: () => writable,
      updateBase: async () => {
        calls.push("updateBase");
        writable = true;
      },
      persistJoined: async () => {
        calls.push("persistJoined");
      },
      advertise: async () => {
        calls.push("advertise");
      },
      cleanupFailedJoin: async () => {
        calls.push("cleanupFailedJoin");
      },
    },
    { pairTimeoutMs: 50, writableTimeoutMs: 50, pollIntervalMs: 1 },
  );

  assert.deepEqual(calls, [
    "closePairing",
    "openBase",
    "goOnline",
    "updateBase",
    "persistJoined",
    "advertise",
  ]);
}

async function testLatePairingConfirmAfterTimeoutIsIgnored(): Promise<void> {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      completeJoin(
        {
          awaitHostConfirm: async () =>
            await new Promise<{ key: Buffer }>((resolve) => {
              setTimeout(() => resolve({ key: Buffer.from("mesh") }), 25);
            }),
          closePairing: async () => {
            calls.push("closePairing");
          },
          openBase: async () => {
            calls.push("openBase");
          },
          goOnline: async () => {
            calls.push("goOnline");
          },
          isWritable: () => false,
          updateBase: async () => {
            calls.push("updateBase");
          },
          persistJoined: async () => {
            calls.push("persistJoined");
          },
          advertise: async () => {
            calls.push("advertise");
          },
          cleanupFailedJoin: async () => {
            calls.push("cleanupFailedJoin");
          },
        },
        { pairTimeoutMs: 5, pairGraceMs: 30, writableTimeoutMs: 50, pollIntervalMs: 1 },
      ),
    /pairing not confirmed within 1s/i,
  );

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(calls, ["cleanupFailedJoin"]);
}

async function testWritableTimeoutCleansUpWithoutPersisting(): Promise<void> {
  let persisted = false;
  let cleaned = 0;
  let updates = 0;

  await assert.rejects(
    () =>
      completeJoin(
        {
          awaitHostConfirm: async () => ({ key: Buffer.from("mesh") }),
          closePairing: async () => {},
          openBase: async () => {},
          goOnline: async () => {},
          isWritable: () => false,
          updateBase: async () => {
            updates += 1;
          },
          persistJoined: async () => {
            persisted = true;
          },
          advertise: async () => {},
          cleanupFailedJoin: async () => {
            cleaned += 1;
          },
        },
        { pairTimeoutMs: 50, writableTimeoutMs: 8, pollIntervalMs: 1 },
      ),
    /writer promotion did not arrive within 1s/i,
  );

  assert.ok(updates > 0);
  assert.equal(cleaned, 1);
  assert.equal(persisted, false);
}

async function main(): Promise<void> {
  await testPairingTimeoutCleansUpWithoutPersisting();
  await testJoinPersistsOnlyAfterWritable();
  await testLatePairingConfirmAfterTimeoutIsIgnored();
  await testWritableTimeoutCleansUpWithoutPersisting();
  console.log("join-flow.test.ts: ok");
}

const keepAlive = setInterval(() => {}, 1_000);

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
