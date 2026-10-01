# Continuous integration

`Check` runs on pull requests and explicit manual dispatch. Every existing test,
typecheck and build command runs once on Windows, with JavaScript and four Python
suites in parallel. `CI required` succeeds only when every test job succeeds;
failed, cancelled or skipped dependencies fail the gate.

Normal changes go through a pull request. There is no push trigger: merging an
already validated PR does not start a second full run on the same tree. A PR's
new commit cancels its obsolete run. Main's existing strict required-check
protection remains in force.

Keep `CI required` as the protected check. Do not add `continue-on-error` to
required tests or make the gate unconditional. Branch protection is configured
separately in GitHub; this file does not enable it.

For an exceptional direct branch update or manual investigation, run:

```powershell
gh workflow run check.yml --ref <branch>
```

Manual dispatch is available once this workflow is on the default branch. It runs
the complete Windows suite for the chosen ref. It is not a substitute for the
required PR check. Runtime, dependencies, test fixtures and test inventory are
unchanged; Linux runtime compatibility is not tested by this workflow.

The Python geometry suites do not require Blender. Hosted CI does not replace
the Blender export and viewport checks needed for character changes. Local
iteration can use focused suites; the PR runs the full inventory for its branch.
