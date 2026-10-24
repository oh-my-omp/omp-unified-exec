# IV-0002 — Bounded output lifecycle and compact tool rendering

**Status:** active; bounded terminal output and omp-native presentation
**Root IV:** this document
**Related release:** [Changelog.md](../Changelog.md) — 2026-09-30 — 0.12.1
**Workspace doctrine:** [docs/DC-0001-agentic-workspace.md](./DC-0001-agentic-workspace.md)

## Intent

`kill_session` historically appended its entire retained final drain directly to
the tool result and had no custom Pi renderer. Pi therefore used its generic
fallback renderer, which ignored the collapsed/expanded state and printed the
whole payload. The same result bypassed unified-exec's normal 50 KiB / 2000-line
model-output cap and persisted an undocumented unbounded `final_output` field.

`list_sessions` also relied on the fallback renderer. Its inventory was smaller,
but the inconsistency meant the package's claim that tool output was compact and
expandable was not true for every tool.

The initiative establishes a durable output contract across these layers:

1. **Capture:** the child stream is mirrored to its session log.
2. **Model/session result:** every output-bearing result is a bounded,
   terminal-inert plain-text tail with explicit truncation metadata and
   a recovery path.
3. **TUI:** omp owns collapsed/expanded output and its configured expansion
   binding through its bash renderer.
4. **Structured tools:** each tool returns `structuredContent` matching its
   `outputSchema`; `output` is the same bounded, terminal-inert tail with
   real newlines.
5. **omp presentation:** only omp hosts are admitted. `exec_command`,
   `write_stdin` and `kill_session` present through omp's own bash renderer
   from the same bounded `details`; the other tools use omp's default card.
6. **Rendered terminal output:** PTY children draw with cursor movement, erases,
   carriage returns and the alternate screen. Stripping those controls left
   every redraw appended to the previous one, so neither the model nor a human
   saw the terminal's actual state. Every session feeds its output into a
   per-session headless terminal emulator. Running results report unseen history
   plus the current screen and cursor; completed results report only the
   frozen final active screen, with a retained-terminal reading address.
7. **Tern terminal HUD (fork):** a tool result shows a session's screen only as it
   was when that call returned. On omp rendering natively in Tern, a terminals
   segment (terminal icon and bare stored session count, words in its hover
   label) joins omp's own running-work pill as its last segment, after agents
   and jobs, so Tern draws one capsule with its dividers across Reader, Spine,
   Console and color themes
   ([#76](https://github.com/oh-my-omp/omp-unified-exec/issues/76)). There is
   no outer hide button or dismiss state. Clicking the
   segment opens the Terminals view, built like omp's Background jobs view: the
   sessions as a master list (icon, command, elapsed), the selected session's
   status, command, facts and colored output as its detail, Kill, Open and
   Close, drawn by Tern's own styles with no plugin
   ([#77](https://github.com/oh-my-omp/omp-unified-exec/issues/77)). Open shows the
   session as a full-pane terminal page framed like omp's Console: its
   retained history and current screen, colored, scrollable back and
   following new output without any tool call, with typed keys sent to the
   session
   ([#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17),
   [#19](https://github.com/mouriya-s-lab/omp-unified-exec/issues/19),
   [#21](https://github.com/mouriya-s-lab/omp-unified-exec/issues/21),
   [#23](https://github.com/mouriya-s-lab/omp-unified-exec/issues/23),
   [#25](https://github.com/mouriya-s-lab/omp-unified-exec/issues/25)).

## Requirements

- Never depend on a TUI renderer to enforce model/session size limits.
- Apply the host-compatible `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` tail limits to
  `kill_session`, including model-visible recovery markers; independently cap
  metadata scans/headers that sit outside the output body.
- Keep the full retained stream out of result details; `details.output` is the
  canonical bounded body for exec, write, and kill.
- Strip ANSI/VT sequences and unsafe C0/C1 controls before child text reaches
  model content, persisted details, partial updates, or custom renderers. Child
  bytes are first interpreted by the session's terminal emulator and only its
  rendered plain text (sanitized again) leaves it. Keep exact raw bytes only in
  the session log and sanitize again while
  rendering legacy/fallback details. The two styled projections, the Tern HUD
  screen and explicit terminal screenshots, are generated only from emulator
  cell attributes (SGR for the HUD, SVG rasterized to PNG for screenshots);
  no child byte reaches either.
- Consuming observations, non-consuming projections and emulator disposal
  are serialized per session. Zero-byte writes are rejected before observation;
  use `read term://…` for state/content and `monitor` for events or completion.
  Reads use an ordered parser barrier covering bytes accepted before the read,
  rather than waiting for continuous output to become idle. Streaming snapshots
  and HUD screens may lag unparsed output and never consume; the HUD reads only
  sessions still in the store.
- Conditional monitors use their own rendered-row cursor on this same parser
  chain, never the consuming observer. Their sanitized, bounded notifications
  follow the [monitor contract](IV-0001-long-wait-and-wake-control.md#monitor-contract).
- On omp, `read term://<session-id>-<unique-suffix>` reads what the HUD shows:
  normal-screen retained physical rows, or the alternate screen while it is
  active (the alternate screen has no history). `/screen` reads the active
  screen, and `/page/N` reads `rows` rows per page of the bare read's rows
  (negative pages count from the end). Existing `read`
  selectors provide head/tail. Reads never advance observation markers or remove
  sessions. Unknown keys report `unknown_terminal`; out-of-range pages report
  total pages. A session whose spawn failed registers no terminal resource.
- Every PTY child gets `TERM=xterm-256color`, matching the PTY's terminal name
  and the emulator, never omp's own inherited `TERM`.
- The session freezes one immutable terminal projection only after output
  closure and parser completion, including normal retained rows, active styled
  cells, geometry, cursor and appearance. Normal removal, LRU termination and
  short-command release await that freeze before disposing the emulator.
  Frozen projections remain addressable until process exit, even across plugin
  activations; shutdown may discard only its own unfinished live resources.
- `read term://<key>/screen.png` returns the complete active cell grid through
  omp's file-backed image pipeline. It preserves palette/256/RGB colours,
  bold, dim, italic, underline, inverse and strikethrough; invisible cells draw
  only their background, wide glyphs span two cells. Live reads use the same
  projection's current appearance and draw an outline cursor; frozen reads
  use frozen appearance and never draw a cursor. No raw-output replay occurs.
- Every completed result uses the frozen active screen, including short
  commands, attached exits, input-bearing writes and confirmed kills. An
  unchanged final screen is still returned. `terminal_url` remains root-level;
  `terminal.retained_rows` counts trimmed normal-screen physical retained rows,
  and `terminal.history_may_be_truncated` is an explicit boolean. Final metadata
  omits incremental `screen_changed` and `history_lines`. Output remains subject
  to the independent 50 KiB / 2000-line cap; `/screen` retains the complete view.
  Shutdown releases a live terminal without waiting for the process to die;
  an in-flight call that finds its terminal released returns empty output
  instead of an error and reports the process as it is (exited, or still
  running until the SIGKILL escalation lands).
- Represent operation and state explicitly (`operation`, `status`, `running`),
  rather than inferring liveness from the presence of `session_id`.
- Preserve failed-kill ownership: an unconfirmed kill remains registered and is
  reported as running.
- Reject non-omp hosts, and omp hosts without `Bun.spawn` and `Bun.Terminal`,
  in the extension factory before loading omp modules or activating.
  Exec/write/kill delegate render and describe hooks to omp's bash renderer;
  monitor, set_on_exit and list_sessions use omp's bounded default card.
  Tool-core definitions carry no host renderer hooks.
- On omp, add the terminals segment to omp's pill only while an interactive
  session renders natively and the store holds a session, so the ANSI TUI's
  pill line gains nothing. omp's own row is never mutated; the extension adds
  no dock CSS, so omp-todo-more and other dock widgets keep their layout.
  Only the open Terminals view and terminal page take focus and keys, as
  omp's Background jobs view and Console do.
  The page writes typed keys to its running session (Esc goes back instead),
  and Kill ends a session through `kill_session`'s path; nothing else reaches
  sessions, and the HUD keeps no copy of session or screen state.
- Leave collapse/expansion and visual-line clipping to omp's native renderer.
- Keep truncation and log-recovery warnings in the display projection.
- Do not synchronously load an arbitrary log file when expanded. Expanded mode
  shows the complete bounded result; `log_path` owns complete-stream recovery.

## Decisions

| Decision | Rationale |
|---|---|
| Split output serialization into `src/tool-result.ts` | Result bounds remain testable without process or TUI machinery, and `src/index.ts` no longer carries multiple ad-hoc serializers. |
| Replace undocumented `final_output` with bounded `output` | One canonical renderer/model field; avoids persisting the whole retained output. GitHub code search found no external consumer. |
| Version as 0.9.0 | The observable details shape changed even though the old field was undocumented. |
| Delegate tool presentation to omp | Exec/write/kill adapt bounded details to omp's bash renderer; other tools use omp's default cards. |
| Expand only bounded output | Rendering or reading an unlimited multi-gigabyte log from a synchronous tool row is unsafe. |
| Make result text terminal-inert; preserve raw logs | PTY output can contain clipboard, alternate-screen, keyboard-mode, and cursor controls. Models need text, not executable terminal state; forensic bytes remain recoverable by path. |
| Project script results from details, not a second serializer | `structuredContent` inherits the bounds and terminal safety of `details.output`; metadata strings reuse `safeMeta`. Model `content` stays byte-identical. |
| Keep structured schemas and projections | `outputSchema` / `structuredContent` expose typed bounded results without changing model text or persisted details. |
| Keep complete logs for now | Archive bounding/retention is a separate policy change and remains follow-up work. |
| Present only on omp through its exported bash renderer | omp's `toolRenderers.bash` (`@oh-my-pi/pi-tui/tools`) owns collapse, expansion, exit/background status and ANSI/Tern views. A pure display adapter is plugin code. The injected `ExtensionAPI.arktype` identifies omp; non-omp hosts fail at factory invocation, and missing or reshaped required omp modules fail loading before activation. |
| Show write/kill actions as bash comments | `# stdin → session N: "…"`, `# kill session N (SIGTERM)` name the action without presenting input bytes as an executable command; base64 input shows only its byte count. Incomplete or rejected zero-byte writes display `input required`, not an observation action. |
| Append the truncation marker to the omp display text | The marker and `log_path` live outside `details.output`; appending `truncationMarker()` keeps recovery visible as the last collapsed line without claiming the log is an omp artifact. |
| Mark omp Tern failures with view tone, not result `isError` | Tern derives card status from the host result's `isError`, which stays false for a nonzero exit because that is an ordinary completion for the model. The describe view sets `tone: "error"` for failed exits, signals, start failures and failed or unknown kills; the exit chip comes from omp's bash head. |
| Run every session in a PTY | A rendered screen bounds every read by its size, so neither an in-memory retention cap with omission markers nor a streaming sanitizer for raw output is needed; the raw stream stays in the log. A non-PTY session duplicated the host's `bash`, whose deadline is harmless for short commands, so short one-shot commands stay there and `exec_command` keeps long, interactive, concurrent and daemon work with no command deadline ([#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)). |
| Render session output through `@xterm/headless` | Proven identical under Node, Bun and a `bun build --compile` binary, with no DOM, assets or native code. Rejected: Codex's `TERM=dumb`/`NO_COLOR`/`PAGER=cat` mitigation (openai/codex `core/src/unified_exec/process_manager.rs:94-104`), which cannot stop programs that force redraws ([openai/codex#32325](https://github.com/openai/codex/issues/32325)). |
| Bare `term://` follows the HUD's domain; PTYs announce `xterm-256color` | Under tmux every byte lands on the alternate screen, so a normal-only bare read stayed frozen at `tmux new` for hours while the HUD showed the pane ([#84](https://github.com/oh-my-omp/omp-unified-exec/issues/84)). Rejected: a notice line on the stale rows, which joins line selectors and is easy to skip. An inherited `xterm-kitty` made programs target a terminal the emulator is not, and remote hosts without that terminfo refused it. |
| Running result = unseen history + full current screen + cursor | A self-contained running screen matches what a human sees and does not require splicing earlier results. Positional comparison skips unchanged previously reported rows; an unchanged running screen reports `screen_changed: false`. This incremental contract does not apply to final results. |
| Completed result = frozen active screen | Exit is a final state, not an incremental observation. The final body and `/screen` use the same frozen projection, so unchanged screens and last-moment output remain visible. Retained history stays behind `terminal_url`; `retained_rows` describes retained physical rows, not total produced output. |
| Align history with an xterm marker on the observed screen's top row | Each observation registers a marker at the screen's top row; the next observation's history starts there, so positional comparison with the previous screen is exact. The marker follows the row as it scrolls and is disposed when the row is trimmed from the history, so the emulator keeps its history for the HUD. Rejected: erasing the emulator's scrollback (ED3) after each observation, which left the HUD screen nothing to scroll back through; counting scroll events into absolute line numbers, which leaving the alternate screen, DECSTBM regions, ED3 and RIS all break. |
| Bound history by cells, not lines | History rows = 240000 cells / `cols`, at least one screen. Running observations warn when the marked row was evicted while history sits at that cap; a child's ED3 or RIS can also remove the marker by erasing those rows. Final metadata uses the frozen projection's retained-history capacity warning, independent of the consuming marker. Neither count claims total produced output. |
| One process-global terminal index and `term` handler | Child activations and reloads may reuse numeric session ids. A UUID suffix and a `Symbol.for` process registry keep keys distinct and old resources readable. The router is the registration authority: reload updates the same branded handler object's complete methods in place, without registering or unregistering again. |
| Freeze at output closure plus ordered parser completion | A process-exit event may precede trailing output. The session owns the freeze promise; the registry stores only the derived live/frozen projection, not a second process state. Final results read that projection; the emulator is released when the session leaves ownership. Rejected: log replay and retaining live emulators as final resources. |
| Retain frozen resources for the omp process lifetime | Frozen data keeps normal physical rows and only the active styled grid, never xterm cell references or the live session graph. Memory accumulates with completed sessions, as logs do. LRU still sends only its existing SIGTERM: a child that ignores it retains its live emulator until actual output closure; no new escalation mechanism is introduced. |
| HUD logic inside the omp extension, drawn only by Tern's built-in styles | The sessions and their emulators live in this process; omp's dock and overlays read them through the extension's components directly. A Luau plugin block would need the screen pushed to it across processes (a second copy of state) and shows as a pane, not a floating panel (owner's choice, [#17](https://github.com/mouriya-s-lab/omp-unified-exec/issues/17)). The segment, view and page use omp's own roles, so they need no Tern CSS and look right in every theme and chat style with no plugin installed (owner's requirement, [#75](https://github.com/oh-my-omp/omp-unified-exec/issues/75)). |
| Remove the Tern plugin earlier versions installed, in the awaited omp factory | Up to 0.14.7 the extension installed a CSS-only `omp-unified-exec` Tern plugin (a normal copy; 0.14.6 a developer link), whose stylesheet moved omp's shared `belowEditor` container and so other extensions' widgets. The extension created it, so it ends it: `withHostPresentation` awaits `retireTernPlugin` before activation, during install validation and ordinary loading. Tern's CLI owns the directory and reload: `plugin list --json` decides whether `omp-unified-exec` is registered; `plugin remove ID --json` removes a copy, and only Tern's exact `is linked; use unlink` answer leads to `plugin unlink ID --json`; a second `list` must no longer show the id. Only that id is touched. Missing Tern skips it; any other failure rejects loading with bounded sanitized diagnostics. Each CLI call has a 75-second timeout for Tern's 60-second reload wait. Rejected: deleting the plugin sources only (installed copies keep moving other widgets); keeping an empty plugin (it would still be a plugin to install). |
| Terminals = a segment of omp's own running-work pill | Tern 0.9.5 draws omp's running work as one capsule (`omp.hud.pill`) of sibling segments (`omp.hud.seg`), with a divider rule between adjacent segments; a separate pill on another `omp.hud` row is a second capsule, and with omp-todo-more's dock grid it landed below the composer ([#76](https://github.com/oh-my-omp/omp-unified-exec/issues/76)). The terminals segment is a `row` with role `omp.hud.seg`: a terminal icon (tone `success`, distinct from agents' accent and jobs' warning) and the bare stored session count, `N terminals · M running` as its hover/aria label, and `unified-exec.terminals.open` as its click action (Tern handles built-in action names itself). It is the pill's last segment, after omp's agents and jobs. Naturally exited sessions still count while stored. Tern's rules own the capsule, divider, spacing and chat-style geometry; the extension adds no CSS for it. |
| Wrap `describeHudPills` once per process; append a component per interactive mode | omp has no extension API for pill segments; `InteractiveMode` (exported to extensions by `@oh-my-pi/pi-coding-agent/modes/interactive-mode`) describes the row in `describeHudPills`, and omp's reconciler describes a component child in place (no wrapper element) and routes its events to that component. The wrapper is installed once per prototype; a `Symbol.for` registry holds the current activation's decorator, which a reloaded activation replaces and only its own deactivation withdraws. The decorator parses omp's row (an `omp.hud` row with at most one `omp.hud.pill`), returns it untouched with no stored session, and otherwise returns a new row whose pill (omp's, or a new one with omp's key and props when omp has none) ends with this activation's segment component for that mode, with `hidden` cleared. omp returns the same row object while its own segments are unchanged, so the decorated row is memoized per mode on that object and omp's row is never mutated. Each mode gets its own component, since omp skips a component described twice in one frame. Store and exit changes call each describing mode's `ui.requestRender`, because omp does not watch the store. A reshaped omp fails loading or describing with a requalify error. Rejected: CSS that fuses a separate widget row into the capsule (it must take over omp-todo-more's dock grid, stylesheet order becomes the authority, and it fails without a plugin); keeping a separate pill and only fixing its placement; registering sessions as omp background jobs (the count would merge into jobs and drop exited sessions, omp would deliver job results to the agent beside this extension's wakes, sessions would take omp's job capacity, and that view cannot open a terminal page). |
| View = omp's Background jobs view, with its roles | omp's jobs panel (`packages/tui/src/overlays/jobs-panel.ts`) is a custom overlay whose `nativeOverlay` is `{ role: "omp.overlay.jobs", size: "lg", anchor: "center", head }` and whose body is a `col` of a row `omp.jobs.split` (col `omp.jobs.master` holding a `list` with `click: select, dblclick: activate`; col `omp.jobs.detail`) over an `omp.actions` footer (`omp.jobs.summary`, spacer, Close `esc`), or `omp.jobs.empty` and Close. Tern's layout rules for it are all scoped under `.sf-overlay[data-role='omp.overlay.jobs']`, and neither Tern nor omp keys behavior on these roles, so the Terminals view reuses the root and inner roles to get the same layout in every theme and chat style without a plugin; own roles would need copied CSS, which exists only with a plugin and drifts with Tern ([#77](https://github.com/oh-my-omp/omp-unified-exec/issues/77)). The header icon comes from the role, so it is the jobs icon. List items (key `s<id>`) show a terminal icon, the one-line command in mono, the elapsed time, and the state tone (`pending` while running, `success` after exit 0 with no signal or failure, `error` otherwise). The detail's status row holds the state (`●` pulsing Running, `✓ Exit 0`, `✕` Exit N / signal / Failed / Exited), an `elapsed` ticking Tern-side while running and stopped at the session's own exit time (`ExecSession.exitedAt`), `exec · #id`, Kill (`x`, only while running) and Open (`enter`, also a row's activate or double click); then the whole command as a `bash` code block, the facts Directory (home as `~`), PID (when known), Size, Started and the linked Log, and Output. The view re-describes every second while a session runs so list ages advance, as omp's jobs view does. Kill runs `terminateSessionById` (SIGTERM, then SIGKILL after 2s), the path `kill_session` and `/unified-exec-sessions` use; a confirmed exit removes the session from the store and its row from the list. These roles are a presentation dependency on Tern 0.9.5 / omp 18.12.5, requalified on upgrades. Rejected: merging Open into an interactive Output (↑/↓, `x` and Enter are view keys; the page forwards every key but Esc). |
| Terminal page = a `full` overlay framed as omp's Console | omp's own terminal window is the Console overlay its bash tool opens with `pty: true`: `ui.custom` with `nativeOverlay { role: "omp.overlay.console", size: "full" }`, the PTY screen as `ansi`, keys forwarded to the process, and an action bar. Open closes the Terminals view and opens the page the same way, with that role so Tern's `omp.overlay.*` frame, face and head rules apply (head `Terminals · #id command state`); its body is a column filling the overlay (`min.h` 1) holding the session's history and screen as `ansi` at the session's own width, which grows into the height the action bar leaves (`grow` 1, `max.h` 1, a fraction of the available height) and follows the newest row, and the action bar with Kill (while running) and Back (`esc`) pinned at the bottom. Back, Esc and Tern's `close` reopen the Terminals view on the same session; at most one of the two is open. Typed keys go to the running session through `ExecSession.write`, as `write_stdin` writes, so the model's next observation sees their effect (owner's choice); Esc is kept for Back. The PTY keeps the size the model's session started with. Rejected: a `max.h` in rows computed from the pane's rows less the overlay's chrome, which left the action bar floating above empty space. |
| Output and page screen = `ansi` of the retained history and screen | `ansi` keeps the colors and follows the newest row. Its text is the session's retained history plus the current screen (the alternate screen has no history), so its scrollbar scrolls back through the terminal's history. The view's Output is that same text as `ansi` with role `omp.jobs.output`, `max.h: "16lines"` and `follow` only while running, as the jobs view shows a job's output, without `cols`: rows wider than the detail wrap there, and Open shows the session at its own width. A screen with no visible characters shows `No output yet` (running) or `No output` (exited) with role `omp.jobs.nooutput`. |
| HUD colors from cell attributes | `TerminalScreen.styledScreen()` writes SGR for palette/256/RGB colors and bold, dim, italic, underline, blink, inverse, invisible, strikethrough and overline. Child OSC, cursor and mode sequences cannot pass, because nothing is copied from the byte stream. |
| Answer OSC 10/11 with the host's appearance | xterm answers DSR and DA1 itself but not default-colour queries. The emulator answers `?` inside the parse, before a following DA1, with white on black for a dark host and black on white for a light one. Appearance is read at each query from omp's theme (`isLightTheme(getCurrentThemeName())` from `@oh-my-pi/pi-tui/theme`, loaded with the other omp modules so a reshaped omp fails plugin loading). Colour sets (`OSC 11;rgb:…`) are ignored. |
| Screenshot cells through the host rasterizer and read pipeline | Each active grid becomes an in-memory SVG with XML-safe, individually positioned glyphs on an 8×16 logical cell grid, then `@oh-my-pi/pi-natives.rasterizeSvg` produces PNG bytes. Uniform scaling keeps the entire grid within 16,777,216 pixels. A file-backed handler locates a fresh private PNG; non-image targets still resolve as text. No image dependency with install scripts, second parser, screenshot cache or new tool-result option is introduced. |
| Retain successful screenshot files for OS cleanup | The host opens a located file after the plugin returns and supplies no read-complete acknowledgement. Each read therefore writes an exclusive 0600 PNG in a private temporary directory; failed writes clean their directory, successful files remain for OS cleanup like logs. Repeated screenshots consume disk space; a timer or overwrite-per-key would race readers. |
| Decorate only while an interactive session renders natively | omp's `isNativeRendering`/`onNativeRenderingChange` (`@oh-my-pi/pi-tui/native/state`) and `session_start`/`session_shutdown` with a UI gate the decorator, so the ANSI TUI's pill line never gains a segment. A missing module fails omp plugin loading before anything registers, like the bash renderer. |
| Watch screens only while the sheet or page is open | The segment re-describes on store membership and session exits only; the open sheet or page watches every listed session's exit (its dot or state) and only the shown session's parsed-output notifications, and each re-description reads the current screens, so a closed HUD costs nothing per chunk. |

## Implementation map

| Area | Location |
|---|---|
| Terminal-control scanner | `src/output-safety.ts` (`sanitizeOutputText`) |
| Terminal emulator, serialized observations/projections/disposal, snapshots, styled screens, parse notifications | `src/terminal-screen.ts`, owned by `ExecSession` (`src/session.ts`); session-owned freeze after output closure, release from `src/session-store.ts` |
| Process-global terminal keys, live/frozen projections, physical paging and omp internal URL handler | `fork-features/terminal-resource.ts`, `fork-features/terminal-url.ts`; initialized by `withHostPresentation` before activation |
| Terminal cell SVG, host PNG rasterization and file-backed image location | `fork-features/terminal-image.ts`, `fork-features/terminal-url.ts` |
| Non-consuming monitor rows, bounded notifications and End/wake routing | `TerminalScreen.subscribeLines`, `ExecSession.subscribeMonitor`, `fork-features/monitor-subscription.ts`, `src/completion.ts`; lifecycle in IV-0001 |
| Session membership notifications | `SessionStore.subscribe` in `src/session-store.ts` |
| Shared output envelope, truncation, incremental/final terminal metadata and process/kill text | `src/tool-result.ts`; `CollectResult` (`screen`, `final-screen`, `none`) in `src/collect.ts`, produced by `ExecSession.collect` (final screens from the frozen projection) |
| Structured tool schemas and projections | `src/script-result.ts`, `tests/script-result.test.ts` |
| Kill collection, partial sanitization, and tool registration | `src/index.ts` (`TerminateOutcome`, `buildStreamUpdate`, `kill_session`) |
| omp/Bun host admission, bash-renderer delegation, result/args display adapters | `src/pty.ts` (`requireBunRuntime`), `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`; wired by `withHostPresentation` in `src/index.ts`; tests `tests/pty-load.test.ts`, `tests/omp-presentation.test.ts` |
| Tern terminal HUD: terminals segment in omp's pill (process-wide `describeHudPills` wrapper and activation decorator), Terminals view with omp's jobs roles, Console-framed terminal page, session/native gate | `fork-features/tern-terminal-hud.ts` (`loadTernHudHost`, `mountTerminalHud`, `describeTerminalsSheet`, `VIEW_FRAME`), mounted by `withHostPresentation` with the store and kill `activate` returns; `ExecSession.exitedAt` in `src/session.ts`; tests `tests/tern-terminal-hud.test.ts` |
| Removal of the Tern plugin earlier versions installed | `retireTernPlugin` / `removeTernPlugin` in `fork-features/tern-plugin-removal.ts`, awaited by `withHostPresentation` during omp factory initialization; tests `tests/tern-plugin-removal.test.ts` against the stateful CLI simulator `tests/fixtures/tern-cli.mjs` |
| Pure output and terminal-safety tests | `tests/{tool-result,output-safety}.test.ts` |
| Real delayed noisy-kill regression | `tests/e2e.test.ts` |
| Package/runtime compatibility | `package.json`, `package-lock.json`, `.github/workflows/ci.yml` |
| Public behavior and development guidance | `README.md`, `docs/DEV.md`, `Changelog.md` |

## Related upstream issues

These are design evidence rather than a direct tracker for this repository,
whose GitHub issues are intentionally disabled:

- [earendil-works/pi#31](https://github.com/earendil-works/pi/issues/31) —
  tool expansion through `app.tools.expand`.
- [#134](https://github.com/earendil-works/pi/issues/134) — bounded model
  output, visible warnings, and full-output recovery.
- [#275](https://github.com/earendil-works/pi/issues/275) — visual-line rather
  than logical-line previews.
- [#1795](https://github.com/earendil-works/pi/issues/1795) and
  [#5137](https://github.com/earendil-works/pi/issues/5137) — live TUI flooding
  and fallback/custom-tool output.
- [#6548](https://github.com/earendil-works/pi/issues/6548) — configured key
  hints in bounded previews.
- [#7578](https://github.com/earendil-works/pi/issues/7578) — exact failure
  class where a custom tool ignores the expanded flag.
- [#7237](https://github.com/earendil-works/pi/issues/7237) — related archive
  quota/failure concerns tracked below.

## Evidence and reproduction

Tern qualification starts from a real window, not `tern serve` (which does
not load plugins), with isolated state. Copy the operator's `settings.json`
into an isolated `TERN_CONFIG_DIR`, keep a separate `TERN_DAEMON_SOCKET`
(plugin `list`/`install`/`remove` read the operator's daemon unless both are
set), and launch the window from a directory under `/tmp` (screenshots land in
`target/shots/tern/live/` under the window process's cwd):

```bash
TERN_CONFIG_DIR=$D/config TERN_DAEMON_SOCKET=$D/daemon.sock \
  /Applications/Tern.app/Contents/MacOS/tern --control $D/control.sock $D
# scenario command in that window's pane:
run "omp --no-extensions -e /ABSOLUTE/CHECKOUT/src/index.ts --no-session --no-title"
```

With the extension loaded, `tern plugin list --json` (both variables set) must
not list `omp-unified-exec`: the extension removes the plugin earlier versions
installed. To exercise that removal, install the 0.14.7 plugin directory
(`git archive` of `fork-features/tern-plugin` from a pre-#77 commit) into the
isolated config before launching, and confirm it is gone once omp has
loaded. For the operator's setup, also install omp-todo-more's Tern plugin and load
its extension with a second `-e`. Switch chat styles with `palette "Chat
style: Reader"` (Spine, Console) and appearance with `palette "Dark
appearance"` / `"Light appearance"`, each followed by `key Enter`;
`theme dark NAME` only picks the dark theme, so confirm the dump header's
`theme`. A tiling window manager can pin the window size: float the test
window before `resize`, and read the real viewport from `tern ctl stats`.

Use the real omp input to start `cat` and `sleep 600` with
`yield_time_ms: 1000`, an async `bash` `sleep 900` and a background subagent.
`tern ctl dump '[data-role^="omp.hud"]'` reports runtime rectangles and
fonts; identify segments by their users/job/terminal icons. Check one
`omp.hud` row and one `omp.hud.pill` whose last `omp.hud.seg` is the terminal
count, equal segment heights and fonts, and Tern's divider at the terminal
segment's left edge (scan ±3 px of each boundary in a 2x crop; the dump does
not expose radius, border or `::before`). Click the terminal segment; Close
and Esc must leave both processes alive. Kill sleep from the list: only its
confirmed exit removes its row and changes 2 to 1. Open cat, type
`hello-from-tern` and Enter, observe the actual echo, then Kill from its page:
await exit/removal, and once exited sessions are drained the segment leaves
while agents and jobs still open their sheets. Starting another session must
immediately show 1, with only that segment in a shown pill when omp has no
agents or jobs. List `x` remains Kill and is also covered by the real-session
automated tests.

OSC 10/11 qualification, 2026-10-12, macOS arm64 / omp 18.10.1, isolated real
window: an omp started in a tty session and opened on the terminal page drew
omp's light palette on the light page (it had drawn black message and
thinking blocks before the emulator answered OSC 11).

Pill-group qualification, 2026-10-22, macOS arm64, Tern 0.9.5 / omp 18.12.5,
operator fonts, `issue-76-pill-segment@03a1742`
([#76](https://github.com/oh-my-omp/omp-unified-exec/issues/76)). Before the
change, survey runs in Reader, Spine and Console with light-dawn and dark-nord
found the terminal counter a separate capsule on another `omp.hud` row in
every case; without Tern plugins and with omp-todo-more it sat below the
composer (Reader with omp-todo-more at 1100×850: native pill y 648, terminal
pill y 801), because omp-todo-more's dock grid made the moved container
`display: contents`. After the change, two isolated real windows (no Tern
plugin; omp-todo-more extension and plugin) each covered Reader, Spine and
Console × light-dawn/dark-nord at 1100×850 and each style at 700×850 with an
agent, background jobs and two sessions. All 18 cells had one `omp.hud` row
and one pill ordered agents 1, jobs 2, terminals 2, with equal segment heights
and fonts (Reader/Spine 18.47 px, 10.6154 px weight 500; Console 16 px, 12 px
weight 400) and the pill above the composer, omp-todo-more's own HUD still in
its activity track. The terminal boundary painted Tern's divider in every
cell (RGB delta 18 light, 15 dark). In Reader light at 700 px, both windows
showed no painted line at the native agents|jobs boundary (x 588.984, device
fraction 0.969); draining the terminals moved that boundary to x 625.688
(fraction 0.375), where it painted. Tern's 1px divider therefore depends on
the boundary's sub-pixel position, not on the terminal segment. Clicking the
segment opened the Terminals sheet, Esc kept the sessions, list `x` changed 2
to 1, draining the last session removed the segment while Agents and
Background jobs still opened, and a lone new session showed a visible pill
holding only its segment. Evidence is under `/tmp/tern-76-verify/`
(`*/shots/*.png`, `*.dump.json`, `divider-pixel-evidence.json`,
`narrow-native-control.json`).

Jobs-view qualification, 2026-10-22, macOS arm64, Tern 0.9.5 / omp 18.12.5,
operator fonts, `issue-77-jobs-view@ddedaf5`
([#77](https://github.com/oh-my-omp/omp-unified-exec/issues/77)), isolated
real windows with no Tern plugin (`plugin list` empty). At 1200×900 with the
file tree open, the Terminals view and the native Background jobs view in the
same window measured card 886.16, master 295.59 and detail 590.56 in Reader,
Spine and Console × light/dark (difference 0.00), with the same header heights
(48.00 / 40.61 / 36.92), Console's flush master list and mono typography; at
900×900 both stacked master above detail at 631.84. A colored loop's Output
was `ansi` that advanced from line-33 to line-43 within a fixed 256 px
viewport; an exited `sleep 3; echo done` showed `✓ Exit 0` with its age frozen
at 3.0s. The page matched omp's own `bash` `pty: true` Console overlay in all
three styles: role `omp.overlay.console`, classes `sf-overlay sz-full
at-bottom modal`, card 939.23×832.31 and the same head typography and face.
↑/↓ and clicks moved the detail, `x` removed only the running sleep, `x` on an
exited session changed nothing and showed no Kill, Enter opened cat and
`hello` echoed twice, Esc returned to the view and Esc closed it with the
sessions alive; after draining the exited session and killing cat, the view
showed `No terminals`, its note and Close only, and the segment left the pill.
A config holding the 0.14.7 plugin copy (listed `ready`) listed no plugins
after the extension loaded; a linked 0.14.7 plugin was unlinked by a headless
load, its `.path` gone and the linked directory intact; a further load with
nothing installed succeeded. Evidence is under `/tmp/tern-77-verify/`.

Current automated qualification runs strict types and the full suite through
`npm test` (Bun's native runner). Real PTY suites are mandatory, including:

```bash
bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

These cover list Kill/x, terminal-page echo and Kill, native resume and
last-tty removal; `tests/tern-plugin-removal.test.ts` covers the old-plugin
removal against a stateful simulator of Tern's `plugin list/remove/unlink`.


Automated gate:

```bash
npm test
```

The focused process regression:

1. starts a command that yields before producing output;
2. emits 4000 long lines and then remains alive;
3. waits until the final line reaches the log;
4. calls `kill_session`;
5. asserts `details.output` is at most the byte cap and no taller than the
   terminal, shows line 4000, carries no `final_output`, and that the log holds
   every line from 1 through 4000 (counted by content, since ConPTY prefixes
   the first lines with its own control sequences).

Pure output tests additionally exercise CSI/SGR mode changes, OSC
clipboard/title writes, terminal strings, C0/C1 controls and unterminated
sequences. Omp presentation tests cover persisted legacy details, partial
results, failures, bounded output and recovery markers. Exercise collapse
and expansion through omp's own binding in the real ANSI TUI and Tern.

## Consumers

- omp model turns using the unified-exec tools.
- Humans reviewing streaming and settled tool rows in omp's ANSI TUI and Tern
  frontend; exact PTY logs must be opened through a non-executing reader/escape
  visualizer, not `cat`.
- Humans glancing at live session screens in the Tern terminal HUD.
- Persisted session entries containing tool result details.
- Private path-based adoption in `piagent-config`, whose lifecycle owner links
  this public initiative.

## Follow-up backlog

### Output archive safety

The current session log is complete but unbounded and relies on OS `/tmp`
cleanup. A separate initiative should decide and test:

- a configurable per-session archive cap with explicit unlimited opt-in;
- `log_status: complete | partial | unavailable`, bytes written, and bounded
  failure evidence;
- private (`0600`) exclusive creation with symlink/collision resistance and a
  documented trust boundary for `TMPDIR`;
- withholding the phrase “Full output” whenever archival degraded;
- prefix-scoped age/size cleanup; and
- quota, synchronous-open, asynchronous-write, close, and cleanup races.

Likely implementation location: a new `src/output-archive.ts` owned by
`ExecSession`.

### Existing lifecycle work

Wake TTL/human disarm UX and Windows Job Object ownership remain in their
existing backlogs; they do not weaken this output contract.

## Non-goals

- No async full-log viewer in a tool row.
- No child ANSI styling in result text or omp tool rows; the raw log is the
  complete-stream recovery surface. The Tern HUD and explicit terminal images
  show colours re-encoded from emulator cells, never the child's bytes.
- No input from the Tern HUD to sessions beyond the terminal page's typed keys
  and Kill; neither is model-visible except through the session's own output
  and exit.
- No output-size parameter or screenshot option on exec/write/kill.
- Process signaling and kill escalation remain unchanged; monitor interaction
  with optional completion wakes follows IV-0001.
- No archive cap or deletion policy in 0.9.0.

## Retirement conditions

Before replacing this contract, prove the successor keeps model-visible output
bounded independently of rendering, keeps terminal state inert, preserves
complete/degraded recovery truthfully, honors omp's configured expansion state,
and retains failed-process ownership. Remove this IV only after its tests and
consumers move with that replacement.
