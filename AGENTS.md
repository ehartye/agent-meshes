# Agent instructions

## Testing rules (agent-tests)

- `.testing/risk.yml` says which areas are critical, standard or low. Read it before adding or changing tests.
- One owner per invariant. Before adding a test, search for an existing test of the same behavior and extend it.
- Test behavior at seams (public functions, inputs, persistence, transfers), not implementation details. Do not
  assert on mocks alone, snapshot everything, or assert a value against itself.
- Add old-format compatibility tests only for declared obligations. Current missing/invalid-input handling is
  ordinary behavior and can need coverage even with no legacy consumers. The risk map decides.
- Tests must not depend on the checkout: no fixed ports (use port 0), no fixed temp paths (use mkdtemp), no
  absolute paths, no reading `.git` directly, no writes under the home directory.
- Declare the lane in the file's first comment, before any import: `/** @lane merge */` (edit, merge, scheduled or
  release); in Python, `# @lane merge` in the leading `#` comment lines. If the test reaches code only through a
  subprocess or the network, add `@subject <path>` for that code, as a path from the project root. A test with no
  code subject gets `@risk <critical|standard|low>`.
- For a bug fix, write the failing test first and watch it fail for the reported reason. For any new test, check that
  it fails when the behavior it covers is broken.
- While editing, run only the tests for the files you changed (`npx vitest run tests/<file>.test.ts`). Before
  pushing, run `npm run gate`: it runs the checks that can reach your diff and ends with a `LOCAL-GATE-DONE` line.
  Do not run the full suite after every change, and do not edit files while a gate or a Blender build is running:
  a build refuses to finish when its helper files or the package change under it.

## How this repository keeps the gate fast

- The gate selects vitest files through a reach graph (`scripts/ci-affected.mjs`). It follows relative imports and
  repository paths written as string literals. Write a path a test depends on as a literal (`resolve('tests/fixtures/x.py')`),
  not assembled from pieces, or the graph cannot see it and falls back to every file.
- One real Blender build takes minutes. Tests in one file run one after another, so put long builds in separate
  `tests/*-blender.test.ts` files (as the `face-rig-*-blender` files do) and share the test body through `tests/helpers/`.
- A known failure that its owner has deferred is declared with `it.fails`, an owner and an expiry date in the file
  header, with every other assertion left live. Do not loosen the assertion and do not skip the test.
