# Monitoring future output

- Each batch matching `condition` wakes you; with `judge`, each new screen the judge finds meets your intent wakes you; with neither, the session's end wakes you once. A monitor observes without consuming output, and only output after the call counts.
- Matches coalesce for about 250 ms. `kill_session` or a session reset also ends a monitor silently; delivered follow-ups cannot be recalled.
- Starting establishes or replaces the subscription; cancelling removes it silently. Reaching `max_returns` ends the monitor, not the process. End does not count toward the limit.
- A no-return reminder quotes the current screen. Read the terminal, then answer a prompt with `write_stdin`, call `monitor` again, or cancel. A return restarts the reminder clock; a reminder neither counts toward `max_returns` nor ends the monitor.
- A session settling on an unseen input prompt raises an input-wait alert with or without a monitor.
- A wake needs an unfinished task: once your final response shows the task finished, a monitor ends at its next return without waking you. To wait on it, say so in your response instead of reporting the task done; see `xd://exec_command/lifecycle`.

## Judge monitors

- Use `judge` when the awaited state has no stable text to match: state it as one plain sentence about what the screen should show ("the server is ready to accept requests"). It excludes `condition`.
- Every `judge_interval_ms` (default 60 s) omp's judge model reads your intent and the current visible screen, nothing else, and answers met or not met. The screen shown when the monitor starts and a screen equal to the last judged one are not judged.
- Each met screen is one return quoting that screen; a later changed screen that still meets the intent returns again. Use `max_returns: 1` to wake once.
- A failed judgment (no judge model, an error, no answer within 30 s) sends a failure notice and ends the monitor; the process keeps running. Starting fails with `judge_unavailable` when no judge model resolves.
- Each judgment of a changed screen costs one judge call, billed to the session; a screen that changes every interval is judged every interval.

See `xd://exec_command/waiting` for completion-only waits and `xd://write_stdin/input` before answering a prompt.
