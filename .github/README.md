# Continuous integration

`Check` runs on every pull request and on pushes to `main` and
`integration/cast`. Feature-branch pushes are covered by their PR run. A newer
commit cancels the superseded run for that PR; runs for different PRs do not
cancel each other. Push runs are not cancelled while executing.

JavaScript checks and four Python groups run independently on both Ubuntu and
Windows. Typechecking and building run early in the JavaScript job. Every Python
test command remains a separate step for failure diagnosis and timing. Keep both
OS matrices and add new Python suites to exactly one group.

Use the stable `CI required` check for branch protection. It runs even when a
dependency fails or is skipped, and succeeds only when both complete matrices
succeed. Do not add `continue-on-error` to required tests or replace the gate
with an unconditional successful step. Branch protection is configured separately
in GitHub; this file does not enable it.

The Python geometry suites do not require Blender. Hosted CI does not replace
the Blender export and viewport checks needed for character changes. Local
iteration can use focused suites; the PR runs the full inventory for its branch.
