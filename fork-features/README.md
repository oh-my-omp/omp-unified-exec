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
| Only omp is supported: non-omp hosts are rejected at the extension factory before activation | `fork-features/omp-presentation.ts`, `src/index.ts`, `tests/omp-presentation.test.ts`; `package.json` `omp.extensions` | `ExtensionAPI.arktype` identifies omp. The named `activate` export is the direct tool-core test seam, not another supported host entry point. | Fork-only |
| Bun-only native PTY backend and test runner | `src/pty.ts`, `fork-features/omp-presentation.ts`, `tests/pty-load.test.ts`, `tests/bun-pty-runtime.mjs`, `package.json`, `.github/workflows/ci.yml` | omp is a compiled Bun executable. Every session uses `Bun.Terminal` (Bun 1.4+), supplying `openpty` on Linux/macOS and ConPTY on Windows. The factory requires `Bun.spawn` and `Bun.Terminal` before loading omp modules or activating; Bun's native test runner exercises the full suite on all three platforms, plus source/compiled runtime fixtures. | Fork-only |
| omp presentation: exec_command, write_stdin and kill_session render through omp's bash renderer; other tools use omp's default card | `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`, `tests/omp-presentation.test.ts`; `withHostPresentation` in `src/index.ts`; `fork-features` in `package.json` `files` and `tsconfig.json` | omp owns `renderCall`/`renderResult` and Tern's `describeCall`/`describeResult`. Display-only adapters and input-preview helpers live together in `omp-presentation.ts`; the bash renderer comes from `@oh-my-pi/pi-tui/tools` `toolRenderers.bash`, and a missing contract fails plugin loading. | Fork-only |
| Tern terminal HUD: a terminals segment (terminal icon and stored session count) inside omp's own running-work pill, after its agents and jobs segments; clicking it opens the Terminals view, built like omp's Background jobs view (sessions as a master list with icon, command and elapsed time; the selected session's status row with Kill and Open, command, facts and coloured output; running/stored summary and Close); Open shows a full-pane terminal page framed like omp's Console, with typed keys sent to the session | `fork-features/tern-terminal-hud.ts`, `fork-features/tern-plugin-removal.ts`, `fork-features/omp-tools.d.ts`, `tests/tern-terminal-hud.test.ts`, `tests/tern-plugin-removal.test.ts`, `tests/fixtures/tern-cli.mjs`; `TerminalScreen.styledScreen`/`onChange` in `src/terminal-screen.ts`, `ExecSession.styledScreen`/`onScreenChange`/`exitedAt` in `src/session.ts`, `SessionStore.subscribe` in `src/session-store.ts`; `activate` in `src/index.ts` returns the store and a kill over `terminateSessionById` to `withHostPresentation` | A tool result shows a session's screen only as it was when that call returned ([#17](https://github.com/oh-my-omp/omp-unified-exec/issues/17)). omp has no API for pill segments ([#76](https://github.com/oh-my-omp/omp-unified-exec/issues/76)): the HUD wraps `InteractiveMode.prototype.describeHudPills` once per process (a `Symbol.for` registry holds the current activation's decorator) and appends one segment component per interactive mode as the pill's last child, creating and showing the pill when omp has none and never mutating omp's memoized row. The decorator is registered exactly while an interactive session renders natively; the segment shows while a session is stored, including naturally exited sessions not yet removed, and store or exit changes ask omp's TUI to render again. Tern owns the capsule, divider and Reader, Spine and Console geometry. The view and the page are custom overlays declaring omp's own roles ([#77](https://github.com/oh-my-omp/omp-unified-exec/issues/77)): `nativeOverlay` `omp.overlay.jobs` (lg, centered, head Terminals) with the jobs panel's `omp.jobs.*` role tree, and `omp.overlay.console` for the `full` page, so Tern's built-in styles draw both with no plugin; the components keep selection, keys, Open and Kill, and the page shows colored, scrollable `ansi` from retained history and the current screen ([#19](https://github.com/oh-my-omp/omp-unified-exec/issues/19)). The awaited omp factory removes the `omp-unified-exec` Tern plugin earlier versions installed (`plugin remove`, or `unlink` when Tern answers it is linked, confirmed by `plugin list`); missing Tern skips it, a failing Tern rejects loading. Only the page's typed keys and view/page Kill reach sessions; model-visible results stay plain text. | Fork-only |
| Process-unique terminal resources and `read term://` | `fork-features/terminal-resource.ts`, `fork-features/terminal-url.ts`, `src/terminal-screen.ts`, `src/session.ts`, `src/session-store.ts`, `src/tool-result.ts`, `src/script-result.ts`, `src/index.ts`; initialization in `omp-presentation.ts` | omp's `@oh-my-pi/pi-coding-agent/internal-urls` supplies the process-singleton `InternalUrlRouter.instance().register(handler)` seam. One `term` handler reads a `Symbol.for` shared index, with UUID-suffixed keys across activations/reloads. Physical-row projections never consume; the session freezes at output closure plus parser completion. Frozen rows and the copied active styled grid remain readable until process exit; shutdown only discards its own unfinished live resources. | Fork-only |
| Terminal screenshots through `read term://…/screen.png` | `fork-features/terminal-image.ts`, `fork-features/terminal-url.ts`, `fork-features/omp-tools.d.ts` | The host's `@oh-my-pi/pi-natives` root `rasterizeSvg(Uint8Array, maxWidthPx, maxHeightPx)` supplies system-font SVG rasterization without install scripts. A file-backed scheme's `locate()` hands the private PNG to production `read`; text paths return null and still resolve normally. Only copied emulator cells reach SVG. Live appearance/cursor and frozen appearance/no-cursor share K1's projection. | Fork-only |
| Future-output monitors and repeated follow-up wakes | `fork-features/monitor-subscription.ts`, `src/completion.ts`, `src/session.ts`, `src/terminal-screen.ts`, `src/index.ts`, `src/script-result.ts`, `tests/monitor.test.ts` | The source establishes a non-consuming future boundary; the completion coordinator owns actual subscriptions and merges End with ordinary wake. The existing `pi.sendMessage` seam delivers `unified-exec-monitor` with `display:true`, `triggerTurn:true`, `deliverAs:"followUp"`; the tool and messages retain host-default presentation. | Fork-only |
| PTY-only `exec_command`: every session runs in a PTY; the pipe backend, `tty` parameter/result field, in-memory raw-output retention, pipe monitor decoding and the flag removing host `bash` are deleted | `src/pty.ts`, `src/session.ts`, `src/collect.ts`, `src/long-wait.ts`, `src/output-safety.ts`, `src/index.ts`, `src/shell.ts`, `src/tool-result.ts`, `src/script-result.ts`, `src/terminal-screen.ts`, `fork-features/monitor-subscription.ts`, `fork-features/terminal-resource.ts`, `fork-features/tern-terminal-hud.ts`, `fork-features/omp-presentation.ts` | A pipe session kept stdin open indefinitely and duplicated host `bash` without its approval, direnv, Git Guard, auto-backgrounding and output shaping ([#61](https://github.com/oh-my-omp/omp-unified-exec/issues/61)). PTYs bound each read to rendered screen state, flush interactive output promptly and route Ctrl-C through the foreground process group. Short commands stay with host `bash`; writes append nothing, PowerShell uses `-NoProfile -NoLogo -Command`, missing PTY backends fail explicitly, and exited processes never restart. | Fork-only |
| Shell selection follows the host: an explicit `shell`, then omp's live `shellPath`, then `SHELL`, then the platform default; results, streaming updates, kill results and session listings name the executable actually spawned | `fork-features/omp-presentation.ts` (`loadOmpShellPath`, passed to `activate` by `withHostPresentation`), `fork-features/omp-tools.d.ts`; `resolveDefaultShell` in `src/shell.ts`; shell resolution in `runExecCommand` and `activate` in `src/index.ts`; `ExecSession.shell` in `src/session.ts`; `shell` in `src/tool-result.ts` and `src/script-result.ts`; `tests/shell.test.ts`, `tests/e2e.test.ts` | Upstream hard-wired `bash` on POSIX and probed Windows itself, so omp's configured or login shell could differ from the shell that ran a command, and results did not say which one ran ([#63](https://github.com/oh-my-omp/omp-unified-exec/issues/63)). omp owns `shellPath`: `@oh-my-pi/pi-coding-agent/config/registry` exposes `lookup("shellPath").get(host.pi.settings)`. The admitted factory loads it with the other omp modules; each new process reads the effective setting through that getter, never an activation-time copy. A reshaped registry fails plugin loading. Shell resolution precedes argv construction, with no lower-priority fallback after failure. `ExecSession.shell` reads `command[0]`, so later results retain the spawned executable. Command text is not translated: cmd and PowerShell keep their argv; every other shell gets `-c`. | Fork-only |
| Command approval and host session binding ([#29](https://github.com/oh-my-omp/omp-unified-exec/issues/29)) | `fork-features/command-approval.ts`, `fork-features/session-binding.ts`, `fork-features/omp-presentation.ts`, `fork-features/omp-tools.d.ts`, `src/index.ts`, `tests/command-approval.test.ts` | `exec_command` checks raw `cmd` through the built-in bash decision logic before execution. Its first `session_start` binds `AgentRegistry.global().get(ctx.agent.id)?.session` with `sessionManager` identity; switches/branches only recheck. Every approval reads that actual session's live settings, never global settings or cwd. Unbound returns bare `exec` without settings access and does not disable execution. Other tools retain host-default approval. | Fork-only |
| `gh` mutations through `exec_command` invalidate omp's `issue://` / `pr://` view cache before the PTY starts ([#32](https://github.com/oh-my-omp/omp-unified-exec/issues/32)) | `fork-features/omp-presentation.ts` (`loadGithubCacheInvalidation`), `fork-features/omp-tools.d.ts`; `runExecCommand` and `activate` in `src/index.ts` | Interactive `gh` mutations (merge confirmations, comment editors) need a terminal and therefore run through `exec_command`, which the host bash's invalidation never saw. The factory imports omp's `tools/gh-cache-invalidation.invalidateGithubCacheForBashCommand` and calls it with the raw `cmd` before spawning, as `BashTool.execute` does; the detector and the SQLite cache stay host-owned. On omp upgrades, requalify that this export still exists and that a `gh issue close` through `exec_command` makes the next `issue://` read refetch. | Fork-only |
| Input-only `write_stdin`; zero-byte polling and its deadline/configuration paths are deleted ([#44](https://github.com/oh-my-omp/omp-unified-exec/issues/44)) | `src/index.ts`, `src/completion.ts`, `src/long-wait.ts`, `src/format-time.ts`, `src/tool-result.ts`, `src/script-result.ts`, `fork-features/omp-presentation.ts`; deleted `src/time.ts` | Reads obtain state/content through `term://`; monitor waits for events or completion; writes require nonempty decoded input and otherwise return typed `empty_poll_removed` without observation. Completion wakes point to each terminal's read address; input attachment and human-explicit wake policy remain unchanged. | Fork-only |

Existing tool names and retained environment variables (`PI_UNIFIED_EXEC_*`)
keep their names. Modules used only for deleted paths are removed rather than
retained as compatibility shims.

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

The plugin host and PTY backend are Bun-only; keep the deletion when upstream
changes its Node PTY backend rather than restoring that path.

Upstream's v0.13 steer gate (`src/steer-gate.ts`, `wait_status:
"interrupted_by_steer"`, `PI_UNIFIED_EXEC_STEER_INTERRUPT`; upstream
`d393051`, `f5e5d96`, `1baa416`) is not adopted: it was merged with the
`ours` strategy ([PR #1](https://github.com/oh-my-omp/omp-unified-exec/pull/1)).
This fork targets omp, whose extension context carries no steering signal.
Zero-byte polling, `yield_until` and the associated environment limit are
deleted in favour of `read term://` and `monitor`
([#44](https://github.com/oh-my-omp/omp-unified-exec/issues/44)). Upstream
changes to those paths or steer waits arrive as modify/delete or content
conflicts; keep the deletion and do not restore their parameters, configuration
or waiting helpers.

Shell selection follows the host here ([#63](https://github.com/oh-my-omp/omp-unified-exec/issues/63)):
upstream's `resolveDefaultShell` returns `bash` on POSIX, its `shell`
parameter text says so, and its spawn options record the raw `shell`
argument. Upstream changes there arrive as content conflicts in
`src/shell.ts`, `src/index.ts` and `src/session.ts`. Keep the precedence
(explicit `shell`, omp `shellPath`, `SHELL`, platform default), resolution
before `buildShellCommand`, and `ExecSession.shell` as `command[0]`; port
upstream fixes to the Windows Git Bash/PowerShell probe into the platform
default branch only, and never add a fallback after a selected shell fails.

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

On omp upgrades, requalify the shell bridge: `@oh-my-pi/pi-coding-agent/config/registry`
must still export `lookup`, and `lookup("shellPath").get(host.pi.settings)` must
still return omp's effective setting as a string or undefined. Through real
interactive omp, a `shellPath` overlay must outrank `SHELL` and an explicit
`shell` must outrank both; an explicit `shell` that does not exist must
return `spawn … ENOENT` and no output rather than another shell (omp itself
rejects a missing `shellPath` at startup, before the extension loads); later input writes, kills and listings must repeat the session's shell;
and the default `workdir` must still follow omp's cwd.

Command approval is ported from
[`can1357/oh-my-pi@57b56631ee009098a78d9badf91afc3a48eef32e`](https://github.com/can1357/oh-my-pi/blob/57b56631ee009098a78d9badf91afc3a48eef32e/packages/coding-agent/src/tools/bash.ts),
`packages/coding-agent/src/tools/bash.ts` (internal rule helpers and
`BashTool.approval` / `formatApprovalDetails`). Differences are argument name
`cmd`, explicit bound-session settings, injected host helpers, and typed
boundary parsing; rule ordering and every compound/critical branch are retained.
The POSIX-shell predicate is copied from `packages/utils/src/procmgr.ts`.
Factory loading imports root `AgentRegistry` / `CRITICAL_BASH_PATTERNS`,
`exec/settings`'s `cfgBashPatterns` / `cfgBashAllowCompoundCommands`,
`tools/shell-tokenize`'s `tokenizeShellSegments` /
`extractLiteralAndChainSegments`, and `tools/approval`'s `truncateForPrompt`.
Missing exports reject plugin loading; synchronous approval imports nothing.

On omp upgrades, compare the port with the current built-in functions, then
run real omp comparisons with compound approval both off and on: ordered
first-match, whole-chain restrictions, all-segments-allow, deny/prompt/critical
precedence, and display truncation. Requalify the internal session interface:
registry registration before `session_start`, `ctx.agent.id`, the exact
`sessionManager` identity, live `session.settings` and `getShellConfig().shell`;
switches/branches must retain the same session without registry lookup.
Create real child agents with distinct settings overlays and a private-registry
Unbound child; ensure pending/Unbound reads no settings and returns bare `exec`.
Verify the host's tool proxy and our presentation spread retain `approval` and
`formatApprovalDetails`, deny calls spawn nothing, and real TUI confirmation
shows the critical reason and `Command: …`. Only approval uses this binding;
PTY shell selection keeps its existing host bridge.


Host shell selection is also a fork customization meant to stay.

The package rename, fork README, omp-only host admission, native Bun PTY backend,
PTY-only `exec_command`, omp presentation and Tern terminal HUD are the fork customizations meant to stay. On
omp upgrades, requalify the omp presentation: `toolRenderers.bash` must still
expose `renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`
and accept `{command, cwd}` args and `{exitCode, wallTimeMs, async}` details.
Requalify the Tern HUD too: `@oh-my-pi/pi-tui/native/state` must still export
`isNativeRendering`/`onNativeRenderingChange`;
`@oh-my-pi/pi-coding-agent/modes/interactive-mode` must still export
`InteractiveMode` whose prototype `describeHudPills` returns an `omp.hud` row
holding at most one `omp.hud.pill` row (`hidden` when empty) and whose
instances keep `ui.requestRender`; omp's dock must still describe that row on
every native frame, describe a component child in a node's children in place
(no wrapper element) and route its events to that component's
`handleNativeEvent`, and Tern must still draw a divider between sibling
`omp.hud.seg` rows of one pill. A custom overlay's `nativeOverlay` role and
head must still reach Tern's overlay frame with `select`/`activate`/`action`
events and `handleInput` keys reaching the component; Tern must still scope
the Background jobs layout under `.sf-overlay[data-role='omp.overlay.jobs']`
with the `omp.jobs.*` inner roles (split, master, detail, status, state, age,
id, command, facts, out, label, output, nooutput, summary, empty) and key no
behavior on them, and draw `omp.overlay.console` as a full-pane overlay. In
Tern, a `full` overlay's `ansi` must still fill the height its action bar
leaves under `grow` and a fractional `max.h`, and scroll inside itself, and an
`ansi` with role `omp.jobs.output` must keep colors and follow its newest row
within `max.h: "16lines"`. On omp upgrades, package installation validation
must still await the extension factory and propagate its rejection; Tern's
`plugin list --json` (`plugins[].id`), `remove ID --json`, its exact
`is linked; use unlink` answer and `unlink ID --json` must retain their
contract for the old-plugin removal, with a 75-second timeout covering Tern's
60-second reload wait. Check
it in a real Tern window (`tern --control`, plugins load only in windows, not
in `tern serve`) with the owner's settings, isolated `TERN_CONFIG_DIR` and
`TERN_DAEMON_SOCKET`, a running turn, a background agent and a background
bash job, at 1100×850 and 700px width, in Reader, Spine and Console with a
light and a dark appearance (`palette "Dark appearance"`; `theme dark NAME`
only picks the dark theme), both with no Tern plugin and with omp-todo-more's
extension and Tern plugin. The terminals segment must be the last
`omp.hud.seg` of omp's single `omp.hud.pill`, with the same height and font as
the agents and jobs segments and Tern's segment divider at its left edge (Tern
drops that 1px line at some sub-pixel boundary positions, native boundaries
included; compare the boundary x with a native-only pill before blaming the
segment), and no
second `omp.hud` row. The Terminals view must
match the native Background jobs view's card, master and detail widths and
layout in the same window, and pick a session by click and ↑/↓. Kill and
`x` must end only the selected running session after confirmed exit; Open /
Enter must show the full-pane page at the session's full width, with retained
history still scrollable after model observations and typed keys reaching a
running `cat`. Esc / Back must return to the view; Close and Esc must leave
processes alive and the composer usable. Removing the last session removes the
segment; starting another session immediately adds it again. A Tern config
holding the old plugin must list no `omp-unified-exec` after loading.
