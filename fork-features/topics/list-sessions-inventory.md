# Interpreting the terminal inventory

- `list_sessions` lists this omp run's running terminals and returned terminals not yet reclaimed, with titles, command, shell, process and lifecycle state.
- Reporting an exit here directly observes completion and suppresses a wake not yet sent. It does not read terminal output or reset the output-read lifecycle.
- A returned terminal stays listed until reclaim; a listed terminal need not still have a running command. Read `terminal_url` for retained output instead of starting the command again.

See `xd://exec_command/lifecycle` for return, read and reclaim phases and `xd://set_on_exit/wake` for exit-wake policy.
