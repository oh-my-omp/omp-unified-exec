# IV-0001 — Long-wait UX, wake control, and agent guidance

**Status:** active; uncapped relative empty polls and output monitors
**Root IV:** this document  
**Related release:** [Changelog.md](../Changelog.md) — 2026-07-22 — 0.7.1 / 0.7.2  
**Workspace doctrine:** [docs/DC-0001-agentic-workspace.md](./DC-0001-agentic-workspace.md)

## Current wait contract

Empty relative polls have no built-in maximum. They retain the five-second
minimum/default; exec and input-bearing calls retain the 30-second ceiling.
An explicit `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` limits relative polls and may
exceed 290 seconds. Invalid explicit configuration fails the call. Durations
must be non-negative, finite and within the safe JavaScript millisecond range.

Both empty-poll forms use `runAttachedWait` in `src/index.ts` and the monotonic,
chunked timer engine in `src/long-wait.ts`. Neither consumes output while
waiting. Cancellation leaves the unobserved screen and the live process intact. Terminal delivery
still commits at `tool_execution_end`; failed/cancelled delivery leaves an
armed wake eligible. Long polls use output-driven, rate-limited updates.

Pi owns cache warming, with no provider-specific polling rules here. Warming
is not a prerequisite for long waits and this extension never overrides its
cost policy or another extension's veto. Human-explicit absolute deadlines and
completion wakes remain unchanged.

Validation uses `npm test`, including the actual Pi CLI with a scripted local
provider in `tests/cli-wait.test.ts`. Its synthetic 12-second cache lifetime
schedules a refresh after two seconds while a 900,000 ms relative wait remains
attached to a short real child process. Cases cover streaming/idle/off modes,
an extension veto, missing cache lifetime and unavailable cost economics.
No live provider requests are made. `PI_UNIFIED_EXEC_TEST_CLI` selects another
published Pi CLI for the same acceptance test.

Observed on macOS, 2026-09-23: `EXPECT_PTY=1 npm test` passes strict types and
301 tests with three Windows-only skips on Pi 0.86.1. The six actual-CLI cases
also pass on installed Pi 0.87.1. `npm run test:tui` on 0.87.1 passes both
isolated tmux cases: a long relative wait renders and completes, and Esc
returns while the child remains alive until session shutdown. Package dry-run
passes and the production dependency audit reports zero vulnerabilities.
No Windows-native revalidation or live cache-provider probe was run.

Archive quotas, output-delivery acknowledgement, per-job concurrency changes,
and registry eviction redesign are not part of this wait-path release. They
remain separate work; this release does not claim to implement the entire
from-scratch process-manager proposal.

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
On Windows, node-pty closes the output about 1 s after the process ends (it
waits 1000 ms for trailing output, `FLUSH_DATA_INTERVAL` in its
`windowsPtyAgent`), and reports the exit only then. Matches printed just
before exit fall outside the 250 ms coalescing window and arrive as a match
message ahead of End.

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
Neither monitor nor `read` consumes ordinary observations or removes sessions. This
change does not remove empty polling, add Brush/HostJob integration, or change
`on_exit` defaults and its human-explicit guidance.

## Historical intent: 0.7.x

The original cache-specific limit and bypass rationale below are superseded
by the current contract. Wake ownership and explicit absolute-wait guidance
remain in effect.

After shipping absolute waits (`yield_until`) and completion wakes
(`on_exit: "wake"`) in 0.7.0, operators and agents hit four practical problems:

1. **Human readability** — while attached to a UTC deadline, the TUI only
   showed a raw ISO timestamp; humans need remaining time like `2h40m later`.
2. **Cache thrash** — agents used `yield_until` to bypass the 290 s empty-poll
   cap too often, defeating prompt-cache friendliness.
3. **Wake overuse** — default was already `"none"`, but tool guidance still
   promoted `"wake"`; most jobs do not need auto-resume.
4. **Stale wakes** — once armed, a late/failed background job could resume the
   agent unexpectedly, and the model had **no way to disarm** without killing
   the process.

Also: the **10 h `yield_until` horizon** was an artificial reject; multi-day
attached waits should work (with safe `setTimeout` chunking).

## Non-goals

- Wake TTL / auto-expire (optional later).
- Changing the `on_exit` enum values or default away from `"none"`.
- Soft-disable of `triggerTurn` on wake delivery.
- Making `yield_until` the default long-poll path.

## Decisions

| Decision | Rationale |
|---|---|
| Humanize remaining time in TUI only; keep ISO in tool details | Model still needs machine-parseable deadlines via `tool_time_utc` / `yield_until`. |
| Guide `yield_until` as **human-explicit only** | Prevents routine 290 s bypass and cache misses. |
| Guide `on_exit: "wake"` as **human-explicit only** | Default stays `"none"`; reduces stale resumes. |
| Add `set_on_exit` tool (disarm/re-arm without kill) | Model must be able to undo a mistaken wake while leaving the process running. |
| Remove default 10 h horizon entirely (option A) | No silent clamp; no env cap; any valid RFC 3339 UTC future is accepted. |
| Chunk timers at `MAX_TIMER_ARM_MS` (`2^31-1`) | Prevents `setTimeout` overflow on multi-day waits. |
| Mid-flight flush re-checks suppression | Disarm racing a reserved wake must not still send. |
| Source-first monitor acceptance | The source checks liveness after its parser baseline and publishes only the real installed tap; reset/abort cannot leave speculative coordinator entries. |
| Rendered row identities for monitors | Reusable current-row markers plus a history frontier prevent pre-subscription replay across trim, erase and scrolling; regex sees joined rendered logical text, not raw child bytes. |
| One coordinator routes End and ordinary wake | Successful monitor End consumes the same session's wake before releasing ownership; separate claim flags or temporary disarm/rearm would create a second authority. |
| Serialized bounded match delivery | A successful host enqueue, not model-turn completion, counts toward the limit; failed batches remain pending, and End includes unreturned final matches. |

## Implementation map

| Area | Location | Notes |
|---|---|---|
| Remaining / elapsed labels | `src/format-time.ts` | `formatRemainingLater`, `formatElapsed`, etc. Remaining re-exported from `time.ts`. |
| TUI call/footer | `src/render.ts` | Banner + streaming status use remaining label; 1 s invalidate re-runs call+result. |
| Horizon removal | `src/time.ts` | `parseYieldUntil(raw, nowMs)` — no max arg. Dropped env/constants. |
| Long timer arms | `src/long-wait.ts` | `MAX_TIMER_ARM_MS`; re-arm loop. |
| Policy change | `src/completion.ts` → `setOnExit(id, policy, session?)` | By-id disarm (tombstones); status tokens; flushPending deliver filter. |
| Wake audit | `list_sessions` / widget / slash picker | `wake_armed` / `[wake]`. |
| Tool surface | `src/index.ts` | `set_on_exit` tool + renderer; rewritten `promptGuidelines`. |
| Monitor source and bounded delivery | `fork-features/monitor-subscription.ts`, `sanitizeOutputText`, `ExecSession.subscribeMonitor`, `TerminalScreen.subscribeLines`, `Gate.subscribe` | Source-owned future boundary; sanitized, bounded rendered lines before matching; physically cancellable source listeners. |
| Monitor lifecycle and tools | `CompletionCoordinator.startMonitor` / `cancelMonitor`, `src/index.ts`, `src/script-result.ts` | One actual subscription map, End/wake routing, typed errors and list state. |
| Docs | `README.md`, `Changelog.md`, this IV, `DC-0001` | Rules + API tables + workspace doctrine. |
| Tests | `tests/time.test.ts`, `long-wait.test.ts`, `completion.test.ts`, `wake-e2e.test.ts`, `e2e.test.ts` | Unit + pipeline; wake-e2e `afterEach` shutdown. |

## Current agent / human guidance

```text
short one-shot command   → host bash
long / interactive job   → exec_command (PTY, no command deadline, never restarted)
finite yield_time_ms     → choose by job duration/responsiveness, no built-in cap
operator relative cap    → respect PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS when set
yield_until              → ONLY if human explicitly asks for long attach / UTC deadline
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

### Probe: can the model cancel wake without kill?

**Procedure** (extension harness, no full LLM turn required):

```bash
# Conceptual cases exercised in tests/wake-e2e.test.ts and ad-hoc probe:
# A kill_before_exit          → 0 wakes
# B unobserved fail exit      → 1 wake
# C write_stdin observes exit → 0 wakes (consumed)
# D list_sessions race        → unreliable (debounce window)
# E short poll while running  → still armed; later exit wakes
# set_on_exit none + fail exit → 0 wakes   (new)
```

**Observed (pre-fix):** no disarm API; only `kill_session` or observing the
exit reliably suppressed wake. `list_sessions` after exit is a race against the
~250 ms debounce.

**Observed (post-fix):**

```bash
npx tsx --test tests/time.test.ts tests/long-wait.test.ts tests/completion.test.ts
# 53 pass

npx tsx --test tests/wake-e2e.test.ts
# 26+ pass — set_on_exit disarm/re-arm, unknown sid, list wake_armed, …

npx tsx --test tests/e2e.test.ts
# 42 pass, 2 skip

npx tsx --test tests/*.test.ts
# 250+ pass, a few skip; occasional flaky notify sleep timing under load (unrelated)
```

### Related pre-fix diagnosis

Stale wake is **not** “default is wake”. Default is `"none"`. The footgun is:
guidance over-promotes wake + no undo path + `triggerTurn: true` on late exit.

## Consumers

- Pi agents loading this extension (`exec_command` / `write_stdin` / new
  `set_on_exit`).
- Humans watching TUI remaining labels during absolute waits.
- Any skill/prompt that previously told models to use `yield_until` freely or
  arm wake “just in case” — should be aligned with human-explicit rules.

## Open / later

- Optional wake TTL if stale resumes remain common even with guidance + disarm.
- Human slash-command action for `set_on_exit` (picker currently kill-only;
  wake is now visible as `[wake]`).
- Soften `triggerTurn` for very old completions (product choice).
- liveTicker cleanup if TUI drops a streaming component mid-wait (P3).

## Revision notes

- **Opened + shipped in one pass (0.7.1):** UI remaining, guidance, horizon
  removal, `set_on_exit`, tests, docs. IV written after implementation to
  preserve intent and evidence for the workspace.
- **0.7.2 (fable-5 review top 5):** wake_armed visibility; tombstone disarm by
  id; format-time unify; dead `policy` field removed; set_on_exit renderer;
  wake-e2e afterEach cleanup + waitFor debounce waits. Rejected frozen-banner
  and in-flight-send “bugs” as incorrect / by-design.
