# Changelog

All notable changes to this project. **Newest entries go on top.**

## Unreleased

- Make the Tern install and HUD terminal tests run on Windows ([#46](https://github.com/oh-my-omp/omp-unified-exec/issues/46)): the install fixture uses the system temp directory and a CLI compiled once with `bun build --compile` (`tern.exe` on Windows) instead of a shebang script under `/tmp`; the HUD page-input test drives a raw-mode Bun stdin echo program instead of `/bin/sh` + `stty` + `cat`. Assertions are unchanged.
- Require a Bun host with `Bun.Terminal` at the omp extension factory before loading omp modules or registering tools ([#71](https://github.com/oh-my-omp/omp-unified-exec/issues/71)). Remove the Node PTY backend and optional native dependency, run the full suite with Bun's native test runner, and use Bun on Linux/macOS/Windows CI and for pre-publish checks while retaining npm OIDC publishing; CI runs the source and compiled PTY fixtures before the full suite so a suite failure cannot skip them. The shutdown-race regression accepts the documented unconfirmed-exit result, since Bun.Terminal on Windows reported the taskkilled child's exit after shutdown's wait. Current backend, admission and test documentation is updated in both languages; historical entries remain unchanged.
- Support only omp ([#70](https://github.com/oh-my-omp/omp-unified-exec/issues/70)): reject non-omp hosts at the extension factory before registering tools, publish the `omp` extension manifest, and keep omp-native bash presentation and the Tern HUD. Remove Pi-only renderers, script presentation wrapping, CLI/TUI qualification and support claims, the Pi qualification records in IV-0001/IV-0002 and the Pi 0.73 compatibility audit `to_improve.md`; tool-core tests activate through the named `activate` seam.
- Fix an `exec_command` caught inside its 150 ms start-up grace by `session_shutdown` ([#66](https://github.com/oh-my-omp/omp-unified-exec/issues/66)): it was inserted into the already-drained session store once the grace ended, returned a `session_id`, and its SIGKILLed session surfaced in `list_sessions` after the next `session_start`. Shutdown now takes ownership of pending sessions; the call waits for the shutdown to end the process and returns that exit without a `session_id`, or `running: true` with `exit not confirmed` if the process outlives the SIGKILL wait. README (both languages) describes the case.
- Merge upstream through v0.13.1 with the `ours` strategy: upstream's steer gate (early end of attached waits on a Pi human steer) is not adopted, because omp extensions receive no steering signal and empty polls are being replaced by `read term://` and `monitor`. `fork-features/README` (both languages) records the decision under the expected sync conflicts.
- Fix an in-flight `exec_command` failing with `terminal screen observed after release` (and an unhandled rejection) when `session_shutdown` released its live terminal before the child died: a session now gives up its screen when released, and a collect that finds no screen while the process is still dying returns empty output with the process reported as still running. README, README.zh-CN and IV-0002 now state that instead of promising an exit result, and IV-0002's noisy-kill regression description matches the current screen-bounded assertions. Windows tests that assumed sub-second exit reporting now wait for the observed exit or the failed send; node-pty on Windows reports output closure and exit about 1 s after the process ends (documented in README and IV-0001), so the final-output-merges-into-End monitor test runs on POSIX only. The noisy-kill log check counts logged lines by content, since ConPTY prefixes the first lines with its own control sequences.
- `exec_command` always runs in a PTY ([#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)). The `tty` parameter and the pipe backend are gone, together with everything that only existed to tell the two apart: the head/tail drain buffer and `omitted_bytes`, pipe draining in `collect`, the `"stream"` result kind, pipe monitor line decoding and its streaming sanitizer, and `tty` in results, listings and renderers. Results are always the rendered screen; a call with no PTY backend fails at call time with the load reason. Missing shell binaries or workdirs are checked before spawning and fail with `ENOENT` instead of a silent exit. A shutdown that discards a session's unfinished terminal during exec_command's start-up grace no longer makes the call fail with `unknown_terminal`; it returns empty output.
- The host's built-in `bash` stays active; `--keep-builtin-bash` and the removal at `session_start` are deleted. Tool text sets the split: short one-shot commands go to `bash`; `exec_command` is for long-running, interactive, concurrent and dev-daemon work, with no command deadline and no restart, observed through `monitor` and `term://`. `write_stdin` writes bytes verbatim and appends nothing. PowerShell no longer gets `-NonInteractive`, which would block prompts in a PTY. The Tern HUD counts every session.
- Fix pipe monitor bounds to apply after streaming control sanitation: long SGR prefixes no longer hide short visible matches, OSC/DCS payload newlines cannot escape into matching, and UTF-8/control states survive chunk boundaries. Batch and stream sanitation share one scanner without changing the batch fast path. Cancelled/replaced monitors now physically remove source-close listeners instead of retaining abandoned gate promises until process exit.
- Add future-only `monitor` subscriptions on omp with regex or completion-only conditions, 250 ms matched batches, a default ten successful returns, a 60-second excessive-results advisory and bounded sanitized lines. TTY monitoring tracks rendered logical row identities without consuming ordinary observations; pipe monitoring stream-decodes future lines. The completion coordinator owns subscription replacement/cancel/reset, merges End with ordinary wake, distinguishes model versus human/LRU termination, and exposes monitor state through `list_sessions`; empty polling and its dependency-gated migration remain unchanged.
- Add `read term://<key>/screen.png` on omp: the complete active grid is rendered from copied emulator cells, with ANSI/256/RGB colours, text attributes, wide glyphs and an outline Live cursor. Frozen screenshots preserve frozen appearance and omit the cursor. The host rasterizer and file-backed `read` pipeline supply images without install-script dependencies; each read creates a private temporary PNG, retained for OS cleanup like logs. Reload refreshes the same branded handler object without re-registering; upgrading an already-running text-only handler requires one restart.
- tty 会话的默认终端尺寸从 120×30 改为 120×80。仅默认行数改变；显式 `cols`/`rows`、`[20,500]` / `[5,300]` 限制以及 240000 单元格历史预算保持不变，并同步更新工具说明与 README 示例。
- Add process-unique `term://` resources on omp: non-consuming retained physical rows, active screens, positive/negative screen pages and existing `read` head/tail selectors. Sessions freeze copied rows, active styled cells, geometry, cursor and appearance after output closure and parsing; resources survive exit, confirmed kill, LRU removal and reload until process exit. TTY results and session listings expose `terminal_url`.
- Completed tty results now return only the frozen final active screen, including unchanged screens and confirmed kills, with `terminal_url` and final `terminal.retained_rows` / `rows` / `history_may_be_truncated`. Running observations and pipe results retain their existing behavior; earlier retained rows remain readable through `term://`.

## 0.14.7 - 2026-10-13

- Bump the package, tracked npm lock metadata and bundled Tern plugin to 0.14.7, releasing the native HUD fixes and awaited normal-copy installation update below.
- Synchronize the bundled Tern plugin inside the awaited omp extension factory, which runs during normal install/force-reinstall validation as well as ordinary loading. Use Tern's normal copy installer, automatically migrate the known old `.path` registration through official unlink/install, and remove session-start installation, developer linking and installation toasts. A current exact copy is unchanged; absent Tern leaves non-Tern usage available, while a present Tern synchronization failure rejects installation/loading instead of reporting success.
- Installation regression gate: `npm test` passes strict types and 492 tests (0 failures, 5 individual skips; unavailable Node PTY suites separately). The opt-in real omp force-install test passes 1/1, exercising same-version asset updates, unchanged current-copy identity and package/lock rollback on Tern failure before any session; mandatory Bun real-PTY HUD/presentation tests pass 54/54.
- Verified the full production package with real omp 18.10.3 and Tern 0.8.3 before any interactive session: missing and same-version stale copies, identical-CSS legacy-link migration, identity-preserving repeated force install, unknown-registration failure with package/lock byte rollback and no unlink, and installation without Tern. All six cases used normal `omp plugin install URL --force` in isolated state; no manual Tern update was the behavior trigger.

- Make the Tern terminal counter use native `omp.hud` row styling across Reader, Spine and Console and color themes. The CSS-only plugin keeps the shared belowEditor container above omp's counter, but removes its extra margin, padding, background and shadow so Spine does not add a second inset or plate; co-located widgets share this move/reset, while native roles own the pills' appearance. Remove the outer ✕ and its dismiss-until-new-tty state; stored tty sessions remain counted until removed, and the Terminals sheet/page retain Kill.
- Verified in real Tern 0.8.3 / omp 18.10.3: light/dark themes, Reader/Spine/Console at 1280×800 and 700×800, genuine Spine pane blur, hover, Close/Esc, list Kill and terminal-page echo/Kill, immediate new-tty remount, and eight no-tty/plugin-free comparisons with real working/todo HUD rows. Counter row/pill right-edge differences were 0px; composer/meter/working/todo geometry was unchanged with no tty. `npm test`: 456 pass, 0 fail, 4 individual skips (Node PTY suites unavailable separately); mandatory Bun real-PTY tests: 54 pass, 0 fail, no skips.

- Rewrite `README.md` for the fork: install through omp, the Tern terminal HUD and its auto-installed plugin, omp presentation, OSC 10/11 answers and the fork's layout lead; the tool reference keeps upstream's semantics in condensed form. Upstream's npm badges, install commands and maintenance notice are gone. A Chinese translation, `README.zh-CN.md`, mirrors it section for section, and each links the other. `fork-features/README.md` records both as fork-owned and how to resolve them on upstream syncs.

## 0.14.6 - 2026-10-12

- Bump the package and the Tern plugin (`fork-features/tern-plugin/plugin.toml`) to 0.14.6. The plugin's stylesheet now also sets the Terminals sheet's output preview in the mono face.
- omp now installs the package's Tern plugin itself. At the first interactive session inside a Tern pane (`TERN_PANE_SOCKET` and a numeric `TERN_PANE`, the test omp uses), the extension asks Tern with `tern plugin list --json` whether it runs the plugin's current version and stylesheet; if not, it runs `tern plugin link` on the package's `fork-features/tern-plugin` (removing an installed copy that blocks the link), and the daemon reloads its plugins. An install or update shows a toast; a failure (no `tern` on PATH, a CLI error) shows a warning with the manual `tern plugin link` command; outside Tern, or when Tern is already current, nothing runs or shows. The manual `tern plugin link` step is no longer needed.
- tty sessions now answer OSC 10/11 default-colour queries, which the emulator left unanswered. Programs that pick a light or dark palette from the reply, such as omp run in a tty session, fell back to their dark palette and drew black message and thinking blocks on Tern's light page. On omp the answer follows omp's own theme (light or dark, which in Tern follows Tern's appearance); on Pi it stays dark, as omp's Console answers.

## 0.14.5 - 2026-10-11

- Tern terminal HUD's panel now scrolls back through the terminal's history instead of only the current screen. Each model observation used to erase the emulator's history (ED3) to line up the next one, so the panel had nothing to scroll; observations now mark the screen's top row with an xterm marker instead, and the HUD shows the retained history plus the current screen. Model results are unchanged, and `history_may_be_truncated` is now reported only when unreported rows were actually evicted.
- The HUD's pill is now a copy of omp 18.10's running-work counter (a terminal icon and the session count, the words in its hover label) on its own line just above omp's counter; its ✕ still hides the HUD until a new tty session starts. Clicking it opens the Terminals sheet, built like omp's Agents sheet: the tty sessions with status dots and Size / PID / Time columns, and the selected session as the Agents-style preview (command and state, session, directory, PID, size, start time, the log path linked on one line, and its newest output rows); ↑/↓ or a click picks one, `x` / Kill ends it the way `kill_session` does, Esc / Close leaves. Enter / Open shows the session as a full-pane terminal page, built like omp's Console: the session's history and screen at its full width filling the page above its action bar, following new output, with typed keys sent to the session, Kill, and Esc / Back to return to the list. The non-modal panel with tabs is gone. An omp extension cannot add to omp's pill line, so the package ships a CSS-only Tern plugin (`fork-features/tern-plugin/`) that moves the HUD's row to the front of omp's dock and sets the preview's output rows in the mono face (Tern draws a preview's code block in the UI face, which misaligned columns); install it once with `tern plugin link ~/.omp/plugins/node_modules/omp-unified-exec/fork-features/tern-plugin`. omp's own rows are untouched: with the HUD hidden the dock is identical to one without the plugin, measured during a running turn with todos and a background agent. Without the plugin the pill sits below the composer and the output rows are unaligned.

## 0.14.4 - 2026-10-11

- Tern terminal HUD follows the owner's choices again ([#25](https://github.com/mouriya-s-lab/omp-unified-exec/issues/25)). The panel is no longer full-width: it is as wide as the widest session's screen (capped at the pane), measured in terminal cells so a 120- or 170-column screen no longer wraps, and a short 80-column session gets a narrow panel. The tab strip is back (one tab per session), and every screen is colored `ansi` that scrolls inside itself and follows its newest row; wide screens are no longer cropped into an uncolored grid. The screen is clamped to the height the panel reserves for it, so screens with CJK text no longer push the panel into scrolling itself, and the panel has its own ✕.
- The chip moved from the pane's top-left to its bottom-left, beside the composer (top-left only on panes too narrow to hold it there without covering the composer), and gained a ✕ that hides the HUD until a new tty session starts. omp's activity line, todo HUD, meter and composer keep their positions.

## 0.14.3 - 2026-10-11

- Tern terminal HUD no longer disturbs omp's dock ([#21](https://github.com/mouriya-s-lab/omp-unified-exec/issues/21)). Its pill was a dock row above the composer: it pushed omp's working timer and todo HUD up by 36px and overlapped the context meter. The widget now sits below the editor and describes only an overlay chip at the pane's top-left, so the activity line, todo HUD, meter and composer keep their native positions (measured against a widget-free baseline with a running turn and todos).
- Clicking the chip opens the Terminals sheet, built like omp's Background jobs sheet ([#23](https://github.com/mouriya-s-lab/omp-unified-exec/issues/23)): a centred sheet with the session list, the selected session's status and current screen, and Close (Esc). Click or ↑/↓ selects a session; its screen starts at the newest row instead of inheriting the previous session's scroll. The sheet is `lg` while every screen fits 88 columns, else full-width, and never scrolls itself: a fitting screen scrolls inside itself, a wider one shows its newest rows in a sideways-scrolling grid. Esc closes the sheet without stopping the running turn. The tab strip and the hand-sized panel are gone.
- Tests cover the overlay-only chip, the sheet's list, per-session detail keys, size choice, line budgets, wide-screen cropping and the chip opening a custom overlay.

## 0.14.2 - 2026-10-11

- Tern terminal HUD: the terminal scrolls, not the panel ([#21](https://github.com/mouriya-s-lab/omp-unified-exec/issues/21)). Every session card showed its full screen, so a 30–40 row screen overflowed the panel's 60% height and the whole panel scrolled while the screen itself could not. The panel now shows one session at a time, picked from a tab strip, and a screen that fits the panel width is bounded to the panel's line budget (from omp's terminal rows): it scrolls inside itself and follows the newest row, and the panel never scrolls. A screen wider than the panel still scrolls sideways; Tern's plain-text grid has no vertical scroll of its own, so such a screen taller than the budget scrolls with the panel.

## 0.14.1 - 2026-10-11

- Fix the Tern terminal HUD scrambling wide screens ([#19](https://github.com/mouriya-s-lab/omp-unified-exec/issues/19)). The panel's 720px card held about 95 columns, and Tern's `ansi` node reflows at its width, so a 120–140 column screen broke its box lines and turned full-width background rows into stripes. The panel now spans the pane width (top 60%, so the pill and composer stay usable). A screen that fits draws as a colored grid that never wraps; a wider one draws as an unwrapped plain-text grid that scrolls sideways, so nothing is cut off. The panel follows window width changes.

## 0.14.0 - 2026-10-11

- Tern terminal HUD on omp ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). While omp renders natively in Tern and a tty session exists, a pill above the composer counts tty sessions. Clicking it opens a non-modal panel floating above the pill with one collapsible card per session: `#id`, command, running/exit state and the current screen in color, updated as output arrives without any tool call. The panel is read-only; omp's ANSI TUI, Pi hosts and model-visible results (still plain text) are unchanged.
- `TerminalScreen.styledScreen()` re-encodes the current screen as SGR from cell attributes (no child bytes pass through) and `onChange()` reports parsed output; `ExecSession` exposes both for tty sessions. `SessionStore.subscribe()` reports membership changes. On omp, `@oh-my-pi/pi-tui/native/state` is now required alongside the bash renderer.

## 0.13.1 - 2026-10-10

- `tty: true` works again under Node 25 and 26. The optional `@homebridge/node-pty-prebuilt-multiarch` was pinned to `0.13.1`, which declares `node <25`. On newer Node, npm silently skips it, so every Node-hosted tty call failed with `tty: true is unavailable`. It now takes `^0.14.1` (`node >=20 <27`). Bun hosts are unaffected.

## 0.13.0 - 2026-10-10

- tty sessions now return what a terminal shows ([#13](https://github.com/mouriya-s-lab/omp-unified-exec/issues/13)). Previously PTY output was the raw stream with control sequences stripped, so carriage-return progress bars, cursor-up redraws, clear-screen redraws and full-screen programs piled every frame on top of the last. Each tty session now feeds its output, in order, into a per-session `@xterm/headless` terminal of its `cols`×`rows`. Each result returns the lines that scrolled off since the last call and were not already reported, then the full current screen and the cursor position (`terminal: normal|alternate screen CxR, cursor row R col C`, plus `history_lines`). An unchanged screen reports `screen_changed: false` with no output. The emulator answers terminal queries (cursor position, device attributes) on the child's input. Only plain text and the cursor are represented; styling and the exact raw stream stay in `log_path`. Pipe sessions are unchanged.
- `details.terminal` and codemode `structuredContent.terminal` carry the screen, size, cursor, `screen_changed`, `history_lines` and `history_may_be_truncated`. tty history between calls is bounded by `TERMINAL_HISTORY_CELLS` (240000 cells / `cols` rows). Reaching it sets `history_may_be_truncated`, and script `truncated` becomes true.
- tty observations are serialized per session. A cancelled empty poll does not consume anything. Streaming updates show the current screen without consuming it. Emulators are released when a session leaves the store, is evicted, shut down, or never registered.

## 0.12.4 - 2026-10-10

- Fix unified-exec tool rows on oh-my-pi (omp) ([#11](https://github.com/mouriya-s-lab/omp-unified-exec/issues/11)). omp passes extension renderers different arguments than Pi, so the Pi renderers threw on every repaint (`Tool renderer failed … state.startedAt`). omp then showed its generic card, with an argument dump and the whole model envelope (`chunk_id`, `original_token_count`, …). Tern's native views got no `describeCall`/`describeResult` at all.
- On omp, `exec_command` now renders like omp's built-in bash tool, using omp's own bash renderer (`@oh-my-pi/pi-tui/tools`): `$ cmd` with output, the exit code and error tone on failure, `Backgrounded: session N` for yielded sessions, and the truncation marker with the full log path as the last line. `[failure: …]` and `[signal: …]` lines appear when present. `write_stdin` and `kill_session` show their action as a bash comment (`# poll session N`, `# stdin → session N: "…"`, `# kill session N (SIGTERM)`) above the same output view. `set_on_exit` and `list_sessions` use omp's default card. Model-visible content, details and script results are unchanged.
- omp is detected by its injected `ExtensionAPI.arktype`. If omp's bash renderer is missing or changed shape, plugin loading fails instead of re-registering renderers omp cannot call. Pi hosts activate synchronously with unchanged renderers.

## 0.12.3 - 2026-10-10

- Use Bun 1.4's native `Bun.Terminal` backend whenever the host is Bun, including compiled executables; keep `@homebridge/node-pty-prebuilt-multiarch` as the lazy Node-only fallback. Process exit and terminal-stream closure are tracked independently, with the terminal's EOF callback authoritative for completion so every byte Bun delivers before closure reaches the session. Data and exit callbacks that fire before `Bun.spawn()` returns are replayed after the caller subscribes.
- Add a dependency-free Bun runtime fixture covering PTY input/output, initial geometry, argument quoting, shell execution, rapid and normal exit, kill, and POSIX process-group termination. Bun PTY termination now signals the whole POSIX process group instead of only the direct shell, matching the existing `SpawnedChild.kill()` contract. CI runs the fixture from source and from `bun build --compile` executables on macOS, Linux, and Windows; the existing Node 22/24 matrix continues to exercise the native package backend.

- Pin Pi-family development dependencies and locks to 1.0.0, retaining >=0.99.1 peers. Production code and package version are unchanged.
- Assert Pi's native codemode documentation reference instead of the retired inline model declaration. Add wrapped/native generated-image and model-usage parity plus unknown-member fail-fast tests with no live models.
- macOS strict types, `EXPECT_PTY=1 npm test` with 348 passes and three Windows-only skips, and all 21 isolated real-tmux cases pass. No npm publication or installed-package replacement.

## Pi 0.99.2 qualification - 2026-10-01

- Pin Pi-family development dependencies and locks to 0.99.2. Keep runtime peers at >=0.99.1; no newly required production API.
- macOS strict types, EXPECT_PTY=1 npm test with 345 passes and three Windows-only skips, and all 21 real-tmux cases pass. Package dry-run includes the renderer; no live model traffic or publication.
- Update renderer and tmux assertions for Pi 0.99.2's native visual-line previews and Container cache. Preserve the whole-result ten-row cap for many nested summaries.
- Configure extended keys only on the isolated test tmux server to keep host startup warnings out of measured tool rows. Production rendering and execution are unchanged.

## 0.12.2 - 2026-09-30

- Remove Pi's replacement warning for everyone. 0.12.1 registered `codemode` during extension loading, so Pi skipped `builtin:codemode` and told every user of this package to disable it. The compact codemode replacement now registers at the first `session_start`, following Pi's `dynamic-tools.ts` pattern. Pi keeps the built-in loaded, and its tool registry uses the first extension in load order, where configured packages precede built-ins. The fix stays default-on with no settings; the built-in becomes the automatic fallback when it is off or fails.
- Verify precedence at session start through `pi.getAllTools()` source info. If another extension's codemode wins, warn instead of silently claiming the fix is active.
- A missing native codemode result renderer no longer throws from the extension factory, which would have unloaded all five exec tools. The package registers native codemode unchanged and warns at session start.
- Legacy `-builtin:codemode` exclusion from 0.12.1: Pi resolves `defaultTools` before session start and drops the then-unknown `codemode`. When no built-in codemode was shadowed, apply the last `defaultTools` entry naming codemode and activate it. Declarations match native apart from codemode's position. The exclusion is no longer recommended.
- `PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` remains the only opt-out.
- Tests: session-start registration and idempotence, precedence-loss warning, `defaultTools` rule and legacy activation. Actual-CLI parity now covers the default (built-in enabled) and legacy exclusion; real-tmux cases assert no replacement warning in any configuration and clip with the built-in enabled.
- Validation on Linux / Node 24 / Pi 0.99.1: strict types, `EXPECT_PTY=1 npm test` and all 21 real-tmux cases pass. No live model traffic.

## 0.12.1 - 2026-09-30

- Fix collapsed codemode output flooding by default. Reuse Pi's public `createCodemodeExtension()` factory and wrap only `renderResult`: cap the result text component at ten **visual rows** after wrapping, including nested-call summaries, spacers and footer. This also bounds `text(r)` and `text({ i, ...settled })`, not just `text(r.output)`.
- Preserve native expanded output, small previews, call rendering, execution, typed results, settings/loadout, MCP activation and branch-local store/load. Unwrap the native cached component before delegation so streaming updates and expansion do not silently fall back to Pi's generic renderer.
- Keep a configured expansion hint and `Full output:` recovery footer visible when clipping. Use a non-numeric clipping hint because Pi's native logical-line preview has already hidden output. The cap is display-only, not a change to model-visible content or process output bounds.
- Add explicit opt-out `PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` for alternative codemode replacements. The fix does not enable codemode or edit settings; disable the duplicate `builtin:codemode` in `pi config` to silence Pi's replacement warning. Applies to all codemode nested tools while this package is loaded.
- Add permanent native-renderer, actual-CLI parity/default/opt-out/MCP and real-tmux A/B/C regressions; requalify the public factory, schema identity and renderer cache on Pi upgrades. No Pi core patch.
- Validation on Linux / Node 24 / Pi 0.99.1: strict types and 342 tests pass (three Windows-only skips); all 21 real-tmux cases pass. The eight new CLI parity cases and all TUI cases also pass against the installed bundled CLI. Production dependency audit reports zero vulnerabilities; package dry-run includes the renderer module. No live model traffic.

## 0.12.0 - 2026-09-29

- Give codemode scripts structured results. All five tools declare an `outputSchema` and return `structuredContent` (`src/script-result.ts`). Scripts receive `output` as a real multi-line string plus typed `exit_code`, `session_id`, `running`, `truncated` and `log_path`, instead of the whole text envelope. Previously, printing that string inside an object serialized its newlines, producing one logical line that Pi's five-line codemode preview could not bound (22 rows for 40 short lines at width 80).
- `structuredContent` derives only from the bounded, sanitized result details. Metadata strings are bounded and single-line. Model-visible `content`, persisted `details` and TUI rendering are unchanged.
- Add a prompt guideline: in codemode, print `r.output` rather than the whole result object.
- Require Pi and TUI 0.99.1 or newer (`outputSchema`/`structuredContent`); lock development dependencies to Pi/TUI 0.99.1 and TypeBox 1.3.27, matching Pi's resolved TypeBox.
- Add `tests/script-result.test.ts`: schema checks for exited, running, non-zero, signalled, truncated, control-sequence, killed, failed-kill and unknown-session results; checks on all five registered tools; and an offline actual Pi 0.99.1 codemode run that asserts the script receives an object with 40 real output lines and that Pi's collapsed codemode renderer stays within eight rows.

## 0.11.0 - 2026-09-23

- Remove the built-in 290-second ceiling for empty relative `write_stdin` polls. The default/minimum remains five seconds; initial exec and input-bearing calls retain their 30-second ceiling.
- Share one bounded, event-driven, monotonic wait path between relative empty polls and absolute deadlines. Long waits retain head/tail output in the session, rather than accumulating every chunk in a tool-local array. Output-driven updates replace the periodic heartbeat for empty polls.
- Preserve buffered output on cancelled empty polls and preserve completion observation/wake semantics. Use chunked timers for multi-day relative waits as well as absolute waits.
- Keep `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` as an optional relative-poll limit, now permitting values above 290 seconds. Unset means no cap; invalid explicit configuration fails instead of silently disabling the limit. Tool durations must be non-negative, finite and within JavaScript's safe millisecond range.
- Remove cache-TTL polling guidance. Pi owns best-effort warming independently; warming is neither required nor forced by this extension. Absolute deadlines and completion wakes remain human-explicit controls.
- Validation on macOS: strict types and 301 tests pass against Pi 0.86.1, with three Windows-only skips. The six offline actual-CLI warming cases also pass on Pi 0.87.1, plus two real tmux tests for rendering, Esc survival and shutdown cleanup. Package dry-run passes; no live provider traffic or npm publication.

## 0.10.0 - 2026-09-21

- Remove the remaining `setWidget` capability probe; current Pi supplies this API in every mode.
- Require Pi and TUI 0.86.1 or newer; lock development dependencies to 0.86.1.
- Register `agent_settled` directly and read only the registered `keep-builtin-bash` flag name. Remove pre-0.80.5 and dashed-name compatibility paths.
- Type streaming callbacks with Pi's `AgentToolUpdateCallback` and JSON-compatible process details. Remove callback casts without changing process ownership, output bounds, terminal safety or wake policy.
- Add permanent current-event and flag-name regressions. The workflow package's opt-in offline integration also exercises this checkout's real process termination and wake suppression during SDK child shutdown.

## Unreleased

### Changed

- Updated the exact Pi/TUI development baseline from 0.83.0 to 0.84.1,
  TypeBox from 1.1.24 to 1.3.7, and the test runner to `tsx` 4.23.12.
  Synchronized the lockfile root metadata with package version 0.9.1. Runtime
  source, peer compatibility, and npm runtime installation policy are
  unchanged.

### Validated

- Strict typecheck and the complete unit/integration suite pass against Pi
  0.84.1; package dry-run and the full npm audit also pass.

## 2026-08-12 — 0.9.1

### Fixed

- **Held-open sessions are now diagnosable instead of looking like a hang.**
  A command that backgrounded processes with inherited stdout/stderr — or a
  `cd … && cmd &` chain whose subshell keeps waiting — left the session
  `[still running]` indefinitely after the shell itself had exited, with no
  explanation (a live session misread this as an `exec_command` wrapper bug
  and wasted calls restarting the jobs). The shell's `exit` event is now
  tracked separately from the close-based session exit
  (`SpawnedChild.processExited` / `ExecSession.shellExited`); `exec_command`
  and `write_stdin` results in that state carry a `note` field ("shell has
  exited, but background process(es) still hold the output pipe…" with
  detach recipes), and the running-session widget / `list_sessions` mark
  such sessions `(shell exited, pipe held)`. Lifecycle semantics are
  unchanged: the session stays open, killable, and pollable — diagnosis
  only, never a forced pipe close or command rewrite. Tests: held-open
  suite (6 cases).

## 2026-08-04 — 0.9.0

### Fixed

- **`kill_session` output is now bounded before it reaches either the model or
  the TUI.** The tool previously appended its complete retained drain directly
  to `content` and `details.final_output`, bypassing the normal 50 KiB / 2000
  line cap (up to the 1 MiB in-memory retention) and Pi's collapse state. Kill
  results now use the same tail truncation, omission metadata, recovery marker,
  token/byte metrics, and `log_path` contract as exec/write results.
- **Every unified-exec tool now has an explicit call and result renderer.**
  `kill_session` and `list_sessions` no longer fall through to Pi's generic raw
  renderer. Kill output defaults to a five-visual-line tail; `list_sessions`
  defaults to five compact entries. Both honor `app.tools.expand`, use Pi's
  configured `keyHint`, and keep status/truncation/log evidence visible.
- **Child output is made terminal-inert before entering model content, result
  details, partial updates, or custom TUI rendering.** ANSI/VT mode changes,
  OSC clipboard/title writes, terminal strings, C0/C1 controls, SGR, and
  carriage returns are stripped; the exact raw byte stream remains available
  only in `log_path`. Renderers also sanitize legacy/raw details defensively,
  and model-visible metadata headers have independent scan/display caps.
- **Streaming output previews now refresh when partial output changes** at the
  same terminal width instead of reusing a stale visual-line cache.
- **Settled session inventories cache their rendered rows by terminal width**
  and bound command-preview scanning instead of re-sanitizing arbitrarily long
  command strings on every unrelated TUI redraw.
- **Session-list command previews are control-character sanitized** in the
  model-visible fallback text as well as the custom renderer.

### Changed

- Output-bearing details now carry explicit `operation`, `status`, and
  `running` fields. Kill identity is no longer mistaken for proof that a
  process remains alive.
- The undocumented kill-only `details.final_output` field was replaced by the
  canonical bounded `details.output`. No external consumer was found in a
  repository-wide/GitHub code search; the observable shape change is released
  as 0.9.0.
- Shared output bounding and model-text formatting moved from `src/index.ts` to
  `src/tool-result.ts`, with separate process and kill result types.
- Development pins moved from Pi/TUI 0.80.10 to 0.83.0 while the peer minimum
  remains `>=0.80.5`. Added canonical `npm run check` / `npm test` scripts and
  aligned CI with them. Removed package metadata's dead issues URL because the
  repository intentionally has issues disabled.

### Tests / docs

- Added pure result-contract, terminal-safety, and renderer tests for bounding,
  control-sequence stripping, collapse, expansion, re-collapse, kill failure,
  unknown ids, cache refresh, and session-list previews.
- Added a real delayed 4000-line regression: `exec_command` yields before the
  burst, `kill_session` drains it, the result stays bounded, and the complete
  stream remains in the log.
- Added `docs/IV-0002-output-lifecycle-and-rendering.md` with the three-layer
  capture/model/TUI contract, upstream issue evidence, reproduction procedure,
  and separate archive/ticker follow-up backlog. Updated README/developer
  guidance for bounded expansion and complete-log recovery.

## 2026-07-23 — 0.8.0

### Fixed

- **Silent data loss between polls is now visible to the model.** The 1 MiB
  `HeadTailBuffer` drops middle bytes when a chatty process outruns polling;
  previously the drained head+tail were spliced together with no trace. Now an
  omission marker (`[... N bytes omitted here ... full stream is in the
  session log file ...]`) is inserted at the exact drop point and the response
  carries `omitted_bytes`. (`drainSegments()` in `head-tail-buffer.ts`;
  `collectOutputUntilDeadline` returns `{ bytes, omittedBytes }`.)
- **Empty-poll cap error message** no longer hardcodes "290 seconds" — it
  interpolates the effective cap, which `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS`
  may have lowered.
- **Rolling TUI stream tail now trims a single oversized chunk.** A lone
  chunk larger than the 32 KiB window previously bypassed the trim loop and
  was shipped whole to the TUI every 250 ms tick.
- **Widget / slash-picker command labels are control-char sanitized**
  (`sanitizeMeta` in `oneLineCommand`) so ESC sequences can't reach the TUI.

### Added

- **`output_bytes_total`** in tool responses (cumulative bytes since spawn):
  two polls with identical totals = stalled process, no drain needed.
- **`cols` / `rows` params on `exec_command`** (tty only; clamped [20,500] /
  [5,300]; defaults 120×30) — PTY geometry was previously hardcoded.
- **`completion_delivery: "direct"` on exec_command's own exit paths** when
  `on_exit: "wake"` was requested but the process exited within the call —
  wake accounting is now auditable from the transcript alone (matches
  write_stdin's direct-delivery metadata).
- **`tool_time_utc` in `list_sessions`** (text trailer + details) so the
  model can compute `yield_until` deadlines without an extra call.
- **`[wake]` indicator in the `exec_command` call banner** (warning-colored)
  when `on_exit: "wake"` is passed — the "this may interrupt you later" flag
  is now visible at a glance. The widget, slash picker, and `list_sessions`
  text now use the same `[wake]` token (previously `⏰wake` / `wake`).

### Changed (internal refactors, no behavior change)

- `ExecSession.collect()` wraps the buffer/notify/gate plumbing — seven
  copy-pasted `collectOutputUntilDeadline({...})` call sites collapsed.
- `kill_session` / `session_shutdown` waits are event-driven
  (`waitForExitOrDeadline`) instead of 25–50 ms sleep-polling loops.
- Shared `buildStreamUpdate()` for the two streaming-details builders.
- Dead code removed: `SessionStore` id reservation (`reservedIds`,
  `releaseId` — write-only state; ids are monotonic and never reused),
  `ExecSession.snapshotState()`, `Notify.waiterCount`, `SpawnedChild.resize()`
  (never callable; PTY geometry is set at spawn via `cols`/`rows`).
- `pruneLru` uses one ascending sort instead of two.
- TUI typing: `ui.setWidget` called through its real type (runtime-guarded),
  and all `renderCall`/`renderResult` `as any` casts removed
  (`renderSetOnExitCall` accepts `on_exit?: unknown` because the
  Google-compatible `Type.Unsafe` enum's static type does not survive
  inference).
- `runExecCommand`'s grace-window `try` block re-indented; misc renames.

## 2026-07-23 — 0.7.4

### Changed

- **TUI `yield_until` label now shows both the ISO deadline and the human
  hint:** `until 2026-07-23T04:20:00Z · 49m later` instead of only the
  countdown. The ISO timestamp is the source of truth; the "later" part is a
  human-readable remaining-time hint. Unparseable timestamps still fall back
  to `until <raw>` with no hint (`formatUntilLabel` in `src/render.ts`).

## 2026-07-22 — Maintenance notice

- **README:** added a maintenance disclaimer — we don't have bandwidth to
  maintain this repo for the community; issues are disabled and external PRs
  are not accepted. Anyone wanting to improve it should fork (MIT license).
- **GitHub settings (via `gh`):** disabled issues, projects, and wiki;
  set interaction limits to `collaborators_only` (max GitHub allows:
  6 months, expires 2027-01-22 — needs re-applying after expiry, since
  GitHub does not support permanently disabling PRs on public repos).
- **CI:** new `.github/workflows/interaction-limit-reminder.yml` — weekly
  scheduled job that fails starting 7 days before the interaction-limit
  expiry (hardcoded `EXPIRES_AT`, since `GITHUB_TOKEN` can't read the
  interaction-limits API), reminding the owner to re-apply the limit and
  bump the date.

## 2026-07-22 — 0.7.3

### Fixed

- **Windows PowerShell hang under Node 24 CI:** `buildShellCommand` now
  passes `-NonInteractive -NoLogo` (with existing `-NoProfile -Command`) so
  short `shell: "powershell"` commands exit when stdin is kept open as a pipe
  for `write_stdin`. Fixes CI failure on `windows-latest` + Node 24 where
  `Write-Output` never finished within the yield window.

## 2026-07-22 — 0.7.2

### Fixed / improved (post-review top 5)

- **wake-e2e hygiene:** harnesses auto-`session_shutdown` in `afterEach`;
  async-aware `waitFor`; fewer fixed long sleeps around debounce.
- **`list_sessions` + widget + slash picker show `wake_armed` / `⏰wake`** so
  agents and humans can audit which sessions will auto-resume.
- **`set_on_exit` by coordinator id:** can disarm LRU tombstone wakes even when
  the session is no longer in the store; unknown ids still return `found: false`.
  Tool text notes disarm cannot recall an already-queued follow-up.
- **Cleanup:** `src/format-time.ts` unifies duration labels; removed unused
  `policy` field on completion records; `renderSetOnExitCall` for TUI.
- **Tests:** tombstone disarm unit test; unknown sid + list `wake_armed` e2e.
- **Docs refreshed:** README (`set_on_exit` tombstones/status tokens,
  `wake_armed`, TUI remaining + `set_on_exit` banner, architecture +
  `format-time.ts` + workspace docs), `docs/DEV.md` layout table, IV-0001
  implementation map.

## 2026-07-22 — 0.7.1

### Added

- **Agentic workspace docs:** `docs/DC-0001-agentic-workspace.md` (IV/DC
  doctrine) and `docs/IV-0001-long-wait-and-wake-control.md` (this release’s
  initiative: remaining-time TUI, human-explicit wait/wake guidance, horizon
  removal, `set_on_exit`, evidence).
- **`set_on_exit(session_id, on_exit)` tool.** Change a live session's
  completion policy without killing it: `"none"` disarms a pending wake
  (process keeps running); `"wake"` arms auto-resume if still running.
  Disarm after exit but before the debounced wake flush also suppresses the
  notification. Mid-flight flush re-checks suppression so a disarm cannot
  race a reserved send. Status tokens: `disarmed`, `already_none`, `armed`,
  `already_armed`, `too_late`.
- **TUI remaining countdown for `yield_until`.** Call banners and streaming
  footers show human remaining time (`2h40m later`, `12m later`, `45s later`,
  `now`) instead of only the raw ISO deadline. ISO stays in tool result
  metadata for the model. Shared helper: `formatRemainingLater` (now in
  `src/format-time.ts` as of 0.7.2; still re-exported from `time.ts`).

### Changed

- **Removed the default 10 h `yield_until` horizon.** Any valid RFC 3339 UTC
  future timestamp is accepted (past still = immediate poll). Dropped
  `PI_UNIFIED_EXEC_MAX_ABSOLUTE_WAIT_MS`, `DEFAULT_MAX_ABSOLUTE_WAIT_MS`, and
  `resolveMaxAbsoluteWaitMs`. Multi-day waits chunk `setTimeout` arms at
  `MAX_TIMER_ARM_MS` (`2^31-1`) so timers never overflow.
- **Tool guidance tightened against cache-busting and stale wakes.**
  - `yield_until`: only when the human explicitly asks for a long attached
    wait or wall-clock deadline — not to bypass the 290 s `yield_time_ms`
    cap; repeat ≤290 s polls instead.
  - `on_exit`: default remains `"none"`; use `"wake"` only when the human
    explicitly wants auto-resume; if armed by mistake, `set_on_exit … none`
    promptly. write_stdin no longer promotes wake.
- **Docs** (README) updated for `set_on_exit`, human-explicit wait/wake
  rules, no 10 h cap, and remaining-time TUI.

### Tests

- `formatRemainingLater` unit coverage; far-future `yield_until` accepted;
  long-wait multi-arm chunking; CompletionCoordinator `setOnExit` paths;
  wake-e2e: disarm failed job (0 wakes) and late-arm from `none` → 1 wake.

## 2026-07-21 — 0.7.0

### Added

- **`write_stdin(yield_until)` — absolute-deadline waits.** Empty polls can
  now stay attached until a strict RFC 3339 UTC deadline (`"2026-07-21T18:30:00Z"`,
  0–3 fractional digits, uppercase `Z` only; offsets, local timestamps, and
  JS-normalized impossible dates are rejected; accepted values are normalized
  with `Date.toISOString()`). Semantics: mutually exclusive with
  `yield_time_ms` and with input bytes; returns immediately on process exit;
  a past deadline is an immediate poll; cancellation never kills the child;
  default horizon 10 h with a new `PI_UNIFIED_EXEC_MAX_ABSOLUTE_WAIT_MS`
  override — excessive deadlines are rejected with an actionable error, never
  clamped. The wait is event-driven (exit / cancellation / one timer) on a
  **monotonic** deadline (wall-clock parsed once, then anchored to
  `performance.now()`), never drains output into an unbounded local
  collection (the session's bounded head/tail buffer, rolling TUI tail, and
  full on-disk log keep working), and replaces the 250 ms TUI heartbeat with
  an initial update + output-driven updates rate-limited to 30 s + a final
  update (nothing when nothing changes). Exit wins close exit/deadline/cancel
  races whenever the session is terminal when the result is assembled. New
  `src/time.ts` and `src/long-wait.ts`.
- **`exec_command(on_exit: "wake")` — completion notifications.** A new
  persistent per-session policy (default `"none"`, Google-compatible
  string-enum schema): when a backgrounded wake session exits while no tool
  call is observing it, exactly one synthetic follow-up prompt
  (`pi.sendMessage` with `customType: "unified-exec-completed"`,
  `triggerTurn: true`, `deliverAs: "followUp"`) resumes the agent — starting
  a turn when idle, queued as a follow-up during an active run, never
  steering. Implemented as a dedicated agent-level `CompletionCoordinator`
  (`src/completion.ts`) enforcing the exactly-once invariant: terminal
  completion is delivered through a finalized tool result OR causes one
  wake, never both. `write_stdin` calls take observation leases; "observed"
  commits at pi's finalized `tool_execution_end` (an error/cancelled
  finalization keeps the wake eligible); deadline/cancellation releases the
  lease with the wake armed. Wakes are armed only after `exec_command`
  commits to returning a `session_id` (in-yield exits return directly),
  reserved before sending (no duplicates across repeated exit callbacks or
  flush triggers), debounced so simultaneous completions batch into one
  bounded prompt, and retried at the next flush point if submission throws.
  Suppression: `kill_session` and `/unified-exec-sessions` suppress before
  signaling (failed kills restore eligibility), live-process LRU eviction
  and `session_shutdown` suppress, `list_sessions` observing the exit first
  suppresses, and a naturally-exited wake session evicted before
  notification keeps a bounded tombstone snapshot (with `log_path`) so its
  one wake still fires. The prompt carries sanitized bounded metadata
  (session id, exit code/signal, one-line command, cwd, elapsed, log path,
  failure info) — never raw stdout/stderr — and the exited session stays
  drainable afterwards without triggering a second wake.
- **`tool_time_utc` everywhere it matters**: still-running responses,
  absolute-deadline responses, direct terminal results of waits, and
  validation errors now report the current host UTC time so the model can
  compute wall-clock deadlines itself (no precomputed 10-hour deadline is
  handed out). New response fields: `wait_mode`, `wait_status`,
  `yield_until`, `effective_wait_ms`, `on_exit`, `completion_notification`,
  `completion_delivery`, `on_exit_wake`.
- **Tests**: 68 new tests (`tests/time.test.ts`, `tests/long-wait.test.ts`,
  `tests/completion.test.ts`, `tests/wake-e2e.test.ts`) covering timestamp
  validation, argument validation, long-wait behavior with injected
  monotonic clocks/timers (no real 290 s / 10 h waits), and the full wake
  state machine through the real tool pipeline (246 total).

### Verified

- **Live end-to-end run against real pi 0.80.10** (interactive TUI in tmux,
  `gpt-5.6-sol`, extension loaded via `--no-extensions -e ./src/index.ts`):
  (1) `on_exit: "wake"` → idle exit delivered exactly one
  `unified-exec-completed` follow-up that started a turn; the model drained
  the exited session afterwards with no duplicate wake. (2) `yield_until`
  accepted by the provider schema; the model computed a valid deadline from
  `tool_time_utc`; exit-before-deadline returned `wait_status: completed`
  immediately and consumed the wake (no follow-up). (3) Esc during an
  absolute wait: pi aborted the turn ("Operation aborted"), the footer
  showed `until … · cancelled · wake armed`, the process survived, and the
  later natural exit fired exactly one wake from the aborted-idle state.
  Across 4 sessions: exactly 2 wakes (unobserved exits) and 2 direct
  consumptions — the exactly-once invariant held.

### Changed

- **Empty-poll `yield_time_ms` above the cap is now rejected, not clamped**,
  with an actionable error that names `yield_until` and includes
  `tool_time_utc`. `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` can still lower the
  cap but no longer raises the effective cache-friendly maximum above
  290 s (previously it could raise it arbitrarily). Defaults, minimums, and
  interactive-input clamping are unchanged.
- **TUI result footer** now surfaces long-wait state: `until <deadline>`
  while a `yield_until` session is still running, a `cancelled` marker for
  aborted absolute waits, and `wake armed` when a completion notification is
  pending.
- **Tool guidance rewritten** around the four rules: `yield_time_ms` for
  interaction/progress polls ≤ 290 s; `yield_until` for deliberate longer
  waits on finite non-interactive commands; `on_exit: "wake"` to resume on
  unobserved completion; combining them is safe. `yield_time_ms` is now
  described as an attachment/progress window, not a process lifetime. An
  explicit warning forbids `yield_until` for REPLs, sudo, ssh, password
  prompts, dev servers, file watchers, debuggers, and other
  indefinite/interactive sessions.
- **Dependency minimums**: `@earendil-works/pi-coding-agent` peer range
  narrowed from `*` to `>=0.80.5` — the first published version with the
  `agent_settled` extension event, used as a safe flush point for pending
  completion notifications (`tool_execution_end` finalization existed
  earlier). Dev pins bumped 0.80.3 → 0.80.10. The `agent_settled`
  subscription is wrapped in try/catch so older runtimes degrade gracefully
  (wakes still deliver via the debounce timer and tool boundaries).

## 2026-07-10 — 0.6.2

### Changed

- **Default empty-poll yield cap lowered to 290 seconds**: reduced the default
  empty `write_stdin` poll `yield_time_ms` upper clamp from 30 minutes to
  290 seconds so a long poll never outlives Anthropic's default 5-minute
  prompt-cache TTL. The `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` env override still
  allows raising the cap (e.g. back to `1_800_000`) for cache-insensitive
  runs. Updated tool guidance, README, and tests accordingly.

## 2026-07-10 — 0.6.1

### Added

- **Windows: find Git Bash even when it's not on PATH.** Git for Windows'
  default installer option adds only `Git\cmd` (git.exe) to PATH — not
  `Git\bin` — so the most common setup is "git works, bash doesn't", and
  those users were silently downgraded to powershell. The default-shell
  probe (and explicit `shell: "bash"`) now resolves in order:
  1. `PI_UNIFIED_EXEC_BASH` env var (explicit override, must be a file)
  2. `bash` on PATH (WSL System32 stub still excluded)
  3. derived from `git.exe` on PATH — walk up from git's directory probing
     `<root>\bin\bash.exe` (covers `Git\cmd`, `Git\bin`,
     `Git\mingw64\bin` layouts)
  4. well-known install roots: `%ProgramFiles%\Git`, `%ProgramW6432%\Git`,
     `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git`
  5. powershell fallback (warning now mentions `PI_UNIFIED_EXEC_BASH`)

  Derived/fixed-path hits use `bin\bash.exe` (Git's launcher, which sets
  up MSYS PATH so `ls`/`grep`/`sed` work in the child — verified with a
  stripped PATH), never `usr\bin\bash.exe`. A one-time info notice reports
  when bash is used from off PATH. Security posture unchanged: only
  absolute paths under admin/user-owned install roots or the tree of an
  already-PATH-trusted git.exe are probed; every candidate must be a
  regular file; nothing cwd-relative. Registry lookup and MSYS2/Cygwin
  roots deliberately omitted.

### Fixed

- De-flaked the three running-session UI tests (fixed sleeps → polling):
  `sleep 0.4` exceeded the 700 ms wait on a loaded windows-latest runner.

## 2026-07-10

### Fixed (second review round)

A second review pass (different reviewer model, empirical reproductions)
found residual issues in the Windows PR; all majors addressed:

- **taskkill was cwd-hijackable**: Windows' CreateProcess checks the
  parent's cwd before PATH for bare names, so a `taskkill.exe` planted in
  an untrusted repository would run on every kill. Now invoked via the
  absolute `%SystemRoot%\System32\taskkill.exe`.
- **Failed kills were reported as successful**: `kill_session` removed the
  session from the store even when the process never exited (e.g. taskkill
  failure/access denied), silently dropping ownership of a live process.
  Termination outcomes now carry `killed`; unconfirmed kills keep the
  session registered and return an explicit FAILED message (same for the
  `/unified-exec-sessions` command and the shutdown notification).
- **Shutdown raced session creation**: `exec_command` inserts into the
  store only after the 150 ms early-exit grace, so a `session_shutdown`
  inside that window drained the store without seeing the new child —
  reproduced, orphaning a live process. Spawned sessions are now tracked in
  a pending set that shutdown also terminates, and new `exec_command`s are
  rejected after shutdown until the next `session_start`.
- **Multiline cmd.exe commands were silently truncated**: `cmd /c` stops at
  the first newline. `buildShellCommand` now fails closed with a clear
  error (join with ` & `, or use powershell/bash) instead of silently
  running only the first line.
- **Unresolved bare shell names could execute from the workdir**:
  `resolveBinary`'s bare-name passthrough let CreateProcess find a planted
  `powershell.exe` in the child cwd. Shell resolution now fails closed
  (`resolveWindowsShell` throws for unresolvable names, only accepts
  .com/.exe — Node can't spawn .cmd/.bat directly), and the last-resort
  powershell fallback is the canonical absolute System32 path, never a
  bare name.
- **Windows-only cmd specialization no longer leaks to POSIX**: a POSIX
  binary named `cmd` now gets plain `-c` (powershell/pwsh keep `-Command`
  everywhere — pwsh is cross-platform).
- **findOnPath resolves relative PATH entries to absolute paths** (results
  were cwd-dependent), and the double force-kill on Windows shutdown was
  removed.
- **PTY input now has a mandatory cross-platform assertion**: a repo-owned
  Node line-echo fixture asserts write_stdin round-trips (and exit-code
  propagation) under a real PTY on every platform — no longer only the
  skippable python REPL test. The Windows-only direct CI step also runs
  pty-load first so it can't pass by skipping.
- **README**: PTY examples now use `\r` (Enter) instead of `\n`; added a
  supply-chain note documenting that the native ConPTY prebuild is fetched
  by `prebuild-install` outside npm's integrity envelope (pinned exactly;
  vendor or build from source for stricter guarantees).

Known residual (documented): LRU eviction and shutdown kills remain
best-effort (no per-kill confirmation loop); Job Objects remain the
follow-up for true group-kill semantics.

## 2026-07-09

### Fixed (post-review)

A multi-perspective code review of the Windows PR produced 17 confirmed
findings; all majors and most minors addressed:

- **`shell: "cmd"` with `tty: true` was broken**: node-pty has no
  `windowsVerbatimArguments` and its `argsToCommandLine()` re-escapes
  embedded quotes, mangling the pre-quoted `/s /c` payload into a
  guaranteed syntax error (and diverging the executed command from the
  displayed one). The PTY path now passes the args as a single raw
  command-line string, which node-pty uses verbatim. Covered by a new
  Windows PTY e2e test.
- **PTY dependency load is now guarded in CI**: new `tests/pty-load.test.ts`
  asserts `isPtyAvailable()` when `EXPECT_PTY=1` (set on all matrix legs),
  so a prebuild failure is a red build instead of a silent skip of the
  whole PTY suite. The dep is pinned exactly (`0.13.1`) since
  `disposeWindowsConpty` relies on undocumented internals (now also locked
  by a mock-agent unit test).
- **Dropped the fallback `require("node-pty-prebuilt-multiarch")`**: the
  old package name is no longer declared, so Node's resolution would walk
  ancestor `node_modules` — a planted package could inject unaudited native
  code. Only the declared @homebridge package is loaded.
- **Shell resolution hardening**: `findOnPath` only accepts regular files
  (a directory named `bash` no longer matches) and returns absolute paths;
  bare shell names are resolved to their absolute PATH match before
  spawning (Windows' CreateProcess checks the child's cwd — the
  LLM-supplied workdir — before PATH); System32's WSL `bash.exe` stub is
  excluded from the default-shell probe; resolutions are cached
  (previously every Windows PTY spawn re-scanned PATH synchronously).
- **Windows kill escalation removed**: the "SIGKILL escalation" was a
  byte-identical second `taskkill /T /F` after a wasted 2 s poll; on
  Windows the first kill is already final, so escalation is skipped.
- **Real fallback-branch coverage**: `resolveDefaultShell` takes an
  injectable env; tests drive both the bash-found and powershell-fallback
  branches (plus caching) with synthetic PATH fixtures on every platform.
  cmd.exe quoting is e2e-tested against `&`, embedded quotes, `%VAR%`,
  parentheses, and pipes — the inputs the mechanism exists for.
- **CI**: direct PTY diagnostic step scoped to Windows (was doubling the
  slowest suite on all 6 legs). Removed a redundant SIGSEGV assertion and
  a stale python3 silent-skip branch that could mask real REPL failures.

Known limitation (documented, not fixed): `taskkill /T` cannot reach
grandchildren once the direct child has exited — true group-kill semantics
would need Windows Job Objects; tracked as a possible follow-up.

### Added

- **Windows support** (fixes [#3](https://github.com/iamwrm/pi-unified-exec/issues/3)):
  - **Process-tree kill via `taskkill /pid <pid> /T /F`**: POSIX
    process-group kills (`process.kill(-pid)`) don't exist on Windows;
    killing only the shell orphaned grandchildren, which also held the
    stdio pipes open and delayed exit detection past the escalation
    grace. Every kill path (`kill_session`, LRU eviction,
    `session_shutdown`, `/unified-exec-sessions`) now force tree-kills on
    Windows. Pipes are spawned with `detached: false` there (no process
    groups to detach into).
  - **Windows PTY (ConPTY)**: swapped the optional PTY dependency from
    `node-pty-prebuilt-multiarch` (linux/macOS prebuilds only) to the
    API-compatible `@homebridge/node-pty-prebuilt-multiarch` fork
    (adds win32 prebuilds, covers Node 22/24 ABIs). The loader prefers
    the new package and falls back to the old name. On Windows the PTY
    binary is resolved to a full path (bare `bash` fails ConPTY's
    "File not found" check), kills go through taskkill (node-pty's
    `kill()` throws on signal names and its console-list helper crashes
    on dead children), and ConPTY's conout worker thread + named-pipe
    sockets are disposed on exit — they otherwise keep the host event
    loop alive forever.
  - **Shell selection** (new `src/shell.ts`): default shell is `bash`
    everywhere; on Windows without bash on PATH it falls back to
    `powershell` with a one-time warning. Explicit `shell: "cmd"` gets
    `/d /s /c` + verbatim args (cmd's quoting rules), `powershell`/`pwsh`
    get `-NoProfile -Command`, POSIX shells keep `-c`.
  - **CI**: `windows-latest` added to the matrix. Platform-aware test
    fixes: SIGTERM-trap escalation doesn't apply on Windows (first kill
    is already final), Windows' signal table lacks
    SIGPIPE/SIGUSR1/SIGUSR2, and the python3 REPL PTY test now probes for
    a real interpreter (the WindowsApps Store stub stays alive without
    being a REPL). New `tests/shell.test.ts` (9 scenarios).

## 2026-07-08

### Fixed

- **CI failing on Node 20**: `@earendil-works/pi-coding-agent` requires
  Node >= 22.19.0 (its bundled undici 8 calls
  `worker_threads.markAsUncloneable`, which doesn't exist on Node 20, so four
  test files crashed on import with `webidl.util.markAsUncloneable is not a
  function`). Dropped Node 20 from the CI matrix in favor of 22 and 24, and
  declared `"engines": { "node": ">=22.19.0" }` in `package.json`.

## 2026-07-07 — 0.5.0

### Changed

- **Migrated to the `@earendil-works/*` package scope**: upstream pi renamed
  `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` to
  `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` in 0.74.0 (the
  old npm scope is frozen at 0.73.1; the repo moved to `earendil-works/pi`).
  All imports in `src/` and `tests/`, both peerDependencies, and both dev pins
  now use the new scope. Pi's extension loader still aliases the old scope at
  runtime, but that compat shim is slated for removal upstream. Bumped the
  package version to 0.5.0 because the peer dependency names changed.
- **Dev pins bumped 0.73.0 → 0.80.3** (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`).
- Updated `README.md`, `docs/DEV.md`, and `AGENTS.md` references (package
  scope, changelog/clone URLs → `earendil-works/pi`).

### Verified

- **Upstream compatibility with `@earendil-works/pi-coding-agent` 0.80.3**:
  audited every release note from 0.73.0 to 0.80.3. Our entire import surface
  (`ExtensionAPI`, `ExtensionContext`, `AgentToolResult`,
  `ToolRenderResultOptions`, `Theme`, `TruncationResult`, `formatSize`,
  `truncateTail`, `truncateToVisualLines`, `DEFAULT_MAX_BYTES`,
  `DEFAULT_MAX_LINES`; pi-tui `Container`, `Text`, `truncateToWidth`,
  `Component`) is unchanged. The only breaking changes upstream were the
  minimum Node bump to 22.19.0 (0.75.0, dev-only impact) and the pi-ai root
  API move to `/compat` (0.80.0, we don't import pi-ai). `npx tsc --noEmit`
  clean; all 129 tests pass.

### Fixed

- **Test pins updated for new `truncateTail` line-counting semantics**:
  since pi ≥ 0.80, a trailing `\n` no longer counts a phantom empty last line
  and empty input counts 0 lines (previously `"".split("\n") → [""]` counted
  1). Updated `tests/truncate.test.ts` and the `totalLines` expectations in
  `tests/e2e.test.ts` (4001→4000, 2501→2500). No production-code change was
  needed — the `[Showing lines X-Y of Z]` marker in `src/index.ts` derives
  from the same counts and is now more accurate.

## 2026-06-10 — 0.4.0

### Fixed

- **Log-stream error no longer orphans live sessions**: a log-mirroring error
  (disk full, permissions, …) used to mark the session as exited while the
  child kept running, making it unkillable (`kill()` no-ops once exited) and
  letting `list_sessions` drop it without terminating the process. Failures
  are now recorded on the session without flipping its exited state.
- **Async spawn errors are diagnosable**: pipe-mode spawn failures delivered
  via the child's async `error` event (ENOENT shell binary, nonexistent
  `workdir`) previously produced an empty `[exited]` response with no
  exit_code, signal, failure, or output. The error message (plus a
  shell/workdir hint for ENOENT) is now surfaced as `failure_message`.
- **EPIPE no longer crashes the host**: `child.stdin` had no `error` handler,
  so writing to a child that closed its stdin raised an unhandled stream
  `error` event and crashed the whole pi process. Errors are now swallowed,
  and `write_stdin` reports `failure_message: "stdin write failed: …"` when
  bytes cannot be delivered to a live session (stdin destroyed/ended).
  `write()` also no longer conflates stream backpressure with delivery
  failure.
- **collectOutputUntilDeadline listener/timer leak**: each loop iteration
  registered fresh `abort` listeners on the exit/external signals and started
  a fresh deadline timer without ever cleaning them up — chatty processes
  tripped Node's EventTarget max-listener warning after ~10 chunks, and a
  30-minute empty poll could accumulate thousands of live timers. The
  deadline/abort promises are now created once per call and all
  listeners/timers are released when the call returns. The no-external-abort
  placeholder promise is also scoped per call (not module-global) so race
  reactions attached to it stay garbage-collectable.
- **PTY signal mapping covers the full platform table**: the numeric→name
  signal map was a hand-picked 6-entry table, so tty-mode children killed by
  SIGSEGV/SIGPIPE/SIGUSR1/… were reported as `exit_code=0`. The map is now
  built from `os.constants.signals` (exported as `signalNameFromNumber`).
- **`write_stdin` rendering of `chars_b64`**: calls carrying only a base64
  payload rendered as `⟳ poll`; they now render as `» (base64, N bytes)`.
- **`kill_session` signal validation**: signal names are normalized (`term`,
  `INT`, `sigkill` all work) and unknown names are rejected with an error
  instead of silently no-opping and then escalating to SIGKILL anyway.

### Changed

- **`list_sessions` reports exited sessions once before pruning**: instead of
  silently dropping sessions that exited between tool calls, the listing now
  includes them one final time with `running: false`, `exit_code`/`signal`,
  `failure_message`, and `log_path` (`active_count` still counts only live
  sessions), preserving the "exit information is never silently lost"
  guarantee.
- **Shutdown escalates to SIGKILL**: `session_shutdown` now waits up to 1s for
  SIGTERM'd children to exit and SIGKILLs survivors (children run in detached
  process groups and would otherwise outlive pi when they trap SIGTERM).
- **Removed dead `HEAD_TAIL_MAX_BYTES` constant** in `src/index.ts` (the
  per-session buffer cap lives in `src/session.ts`).

### Added

- **`/unified-exec-sessions` command**: human-facing escape hatch that lists
  live sessions in a selector and kills the chosen one (or all) without going
  through the model, sharing the kill/escalate/drain logic with
  `kill_session`.
- **Streaming parity test**: the e2e harness now captures `onUpdate` and
  asserts multiple growing partial outputs during a long-running
  `exec_command`, plus 14 more regression tests covering every fix above
  (129 tests total across 10 files).

## 2026-06-02 — 0.3.6

### Changed

- **Configurable empty-poll cap**: restored the default pure `write_stdin`
  empty-poll `yield_time_ms` cap to 30 minutes and added
  `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` so cache-sensitive environments can lower
  the cap (for example to 300 seconds / 5 minutes).

## 2026-06-02 — 0.3.5

### Changed

- **Empty-poll cache safety**: reverted pure `write_stdin` poll
  `yield_time_ms` clamping from 30 minutes back to 5 minutes (300 seconds) and
  updated model guidance/docs so long polls stay within typical prompt-cache
  expiry windows. Superseded by 0.3.6's configurable cap.

## 2026-06-01 — 0.3.4

### Fixed

- **macOS short-command output race**: pipe-mode sessions now wait for the
  child-process `close` event instead of `exit` before finalizing, preserving
  trailing stdout/stderr from very short-lived commands in CI.

## 2026-06-01 — 0.3.3

### Changed

- **Long-running job polling guidance**: updated the `write_stdin` tool prompt
  and README to tell models to use a single long empty poll for known
  non-interactive jobs instead of repeated short polls, reducing context noise.

## 2026-05-27 — 0.3.2

### Changed

- **Longer empty-poll yield cap**: raised empty `write_stdin` poll
  `yield_time_ms` clamping from 300 seconds to 30 minutes, allowing agents to
  wait longer on known-running background sessions without repeated polls.
  Superseded by the 2026-06-02 cache-safety revert.

## 2026-05-06

### Changed

- **Compatibility follow-ups resolved**: replaced the hand-restated render
  context shape with a type derived from pi's exported `ToolDefinition`, and
  documented the resolved follow-ups in `to_improve.md`.
- **Improvement backlog detail**: expanded each `to_improve.md` item with a
  lightweight plan, code references, risk evaluation, and verification gate
  based on the latest pi release notes.
- **Upstream pi 0.73.0 compatibility**: cloned and audited the latest
  `badlogic/pi-mono` source at `30298368` and updated development dependencies
  to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` 0.73.0. Switched
  tool schema imports and package metadata from the legacy
  `@sinclair/typebox` package name to pi's current `typebox` package while
  keeping the existing extension API usage intact.

### Added

- **Shutdown metadata coverage**: added tests for all current pi
  `session_shutdown` reasons so session cleanup remains covered across quit,
  reload, and session replacement paths.
- **Upstream improvement notes**: added `to_improve.md` with follow-up
  opportunities and pitfalls found while reviewing recent pi releases.

## 2026-04-27 — 0.3.1

### Fixed

- **macOS CI short-command drain race**: increased the bounded trailing-output
  drain window for very fast commands so stdout/stderr that arrives shortly
  after the process exit event is captured reliably on macOS Node 22.

## 2026-04-27 — 0.3.0

### Added

- **Running-session UI after `/tree`**: while unified-exec processes are still
  alive, the extension now keeps a TUI footer status. After `/tree` navigation
  it also shows a widget listing live session IDs and commands so humans can
  see that processes survived branch navigation. The footer/widget now refresh
  immediately when a background session exits, without waiting for the next
  tool call or turn.
- **Contributor guidance**: added `AGENTS.md` guidance requiring changelog
  updates alongside future code, docs, tests, or package metadata edits.

## 2026-04-27 — 0.2.2

### Changed

- **Prompt guideline safety**: changed the `exec_command` file-exploration hint
  to only prefer `grep`/`find`/`ls` when those dedicated tools are actually
  available, and to suggest shell fallbacks via `rg`, `fd` when installed,
  `find`, and `ls` otherwise.

## 2026-04-21

### Verified

- **Upstream compatibility with `@mariozechner/pi-coding-agent` 0.68.0**:
  audited the upstream 0.68.0 `CHANGELOG.md` against our extension's
  usage of pi-coding-agent. All 0.68.0 breaking changes
  (`createAgentSession({ tools })` now takes `string[]` instead of
  `Tool[]`; removal of prebuilt cwd-bound tool exports such as
  `readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`,
  `findTool`, `lsTool`, `readOnlyTools`, `codingTools`, and the
  corresponding `*ToolDefinition` values; removal of ambient
  `process.cwd()` fallbacks from `DefaultResourceLoader`,
  `loadProjectContextFiles()`, and `loadSkills()`) target APIs we do
  **not** call. The types, helpers, constants, and `ExtensionAPI`
  surface we import (`ExtensionAPI`, `ExtensionContext`,
  `AgentToolResult`, `ToolRenderResultOptions`, `Theme`,
  `TruncationResult`, `formatSize`, `truncateTail`,
  `truncateToVisualLines`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`,
  `pi.on`, `pi.registerFlag`, `pi.getFlag`, `pi.registerTool`,
  `pi.getActiveTools`, `pi.setActiveTools`) are unchanged. The new
  additive fields on `SessionShutdownEvent` (`reason`,
  `targetSessionFile`) do not affect our handler. No extension code
  changes required; the devDep pin can be bumped at leisure. See
  [docs/DEV.md#checking-upstream-compatibility](docs/DEV.md#checking-upstream-compatibility)
  for the recipe used.

## 2026-04-20

### Changed

- **Prompt optimization**: LLM-visible tool prompts trimmed by ~56% (~384
  tokens saved per request). Tightened `description` strings, removed
  redundant `promptGuidelines`, and shortened parameter descriptions for
  `exec_command`, `write_stdin`, `kill_session`, and `list_sessions`. The
  `chars` escape table, `yield_time_ms` bounds, and `session_id` vs
  `exit_code` semantics are each now documented in a single canonical
  location instead of 3–4.
- **`exec_command` guidelines**: added a rephrased file-exploration hint —
  *"Prefer grep/find/ls tools over exec_command for file exploration
  (faster, respects .gitignore)."* This replaces the auto-added `bash`-
  targeted guideline that pi's `system-prompt.ts` stops emitting once the
  built-in `bash` tool is filtered out (the default under this extension).

### Fixed

- **Renderer parity with pi's built-in `bash`**: removed the
  `commandPreview` whitespace collapsing from `renderExecCommandCall` in
  `src/render.ts`. Multi-line commands (heredocs, multi-line `node -e` /
  `python3 -c`) now render verbatim in the `$ …` banner across multiple
  rows, matching
  `pi-mono/packages/coding-agent/src/core/tools/bash.ts:formatBashCall`.
