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
- `lathe` revolves a `profile` of `[radius, height]` points (radius 0 to 0.5, height -0.5 to 0.5,
  3 to 64 points) around y. Good for hooves, vases, bells, bowls, heads of nails.
- `prism` extrudes an `outline` of `[x, y]` points within -0.5 to 0.5 along z. Good for plates,
  fins, silhouettes, letters.
- `parent` makes the transform relative to another part. `anchor` makes it relative to a bone's
  rest frame instead; use it for anything that belongs at a joint.
- `update` takes `changes` with any part fields except `name`; unbind before changing geometry.
- `material` sets the finish, each 0 to 1: `metalness` 0 is paint, 1 bare metal; `roughness` 0 is a
  mirror, 1 chalk. Omitted, a part keeps the default matte finish (metalness 0.08, roughness 0.65).
  `{"metalness":1,"roughness":0.1}` is polished chrome. A shell takes the same `material` for its
  whole surface.

## Shells

```json
{"op":"shell.set","shell":{"name":"skin","parts":["body","neck","head"],"blend":0.12,"resolution":48}}
{"op":"shell.set","shell":{"name":"figure","parts":["torso","hip"],"cut":["hole"],"blend":0.08,"resolution":48}}
{"op":"shell.remove","name":"skin"}
```

`blend` is how far members reach toward each other before merging, in meters (bigger is
smoother, smaller keeps definition). `resolution` is grid cells along the longest axis, 16 to 96;
48 is a good default, 32 for a quick look, above 64 only for hero models (vertex count grows
fast, and a later Blender subdivision multiplies it). Members must all be rigid-bound or all
unbound. Colors and bone weights come from the member that owns each point. `cut` lists parts
subtracted from the surface with the same blend (holes, hollows); a cutter is hidden like a
member, adds no color or weight, cannot also be a member, and is carved where it sits at rest.

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

`property` is `rotation` (quaternion offset from rest) or `position` (meters offset from rest).
Key times strictly increase from 0 through `duration` (0.05 to 120 s). Matching first and last
keys make a seamless loop. Bones without a track stay at rest during playback.
