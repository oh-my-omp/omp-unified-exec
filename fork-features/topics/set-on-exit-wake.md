# Changing an exit wake

- `set_on_exit` changes a session's `on_exit` policy without stopping the process. Use `kill_session` to terminate it and suppress its wake.
- `none` disarms as soon as auto-resume is unwanted, including after eviction. `wake` arms auto-resume while running, only when the human explicitly asked; never use it for servers or watchers.
- An exit observed by a tool result consumes an armed wake. A follow-up already queued cannot be recalled.

See `xd://exec_command/lifecycle` for terminal lifetime and `xd://kill_session/termination` for termination effects.
