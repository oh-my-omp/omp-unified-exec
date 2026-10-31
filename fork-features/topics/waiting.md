# Waiting for an outside condition

- `exec_command` has no command deadline, so a command may outlive the call's `yield_time_ms`; the call returns `session_id` while the command keeps running. `yield_time_ms` only controls how long the call stays attached, not the command's lifetime.
- Attach `monitor` to that `session_id` without `condition` to receive one wake when the session ends. With a `condition`, matching output can also wake you; every printed line can contribute to a match.
- To look at progress without disturbing the wait, read `terminal_url` (`term://…`); `monitor` observes without consuming output.
- `kill_session` stops the session and cancels its monitor silently. It does not require the waiting command to exit on its own.

See `xd://exec_command/interactive` for conditional monitors and `xd://exec_command/lifecycle` for exit wakes and reclaim.
