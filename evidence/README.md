# Evidence

Committed verification artifacts for the QVAC Hackathon submission, so the audit-log
requirement is checkable from a fresh clone (the per-run `logs/` directories are gitignored as
per-device evidence — this is a captured, representative run).

## `medpsy-demo.jsonl`

The structured audit log for one full **MedPsy health-record RAG** demo run
(`npm run medpsy:demo`, 2026-06-17, Apple-Silicon / Metal). Regenerate it any time with that
command. Each line is one JSONL `AuditRecord` (schema: `spike/lib/audit-log.ts`; reference:
`docs/reference/audit-log.mdx`).

What the 12 records show, in order:

- `model_load` — gte-large embeddings, then `model_load` — MedGemma 4B (the `medpsy` alias).
- `rag_ingest` — 4 health records embedded into the `mycelium-health-records` workspace.
- `rag_search` — retrieval for the grounded question (**28 ms**, real similarity scores).
- `completion` (`role:medpsy-proposer`, 218 tokens) → `completion` (`role:verifier`,
  `verdict:pass`) → `note` (`cited:true`, `disclaimerAppended:false`) — the cited, verified answer.
- `rag_search` (**22 ms**) + `completion` + `note` (`redFlag:true`) — the emergency turn. Its
  verifier verdict is `revise`/`cited:false` **by design**: the urgent-care escalation is a safety
  response, not a record-grounded claim, so the critic correctly notes it isn't supported by the
  retrieved sources.
- `model_unload` — embeddings released.

Every line corresponds to an on-screen line in the demo output (see
`docs/hackathon/medpsy-workflow.mdx`). All inference, embeddings, RAG, and verification are real
on-device `@qvac/sdk` calls — zero cloud. The health records are synthetic fixtures
(`spike/fixtures/health-records/`); no real personal health information is involved.
