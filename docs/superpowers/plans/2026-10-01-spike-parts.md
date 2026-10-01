# LEGO parts and SPIKE sumo integration implementation plan

**Goal:** Add reusable real-part assembly/export to Agent Meshes and use it to construct the minimal SPIKE robot for a physically instrumented two-bot simulator.

**Architecture:** A declarative assembly manifest combines pinned LDraw parts with SI transforms, source-attributed masses, rigid-body membership and explicit collision proxies. Agent Meshes generates the GLB and a renderer-independent robot description from this same manifest. The sumo project consumes the export in a MuJoCo simulation with a documented Pybricks API subset. Catalog-based geometry/mass is available immediately; physical accuracy remains explicitly uncalibrated until measured validation data exists.

**Tech stack:** Existing TypeScript/Three.js/Node Agent Meshes; official LDraw assets; Python/MuJoCo simulator; local browser viewer. Existing workspace source formats remain compatible.

User selected enhancing the sibling Agent Meshes clone on 2026-10-01. Execute on feature branches. One implementer owns Agent Meshes; the coordinator owns the independent simulator and integration. Review spec compliance, then quality, before accepting the enhancement.

## 1. Agent Meshes real-part assembly

- [x] Run the current repository suite and record the baseline.
- [x] Add `tests/parts-assembly.test.ts` for local LDraw dependency resolution, missing/cyclic dependencies, SI bounds, axis conversion, part colors, source attribution and mass accounting. Run it and observe feature-related failures before implementation.
- [x] Create `src/parts/ldraw.ts` to load a local official-library dependency closure with Three.js LDrawLoader, validate references stay under the library, preserve attribution, and transform nominal LDU to meters, Y-up. Import render surfaces; conditional/edge lines need not become physics geometry.
- [x] Create `src/parts/assembly.ts` defining and validating the manifest, loading named part instances with explicit placements and optional body membership. Mass is provided from catalog/measurement with provenance; it must never be inferred from render mesh volume. Output bounds, total mass, center of mass, part IDs and their sources. Missing physical metadata is an error for a physical export, not zero mass.
- [x] Add `assemble <manifest> <directory>` in `src/cli.ts` with GLB, verification report, resolved physical JSON and attribution output. Export before replacing any prior successful outputs. Keep all existing authoring commands unchanged.
- [x] Test an actual SPIKE part through import, manifest save/reload, GLB validation and numerical bounds. Add CLI roundtrip coverage and invalid-manifest failures. Run targeted tests, typecheck and full suite; document the command in README.

## 2. Minimal robot source and physics

- [x] Create the sumo project on a feature branch with reproducible setup and pinned dependencies.
- [x] Fetch only the official-library parts and recursive dependencies needed by the bot. Record upstream URLs, content hashes and licenses. Use actual kit motor, hub/battery, ultrasonic, color, wheel and structural part IDs.
- [x] Build a manifest with one hub/battery, two medium motors, two stock wheels, one ultrasonic, one color sensor and necessary structure/caster. Generate and inspect top/side/front views. Compute total mass and bounds from the manifest. Keep catalog estimates distinct from measured values.
- [x] Write failing physical tests for rest stability, acceleration, braking, torque-limited wheel motion, slip, collisions, ring-out and repeatability.
- [x] Implement MuJoCo bodies from the exported physical description. Use free chassis and hinge-driven wheels, motor torque-speed and voltage/current limits, ground contacts and raised circular arena. Sensor observations derive from mounting transforms and state. Fixed timestep and seeded noise are independent of wall time.

## 3. Robot programs and match workflow

- [x] Test the supported Pybricks methods before implementation: port/device validation, `Motor.run/dc/stop/brake/hold/angle/speed`, sensor outputs, `wait` and `StopWatch` clock semantics. Add blocking motion only when completion and timeout behavior are tested. Reject unsupported APIs explicitly.
- [x] Execute two independently loaded Python controllers against simulated devices. Preserve millimeters/degrees/milliseconds at the API boundary, meters/radians/seconds inside physics. Never provide robot scripts with opponent pose or global state through the device interface. Pin and disclose supported runtime scope.
- [x] Implement start/reset/pause/step, program selection, replay/telemetry, deterministic seeded bouts and batch reports. Catch program exceptions and terminate runaway execution with a declared fault result.
- [x] Verify a real UI bout plus invalid-build and program-failure paths. Inspect the actual bot model visually and run numerical convergence/physics tests. Document calibration status and observed limitations instead of asserting unmeasured real-world accuracy.

## 4. Delivery

- [x] Independent spec review and subsequent quality review of Agent Meshes and integrated simulator; fix substantive findings and rerun affected checks.
- [x] Record as-built architecture, current roadmap, concrete commands and validation results in the wiki. Wiki stays on main and is committed/pushed through its operation helpers.
- [x] Leave source changes on the feature branches with clear local launch instructions; no remote code publication or default-branch merge is implied.

## Verification record (2026-10-01)

- Remote main fetched before feature work: f5fa7ee (0.6.0).
- Current assembly/connectivity suites: 33 passing tests; TypeScript typecheck passes.
- Simulator integration: 52 passing tests; real GLB export valid. Reference: 43 parts, 61 rest mates, approximately 357.53 g, 103.6 x 80 x 158.8 mm.
- Physical review found and corrected bracket/tire overlap, caster/frame overlap, excessive axle insertion and two pins occupying one frame hole. Generic consumed-hole alias regression added.
- Full repository test run was attempted, encountered Blender/Unreal integration failures and timeouts, and was interrupted. An untouched origin/main archive reproduces the skin-samples Blender failure: installed Blender 4.2.3 lacks AnimData.action_slot. Carving's seven tests pass on that untouched archive when run with one worker. No claim of a green full repository suite.
- Independent static-build and integrated-runtime reviews accepted the scoped changes. Checks do not prove physical assembly, articulation fidelity, structural strength or calibrated dynamics. Motor output-disc animation remains a documented limitation.
- Wiki evidence, architecture and roadmap committed/pushed on wiki main through f275940a.
- Temporary upstream comparison files remain untracked under .cache/spike-baseline because automatic approval blocked cleanup; they are excluded from implementation commits.
