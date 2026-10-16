"""Rebuild the vendored MakeHuman hm08 head data (`scripts/blender_lib/data/hm08/hm08_head.npz`) from pinned CC0 sources.

    python scripts/hm08-vendor.py [--cache <folder>]

Every source file is fetched from its pinned commit (see SOURCES.json beside the output) and checked against its
SHA-256 before use. The files are read as plain data (the base mesh .obj, vertex-group and mirror tables and .target
delta files); no MakeHuman or MPFB program code is used or vendored. The output keeps the head and upper neck of the
body mesh, its helper geometry there (eyes, teeth, tongue, lashes), the joint helper cubes' centers, the mirror
table and every listed target restricted to those vertices. Original face-corner UVs and source-face indices are
retained separately from geometry vertices so atlas seams survive shape changes.

Units stay MakeHuman's: decimeters, Y up, the face looks down +Z, the character's left is +X. Target deltas have three
decimals in the sources, so they are stored exactly as int16 thousandths.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / 'blender_lib' / 'data' / 'hm08'
# Head and upper neck: every vertex above this MakeHuman height (the neck joint sits at 5.89, the chin near 6.3).
CUT_Y = 5.75
JOINTS = ('neck', 'head', 'head-2', 'jaw', 'mouth', 'l-eye', 'r-eye', 'l-eye-target', 'r-eye-target', 'l-upperlid', 'r-upperlid',
          'l-lowerlid', 'r-lowerlid', 'tongue-1', 'tongue-2', 'tongue-3', 'tongue-4')
HELPERS = ('helper-l-eye', 'helper-r-eye', 'helper-upper-teeth', 'helper-lower-teeth', 'helper-tongue', 'helper-l-eyelashes-1',
           'helper-l-eyelashes-2', 'helper-r-eyelashes-1', 'helper-r-eyelashes-2')


def fetch(entry, cache):
    """The bytes of a pinned source, from the cache or the network, checked against its SHA-256."""
    path = cache / entry['sha256']
    if path.exists(): data = path.read_bytes()
    else:
        request = urllib.request.Request(entry['url'], headers={'User-Agent': 'agent-meshes-hm08-vendor'})
        with urllib.request.urlopen(request, timeout=120) as response: data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != entry['sha256']: raise ValueError(f"{entry['url']}: SHA-256 {digest} does not match the pinned {entry['sha256']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return gzip.decompress(data) if entry['url'].endswith('.gz') else data


def parse_obj(text):
    vertices, faces, uv, face_uv = [], [], [], []
    group = None
    for line in text.splitlines():
        if line.startswith('v '): vertices.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '): uv.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('g '): group = line.split()[1]
        elif line.startswith('f '):
            corners = [token.split('/') for token in line.split()[1:]]
            faces.append((group, [int(corner[0]) - 1 for corner in corners]))
            face_uv.append([int(corner[1]) - 1 if len(corner) > 1 and corner[1] else -1 for corner in corners])
    return np.array(vertices, dtype=np.float64), faces, np.array(uv, dtype=np.float64).reshape(-1, 2), face_uv


def parse_target(text):
    index, delta = [], []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 4 or not parts[0].isdigit(): continue
        index.append(int(parts[0]))
        delta.append([round(float(v) * 1000) for v in parts[1:]])
    return np.array(index, dtype=np.int64), np.array(delta, dtype=np.int64).reshape(-1, 3)


def group_indices(groups, name):
    return sorted({i for a, b in groups[name] for i in range(a, b + 1)})


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--cache', default=str(Path.home() / '.cache' / 'agent-meshes' / 'hm08'))
    args = parser.parse_args()
    cache = Path(args.cache)
    sources = json.loads((OUT / 'SOURCES.json').read_text(encoding='utf-8'))
    files = {entry['name']: entry for entry in sources['files']}

    vertices, faces, uv, face_uv = parse_obj(fetch(files['base.obj'], cache).decode('utf-8'))
    groups = json.loads(fetch(files['basemesh_vertex_groups.json'], cache))
    mirror_rows = [line.split() for line in fetch(files['hm08.mirror'], cache).decode('utf-8').splitlines() if line.strip()]

    # The head: body faces wholly above the cut, and the helper groups' faces there.
    keep_faces, kinds, keep_uv, source_faces = [], [], [], []
    for source_face, (group, face) in enumerate(faces):
        if group != 'body' and group not in HELPERS: continue
        if min(vertices[i][1] for i in face) <= CUT_Y: continue
        keep_faces.append(face)
        kinds.append(group)
        keep_uv.append(face_uv[source_face])
        source_faces.append(source_face)
    used = sorted({i for face in keep_faces for i in face})
    local = {old: new for new, old in enumerate(used)}
    quads = np.array([[local[i] for i in face] + [-1] * (4 - len(face)) for face in keep_faces], dtype=np.int32)
    kind_names = ['body'] + list(HELPERS)
    face_kind = np.array([kind_names.index(k) for k in kinds], dtype=np.int8)
    used_uv = sorted({i for corners in keep_uv for i in corners if i >= 0})
    uv_local = {old: new for new, old in enumerate(used_uv)}
    corner_uv = np.array([[uv_local.get(i, -1) for i in corners] + [-1] * (4 - len(corners))
                          for corners in keep_uv], dtype=np.int32)

    mirror = np.full(len(used), -1, dtype=np.int32)
    for row in mirror_rows:
        a, b = int(row[0]), int(row[1])
        if a in local and b in local: mirror[local[a]] = local[b]

    joints = np.array([vertices[group_indices(groups, f'joint-{name}')].mean(axis=0) for name in JOINTS], dtype=np.float64)

    arrays = {
        'rest': vertices[used].astype(np.float64), 'index': np.array(used, dtype=np.int32), 'faces': quads,
        'face_kind': face_kind, 'kind_names': np.array(kind_names), 'mirror': mirror,
        'joint_names': np.array(JOINTS), 'joints': joints,
        'uv': uv[used_uv], 'face_uv': corner_uv, 'source_faces': np.array(source_faces, dtype=np.int32),
    }
    names = []
    for entry in sources['files']:
        if entry.get('role') != 'target': continue
        index, delta = parse_target(fetch(entry, cache).decode('utf-8'))
        inside = np.array([i in local for i in index], dtype=bool) if len(index) else np.zeros(0, dtype=bool)
        index, delta = index[inside], delta[inside]
        if np.abs(delta).max(initial=0) > 32767: raise ValueError(f"{entry['name']}: a delta does not fit int16")
        arrays[f"t:{entry['name']}:i"] = np.array([local[i] for i in index], dtype=np.int32)
        arrays[f"t:{entry['name']}:d"] = delta.astype(np.int16)
        names.append(entry['name'])
    arrays['target_names'] = np.array(names)
    np.savez_compressed(OUT / 'hm08_head.npz', **arrays)
    print(json.dumps({'vertices': len(used), 'faces': len(keep_faces), 'targets': len(names),
                      'bytes': (OUT / 'hm08_head.npz').stat().st_size}))


if __name__ == '__main__':
    sys.exit(main())
