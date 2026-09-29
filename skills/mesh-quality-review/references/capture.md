# Repeatable GLB review capture

From the agent-meshes runtime with its dependencies and Playwright Chromium installed:

```text
node scripts/review-model.mjs path/to/review.json
```

Paths are relative to the JSON file. Use a new output directory outside the build's owned
output for each revision. The helper refuses nonempty directories to preserve prior evidence.

```json
{
  "model": "generated/model.glb",
  "output": "reviews/revision-01",
  "name": "Character construction review",
  "intent": "Preserve approved proportions and match the supplied costume board.",
  "references": [{"label": "Costume board", "path": "board.png"}],
  "regions": [
    {"name": "head", "node": "head", "offset": [0, 0.14, 0], "radius": 0.25},
    {"name": "collar", "node": "neck_01", "radius": 0.16, "elevation": 25},
    {"name": "left-hand", "node": "hand_l", "radius": 0.12},
    {"name": "right-hand", "node": "hand_r", "radius": 0.12},
    {"name": "left-boot", "node": "foot_l", "radius": 0.18, "elevation": 25},
    {"name": "right-boot", "node": "foot_r", "radius": 0.18, "elevation": 25}
  ],
  "poses": [
    {"name": "rest"},
    {"name": "idle", "clip": "idle", "phase": 0},
    {"name": "run-quarter", "clip": "run", "phase": 0.25},
    {"name": "blink", "clip": "idle", "phase": 0, "regions": ["head"],
     "morphs": {"eyeBlinkLeft": 1, "eyeBlinkRight": 1}}
  ]
}
```

This is an example, not complete coverage. Use the actual model's node, clip and morph names.
Add torso, limbs, soles/undersides, relevant motion extremes and all delivered clips.
The default orbit is 0,45,90,135,180,225,270,315 degrees. Override `angles` globally, per pose,
or per region. Zero faces +Z; 90 faces +X. Positive `elevation` looks down; negative looks up.

Use a world-space glTF Y-up `center: [x,y,z]` for static assemblies, or `node` to follow a
bone/object in each pose. `offset` is a world-space displacement from that point; `radius`
controls the framing. Check the resulting images: a node origin is not necessarily the center
of its geometry. A region name must be unique and cannot be `body`, which is captured always.

An optional unanimated rest pose must come first. Later poses require a clip. `phase` is a
normalized time in [0,1], not a source frame number. `regions: false` captures only the body;
a list selects named detail regions. Morph overrides apply after sampling the clip.

The output contains individual PNGs, contact sheets, an HTML index, copied references and a
manifest with asset SHA-256, camera and animation time. `findings.json` starts **unreviewed**.
Open the images and record observations; the helper cannot decide fidelity or visual quality.
Missing or occluded coverage must remain explicit until it is actually inspected.
