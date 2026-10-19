# Native batch builds and cache diagnostics implementation plan

**Goal:** Deliver the two prioritized wiki items, plus the requested authored-build vertex-colour forwarding, in one additive Meshes release.

**Architecture:** A sequential `build-batch <configs...>` invocation owns a short-lived session. It shares full byte snapshots of Blender, helper toolchain and native implementation, validates metadata/membership before reuse and publication, and destroys the context on exit. Per-asset inputs, ownership, output transaction, audit and cache keys stay independent. No persistent metadata-only hash cache or environment allowlist is introduced.

**Tech stack:** Existing Node24/TypeScript CLI, Python/Blender helper, Vitest and isolated native fixtures.

- [ ] Establish 0.22 baseline: three strict, declared disposable assets; managed launch/direct launch and snapshot/guard phase timings. Keep same cwd/environment for comparisons.
- [ ] Add failing session tests for once-only capture, changed-resource refusal, poisoning and closed-context refusal. Implement `src/build-session.ts` with validation and immutable resource ownership; counters expose full hashes performed, not a general profiler.
- [ ] Add failing real build tests for key-component reasons, missing/legacy/corrupt records, output hash failure and privacy. Version the private record and hash all exact named components; explanations never authorize hits.
- [ ] Share Blender/runtime and native implementation capture in `src/build-native-cache.ts`, helper snapshot in `src/build-provenance.ts`. Revalidate on each asset and before publishing, preserving output containment checks for every config.
- [ ] Add failing batch tests for one snapshot across several assets, independent invalidation, failure stop/unattempted report, duplicate config rejection, changed tools and API/CLI equivalence. Implement `src/build-batch.ts`, pass the internal session through buildAsset and add CLI command with existing preview/force flags. Completed outputs remain committed per asset; no whole-batch transaction is claimed.
- [ ] Forward existing `EXPORT_VERTEX_COLOR`/`EXPORT_ALL_VERTEX_COLORS` constants in the authored wrapper. Independent scoped agent owns wrapper/tests; preserve legacy omission and the current read audit. Native proof decodes actual nonuniform COLOR_0/alpha and NONE, without preview feature creep.
- [ ] Run affected tests/typecheck/build/doc controls and native cold/warm/edit/force/strict batch controls. Compare independent versus batch with identical fixture/code/env and count actual Blender calls. Native failures and metadata mutation fixtures remain evidence.
- [ ] Independent review; resolve actionable findings with RED/GREEN. Finalize0.23 metadata, review the exact versioned tree, quick dev CI/tag identity, publish source/catalog, normal Codex/Claude installation and installed batch smoke. No new full face matrix or game modification.
- [ ] Update canonical wiki backlog states, architecture/usage, exact measurements and limits, capture/ingest missing primary build-cache evidence as needed; operation-scoped sync with manifest.

Time: bounded session avoids repeated full hashes; observed benefit requires actual native measurements. Risk: stale shared snapshots or misleading misses; refuse resource changes and keep exact keys/output hashes authoritative. Complexity: one context plus one batch coordinator, with no resident process. Best practice: explicit session lifetime, per-asset ownership and structured diagnostics. Maintainability: shared implementation in Meshes and existing native exporter controls, no game-side copies.
