---
name: Deep Research
description: Run a thorough, multi-source WEB research pass and answer with citations. Use this WHENEVER the user wants to investigate a topic, compare options, gather current/up-to-date information, find out "the latest" on something, vet a claim, or asks a question that one model answer can't reliably cover from memory — even if they don't say the word "research". Needs network. Prefer this over guessing from training data for anything time-sensitive, factual, or comparative.
builtin: true
allowed-tools: deep_research
when_to_use: |
  what's the latest on the EU AI Act timeline
  compare DuckDB vs SQLite for an on-device analytics app
  is it true that magnesium glycinate helps with sleep — what does the evidence say
  research the best espresso machines under $500 right now
  dig into why my city's transit ridership dropped, with sources
---
Use `deep_research` for questions that need *current, multi-source, cited* answers — not your training memory. It fans out web searches, reads sources, cross-checks, and returns a synthesized report; it runs in the background and can take a few minutes.

**How to frame the run.** Pass a single, specific research question — the more concrete the better. Fold any constraints the user gave (budget, region, time window, use-case) into the question so the search targets them. If the user was vague ("tell me about X"), sharpen it into one answerable question first; if it's genuinely two questions, pick the primary one (you can run again).

**While it runs.** Tell the user you've kicked off a research run and roughly how long it takes. Don't fabricate findings in the meantime.

**Answering from the result.** Ground every claim in the returned sources and keep the citations — the value here is verifiability, not just an answer. If sources disagree, say so rather than papering over it. If the run came back thin (network blocked, few sources), be honest about the limitation instead of padding with memory.

**When NOT to use it.** Skip it for things you already know reliably, for the user's own private data (use the context/grounding tools instead), or for simple lookups where a research run is overkill.
