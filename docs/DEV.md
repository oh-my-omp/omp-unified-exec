# Development

Onboarding guide for hacking on this extension. For end-user install
and tool reference, see [../README.md](../README.md).

## Prerequisites

- **Bun 1.4+**, providing native TypeScript imports, the `bun test` runner
  and `Bun.Terminal` (see `package.json` `engines`).
- **Node and npm** for the npm lockfile/install workflow, ordinary `node`
  children in `tests/bun-pty-runtime.mjs`, and the unsupported-host rejection
  regression. Node is not a supported plugin host.
- **Linux, macOS, or Windows.** On Windows, Git Bash is strongly
  recommended: with no `shell` argument, omp `shellPath` or `SHELL`, it is
  the platform default when found, otherwise commands run in `powershell`
  (see [Shell selection](../README.md#shell-selection)).
  Every PTY uses Bun's native `Bun.Terminal`.
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

Every session needs Bun's native PTY. The extension factory checks for
`Bun.spawn` and `Bun.Terminal` after identifying omp, before loading omp
modules or registering tools. A non-Bun host or a Bun build lacking those
capabilities fails immediately with the runtime reason.

Verify the install:

```bash
npm run check                       # clean strict typecheck
npm test                            # typecheck + all tests
```

Expect zero failures on Linux, macOS and Windows; CI runs the full suite on all
three. Platform-specific cases and the explicit omp install gate may skip; PTY
availability never does.
The Node admission regression compiles the actual
TypeScript entry before executing it in Node, whose strip-only loader cannot
parse the HUD's parameter properties.

## Repo layout

See [Layout](../README.md#layout) for the `src/` and `fork-features/` layout.
A sibling view, indexed by concern:

| Concern | File(s) |
|---|---|
| Tool schemas and orchestration | `src/index.ts` (`exec_command`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions`) |
| Session lifecycle (spawn, write, kill, log-stream) | `src/session.ts` |
| Session registry, LRU eviction, shutdown | `src/session-store.ts` |
| Per-call observation (`CollectResult`: screen, final screen or none) | `src/collect.ts`; produced by `ExecSession.collect` in `src/session.ts` |
| Event-driven, monotonic waits: collection, shutdown and kill confirmation | `src/long-wait.ts` |
| Human duration labels and host UTC time | `src/format-time.ts` |
| `on_exit: "wake"` completion scheduling (exactly-once) | `src/completion.ts` (`setOnExit`, tombstones, flush) |
| Rendered terminal screen: emulator, history + screen observations, snapshots | `src/terminal-screen.ts` (owned by `ExecSession`) |
| On-disk raw log file mirroring | `src/session.ts` (`logStream`) |
| Terminal-inert result/partial text | `src/output-safety.ts` |
| Bounded process/kill details + LLM-visible text | `src/tool-result.ts` (host-compatible `truncateTail`) |
| C-style escape decoding for `chars` | `src/unescape.ts` |
| Bun.Terminal backend, runtime admission, spawn preflight, Windows tree-kill | `src/pty.ts` |
| Shell selection & argv construction | `src/shell.ts` |
| omp-only host admission, bash delegation, argument/result display adapters, live `shellPath` registry lookup | `fork-features/omp-presentation.ts` |
| Tern terminal HUD: pill segment, Terminals view, terminal page | `fork-features/tern-terminal-hud.ts` |
| Removal of the Tern plugin versions up to 0.14.7 installed | `fork-features/tern-plugin-removal.ts` |
| `term://` resources, read handler and screenshots | `fork-features/terminal-resource.ts`, `fork-features/terminal-url.ts`, `fork-features/terminal-image.ts` |
| Monitors: conditions, batching, End/match/reminder delivery | `fork-features/monitor-subscription.ts`; subscriptions owned by `src/completion.ts` (`startMonitor`) |
| Input-wait alerts: prompt detection, quiet watcher, delivery | `fork-features/input-wait.ts`; `ExecSession.watchInputWait` in `src/session.ts`; `alertInputWait` in `src/completion.ts` |
| Command approval and host session binding | `fork-features/command-approval.ts`, `fork-features/session-binding.ts` |
| Structured output schemas and projections | `src/script-result.ts` |
| Tool limits, early-exit grace, session-store limits | top of `src/index.ts` |

## Dev loop

1. Edit files under `src/` or `fork-features/`.
2. `npm run check` (catch type errors early).
3. `bun test ./tests/<relevant>.test.ts` (fast inner loop).
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
For Tern, exercise the pill segment, Terminals view, typed input and Kill in a real
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
bun test ./tests/notify.test.ts \
         ./tests/truncate.test.ts \
         ./tests/unescape.test.ts \
         ./tests/session-store.test.ts

# End-to-end against real bash / cat in a PTY (seconds)
bun test ./tests/e2e.test.ts
bun test ./tests/chars-encoding.test.ts

# Real Bun PTY sessions
bun test ./tests/e2e-pty.test.ts

# Bun PTY backend, directly and from a compiled executable
bun tests/bun-pty-runtime.mjs
bun build --compile tests/bun-pty-runtime.mjs --outfile /tmp/bun-pty-runtime
/tmp/bun-pty-runtime

# Shared waits and wake delivery
bun test ./tests/long-wait.test.ts ./tests/wake-e2e.test.ts

# Display adapters and direct host-admission checks
bun test ./tests/omp-presentation.test.ts

# Native Bun PTY-backed HUD lifecycle
bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

## Writing new tests

We use Bun's native `bun test` runner with its supported `node:test` API
(no jest, no vitest). Pattern:

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

### Change a documented constant

The constants in the README's `## Constants` section live in the module that
owns them: yield limits, early-exit grace, session-store limits and
`INPUT_WAIT_QUIET_MS` at the top of `src/index.ts`, `TERMINAL_HISTORY_CELLS`
in `src/terminal-screen.ts`, `DEFAULT_REMIND_AFTER_MS` in
`fork-features/monitor-subscription.ts`, the output caps in the host's
`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`. When you touch one:

1. Update the value in its owning module.
2. Update `## Constants` (and any prose quoting the value) in `README.md` and
   `README.zh-CN.md`.
3. Check whether any test depends on the old value (search for the number
   literal).

### Add a new output-result field

1. Add it to `ProcessResultDetails`, `KillResultDetails`, or their shared
   envelope in `src/tool-result.ts`.
2. Populate it in `finalizeProcessResult()` / `finalizeKillResult()`.
3. Add it to `renderProcessResultText()` / `renderKillResultText()` only when
   the model needs the field in textual content (details are TUI/session data).
4. Add it to the TypeBox schema, type and projection in `src/script-result.ts`
   so `structuredContent` carries it, and assert the projection in
   `tests/script-result.test.ts`.
5. If the TUI should show it, update the display adapter in
   `fork-features/omp-presentation.ts`.
6. Add a pure assertion in `tests/tool-result.test.ts` and an end-to-end
   assertion in `tests/e2e.test.ts` when process lifecycle matters; update the
   response example and API tables in both READMEs.

Never put an unbounded value in `content` or details and expect
`renderResult` to hide it: model bounds must hold independently of display.
Child bytes go through the session's `TerminalScreen` first; pass its rendered
text through `sanitizeOutputText()` before model/session/TUI use. Only the
on-disk log owns the exact raw stream. Keep renderer-side sanitization as
defense for legacy results and fallback content.

### Tune TUI rendering

Tool result cards: `fork-features/omp-presentation.ts` adapts exec/write/kill
to omp's exported bash renderer, including Tern's describe hooks. Other tools
use omp's default cards. Keep model content and persisted details unchanged by
display adapters. Update `tests/omp-presentation.test.ts`, then exercise the
actual omp ANSI TUI and Tern path. A missing or reshaped required omp module
must fail factory loading before tools register, not fall back to another
host's rendering.

Tern terminal HUD (pill segment, Terminals view, terminal page):
`fork-features/tern-terminal-hud.ts`, covered by the real-PTY
`tests/tern-terminal-hud.test.ts`; requalify in a real Tern window as
[fork-features/README.md](../fork-features/README.md) describes.

## Debugging aids

- **Per-session log files** at `pi-unified-exec-<sid>-*.log` in the system
  temporary directory (`/tmp` or `%TEMP%`) capture the complete raw byte
  stream the child wrote. Inspect them with a non-executing viewer to
  diagnose ANSI / control-sequence issues.
- **`details.output` vs `content[0].text`**: the LLM reads
  `content[0].text` (structured); the TUI renderer reads
  `details.output` (clean body). If the TUI shows a header like
  `[still running]\nsession_id: …` verbatim, the renderer is failing
  and falling back to omp's default. Check `fork-features/omp-presentation.ts`.
- **`list_sessions` tool** (invokable from the LLM side) is the
  quickest way to audit what's live.
- **omp's `/reload` output** echoes the extensions it loaded — check
  that this extension is among them.

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

## Re-recording the README demos

`docs/assets/demo.*` (Python REPL, Gemini 4 Argon) and
`docs/assets/demo-lazygit.*` (lazygit, GPT-6.1 Sol) are real omp turns in a
headless Tern session, filmed by Tern's own `record` scenario command.
Re-record them when the HUD, the Terminals view or omp's tool cards change
visibly.

1. Start an isolated headless Tern with the owner's settings:
   `TERN_CONFIG_DIR=$D/config TERN_DAEMON_SOCKET=$D/daemon.sock tern serve
   --control $D/control.sock --out $D/out`, `$D` under `/tmp`, with
   `settings.json` copied into `$D/config`. omp's native rendering and the
   HUD need no Tern plugin, so `serve` shows them.
2. Drive it with `tern ctl --control $D/control.sock …`: `size 1120 760`, then
   `run "cd DIR; TMPDIR=/tmp omp --no-extensions -e $PWD/src/index.ts
   --no-session --no-title --model MODEL"` so session logs show `/tmp` rather
   than the per-user temp directory. `--no-extensions` also drops
   extension-provided model providers; pick a built-in one such as
   `openai-codex/gpt-6.1-sol`. Send `/new` before `record start NAME fps 30`:
   it clears omp's startup notices, which can name the signed-in account.
   For lazygit, `DIR` is a throwaway repository with a local `Demo` author,
   and `LG_CONFIG_FILE` points at a config with `disableStartupPopups: true`.
   Reset that repository by emptying it, not removing it: omp crashes on
   `process.cwd` when its working directory disappears.
3. Type prompts one character per `type` with `wait 28` between them (a
   prompt cannot contain `"`, which ends the scenario string), and switch to
   `record speed 3` while a model turn runs. A turn has ended when the last
   `… this turn` text in `tern ctl tree` changes. Locate the terminals segment
   with `tern ctl dump '[data-role^="omp.hud"]'` and `click` its centre;
   Enter opens the terminal page, where typed keys reach the session, Escape
   goes back, and `x` in the view kills the selected session.
4. `record stop`, then encode `$D/out/serve/NAME.mp4` into
   `docs/assets/OUT.mp4` and `OUT.gif` (`OUT` is `demo` or `demo-lazygit`):

```bash
ffmpeg -i NAME.mp4 -vf "scale=1680:-2:flags=lanczos,fps=30" -c:v libx264 \
  -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -an docs/assets/OUT.mp4
ffmpeg -i NAME.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" palette.png
ffmpeg -i NAME.mp4 -i palette.png -lavfi \
  "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" docs/assets/OUT.gif
```

Check every frame for account names, home-directory paths and tokens before
committing. GitHub does not play a repository-relative MP4 inline, so the
READMEs show the GIF and link the MP4.

## Package delivery

This fork does not publish to npm; its publish workflow is disabled.
Users install the Git source with:

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

`files` in `package.json` includes `src`, the fork's TypeScript modules,
`README.md`, and `LICENSE`. Keep required runtime files
inside that package set.

## Commit conventions

Match the existing history: Conventional Commit types (`feat`, `fix`, `docs`,
`test`, `refactor`, `ci`, `chore`; `!` marks a breaking change) with a terse
present-tense summary and the issue number:

```
fix: sample alternate rows before cursor-moving CSIs too (#84)
```

Keep each commit focused (one feature / fix). `git log --oneline` for
prior commits gives a sense of scope.

## Sources to read before changing core behavior

- This fork's behavior is defined by the READMEs, the fork customizations and
  expected sync conflicts in
  [fork-features/README.md](../fork-features/README.md), the implementation
  and its tests. Upstream and codex diverge from it (PTY-only sessions, input-only
  `write_stdin`, `term://`, `monitor`, host shell selection, omp presentation);
  do not port their behavior back over a fork deletion.
- Codex's `unified_exec`
  ([`codex-rs/core/src/unified_exec/`](https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec))
  is useful for comparing shared session semantics and candidate fixes.
- omp's built-in `bash` renderer and extension APIs:
  [oh-my-pi source](https://github.com/can1357/oh-my-pi), especially
  `packages/tui/src/tools` and `packages/coding-agent/src/extensibility`.
