---
name: daily-paper
description: Read and search The Understory — the user's auto-written, on-device daily paper that summarizes their world. Use this WHENEVER the user asks about their paper or a recap of their own goings-on: "what's in my paper today", "what's new", "did anything happen about X", "catch me up", "search my feed for…". This is their personal paper, not the public news.
metadata: |
  {"builtin":true}
allowed-tools: understory_today understory_search
when_to_use: |
  what's in my paper today
  catch me up on anything new
  did my paper mention the Henderson project
  what's the latest edition say
  search my feed for anything about travel
---
The Understory is the user's *own* daily paper — written on-device from their context. Treat it as their personalized briefing, distinct from world news.

**`understory_today`** — the current edition. Use for "what's in my paper", "what's new", "catch me up". Summarize the highlights conversationally rather than dumping raw text.

**`understory_search`** — find past coverage. Use when they ask whether the paper covered a topic or want items about something specific. Pull the relevant pieces and quote/link them.

If the paper is empty (a fresh device hasn't generated editions yet), say so plainly and don't invent headlines. For the open web, use research; for the user's raw notes/files, use context-grounding or the file-finder.
