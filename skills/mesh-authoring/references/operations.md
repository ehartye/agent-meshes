# Operations by example

Run `capabilities` for the authoritative schema. Every example below is one valid operation;
they are not a sequential batch. Lengths are meters, +Y is up, quaternions are `[x,y,z,w]`.

## Parts

```json
{"op":"add","part":{"name":"body","geometry":{"type":"box","size":[1,2,1]},"position":[0,1,0],"color":"#64b9c4"}}
{"op":"add","part":{"name":"head","geometry":{"type":"sphere","size":[0.5,0.5,0.5],"segments":20},"position":[0,2.4,0],"parent":"body"}}
{"op":"add","part":{"name":"neck","geometry":{"type":"capsule","size":[0.3,0.6,0.3]},"position":[0,2,0],"rotation":[0.3826834,0,0,0.9238795]}}
{"op":"add","part":{"name":"hoof","geometry":{"type":"lathe","size":[0.16,0.1,0.16],"profile":[[0.35,-0.5],[0.5,-0.2],[0.45,0.3],[0.3,0.5]]},"anchor":"leg_L_front_fetlock","position":[0,-0.08,0]}}
{"op":"add","part":{"name":"fin","geometry":{"type":"prism","size":[0.6,0.4,0.05],"outline":[[-0.5,-0.5],[0.5,-0.5],[0.2,0.5]]},"position":[0,1,-0.5]}}
{"op":"add","part":{"name":"arm_group","geometry":{"type":"group"},"position":[0.6,1.8,0]}}
{"op":"update","name":"body","changes":{"color":"#c76f43","scale":[1,1.1,1]}}
{"op":"update","name":"body","changes":{"material":{"metalness":1,"roughness":0.1}}}
{"op":"remove","name":"fin"}
```

- Types: `box`, `sphere`, `cylinder`, `cone`, `capsule`, `lathe`, `prism`, `group`. `size` is the
  full extent in meters along x, y, z of the unit shape; `segments` (default 12) sets tessellation.
- `lathe` revolves a `profile` of `[radius, height]` points (3 to 64, bottom to top) around y. Good
  for hooves, vases, bells, bowls, turned pieces. A hollow piece runs down the inner wall and back up
  the outer wall; a profile run the other way renders inside out and is reported as the warning
  `LATHE_PROFILE_INWARD` (reverse the array to fix it). Default unit profile: radius 0 to 0.5, height -0.5
  to 0.5, world radius `r * size[0]`, centred on the part origin (bottom at `-size[1] / 2`), a
  zero-radius first or last point closes the cap. `profileUnits: "metres"` takes real meters with
  height up from the origin and ignores `size`. `corners: [i, ...]` makes hard edges (split
  normals, no extra triangles). `angleRange: [a, b]` degrees makes a capped sector that shares the
  segment grid (`segments`, `startAngle`) of a full lathe. See `capabilities lathe`.
- `prism` extrudes an `outline` of `[x, y]` points along z. Good for plates, fins, silhouettes,
  letters. The default outline is size-normalised (-0.5 to 0.5). `axis: "y"` takes `[x, z]` points
  and extrudes upward; `outlineUnits: "metres"` takes real meters and extrudes from the origin to
  `size`; `bevel` chamfers the caps. See `capabilities prism`.
- `rotationEuler: [x, y, z]` degrees (three.js XYZ: world z, then y, then x) replaces `rotation`
  on `add` and `update`; give one or the other.
- `parent` makes the transform relative to another part. `anchor` makes it relative to a bone's
  rest frame instead; use it for anything that belongs at a joint.
- `update` takes `changes` with any part fields except `name`; unbind before changing geometry.
- `material` sets the finish, each 0 to 1: `metalness` 0 is paint, 1 bare metal; `roughness` 0 is a
  mirror, 1 chalk. Omitted, a part keeps the default matte finish (metalness 0.08, roughness 0.65).
  `{"metalness":1,"roughness":0.1}` is polished chrome. A shell takes the same `material` for its
  whole surface.
- **Glass** is a `material` too. `opacity` 0 to 1 below 1 blends the surface over what is behind it
  (glTF `alphaMode: BLEND`, base color alpha = opacity); `transmission` 0 to 1 is physically
  transmitted light (`KHR_materials_transmission`); `ior` 1 to 2.333 sets `KHR_materials_ior` (1.5
  is glass); `doubleSided: true` draws both faces so a hollow bubble shows its far wall. A clear
  visor or bubble is `{"metalness":0,"roughness":0.05,"opacity":0.18,"ior":1.5,"doubleSided":true}`.
  Prefer opacity (BLEND) for a see-through visor: every consumer (three.js, Blender, Unreal) reads
  it the same way; transmission refracts in three.js and Unreal but costs an extra render pass.
  Glass casts no shadow and gets no outline hull (either would hide what is behind it). Keep glass
  a separate part from anything opaque, and keep 1.5 cm or more between the glass and what it holds.
- **Glow** is a `material` too. `emissive` is a `#rrggbb` colour the surface gives off (glTF
  `emissiveFactor`); `emissiveStrength` 0 to 1000 (default 1) scales it and is written as
  `KHR_materials_emissive_strength` when it is not 1, so it needs `emissive`. A lantern flame is
  `{"metalness":0,"roughness":0.4,"emissive":"#ff8800","emissiveStrength":4}`. Parts that differ only in
  glow export separate materials. three.js and Blender read both fields; for Unreal see
  [static props](../../mesh-build/references/unreal-static-props.md#emissive-materials).

## Shells

```json
{"op":"shell.set","shell":{"name":"skin","parts":["body","neck","head"],"blend":0.12,"resolution":48}}
{"op":"shell.set","shell":{"name":"figure","parts":["torso","hip"],"cut":["hole"],"blend":0.08,"resolution":48}}
{"op":"shell.set","shell":{"name":"nana","parts":["torso","left_leg","right_leg"],"blend":0.10,"colorBlend":0,"resolution":48}}
{"op":"shell.set","shell":{"name":"skin","parts":["body","neck","head"],"blend":0.12,"resolution":48,"pattern":{"type":"dots","color":"#ffffff","size":0.12}}}
{"op":"shell.remove","name":"skin"}
```

`blend` is how far members reach toward each other before merging, in meters (bigger is
smoother, smaller keeps definition). `resolution` is grid cells along the longest axis, 16 to 96;
48 is a good default, 32 for a quick look, above 64 only for hero models (vertex count grows
fast, and a later Blender subdivision multiplies it). Members must all be rigid-bound or all
unbound. Colors and bone weights come from the member that owns each point. `colorBlend` (meters,
min 0, default half of `blend`) is the width of the band where neighbouring members' colors mix:
`0` gives hard-edged color patches by ownership, for a figure whose parts are painted in flat
blocks of color; skin weights keep their own band either way. `cut` lists parts
subtracted from the surface with the same blend (holes, hollows); a cutter is hidden like a
member, adds no color or weight, cannot also be a member, and is carved where it sits at rest. An optional `pattern`
(`dots`, `stripes` or `checks` of a `color`, `size` in meters, `axis` default `y`, optional `offset`) paints
over the blended colors in world space; parts take the same `pattern` field, and `update` with
`{"pattern":null}` removes it. The viewer can swap it later with `setPattern` without a remesh.

## Bones and bindings

```json
{"op":"bone.add","bone":{"name":"hip","position":[0,1,0]}}
{"op":"bone.add","bone":{"name":"knee","parent":"hip","position":[0,-0.5,0]}}
{"op":"bone.update","name":"knee","changes":{"position":[0,-0.45,0]}}
{"op":"bone.mirror","name":"leg_L_hip","prefix":"R_","axis":"x"}
{"op":"bone.remove","name":"tail_tip"}
{"op":"bind","name":"thigh","binding":{"type":"rigid","bone":"hip"}}
{"op":"bind","name":"upper_leg","binding":{"type":"linear","bones":["hip","knee"],"axis":"y","range":[-0.25,0.25]}}
{"op":"unbind","name":"thigh"}
```

Bone positions are relative to the parent bone. `rigid` follows one bone. `linear` blends from
the first bone to the second along the part's local `axis` across an ascending `range`. `weights`
takes one to four named `bones` and one normalized weight row per generated vertex, which is
rarely worth authoring by hand; a shell over rigid-bound parts gives smooth skinning for free.

## Posing

```json
{"op":"pose","name":"knee","rotation":[0.3826834,0,0,0.9238795]}
{"op":"pose.target","chain":["hip","knee","ankle"],"target":[0.1,0,0.3],"pole":[0,0.5,1],"preserveEndOrientation":true}
{"op":"pose.reset"}
```

Poses are quaternion offsets from the rest rotation and never change bindings. `pose.target`
solves a two-link chain so the end bone reaches a world-space `target`, bending toward `pole`.
Axes and rotation signs (+Z front, +X tips +Y toward +Z, forward swing is negative X) are in
[mesh-rigging](../../mesh-rigging/SKILL.md).

## Assemblies

```json
{"op":"assembly.copy","root":"leg_L_hip","prefix":"R_","mirror":"x","offset":[0,0,0],"clips":true}
```

Copies a bone subtree with its bound parts and, with `clips`, its clip tracks, optionally
mirrored and offset in the root parent's frame. Model one leg, then copy it.

## Clips

```json
{"op":"clip.set","clip":{"name":"sway","duration":2,"tracks":[
  {"bone":"hip","property":"rotation","keys":[{"time":0,"value":[0,0,0,1]},{"time":1,"value":[0,0,0.258819,0.965926]},{"time":2,"value":[0,0,0,1]}]},
  {"bone":"hip","property":"position","keys":[{"time":0,"value":[0,0,0]},{"time":1,"value":[0,0.05,0]},{"time":2,"value":[0,0,0]}]}]}}
{"op":"clip.remove","name":"sway"}
```

`property` is `rotation` (quaternion offset from rest), `position` (meters offset from rest) or `scale`
(three positive multipliers of the bone's rest scale, which is `[1,1,1]`; zero or negative is rejected).
A bone has at most one track per property. `assembly.copy` with `mirror` keeps a copied scale as written.
Key times strictly increase from 0 through `duration` (0.05 to 120 s). Matching first and last
keys make a seamless loop. Bones without a track stay at rest during playback.

### Targeted clip edits

```json
{"op":"clip.create","name":"wave","duration":2,"bones":["arm_R"]}
{"op":"clip.clone","from":"wave","name":"wave_slow"}
{"op":"clip.rename","name":"wave_slow","to":"wave_big"}
{"op":"clip.retime","name":"wave_big","duration":3}
{"op":"clip.key.set","name":"wave","bone":"arm_R","property":"rotation","time":0.5,"value":[0,0,0.258819,0.965926]}
{"op":"clip.key.remove","name":"wave","bone":"arm_R","property":"rotation","time":0.5}
{"op":"clip.key.record","name":"wave","time":1,"bones":["arm_R"]}
{"op":"clip.key.record","name":"wave","time":0,"endpoints":"loop","poses":[{"bone":"arm_R","rotation":[0,0,0.258819,0.965926],"position":[0,0.05,0]}]}
```

- `clip.create` makes a clip of `duration` seconds with a rotation track on each listed bone
  (default every bone) holding that bone's current `pose` at both ends. `clip.clone` copies the
  tracks of `from` under a new `name`; `clip.rename` keeps them under `to`. Both need a free name.
- `clip.retime` scales every key time by `duration` over the old duration, so motion keeps its
  shape and only the speed changes.
- `clip.key.set` inserts a key, or replaces the one already at that time, and creates the track
  (neutral at both ends) if the bone has none. `value` is a quaternion for `rotation`, normalized
  for you, and an offset for `position`.
- `clip.key.remove` drops one interior key. It refuses to leave a track with fewer than 2 keys or
  to remove the key at 0 or at the duration, which every track needs; replace an end with `clip.key.set`.
- `clip.key.record` writes a pose at `time` into the tracks of the listed `bones` (default all),
  creating tracks as needed. Without `poses` it records each bone's stored `pose` rotation, so
  `pose` then `clip.key.record` keys a pose. `poses` give explicit rotation and position values.
- `endpoints` is `free` (default: write only the key given) or `loop` (a key at time 0 or at the
  duration is copied to the other end). A `time` outside 0 through `duration` fails; so does a
  name that is taken or an unknown clip or bone, each reported with its operation index.
- `clip.key.set` also takes `"property":"scale"` with `[x,y,z]`, and `clip.key.record` poses take an
  optional `scale`; a recorded stored pose carries rotation only.
- Only the tracks an operation names change; the rest stay identical. A batch of these is atomic
  and one `undo` restores the project from before it.

### Controls

Controls bake a stated motion into ordinary tracks of clip `name` (new clips need `duration`; an
existing clip keeps its own). No quaternion is written by hand, rotation keys are never more than a
quarter turn apart with continuous signs, and only the controlled bone and property track is
replaced; every other track stays identical. Axes are in the bone's rest frame: `x`, `y`, `z` or a vector.

```json
{"op":"control.hinge","name":"talk","bone":"head","axis":"x","from":0,"to":12,"cycles":2,"duration":4}
{"op":"control.spin","name":"run","bone":"wheel","axis":"z","turns":3,"duration":3}
{"op":"control.pulse","name":"talk","bone":"lid_L","property":"scale","peak":[1,0.05,1],"times":[1,2.6],"width":0.2}
{"op":"control.pulse","name":"talk","bone":"jaw","property":"position","peak":[0,-0.04,0],"times":[0.5],"width":0.4}
{"op":"control.couple","name":"run","driver":"gear_a","driven":"gear_b","axis":"z","teeth":[20,10],"phase":18}
```

- `control.hinge` swings `bone` from `from` to `to` degrees and back (`mode` `swing`, default, `cycles`
  times, ending where it began) or goes once from one to the other (`mode` `ramp`).
- `control.spin` turns `bone` a whole number of `turns` about `axis` (negative reverses) over the clip,
  starting at `phase` degrees, `keysPerTurn` keys per turn (4 to 360, default 8). An odd turn count
  ends on the negated quaternion, the same orientation as the start.
- `control.pulse` raises `scale` (positive multipliers, a blink is `[1,0.05,1]`) or `position` to `peak`
  and back to rest at each time in `times` (the centre) over `width` seconds, `shape` `smooth` (default)
  or `triangle`. Pulses must fit in the clip and not overlap.
- `control.couple` bakes the driven rotation `angle2 = -ratio * angle1 + phase` from the driver's
  existing rotation track about `axis` (spin or hinge the driver first). Give `ratio` or `teeth`
  `[driver, driven]`; `mesh` `external` (default) reverses the direction, `internal` keeps it. A `phase`
  of 180 over the driven tooth count lines a tooth up with a gap. By default it refuses a ratio whose driven
  end pose differs from its start; `loop: false` allows it.
