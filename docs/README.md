# Leash documentation

This directory is the **Leash docs site** — a [Mintlify](https://mintlify.com) project that documents
Leash (the dashboard + the `hypha` daemon) and the Mycelium device-mesh it runs on. It is the only place
inside `mycelium/` where product-documentation markdown belongs (see "Rule 6" below).

## Preview locally

From this `docs/` directory (where `docs.json` lives):

```bash
npx mint dev
```

The local preview runs at `http://localhost:3000`. To check for broken internal links:

```bash
npx mint broken-links
```

If the dev server misbehaves, `npx mint update` refreshes the CLI.

## Structure

Navigation is defined in [`docs.json`](./docs.json). Every page is an `.mdx` file referenced there by its
path without extension. The tabs:

- **Get Started** — index, quickstart, and the first-local-mesh tutorial.
- **Install** — per-platform install guides (macOS, Linux, Windows, iOS, Android).
- **Channels** — chat, voice, computer-use, mobile, Telegram.
- **Agents** — the agent harness: context, runtime, sessions, memory, queue, multi-agent, orchestration.
- **Capabilities** — skills, MCP and its tools, automation, plugins.
- **Models** — the model catalog, aliases, config, and per-modality pages.
- **Platforms** — desktop, mesh, economy, mobile.
- **Reference** — workspace map, ports/processes, configuration, the audit-log and benchmark references,
  plus the *explanation* pages (the system, the agent, the mesh, models & media).
- **Help** — troubleshooting, debugging, FAQ, testing, an **Operations** group (multi-device mesh,
  corestore/registry, local anvil settlement), diagnostics, and community/meta.
- **Changelog** and **Hackathon**.

Content follows the [Diátaxis](https://diataxis.fr) model: `explanation/` pages cover the *why*, `help/`
pages are how-to/troubleshooting, and `reference/` pages are neutral fact tables. Keep the modes separate.

## Rule 6 — only docs markdown lives here

Per the repo conventions in the root `CLAUDE.md`, `mycelium/docs/` is the **only** location inside the code
repo where product-documentation markdown is allowed. Reporting, submission, build-in-public, and
evidence markdown live in `submission/` (outside `mycelium/`); reference docs derived from external sources
live in `resources/`. Do not scatter markdown elsewhere under `mycelium/`.
