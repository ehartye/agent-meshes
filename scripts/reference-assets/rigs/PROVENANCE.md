# Rig reference payload provenance

Mesh2Motion application source pin:
`a59685db6eb9dad90058581d08c6920f7b6f9268` in
`https://github.com/scottpetrovic/mesh2motion-app`.
Seven animal files are exact copies of `static/animations/<id>-animations.glb`.
The [catalog](catalog.json) records each original path/hash and delivered hash.
`LICENSE-CC0.MD` is the pinned upstream statement for models, blend files, rigs
and animations. `LICENSE-MIT.MD` separately records the application-code terms.
These statements do not relicense third-party FBX or rigging helper code.

Human-base and human-addon reference existing payloads under `../mannequins/`;
no duplicate human bytes are added. That library's catalog/provenance remains
authoritative for its historical source project and human-base's198 exact
duplicate-channel removals. The new catalog additionally records the observed
Mesh2Motion source pin/hash. The addon is unchanged; the base retains the already
validated JSON-only repair and unchanged binary payload.

The rigging source pin `78593cdd61d0bc3e7324648fd70a3760974e6b82` supplies 26 text
files under `rigging/`, preserved exactly in `../../rigging/rig-tools/upstream/`.
Their original bytes/hashes, module roles and tracked-at-pin flags are in the
[inventory](../../rigging/rig-tools/inventory.json). Exact snapshots deliberately
retain historical prose and machine paths; portable adapters are new Meshes code.
No blanket CC0 claim applies to this mixed-source code/assets collection.

Local raw Adobe Mixamo, CMU/rancidmilk and legacy lossy Mesh2Motion FBX exports
are inventoried with source paths, hashes and available clip IDs, not bundled.
Original CMU sample readme points to `https://rancidmilk.itch.io/free-character-animations`.
Keep that third-party provenance and applicable original terms distinct from
Mesh2Motion's art statement. Derived local NPZ motion and cached rig experiments
are also inventory-only. Tracked-at-pin false means a local snapshot observed
alongside the pinned checkout, not content proven to exist in that git commit.

Delivery checks compare all 9 GLBs, actual clip presence and Khronos validation;
all 26 text snapshots are hash-verified. Real imported CPU extraction/retarget
checks cover human-base, fox and spider diagnostic bind-chain targets, with a
separate synthetic spider-template positive/box-negative. This is bounded CPU
source verification. It does not certify all clips or targets, native imported
FBX/USD, learned inference, browser demo playback, skin clearance or final art.
