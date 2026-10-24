# AGENTS.md

omp-unified-exec is an omp extension, forked from
[iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec), that runs
long-lived PTY sessions on Bun's `Bun.Terminal`. omp is the only supported
host. Setup, the concern-to-file map, test recipes and live-testing commands are
in [docs/DEV.md](docs/DEV.md); the fork's customizations, expected sync
conflicts and omp-upgrade requalification are in
[fork-features/README.md](fork-features/README.md).

## Every change

- When code, docs, tests or package metadata change, add an entry under the
  first `## Unreleased` of `Changelog.md`, newest on top. Keep that heading as
  the file's first section and leave versions alone: on every push to `main`
  the `Release` workflow bumps `package.json` and `package-lock.json` and
  renames the section to the new version.
- Change `README.md` and `README.zh-CN.md` together, section for section; the
  same holds for `fork-features/README.md` and `fork-features/README.zh-CN.md`.
- Commit with a Conventional Commit type and the issue number, e.g.
  `fix: sample alternate rows before cursor-moving CSIs too (#84)`.

## Fork customizations

- Put fork-only modules in `fork-features/` and connect them to `src/` at the
  narrowest seam. Record each new customization, and the sync conflict it will
  cause, in both fork-features READMEs.
- Upstream code the fork deleted stays deleted: Pi host support, the Node PTY
  backend, the pipe backend and `tty`, zero-byte polling, the steer gate and
  the IV/DC design docs. Port only upstream facts that still hold here.
- Delete code a change makes obsolete instead of keeping compatibility shims.
  Tool names and `PI_UNIFIED_EXEC_*` variables keep their names.

## Verification

- `npm test` runs `tsc --noEmit` and `bun test`, and must pass before a commit.
  While iterating, run `bun test ./tests/<file>.test.ts`.
- Stub-host tests do not prove host behaviour. A change to tools, results,
  presentation or omp seams also needs a run in real omp:
  `omp --no-extensions -e "$PWD/src/index.ts" --no-session`, or add
  `--mode json -p '…'` for one non-interactive call. A running omp keeps the
  old code until `/reload`, also when it drives its own tools.
- A Tern HUD change needs a real Tern window, checked as
  `fork-features/README.md` describes.
