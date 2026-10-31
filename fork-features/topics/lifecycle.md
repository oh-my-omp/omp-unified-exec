# Terminal lifetime, reclaim and exit wakes

- A running result returns `session_id`; a finished one returns `exit_code`. A process that exits is never restarted, so run it again yourself if that is what you want.
- A returned terminal stays in `list_sessions` until reclaimed. An abnormal return is reported at once; a normal one is not.
- Reclaim timers start at the return or at the last read: 30 minutes later, a never-read terminal gets one read reminder and a read one gets a reclaim notice. Then it is killed with its background jobs and unlisted unless you read it within 5 minutes.
- When your final response shows the task finished, returned terminals are reclaimed silently — no notice. Do not rely on a finished terminal staying alive across turns.
- `term://` stays readable after reclaim, so read the retained history or `log_path` instead of starting the command again.
- `on_exit: wake` resumes you once when the process exits unobserved. Set it only when the human asked for that; never for servers or watchers. A tool result that observes the exit consumes the wake.
- `set_on_exit` changes the policy without stopping the process: `none` disarms, `wake` re-arms. A queued follow-up cannot be recalled.
- `kill_session` terminates the process and suppresses the wake.
