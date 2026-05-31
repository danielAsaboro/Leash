# @mycelium/mobile — iPhone / iPad app (placeholder)

Scaffolded properly in **Week 1/2** as an **Expo** app. `@qvac/sdk` runs on Expo,
so the phone is a first-class node in the mesh.

## Planned role (spec Layer 5)

- **Sensors / connectors:** camera (photos → OCR/vision), microphone (voice → STT).
- **Delegated-compute consumer:** offload heavy reasoning to the Mac provider over
  the encrypted P2P link (`loadModel({ delegate: { providerPublicKey } })`) — this is
  spike primitive (c). On-device fallback via `fallbackToLocal: true`.
- **Demo UX:** the "weak device borrows the strong brain" beat; airplane-mode demo;
  live mesh visualization.

## Spike role now (device-fit + P2P proof)

During the Day 1–3 spike this device is used **manually** (cannot be automated from
the dev host) to:
1. Confirm which model sizes load on-device (device-fit: try `QWEN3_600M_INST_Q4`,
   then `LLAMA_3_2_1B_INST_Q4_0`); record RAM + tok/s.
2. Run a real **iPhone → Mac** delegated-inference consumer against the Mac provider
   from `spike/03-p2p-provider.ts`.

Until the Expo app exists, the simplest path is the QVAC Expo example/quickstart
pointed at the Mac provider's public key. Results recorded in `../../SPIKE_RESULTS.md`.

## Scaffold later

```bash
# from repo root, in Week 1
npx create-expo-app@latest apps/mobile --template
npm install @qvac/sdk
# add the QVAC Expo config plugin (see @qvac/sdk "./expo-plugin" export)
```
