# Documentation routing smoke check

This temporary draft PR validates the affected-CI documentation route on a real
GitHub runner. Its base is the CI feature branch. Only this Markdown file changes;
the workflow should run quick checks and `CI required`, with all six runtime jobs
deliberately skipped. The PR is closed after recording its result, without merging
this smoke-only file.

The [CI audit](audit.md) explains the preserved runtime inventory and the full-run
fallback. Failure/cancellation/missing-scope controls are tested by the policy suite.
