# omp-unified-exec

English | [简体中文](README.zh-CN.md)

Long-lived terminal sessions for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp), with a terminal HUD in Tern. The host's `bash` keeps short one-shot
commands; long commands, interactive programs (REPLs, TUIs, `ssh`, `sudo`),
concurrent computation and dev-time daemons go to `exec_command`, which runs
each in a PTY session the model drives with input, reads and monitors instead of a
single blocking call. Sessions keep running between turns, with no command
deadline, and a human can watch and type into them from Tern.

[![omp-unified-exec demo in Tern](docs/assets/demo.gif)](docs/assets/demo.mp4)

The agent starts `python3 -q` with `exec_command` and runs `x = 21` through
`write_stdin`. The human opens that session from the terminals segment of
omp's pill and types `y = x * 2` on its terminal page; the agent then prints
`y` in the same session and gets 42. Kill in the Terminals view ends the
session. Recorded in Tern with omp 18.12.6 and Gemini 4 Argon; model turns
play at 3× speed. Full-resolution video:
[docs/assets/demo.mp4](docs/assets/demo.mp4).

[![lazygit driven by omp in Tern](docs/assets/demo-lazygit.gif)](docs/assets/demo-lazygit.mp4)

A full-screen TUI works the same way. With GPT-6.1 Sol, the agent opens
lazygit through `exec_command` and drives it with `write_stdin` alone: it
stages only `src/todos.ts` and commits it as `feat: toggle todos`, leaving
`README.md` unstaged. The human opens the same lazygit on its terminal page,
in colour, focuses the commits panel with `4` to read the new commit's patch,
and quits with `q`; the Terminals view then shows the session's `Exit 0`.
Model turns play at 3× speed. Full-resolution video:
[docs/assets/demo-lazygit.mp4](docs/assets/demo-lazygit.mp4).

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

Updates use the same command with `--force`:

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

The extension needs no Tern plugin. Versions up to 0.14.7 installed one
(`omp-unified-exec`); when `tern` is on PATH, loading the extension (including
install validation) removes that copy or link through Tern's own CLI.

This plugin supports only omp running on Bun 1.4+ (omp is a compiled Bun
executable). Pi and other non-omp hosts fail immediately at the extension
factory with an explicit “only supports omp” error. Every session uses Bun's
native `Bun.Terminal`; a host without `Bun.spawn` and `Bun.Terminal` fails at
that same factory before omp modules load or any tools register.

## UI language

Human-facing notifications, widgets, command labels, the omp bash card annotations,
and the Tern terminal HUD follow `OMOMP_LANG` (`en` or `zh`, case-insensitive).
When it is unset or invalid, the plugin uses the first non-empty `LC_ALL`,
`LC_MESSAGES`, or `LANG` value (`zh*` selects Chinese); otherwise it uses English.
This Pi-compatible plugin does not read an `omomp` file. Command descriptions and
tool labels resolve the environment once when registered for each session;
notifications, widgets, renderers, and the HUD resolve it when generating their
display text. Tool descriptions, prompts, protocol values, and model-facing tool
results remain in English.

## What it does

- **Sessions, not calls.** `exec_command` starts a process in a PTY and returns
  within its yield window with output so far and a `session_id`; on later turns
  `write_stdin` writes bytes to it verbatim (text, `\x03` Ctrl-C, arrow keys).
  Read `terminal_url` for state/content and use `monitor` for events or completion.
  Cancelling a call never kills the process. There is no command deadline,
  and a process that exits is never restarted.
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
- **Terminal lifecycle.** A background terminal stays listed after its
  command returns until it is reclaimed. An abnormal return is reported at
  once; 30 minutes after the return or the last read, a never-read terminal
  gets one read reminder, and a read one gets a reclaim-due notice and a
  5-minute grace before its remaining processes are killed and it is
  reclaimed. See [Terminal lifecycle](#terminal-lifecycle).
- **One notice channel.** Wakes, monitor returns and reminders, input-wait
  alerts and lifecycle notices are all terminal notices: each names the
  terminal by `session_id` and the title given to `exec_command`, with a short
  reason. Notices wait while the agent is running and arrive as one follow-up
  when it stops.
- **Quiet after finished work.** When the main agent stops, its final response
  is judged (OMP's judge, else `@smol`, else the todo list) before any notice
  goes out; if the work is done, returned terminals are reclaimed and their
  notices dropped instead of starting turns. See
  [Finished work](#finished-work).
- **Opt-in completion wake.** `on_exit: "wake"` resumes the agent once when a
  backgrounded process exits unobserved; `set_on_exit` disarms it.
- **Await matching output.** `monitor` watches an existing session without
  consuming output, wakes for matching batches or completion, and defaults to
  at most ten successful match returns. A monitor that has not returned for 20
  minutes reminds the agent once to check the session.
- **Input-wait alerts.** With or without a monitor, a session whose screen
  settles on a prompt the agent has not seen (a debconf/whiptail dialog such as
  the sshd_config question during `apt upgrade`, `[Y/n]`, a password, a pager)
  wakes the agent.
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
- **Terminals view.** Clicking the segment opens a view built like omp's
  Background jobs view, styled by Tern's own rules for that view in every
  theme and chat style: a centered card listing the sessions (terminal icon,
  title, elapsed time, tinted by state) beside the selected session's
  detail: a status row (Running / Exit N, elapsed, `exec · #id`, Kill while it
  runs, Open), the whole command, its directory, PID, size, start time and
  linked log, and its coloured output following the newest line. The footer
  shows how many run and are stored, and Close. ↑/↓ or a click picks a
  session, `x` / Kill ends it the way `kill_session` does, Esc / Close leaves.
  The card's header icon is the one Tern draws for the jobs view.
- **Terminal page.** Enter / Open (or a double click) shows the session as a
  full-pane page framed like omp's Console, headed by its title: its retained
  history and current screen in colour, at its own width, following new output and scrollable
  back. Typed keys go to the session (as `write_stdin` writes them, so the
  model sees their effect); Esc / Back returns to the view; Kill ends the
  session.

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

**No Tern plugin.** The view and page use omp's own overlay roles
(`omp.overlay.jobs`, `omp.overlay.console`), so Tern's built-in styles draw
them and the segment. Those roles are presentation contracts of omp and Tern,
requalified on upgrades. The extension removes the `omp-unified-exec` Tern
plugin that earlier versions installed, because its stylesheet still moved
omp's shared widget container: during omp's awaited factory it asks Tern's
`plugin list`, then `plugin remove` (or `plugin unlink` when Tern answers that
it is linked), and confirms Tern no longer lists it. Without `tern` nothing
runs; if an available Tern fails, loading fails with its diagnostics.

## Tools

### `exec_command`

Runs a command in a persistent PTY session. Use it for long commands,
interactive programs (REPLs, TUIs, `ssh`, `sudo`), concurrent computation and
dev-time daemons; use the host's `bash` for short one-shot commands. There is no
command deadline, and nothing restarts a process that exits. Observe a session
with `monitor` and `read term://…`, and send input with `write_stdin`; its output is the
rendered terminal screen (see [Terminal output](#terminal-output)).

Read `xd://exec_command` for the complete tool description and its topic pointers.
The plugin supplies the topic bodies through the tool's `docTopics()`:

- `xd://exec_command/interactive`: input bytes, monitoring output and remote-script quoting.
- `xd://exec_command/lifecycle`: terminal reclaim and exit wakes.
- `xd://exec_command/waiting`: command lifetime, completion-only monitors and non-consuming reads.

The Markdown files ship in `fork-features/topics/`; topic reads need no external
configuration extension. An unknown topic returns a missing-topic error.

| Param | Type | Default | Notes |
|---|---|---|---|
| `cmd` | string | — | Shell command. Required. |
| `title` | string | — | Required start title naming the terminal in `list_sessions`, the Terminals view and every notice about it. Folded to one line; at most 80 characters are kept. A missing or blank title fails the call before anything starts. |
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
log_path: /tmp/pi-unified-exec-41237-1-5cc5e104.log  (omp pid, session id, random)
terminal_url: term://1-9f2c1a7e-…
cwd: /home/you/project
shell: /bin/zsh                     (absolute path of the shell the session started with)
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn)
terminal: normal screen 120x80, cursor row 4 col 5
history_lines: 2                   (running, optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

When output exceeds the caps (50 KiB / 2000 lines), a footer is appended:

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-41237-1-5cc5e104.log]
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
- **Full-screen programs** (alternate screen, e.g. `top`, editors, `tmux`) are
  reported as `terminal: alternate screen …`; leaving it restores the normal screen.
- **The child sees `TERM=xterm-256color`**, the terminal it actually draws on,
  whatever terminal omp itself runs in; a command can still set its own `TERM`.
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
`term://3-9f2c1a7e-…`. What a human sees in the terminal remains readable
independently of result consumption:

| Read path | Content |
|---|---|
| `term://<key>` | All retained normal-screen physical rows, without trailing spaces or trailing empty rows. While a full-screen program (e.g. `tmux`) holds the alternate screen, that screen instead, which has no history; normal history is back once it leaves. |
| `term://<key>/screen` | The active screen, including an active alternate screen. |
| `term://<key>/screen.png` | An image of the full active grid, with cell colours and attributes. |
| `term://<key>/page/2` | The second page of the rows `term://<key>` reads; each page has the session's `rows` rows. |
| `term://<key>/page/-1` | The last page; negative page numbers count from the end. |
| `term://<key>:raw:1-2` / `term://<key>:raw:-3` | The existing `read` head/tail selectors, with no context rows in raw mode. |

Reads do not consume output, advance observation markers or remove sessions.
A complete read of a terminal whose command has returned counts as reading it
for its [lifecycle](#terminal-lifecycle).
An out-of-range page reports the total page count; an unknown key reports
`unknown_terminal`. A session whose spawn failed has no terminal resource.

After output closes and every accepted byte is parsed, the session freezes its
physical rows, active styled cells, geometry, cursor and current appearance.
The same URL remains readable after short-command completion, normal exit,
confirmed kill, LRU removal or reclaim, until the omp process ends. Frozen resources
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

Sends nonempty decoded input to an existing session. Missing or zero-byte input
returns the typed `empty_poll_removed` error without consuming observations or
affecting the process. The error points to the session's `read term://…` address
and `monitor`.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `chars` | string | omitted | Text decoded with C-style escapes, then written verbatim with nothing appended. Mutually exclusive with `chars_b64`; decoded input must be nonempty. |
| `chars_b64` | string | omitted | Base64-encoded input bytes. Binary-safe; decoded input must be nonempty. Mutually exclusive with `chars`. |
| `yield_time_ms` | number | `250` | Attachment window after writing, not a process timeout. Clamped to [250, 30_000]; fractional milliseconds round down. |

#### Waiting on long-running commands

1. Read `terminal_url` (or its `/screen`) for state and content without consuming
   ordinary observations.
2. Use `monitor` with a condition for future output events, or without a condition
   to await output closure and process completion. Send input only with `write_stdin`.
3. `on_exit` defaults to `"none"`. Use `"wake"` only when the human explicitly
   wants auto-resume; `set_on_exit(session_id, on_exit: "none")` disarms it
   without killing.
4. A completion observed directly by an input-bearing tool result consumes the
   wake; an attachment window ending or cancellation leaves it armed. Monitor
   End merges an already-armed wake into the same notification.

The attachment window never kills a process. Cache warming during waits is the
host's business, not this package's. Raw logs have no size cap; see **Logs**
under [Semantics](#semantics) for their seven-day compression.

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
- The wake is an `exit_wake` [terminal notice](#terminal-notices): bounded
  metadata only (session id, title, exit code/signal, command, cwd, elapsed
  time, terminal reading address, log path, failure) — never raw output.
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
| `remind_after_ms` | number | `1200000` | Integer 1–2147483647: silence before one reminder that the monitor has not returned. |

Conditions see changed/new rendered logical lines, including prompts without a
newline; wrapped physical rows are joined. On the alternate screen, the
cursor's row is also seen as it was just before a bare carriage return (one not
followed by a line feed) or a cursor-moving CSI hands it to the next output, so
a marker that `tmux` draws and overwrites still matches. Each line is sanitized and bounded
to its first 1024 UTF-16 code units. Pure cursor/style changes do not trigger,
and old output is never replayed.

Matches coalesce for about 250 ms. Each delivered batch is a `monitor_match`
[terminal notice](#terminal-notices) that wakes the model, with at most 16
matching lines of at most 1024 characters, an omitted count, successful
returns/limit, and the session's `terminal_url` and `log_path`. More than
20 matches in the last 60 seconds adds a narrow-the-condition advisory, without
stopping. The final allowed match announces the limit and ends only the monitor.

Actual output closure sends End (a `monitor_end` notice) with pending matches and exit code/signal;
human HUD/slash and LRU terminations identify their reason. End merges an
already-armed ordinary completion wake. Model `kill_session`, explicit cancel,
replacement, reset and shutdown end monitoring silently, including a failed
model kill. Already-enqueued follow-ups cannot be recalled. Unknown/ended
sessions, invalid regexes, invalid limits and invalid reminder intervals return
typed errors.

If no match or End has been delivered for `remind_after_ms` (20 minutes by
default) since the monitor started or since its last delivered match, it sends
one `monitor_silent` notice with `silentMs` in its body:
the monitor has not returned, the time since the last output, the screen kind
and the last eight non-blank screen lines (labelled as command output), and
the terminal's read address, asking the agent to check whether the session is
waiting for input, stalled or slow. The reminder does not count toward
`max_returns` and does not end the monitor; it is not repeated until a
delivered match starts a new silent period, so a waiting agent calls `monitor`
again for another deadline. A pending match goes out before a due reminder, and
End replaces an undelivered one.

### Input-wait alerts

No terminal protocol tells a program's host that it is waiting for input.
`apt upgrade` asks about a locally modified `sshd_config` through debconf
(openssh-server's maintainer script uses ucf, which uses debconf); debconf talks
to its frontend over its own pipe, and the whiptail/dialog frontend reaches the
PTY only as ordinary drawing (alternate screen, hidden cursor, box characters).
Over `ssh` the local process state says nothing either. Every running session
therefore examines its rendered screen once output has been quiet for 5 seconds
and sends an `input_wait` [terminal notice](#terminal-notices) that wakes the model when all of
these hold:

- no `exec_command`/`write_stdin` call is attached (its result shows the
  screen), and no tool result has shown this exact screen yet;
- the screen shows a prompt:
  - **dialog** — a `<Ok>`, `<Yes>`, `<No>` or `<Cancel>` button anywhere
    (whiptail, dialog, debconf, needrestart);
  - **inline** — the cursor waits at the end of a line containing `[Y/n]`-style
    choices, `(yes/no)` or `(Y/I/N/O/D/Z)`, `[default=…]`, a line ending in
    `password …:` / `passphrase …:`, or `press Enter/Return/any key`;
  - **pager** — the cursor sits on the bottom row after `:`, `(END)` or
    `--More--`;
- that screen has not been alerted before.

The alert names the session, its title and command, quotes the prompt lines as
command output, and gives the read address. It is heuristic: a screen read through
`read term://…` does not count as shown, and shells, progress lines and
prompts away from the cursor are ignored. A newer alert for the same session
replaces an undelivered one; a failed send is retried at the next safe
boundary while the screen is unchanged and unseen.

### `kill_session`

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `signal` | string | `"SIGTERM"` | Escalates to SIGKILL after 2s. `"SIGKILL"` skips the grace. On Windows any signal force-kills the process tree. |

Signal names are normalized (`term`, `INT`, `sigkill`); unknown names are
rejected. The result uses the same bounded envelope as the other tools, with
`killed`, `escalated`, requested/actual signal and `running`. A failed kill
stays registered and reports `running: true`. A confirmed kill is a normal
ending: the terminal stays listed (`running: false`) and its
[lifecycle](#terminal-lifecycle) reclaims it; the kill result shows its final
screen, which counts as reading it. The Tern HUD's Kill uses the same path and
counts as read as well.

### `list_sessions`

Lists every stored terminal: running ones, and returned ones until their
[lifecycle](#terminal-lifecycle) reclaims them. Each entry has its `title`, the
`shell` it started with, `running`, `exit_code`/`signal` once the terminal
closed, `wake_armed`, an active monitor's condition/returns/limit/reminder
interval and, once the command returned, `lifecycle`: how it returned
(`normally` or `abnormally (<reason>)`), whether it has been read, and its
phase (`ttl`, `unread_reminded`, `grace`, `reclaiming`). The response carries
`running_count`, `returned_count` and the current host `tool_time_utc`.
Reporting an exit here suppresses a not-yet-sent `on_exit` wake; it is not a
read of the terminal's output.

### Terminal lifecycle

From the result that hands out a `session_id` until reclaim, the terminal
lifecycle owns the terminal. Its command **returns** when the shell exits —
background processes may still hold the terminal — or the terminal closes.

- **Abnormal return** (non-zero exit, signal, spawn/runtime failure) sends an
  `abnormal_return` notice at once, read or not. A kill by `kill_session`, the
  HUD or `/unified-exec-sessions` is a normal ending.
- **Reads** count from the return on: a complete `read term://…` (text or
  `/screen.png`), or a finalized `write_stdin`/`kill_session` result (or an
  `exec_command` result for a shell that already exited) that shows the
  returned terminal. Errored or cancelled results do not count. `list_sessions`,
  `monitor` End and wakes report status only and do not count.
- **30 minutes** after the return or the latest read:
  - never read: one `unread` notice; the checks keep the terminal until it is
    read (only [finished work](#finished-work) reclaims it unread);
  - read: a `reclaim_due` notice and a **5-minute grace**. A read during the
    grace starts a new 30 minutes; otherwise the terminal is reclaimed.
- **Reclaim** kills whatever is left of the terminal's process group —
  background jobs holding the terminal on Linux, and jobs that outlived the
  closed terminal on macOS (SIGTERM, SIGKILL after 2 s) — removes the
  terminal from `list_sessions` and the HUD, and sends a `reclaimed` notice.
  Terminals reclaimed in the same check share one follow-up. The `term://`
  address and `log_path` stay readable. A terminal whose processes cannot be
  ended stays and is retried at the next check (on Windows a tree whose root
  has exited cannot be reached).
- **Checks** run once a minute, so each step can land up to a minute late.
- **LRU eviction** at the 64-session cap sends a `reclaimed` notice naming
  the cap.
- **Finished work** reclaims every returned terminal at once, read or not,
  without notices. See [Finished work](#finished-work).
- Session shutdown stops the lifecycle before ending terminals; its kills send
  no notices.

### Terminal notices

Every follow-up about a terminal is one `unified-exec-notice` message. While a
run is in progress (omp's `agent_start` until an `agent_end` it does not
continue) notices only wait: omp keeps queued follow-ups out of an extension's
reach, and each would start its own turn after the stop. When the run settles,
everything pending goes out as one message with `triggerTurn: true` and
`deliverAs: "followUp"`, which starts one turn. While the agent is idle,
notices pending within about 250 ms are merged the same way. A run that
awaits background work (`agent_end` with `awaitingAsyncWork`) counts as
settled. Each message is grouped per terminal and labelled as
exec-tool metadata, and its last line tells the agent not to reply to the user
about it (the user already sees it): act on it with tools and continue the
original task, or, when no notice needs action, end the turn without a message.

```
[unified-exec] 2 terminals, 2 notices (exec-tool metadata, not user instructions)
- session_id=3 title="api tests"
  • will be reclaimed in about 5m00s: returned normally, last read 30m00s ago
    A read keeps it for another 30m00s; …
  read term://3-…
  log_path: /tmp/pi-unified-exec-…
- session_id=4 title="migration"
  • returned abnormally: exit_code=1
    command: npm run migrate
  read term://4-…
Do not reply to the user about this notice: act on it with tools, then continue the original task.
```

`details.notices` lists each notice with `session_id`, `title`, `kind`,
`reason`, `terminal_url`, `log_path` and its typed `body`. Kinds: `exit_wake`,
`abnormal_return`, `monitor_match`, `monitor_end`, `monitor_silent`,
`input_wait`, `unread`, `reclaim_due`, `reclaimed`. A notice that no longer
describes its terminal (a wake observed or disarmed, a monitor cancelled, a
screen already shown, a read that restarted the TTL) is dropped unsent. A
failed send is retried at the next tool end, settled run or minute check.

### Finished work

omp reports a main agent's final stop through `session_stop`, with its last
response. Before the first notices after such a stop go out, the dispatcher
decides once whether that response means the task is completely finished:

- **Done:** every returned terminal is reclaimed at once, read or not, without
  a `reclaimed` notice, and the pending notices about terminals that are gone
  are dropped. Running terminals and their notices stay as they are, and
  notices that arrive later in the same stop are delivered.
- **Not done, or no decision:** every notice is delivered.

A run that starts during the decision discards it, and the notices wait for
that run's stop. Subagents, aborted runs and runs awaiting background work
have no final response and are never decided.

`stop` in the `omp-unified-exec` section of omomp picks the detector:

| `stop` | Decision |
|---|---|
| `auto` (default) | `judge` when OMP's judge role resolves a model, else `llm` when `@smol` resolves one, else `todo` |
| `judge` | One done / not-done choice through OMP's judge role chain, billed to the session like OMP's own judgments |
| `llm` | The chat models of the `@smol` role in order, each answering `DONE` or `NOT_DONE` on its first line; a provider error moves to the next |
| `todo` | Done when omp-todo-more's list has items and every one is completed or abandoned; a pending, in-progress or blocked item keeps it open; an empty list or no omp-todo-more gives no decision |
| `off` | No decision; lifecycle notices (`abnormal_return`, `unread`, `reclaim_due`, `reclaimed`) are not delivered, while monitor, wake and input-wait notices are |

An explicitly chosen detector that is unavailable gives no decision; one that
fails, or runs past 30 seconds, also shows a warning. A done decision shows an
info notification naming the detector.

```yaml
omp-unified-exec:
  stop: auto
  judgePrompt: |
    A coding agent stopped. Its final response, its todo list and the terminal notices that arrived for it follow.

    Final response:
    {last_response}

    Todo list:
    {todo}

    Pending terminal notices:
    {notices}
  noticeTemplate: "{summary}\n{items}\n{instruction}"
```

The values above are the defaults. `judgePrompt` is the material the judge or
`@smol` reads; the question it answers and the answer format are fixed.
Placeholders: `{last_response}` (the final response), `{notices}` (the pending
notices as the agent would read them) and `{todo}` (objective, item counts per
status and open items, or `(unavailable)`). `noticeTemplate` is the injected
text: `{summary}` (the `[unified-exec] …` line), `{items}` (the per-terminal
lines), `{instruction}` (the last line), `{terminal_count}` and
`{notice_count}`. A brace pair around anything but a bare name (such as
`{ "done": true }`) stays literal. Substitution is a single pass, so inserted text is never
expanded again. The human-facing transcript keeps the default layout.

The section is read from `<cwd>/.omp/omomp.{yml,yaml,json,toml}`, then from the
agent directory's `omomp.*`; the first valid copy wins, and it is read again at
every stop, so edits apply without a restart. An unknown key, mode or
placeholder makes a copy invalid: a warning names it once and the next
location, or the defaults, apply.

## Command

- `/unified-exec-sessions` — lists running sessions with their titles in a
  selector (armed wakes show `[wake]`) and kills the chosen one, or all,
  without the model, with the same SIGTERM → 2s → SIGKILL escalation.

## Presentation

**On omp,** `exec_command`, `write_stdin` and `kill_session` render through
omp's exported bash renderer, in the ANSI TUI and in Tern: `$ cmd`, collapsed
output with omp's expand binding, the exit chip and error tone for failures,
`Backgrounded: session N` for running sessions, and the truncation marker with
the log path as the last line. `write_stdin` and `kill_session` show their
action as a bash comment (`# stdin → session N: "…"`,
`# kill session N (SIGTERM)`). `monitor`, `set_on_exit` and `list_sessions`
use omp's default card. If omp's bash renderer is missing or reshaped, plugin loading
fails rather than showing raw envelopes.

## Constants

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
TERMINAL_HISTORY_CELLS       = 240_000 (history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 2000
DEFAULT_REMIND_AFTER_MS      = 1_200_000 (monitor silence before one reminder)
INPUT_WAIT_QUIET_MS          = 5_000 (output silence before the screen is examined for a prompt)
RECLAIM_TTL_MS               = 1_800_000 (after a return or read: read reminder or reclaim-due notice)
RECLAIM_GRACE_MS             = 300_000 (reclaim-due notice to reclaim, unless read)
LIFECYCLE_SWEEP_MS           = 60_000 (lifecycle check interval)
```

## Semantics

- **Early exit:** commands that finish within 150 ms never enter the session
  store; the result has `exit_code` and no `session_id`.
- **Returned terminals** stay in the store, the HUD and `list_sessions`
  until their [lifecycle](#terminal-lifecycle) reclaims them; no tool call
  removes them on observing the exit.
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
  running-session widget marks the session `terminal held`. `kill_session`,
  reclaim and shutdown still signal the shell's process group then, so a
  descendant that stayed in it is ended; one that left it (`setsid`) is not.
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
  exited sessions; the 8 most recent are never evicted. A tracked terminal
  evicted this way gets a `reclaimed` notice naming the cap.
- **Observations** are serialized per session; streaming updates, `read term://`,
  monitor and the Tern HUD never consume ordinary observations. Frozen terminal
  resources outlive session-store membership.
- **Logs** live in the temp directory (`/tmp` or `%TEMP%`) as
  `pi-unified-exec-<omp pid>-<session id>-<random>.log`. The package never
  deletes their content. A log last written more than seven days ago is
  replaced by a standard gzip `<log_path>.gz` with the same modification time,
  once its writer is provably gone: this process closed it, the omp pid in its
  name no longer exists, or it was last written before the last boot (the only
  test for older names without a pid). omp checks when the extension loads and
  daily after that. Read an archive with `zcat <file>` on Linux, or
  `gzcat <file>` / `zcat < <file>` on macOS, whose `zcat` given a path looks
  for `<file>.Z`. Inspect raw PTY logs with a non-executing viewer, not `cat`.

## Worked examples

### Dev server

```
> exec_command(cmd="npm run dev", title="dev server", yield_time_ms=5000)
[still running]
session_id: 1
terminal_url: term://1-9f2c1a7e-…
---
> Server listening on :3000

> monitor(session_id=1, condition="GET /health")
{"session_id":1,"status":"started",…}
# A subsequent matching request wakes the model.
> read term://1-9f2c1a7e-…/screen
Server listening on :3000
  GET /health 200 in 3ms

> kill_session(session_id=1)   # stays listed until its lifecycle reclaims it
```

### Interactive Python REPL

```
> exec_command(cmd="python3 -q", title="python repl", yield_time_ms=1500)
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
> exec_command(cmd="npm test", title="npm test", yield_time_ms=1000, on_exit="wake")
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
├── long-wait.ts          # event-driven waits (collection, shutdown, kill)
├── format-time.ts        # elapsed labels and host UTC time
├── completion.ts         # on_exit "wake" coordination (exactly-once), monitor ownership
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # Bun.Terminal backend, host admission, spawn preflight, shell-exit events, process-group signals, Windows tree-kill
├── shell.ts              # shell selection and argv (Windows-aware)
├── output-safety.ts      # terminal-control stripping
├── terminal-screen.ts    # headless terminal: observations, styled screens, query answers
├── tool-result.ts        # bounded envelopes + model-visible text
├── script-result.ts      # tool outputSchema / structuredContent
└── unescape.ts           # C-style escape decoder for `chars`
fork-features/
├── omp-presentation.ts   # omp host detection, bash-renderer delegation, theme appearance, shellPath setting
├── command-approval.ts   # built-in bash approval port and factory-loaded host helpers
├── session-binding.ts    # activation-local AgentSession identity for approval settings and stop detectors
├── omp-tools.d.ts        # types of the omp modules loaded at runtime
├── tern-terminal-hud.ts  # terminals segment in omp's pill, Terminals view, terminal page
├── terminal-resource.ts  # process-global terminal keys, live/frozen projections
├── terminal-url.ts       # omp `term://` read handler; reports reads to the terminal's owner
├── terminal-image.ts     # terminal screenshots (SVG → PNG)
├── terminal-notice.ts    # terminal notice ADT, formatter and the one dispatcher: run-held, merged, stop-gated
├── terminal-lifecycle.ts # returned-terminal TTL, read/reclaim reminders, grace, reclaim, finished-work collection
├── stop-config.ts        # `omp-unified-exec` omomp section: stop mode, judge prompt, notice template
├── stop-gate.ts          # judge / @smol / todo stop detectors over factory-loaded omp modules
├── monitor-subscription.ts # monitor conditions, batching and reminders as terminal notices
├── input-wait.ts         # input prompt detection; input-wait alerts as terminal notices
├── log-archive.ts        # seven-day gzip compression of session logs
├── tern-plugin-removal.ts# removes the Tern plugin earlier versions installed
└── README.md             # fork customizations and requalification
docs/
├── DEV.md                # maintainer guide
└── assets/               # README demos (demo*.gif, demo*.mp4)
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

[docs/DEV.md](docs/DEV.md) covers the dev loop, focused test recipes, omp
compatibility checks and re-recording the README demos.
The fork's publish workflow is disabled. Upstream changes arrive through the
daily `Sync upstream` workflow; how fork changes are kept apart from upstream
and resolved on sync is in [fork-features/README.md](fork-features/README.md).

Licensed [MIT](./LICENSE), like upstream.
