"""Regenerate the lantern lid fixtures: python make.py <blender_lib directory> <output.json>

Builds the continuous eye of a lantern head (big round eyes on a plain ellipsoid; the 'LANTERN48' fixture of
tests/blender_face_geometry.py) with the agent_meshes_face.py in <blender_lib directory>, and writes the triangles within
FIT eyeball radii of the eye with the eye's blink, squint and wide deltas, as plain JSON that tests/face-lids.test.ts
poses without Blender. `before-fix.json` came from the library before the lids were nested by construction
(agent-meshes 0.15.0, PR 93, commit 3826663); `after-fix.json` from the library with the nested lids.
Positions are rounded to 0.1 micrometre once per vertex, so welded vertices stay welded.
"""
import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import agent_meshes_face as face

HEAD = ((0, .006, .146), (.164, .118, .096))
EYE, RADIUS = (.064, -.064, .146), .034
OPTIONS = dict(opening=(48, 32, 40), corner=1.6, overlap=8, wide=(15, 5), squint_upper_share=.35, column_step=3, max_edge=.24 * RADIUS)
FIT = 1.35


def main(output):
    blank = face.ellipsoid_geometry(*HEAD, rings=56, segments=72)
    hole = face.eye_hole(blank['vertices'], blank['faces'], EYE, RADIUS, **OPTIONS)
    vertices, faces = hole['vertices'], hole['faces']
    moved = {tuple(round(c, 12) for c in rest): targets for rest, targets in hole['motion']}
    triangles = [t for f in faces for t in ((f[0], f[k], f[k + 1]) for k in range(1, len(f) - 1))
                 if all(math.dist(vertices[i], EYE) <= FIT * RADIUS for i in t)]
    used = sorted({i for t in triangles for i in t})
    index = {old: new for new, old in enumerate(used)}
    rounded = lambda v: [round(c, 7) for c in v]
    moving = []
    for old in used:
        targets = moved.get(tuple(round(c, 12) for c in vertices[old]))
        if not targets: continue
        row = [index[old]]
        for name in ('blink', 'squint', 'wide'): row += rounded([targets[name][k] - vertices[old][k] for k in range(3)])
        moving.append(row)
    data = {
        'provenance': f'lantern head, eye_hole(**{OPTIONS}) on ellipsoid_geometry{HEAD} (56 rings, 72 segments); the triangles within {FIT} eyeball radii of the eye',
        'center': list(EYE), 'radius': RADIUS,
        'vertices': [rounded(vertices[i]) for i in used],
        'triangles': [[index[i] for i in t] for t in triangles],
        # [vertex, blink dx, dy, dz, squint dx, dy, dz, wide dx, dy, dz] for each vertex an eye morph moves
        'moving': moving,
    }
    Path(output).write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{len(used)} vertices, {len(triangles)} triangles, {len(moving)} moving, {Path(output).stat().st_size} bytes')


if __name__ == '__main__':
    main(sys.argv[2])
