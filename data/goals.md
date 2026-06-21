# Goals

## Demonstrate a 9/10 dedicated-hardware application

Turn Leash's implemented capabilities into one reproducible, production-shaped proof on retail devices with no main device above 32 GB RAM.

The goal is complete only when all of these gates pass:

- A natural multimodal request combining voice, an image, and private documents runs through local QVAC paths in one uninterrupted user flow.
- The main agent delegates one task to at least two appropriate specialist agents; each agent uses authoritative tools, and the parent produces one grounded synthesis. Long-conversation, compaction, failure, and repeated-call tests maintain at least 90% strict correctness.
- A scaled private-document RAG benchmark reports corpus size, ingest time, index size, recall@5, citation accuracy, p50/p95 retrieval latency, and memory use. Target recall@5 and citation accuracy are at least 90% without exceeding the hardware boundary.
- A real physical-device run shows capability-aware local-versus-peer routing, encrypted delegation, failure recovery, and continued operation with WAN access disabled. Record device RAM, route choice, TTFT, throughput, and end-to-end latency.
- A QVAC Fabric adapter is evaluated against its base model on a held-out set. Publish the dataset hash, scoring method, base/adapted results, training time, artifact size, and regression checks; the adapted model must show a meaningful measured improvement.
- One evidence manifest links every claim to a repeatable command, structured log, and visible product path. The final readiness score must be at least 9/10 with no focus area below 8/10.
