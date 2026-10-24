# IV-0001 — Long-wait UX, wake control, and agent guidance

**Status:** active; input-only writes, terminal reads and output monitors
**Root IV:** this document  
**Related release:** [Changelog.md](../Changelog.md) — 2026-07-22 — 0.7.1 / 0.7.2  
**Workspace doctrine:** [docs/DC-0001-agentic-workspace.md](./DC-0001-agentic-workspace.md)

## Current wait contract

`write_stdin` only sends nonempty decoded input. Omitted input, empty text and
base64 decoding to zero bytes return the typed `empty_poll_removed` error
before touching the session, acquiring an observation lease or collecting output.
The error points to `read term://<key>` (the session's actual `terminal_url`
when known) and `monitor`; unknown session ids do not bypass this rejection.
There is no zero-byte attached-wait path or associated configuration.

Read state and content through `read term://…`, including `/screen` for active
text. Await future output events with a conditional `monitor`, or omit its
condition to await output closure. Neither operation consumes ordinary
observations or removes sessions. Input-bearing `write_stdin` retains its
250 ms default attachment window; exec defaults to 10 seconds. Both clamp
attachment windows to [250, 30_000] ms, and cancellation leaves the process alive.

Terminal delivery by an input-bearing call still commits at `tool_execution_end`;
failed/cancelled delivery leaves an armed wake eligible. Completion notifications
name each session's terminal reading address instead of requesting another write.
`on_exit` defaults to `"none"`; `"wake"` is only for a human-explicit request for
auto-resume, not a substitute for monitor. omp owns cache warming independently.

Validation uses `npm test`, including shared wait-engine, input rejection and
wake tests in `tests/long-wait.test.ts`, `tests/e2e.test.ts` and
`tests/wake-e2e.test.ts`. Real host qualification uses omp; the direct-core
harness is not a second supported host. Archive quotas, output-delivery
acknowledgement, per-job concurrency and registry eviction redesign remain
separate work.

## Monitor contract

`monitor` subscribes to an existing running session. Its optional `condition`
is a JavaScript regex source; omitting it waits only for output closure.
`max_returns` defaults to 10 and must be a positive safe integer. One session
has at most one subscription: a successful new establishment replaces the
old one; `action: "cancel"` silently removes it. Unknown/ended sessions,
invalid regexes and invalid limits return typed errors without replacing an
existing subscription.

The terminal source establishes the future-only boundary before the
coordinator publishes the actual subscription. Conditional monitors compare
rendered text/row identities: wrapped physical rows form logical lines,
including nonempty incomplete prompts. Cursor-only movement over existing
blank rows and style-only changes do not trigger. New blank row identities and
nonempty-to-empty erases can match an empty-line condition; untouched padding
is not output. These are rendered-state deltas, not byte/LF replay.
Unconditional monitors install no row cursor and only await output closure.

Evaluation waits 50 ms for quiet, with a 250 ms maximum delay during
continuous output. A source-owned history frontier and reusable per-current-row
markers distinguish moved/trimmed rows from new rows without consuming the
ordinary observation cursor. Erase/redraw compares the same viewport position
only after its old marker is disposed. RIS invalidates this monitor cursor at
the emulator's native reset boundary. There is no second terminal parser,
global output copy or coordinator cursor mirror.

On the alternate screen a row can be drawn and overwritten within one
evaluation window: tmux redraws pane lines separated by bare carriage returns
([#84](https://github.com/oh-my-omp/omp-unified-exec/issues/84)). While a
conditional monitor exists, `TerminalScreen.write` splits child writes after
each CR not followed by CR or LF (a trailing CR waits for the next write's
first byte) and, once that piece is parsed, the monitor reads the cursor's
logical row from the same emulator. A row that differs from the last reported
text at that position is delivered and recorded as reported, so the next
evaluation does not repeat it. CR LF, LF and other cursor redraws are not
sampled; the normal screen keeps its marker identities and is not sampled.
Change notifications still fire once per child write.

Each rendered logical line is sanitized, and its first 1024 UTF-16 code units
are used for regex evaluation and display; the rest of that line is ignored.
Each message shows at most 16 lines and counts omitted matches.
Matches arriving within about 250 ms coalesce. Successful messages alone
advance `returns`; the last allowed match message announces the limit and
ends the subscription, not the process. More than 20 matching lines in the
preceding 60 seconds adds an advisory to narrow the condition, without stopping.

Each return is a `unified-exec-monitor` message using the existing completion
display path with `display: true`, `triggerTurn: true`, `deliverAs: "followUp"`.
It names the session, condition, successful count/limit, bounded matching
lines, and `terminal_url` or `log_path`, and labels command output as
untrusted rather than user instructions. The monitor tool itself uses omp's
default card; no new UI styling is introduced.

Output closure and final parser completion produce one End with
the pending matches, natural/human/LRU reason and exit code/signal. End does
not count against the match limit. Model `kill_session` cancels before
signaling, even on failed kill; explicit cancel, replacement, reset and
shutdown are also silent. Human HUD/slash termination and LRU termination
retain the monitor until actual closure. Direct write/listing observations
do not cancel it. A source acceptance before model kill is cancelled; a new
parallel acceptance after the kill request may still observe a running source.

The completion coordinator owns both distinct objects: optional wake intent
and actual monitor subscription. An active/closing monitor blocks ordinary
wake reservation. Successful End consumes that session's wake before removing
the monitor; failed sends remain owned and retry only on subsequent safe host
flush boundaries. Idle failed delivery may wait for such a boundary. Limit or
explicit cancellation removes the monitor without consuming a future ordinary
wake. All replacement/reset callbacks check exact subscription and map
identity. No already-enqueued follow-up can be recalled.

Source handles physically remove both rendered-row and close listeners on cancellation,
not merely disable their callbacks. `Gate.subscribe` queues closure callbacks
in the same microtask order as `closed().then`, preserving freeze, final drain,
then release while allowing cancelled subscriptions to detach before closure.

`list_sessions` exposes each active monitor's condition, returns and limit.
Neither monitor nor `read` consumes ordinary observations or removes sessions.
Brush/HostJob integration, `on_exit` defaults and its human-explicit guidance
remain unchanged.

## Non-goals

- Wake TTL / auto-expire (optional later).
- Changing the `on_exit` enum values or default away from `"none"`.
- Soft-disable of `triggerTurn` on wake delivery.

## Decisions

| Decision | Rationale |
|---|---|
| Guide `on_exit: "wake"` as **human-explicit only** | Default stays `"none"`; reduces stale resumes. |
| Add `set_on_exit` tool (disarm/re-arm without kill) | Model must be able to undo a mistaken wake while leaving the process running. |
| Mid-flight flush re-checks suppression | Disarm racing a reserved wake must not still send. |
| Source-first monitor acceptance | The source checks liveness after its parser baseline and publishes only the real installed tap; reset/abort cannot leave speculative coordinator entries. |
| Rendered row identities for monitors | Reusable current-row markers plus a history frontier prevent pre-subscription replay across trim, erase and scrolling; regex sees joined rendered logical text, not raw child bytes. |
| Sample alternate rows at bare CRs by splitting child writes | The same xterm parser stays the only authority and parsing is unchanged across split points. Rejected: xterm parser hooks (`@xterm/headless` 6 exposes no C0 execute hook, and `onCursorMove` fires once per parse); sampling CR LF/LF, whose rows scroll and would be reported twice; attributing the loss to tmux, since the marker was rendered. |
| One coordinator routes End and ordinary wake | Successful monitor End consumes the same session's wake before releasing ownership; separate claim flags or temporary disarm/rearm would create a second authority. |
| Serialized bounded match delivery | A successful host enqueue, not model-turn completion, counts toward the limit; failed batches remain pending, and End includes unreturned final matches. |

## Implementation map

| Area | Location | Notes |
|---|---|---|
| Elapsed labels and host UTC time | `src/format-time.ts` | Shared pure formatting; no deadline parser. |
| TUI presentation | `fork-features/omp-presentation.ts` | Exec/write/kill delegate to omp's native bash renderer; other tools use omp's default card. |
| Collection, shutdown and kill waits | `src/long-wait.ts` | Monotonic `waitForExitOrDeadline`, with safe timer re-arming. |
| Policy change | `src/completion.ts` → `setOnExit(id, policy, session?)` | By-id disarm (tombstones); status tokens; flushPending deliver filter. |
| Wake audit | `list_sessions` / widget / slash picker | `wake_armed` / `[wake]`. |
| Tool surface | `src/index.ts` | Input-only `write_stdin`, terminal-read/monitor guidance and human-explicit wake policy. |
| Monitor source and bounded delivery | `fork-features/monitor-subscription.ts`, `sanitizeOutputText`, `ExecSession.subscribeMonitor`, `TerminalScreen.subscribeLines`, `Gate.subscribe` | Source-owned future boundary; sanitized, bounded rendered lines before matching; physically cancellable source listeners. |
| Monitor lifecycle and tools | `CompletionCoordinator.startMonitor` / `cancelMonitor`, `src/index.ts`, `src/script-result.ts` | One actual subscription map, End/wake routing, typed errors and list state. |
| Docs | `README.md`, `Changelog.md`, this IV, `DC-0001` | Rules + API tables + workspace doctrine. |
| Tests | `tests/long-wait.test.ts`, `completion.test.ts`, `wake-e2e.test.ts`, `e2e.test.ts` | Unit + pipeline; wake-e2e `afterEach` shutdown. |

## Current agent / human guidance

```text
short one-shot command   → host bash
long / interactive job   → exec_command (PTY, no command deadline, never restarted)
read term://…            → state/content, without consuming observations
monitor(session_id, …)   → future output events; no condition means wait for completion
write_stdin              → nonempty input only, attachment window clamped to [250, 30_000] ms
on_exit default          → "none"
on_exit "wake"           → ONLY if human explicitly wants auto-resume
mistaken / abandoned wake → set_on_exit(session_id, on_exit: "none")  # does not kill
kill_session             → kill process AND suppress wake
list_sessions            → includes wake_armed for audit
```

Disarm cannot recall a follow-up already queued via `pi.sendMessage`.

Use `monitor(session_id, condition)` to await subsequent matching output, or
omit the condition to await closure. Cancel with `monitor(session_id,
action: "cancel")` when the observation is no longer wanted. Do not arm an
extra ordinary wake merely to implement monitor; an already-armed wake is
merged automatically at End.

## Evidence

### Wake delivery regression

The tool-core harness covers killed and disarmed sessions, unobserved failures,
input-bearing direct completion, failed finalization, and End/wake merging.
Rejected zero-byte writes do not acquire an observation lease or consume output.
Real omp acceptance must additionally exercise three zero-byte inputs, a later
successful input write, removed-argument schema rejection, an ordinary completion
wake containing `term://`, and an interactive long job using reads and monitors
with no zero-byte write calls.

Current regression commands use Bun's native runner:

```bash
bun test ./tests/long-wait.test.ts ./tests/completion.test.ts
bun test ./tests/wake-e2e.test.ts
bun test ./tests/e2e.test.ts
npm test
```

### Related pre-fix diagnosis

Stale wake is **not** “default is wake”. Default is `"none"`. The footgun is:
guidance over-promotes wake + no undo path + `triggerTurn: true` on late exit.

## Consumers

- omp agents loading this extension's tools.
- Humans reading terminal screens and waiting for progress/completion notifications.
- Skills/prompts directing session observation: reads obtain state/content,
  monitors wait for events/completion, and writes send input.

## Open / later

- Optional wake TTL if stale resumes remain common even with guidance + disarm.
- Human slash-command action for `set_on_exit` (picker currently kill-only;
  wake is now visible as `[wake]`).
- Soften `triggerTurn` for very old completions (product choice).

