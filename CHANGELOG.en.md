# Release Notes

This file is the English release notes for FinalCheck. Each entry mirrors the corresponding Chinese entry in CHANGELOG.md.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/).

Each version uses three sections: ### Added / ### Fixed / ### Improved. A section with no content is omitted rather than left as an empty heading.
Keep each item to one sentence, describe what users actually notice, and avoid internal jargon.

## [0.15.1] - 2026-11-12

### Added

- The MCP server now supports a `--root` path jail: file reads, edits, writes, artifacts, and audit reports are confined to the given root directory, and `..`, absolute paths, and symlink escapes are rejected.
- Integrated gitleaks' 600+ secret rules: findings are recorded as `S3.gitleaks:<rule name>`, and a location already flagged by our own rules is reported only once.

### Fixed

- `quality_gate` no longer runs project commands by default; commands are allowed only when `--root` is explicitly set and `FINALCHECK_MCP_ALLOW_COMMANDS=1` is enabled, so MCP is no longer an entry point for arbitrary commands.
- gitleaks reports are now written to the system temp directory, and raw Secret/Match values are no longer written into the report; findings under `.tmp`, dependency, and build directories are ignored as noise, and sample keys in documentation are downgraded to medium/tip hints.
- README now uses `finalcheck` as the clone directory and `fc-setup-<version>.exe` as the installer name, removed leftover local paths from yanshou/rcw-geo, and updated the fs-tools boundary comments to match the new MCP root restriction.

### Improved

- All 1034 tests passed in the pre-release regression; the MCP path and command boundaries and the gitleaks integration both have regression coverage.

## [0.15.0] - 2026-11-12

### Added

- Reports are split into three layers: issues that block delivery, issues that need human judgment, and style and readability suggestions; low-priority suggestions are collapsed to one line by default, and `--show-low` expands them all.
- Added audit baselines: `--baseline` / `--write-baseline` / `--fail-on new` flag only blocking or high-severity findings that are new since the last run, so old issues do not fail CI again.
- Desktop projects now get an Electron IPC permission-surface check: `ipcMain.handle/on` channels without parameter or path validation are listed as medium severity for manual review; desktop projects without HTTP routes are no longer misjudged as "cannot be verified" by auth and privilege checks.
- False positives can be waived individually: `.finalcheck/accept.json` matches only when rule, file, line number, and line fingerprint all match, and the warning returns automatically if the line content changes by a single character or the waiver expires.
- Added `scripts/backup.mjs`: one-command backup of local config, sessions, and project databases, with secrets automatically masked and the last 7 copies kept by default.
- README now covers install, run, environment variables, deployment, backup and restore, and rollback, and adds a `.env.example` with only variable names and placeholders.

### Fixed

- Auth coverage no longer guesses guards from name substrings: `author`, `sessionStore`, `loginLimiter`, and `authRoutes` are no longer mistaken for login guards, while `requireAuth`, `verifyToken`, and `passport.authenticate` are still recognized.
- An empty route table no longer passes the auth check: when there are no analyzable endpoints it is explicitly marked "not verified" instead of claiming a pass from "no issues found".
- Single-step and blind-verification deadlines no longer exit early with the event loop: CI no longer hits "the Promise is still pending but the event loop has ended", and timeouts reliably end in an explicit timeout state.
- The only S2 high finding in the self-audit report (an e2e script building table names from strings) was replaced with fixed SQL literals and a table-name allowlist; S2 findings are now zero.
- Closed four "not found means pass" gaps: untracked key files, lockfiles in the workspace, backups that exist only in documentation, and missing coverage artifacts are now explicitly marked "not verified".
- `electron-builder` upgraded to 26.18.1 (patch).

### Improved

- Report noise reduction: cross-copy deduplication and pruning of build artifacts and fixture directories; by default only blocking and medium-severity findings are expanded while 700+ low-priority suggestions stay collapsed; stricter naming rules cut findings from 420 to 96.
- Medium and high findings that need manual confirmation no longer let the dimension verdict say "pass"; it now shows "pass once fixed".
- Static command parsing and route-path pure functions were split out of oversized files: `handover.mjs` went from 879 to 475 lines, and `extract-routes.mjs` from 801 to 759 lines.
- The 14 dependency advisories that cannot be fixed within the current patch range are each documented in `docs/ACCEPTED-RISKS.md` with the GHSA ID, risk surface, reason for not fixing, and review date.
- CI is green again: 1014 tests, lint, typecheck, desktop build, and E2E smoke all pass.

## [0.14.0] - 2026-11-11

### Added

- The verification checklist is now a persistent panel pinned to the top right of the conversation area: it stays put while scrolling and collapses to a single line; when the sub-agent panel on the right opens, the checklist moves aside instead of covering messages.
- Before running verification or a health check, the app must ask you first: confirm the tier (L1/L2/L3) and the dimensions to cover with answer cards, and nothing runs until you confirm; if you have already stated them clearly, it will not ask again.
- Settings → About & updates now includes "View update details", shipped with the installer, so you can see what changed in this version and in earlier versions even offline.
- Language now switches only the UI and feature-module copy (Chinese / English); AI replies and reports follow the language of your own questions instead of being forced by the UI language.
- Sub-agents in workflows now show job titles (injection-surface reviewer, auth and privilege reviewer, supply-chain compliance specialist, and so on) in both DAG and script modes; "step 1" no longer appears.
- Long-running tools are now visible: the tool row shows elapsed time, "moved to background PID xxx" is rendered, and long commands report "still running" every 30 seconds.
- Queued messages are saved in the session and restored as "pending send" after a restart instead of being silently lost.

### Fixed

- The 60-minute cap for blind verification was truncated by the 10-minute cap for regular steps, so each review was killed at 10 minutes (error code VERIFY_TIMEOUT).
- When tool-argument JSON is malformed or truncated, half-written arguments are no longer executed as a tool call: it auto-corrects once, only errors if that still fails, and never leaves a tool row spinning forever.
- Token usage is now recorded per model request (previously one record per turn, and only for the last request), and the Usage page refreshes automatically while tasks are running.
- Stopping an already-finished session no longer interrupts other running sessions.
- The startup cleanup of leftover "running" tools in the production installer never actually ran (it received the wrong directory); this is now fixed.
- After you stop a run, queued messages are no longer sent automatically (you are prompted to click Send), and the "stopping" state no longer gets stuck forever.
- Opening Settings no longer leaves the sub-agent conversation panel behind; it appears only for the conversation it belongs to.
- When a turn is stopped, checklist items still marked "in progress" now show "interrupted" instead of blinking forever.

### Improved

- Usage ledger writes now retry on Windows, so a record is no longer dropped when the Usage page reads at the same time.
- Command-line audits now judge evidence level by "has source code" by default, instead of marking every dimension "not verified".

## [0.13.0] - 2026-11-11

### Added

- Settings → About & updates adds "View update details": see what changed in this version and in earlier versions without leaving the app, and longer content scrolls inside the card.
- Each version now has fixed "Added / Fixed / Improved" notes shipped with the installer; update notes must be written before a release.

### Fixed

- Session restore at startup in the installed build no longer silently fails: it previously pointed at the project root instead of the session directory, so leftover "running" tools survived restarts.
- Stopping an already-finished session no longer cancels other running sessions.

### Improved

- The verification checklist shows progress even when collapsed to one line (for example, "checklist 3/7"), remembers its collapsed state per session, and the whole card always keeps a single border.
- "Steer" now inserts the message into the conversation immediately and restarts the turn, so the text always appears in the record and the same message is never inserted twice.
- Context compaction is visible and can be stopped midway; long-running tools show elapsed time instead of looking frozen.

## [0.1.12] - 2026-11-11

### Added

- Added `npm run check:package` packaging self-check: it fails when a path exceeds 200 characters or when `.mimosa`, `.git`, or `desktop/config.json` is included in the package.

### Fixed

- Fixed upgrades getting stuck halfway with repeated "FinalCheck cannot be closed" prompts: the installer had picked up 41 editor state files with very long paths that exceeded the Windows 260-character path limit; they are now excluded, and `.mimosa` is explicitly filtered during packaging.

## [0.1.11] - 2026-11-11

### Fixed

- Fixed the repeated "FinalCheck cannot be closed" prompt during upgrades where Retry did not help: the installer now force-terminates the old version by process name and continues, and that blocking dialog is no longer compiled into the installer.

### Improved

- The installer file is now named fc-setup-<version>.exe, so downloaded copies (for example, FinalCheck-install(1).exe) are no longer mistaken for the app itself.

## [0.1.10] - 2026-11-11

### Added

- Added a packaging regression test that simulates a host treating .js as CommonJS, ensuring the English dictionary loads on any machine.

### Fixed

- Fixed the installed build failing on the first message with Named export 'EN_APP' not found: the packaged desktop/src had no package.json and its module type was undeclared; it now ships with "type": "module" declared.

## [0.1.9] - 2026-11-11

### Added

- The 11 dimensions are now truly wired into the app: audit_project supports sources (code / URL / dynamic auth / stress-test limits) and reads finalcheck.profile.json, and reports produce an 11-dimension table (verdict / evidence level / covered items).
- The CLI adds the `--profile` and `--sources` options.

### Fixed

- Declaring a URL and dynamic auth no longer counts as "complete" automatically: if no probing or stress testing actually ran this time, scoring uses the declaration only, and the report distinguishes "declared" from "measured".
- Adversarial review now has a 60-minute cap; timeouts end explicitly as VERIFY_TIMEOUT instead of hanging forever.
- Artifact preview and open now go through the same sensitive-path blocking as file tools, so config.json and ~/.ssh can no longer be registered as artifacts.
- Leftover "running" tools after a restart are marked as interrupted and can enter workflow recovery; fan-out step outputs now have a JSON array contract plus one auto-correct retry.

## [0.1.8] - 2026-11-10

### Fixed

- Fixed the crash when sending a message (TDZ).
- Workflow failures no longer fail the whole run; they degrade into gaps you can continue from.
- Fan-out targets written as a paragraph are now parsed automatically.
- Added IPC error boundaries and process-level fallbacks, so exceptions no longer take down the UI.

### Improved

- The verification card now uses the ZCode style and collapses when it exceeds 4 lines.

## [0.1.7] - 2026-11-10

### Added

- 11 dimensions × 3 levels plus an evidence matrix (code / URL / dynamic auth); reports expand by dimension, with a verification checklist and question cards.

### Fixed

- Known gap: this version's 11-dimension engine is not yet wired into the desktop app; the app still uses the old gate, and the dimension view arrives in 0.1.9.

## [0.1.6] - 2026-11-10

### Added

- Readability (Q4), static performance (Q5), and handover deep checks are wired into L2/L3; sub-agent tool results are persisted.
- Models can be switched in real time during a conversation.

### Improved

- The DSL automatically adds report nodes, and the fan-out limit is capped at 20.

## [0.1.5] - 2026-11-10

### Added

- No need to choose a workflow mode: the model first judges the task shape and picks fixed steps (DAG) or a script (DSL) itself, without asking you.
- Workflow cards show a DAG / DSL badge and a one-line plain-language summary (for example, "3 steps, run in 2 parallel layers by dependency").

### Fixed

- When the model supplies neither representation, it now returns an actionable self-correction hint instead of just "steps cannot be empty".

## [0.1.4] - 2026-11-10

### Fixed

- Fixed the stutter: when the window is covered by another window it is no longer treated as hidden, and animations and timers return to normal (measured setTimeout(100ms) improved from 283ms back to 102ms).

### Improved

- Window background throttling is off, so switching away and back no longer hitches.

## [0.1.3] - 2026-11-10

### Added

- Each workspace can create its own conversation: a "+" appears when hovering over a project row, and the top New Session follows the workspace of the current conversation.

### Improved

- Code split: App.jsx from 2685 to 1180 lines, and index.mjs from 1438 to 269 lines.
- Engineering: partial type checking in CI, session performance tests, and E2E smoke tests on real packaged artifacts.

## [0.1.2] - 2026-11-10

### Added

- Multiple workspaces can expand at the same time, each showing its own conversation list (active / archived / show more); viewing another project does not change the current project.

### Fixed

- After sending a message, archiving, renaming, or deleting, conversation counts and caches for each project refresh in sync.

## [0.1.1] - 2026-11-10

### Added

- Settings adds a dedicated "Language" section (follow system / Chinese / English), and switching takes effect immediately; in English mode the agent, workflows, and reports also output English.

## [0.1.0] - 2026-11-10

### Added

- First Windows installer; fill in one OpenAI-compatible gateway in Settings → Model settings on first launch and you are ready to go.
- One SQLite conversation database per project (WAL, tool calls stored with their run state).
- Bilingual Chinese/English UI; in English mode the agent and reports also output English.
- Adversarial review, and DAG + restricted-script workflows.

### Improved

- CI + ESLint integrated, with 663 tests.
