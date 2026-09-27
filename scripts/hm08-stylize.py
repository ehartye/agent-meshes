"""Derive the hm08 stylize target (`scripts/blender_lib/data/hm08/stylize01.target`) from Blender Studio's CC0 stylized head.

    python scripts/hm08-stylize.py [--cache <folder>] [--blender <executable>]

The stylized head comes from the Human Base Meshes bundle v1.4.1 (Blender Studio, CC0), pinned by SHA-256. The first
run extracts its head and eyeballs with Blender (`blender -b --python scripts/hm08-stylize.py -- --dump <bundle>
<out.npz>`); later runs reuse the extraction.

The fit, in numpy:
1. The same landmarks are found on the hm08 base head and on the stylized head: the eye openings (where each eyeball
   shows past the skin), the midline profile (nose, lips, chin), the mouth's corners and the outline.
2. hm08 is scaled and moved onto the stylized head by those landmarks, then warped by a thin-plate spline through
   them.
3. The warped skin is projected onto the stylized surface wherever the two agree (near, facing the same way, away
   from the eye sockets). The projection's displacements are relaxed along the mesh into one smooth field.
4. The result is scaled back to hm08's size and baked as per-vertex deltas on the hm08 head.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'blender_lib'))
OUT = HERE / 'blender_lib' / 'data' / 'hm08'
BUNDLE = {
    'name': 'human-base-meshes-bundle-v1.4.1.zip',
    'url': 'https://web.archive.org/web/20260823014643id_/https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip',
    'original': 'https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip',
    'sha256': '811f43accbb31a88266d932f8f5563b2d13586fca0ba2693aad1f5fe582b3515',
    'license': 'CC0-1.0 (Blender Studio Human Base Meshes)',
}
HEAD, EYES = 'GEO-head_stylized', ('GEO-head_stylized.eye.L', 'GEO-head_stylized.eye.R')


def dump(blend, out):
    """Inside Blender: the stylized head and its eyeballs, in world coordinates, to an npz."""
    import bpy
    import numpy as np
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    arrays = {}
    for key, name in (('head', HEAD), ('eye_l', EYES[0]), ('eye_r', EYES[1])):
        obj = bpy.data.objects[name]
        M = obj.matrix_world
        arrays[key + '_v'] = np.array([tuple(M @ v.co) for v in obj.data.vertices])
        arrays[key + '_f'] = np.array([list(p.vertices) + [-1] * (4 - len(p.vertices)) for p in obj.data.polygons])
    np.savez(out, **arrays)


def fetch_bundle(cache):
    path = cache / BUNDLE['name']
    if not path.exists():
        request = urllib.request.Request(BUNDLE['url'], headers={'User-Agent': 'agent-meshes-hm08-stylize'})
        with urllib.request.urlopen(request, timeout=600) as response: path.write_bytes(response.read())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != BUNDLE['sha256']: raise ValueError(f'{path}: SHA-256 {digest} is not the pinned {BUNDLE["sha256"]}')
    return path


def extract(cache, blender):
    out = cache / 'stylized-head.npz'
    if out.exists(): return out
    import zipfile
    bundle = fetch_bundle(cache)
    with zipfile.ZipFile(bundle) as archive:
        member = next(n for n in archive.namelist() if n.endswith('human_base_meshes_bundle.blend'))
        blend = cache / 'human_base_meshes_bundle.blend'
        blend.write_bytes(archive.read(member))
    subprocess.run([blender, '-b', '--python', str(Path(__file__).resolve()), '--', '--dump', str(blend), str(out)], check=True)
    # The Store build's launcher returns at once: wait for the extraction to land.
    for _ in range(600):
        if out.exists(): return out
        time.sleep(.5)
    raise RuntimeError('Blender did not write the stylized head extraction')


def derive(stylized):
    import numpy as np
    import agent_meshes_hm08 as hm
    head = hm.load_head()
    base = hm.to_blender(head.rest)
    skin_faces = head.kind_faces('body')
    data = np.load(stylized)
    S, SF = data['head_v'], data['head_f']
    mid = (S[:, 0].max() + S[:, 0].min()) / 2
    S = S - [mid, 0, 0]
    sty_eyes = []
    for key in ('eye_l', 'eye_r'):
        EV = data[key + '_v'] - [mid, 0, 0]
        r = float((EV.max(0) - EV.min(0))[0] / 2)
        # A sphere with a cornea bulging in front: its center lies a radius in front of its back.
        center = np.array([(EV[:, 0].max() + EV[:, 0].min()) / 2, EV[:, 1].max() - r, (EV[:, 2].max() + EV[:, 2].min()) / 2])
        sty_eyes.append((center, r, EV, data[key + '_f']))
    hm_eyes = hm.hm08_eyes(head, base)
    A = hm.face_landmarks(base, skin_faces, hm_eyes)
    B = hm.face_landmarks(S, SF, sty_eyes)
    keys = [k for k in A if k in B]
    P, Q = np.array([A[k] for k in keys]), np.array([B[k] for k in keys])
    s, t = hm.similarity(P, Q)
    warped = hm.tps_apply(hm.tps_fit(s * P + t, Q), s * base + t)
    body = np.zeros(len(base), dtype=bool); body[head.kind_vertices('body')] = True
    q, dist, tri = hm.closest_points(warped, S, SF)
    normals = hm.vertex_normals(warped, skin_faces)
    T = hm.triangles(SF)
    sn = hm.vertex_normals(S, SF)
    tn = sn[T[tri]].sum(axis=1); tn /= np.linalg.norm(tn, axis=1, keepdims=True)
    agree = (normals * tn).sum(1)
    reach = .012
    weight = np.clip((reach - dist) / (.4 * reach), 0, 1) * np.clip((agree - .4) / .3, 0, 1) * body
    for center, r, _, _ in sty_eyes:
        weight *= np.clip((np.linalg.norm(warped - center, axis=1) - 1.35 * r) / (.55 * r), 0, 1)
    field = hm.relax_field(q - warped, weight, hm.edges_of(head.faces), len(base))
    result = (warped + field - t) / s
    deltas = hm.from_blender(result) - head.rest
    report = {'landmarks': keys, 'scale': float(s), 'projected': int((weight > .5).sum()), 'skin': int(body.sum())}
    return deltas, report, {k: [A[k].tolist(), B[k].tolist()] for k in keys}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--cache', default=str(Path.home() / '.cache' / 'agent-meshes' / 'hm08'))
    parser.add_argument('--blender', default=os.environ.get('AGENT_MESHES_BLENDER', 'blender'))
    args = parser.parse_args()
    cache = Path(args.cache); cache.mkdir(parents=True, exist_ok=True)
    import agent_meshes_hm08 as hm
    deltas, report, pairs = derive(extract(cache, args.blender))
    header = ['hm08 stylize target 01: hm08 fitted onto Blender Studio\'s stylized head (Human Base Meshes v1.4.1, CC0).',
              f'Bundle SHA-256 {BUNDLE["sha256"]}; derived by scripts/hm08-stylize.py. Licence: CC0-1.0.',
              f'Landmarks {len(report["landmarks"])}, scale {report["scale"]:.4f}, projected {report["projected"]} of {report["skin"]} skin vertices.']
    hm.write_target(OUT / 'stylize01.target', hm.load_head(), deltas, header)
    (OUT / 'stylize01.json').write_text(json.dumps({'source': BUNDLE, 'report': report, 'landmarks': pairs}, indent=1) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None
    if argv and argv[0] == '--dump': dump(Path(argv[1]), Path(argv[2]))
    else: main()
