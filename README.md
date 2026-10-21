# omp-unified-exec

English | [简体中文](README.zh-CN.md)

Long-lived terminal sessions for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp), with a terminal HUD in Tern. The host's `bash` keeps short one-shot
commands; long commands, interactive programs (REPLs, TUIs, `ssh`, `sudo`),
concurrent computation and dev-time daemons go to `exec_command`, which runs
each in a PTY session the model drives with writes and polls instead of a
single blocking call. Sessions keep running between turns, with no command
deadline, and a human can watch and type into them from Tern.

This is a fork of [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec),
a Pi port of codex's `unified_exec`. The original tools (`exec_command`,
`write_stdin`, `set_on_exit`, `kill_session`, `list_sessions`) retain their
session model; the fork runs every session in a PTY under the host's shell
setting, leaves short commands to the host's `bash`, and adds terminal
reads/images and `monitor` for omp. The full list
of fork changes, why each exists and how to requalify them on omp/Tern
upgrades is in [fork-features/README.md](fork-features/README.md).

## Install

```bash
omp install https://github.com/oh-my-omp/omp-unified-exec
```

Remove an existing `pi-unified-exec` first (`omp plugin uninstall
pi-unified-exec`): both register the same tools. The fork publishes nothing to
npm.

omp also installs the bundled Tern plugin as a normal copy when `tern` is on
PATH. Updates use the same command with `--force`:

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

The Tern update finishes before this command succeeds; no separate Tern
command or developer link is needed.

This plugin supports only omp running on Bun 1.4+ (omp is a compiled Bun
executable). Pi and other non-omp hosts fail immediately at the extension
factory with an explicit “only supports omp” error. Every session uses Bun's
native `Bun.Terminal`; a host without `Bun.spawn` and `Bun.Terminal` fails at
that same factory before omp modules load or any tools register.

## What it does

- **Sessions, not calls.** `exec_command` starts a process in a PTY and returns
  within its yield window with output so far and a `session_id`; on later turns
  `write_stdin` writes bytes to it verbatim (text, `\x03` Ctrl-C, arrow keys) or
  polls it. Cancelling a call never kills the process. There is no command
  deadline, and a process that exits is never restarted.
- **The host's shell.** Unless the call names a `shell`, commands run in omp's
  `shellPath` setting, else the environment's `SHELL`, else the platform
  default. Every result names the shell it started, so the model writes that
  shell's syntax.
- **Output is what a terminal shows.** Every session runs through a headless
  terminal emulator, so progress bars, redraws and full-screen programs return
  the current screen plus unseen history while running, not every redraw
  appended. Exited results contain only the final active screen;
  `terminal_url` recovers earlier retained rows. The emulator answers
  the terminal queries a real terminal would (cursor position, device
  attributes, default colours), so programs that wait for them, or pick a light
  or dark palette from them, behave as in a real terminal.
- **Bounded output, complete recovery.** Every result the model sees is
  tail-capped at 50 KiB / 2000 lines and stripped of terminal controls; the
  complete raw stream of every session is written to `log_path`.
- **Opt-in completion wake.** `on_exit: "wake"` resumes the agent once when a
  backgrounded process exits unobserved; `set_on_exit` disarms it.
- **Await matching output.** `monitor` watches an existing session without
  consuming output, wakes for matching batches or completion, and defaults to
  at most ten successful match returns.
- **omp-native presentation.** `exec_command`, `write_stdin` and
  `kill_session` render through omp's own bash card (command line, output,
  exit chip, error tone), in the ANSI TUI and in Tern alike.
- **A terminal HUD in Tern.** Watch, scroll back through, type into and kill
  the model's sessions without a tool call.

## Tern terminal HUD

When omp renders natively in Tern and a session exists:

- **Terminals segment.** A terminal icon and the stored session count join
  omp's own running-work pill, after its agents and jobs segments, in the same
  capsule; the hover label also gives how many still run. Tern draws the pill,
  its dividers and every chat style and color theme. Removing the last
  session removes the segment; with no agents or jobs either, the pill goes.
- **Terminals sheet.** Clicking the segment opens a sheet built like omp's Agents
  sheet: one row per session with a status dot, size, PID and running
  time; the selected session's command, state, directory, PID, size, start
  time, linked log path and newest output rows as the preview. ↑/↓ or a click
  picks a session, `x` / Kill ends it the way `kill_session` does, Esc / Close
  leaves.
- **Terminal page.** Enter / Open shows the session as a full-pane page built
  like omp's Console: its retained history and current screen in colour, at
  its own width, following new output and scrollable back. Typed keys go to
  the session (as `write_stdin` writes them, so the model sees their effect);
  Esc / Back returns to the sheet; Kill ends the session.

The HUD reads the sessions in place and keeps no copy of them. It only exists
while omp renders natively, so omp's ANSI TUI gains no row. Tool results stay
plain text; explicit `read term://…/screen.png` requests return images.

**How the segment joins omp's pill.** omp has no extension API for pill
segments, so the HUD wraps omp's `InteractiveMode.prototype.describeHudPills`
once per process and appends its own segment component as the pill's last
child, creating the pill when omp has none. omp's own row object is never
changed. A reloaded extension replaces the decorator rather than wrapping
again. If omp no longer has that method, or it returns a row of another
shape, loading or describing fails with a "requalify" error instead of
silently dropping the segment.

**The Tern plugin.** The package ships a CSS-only Tern plugin
(`fork-features/tern-plugin/`) that only sets the sheet's output preview in
the monospace face; the segment needs no plugin. The awaited omp extension
factory synchronizes this plugin during package-install validation, including
`install --force`, and during ordinary extension loading. It asks Tern for
its plugin directory and catalog; an exact three-file normal copy with the
current ready version and stylesheet is left unchanged. Missing or stale
files are updated with `tern plugin install <bundled-directory> --force`.
Known legacy `.path` registrations are migrated automatically through Tern's
own unlink and copy-install operations; no developer link is created.

The CLI inherits omp's environment, so Tern owns the destination and reload.
With no daemon running, Tern installs the copy for its next start. A missing
`tern` executable does not prevent non-Tern use. If Tern is present but
synchronization fails, package validation or ordinary extension loading
fails with command diagnostics; there is no deferred session-start retry or
success toast. Tern's external update is not rolled back if omp later fails
to save its package configuration. Without the plugin the preview's output
rows use the interface face.

Design, decisions and Tern qualification evidence:
[docs/IV-0002-output-lifecycle-and-rendering.md](docs/IV-0002-output-lifecycle-and-rendering.md).

## Tools

### `exec_command`

Runs a command in a persistent PTY session. Use it for long commands,
interactive programs (REPLs, TUIs, `ssh`, `sudo`), concurrent computation and
dev-time daemons; use the host's `bash` for short one-shot commands. There is no
command deadline, and nothing restarts a process that exits. Observe a session
with `write_stdin` polls, `monitor` and `read term://…`; its output is the
rendered terminal screen (see [Terminal output](#terminal-output)).

| Param | Type | Default | Notes |
|---|---|---|---|
| `cmd` | string | — | Shell command. Required. |
| `workdir` | string | host session cwd | Working directory. The default is read from the host for each call; a `cd` inside a session never changes it. A relative path resolves against that session cwd. A missing path or a non-directory fails with `Working directory does not exist: <path>` / `Working directory is not a directory: <path>` (the host bash's wording) and starts nothing. |
| `shell` | string | omp `shellPath`, else `SHELL`, else `bash` | Shell executable; see [Shell selection](#shell-selection). `cmd` / `powershell` / `pwsh` get shell-appropriate flags; every other shell gets `-c`. |
| `cols` | number | `120` | PTY width. Clamped to [20, 500]. |
| `rows` | number | `80` | PTY height. Clamped to [5, 300]. |
| `yield_time_ms` | number | `10_000` | How long this call stays attached waiting for output (not the command's lifetime), clamped to [250, 30_000]. |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | Policy for exits nobody is observing. `"wake"`: one follow-up prompt resumes the agent — only when the human explicitly wants auto-resume. Change later with `set_on_exit`. |

Response body (running, short output, no truncation):

```
[still running]                     (or [exited])
session_id: 1                       (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with session_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/pi-unified-exec-1-5cc5e104.log
terminal_url: term://1-9f2c1a7e-…
cwd: /home/you/project
shell: /bin/zsh                     (absolute path of the shell the session started with)
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn — compare across polls to detect stalls)
terminal: normal screen 120x80, cursor row 4 col 5
history_lines: 2                   (running, optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

When output exceeds the caps (50 KiB / 2000 lines), a footer is appended:

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-1-5cc5e104.log]
```

#### Command approval

Before starting a process, omp evaluates the original `cmd` with the same
approval logic as its built-in `bash`: ordered `bash.patterns` rules
(`allow`, `deny`, `prompt`), `bash.allowCompoundCommands`, and critical-command
patterns. A deny prevents execution; confirmation details show
`Command: <command>` (truncated only for display). An allow for `true` does
not allow `true && echo x` unless compound approval is enabled and every
segment is allowed. omp's approval mode still applies: in `yolo`, explicit
deny/prompt policies apply, but critical-pattern overrides alone do not ask.

Rules are read live from the calling session, including a child agent's
own settings overlay. The first `session_start` binds that session by agent
id and session-manager identity; switches and branches only recheck identity.
If binding is unavailable or fails, approval returns the host's default
`exec` tier without reading another session's settings; execution itself is
not disabled. Only `exec_command` adds this approval logic: input written
later with `write_stdin` is not reinterpreted as a new command for approval.

#### Shell selection

Each new process uses the first of these that is set; a blank `shellPath` or
`SHELL` counts as unset:

1. the call's `shell` argument;
2. the omp `shellPath` setting, read from omp's settings registry each
   time a process starts rather than copied at load;
3. `SHELL` from the environment;
4. the platform default: `bash`, or on Windows Git Bash with PowerShell last
   (see [Windows](#windows)).

The selected shell is resolved to an absolute executable path before the
process starts: a bare name through `PATH`, a relative path containing `/` or
`\` against the effective `workdir`. A selected shell that cannot be found or
started fails the call (`failure_message: spawn <file> ENOENT: …`, or on
Windows an error naming a shell that is not on `PATH`); the command never runs
under a lower-priority shell.

`cmd` (Windows) gets `/d /s /c` with its own quoting and `powershell` / `pwsh`
get `-NoProfile -NoLogo -Command`; every other shell runs as
`<shell> -c <cmd>`. The command text is passed unchanged, so write it in the
syntax of the shell the result names.

The result header, `details` and `structuredContent` carry the
resolved executable as `shell`: for short commands, started sessions and spawn
failures alike. `write_stdin` results, streaming updates, `kill_session`
results and `list_sessions` entries repeat the shell the session started
with; they never select again. The shell is metadata only and is never added
to `output`.

#### Terminal output

Every session feeds every byte its child writes, in order, into a headless
terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless))
of the session's `cols`×`rows`, and each result reports what that terminal
shows rather than the raw stream. Every read is therefore bounded by the screen
size; the raw stream goes only to `log_path`.

- **Running history plus screen.** Lines that scrolled off the top since the
  previous call and were not already reported come first, then the whole current
  screen. Carriage-return progress bars and redraws show their final state.
- **Unchanged running screen.** When neither the screen, the cursor nor the
  history changed, the result has `screen_changed: false` and `(no output)`.
- **Exit screen only.** Every completed result, including short commands and
  confirmed kills, returns the frozen final active screen even when unchanged.
  `terminal_url` stays at the result root; `terminal.retained_rows`,
  `terminal.rows` and `terminal.history_may_be_truncated` describe the retained
  normal-screen projection. Final metadata has no `screen_changed` or
  `history_lines`. The 50 KiB / 2000-line result cap still applies; read the URL's
  `/screen` for the complete screen and `/page/N` for earlier retained rows.
- **Full-screen programs** (alternate screen, e.g. `top`, editors) are reported
  as `terminal: alternate screen …`; leaving it restores the normal screen.
- **Plain text and cursor in tool results.** Colours stay out of exec/write/kill
  text; Tern's terminal page and explicit `read term://…/screen.png` show them.
- **Terminal queries are answered** on the child's input: cursor position and
  device attributes, and the default foreground/background colours (OSC 10/11).
  The colours follow omp's theme (light or dark, which in Tern follows
  Tern's appearance).
- History between calls is bounded by a cell budget (`TERMINAL_HISTORY_CELLS`
  divided by `cols` rows). Lines scrolled past it before a call reports them
  set `history_may_be_truncated: true`; they are only in the log.

#### Reading retained terminals on omp

Results and `list_sessions` include a process-unique `terminal_url`, such as
`term://3-9f2c1a7e-…`. The normal screen's retained history and screen remain
readable independently of result consumption:

| Read path | Content |
|---|---|
| `term://<key>` | All retained normal-screen physical rows, without trailing spaces or trailing empty rows. |
| `term://<key>/screen` | The active screen, including an active alternate screen. |
| `term://<key>/screen.png` | An image of the full active grid, with cell colours and attributes. |
| `term://<key>/page/2` | The second page of retained rows; each page has the session's `rows` rows. |
| `term://<key>/page/-1` | The last page; negative page numbers count from the end. |
| `term://<key>:raw:1-2` / `term://<key>:raw:-3` | The existing `read` head/tail selectors, with no context rows in raw mode. |

Reads do not consume output, advance observation markers or remove sessions.
An out-of-range page reports the total page count; an unknown key reports
`unknown_terminal`. A session whose spawn failed has no terminal resource.

After output closes and every accepted byte is parsed, the session freezes its
physical rows, active styled cells, geometry, cursor and current appearance.
The same URL remains readable after short-command completion, normal exit,
confirmed kill or LRU removal, until the omp process ends. Frozen resources
are not deleted; unfinished live projections need not survive plugin shutdown.
Keys remain distinct across child agents and extension reloads.

`read term://<key>/screen.png` uses omp's image pipeline; do not add `:img`.
The grid uses 8×16 logical pixels per cell and a system monospace font, with
wide glyphs spanning two cells. Live reads use the current host appearance and
draw an outline cursor; frozen reads preserve the frozen appearance and omit
the cursor. Large grids scale uniformly to the native rasterizer's pixel limit.
Each image read creates a private PNG in the OS temporary directory; it is a
point-in-time copy, not a cache, and relies on OS cleanup like session logs.
Restart omp once when upgrading from the text-only terminal handler; subsequent
extension reloads preserve the image handler and existing URLs.

### `write_stdin`

Drives or polls an existing session.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `chars` | string | `""` | Empty = pure poll; non-empty writes the bytes (after escape decoding) verbatim, appending nothing, then polls. Mutually exclusive with `chars_b64`. |
| `chars_b64` | string | `""` | Base64-encoded bytes to write. Binary-safe. Mutually exclusive with `chars`. |
| `yield_time_ms` | number | `250` with input; `5_000` empty | Attachment window, not a process timeout. Input-bearing calls clamp to [250, 30_000]. Empty polls have a 5_000 minimum and no built-in maximum; fractional milliseconds round down. An explicit operator cap rejects larger relative polls. Mutually exclusive with `yield_until`. |
| `yield_until` | string | — | Absolute UTC deadline for an **empty poll only**, strict RFC 3339 UTC (`2026-07-21T18:30:00Z` or with `.mmm`; uppercase `Z`; real calendar dates only). **Only when the human explicitly asks** for a long attached wait. Returns on exit, cancellation or the deadline; a past deadline is an immediate poll. Mutually exclusive with `yield_time_ms` and with input bytes. |

#### Waiting on long-running commands

1. Use a finite `yield_time_ms` based on the expected job duration, or a
   `monitor` (without a condition it wakes the model once output closes).
   Empty polls default to five seconds and have no built-in maximum. An
   attachment deadline never kills the process.
2. Use `yield_until` **only when the human explicitly asks** for a long attached
   wait or a wall-clock deadline on a **finite, non-interactive** command,
   computed from `tool_time_utc`. **Never** for REPLs, `sudo`, `ssh`, password
   prompts, dev servers, watchers or debuggers.
3. `on_exit` defaults to `"none"`. Use `"wake"` only when the human explicitly
   wants auto-resume; `set_on_exit(session_id, on_exit: "none")` disarms it
   without killing.
4. A completion observed directly by a tool result consumes the wake; a
   deadline or cancellation leaves it armed.

Both empty-poll forms use the same event-driven wait on monotonic time. Output
stays in the session's terminal screen, so a wait never accumulates it; the log
always gets the raw stream. Streaming updates are
output-driven (short polls at most four per second, long and absolute waits at
most once per 30 seconds), with no heartbeat while quiet. Cache warming during
waits is the host's business, not this package's. Raw logs are unbounded on
disk; archive quotas are [follow-up work](docs/IV-0002-output-lifecycle-and-rendering.md#output-archive-safety).

| Env var | Default | Notes |
|---|---|---|
| `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` | unset, no cap | Optional limit for empty relative polls. Values below `5_000` become `5_000`; invalid values fail the poll instead of removing the limit. Does not affect `yield_until`. |

#### Control bytes and escapes in `chars`

`chars` is decoded as a C-style escape string before it is written.

| Escape | Produces |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH` (2 hex) | single byte |
| `\\uHHHH` (4 hex) | Unicode char |
| `\\u{H…H}` (1–6 hex) | Unicode code point |
| `\\\\` `\\"` `\\'` | literal `\` `"` `'` |
| `\\X` not in the list above | preserved literally (both chars) |
| Raw bytes in the string | pass through untouched |

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
write_stdin chars_b64="G3s6wgo="  → exact 5 decoded bytes
```

Passing both `chars` and `chars_b64`, or malformed base64, rejects the call.
Bytes reach the PTY verbatim: nothing (no `\r` or `\n`) is appended, so ESC and
arrow keys go alone. The terminal's line discipline turns `\x03` (Ctrl-C) into
SIGINT for the foreground process group, and `\x04` (Ctrl-D) at the start of a
line into end-of-file for a program reading in canonical mode; programs in raw
mode read both as keys. Submit a line with `\r` (Enter): it works everywhere,
while `\n` does not run a line in legacy Windows consoles.

### `set_on_exit`

Changes the `on_exit` policy **without killing the process**.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `on_exit` | `"none"` \| `"wake"` | — | `"none"` disarms a pending wake (also for coordinator tombstones after eviction). `"wake"` arms it while the session is still running in the store. |

Status tokens: `disarmed`, `already_none`, `armed`, `already_armed`,
`too_late`; unknown ids return `found: false`. Disarming cannot recall a
follow-up already queued to the host.

### `on_exit: "wake"` — completion notifications

> Terminal completion is delivered through a finalized tool result **or** it
> causes one synthetic model prompt — never both.

- An exit that lands while a `write_stdin` is observing is returned by that
  call, and the wake is consumed when the result is finalized. A result
  finalized as error or cancelled keeps the wake eligible.
- A deadline or a cancelled call leaves the wake armed; when the process later
  exits, exactly one follow-up prompt is sent (`deliverAs: "followUp"`, never
  interrupting a running turn). Simultaneous completions are batched into one
  prompt.
- The prompt carries bounded metadata only (session id, exit code/signal,
  command, cwd, elapsed time, log path, failure) — never raw output.
- `kill_session`, the `/unified-exec-sessions` command, LRU eviction of a live
  process and `session_shutdown` suppress the wake; a kill that fails restores
  it. A naturally exited wake session evicted before notification keeps a
  bounded tombstone so its wake is still delivered.

### `monitor`

Subscribes to future output from an existing running session without stopping
the process or consuming ordinary observations.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Existing running session. |
| `action` | `"start"` \| `"cancel"` | `"start"` | Start/replaces the session's one subscription, or silently cancel it. |
| `condition` | string | omitted | JavaScript regex source (no `/` delimiters); omit to return only at output closure. |
| `max_returns` | number | `10` | Positive safe integer, counting successful match messages, not lines or End. |

Conditions see changed/new rendered logical lines, including prompts without a
newline; wrapped physical rows are joined. Each line is sanitized and bounded
to its first 1024 UTF-16 code units. Pure cursor/style changes do not trigger,
and old output is never replayed.

Matches coalesce for about 250 ms. Each `unified-exec-monitor` follow-up wakes
the model, with at most 16 matching lines of at most 1024 characters, an omitted
count, successful returns/limit, and the session's `terminal_url` and `log_path`. More than
20 matches in the last 60 seconds adds a narrow-the-condition advisory, without
stopping. The final allowed match announces the limit and ends only the monitor.

Actual output closure sends End with pending matches and exit code/signal;
human HUD/slash and LRU terminations identify their reason. End merges an
already-armed ordinary completion wake. Model `kill_session`, explicit cancel,
replacement, reset and shutdown end monitoring silently, including a failed
model kill. Already-enqueued follow-ups cannot be recalled. Unknown/ended
sessions, invalid regexes and invalid limits return typed errors.

### `kill_session`

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `signal` | string | `"SIGTERM"` | Escalates to SIGKILL after 2s. `"SIGKILL"` skips the grace. On Windows any signal force-kills the process tree. |

Signal names are normalized (`term`, `INT`, `sigkill`); unknown names are
rejected. The result uses the same bounded envelope as the other tools, with
`killed`, `escalated`, requested/actual signal and `running`. A failed kill
stays registered and reports `running: true`. The Tern HUD's Kill uses the same
path.

### `list_sessions`

Lists live sessions and reports each exited one a final time (with
`running: false`, `exit_code`/`signal` and `log_path`) before pruning it. Each
entry has the `shell` it started with, `wake_armed` and an active monitor's
condition/returns/limit; the response carries `tool_time_utc` for computing
`yield_until` deadlines.

## Command

- `/unified-exec-sessions` — lists live sessions in a selector (armed wakes
  show `[wake]`) and kills the chosen one, or all, without the model, with the
  same SIGTERM → 2s → SIGKILL escalation.

## Presentation

**On omp,** `exec_command`, `write_stdin` and `kill_session` render through
omp's exported bash renderer, in the ANSI TUI and in Tern: `$ cmd`, collapsed
output with omp's expand binding, the exit chip and error tone for failures,
`Backgrounded: session N` for running sessions, and the truncation marker with
the log path as the last line. `write_stdin` and `kill_session` show their
action as a bash comment (`# poll session N`, `# stdin → session N: "…"`,
`# kill session N (SIGTERM)`). `monitor`, `set_on_exit` and `list_sessions`
use omp's default card. If omp's bash renderer is missing or reshaped, plugin loading
fails rather than showing raw envelopes.

## Constants

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
MIN_EMPTY_YIELD_TIME_MS      = 5_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
TERMINAL_HISTORY_CELLS       = 240_000 (history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 2000
```

## Semantics

- **Early exit:** commands that finish within 150 ms never enter the session
  store; the result has `exit_code` and no `session_id`.
- **Exits between calls** stay in the store until the next `write_stdin` or
  `list_sessions` reports them.
- **Spawn failures** (missing shell or `workdir`) are checked before the PTY
  starts and surface as `failure_message` (`spawn <file> ENOENT: …`). A
  missing selected shell is never replaced by another shell.
- **Bun PTY required:** a host without `Bun.spawn` and `Bun.Terminal` is rejected at the extension factory, before tools register.
- **No deadline, no restart:** the package never ends a command for running
  long and never restarts a process that exits.
- **Shell exit vs terminal close:** a session runs until its terminal closes.
  A descendant that survives the shell and still holds the PTY (e.g. a
  `nohup`'d or SIGHUP-ignoring job) keeps it open; such results carry a `note`
  on how to detach it (`setsid cmd >log 2>&1 </dev/null &`), and the
  running-session widget marks the session `terminal held`.
- **A closed terminal** never crashes the host; writes report `failure_message`.
- **Esc** breaks the current wait but leaves the session running.
- **Shutdown** sends SIGTERM to every session and SIGKILLs survivors after 1s.
  An `exec_command` still inside its 150 ms start-up grace never gets a
  `session_id`: it waits for the shutdown to end the process and reports that
  exit (or `running: true` with `exit not confirmed` if the process outlives
  the SIGKILL wait), so the session never appears after the next
  `session_start`. Any other in-flight call whose terminal shutdown has already
  released returns empty output and reports the process as it is: exited, or
  still running until the SIGKILL lands.
- **LRU eviction** at 64 sessions takes the oldest non-protected one, preferring
  exited sessions; the 8 most recent are never evicted.
- **Observations** are serialized per session; streaming updates, `read term://`,
  monitor and the Tern HUD never consume ordinary observations. Frozen terminal
  resources outlive session-store membership.
- **Logs** live in the temp directory (`/tmp` or `%TEMP%`) and are never
  deleted by the package. Inspect raw PTY logs with a non-executing viewer, not
  `cat`.

## Worked examples

### Dev server

```
> exec_command(cmd="npm run dev", yield_time_ms=5000)
[still running]
session_id: 1
---
> Server listening on :3000

> write_stdin(session_id=1, chars="", yield_time_ms=10000)
[still running]
---
  GET /health 200 in 3ms

> kill_session(session_id=1)
```

### Interactive Python REPL

```
> exec_command(cmd="python3 -q", yield_time_ms=1500)
[still running]
session_id: 1
terminal: normal screen 120x80, cursor row 1 col 5
---
>>>

> write_stdin(session_id=1, chars="print(7*6)\r", yield_time_ms=1000)
[still running]
terminal: normal screen 120x80, cursor row 3 col 5
---
>>> print(7*6)
42
>>>
```

### Long job with auto-resume (human asked for it)

```
> exec_command(cmd="npm test", yield_time_ms=1000, on_exit="wake")
[still running]
session_id: 2
completion_notification: armed
---
# …the agent ends its turn; when npm test exits, one follow-up prompt resumes it.
> set_on_exit(session_id=2, on_exit="none")   # if the job is abandoned
```

## Windows

Every session runs in ConPTY through Bun's native `Bun.Terminal`.

- **Platform default shell** (no `shell` argument, omp `shellPath` or
  `SHELL`): `bash`, found via `PI_UNIFIED_EXEC_BASH`, then `bash` on PATH
  (excluding System32's WSL stub), then Git for Windows derived from `git.exe`
  or well-known install roots, then `powershell` with a one-time warning. This
  probe is cached for the process lifetime.
- **Shell names** are resolved to absolute paths before spawning (`bash`
  through the same Git Bash probe). A bare name not found on PATH fails the
  call instead of being looked up in the workdir.
- **`SHELL` inherited from Git Bash or MSYS** is used like any other
  selection, so it must name a path Windows can spawn; otherwise pass `shell`,
  set omp's `shellPath`, or unset `SHELL`.
- **PowerShell** (`powershell`, or `pwsh` on any platform) runs as
  `-NoProfile -NoLogo -Command <cmd>`, so its interactive prompts can be
  answered with `write_stdin`.
- **No POSIX signals:** every kill is a tree kill (`taskkill /T /F`); killed
  processes report `exit_code: 1`, and failed kills are reported, not hidden.

## Layout

```
src/
├── index.ts              # tool registration, event handlers
├── session.ts            # ExecSession: spawn, read, write, kill, log stream, state
├── session-store.ts      # SessionStore + LRU eviction
├── collect.ts            # CollectResult: screen, final screen or none
├── long-wait.ts          # event-driven waits (polls, collection, kill) + rate-limited streaming
├── time.ts               # durations, operator limit, strict UTC deadlines
├── format-time.ts        # elapsed / remaining labels
├── completion.ts         # on_exit "wake" coordination (exactly-once)
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # Bun.Terminal backend, host admission, spawn preflight, Windows tree-kill
├── shell.ts              # shell selection and argv (Windows-aware)
├── output-safety.ts      # terminal-control stripping
├── terminal-screen.ts    # headless terminal: observations, styled screens, query answers
├── tool-result.ts        # bounded envelopes + model-visible text
├── script-result.ts      # tool outputSchema / structuredContent
└── unescape.ts           # C-style escape decoder for `chars`
fork-features/
├── omp-presentation.ts   # omp host detection, bash-renderer delegation, theme appearance, shellPath setting
├── command-approval.ts   # built-in bash approval port and factory-loaded host helpers
├── session-binding.ts    # activation-local AgentSession identity for approval settings
├── omp-tools.d.ts        # types of the omp modules loaded at runtime
├── tern-terminal-hud.ts  # terminals segment in omp's pill, Terminals sheet, terminal page
├── terminal-resource.ts  # process-global terminal keys, live/frozen projections
├── terminal-url.ts       # omp `term://` read handler
├── terminal-image.ts     # terminal screenshots (SVG → PNG)
├── monitor-subscription.ts # monitor conditions, batching and follow-ups
├── tern-plugin-install.ts# keeps the Tern plugin installed
├── tern-plugin/          # CSS-only Tern plugin
└── README.md             # fork customizations and requalification
docs/
├── IV-0001-long-wait-and-wake-control.md
├── IV-0002-output-lifecycle-and-rendering.md
├── DC-0001-agentic-workspace.md
└── DEV.md                # maintainer guide
```

## Tests

```bash
npm install
npm test                                   # strict typecheck + Bun unit/integration suites
bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

The full suite runs with Bun's native `bun test` runner, including real PTY
session and HUD lifecycle tests; PTY availability is mandatory, not a skip
condition. Node remains a test prerequisite because the standalone
`tests/bun-pty-runtime.mjs` fixture starts `node` as an ordinary child program,
not as the plugin host. CI runs the full suite and the source/compiled fixture
on Linux, macOS and Windows. Tern behaviour is qualified in a real Tern window,
as described in [fork-features/README.md](fork-features/README.md).

## Development and upstream

[docs/DEV.md](docs/DEV.md) covers the dev loop, test recipes and codex sources.
The fork's publish workflow is disabled. Upstream changes arrive through the
daily `Sync upstream` workflow; how fork changes are kept apart from upstream
and resolved on sync is in [fork-features/README.md](fork-features/README.md).

Licensed [MIT](./LICENSE), like upstream.
