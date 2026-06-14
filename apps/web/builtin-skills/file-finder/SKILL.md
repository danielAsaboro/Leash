---
name: File Finder
description: Search and read the user's files through a sandboxed, read-only shell (grep, find, cat, jq, head, etc.) over a snapshot of their documents. Use this WHENEVER the user asks about the CONTENTS of their own files — "find the file where I…", "what did I write about X", "search my notes/code/PDFs for…", "show me the part of that doc that…" — anything that means locating or quoting their local files rather than the open web.
builtin: true
allowed-tools: bash
when_to_use: |
  find the markdown file where I drafted the Q3 plan
  grep my notes for anything about the Henderson contract
  which of my files mention "supabase" — show the lines
  cat the top of that config file I was editing
  search my code for the function that parses the manifest
---
`bash` here is a **read-only, sandboxed** shell over a snapshot of the user's files — so you can explore freely without risk. Treat it like a detective's toolkit, not a guess.

**Locate, then read.** Start broad to find candidates (`find`/`grep -rl` by name or keyword), then narrow to the right file and `cat`/`head`/`sed -n` the relevant slice. Don't dump whole large files — pull the part that answers the question and quote it.

**Search smart.** Use `grep -ri` for case-insensitive content search, `grep -rl` to list matching files first, `find … -name` for filename patterns, `jq` for JSON. Combine with pipes (`grep … | head`) to keep output tight. If the first keyword misses, try synonyms or a looser pattern before concluding it's not there.

**Answer with evidence.** Cite the file path and quote the matching lines so the user can trust the result. If nothing matches after a real attempt, say so plainly and suggest what else to try — don't invent file contents.

This is for the user's OWN files. For their notes/memories/past-chats as a knowledge graph, the context-grounding tools may fit better; for the live web, use research.
