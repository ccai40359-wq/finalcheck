# FinalCheck

> **Don't run code you can't read. Check it first.**

FinalCheck is a tiered production-readiness desk for people who write with AI but are not security experts:

- **Audit before you run.** AI-written or downloaded code gets checked first, and you get a report in plain language.
- **Evidence, not vibes.** Not "possible IDOR (CWE-639)" but "`register` route defined on line 12 with no auth guard — your user table is exposed to the internet", with file and line references. Dynamic reproduction is available as an opt-in second stage.
- **Tiered gates.** Personal projects pass L1. Company projects must pass full L3 acceptance, and L3 does not ship until everything on the matrix is met.

## Tiers

| Tier | One line | Enforcement |
|---|---|---|
| **L1 Personal** | Losing the data would not hurt; only you use it | High-severity only, advisory |
| **L2 With users** | Public and receiving other people's data | High severity blocks, medium must be fixed |
| **L3 Company** | Company project, paid work, compliance obligations | Nothing ships until the matrix passes; produces a presentable acceptance report |

## What's in the box

| Piece | Form | What it does |
|---|---|---|
| **Desktop app** | Electron (Windows) | Chat + audit desk: tiered acceptance, agent workflows, live tool traces, artifact preview, usage stats |
| **Engine** | CLI (`npx finalcheck audit <dir>`) | Static gates (secrets, dependencies, risky patterns, auth matrix, semantic checks) → scorecard + issue tickets |
| **Agent runtime** | Built into the desktop app | DAG workflows **and** a restricted-script DSL, adversarial verification of every claim, journal-based resume, blind spot checks |
| **Gates & playbooks** | Skill/hook integrations + `playbooks/` | Download gate (before installing/running third-party code) and delivery gate (before handing work over) |
| **Rulebooks** | Text, per tier | What the AI must follow while writing code, so problems are prevented up front |

## Quick start

**Installed build**

1. Download `FinalCheck-install.exe` from [Releases](https://github.com/ccai40359-wq/finalcheck/releases).
2. Run it, open **Settings → Model settings**, and add an OpenAI-compatible gateway (Base URL ending in `/v1`, API key, model name).
3. Open a workspace (a folder), choose your tier, and start a session.

**From source**

```bash
git clone https://github.com/ccai40359-wq/finalcheck
cd finalcheck
npm install
npm test                     # 647 tests
cd desktop && npm install
npm run dev                  # launch the desktop app
```

To package a Windows build: `cd desktop && npm run dist`.

## Language

The UI ships in Chinese and English.

- **Settings → Runtime → Language**: Follow system / 中文 / English. Switching applies immediately.
- In **English** mode the agents, workflows and generated reports also produce English output; in **Chinese** mode everything stays Chinese.
- Chinese is the default: a Chinese system with *Follow system* stays Chinese, everything else starts in English.

## Safety model

- The API key lives **only** in the local `config.json` (`%APPDATA%\FinalCheck` in the installed build). It is never written to sessions, logs or reports.
- Path and command access is controlled by a policy: `workspace` (writes inside the project only), `readonly`, or `off`. Sensitive locations (`.ssh`, `.aws`, `.gnupg`, Git credentials, private keys) are blocked in every mode, and a command blacklist applies on top.
- Dynamic targets (probes, stress tests) require an explicit, per-target confirmation and are capped at 60s / 50 connections.
- Removing a workspace from the list never deletes anything on disk.

## Repository layout

```
bin/          CLI entry points (finalcheck, finalcheck-mcp)
src/          audit engine (checks, probe/stress, MCP surface)
desktop/      Electron app (main / preload / renderer)
playbooks/    audit playbooks
integrations/ skill + hook wiring for coding agents
docs/         ACCEPTANCE.md — the single source of truth for the tiers
tests/        node:test suites (647 passing)
```

## Status

Early but real: the engine, the desktop app, tiered gates, agent workflows (DAG + script DSL), adversarial verification and in-app updates are in place, with 647 tests passing on every change. Development follows the project's own L3 standard — a known violation of any L2 item in this repository counts as a bug.

## License

Apache-2.0. See [LICENSE](LICENSE).
