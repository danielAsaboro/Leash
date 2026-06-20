---
name: context-grounding
description: Ground answers in the user's OWN private context — Apple Notes, files, saved memories, and past chats (a searchable knowledge graph), plus what's currently on their screen. Use this WHENEVER a question is about the user's own world ("what did I decide about…", "summarize Apple Notes on…", "what was I just doing", "based on my stuff…") rather than general knowledge or the open web. Search their context before answering so the reply is theirs, not generic.
metadata: |
  {"builtin":true}
allowed-tools: search_graph active_context activity_recent
when_to_use: |
  what did I conclude about the pricing model in Apple Notes
  summarize everything I've written about the Henderson project
  what was I working on a few minutes ago
  based on Apple Notes, what are the open questions on this
  what's relevant in my stuff to this email I'm drafting
---
This is what lets the assistant answer *from the user's life* instead of from generic training data. Reach for it before answering anything that depends on what they personally know, wrote, or are doing.

**`search_graph` — their knowledge graph.** Semantic search across Apple Notes, files, memories, and past chats. Use it to pull what's relevant to the question, then answer grounded in those results (and cite/quote them so the user can trust it). If the first query misses, rephrase with the user's own likely wording before giving up.

**`active_context` — what's on screen now.** Use when the request is about the current moment — "what am I looking at", "help me with this" referring to the active window, drafting a reply to something open.

**`activity_recent` — what they were just doing.** Use for "what was I working on", picking up a thread, or summarizing the recent session.

**Ground, don't guess.** The whole value is that the answer reflects *their* context. If the search returns nothing relevant, say so rather than substituting generic knowledge — and offer to search differently or look at the open web instead. For the contents of specific files, the file-finder may be more direct; for the public web, use research.
