# Unreal mesh decision tree

This is decision guidance, not a benchmark result. Start with the existing project contract and the change the
user authorized. Authoring language, import automation and runtime mesh representation are separate decisions.

```mermaid
flowchart TD
    A[Read existing pipeline and authorized scope] --> B{Geometry needs live generation or edits?}
    B -- No --> C{Generate inside Unreal?}
    C -- Yes --> D[Editor Geometry Script or existing C++ generator]
    C -- No --> E[Blender, named-part workspace or CAD]
    D --> F[Bake to StaticMesh assets]
    E --> G[Import to StaticMesh assets]
    F --> H[Check materials, collision, LODs and instancing]
    G --> H

    B -- Yes --> I{Existing proven runtime route?}
    I -- Yes --> J[Extend that route]
    I -- No --> K[Test exact Geometry Script operations in a packaged slice]
    K --> L{Supported and within budget?}
    L -- Yes --> M[Runtime Geometry Script]
    L -- No --> N[Evaluate C++ procedural components]
    J --> O[Verify collision updates and frame cost in packaged gameplay]
    M --> O
    N --> O
```

## Read the branches precisely

- **Static does not mean hand-authored.** Seeded layouts, track generators and construction-time C++ can produce
  fixed geometry that is baked in the editor. Preserve generator parameters and rebuild commands. Unreal editor
  Python can orchestrate generation, import and configuration; it is not shipped gameplay Python.
- **Include live vertex edits, not just topology changes.** A road dent can keep its indices while moving vertices
  and changing collision; that still needs a runtime update path. Moving a windmill wheel or using an existing
  skeletal/morph animation does not by itself require a procedural mesh. Preserve addressed nodes, pivots, bones
  and deformation contracts before merging/baking.
  This tree's StaticMesh branch is for static props; a character or skeletal asset retains its rig pipeline.
- **A Geometry Script trial is conditional.** Reuse a proven project route first. Otherwise test the exact runtime
  operations and actor/component class, not just plugin availability. Editor-only asset creation or generated-actor
  callbacks cannot establish packaged support. A failed trial may also justify simplifying the gameplay geometry;
  it is not automatic permission to add a new component plugin.
- **C++ is not one renderer.** ProceduralMeshComponent, DynamicMeshComponent, RealtimeMeshComponent and a runtime-built
  UStaticMesh have different capabilities, collision costs and lifetime rules. Select the smallest extension of the
  existing engine code that meets the measured need. Check third-party licensing and version support before adoption.
- **Nanite is a separate compatibility gate.** In the captured UE 5.8 docs, stock UDynamicMeshComponent lacks Nanite,
  LODs and instanced rendering; forward rendering and MSAA are unsupported by Nanite. Other asset representations,
  including skeletal support, are version-specific. C++ alone does not establish Nanite eligibility or a speed gain.

## Trial acceptance

Before batching, record the project's material/vertex-color and coordinate contracts, target-load counts, and
collision/query policy. Prove one representative asset through the real project:

1. Check saved/imported asset type, names, scale, pivot, material slots and effective vertex colors.
2. Inspect game-camera appearance and any addressed motion, LODs or repeated instances.
3. Test required collision traces and simulation in a packaged build. For live edits, measure collision-update
   delay, repeated/overlapping edits, reset/cleanup and load-dependent frame cost.
4. Report format, import, visual, gameplay and performance evidence separately. A validator or `verify-unreal`
   import receipt cannot establish all five.

The [tool profiles](tool-profiles.md) give concrete **Time, Risk, Complexity, Best practice and Maintainability**
implications for each route. The [evidence list](evidence.md) distinguishes official support, vendor claims and
single-author workarounds. Fill the [project contract card](existing-project-engagement.md) before the trial.
