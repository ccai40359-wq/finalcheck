# Release Notes

This file is the English release notes for FinalCheck. Each entry mirrors the corresponding Chinese entry in CHANGELOG.md.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/).

Each version uses three sections: ### Added / ### Fixed / ### Improved. A section with no content is omitted rather than left as an empty heading.
Keep each item to one sentence, describe what users actually notice, and avoid internal jargon.

## [0.19.0] - 2026-11-16

### Improved

- The installer now ships a complete Git, so `git` and `bash` work right after install: previously we only detected a user-installed Git and fell back to cmd when it was missing (which made bash-style commands fail). The installer now bundles the full Git for Windows (~400MB), so machines without Git can still use `git clone`, `git status`, `cat`, `grep -rn` and `2>/dev/null`.
- Priority is unchanged: a user-installed Git wins; the bundled one is only a fallback.
- Installer size grows from 112MB to roughly 235MB (about 824MB on disk after install, of which 410MB is Git itself) in exchange for zero-dependency, out-of-the-box behavior.

### Fixed

- Commands can no longer read files outside the project: literal paths in a command now pass two gates - sensitive paths (`~/.ssh`, private-key filenames, `*.pem`, and others) are rejected unconditionally, and paths outside the project reject the whole command with the reason returned to the AI.
- Sensitive paths are permanently blocked regardless of sandbox mode: both `workspace` and `off` reject them.
- The settings page states the sandbox's real boundary: a new notice explains the sandbox is "write protection + workspace boundary", NOT read isolation, and that paths assembled at runtime (env vars, `~`, concatenation inside a script) cannot be intercepted.

## [0.18.0] - 2026-11-16

### Fixed

- Commands can no longer read files outside the project: previously only the working directory was checked and paths written inside the command were ignored entirely, so `type C:\Users\x\.ssh\id_rsa` or switching to another directory before reading a file went through. Now every literal path in a command passes two gates — sensitive paths are always rejected, and paths outside the project reject the whole command, with the reason returned to the AI.
- Sensitive paths are permanently blocked: `~/.ssh`, `~/.aws`, `~/.gnupg`, `.git-credentials` and common private-key filenames (id_rsa, id_ed25519, *.pem, and others) are rejected regardless of whether the sandbox mode is workspace or off. Paths inside nested shells (`powershell -Command "..."`, `bash -c "..."`) are checked the same way.
- The settings page now states the sandbox's real boundary: the three mode descriptions read "anything outside the workspace is unreadable" and a new notice makes clear the sandbox is "write protection + workspace boundary", NOT read isolation — paths assembled at runtime (env vars, ~, concatenation inside a script) cannot be intercepted, and sensitive code should run in a dedicated container or WSL.

### Improved

- Commands now run through Git Bash: machines with Git for Windows switch to bash automatically (no more cmd wrapper), so `cat`, `grep -rn`, `2>/dev/null` and `&&` work directly. Machines without Git fall back to cmd with a prompt to install it. On this machine, switching from cmd to bash stopped the model from mixing cmd and bash syntax.
- Tool responsibilities are written into the prompts: reading goes only through read_file (line numbers, resumable on large files), searching goes only through grep_code (returns `file:line:text`), and run_command is only for builds/tests/git/processes/network — the three descriptions name each other's prohibitions, which cuts down detours like "use cat in shell to read a file" or "use findstr to search code".

## [0.17.1] - 2026-11-16

### Fixed

- Model/provider switch notices now show names: they used to read "p-mw7gt125-xtbip/deepseek-v4.1-flash-eco" with the provider's internal id, which told users nothing. They now read "Legacy Default · deepseek-v4.1-flash" (provider name plus model), and the in-transcript model-switch divider was fixed the same way.
- Switch notices no longer trail behind an error: they used to be appended to the end of the message list, so they appeared under the previous turn's error and looked like part of it. They now sit firmly between the end of one turn and the start of the next, while the error stays visible above.
- Switching models mid-turn now says when it takes effect: the main process only actually swaps models at the next model request (by design, so already-streamed output is not interrupted). A new notice "Switched to X from this step onward" fires at that moment, so the switch no longer looks like it silently failed.

## [0.17.0] - 2026-11-16

### Fixed

- The app no longer keeps your whole machine busy for an invisible animation: the full-screen ambient glow carried a never-ending 32-second drift animation underneath the glass panels, forcing the entire blur to be recomputed every frame. The GPU process measured a steady 11% CPU, dropping to 0.00% when disabled and back to 10.8% when re-enabled. It is now a static glow with almost no visible difference, so nothing redraws in the background.
- The same probe result no longer floods the transcript: the model treats a penetration probe as a "is the service still up?" heartbeat and probes the same address 6 to 9 times in one turn, producing that many identical tables. Now identical visible content renders as a single card, with the same address and conclusion merged and labelled "Ran N times".
- Checker detection no longer flashes a window: the main process runs a child process to ask a local checker (rg, osv-scanner) for its version, which used to spawn a visible console. It now runs with a hidden window and a timeout, so audits no longer flash a console.
- Python projects are no longer reported as unauthenticated by mistake: FastAPI guards live almost entirely in the function signature's `Depends(...)`, and the old scanner stopped at `def`, marking protected routes as having no auth (9 of 12 such S1 findings were false positives on a real business project). It now reads the whole multi-line signature and recognises common guard names (require_api_key, verify_api_key, current_superuser, and others).

### Improved

- Switching back to a very large session no longer takes over ten seconds: the process timeline is now paginated (40 entries per page, with "Entries 161–167 / 167 total" and first/earlier/later/latest buttons). On the same 1044-tool-call test session, session switching dropped from 11.7s to 0.44s and DOM nodes from 14,430 to 3,703.
- Off-screen content no longer participates in rendering: every message and every tool row in a long session now skips layout and paint while off-screen. The scroll area's total height dropped from 5015px to 4183px with zero dropped frames measured.
- Glass surfaces cost less: the sidebar and composer blur radii dropped from 32px/28px to 12px/10px, which is visually almost identical while reducing per-frame compositing cost to roughly one seventh.
- Follows the system "reduce motion" setting: when the OS asks for reduced motion, interface animations and transitions are turned off automatically.

## [0.16.10] - 2026-11-15

### Fixed

- Background long-running commands no longer leave permanent console windows: the detached spawn forced Windows to create a new console, so every long-lived service (node server.mjs etc.) left a black window behind. Now spawns without detached (stdio is already detached; children still survive parent exit) — measured delta: 0 visible windows.
- Tool details now truly default to expanded: the expand/collapse memory is keyed with a version, so old collapsed records from previous builds no longer override the new expanded default.

## [0.16.9] - 2026-11-15

### Fixed

- Console black-flash is gone: sandboxed commands used to be launched from console-less Electron into cmd.exe, which forced Windows to create a fresh console per command. Now a hidden-console launcher starts first and the whole chain inherits it — zero windows per command (verified in a GUI, no-console environment).
- Tool details stay put when switching sessions or sending messages: the message list now uses stable element keys, so another session's expand state can no longer bleed in via index reuse.

## [0.16.8] - 2026-11-15

### Fixed

- Tool-call details no longer vanish when you switch sessions: completed turns stay expanded by default (every Thought/command/file-read step visible); click the header to collapse. Your expand/collapse choice is remembered per message across session switches and restarts.

## [0.16.7] - 2026-11-15

### Fixed

- Sending a message no longer wipes earlier turn details: file-change chips and tool-call timelines of previous turns stay visible (the data was always in the database — the display layer was dropping it).

### Added

- Model-switch trail: after switching provider or model, the message flow shows a "⇄ Model switched: old → new" divider (same style as ZCode), visible after restarts and replays.
- A "stuck-loop" guard: when the AI fires byte-identical tool calls round after round, it gets a change-approach reminder at round 3 and is stopped at round 5 — argument-format jitter can't sneak past it, legitimate retries are unaffected.

## [0.16.6] - 2026-11-15

### Fixed

- Model "repetition loops" are now contained: when the AI restates the same progress dozens of times with zero actual movement for many minutes, the engine cuts in automatically and nudges it to continue with real work, instead of accepting a full screen of restatement as a normal reply; a repeat offense fails the turn with a clear error.
- False-positive flood on library repos receded: example routes inside Python docstrings (like `@app.get("/items/")`) are no longer treated as real endpoints, and demo routes under tests/tutorial directories no longer count; framework repos like FastAPI drop from ~2000 findings to 182.

### Improved

- Automated runs get a background-window mode: batch acceptance runs no longer steal focus (no change for normal use).

## [0.16.5] - 2026-11-14

### Fixed

- Console windows popping up on every sandboxed command are largely gone: when a hidden console fails to initialize, the retry first uses a different process-creation flag that also stays hidden (most machines recover without any window); the visible console is now the last resort.

### Improved

- Context compaction refinement: the kept zone after compaction dropped from sitting at the threshold (400k) to ~150k, so very long sessions stop re-triggering compaction.

## [0.16.4] - 2026-11-14

### Added

- Long tasks no longer degrade: tool outputs inside a single turn are auto-folded — context stays at "latest 5 tool results verbatim + earlier placeholders", so hundreds-of-steps turns stop growing unbounded.
- New dedicated code-search tool `grep_code`: prefers bundled ripgrep (rg.exe ships in the installer), returns structured file:line:match — no more hand-written findstr commands.
- Acceptance checklist upgraded: only one in-progress item at a time; marking done with failing tests or unresolved errors is forbidden.

### Fixed

- Fixed a silent real bug: file-level service signals in library-repo detection were swallowed by an unimported function call (one of the 10 lint findings).

## [0.16.3] - 2026-11-14

### Added

- The artifact preview panel now renders Markdown: README-style documents show headings, tables and code blocks directly (use "Open externally" for the raw text).
- Skills come in three tiers: give a single project (`.finalcheck/skills/`) or yourself (user skills directory) dedicated skills; closer tiers shadow same-named builtin ones.
- Ten new repair-methodology skills: every audit finding category now has a matching fix guide with verification steps (41-50).
- Development and acceptance are fully separated: coding/fixing tasks follow your instructions directly, while acceptance tasks still run the strict tiered gates with fail-closed.
- Repairs are reversible: every file edit auto-snapshots first, and `repair_rollback` restores the pre-edit state in one call.
- Each turn logs its configuration facts (model/tools/skills/track) to a ledger, so past judgments are replayable.
- Multiple independent findings get repaired in parallel (multi-agent fanout, one subagent per finding) with honest failure reporting.

### Fixed

- Clicking "New Session" no longer makes a running turn "disappear": the draft page shows a still-running banner with one-click jump back.
- Reopening an unfinished session restores its thinking and tool records instead of silently dropping them.
- AI SDK library repos (langchain / vercel-ai / openai-agents-js) audit with far fewer false positives: three card-level FP clusters are gone while real issues stay as "needs human confirmation".

### Improved

- Test suite at 1310 green; methodology numbering is globally unique across domains (web-vuln 01-40, dev-fix 41-50).

## [0.16.2] - 2026-11-13

### Added

- On Windows, commands and quality-gate checks can run inside a restricted-token sandbox: creating or modifying files is limited to the project directory plus a private temp directory, and a sandbox setup failure refuses to run; `FINALCHECK_SANDBOX=auto|required|off` controls it (with `required`, even unsupported commands are refused).
- Probing or stress-testing an external target now requires a per-target confirmation first (localhost excepted); anything unconfirmed is refused.

### Fixed

- The artifact preview panel only shows on the chat page: opening Settings no longer drags it along, and it comes back when you return to chat.
- Real environment templates (`.env.example`, `.sample`, `.template`, and the like) are no longer reported as leaked secrets, and templates explicitly ignored by `git check-ignore` are allowed.
- Ledger exemptions now match by content fingerprint first, so line drift no longer silently disables them.
- SQLite prebuilt packages are checked against SHA256 before extraction; unlisted versions or platforms fail closed, with `FINALCHECK_SQLITE_ALLOW_UNVERIFIED=1` as a temporary override.
- The download gate inspects lifecycle scripts in nested `package.json` files outside `node_modules`, and warns when only the root was scanned.
- Quality-gate approval targets now match the directory actually executed, so 8.3 short paths can no longer sidestep approval.
- A delete or rename whose target lies outside the project is rejected outright: the restricted token filters write access, not `DELETE` (a plain `del` could remove an outside file while `del /f` and `Remove-Item` were blocked by the kernel), so this case is closed at the application layer.
- Sandboxed child processes run in an invisible console, so no black window pops up; on the rare system where the hidden console makes the child exit with `0xC0000142`, the tool retries once with a visible console and says why.

### Improved

- Tool-argument errors, output truncation and "resending" notices are now fully in English in the English UI.
- The `.jsx` renderer is now linted for shadowed `t()` and React hook rules, fixing 10 shadowed variables.
- CI now runs a FinalCheck self-audit plus an exemption-consistency check, and README/RELIABILITY state the sandbox boundaries honestly (no read, network or process-visibility limits; Node toolchains and Git Bash utilities run on the host because of the restricted token, and are labelled as such).

## [0.16.1] - 2026-11-12

### Fixed

- When the model appends an extra `}` after otherwise valid tool-argument JSON, the extra closing delimiter is removed and the call executes instead of showing "arguments are not valid JSON" and retrying; only a prefix that parses is trimmed, so genuinely missing braces still fail as before.
- Tool-argument JSON errors, output-limit truncation and "resending" notices are now fully translated in the English UI instead of falling back to Chinese.
- Added regressions for trailing-brace repair and English error strings (1149 tests at the time).

## [0.16.0] - 2026-11-12

### Added

- Added `docs/RELIABILITY.md`: it states the implemented scope, evidence contracts and known boundaries; a "pass" now applies only to the plan actually executed in this run, not to full compliance.
- The download gate checks the requested version/range and npm lockfiles instead of only `latest`; the install hook recognizes common wrappers such as `sudo`, `env`, `bash -c`, `cmd /c`, `powershell`, `time`, `nice`, `command`, `timeout`, `xargs`, `stdbuf`, `nohup`, `exec` and `setsid`.
- Dynamic testing now records anonymous accessibility and successful sample counts: security needs probe samples, while performance, stability and robustness need stress samples; failed or zero-sample runs cannot upgrade evidence.
- Backup and privacy now use machine-readable evidence: `finalcheck.evidence.json` records a restore drill confirmed within the last 90 days, and `finalcheck.privacy.json` declares the fields actually collected.

### Fixed

- Audits are static by default and do not run the target project's tests or quality commands; only an explicit `--run-tests` executes them, and `--no-tests` takes precedence. The desktop app still never runs them.
- `readonly` now blocks commands, quality commands and project-memory writes; junctions and symlinks are checked against their real paths; approvals are isolated per session, project and tool; the quality gate binds a command-config fingerprint and executes the config snapshot taken at approval time.
- L2/L3 no longer report an overall pass while unresolved medium/high manual findings remain; L3 coverage must be produced in the current run, and missing or invalid required metrics are failures.
- Auth, signature, ownership and cookie checks now use evidence from the current route handler: an empty `next()` guard is not protection, comments or unrelated routes cannot suppress findings, and cookie attributes are read from actual values; unsupported frameworks are recorded as unavailable coverage.
- Injection checks now catch split-line/aliased SQL and SSRF; same-origin relative `fetch` calls and fixed hosts are no longer high-severity SSRF; parameterized queries, including concatenation inside a `LIKE ?` parameter array, are no longer false positives.
- Dynamic probing no longer treats HTTP 200 business errors, JSON not-found bodies or zero-sample runs as reproduced vulnerabilities; anonymous accessibility is listed only as a signal needing confirmation.
- The download gate no longer blocks installs when the download-count API fails; registry metadata failures or missing packages still block, and failures are not cached as safe.
- L3 backups require three pieces of evidence: an executable command, a related schedule, and a restore drill confirmed within the last 90 days; privacy declarations are reconciled against explicit fields and conflicts with "we do not collect" statements are flagged.
- Approval targets now use the same canonical real path as the tools on Windows 8.3 short paths, preventing duplicate approval prompts or timeouts for the same operation.

### Improved

- Regression tests grew from 1088 to 1146, adding the 18 reproduced cases plus regressions for install-hook prefix bypasses, same-origin SSRF false positives and parameterized-SQL false positives.
- README, ACCEPTANCE, QUALITY-GATE and DESKTOP-ACCEPTANCE were updated to the new semantics, with both READMEs showing 1146 tests.

## [0.15.2] - 2026-11-12

### Added

- Settings → About & updates now has an Export diagnostics button: one click produces a redacted JSON (version, OS, recent log lines, rule hits, masked config) without hunting for log files.
- Update details are available in English: the English UI shows the English release notes (`CHANGELOG.en.md`) instead of Chinese.
- Slash-command skill descriptions, quick-start prompt cards, and ask-card dimension descriptions are fully translated in the English UI.

### Fixed

- Parallel tool calls are no longer merged into one: each call keeps its own arguments, so errors like `ARGS_INVALID_JSON` or a function name glued together (`download_gate`) no longer appear.
- Malformed tool-argument JSON (Windows backslashes, trailing commas) is repaired automatically before execution instead of failing outright; truncated arguments still fail honestly.
- Continuing after an error no longer duplicates the previous answer or ask card: each message renders once, and history wins over the live copy.
- Restoring a session no longer stacks the on-disk "pending" assistant message on top of the live one.

### Improved

- The acceptance checklist is now an overlay in the top-right of the message area: it no longer shrinks the conversation width, collapses to a single chip, and remembers its state per session.
- The Chinese and English READMEs now agree on 1086 tests, the repository root and desktop versions are kept in parity, and both are checked before release so version drift cannot slip through.

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
