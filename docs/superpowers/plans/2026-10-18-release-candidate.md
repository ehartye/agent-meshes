# Meshes 0.19.0 release candidate plan

**Goal:** Release the researched mesh selector and affected CI without repeating full CI solely for a tag.

**Architecture:** Keep full CI for the versioned candidate. After the exact-result gate succeeds with both runtime groups selected, retain a receipt named by the checked Git tree. A separate tag workflow accepts only a matching-version/tree receipt from a completed successful Check run in this repository. Missing, expired, partial or failed evidence fails closed and asks for a full Check run on the tag/candidate. Publishing remains the normal reviewed source/marketplace operation.

**Tools:** Node built-ins, Git/GitHub CLI, Actions artifacts; CI helpers under `.github/scripts/` are outside the shipped managed runtime.

- [x] Merge fully checked/reviewed selector PR149; rebase a new release branch onto current main without rewriting the existing CI branch.
- [x] Add failing Node tests for candidate receipts, tag/version/tree matching, failed/fork/partial/expired evidence, and real Git recording. Run `node --test tests/release-candidate.test.mjs`; observe failure before implementation.
- [x] Implement `.github/scripts/release-candidate.mjs`; wire receipt publication after the Check gate and `.github/workflows/release.yml` verification for version tags. Retain all runtime commands and run the new tests in quick CI.
- [x] Set package, lock root entries, plugin and local marketplace to0.19.0 before final CI. Document release identity/fallback and limits in `.github/README.md` and retained validation evidence.
- [x] Run Node/Python policy checks, actionlint and exact original-command inventory checks. Obtain independent review; correct findings before the final candidate push.
- [ ] Open the consolidated release PR and supersede PR150. Validate the exact final candidate once in hosted full CI, including a retained full receipt. Do not add evidence commits afterward; retain later observations in the wiki/PR body.
- [ ] Merge with the checked tree intact; verify a version tag through the new short workflow. Update the marketplace through a feature PR and verify the normally installed plugin/runtime and selector availability.
- [ ] Update wiki release/policy/backlog state and exact identity/timing receipts; sync. Report actual release and remaining native/automatic-trigger limits without claiming unexecuted checks.

**Checkpoint:** After local tests and independent review, reassess receipt scope and failure controls before committing the final candidate. Do not build a semantic cross-version test cache in this slice; version belongs in the candidate before its full validation.
