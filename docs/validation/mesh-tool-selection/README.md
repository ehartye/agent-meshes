# Mesh tool selection: planning comparison

Run on 2026-10-18 using the Yoda skill-review procedure. This evaluates planning from a frozen local fixture,
not executed modeling, engine compatibility, runtime performance or installed-skill automatic triggering.

## Method

Two fresh agents were launched together with the same [cases](cases.md), inherited model/reasoning settings,
word limits and read-only constraints. The baseline could read repository documentation only through
`git show ec5c34f:<path>`; it could not read the selector, current worktree, wiki or guided output. The guided
agent read the candidate selector and relevant references plus existing build documentation. Neither browsed,
ran modeling tools, wrote the repository or self-scored. The parent inspected both verbatim outputs:
[baseline](baseline.md) and [guided](guided.md).

Before inspecting this final pair, acceptance criteria were: honor the authorized trial; inspect the existing
asset contract; separate authoring/import/runtime; distinguish editor baking from live topology; catch the
forward/MSAA constraint; propose one representative native trial; reject editor Python as gameplay runtime;
reject stock dynamic-mesh Nanite/instancing assumptions; require packaged collision/performance evidence;
retain CAD dimensions separately from game tessellation; avoid bpy solely because the project uses Python;
and route ordinary render/rig/setup tasks directly to their specialist skills.

## Observations

| Case | Baseline | Guided | Assessment |
| --- | --- | --- | --- |
| A: static ink props | Blender hybrid, separate import automation, two-asset native trial; catches the existing helper's color stripping; says Nanite is not needed | Same hybrid, explicit editor baking and forward/MSAA incompatibility; one-asset trial; preserves COLOR_0 and treats the chess recipe as local policy | Same route choice; guided states two important constraints more explicitly |
| B: live craters | Rejects gameplay certification and editor Python; warns against assuming Nanite/instancing; requires packaged crater/collision timings | Same rejection; explicitly identifies stock UDynamicMeshComponent limitations and gives collision/load acceptance checks | Both give sound plans; guided states feature limits more directly |
| C: dimensioned bracket | CAD authority, separate exact and tessellated exports, two variants; rejects unjustified in-process bpy | Same CAD authority and two-variant trial, with explicit tessellation and target budgets | No demonstrated improvement in route choice |
| D/E/F: render, rig, setup | Direct specialist routing | Direct specialist routing | No unnecessary tool-selection exercise in either condition |
| G: FBX/GLB collider mismatch | Importer-specific diagnosis; retain FBX or explicitly assign collision after GLB import | Selector entry, inspect actual importer and probe one collider | Both reject transferring FBX conventions blindly; guided names the new entrypoint |

Both conditions identify all three broad routes appropriately, provide all five cost dimensions in A-C,
and distinguish proposed checks from executed evidence. The guided answer is more explicit on two Unreal
constraints. This small sample does not demonstrate a general quality gain or justify replacing existing
specialist workflows.

## Preliminary comparison and corrections

An earlier pair inspected the original selector at `347cbd0`. Its baseline inadvertently saw README/build/setup
cross-links naming the selector and route categories. It did not read the selector or references. That pair
is excluded from the clean comparison above; its local scratch outputs remain outside the repository.

Inspection of the original prose found several problems even though its guided agent often reasoned past them:

- It said, verbatim, "Does the mesh depend on run-time state or on the route? Then it is generated in the engine."
  Seeded and editor-construction output can be baked; runtime topology changes are the deciding constraint.
- It said "Nanite belongs to a StaticMesh asset" even though its captured UE 5.8 source documents skeletal support.
- It made pipeline changes the owner's decision without accounting for an already authorized hybrid trial.
- It described per-route costs mostly as low/medium/high, and implied procedural authoring establishes a visual ceiling.

The candidate corrects those statements, separates authoring/import/runtime responsibilities, retains editable
hand-authored sources, and scopes importer workarounds and local prop recipes to their actual evidence.

## Verification scope

The parent verified local documentation links, the new skill's frontmatter/name/description limits, absence of
invisible control/tag characters, whitespace, and direct reachability of each reference. The prior research
batch contains 62 topic clippings and all 62 hashes appear in ingested source summaries. Key Unreal limits were
checked against captured evidence and current Epic documentation.

The Skill Creator YAML validator reports `Skill is valid!`; [documentation check results](documentation-checks.json)
record the local scan and final file hashes. After the paired run, only YAML quoting and a direct evidence-list
link changed in the selector; its behavioral instructions are unchanged.
Final review also narrowed the profile's import-check claim to its actual heuristic, scoped B-rep measurements
to the appropriate CAD tools, and disclosed conflicting Import Into Level format lists in Epic's captured pages.
At the owner's request, an Unreal flowchart was added as an explanatory reference after the comparison. It is
covered by structural/link checks, not an additional paired behavioral run.

## R3F, Godot and Unity extension

The owner then requested researched implications for all three engines. Five-lens source discovery per engine
selected 15 new primary sources, all captured successfully and ingested with exact raw-path/hash provenance.
Existing import and loader captures were reused. The new engine reference records rolling versus versioned
documentation limits, source-confidence caveats and concrete costs; none of this is native engine execution.

A second clean pair of fresh agents was launched together on [engine cases H-J](engine-cases.md), using the
same baseline revision/read restrictions and candidate-guided condition as above. Read their verbatim
[baseline](engine-baseline.md) and [guided](engine-guided.md) answers. Expected checks were shared-node/resource
ownership versus instancing, unique live edits and collider refresh, Godot generated-mesh reuse and LOD
preprocessing, spatial culling and separate physics, and Unity pipeline-specific batching/cooking constraints.

| Case | Result |
| --- | --- |
| H: R3F shared GLB and dent | Both retain the GLB, distinguish cloning from instancing, isolate unique geometry and require explicit demand-frame/collider updates. Guided also includes package/renderer, decoder and unmount/remount evidence. |
| I: Godot generated arches | Both allow ArrayMesh/MultiMesh reuse, spatial grouping, explicit LODs and separate static/dynamic collision. Guided explicitly distinguishes runtime LOD indices from imported-scene preprocessing and requires the tested backend/version. |
| J: Unity URP and mutable roads | Both reject universal static batching and concave simulated-body collision. Guided adds eligible SRP/GPU Resident Drawer selection, static/kinematic nuance and the documented convex triangle limit. |

Both conditions produce useful routes. The baseline invents half-day/day spike estimates without project
evidence; guided costs stay qualitative. These three cases show clearer scope and version constraints, not a
general measured advantage. Neither condition executed its proposed trial. Review found no remaining
substantive factual issue in the expanded reference; automatic installed-session activation remains untested.

No application code changed. Local application tests and Blender/Unreal executions were not needed for this
documentation change. The normal PR checks remain the repository's integration gate. No plugin version bump,
marketplace publication or installed-cache refresh is included.

Automatic activation still needs a real installed-session trial. The guided condition explicitly loaded the
skill; the D-G classifications test routing judgment, not whether a host will discover or trigger it unaided.
