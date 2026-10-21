# omp-unified-exec fork

English | [简体中文](README.zh-CN.md)

Fork of [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) for
[oh-my-pi](https://github.com/can1357/oh-my-pi) (omp). omp forked from Pi in early
2026 and loads Pi packages through a compatibility layer that only covers part of
Pi's newer API, so upstream releases can stop loading on omp.

Install: `omp install https://github.com/oh-my-omp/omp-unified-exec`.
Remove an existing `pi-unified-exec` first (`omp plugin uninstall pi-unified-exec`):
both register `exec_command` and the other unified-exec tools.

## Customizations

| Change | Files | Why | Upstream |
|---|---|---|---|
| Package name `omp-unified-exec` | `package.json` (`name`, `repository`, `homepage`) | omp names the plugin after the package | Fork-only |
| README rewritten for the fork, in English and Chinese: omp install, Tern terminal HUD, omp presentation, fork layout; upstream's npm, badges and maintenance notice removed | `README.md`, `README.zh-CN.md` | The fork's behaviour and installation diverged from upstream's README (npm package, Pi-only presentation), so it misled omp users | Fork-only |
| Compact codemode fix reads `createCodemodeExtension` off the module namespace and stays off when the host lacks it | `src/codemode-render.ts`, `tests/codemode-render.test.ts` | Since 0.12.1 a named import of Pi's codemode factory fails to link on omp, which has no codemode; the whole package then fails plugin validation | Fork-only |
| Native Bun PTY backend with lazy Node fallback | `src/pty.ts`, `tests/bun-pty-runtime.mjs`, `.github/workflows/ci.yml` | omp is a `bun build --compile` executable and blocks dependency lifecycle scripts, so Node ABI prebuilds cannot provide a reliable PTY. Bun 1.4's `Bun.Terminal` supplies `openpty` on Linux/macOS and ConPTY on Windows; ordinary Node hosts retain the pinned @homebridge backend. | Fork-only |
| omp presentation: exec_command, write_stdin and kill_session render through omp's bash renderer; other tools use omp's default card | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`, `tests/omp-presentation.test.ts`; `withHostPresentation` in `src/index.ts`; `base64ByteLength`/`stringifyChars` exported from `src/render.ts`; `fork-features` in `package.json` `files` and `tsconfig.json` | omp calls extension renderers as `renderCall(args, options, theme)` / `renderResult(result, options, theme, args)` and Tern reads `describeCall`/`describeResult`; Pi's renderers threw on every repaint and omp showed the raw model envelope. omp is detected by its injected `ExtensionAPI.arktype`; the bash renderer comes from `@oh-my-pi/pi-tui/tools` `toolRenderers.bash`, and omp fails plugin loading if that contract is missing. Pi activation is unchanged. | Fork-only |
| Tern terminal HUD: a native running-work counter (terminal icon and stored session count), on its own line above omp's counter; clicking it opens the Terminals sheet, built like omp's Agents sheet (sessions with status dots and Size / PID / Time columns, the selected session's facts, log link and newest output rows as the preview, Kill, Close, Open); Open shows a full-pane terminal page built like omp's Console, with typed keys sent to the session | `fork-features/tern-terminal-hud.ts`, `fork-features/tern-plugin/`, `fork-features/tern-plugin-install.ts`, `fork-features/omp-tools.d.ts`, `tests/tern-terminal-hud.test.ts`, `tests/tern-plugin-install.test.ts`; `TerminalScreen.styledScreen`/`onChange` in `src/terminal-screen.ts`, `ExecSession.styledScreen`/`onScreenChange` in `src/session.ts`, `SessionStore.subscribe` in `src/session-store.ts`; `activate` in `src/index.ts` returns the store and a kill over `terminateSessionById` to `withHostPresentation`; `fork-features/tern-plugin` in `package.json` `files` | A tool result shows a session's screen only as it was when that call returned ([#17](https://github.com/oh-my-omp/omp-unified-exec/issues/17)). The widget mounts through `ctx.ui.setWidget` (`belowEditor`) exactly while native rendering is active and a session is stored, including naturally exited sessions not yet removed; there is no outer dismiss action or hidden lifecycle. Its row uses `omp.hud`, with `omp.hud.pill` / `omp.hud.seg`, so Tern owns its appearance and Reader, Spine and Console geometry. The CSS-only plugin moves the shared belowEditor container above omp's counter and clears its margin, padding, background and shadow; other co-located widgets share this placement and reset. It also sets the preview's `code` output (`unified-exec.terminals.tail`) in the mono face. The awaited omp factory synchronizes a normal Tern copy during install/force validation and ordinary loading; it verifies all three files and the ready catalog, automatically migrates confirmed legacy `.path` links through Tern's CLI, and fails loading if an available Tern cannot synchronize. No session-start installation or developer link remains. Without the plugin the pill sits below the composer. The sheet answers `nativeSheet` and uses a modal `picker`; the page declares a `full` `nativeOverlay` and shows colored, scrollable `ansi` from retained history and the current screen ([#19](https://github.com/oh-my-omp/omp-unified-exec/issues/19)). Only the page's typed keys and sheet/page Kill reach sessions; model-visible results stay plain text. | Fork-only |
| Process-unique terminal resources and `read term://` | `fork-features/terminal-resource.ts`, `fork-features/terminal-url.ts`, `src/terminal-screen.ts`, `src/session.ts`, `src/session-store.ts`, `src/tool-result.ts`, `src/script-result.ts`, `src/index.ts`; initialization in `omp-presentation.ts` | omp's `@oh-my-pi/pi-coding-agent/internal-urls` supplies the process-singleton `InternalUrlRouter.instance().register(handler)` seam. One `term` handler reads a `Symbol.for` shared index, with UUID-suffixed keys across activations/reloads. Physical-row projections never consume; the session freezes at output closure plus parser completion. Frozen rows and the copied active styled grid remain readable until process exit; shutdown only discards its own unfinished live resources. | Fork-only |
| Terminal screenshots through `read term://…/screen.png` | `fork-features/terminal-image.ts`, `fork-features/terminal-url.ts`, `fork-features/omp-tools.d.ts` | The host's `@oh-my-pi/pi-natives` root `rasterizeSvg(Uint8Array, maxWidthPx, maxHeightPx)` supplies system-font SVG rasterization without install scripts. A file-backed scheme's `locate()` hands the private PNG to production `read`; text paths return null and still resolve normally. Only copied emulator cells reach SVG. Live appearance/cursor and frozen appearance/no-cursor share K1's projection. | Fork-only |
| Future-output monitors and repeated follow-up wakes | `fork-features/monitor-subscription.ts`, `src/completion.ts`, `src/session.ts`, `src/terminal-screen.ts`, `src/index.ts`, `src/script-result.ts`, `tests/monitor.test.ts` | The source establishes a non-consuming future boundary; the completion coordinator owns actual subscriptions and merges End with ordinary wake. The existing `pi.sendMessage` seam delivers `unified-exec-monitor` with `display:true`, `triggerTurn:true`, `deliverAs:"followUp"`; the tool and messages retain host-default presentation. | Fork-only |
| PTY-only `exec_command`: every session runs in a PTY; the pipe backend, the `tty` parameter and result field, the 1 MiB in-memory retention with its omission marker, pipe monitor decoding and the flag that removed the host's `bash` are deleted. The host's `bash` stays active for short one-shot commands; `write_stdin` writes bytes verbatim; PowerShell runs as `-NoProfile -NoLogo -Command` | `src/pty.ts`, `src/session.ts`, `src/collect.ts`, `src/long-wait.ts`, `src/output-safety.ts`, `src/index.ts`, `src/shell.ts`, `src/tool-result.ts`, `src/script-result.ts`, `src/render.ts`, `src/terminal-screen.ts`, `fork-features/monitor-subscription.ts`, `fork-features/terminal-resource.ts`, `fork-features/tern-terminal-hud.ts`, `fork-features/omp-presentation.ts` | A non-PTY session was a shell whose stdin never reached EOF: programs reading stdin (`cat`, `head`, bare `python`, PowerShell `-Command`) waited forever, and the mode duplicated the host's `bash` without its approval, direnv, Git Guard, auto-backgrounding and output shaping ([#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)). A PTY folds output into a fixed-size screen, so every read is bounded and no command deadline is needed; programs flush per line, so monitors match in time; `\x03` reaches the foreground process group through the line discipline. Without a PTY backend `exec_command` fails at call time with the load reason. A process that exits is never restarted. | Fork-only |

Environment variables (`PI_UNIFIED_EXEC_*`) and existing tool names are unchanged,
and the source layout keeps upstream's paths except the deleted pipe backend, so
other omp plugins that import the remaining `src/*` modules keep working after the
path moves from `node_modules/pi-unified-exec` to `node_modules/omp-unified-exec`.

## Repository state

- `Publish to npm` and `Interaction limit reminder` are disabled with
  `gh workflow disable`: the fork publishes nothing to npm, and the reminder
  tracks upstream's own interaction limit. This is repo state, so syncing the
  workflow files back in does not re-enable them.
- `Sync upstream` (`.github/workflows/sync-upstream.yml`) merges `upstream/main`
  into `main` daily through PRs gated on `CI`.

## Expected sync conflict

`name` sits on the line next to `version`, and git treats edits to adjacent lines
as a conflict. Every upstream release bumps `version`, so its sync arrives as a
review PR. Resolve it by keeping `"name": "omp-unified-exec"` and taking upstream's
`version`.

`exec_command` is PTY-only here ([#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)):
the pipe backend (`spawnPipes`, the port of codex's head/tail buffer,
`collectOutputUntilDeadline`, the streaming `OutputTextSanitizer` and pipe
monitor decoding), the `tty` parameter and result field, and the flag that
removed the host's `bash` are deleted, and PowerShell runs as
`-NoProfile -NoLogo -Command`. Upstream changes to that code arrive as
modify/delete or content conflicts. Resolve them by keeping the deletion and
porting only facts that still hold for a PTY session (shell selection,
signals, Windows process trees, result fields) into the PTY code; do not
restore the pipe path, the `tty` parameter, the flag or pipe-only PowerShell
flags.

`README.md` and `README.zh-CN.md` are fork-owned. When a sync touches the
README, keep the fork's and carry over only upstream facts that still hold here
(tool parameters, limits, semantics), written into the fork's sections of both
files; the two stay section-for-section translations of each other, as do
`fork-features/README.md` and `fork-features/README.zh-CN.md`.

On omp upgrades, requalify `@oh-my-pi/pi-coding-agent/internal-urls`:
`InternalUrlRouter.instance().register(handler)` must share the production
`read` router; `getHandler("term")` must return the same mutable object, with
spec and methods consulted per request. The final handler uses
`{backing: "file", selectors: "lines", immutable: false}`: `locate()` returns
a path only for `/screen.png`, null for text. Read all retained rows, `/screen`,
positive/negative pages, head/tail and unknown-key/page errors through real
`read`; confirm child-agent same-number keys, post-exit/kill/LRU access and
two reloads preserve URLs without consuming observations or re-registering.
Requalify root `@oh-my-pi/pi-natives.rasterizeSvg`: PNG bytes, system-font CJK,
palette/RGB and attributes, the 16,777,216-pixel limit, and real `read` image
blocks. Check one live session across dark/light themes, frozen appearance,
Live outline cursor versus Frozen no cursor, and concurrent private PNG paths.
Successful screenshots rely on OS temporary-file cleanup, like logs, because
the path-only host API supplies no read-complete callback. Upgrading an already
running text-only handler requires one omp restart; final-version reloads do not.

Requalify monitor delivery through real RPC and interactive hosts: every
successful return must enqueue one follow-up and trigger a model turn without
an additional user prompt. Verify default/custom limits, batching, advisory,
last partial output, human/model termination, End/wake merging, rendered
prompts and redraws, and unchanged default-card/message styling in ANSI/Tern.


The package rename, fork README, codemode host guard, native Bun PTY backend,
PTY-only `exec_command`, omp presentation and Tern terminal HUD are the fork customizations meant to stay. On
omp upgrades, requalify the omp presentation: `toolRenderers.bash` must still
expose `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`
and accept `{command, cwd}` args and `{exitCode, wallTimeMs, async}` details.
Requalify the Tern HUD too: `@oh-my-pi/pi-tui/native/state` must still export
`isNativeRendering`/`onNativeRenderingChange`; a widget component's `describe`
must still reach Tern, `belowEditor` widgets must still get no spacer, and the
pill's `open` action must still reach the widget's `handleNativeEvent`; a
custom-overlay component answering `nativeSheet` must
still be mounted as its `picker` sheet with `select`/`activate`/`action`
events reaching it, a custom overlay with a `full` `nativeOverlay` must still
be drawn as a full-pane sheet whose `handleInput` receives typed keys, and
omp's counter must still use `omp.hud` / `omp.hud.pill` / `omp.hud.seg`.
On omp or Tern upgrades, the Tern plugin's selectors must still hold: the
shared `belowEditor` container is the dock's last `.sf-col.gap-none` child,
the empty container stays zero-size and never selects the editor, and the
native HUD rules match the nested terminal row in Reader, Spine and Console.
A `code` node's role must still reach its element with `.sf-code-lines`.
In Tern, a `full` sheet's `ansi` must still fill the height its action bar leaves under
`grow` and a fractional `max.h`, and scroll inside itself. On omp upgrades,
package installation validation must still await the extension factory after
materializing package assets, and propagate its rejection before reporting
success. Ordinary loading uses that same initializer; `session_start` has no
installation IO. Requalify missing/stale copies, same-version asset updates,
unchanged exact copies and legacy `.path` registrations through only
`omp plugin install URL --force`, checking Tern's copy before any session.
Tern's `plugin dir --json`, `list --json` (`id`, `version`, `css`, `status`),
`install DIR --force --json` (`id`, `version`, absolute `dir`) and
`unlink ID --json` must retain their contract. The exact linked-target
conflict plus a matching canonical registration and fresh catalog are
required before unlink; unrelated failures must never remove registrations.
The per-command timeout is 75 seconds, covering Tern's 60-second reload wait.
With no daemon, the copy must still install for next start. Missing Tern
skips initialization; an available but failing Tern rejects installation
validation and ordinary loading. Check
it in a real Tern window (`tern --control`, plugins load only in windows, not
in `tern serve`) with the owner's settings, a running turn, todos and a
background agent at 1280×800 and 700px width, in Reader, Spine and Console
with a light and a dark theme switched in the same live session.
Compare both counters' row and pill rects (right edges within 1px), fonts,
height, radius, border and hover; check Spine with the pane focused and
unfocused. With no session or other widget, every composer, meter and activity/
todo rect must match a plugin-free run and the empty container occupy no
height. With sessions, the terminal counter has only its icon and count,
no outer ✕, extra bottom spacing or Spine container plate. The Terminals sheet
must open like the Agents sheet and pick a session by click and ↑/↓. Kill and
`x` must end only the selected running session after confirmed exit; Open /
Enter must show the full-pane page at the session's full width, with retained
history still scrollable after model observations and typed keys reaching a
running `cat`. Esc / Back must return to the sheet; Close and Esc must leave
processes alive and the composer usable. Removing the last session unmounts the
counter; starting another session immediately mounts it again.
