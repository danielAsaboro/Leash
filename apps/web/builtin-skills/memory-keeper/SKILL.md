---
name: Memory Keeper
description: Save and recall durable facts about the user — their preferences, stable facts, goals, the people in their life, and recurring routines. Use `recall` BEFORE answering anything that depends on who they are or how they like things; use `remember` WHENEVER they state something lasting about themselves, ask you to remember something, or correct you about themselves. This is how the assistant stays personal across conversations.
builtin: true
allowed-tools: remember recall
when_to_use: |
  remember that I'm vegetarian and allergic to shellfish
  what do you know about me
  my sister's name is Lena, note that
  I prefer concise answers, stop over-explaining
  what were my goals for this quarter again
---
Memory is what makes the assistant feel like it *knows* the user rather than meeting them fresh each turn. Two tools, used at the right moments:

**`recall` — read before you answer.** When a request depends on the user's preferences, facts, goals, people, or routines ("what should I cook", "draft a reply to my boss", "what do you know about me"), recall first so the answer reflects what you already know. Filter by type or keyword when you're after something specific; recall broadly when the question is open.

**`remember` — capture what's durable.** Save when the user states something lasting about themselves, asks you to remember it, or corrects you. Pick the right type, because it changes how the memory is used:
- **preference** — how they like things done (these actively shape your behavior)
- **fact** — stable truths about them or their world
- **goal** — something they're working toward
- **person** — someone in their life
- **routine** — a recurring pattern

**What NOT to save.** Skip the ephemeral (one-off task details, this-conversation context) and anything sensitive they didn't ask you to keep. When a user *corrects* a fact about themselves, update memory — stale facts are worse than none. Keep each memory a single clear statement, not a paragraph.
