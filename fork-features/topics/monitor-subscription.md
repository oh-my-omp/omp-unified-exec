# Monitoring future output

- Each batch matching `condition` wakes you; without `condition`, the session's end wakes you once. A monitor observes without consuming output, and only output after the call counts.
- Matches coalesce for about 250 ms. `kill_session` or a session reset also ends a monitor silently; delivered follow-ups cannot be recalled.
- Starting establishes or replaces the subscription; cancelling removes it silently. Reaching `max_returns` ends the monitor, not the process. End does not count toward the match limit.
- A no-return reminder quotes the current screen. Read the terminal, then answer a prompt with `write_stdin`, call `monitor` again, or cancel. A match restarts the reminder clock; a reminder neither counts toward `max_returns` nor ends the monitor.
- A session settling on an unseen input prompt raises an input-wait alert with or without a monitor.

See `xd://exec_command/waiting` for completion-only waits and `xd://write_stdin/input` before answering a prompt.
