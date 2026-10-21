# Development

Onboarding guide for hacking on this extension. For end-user install
and tool reference, see [../README.md](../README.md).

## Prerequisites

- **Node ≥ 22.19** (see `package.json` `engines`; we use `AbortSignal`,
  `fetch`, native ESM with `.ts` imports via
  [tsx](https://github.com/privatenumber/tsx)).
- **Linux, macOS, or Windows.** On Windows, Git Bash is strongly
  recommended (it's the default shell when on PATH; otherwise commands
  fall back to `powershell`). Node PTY tests use the optional
  `@homebridge/node-pty-prebuilt-multiarch` ConPTY backend; Bun 1.4+ uses
  its native `Bun.Terminal` backend.
- **omp** installed and runnable (`omp --version`). Only omp is supported;
  Pi and other non-omp hosts fail at the extension factory before tool registration.

## First-time setup

Clone the repo and install dev dependencies:

```bash
git clone https://github.com/oh-my-omp/omp-unified-exec
cd omp-unified-exec
npm install
```

Load the working copy directly for interactive testing:

```bash
omp --no-extensions -e "$PWD/src/index.ts" --no-session
```

The package declares its extension under `omp.extensions`. To exercise package
installation rather than a checkout, use `omp plugin install` with a Git URL.

`npm install` fetches `@homebridge/node-pty-prebuilt-multiarch` for the Node
runtime tests. Bun 1.4+ does not load that optional package; its PTY path uses
`Bun.Terminal`. Every session needs a PTY: if the Node package has no usable
prebuild, Node-hosted `exec_command` reports the load error at call time.

Verify the install:

```bash
npm run check                       # clean strict typecheck
npm test                            # typecheck + all tests
```

Expect `fail 0`. Some suites skip on unsupported platforms, when no usable
Node PTY backend is installed, or when their explicit runtime gate is unset.

## Repo layout

See [Layout](../README.md#layout) for the `src/` layout. A
sibling view, indexed by concern:

| Concern | File(s) |
|---|---|
| Tool schemas and orchestration | `src/index.ts` (`exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions`) |
| Session lifecycle (spawn, write, kill, log-stream) | `src/session.ts` |
| Session registry, LRU eviction, shutdown | `src/session-store.ts` |
| Per-call observation (`CollectResult`: screen, final screen or none) | `src/collect.ts`; produced by `ExecSession.collect` in `src/session.ts` |
| Event-driven, monotonic waits: relative and absolute empty polls, collection, kill confirmation | `src/long-wait.ts` + `src/time.ts`, `runAttachedWait` in `src/index.ts` |
| Human duration / remaining labels | `src/format-time.ts` (re-exported remaining helper from `time.ts`) |
| `on_exit: "wake"` completion scheduling (exactly-once) | `src/completion.ts` (`setOnExit`, tombstones, flush) |
| Rendered terminal screen: emulator, history + screen observations, snapshots | `src/terminal-screen.ts` (owned by `ExecSession`) |
| On-disk raw log file mirroring | `src/session.ts` (`logStream`) |
| Terminal-inert result/partial text | `src/output-safety.ts` |
| Bounded process/kill details + LLM-visible text | `src/tool-result.ts` (host-compatible `truncateTail`) |
| C-style escape decoding for `chars` | `src/unescape.ts` |
| PTY backends (Bun.Terminal / Node node-pty), spawn preflight, Windows tree-kill | `src/pty.ts` |
| Shell selection & argv construction | `src/shell.ts` |
| omp-only host admission, bash delegation, argument/result display adapters | `fork-features/omp-presentation.ts` |
| Structured output schemas and projections | `src/script-result.ts` |
| Initiative / doctrine docs | `docs/IV-*.md`, `docs/DC-*.md` |
| Constants mirroring codex | top of `src/index.ts` |

## Dev loop

1. Edit files under `src/`.
2. `npm run check` (catch type errors early).
3. `npx tsx --test tests/<relevant>.test.ts` (fast inner loop).
4. `npm test` before committing.
5. In a running omp: `/reload` to pick up changes.

### Important gotchas for the dev loop

- **`/reload` does NOT affect tool calls already in flight.** Finish or
  kill the call (`kill_session` tool, or Esc on the omp prompt) before
  reloading, otherwise you'll mix old and new code.
- **If you're driving this extension's own tools from the omp session
  you're editing,** you're working against a snapshot: your edits take
  effect *after* `/reload` (or after full omp restart). Symptom: you
  change `src/unescape.ts`, save, call `write_stdin chars="\x03"` —
  still see the old behavior. Run `/reload` and retry.
- **`omp -p` (print mode) loads extensions fresh per invocation.** No
  `/reload` needed, but each run is a new process.

### Live testing on omp

```bash
omp --no-extensions -e "$PWD/src/index.ts" --no-session
```

Ask the model to start a long-running command through `exec_command`, drive
input with `write_stdin`, and terminate it with `kill_session`. Exec/write/kill
must use omp's bash cards; monitor/set-on-exit/list use its default cards.
For Tern, exercise the counter, session picker, typed input and Kill in a real
window; the procedure is in
[fork-features/README.md](../fork-features/README.md).

For a fresh non-interactive tool execution:

```bash
omp --no-extensions -e "$PWD/src/index.ts" --mode json --no-session \
  -p 'Call exec_command with {"cmd":"echo omp-only-ok"}. Reply done.'
```

## Running specific test files

```bash
# Pure units (fast, no subprocesses)
npx tsx --test tests/notify.test.ts \
                tests/truncate.test.ts \
                tests/unescape.test.ts \
                tests/session-store.test.ts

# End-to-end against real bash / cat in a PTY (seconds)
npx tsx --test tests/e2e.test.ts
npx tsx --test tests/chars-encoding.test.ts

# Node PTY backend (requires @homebridge/node-pty-prebuilt-multiarch)
npx tsx --test tests/e2e-pty.test.ts

# Bun PTY backend, directly and from a compiled executable
bun tests/bun-pty-runtime.mjs
bun build --compile tests/bun-pty-runtime.mjs --outfile /tmp/bun-pty-runtime
/tmp/bun-pty-runtime

# Empty-poll duration policy, shared waits and wake delivery
npx tsx --test tests/time.test.ts tests/long-wait.test.ts tests/wake-e2e.test.ts

# Display adapters and direct host-admission checks
npx tsx --test tests/omp-presentation.test.ts

# Native Bun PTY-backed HUD lifecycle
EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

## Writing new tests

We use Node's built-in `node:test` runner loaded via `tsx` (no jest,
no vitest). Pattern:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { myFunction } from "../src/my-module.ts";

describe("my-module", () => {
  it("does the thing", () => {
    assert.equal(myFunction("in"), "out");
  });
});
```

For end-to-end tests that need the full tool pipeline, use the
`makeHarness()` pattern from `tests/e2e.test.ts` — it calls the named
`activate` export with a stub `ExtensionAPI` and exposes `call(toolName, args)`
and `emit(event)` so you can drive tools directly without a running LLM.
The default factory is the omp admission boundary; never use a fake host there
to test generic tool behavior.

## Common tasks

### Add a new escape sequence to `unescape.ts`

1. If it's a one-character escape (`\X` → single char): add an entry
   to the `SIMPLE_ESCAPES` map in `src/unescape.ts`.
2. Add a test case under `"decodes simple one-char escapes"` in
   `tests/unescape.test.ts`.
3. Update the escape table in `README.md` under
   "Control bytes and escapes in `chars`".

Multi-char escapes (like `\xHH`, `\u{…}`) live in the main decode
loop; see the existing `\x` and `\u` branches for the pattern.

### Change a codex-facing constant

All constants live at the top of `src/index.ts` with a comment block
stating whether they mirror codex or diverge. When you touch one:

1. Update the value.
2. Update the `## Constants` section in `README.md`.
3. Check whether any e2e test depends on the old value (search for
   the number literal).

### Add a new output-result field

1. Add it to `ProcessResultDetails`, `KillResultDetails`, or their shared
   envelope in `src/tool-result.ts`.
2. Populate it in `finalizeProcessResult()` / `finalizeKillResult()`.
3. Add it to `renderProcessResultText()` / `renderKillResultText()` only when
   the model needs the field in textual content (details are TUI/session data).
4. If the TUI should show it, update the display adapter in
   `fork-features/omp-presentation.ts`.
5. Add a pure assertion in `tests/tool-result.test.ts` and an end-to-end
   assertion in `tests/e2e.test.ts` when process lifecycle matters.

Never put an unbounded value in `content` or details and expect
`renderResult` to hide it: model bounds must hold independently of display.
Child bytes go through the session's `TerminalScreen` first; pass its rendered
text through `sanitizeOutputText()` before model/session/TUI use. Only the
on-disk log owns the exact raw stream. Keep renderer-side sanitization as
defense for legacy results and fallback content.

### Tune TUI rendering

`fork-features/omp-presentation.ts` adapts exec/write/kill to omp's exported
bash renderer, including Tern's describe hooks. Other tools use omp's default
cards. Keep model content and persisted details unchanged by display adapters.
Update `tests/omp-presentation.test.ts`, then exercise the actual omp ANSI TUI
and Tern path. A missing or reshaped required omp module must fail factory
loading before tools register, not fall back to another host's rendering.

## Debugging aids

- **Per-session log files** at `/tmp/pi-unified-exec-<sid>-*.log`
  capture the complete raw byte stream the child wrote. Tail them to
  diagnose ANSI / control-sequence issues.
- **`details.output` vs `content[0].text`**: the LLM reads
  `content[0].text` (structured); the TUI renderer reads
  `details.output` (clean body). If the TUI shows a header like
  `[still running]\nsession_id: …` verbatim, the renderer is failing
  and falling back to omp's default. Check `fork-features/omp-presentation.ts`.
- **`list_sessions` tool** (invokable from the LLM side) is the
  quickest way to audit what's live.
- **omp's `/reload` output** echoes the extensions it loaded — check
  that `unified-exec` (or `src/index.ts` under it) is listed.

## Checking omp compatibility

Review [oh-my-pi](https://github.com/can1357/oh-my-pi) release notes and the
extension API, bash renderer, theme, native rendering and internal-URL seams
listed in [fork-features/README.md](../fork-features/README.md).
The host must continue to identify itself through `ExtensionAPI.arktype`.

The retained `@earendil-works/*` imports are compatibility-layer types and
helpers, not a Pi support promise:

- `pi-coding-agent`: `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`,
  `AgentToolUpdateCallback`, `ToolDefinition`, `TruncationResult`;
  `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize`, `truncateTail`.
- `pi-tui`: `matchesKey` and `Component` for the Tern HUD's ANSI input/component
  boundary.

Run `npm run check` and `npm test`, then validate the actual installed omp
runtime. Stub-host tests alone do not qualify host compatibility. Confirm
checkout loading, `omp plugin install` loading through `omp.extensions`,
exec/write/kill cards, and Tern terminal interactions; required host modules
must fail loading rather than silently degrade. Record observed qualification
in `Changelog.md` with environment and evidence.


## Package delivery

This fork does not publish to npm; its publish workflow is disabled.
Users install the Git source with:

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

`files` in `package.json` includes `src`, the fork's TypeScript modules and
bundled Tern plugin, `README.md`, and `LICENSE`. Keep required runtime files
inside that package set.

## Commit conventions

Match the existing history:

```
unified-exec: <terse present-tense summary>

<paragraph(s) of what and why, wrapped to ~72 cols>

- bullet of file/change
- bullet of file/change

<N>/<N> tests pass; clean typecheck.
```

Keep each commit focused (one feature / fix). `git log --oneline` for
prior commits gives a sense of scope.

## Sources to read before changing core behavior

- Codex's `unified_exec` implementation is the reference for session
  semantics:
  [`codex-rs/core/src/unified_exec/`](https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec)
- omp's built-in `bash` renderer and extension APIs:
  [oh-my-pi source](https://github.com/can1357/oh-my-pi), especially
  `packages/tui/src/tools` and `packages/coding-agent/src/extensibility`.

Both source trees are worth keeping open in split panes while you work.
