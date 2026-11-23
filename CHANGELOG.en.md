# Release Notes

This file is the English release notes for FinalCheck. Each entry mirrors the corresponding Chinese entry in CHANGELOG.md.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [SemVer](https://semver.org/).

Each version uses three sections: ### Added / ### Fixed / ### Improved. A section with no content is omitted rather than left as an empty heading.
Keep each item to one sentence, describe what users actually notice, and avoid internal jargon.

## [0.32.0] - 2026-11-23

### Added

- **The built-in browser is now embedded in the right rail — you can see it, click it, and type URLs yourself.** Previously, when the AI opened a page, the page was rendered in a hidden window that was never shown; all you saw was a white box reading "No content under offscreen mode", while the AI asked you to scan a QR code that was not visible anywhere. The browser is now a tab in the right rail: the page renders right there, so you can watch the AI work, take over and click buttons yourself, or type a URL in the address bar.
- **The right rail is now multi-tab**: artifact previews (images / HTML / PDF / slides / Word / video / text), the embedded browser, and sub-agent transcripts can all be open at the same time and switched freely, each with its own tab and close button. Previously it was either the artifact panel or the sub-agent panel, never both.
- **The built-in browser can open multiple pages**: it used to allow only one page (`window.open` simply failed and the page count stayed at 1). Each page now gets its own tab, links that open a new window become new tabs automatically, up to 12 at once.
- When the AI opens a page, the right rail opens itself and switches to the browser tab — you no longer have to hunt for what it is doing.

### Fixed

- The browser view now follows window resizing, rail dragging and sidebar collapsing in real time (an embedded view does not track layout by itself, so the UI has to report its position to the main process; that channel now exists).
- Closing a page tab or collapsing the rail hides the corresponding view immediately — no stale frame flashing in place.

## [0.31.2] - 2026-11-23

### Fixed

- The context usage indicator above the input box now drops immediately after a compaction. Previously the compaction notice said "about 908451 tokens → 16411 tokens" while the panel did not move at all, looking like the compaction never took effect. Two causes: (1) the panel counted the **entire pre-compaction history**, whereas what actually gets sent after compaction is the handoff summary plus messages added afterwards; (2) the panel prefers the "measured usage of the last request", which compaction turns into stale history without invalidating it. Now a successful compaction invalidates the stale measurement, recomputes with the same compaction basis, and refreshes the panel at once (it used to wait for a refresh timer of up to 5 minutes).

## [0.31.1] - 2026-11-23

### Improved

- **You** choose the browser mode now, not the AI: for any task that opens a web page, the AI first asks you to pick one of **one-shot (private) / long-term / use my own Edge**, and each option states plainly whether it writes to disk and whether it touches your real account. Once you answer, the rest of that session follows it without re-asking; if you already said which mode you want in the conversation, or Settings already has a choice, it will not ask at all. Measured before this change: you only said "open the browser, I want to sign in to my Xiaohongshu", and the AI picked the real Edge on its own, then stole the foreground to bring that window forward — five wasted steps.
- Connecting the real Edge now needs your go-ahead: if the AI wants to use your real signed-in session on its own initiative, it asks "connect your own Edge now?" first. If you decline it falls back to the offscreen browser and says plainly that sign-in-only content will not be visible — no silent switch to another route, no repeated nagging.
- Once the real Edge is connected, the AI can only view and click through the browser itself (never stealing your foreground) and **can no longer call desktop automation to screenshot or move that Edge window**. Previously it requested desktop permission, took screenshots and switched the foreground just to focus that window — a detour that really did drive your mouse and keyboard. This block only covers the Edge that FinalCheck started; your everyday browser and other apps are unaffected.

## [0.31.0] - 2026-11-23

### Added

- Three browser modes: (1) **offscreen incognito** (default, forgotten on close), (2) **offscreen persistent** (remembers logins, cookies on disk, red-bordered indicator plus one-click clear in Settings), and (3) **drive your real Edge** (real UA, real login state — for pages that need a signed-in session: scan the QR code once, then operate in the background without ever stealing your foreground). Settings gains a "Browser session" section; first use asks once whether to keep the session.
- Real-Edge mode uses its own profile and port (never touching your daily Edge or the crawler tool's port); disconnecting **never closes the browser** — the window you signed into stays open.

### Improved

- Clearing browser data actually removes the login state: close the window, clear session data, then best-effort delete the directory (on Windows a still-busy file is reported honestly as "data cleared but directory remains" instead of pretending).

## [0.30.4] - 2026-11-22

### Improved

- Desktop control now follows a five-stage workflow: **resolve the target → capture the target window directly (no full-screen first) → keep one screenshot across consecutive actions → re-verify only after result-bearing actions (send/save/delete) → use region capture only to read small text**. Sending one WeChat message used to mean a full-screen shot plus repeated cropping to find tiny glyphs; a window capture now returns the whole window in one shot, and coordinates are in-image pixels converted automatically. Full-screen capture keeps five legitimate uses: unknown target window, need screen-relative layout, target minimized, target is FinalCheck itself, suspected tray/system popup interference.

## [0.30.3] - 2026-11-22

### Fixed

- The horizontal scrollbar at the bottom of a conversation is gone: a wide table in a reply used to stretch the whole message area, adding a page-wide bar underneath (only conversations containing tables showed it; text-only ones didn't). Tables now scroll inside their own box and still show everything.
- Visual self-checking now has a stop-loss: after finishing a page or deck the assistant used to take dozens of screenshots picking at pixels (34 screenshots in one measured task). It now finishes the artifact first, reviews once, and self-checks at most 3 rounds per artifact, then delivers and lists known unfixed details; only severe issues (clipped content, overlapping elements, blank screen, misalignment) keep triggering fixes, while font weight and 1px radius tweaks happen once and move on.
- Three accessibility-passthrough false judgements: (1) when an app window was closed (rather than genuinely having no accessibility tree) it permanently remembered "no passthrough for this app", which survived restarts — now only a confirmed tree-less app is remembered; (2) self-drawn apps return "tree readable but zero elements", which used to count as "the element really disappeared" and made waits report success — now "confirmed gone" and "unreadable" are distinct; (3) an unknown process name used to mean "unsupported" — it is now handed to a real probe.

## [0.30.1] - 2026-11-22

### Fixed

- Closed a hole that could land clicks on the occluding window: when using the accessibility interface for covered targets, a failed call previously fell through to a normal click — i.e. clicking the window that covers yours. Failures are now always refused with the reason instead of blind-firing.
- Re-authorize after pulling the target back: following an automatic refocus, a fresh permission and target check now runs (previously the policy was checked once at the start, so a revoked grant during the turn could still act).
- Occlusion passthrough only trusts the target window's own capture: with a full-screen screenshot you see the occluder, and passing its coordinates through the accessibility interface would hit a different control inside the target; only window-self captures may traverse now, everything else falls back to the explicit occlusion refusal.
- Wait conditions no longer report false positives: when the UI cannot be read (apps without an accessibility tree, e.g. WeChat), "wait for element to disappear" previously returned "already gone" immediately — "confirmed gone", "unobservable" and "timed out" are now distinct, with the middle case waiting out the budget and saying why.

## [0.30.0] - 2026-11-22

### Added

- Covered windows are now clickable: apps with standard controls (Notepad, Calculator, Office) are driven through the system accessibility interface, so the target control is hit even when another window sits on top of it; apps without an accessibility tree (WeChat, Electron/browsers) are still refused with the blocking window named.
- Background typing: for verified classic Win32 programs (Notepad and friends) text can be delivered without stealing your foreground window; the result is marked as unverified delivery and states what is excluded (chords, WeChat/Electron always use normal key injection).
- Actions can wait for UI changes: computer_action accepts "wait for element to appear / disappear / text equals / text contains", 5s by default and 30s max; a timeout returns an explicit "timed out, not matched" instead of a failure, and later actions continue.

### Fixed

- The gold overlay and the top-right mini window no longer disappear when you interrupt control and the assistant yields: they stay until the turn really ends or you press ESC (previously replying "continue" and running a command left the screen uncovered for a long time).
- Window activation, topmost and move operations must go through the computer-control tools: scripts calling SetWindowPos/ShowWindow/SetForegroundWindow/AppActivate/SwitchToThisWindow to change window state are refused with a pointer to focus/click, ending the "keep writing scripts to poke windows, UI stutters, dozens of wasted turns" loop; read-only inspection (window titles, enumeration, process checks) is unaffected.

## [0.29.10] - 2026-11-22

### Fixed

- Fixed the second fallback path for window screenshots: the Microsoft winapp CLI was invoked with two non-existent flags (`--hwnd`/`--out`), so it would fail silently even when installed. Now uses its official flags (`-w`/`-o`/`--json`) and cross-checks the returned window dimensions — a wrong window or black frame is discarded and falls back to full-screen instead of being reported as success.

## [0.29.9] - 2026-11-22

### Fixed

- The top-right mini chat window now actually shrinks: the main window had a 980px minimum width, so resizing to 360px was silently refused (the window stayed 980 wide and only moved) — that's why the mini layout never took effect and part of the WeChat input box was covered. Entering control mode now lifts the width floor and restores it on exit; the window sits below the top banner with a 12px right margin.
- Mini-mode conversation is fully readable: session header hidden, paddings compacted, long URLs and sentences force-wrapped — no truncation or horizontal clipping at 360px.

## [0.29.8] - 2026-11-22

### Added

- Desktop-control screenshots now support「capture the window itself」: a target window half-covered by other windows still yields its own full content, text readable character-by-character — verified working on self-drawn apps like WeChat; seeing and clicking are now separate: you see the whole window, but clicks into occluded regions are still rejected with the reason.
- A minimized target automatically falls back to full-screen capture with an explanatory note; the three-level capture chain always keeps a fallback.

### Fixed

- Top-right mini chat window content adaptation completed: session header hidden, paddings compacted, long URLs and sentences force-wrapped — the conversation is 100% visible and readable at 360px (previously only the sidebar was hidden; title truncation and horizontal clipping remained).
- Coordinate mapping by window origin (verified by real click calibration: menu open and status-bar caret position both matched prediction); unsupported scenes (minimized/multi-screen) are clearly refused instead of giving wrong coordinates.

## [0.29.7] - 2026-11-22

### Added

- Revamped computer-control visuals: gold screen tint, gold reminder banner centered at the top of the screen, and a true mini chat window in the top-right corner (current conversation + composer only, no sidebar); press ESC at any time to stop control.
- Anti-detour: tasks doable with a single command (start a server, check a process) now execute that command first — the same probe task went from 9 calls/75s to 2 calls/16s; multi-file long tasks measured 50% faster with no quality loss.

### Fixed

- Clicks validate the landing point first: an occluded target is now clearly reported as「blocked by window X」instead of clicking into the occluding window (keyboard paths unaffected).
- Simulating keyboard/mouse via script files (e.g. powershell -File xxx.ps1) now also requires desktop-control authorization — closing the「keywords inside the script file」bypass (observed in the wild).
- Repeating the same failing operation 3 times now suggests switching paths or asking you; thinking without acting gets a nudge to output the next step; excessive thinking is reined in earlier (200k → 80k chars).
- Updated screenshot guidance: consecutive clicks/typing reuse the current screenshot; forced re-verification only after submit/save/delete — halving image round-trips.

## [0.29.6] - 2026-11-21

### Fixed

- The gold overlay is back while the assistant controls your computer: the screen tint and the mini chat window in the top-right corner now appear again in installed builds (they never showed outside dev mode due to a packaging-only code elimination, now pinned by a regression test).

## [0.29.5] - 2026-11-21

### Fixed

- The installer now ships the skills directory (computer-use / browser-use and friends): packaging previously skipped it, so the installed app's slash menu was missing the desktop/browser automation skills (visible in dev, absent when installed).
- Skills now load from the cross-agent shared folder `~/.agents/skills` (same source and format as ZCode / Claude Code): skills placed there appear in the slash menu and load by name; FC's own skills win on name conflicts.

## [0.29.4] - 2026-11-21

### Added

- Desktop screenshots now work in two stages: take a full-screen shot to locate the area, then capture a small region (input boxes, menus) at the screen's native resolution — text is sharp enough to verify character-by-character, coordinates map 1:1 with no conversion, so the assistant no longer retries blindly when reading small on-screen text.

### Improved

- Bulk self-check screenshots no longer flood the conversation: screenshots within one reply collapse into a single "Check screenshots ×N" counter (collapsed by default); expanding it keeps each screenshot openable in the right-hand panel.
- Removed the colored dots next to Settings; a gold "Update v{version}" button appears when a new version is found — click to download, then one click to restart and install.
- Updated desktop-control guidance: prefer clicking large on-screen buttons for send/submit actions (some apps, e.g. WeChat, silently ignore Enter shortcuts), and confirm keyboard focus is in the target input before typing.

## [0.29.3] - 2026-11-21

### Fixed

- When the foreground is snatched by another app mid-task, the assistant automatically brings the target window back (rate-limited) and continues, instead of failing every step; when it detects you are actively using the machine it yields and pauses — reply "continue" to resume.
- Commands that simulate keyboard/mouse input (keybd_event/SendInput etc.) now require desktop-operation authorization before they can run, closing the loophole around the computer-use safety layers; AttachThreadInput / SetWindowsHookEx commands are rejected unconditionally.
- When the tool-turn budget is nearly exhausted, a wrap-up instruction is injected automatically: the final turn is for conclusions and an explicit not-covered list — no more half-finished runs without a report.

### Added

- Keyboard actions support Win combinations (e.g. Win+Space to switch input method).

### Added

- While the assistant controls your desktop, a translucent overlay says "FinalCheck is controlling your computer" and the main window shrinks to a pinned mini panel in the top-right corner, so you can keep chatting or stop with one click.

### Fixed

- Typing in document apps is no longer blocked: the title change caused by the unsaved marker is not mistaken for a window switch, so continuous typing and saving work without re-screenshotting every step.
- Launching GUI apps like Notepad no longer stalls the conversation, and turns with an explicit time limit now finish on time and say so.

### Improved

- The browser waits for the page to actually settle before reading its structure, so asynchronously loading pages no longer show an empty "Loading" shell.
- When a page re-render invalidates control references, the assistant first tries to re-locate the same control by its signature instead of re-scanning the whole page.

### Fixed

- Browser actions check the target again when a control is replaced, reused, or covered to avoid clicking or typing in the wrong place.
- Desktop actions translate screenshot coordinates and verify the window and focus before sending input.
- The assistant can now read page status messages and console errors that occur during page startup.
- A failed browser or desktop action stops later actions of the same kind in its batch, so a failed form entry cannot lead to submission.

### Improved

- Opening a page now returns its controls in the same call, and browser clicks and desktop actions can include the resulting page structure or screenshot.

## [0.29.0] - 2026-11-21

Desktop-control release: the AI can now see your screen, move the mouse and type on the keyboard (for non-browser apps like Word, Excel, system settings), and it can click buttons and fill forms in a web page the way a person would. The whole permission design follows Claude Code's approach.

### Added

- **Computer use**: the AI can capture the screen to see what is currently on your desktop, move the mouse, click (left/right/middle, double and triple click), drag, scroll, type text, and press key combinations. The screenshot reports which app is in front, and coordinates are simply pixels on that screenshot.
- **Browser use**: opens a separate window (it does not load your login state) that can navigate, read the page structure (every clickable or typeable element carries a `[ref=eN]` reference), click by reference, fill forms, run JS, and read console errors. Reading the structure beats guessing pixel coordinates when you need to know how the page is built.
- **Per-application access requests**: before touching any other app the AI asks you first ("AI requests access to: WINWORD, EXCEL") and only proceeds after you agree. If you decline, it says plainly that you need to grant access — it will not route around you. Access resets when the app restarts.

### Improved

- **Three permission tiers enforced by the frontmost app**: browsers (Chrome/Edge/Firefox/Safari/Brave/360…) are view-only — no clicking, no typing; terminals and editors (Windows Terminal/PowerShell/VSCode/Cursor/IDEA/python/node…) allow left clicks only — no typing, right-click or dragging; everything else (Word/Excel/Photoshop/system settings) is fully allowed. This is deliberate: typing into a terminal or editor on the user's behalf means running commands for them.
- **Frontmost target is checked before every action**: mouse and keyboard input only reaches the window that is currently in front, so each action first confirms the frontmost app is the one you authorised. If it is not, the action is refused with an explanation rather than assumed to have worked. This came out of real testing — when the target window failed to come to the front, clicks landed on a different program.
- **Chinese text input**: fixed Chinese input turning into mojibake (the Windows console decodes as GBK by default; it now goes through Unicode escapes).

## [0.28.1] - 2026-11-20

Polish release: six rough edges found in real use, two of which were "works, but feels wrong" rather than outright breakage.

### Fixed

- **When the AI asked you a question, the question itself was missing**: in the English UI, if the AI asked in Chinese the whole sentence was replaced with "Choose from the options below." — you saw four options and had no idea what was being asked. The question now always keeps its original text (if you cannot read it you can still copy it and translate, which beats a placeholder line). Dev mode now also asks in the UI language.
- **The model picker had a redundant "Current" row**: the separate highlighted block above the list is gone; the current model's own row now shows a check mark plus its effort level instead.
- **Context usage never refreshed**: it only recalculated after you sent a message, so after compaction or during a long tool run the number sat at a stale value that looked like compaction had not worked. It now refreshes every 5 minutes on its own (skipped while the window is in the background).
- **Clicking a link in a message turned the whole app into a web page**: nothing intercepted it, so Electron navigated the main window to that URL and you had to restart. Links now open in your system browser and the main window is never taken over.
- **A two-item checklist was rejected**: the minimum used to be three. For one or two clear goals, two items is a sensible breakdown, and being rejected forced a rewrite and another round trip. Two is now accepted (one is still rejected — a single item is not a breakdown).

### Added

- **Stuck-on-the-same-error now gets a nudge**: previously only exact repeats of the same tool call were caught, not "different attempts that keep hitting the same error" — which is what getting stuck actually looks like. The failure signature of each round is now remembered (error kind, failing test count; paths and line numbers do not count as differences), and five consecutive rounds on the same error trigger a prompt to step back, try something simpler, or report honestly where it is stuck. It only nudges, never aborts, and at most twice per error.

## [0.28.0] - 2026-11-20

Long-task release: open-ended work (designing a page, choosing a visual direction, weighing architecture trade-offs) used to end with the model thinking for a long time and producing nothing. It now finishes, and it checks its own output by taking screenshots before delivering instead of trusting the code.

### Fixed

- **Open-ended tasks were aborted as "output loop"**: previously, whenever the model's reasoning passed 60k characters it was treated as a loop and killed with "detected a repetitive output loop". In three measured runs of 120k characters there was no repetition at all — it was simply thinking for a long time. It now first checks whether the same passage actually recurs, and the length ceiling is raised to 200k with a distinct "thinking too long" signal instead of a false loop report. Measured: before the fix, two consecutive attempts produced zero files and spent over seven minutes thinking; after the fix, the same task completed.
- **The AI could not see what it wrote when running headless**: it used to get no screenshot at all (told "screenshots are only available in the desktop app"), so it wrote UI blind — a measured run produced a page whose own script threw, and whose screen-reader text was never hidden, rendering the numbers as "1919/4141", and it had no way to know. When there is no desktop window it now starts a separate renderer process to capture the page, so the model can look and then fix. Measured on the same task: 0 screenshots before, 11 screenshots and 40 image views after, iterating until it was deliverable.
- **Playbooks 41-50 never reached the AI**: in dev mode the system prompt only carried the 01-40 vulnerability-technique catalogue, and 41-50 fix skills were reduced to "topic=the matching number", so the AI had no idea what each one was and fixed issues off the cuff. Dev mode now lists 41-50 with their numbers and purposes. The descriptions of "list playbooks" and "read playbook" also no longer say "when starting pentesting" — they now cover delivery acceptance and fixing audit findings too. Before this, across 9 sessions and 1188 tool calls, neither tool had ever been used.

### Improved

- **Repetition protection now covers the closing answer too**: if the model starts repeating while writing its final conclusion, that used to be delivered as a normal answer; it is now reported plainly as an incomplete finish.
- **Screenshots no longer pile up renderer processes**: at most two run at once, waiting longer than 30 seconds gives a clear reason, and each capture cleans up its temporary directory.

## [0.27.1] - 2026-11-19

Interface release: the session sidebar can now be collapsed, the preview panel no longer squeezes the conversation away, and the composer keeps its shape at any width.

### Added

- **Collapsible session sidebar**: the FC mark at the very top-left of the title bar is the switch — hover over it and it turns into a sidebar icon; click once and the sidebar slides away, giving the conversation 212px more room, click again and it slides back. The choice is remembered across restarts.
- **It slides instead of jumping**: a 220ms width transition, with the conversation widening alongside it.

### Fixed

- **Opening the preview panel used to squeeze the conversation away**: in a 1010px window the panel could take up to 727px (72% of the window) and the sidebar another 212px, leaving the conversation just 71px — the middle vanished and the composer was crushed into a strip at the bottom. The panel width is now computed as "window − sidebar − at least 420px of conversation", so there is always room for the conversation.
- **The composer toolbar used to wrap at narrow widths**: once squeezed, "Full access" and "Type / for skills" broke into two or three lines and the toolbar grew from 36px to 50px. All labels now stay on one line, and the hint that burst in tight spaces is gone.
- **The model name collapsed into an ellipsis**: the full model name and thinking effort now show by default; only when the composer is genuinely too narrow to fit the name does it shrink to a cube icon.

### Improved

- **Collapsing the sidebar no longer slows the interface down**: the sidebar is frosted glass, and changing its width forced the glass to be re-blurred every frame. The blur is now switched off only during the 0.2s slide (barely noticeable, since the sidebar is nearly opaque) and restored the moment it ends. Measured frame interval stays at a steady 4ms, with no stutter.

## [0.27.0] - 2026-11-19

Context compaction now fully matches Claude Code: when the context is nearly full it is compacted once and saved, and every later turn just appends after it. Handoff summaries are more complete, and the user's own words, the files at compaction time, and the full transcript all have a deterministic fallback. This release also fixes 7 issues found with the simulated-client harness and real-model runs.

### Added

- **Re-read the working state when compacting**: at the moment of compaction, the files recently read or edited are re-attached with their current contents from disk (not the AI's recollection), along with git status and the current checklist. The full transcript being compacted away is written to a file the AI can read when it needs earlier details (full command output, the full conversation) instead of guessing from the summary.
- **Compaction scenarios in the test harness**: a scripted-gateway scenario covers in-turn compaction, compaction at turn start, continuing after an app restart, manual /compact, and the user's words surviving three compactions; a real-model scenario checks that after compaction the AI can still answer concrete values it read before, without re-reading files.

### Fixed

- **Once over the limit, every turn compacted again**: compaction used to change only what was sent to the model for that turn and was never saved. Once past the limit, every turn started with an extra summary request, and the whole prefix changed every turn so the gateway cache never hit. Compaction is now saved in the session once, and every later turn sends the same summary plus the messages after it; in the harness, the same 6 turns went from 8 summary requests to 2 and cache hits from 60% to 81%, and it carries over an app restart.
- **Auto-compaction chopped up its own instructions**: the summary request was split into 30k-character chunks that were summarized separately and then merged (a summary of summaries), and the "write a sectioned handoff" instruction only landed in the first chunk. It is now one request with no chunking.
- **Manual /compact only saw the final answers**: which files were read and what commands printed were missing from the material. It now includes each turn's full tool history.
- **Summaries said "read the file" without saying what was in it**: in a real-model run, after compaction the AI could not say what b.js's timeout was, because the summary only said "successfully got the first-line comment". The summary now has a dedicated "key facts and data" section that must state concrete values; the same questions are now answered correctly.
- **Manual compaction with thinking models failed with "empty summary"**: some gateways return only the reasoning and no content for non-streaming requests. Summary requests now stream, like the main conversation.
- **Rewinding to before the compaction point kept the old summary**: after editing and resending an earlier message, the summary still contained content that had been taken back. The summary is now discarded in that case and the history rebuilds from the original messages.
- **A stopped turn could make the compaction boundary misalign**: a stopped turn shows up in the UI as a progress digest that differs from what is stored, which made the whole history get sent again after compaction (and immediately exceed the limit). When the text doesn't match, it now aligns by user-message count, and keeps everything only if the user's own words don't match either.

### Improved

- **Compaction reuses the conversation cache**: compaction sends the current conversation plus one compaction instruction, so everything before it is identical to the previous request and hits the gateway cache (25k of 33k tokens in a real-model run) — hundreds of thousands of tokens of history don't need to be recomputed. If it doesn't fit or the gateway refuses, it falls back to sending a written-out transcript.
- **Handoff summaries use Claude Code's format**: 9 sections (main requests and the status of each, key facts and data, technical concepts, files and code, errors and fixes including where you corrected the AI, problem solving, pending tasks, current work, next step). The model drafts first and then writes the final version; the draft never enters the context. Your own words are still kept verbatim and survive multiple compactions.
- **The recent steps kept after compaction are sized, not counted**: it used to keep the last 8 messages regardless of size, so with large tool results the context could come out longer and compact again right away; it now keeps the last few steps up to a quarter of the limit, and always at least the last step.

## [0.26.0] - 2026-11-19

Three things: Claude Code–style lightweight sub-agents; workflows unified into a single "flowchart" format; and a simulated-client test harness that runs the full app pipeline in the background the way a real person uses it — which already caught and fixed 5 real bugs.

### Added

- **Lightweight sub-agents (spawn_agent)**: the AI can hand off a self-contained job — searching a whole repo for a kind of code, figuring out how a module works — to a sub-agent. The sub-agent starts with a blank context and its own tools, and hands back only its report, so the many files it reads never fill up the main conversation. Spawning several in one reply runs them in parallel. Three kinds: read-only investigation (default), allowed to edit files, and independent review (ignores the original reasoning and re-gathers its own evidence). Click "Open sub-agent transcript" in the timeline to see every step it took.
- **Simulated-client test harness**: with no window and no mouse or keyboard, it runs the full pipeline in the background the way a real person uses the app — sending messages, multi-turn chats, stopping midway and continuing, restarting the app and picking up again, sub-agents, workflows — through exactly the same backend code as the desktop app, and checks what was saved, the UI events, whether the prompt-cache prefix broke, and whether files were changed correctly. Three layers: tools only (no model), scripted fake gateway (seconds, now part of npm test), and real model (which also records a replayable cassette). There is also a "trigger eval" that checks with a real model whether the AI actually uses sub-agents / workflows when it should, and leaves them alone when it shouldn't.

### Fixed

- **Every request failed when thinking effort was set to "Default"**: "Default (follow the model)" sent `reasoning_effort: default` to the gateway as-is, and some gateways reject it with HTTP 400. Default now omits the parameter.
- **The end of long command output was silently dropped**: command output used to keep only the first 8,000 characters and silently drop the rest — where test results and error summaries usually are. Now the beginning and the end are kept with a note saying how much was omitted, and the full output is saved to a file the AI can search.
- **The AI couldn't read the saved full output of long results**: long tool results are saved to a file and the AI is told to look there, but that folder lives under `%APPDATA%\FinalCheck` and the safety gate blocked all of it. That folder is now read-only accessible to the AI; config files stay off-limits and nothing in it can be deleted.
- **A stopped turn lost its raw results one turn later**: a turn you stopped was carried over in full when you said "continue", but one turn after that it was swapped back to a short summary — breaking the prompt cache at that point and hiding the original output from the AI. It now stays the same full record however many turns later. Long results likewise: what's carried into the next turn is exactly what the AI saw (previously only the first 2,000 characters).
- **Rollback couldn't find the snapshot when the project path involved a junction or short (8.3) name**: the AI snapshots a file before editing it, but if rollback was given the path written differently from when the snapshot was taken (e.g. a project inside a directory junction), it reported "no snapshot to roll back". Both sides now use the resolved real path.

### Improved

- **Workflows are now one flowchart**: there used to be two formats (DAG and DSL); the AI had to classify the task first and pick one, and `depends_on` meant different things in each, which confused people and the AI alike. Now there is only one: each node is a sub-agent by default, `depends_on` decides what waits for what, and independent nodes run together; when the count depends on upstream results (fan out over a list, loops, branches), you use special nodes in the same chart. Bad references and dependency cycles are reported before anything runs. Workflow cards now just say "Flowchart". Old-format workflows in existing sessions still run.

## [0.25.0] - 2026-11-19

The memory overhaul: the context mechanism now fully matches Claude Code. Within a session, the AI sees everything it did in earlier turns; 1M-context models no longer drop anything early and only compact when the context is genuinely almost full.

### Added

- **Full memory across turns**: previously, after each turn only the AI's final answer and a background summary were carried into the next one, so the files it had read, the commands it had run and the results it had seen were all gone and had to be fetched again. Every turn's tool calls and results now stay in the conversation and are usable right away in the next turn, just like Claude Code. The carried history is byte-for-byte identical to what was actually sent to the model last turn, so the gateway's prompt cache keeps hitting across turns.
- **Context size is judged by the gateway's real usage**: context size used to be a local estimate (0.24's estimate got images wrong, which made the AI keep losing its memory). The actual token count the gateway returns with each response is now the source of truth; the local estimate only covers the few messages added since.

### Improved

- **Large-window models no longer drop things early**: the default 160k-token speed cap is gone. A 1M-context model now only appends and never deletes anything during normal work, relying on the cache to keep each step fast, and the AI writes a handoff summary only when the context window is genuinely close to full. If you want to save tokens, you can still set a cap in the config (`inTurnTokenCap`).
- **No extra model call per turn for a summary**: the full history is already in context, so the background summary is no longer needed; each turn makes one less model call, saving time and money.
- **More reliable compaction across turns**: when compaction is actually needed, the material handed to the AI for its summary includes the full tool history, your own words are kept verbatim, and the most recent tool results stay intact instead of being truncated.
- **Every context cleanup is shown**: previously you saw only one notice per turn and nothing for later folds; now every fold shows a notice, and compaction shows "Compacting context".

## [0.24.2] - 2026-11-19

Hotfix: in 0.24.0 / 0.24.1, during tasks that look at images over and over, such as making videos or decks, the AI forgot what it had done every few steps and went in circles.

### Fixed

- **On image-heavy tasks the AI kept losing its memory and going in circles**: when estimating context size, a screenshot's raw base64 was counted as text, so one image was estimated at over 100k tokens when it really uses only one or two thousand. Any image in context made the context count as "over the limit", so it was compacted again and again until only the last few messages were left. In a real promo-video run on 0.24.0, from the second hour on, 80 requests in a row made no progress at all: the AI kept re-listing directories, re-reading files and re-viewing the same images. Each image is now estimated at a fixed cost; in a simulated 40-step "edit and look at images" loop, compactions dropped from 19 to 0.
- Added a safeguard: summaries triggered by the speed cap are at least 20 requests apart, so even if an estimate is off again, it can no longer turn into "forget everything every few steps".

## [0.24.1] - 2026-11-19

The UI release: new dark and light themes with one-click switching, plus a reworked dark theme with clearer depth and lighting.

### Added

- **Dark and light themes**: switch with one click using the sun / moon button at the top right of the title bar, or in the new Appearance section in Settings; your choice is remembered. Light is a warm paper white and dark is ink black with gold. Body text contrast is above 15:1 in both, and the gold and warning red in the light theme were retuned to WCAG AA so they stay readable on white. The app opens straight in the chosen theme, with no black flash at startup.

### Improved

- **The dark theme has real depth**: the sidebar, main area and cards used to be almost the same black, so the whole page looked flat. They now step clearly from dark to light, code blocks sit recessed, the background has a few soft warm-gold glows, and the glass sidebar lets that light show through.
- **Your own message bubbles look cleaner**: the muddy olive-brown fill is now a warm grey with a thin gold border.

## [0.24.0] - 2026-11-19

The speed release: long-task context management is rebuilt to match Claude Code. Each step of a long task no longer gets slower and slower, and the AI no longer picks an acceptance tier without asking you.

### Fixed

- **Long tasks kept getting slower**: a promo-video task ran 529 steps over 109 minutes, 99 of them spent waiting on the model. Cleanup actions such as trimming old images and merging index lines were changing early messages on almost every step, so the gateway's prompt cache missed and the whole context had to be processed again. Measured on the real gateway with a context of about 170k tokens: a step took 4–5 s when the cache hit, 15–17 s when it missed, and 20–26 s the first time. The conversation is now append-only and cleanup happens occasionally, in batches. In a simulated 300-step task, early messages are now changed 11 times instead of on almost every step.
- **The AI picked L1 / L2 / L3 without asking**: a tier the model fills into the tool arguments by itself no longer counts. Acceptance starts only once you have stated a tier in the conversation or the AI has asked you first.

### Improved

- **In-task speed cap**: once the context passes 160k tokens, older tool results are folded in one go into one-line index entries (which file was read, which command was run). The 12 most recent results and the conversation text stay verbatim. Previously, a 1M-window model only cleaned up at about 980k tokens, so every step carried the entire history.
- **Near the context limit, the AI writes its own handoff summary** (as Claude Code does): the summary covers the requirements, what is done, key findings, current progress and next steps. Your original words are kept verbatim; previously only their first 60 characters survived. If the summary fails, a local summary is used instead and the task keeps going.
- **The AI batches its work**: independent file reads, screenshots and commands go out together in one reply. Visual edits now render several frames, review them together and fix everything at once, instead of looping "change one thing, look at one frame". At most 4 image messages stay in context at once; past that, they are trimmed back to 2 in one go.

## [0.23.0] - 2026-11-19

The "continue" release: after a task is interrupted, saying "continue" lets the AI pick up where it left off, the way Claude Code does, instead of exploring from scratch; what the model says and thinks is saved with every step, so closing the app midway no longer loses it.

### Added

- **"Continue" after an interruption picks up right where it stopped**: when the previous turn did not finish because of a network drop, a manual stop or the app being closed, saying "continue" hands the AI that turn's full tool history as it happened (every call, its real result and what the model said at the time), keeping the most recent steps verbatim and condensing older ones into a summary. Tested on a promo-video task interrupted after 281 steps: the old version re-ran ls, re-read the source and re-viewed the screenshots after "continue"; the new version went straight to checking the rendered output and audio and moved on to the final compositing step. The cost is extra tokens for that one "continue" (about 60k in this example); normal conversation is unaffected.

### Fixed

- **When a turn did not end normally, everything the model said and thought was lost**: tool records were saved step by step, but the reply and reasoning were only written when the turn ended normally, so closing the app or a process exit left only the tools (in a real 281-step turn, the stored reply and reasoning were both empty). Each round's reasoning and the text before its tools are now saved immediately with that round's first tool and still show in the timeline after reopening the session.
- After sending the next message, the reasoning in the previous turn's timeline disappeared from the screen, leaving only the tool list.
- A manual stop discarded the last round's reasoning, and turns that ended in a gateway error saved no reasoning at all.
- Cross-turn context compaction could fold a tool call into the summary while keeping its result, leaving a tool result with no matching call that the gateway rejects outright; calls and results are now always kept together.

## [0.22.0] - 2026-11-18

The multi-language and real-model acceptance release: Go / Java / PHP projects get injection checks for the first time, and Go / Java / PHP / Rust / Ruby / .NET dependencies plus Dockerfile / K8s configuration are checked through Trivy. The full AI acceptance flow was run with a real model (deepseek-v4.1-flash-eco) on 6 real repositories, and the problems it surfaced are fixed. The right-hand preview now plays videos and shows PPT / Word / PDF page by page.

### Added

- **The AI can look at images and take screenshots**: new `view_image` (look at a local image) and `capture_screenshot` (render a web page / local HTML / SVG, one page of a PDF / PPT / Word file, or one frame of a video into an image the AI can see). When building visual deliverables such as decks, pages and videos, the AI now screenshots its own output to check for overflowing, overlapping or misaligned text before fixing it; screenshots also appear in the chat and open at full size. In testing, asked only "is the layout OK?", the model captured both a desktop and a phone viewport on its own and pointed out text running 200px past the card and clipping on mobile. Requires the model to have the vision option checked in Settings → Models.
- **Injection checks for Go / Java / PHP**: the Semgrep engine with FinalCheck's own rule pack (not Semgrep's official rule registry), covering SQL / command / code injection, path traversal, file inclusion, SSRF, open redirect, XSS, unsafe deserialization, XXE, SpEL / Groovy / template expression injection, and passwords hashed with MD5/SHA1; supports net/http, gin, echo, fiber, Spring (including unannotated parameters), Servlet, JPA, Laravel and plain PHP. On real repositories: about 85% of DVWA findings are real issues, and two normal projects (spring-petclinic, gin RealWorld) produced zero noise.
- **MyBatis `${}` SQL injection**: `${}` in mapper XML and in `@Select` / `@Update` annotations is reported, with a fix suited to the case (LIKE queries, an order-by whitelist, `foreach` for IN lists). Does not need Semgrep.
- **Trivy integration**: Go / Java / PHP / Rust / Ruby / .NET dependency vulnerabilities are no longer all marked "not audited"; Dockerfile / Kubernetes / Terraform misconfigurations (such as containers running as root) and cloud provider keys are found as well. Without Trivy or Semgrep installed, FinalCheck shows the install command and still reports the area as not covered instead of pretending it was checked.
- **Video and paged documents in the right-hand preview**: mp4 / webm / mov play directly (seeking works, and the 15MB limit no longer applies); PDFs show one page at a time with previous / next buttons and a thumbnail strip; PPT / Word files are converted to PDF with the local LibreOffice and previewed the same way (each file is converted only once).
- Real-model end-to-end test script `desktop/scripts/e2e-agent.mjs`: runs an unattended acceptance on any repository with the same AI and tools as the desktop app, recording every tool call, its duration and token usage.

### Fixed

- **After the gateway dropped, saying "continue" lost the previous turn**: a turn that ended in an error used to be filtered out on the next send, so minutes of tool history vanished from the screen and the AI had no idea where it had stopped and started over; the turn now stays visible, and a summary of what was done before the interruption (tools called, their arguments and key results) is handed to the AI so it can pick up from there.
- **Giving up too quickly on network hiccups**: retries go from 5 attempts within about 9 seconds to 7 attempts with 2 → 5 → 10 → 20 → 30 → 30 second backoff (about 1.5 minutes), so a brief network drop no longer throws away an acceptance run that has been going for ten minutes or more.
- Project memory (AGENTS.md) got written as one task's deliverable inventory ("13 pages", six script names…), which turned into wrong information as soon as the deliverable changed; it is now organized into project overview / common commands / directory conventions / rules / acceptance criteria, entries with line numbers, progress notes, counts that drift, file inventories or more than 220 characters are sent back for the AI to rewrite, and stale entries can be updated in place instead of piling up.
- A preview opened in one session stayed open after switching to another session; each session now remembers its own preview and restores it when you switch back.
- Express projects that export routes with `module.exports = function () { …; return router }` and mount them with `app.use('/x', require('./routes/x')())` yielded no routes at all, so auth, webhook and IDOR checks were marked "not applicable" (found on dvna).
- Spring's default package path `com/example/...` was treated as an examples folder, demoting every finding in the Java project to a tip.
- Files with Windows (CRLF) line endings: whole-line comments in requirements.txt were treated as "unpinned dependencies"; every check now normalizes line endings when reading files.
- Python projects with many requirements.txt files waited 3 minutes per file for pip-audit, serially, for 24 minutes until the whole turn timed out (found on pygoat); files now share a 2.5-minute total budget, and after one timeout the rest go straight to a batched OSV query.
- A Cloudflare 524 (origin timeout) from the model gateway failed the whole turn; it is now retried like 502 / 503.
- Once "password" appeared anywhere in a file, an `md5(...)` used for a cache tag in the same file was reported as weak password hashing; the password now has to appear near the call, and comments and YAML no longer count.

### Improved

- "Read files with read_file and search code with grep_code" used to be only a line in the tool description and was never enforced (in E2E runs, `nl -ba` was used 37 times to read files and `grep -rn` 34 times to search code); run_command now actually redirects these, while logs, piped processing, counting, git and other legitimate uses still go through. Sub-agents can now use grep_code too.
- Audit results now include concrete next steps: which verification methodology to read for each high-risk finding (down to the topic number), whether a large repository should use a parallel workflow, and which skipped checks belong in Not covered; the methodology library is now triggered when confirming suspicious findings, not only during penetration tests — in E2E runs the methodology library and workflows had never been used.
- Trivy uses its local vulnerability database for 7 days instead of updating over the network on every acceptance (measured in China: from a 2–5 minute stall down to 1.5 seconds); Java dependencies are resolved offline, so an unreachable Maven Central no longer fails the whole run, and the report notes that transitive dependencies may not be fully expanded.
- Less noise from Trivy configuration results: dev containers (`.devcontainer/`) and CI configuration are excluded from delivery acceptance, and medium/low K8s hardening suggestions are shown as tips; only high-risk ones (such as running as root) must be fixed.
- AI acceptance discipline: static acceptance does not require a successful build; build commands such as mvn / npm install run only when the user asks, always with a time limit, and a timeout is recorded as "build not verified" before moving on instead of repeatedly sleeping on dependency downloads (spring-petclinic waited 17 minutes).

## [0.21.1] - 2026-11-18

### Fixed

- In Python projects with Windows (CRLF) line endings, tracking of "this variable came from the request" broke, so path traversal and SSRF were silently missed; the Python rules, guard recognition and Django route parsing added in 0.21.0 now normalize line endings before analysis (caught on GitHub CI's Windows runner).

## [0.21.0] - 2026-11-18

The Python accuracy release: Django projects can be fully audited for the first time, and Python security checks move from "Bandit only" to dedicated rules plus graded Bandit results. It also fixes several places in context compaction, the task ledger and the edit tool that failed silently.

### Added

- **Django / DRF route support**: `urls.py` is resolved to views (including `include` prefixes, `router.register` ViewSets and `from .views import *`), so Django projects no longer get "framework not supported" for auth coverage, webhook verification and IDOR.
- Flask `add_url_rule` / `MethodView` class views and aiohttp route tables are parsed; Tornado, Sanic, Bottle, Falcon and Pyramid are now reported explicitly as "not covered" instead of looking checked.
- **Python security rules**: path traversal, server-side template injection, SSRF, open redirect, reflected XSS, wide-open CORS in Flask/Django/FastAPI, `ALLOWED_HOSTS=['*']`, cookies with Secure/HttpOnly turned off, and JWT decoding without signature checks or with the `none` algorithm.
- Project-specific auth is recognized: custom decorators such as `@token_required`, FastAPI `Annotated` dependency aliases such as `user: CurrentUser`, DRF `@permission_classes`, and inline `if request.user.is_authenticated` checks at the top of a view.
- Python lockfile dependency audit: `uv.lock` / `poetry.lock` / `Pipfile.lock` are checked against OSV directly, and a pip-audit timeout falls back to OSV.
- Python projects now get readability (Q4), static performance (Q5), tests (Q1, via pytest) and AI-call checks (A2-A4) instead of a blanket "only JS/TS is parsed".
- Python accuracy benchmark: 7 labelled Flask/Django/FastAPI projects under `tests/benchmark/python/`; `node scripts/bench-py.mjs` reports detection rate and false positives so rule changes can be measured.

### Fixed

- **`/compact` reported success but the next turn was not actually shorter**: the history sent by the UI carries no timestamps, so nothing could be recognized as already summarized and everything was kept. It is now trimmed by matching message text; measured input for the same kind of question dropped from 18,049 to 12,684 tokens.
- `/compact` always ended in "operation aborted" on long sessions because every summary request shared one 30-second budget; each request now has its own timeout.
- Cross-turn memory permanently lost round 1, session and round summaries were injected twice, and summary truncation always cut the "next step" section first.
- The task ledger was nearly empty with no line numbers and duplicated rounds on retry; failed edits were logged as edits and are now logged as failures with the reason.
- Searching inside a single file returned no results, and searching inside the FinalCheck repo itself errored out.
- `edit_file` could not edit files with Windows (CRLF) line endings, forcing the model to fall back to scripts.
- Commands containing `"\r\n"` or `"\t"` were rejected as "paths outside the project".
- Python dependency audit counted pip-audit crashes, skipped packages and partial checks as "audited", treated single-quoted pyproject dependencies as "no dependencies", and treated a Bandit run that errored midway as a complete scan; all of these are now reported as coverage gaps.
- The IDOR check treated "logged in" as "ownership checked" (missing the most common FastAPI IDOR), and no longer flags endpoints that touch no data, public-content queries or webhooks.
- Webhook signature checking treated every Python route as public and flagged handlers even when they verified an HMAC.
- `publicRoutes` in `finalcheck.config.json` had no effect on Python routes.
- Settings: sandbox mode cards were unreadable in three columns and Chinese leaked into the English UI; the page now states what the sandbox really blocks, and the default project directory is cleaned up.

### Improved

- Bandit results are graded by Bandit's own severity and confidence: reminders such as `assert` or "imports subprocess" are listed but no longer count toward the verdict, and a line reported by both a FinalCheck rule and Bandit is merged into one finding.
- `md5(..., usedforsecurity=False)` used for ETags is no longer flagged as password hashing, and `app.config["SECRET_KEY"] = "..."` is recognized as a hardcoded secret.
- Measured: detection on the labelled benchmark went from 63.9% to 100% and false positives on safe look-alikes from 2/28 to 0/49; the "no login guard" false positives in PyGoat's main app are essentially gone. The last blind set, run before any tuning, scored 55.6%, so unfamiliar code patterns can still be missed — the benchmark is how this keeps improving.

## [0.20.0] - 2026-11-17

### Improved

- Context compaction rebuilt: it used to replace a file's contents with a one-line "cleared" note after only 5 further steps, so the model forgot what it had just read and re-read the same 20 files 808 times in one turn. It now triggers on the context budget (979k of a 1M window instead of cutting at 40%), and cleared results become index lines such as `[index] read_file src/audit.mjs (~1500 tok)`, so the model still knows which files it looked at.
- Added the cross-turn memory that simply did not exist: after a turn ended the model had no idea what the previous turn had read, because tool results never enter history. Now every turn writes a six-section summary (verbatim user request / technical decisions / files and line numbers / errors and fixes / todos / next step) which is injected at the start of the next turn. At most the last 10 rounds are kept verbatim plus one merged "earlier" summary, so the library stays a constant size no matter how many times you compact.
- Program ledger, not model recall: file reads/writes and command failures are recorded deterministically in `<project>/.finalcheck/ledger.md` with line numbers taken from real tool output, so they cannot drift. Only the last few round headers are injected; the full text is read on demand.
- The user's final request is never lost: it always survives compaction, and a "[current task]" line restating it verbatim is appended last so it cannot be buried by summaries or tool output.
- `/compact` no longer latches: one manual compaction used to pin the session to "summary + last 6 messages" forever, with history never growing again. Messages added after a compaction now accumulate normally.

### Fixed

- The ACL sandbox is now off by default and everything runs on Git Bash (one shell, one syntax). Measured reason: the sandbox restricts writes only and does not block reads at all (`type` on a file outside the workspace returned its contents), and it only covered the cmd half of the command set - the commands that actually write (`ls`/`rm`/`node`/`npm`) always ran on the host unprotected.
- Turning the sandbox off must not take two other guards with it: setting the mode to `off` used to disable the project boundary AND the delete-target check. They are now independent switches and all three guards (sensitive paths / project boundary / delete targets) apply unconditionally.
- Real delete gaps closed: `rm`/`unlink`/`shred` were never recognised as delete commands (and after the sandbox goes away they are the primary way to delete), and `dd`/`mkfs`/block-device writes had no rules at all. Also fixed a false positive: `rm -rf ./node_modules` used to be blocked; relative targets are now allowed and absolute ones rejected.
- Cross-directory work now works, but only when you say so: only directories you literally name in this turn's message are authorised (plus projects already in your project list); the model may not decide a directory is "related". Memory (AGENTS.md) goes into the project being edited, and so does the ledger, with a cross-reference line left in the current project.
- Fixed the root cause of `D:\finalcheck` turning into a dumping ground: passing a code fragment as a filename really created files named `ids.indexOf(v)!`. Filenames are now validated before writing (illegal characters / Windows reserved names / length / code-fragment patterns).

## [0.19.3] - 2026-11-17

### Fixed

- Commands now actually use Git Bash: measuring a real session's 14 commands found 0 bash-only and 9 cmd-only, so the "install it and bash works" headline had never actually fired. The model didn't know there are two paths - bash tools (`ls`/`grep`/`cat`/`find`/`rm`) run on Git Bash, cmd tools (`dir`/`type`/`findstr`) go into the ACL sandbox where the shell can only be cmd. The tool description now spells out both, with valid syntax for each.
- Fixed three commands that exist in cmd but mean something different: `find`/`sort`/`which`/`uname` used to be routed into cmd, where `find.exe` is a text search and `sort.exe` sorts characters - producing results that look fine but are wrong. They now go to Git Bash.
- Corrected a misleading message: when S7 cannot parse any route it used to say "target route files are all unreadable", but the real meaning is "no route definitions were parsed" (e.g. a Python project's `@app.get` is not recognised). It is not a permissions problem - don't go chasing paths.

## [0.19.2] - 2026-11-16

### Fixed

- Long tasks no longer forget what they just read: every step used to replace earlier file contents with a one-line "cleared" note, so by the time the model needed the content it could no longer see it and re-read the same files over and over (measured: 808 tool calls across only 20 files, 97% of them redundant). It now decides by context budget - keep everything while there is plenty of room, clear only when genuinely close to full.
- Small context windows no longer compact on every request: when the window was configured small, the thresholds came out negative, meaning "always over budget", so every request wiped the context and the model could see nothing. Thresholds can no longer go negative.
- Real releases (0.16.1 and earlier) were never affected: this per-step clearing was added to main on 2026-11-14 and never reached any tagged release; the local 0.17-0.19 test builds were the ones hitting it.

## [0.19.1] - 2026-11-16

### Fixed

- The bundled Git was never actually used: the packaged lookup path had an extra `resources` segment, so a machine without Git always fell back to cmd (0.19.0's headline feature did nothing in practice). Fixed - a clean machine now really runs on the bundled Git.
- Home-directory paths can no longer bypass the check: `~`, `$HOME`, `${HOME}` and `%USERPROFILE%` are expanded to a real path before judging. After the switch to Git Bash, `rm -rf ~/.ssh` and `cat ~/.ssh/id_rsa` used to be allowed (cmd never expanded `~`, so this hole only became dangerous once bash took over).
- Fixed the collateral damage of the fix above: the `~` inside Windows 8.3 short names (e.g. `RUNNER~1`) was treated as a home directory, which rejected deleting files inside the project.

## [0.19.0] - 2026-11-16

### Improved

- The installer now ships a complete Git, so `git` and `bash` work right after install: previously we only detected a user-installed Git and fell back to cmd when it was missing (which made bash-style commands fail). The installer now bundles the full Git for Windows (~400MB), so machines without Git can still use `git clone`, `git status`, `cat`, `grep -rn` and `2>/dev/null`.
- Priority is unchanged: a user-installed Git wins; the bundled one is only a fallback.
- Installer size grows from 112MB to roughly 235MB (about 824MB on disk after install, of which 410MB is Git itself) in exchange for zero-dependency, out-of-the-box behavior.

### Fixed

- Commands can no longer read files outside the project: literal paths in a command now pass two gates - sensitive paths (`~/.ssh`, private-key filenames, `*.pem`, and others) are rejected unconditionally, and paths outside the project reject the whole command with the reason returned to the AI.
- Home-directory spellings can no longer bypass the check: `~`, `$HOME`, `${HOME}` and `%USERPROFILE%` are expanded to a real absolute path before judging. After the switch to bash, `rm -rf ~/.ssh` and `cat ~/.ssh/id_rsa` used to be allowed (cmd never expanded `~`, so this hole only became dangerous once bash took over).
- The settings page states the sandbox's real boundary: a new notice explains the sandbox is "write protection + workspace boundary", NOT read isolation, and that paths assembled at runtime by a program (env-var concatenation, paths built inside a script) still cannot be intercepted - use a container or WSL for sensitive code.

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
