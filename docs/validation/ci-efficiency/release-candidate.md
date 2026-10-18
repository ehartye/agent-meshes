# Versioned candidate and tag verification

The owner approved setting the final version before CI and avoiding another full
suite solely for the release tag. This candidate includes the mesh-selection guide
and affected CI as0.19.0. The source selector PR149 completed every hosted lane and
was squash-merged before this candidate was rebased onto current main.

After full selected-job success, Check records `candidate.json` with the actual
checked Git tree/commit, repository, version, run ID/attempt and full scope. The
receipt artifact is named `validated-tree-<tree>`. Tag verification requires a
matching package version/tree and a completed successful Check run from this
repository. A normal squash commit can share the checked tree; a changed file
cannot. Failed, forked, unrelated, partial, expired or absent evidence is refused.
No cross-version semantic cache or exemption was added. A later version bump still
requires full validation; avoid that second bump by finalizing the version first.

Six release tests were written first and all six failed against inert exports.
The implementation passes those six plus the original eight policy tests. Six
Python documentation tests pass; actionlint1.7.12 and exact original run-command
comparison pass. Independent review found no blocking issue and checked actual
GitHub run/artifact field shapes. The short tag workflow needs the final hosted
receipt before its end-to-end result can be claimed.

A fresh, isolated managed setup and a second read-only check both passed for0.19.0
on Node24.18.0. The launcher reports0.19.0; runtime fingerprint is
`dac65ff42fe99b8ddced7c42009bfc44e3d4bc4bf0c32997836a98936f360af9`.
It used a dedicated home/npm prefix outside the checkout and did not replace the
installed marketplace plugin. Vite retains its existing chunk-size warning.
Normal marketplace installation and fresh-session skill discovery remain release
delivery checks, recorded afterward in the wiki to preserve this candidate tree.

The receipt has90-day retention. If missing/expired, run full Check on the exact
candidate/tag and rerun tag verification. The workflow fails closed rather than
publishing with unknown evidence. GitHub Actions artifacts supply evidence storage;
the marketplace and managed runtime retain their separate version/fingerprint
checks. The tag workflow does not automatically publish a marketplace update.
