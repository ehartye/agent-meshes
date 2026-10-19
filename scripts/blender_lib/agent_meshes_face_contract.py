"""Optional arkit-face/1 metadata and GLB processing; no Blender dependency.

This profile is used by the example rigs; it does not constrain other face designs.
"""
import json
import math
from numbers import Real
from pathlib import Path
import struct
from agent_meshes_face_geometry import (
    DEFAULT_LID_FOLLOW,
    _number,
)

__all__ = [
    'ARKIT_REQUIRED',
    'ARKIT_OPTIONAL',
    'ARKIT_GAZE',
    'ARKIT_NAMES',
    'CANONICAL_EMOTIONS',
    'face_contract_extras',
    'validate_face_contract_extras',
    'merge_glb_node_extras',
    'prune_glb_morphs',
    'MORPH_POSITION_EPSILON',
    'MORPH_NORMAL_EPSILON',
    'EXTRAS_PROPERTY',
]

ARKIT_REQUIRED = (
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
    'jawOpen',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthFunnel',
    'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'cheekSquintLeft', 'cheekSquintRight',
)
ARKIT_OPTIONAL = ('noseSneerLeft', 'noseSneerRight', 'mouthPucker', 'tongueOut', 'cheekPuff')
ARKIT_GAZE = tuple(f'eyeLook{d}{s}' for s in ('Left', 'Right') for d in ('Up', 'Down', 'In', 'Out'))
# The full 52-curve ARKit blend-shape vocabulary; emotion presets may only name these.
ARKIT_NAMES = tuple(sorted(set(ARKIT_REQUIRED + ARKIT_OPTIONAL + ARKIT_GAZE + (
    'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'mouthLeft', 'mouthRight', 'mouthRollLower', 'mouthRollUpper',
    'mouthShrugLower', 'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
    'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthDimpleLeft', 'mouthDimpleRight',
))))
# Canonical starting presets from the ratified concept sheets; each head may tune its own.
CANONICAL_EMOTIONS = {
    'neutral': {},
    'happy': {'mouthSmileLeft': .9, 'mouthSmileRight': .9, 'jawOpen': .25, 'cheekSquintLeft': .6, 'cheekSquintRight': .6,
              'eyeSquintLeft': .2, 'eyeSquintRight': .2, 'browOuterUpLeft': .3, 'browOuterUpRight': .3},
    'sad': {'browInnerUp': .9, 'mouthFrownLeft': .85, 'mouthFrownRight': .85, 'eyeBlinkLeft': .25, 'eyeBlinkRight': .25,
            'eyeLookDownLeft': .4, 'eyeLookDownRight': .4},
    'angry': {'browDownLeft': 1, 'browDownRight': 1, 'eyeSquintLeft': .45, 'eyeSquintRight': .45, 'noseSneerLeft': .7,
              'noseSneerRight': .7, 'mouthFrownLeft': .35, 'mouthFrownRight': .35, 'mouthStretchLeft': .5,
              'mouthStretchRight': .5, 'jawOpen': .12},
    'surprised': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': .9, 'browOuterUpLeft': 1, 'browOuterUpRight': 1,
                  'jawOpen': .6, 'mouthFunnel': .85},
    'scared': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': 1, 'browDownLeft': .25, 'browDownRight': .25,
               'mouthStretchLeft': .9, 'mouthStretchRight': .9, 'mouthFrownLeft': .3, 'mouthFrownRight': .3, 'jawOpen': .3},
}


# ---------------------------------------------------------------- contract extras

def face_contract_extras(morphs, yaw_max, pitch_max, lid_follow=None, emotions=None, exposed_teeth=(), drop_missing=True, skeleton='head'):
    """Build the root-node `extras` for `arkit-face/1`: {'arkitFace': {...}}.

    `morphs` lists the morph names the GLB carries and must include all 21 required
    names. `emotions` defaults to the canonical concept-sheet presets; with
    `drop_missing` a preset's morph curves the head lacks are removed (gaze curves
    always stay, since they drive eye bones). `exposed_teeth` names the teeth that
    show at rest (an empty list when none do). `skeleton='body'` declares a full-body
    character: its `head` bone hangs under body bones instead of being the skin's root
    (see `add_eye_bones`); the default `'head'` is a head-only rig and writes nothing.
    """
    morphs = list(dict.fromkeys(morphs))
    missing = [name for name in ARKIT_REQUIRED if name not in morphs]
    if missing: raise ValueError(f'Missing required morphs: {", ".join(missing)}')
    presets = CANONICAL_EMOTIONS if emotions is None else emotions
    result = {}
    for name, curves in presets.items():
        result[name] = {curve: float(value) for curve, value in curves.items()
                        if not drop_missing or curve in morphs or curve in ARKIT_GAZE}
    extras = {'arkitFace': {
        'contract': 'arkit-face/1',
        'morphs': morphs,
        'gaze': {'yawMax': _number(yaw_max, 'yawMax', 0, 90, low_open=True), 'pitchMax': _number(pitch_max, 'pitchMax', 0, 90, low_open=True)},
        'lidFollow': dict(DEFAULT_LID_FOLLOW if lid_follow is None else lid_follow),
        'emotions': result,
        'exposedTeeth': list(exposed_teeth),
    }}
    if skeleton != 'head': extras['arkitFace']['skeleton'] = skeleton
    errors = validate_face_contract_extras(extras, morphs)
    if errors: raise ValueError('; '.join(errors))
    return extras


def validate_face_contract_extras(extras, morphs=None):
    """Return a list of problems with an `extras` object against the `arkit-face/1` schema (empty when valid)."""
    errors = []
    face = extras.get('arkitFace') if isinstance(extras, dict) else None
    if not isinstance(face, dict): return ['extras.arkitFace is missing or not an object']
    real = lambda value: isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)
    if face.get('contract') != 'arkit-face/1': errors.append(f'extras.arkitFace.contract must be "arkit-face/1", got {face.get("contract")!r}')
    listed = face.get('morphs')
    if not isinstance(listed, list) or not all(isinstance(n, str) for n in listed):
        errors.append('extras.arkitFace.morphs must be a list of morph names')
    else:
        missing = [n for n in ARKIT_REQUIRED if n not in listed]
        if missing: errors.append(f'extras.arkitFace.morphs lacks required morphs: {", ".join(missing)}')
        if morphs is not None and set(listed) != set(morphs):
            errors.append(f'extras.arkitFace.morphs does not match the file: listed only {sorted(set(listed) - set(morphs))}, unlisted {sorted(set(morphs) - set(listed))}')
    gaze = face.get('gaze')
    for key in ('yawMax', 'pitchMax'):
        value = gaze.get(key) if isinstance(gaze, dict) else None
        if not real(value) or not 0 < value <= 90: errors.append(f'extras.arkitFace.gaze.{key} must be a number of degrees in (0, 90]')
    follow = face.get('lidFollow')
    for key in ('down', 'up'):
        value = follow.get(key) if isinstance(follow, dict) else None
        if not real(value) or not 0 <= value <= 1: errors.append(f'extras.arkitFace.lidFollow.{key} must be a number in [0, 1]')
    emotions = face.get('emotions')
    if not isinstance(emotions, dict): errors.append('extras.arkitFace.emotions must be an object')
    else:
        for name in CANONICAL_EMOTIONS:
            if not isinstance(emotions.get(name), dict): errors.append(f'extras.arkitFace.emotions.{name} is missing')
        for name, curves in emotions.items():
            if not isinstance(curves, dict): continue
            for curve, value in curves.items():
                if curve not in ARKIT_NAMES: errors.append(f'extras.arkitFace.emotions.{name}.{curve} is not an ARKit curve')
                elif not real(value) or not 0 <= value <= 1: errors.append(f'extras.arkitFace.emotions.{name}.{curve} must be in [0, 1]')
    if face.get('skeleton', 'head') not in ('head', 'body'):
        errors.append(f"extras.arkitFace.skeleton must be 'head' or 'body', got {face.get('skeleton')!r}")
    teeth = face.get('exposedTeeth')
    if not isinstance(teeth, list) or not all(isinstance(t, str) and t for t in teeth):
        errors.append('extras.arkitFace.exposedTeeth must be a list of names (empty when no teeth show at rest)')
    return errors


def merge_glb_node_extras(path, extras_by_node):
    """Merge JSON extras into named nodes of a GLB file in place, leaving the binary chunk untouched."""
    path = Path(path)
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data): raise ValueError('Not a glTF 2.0 binary file')
    chunks, offset = [], 12
    while offset < len(data):
        size, kind = struct.unpack_from('<I4s', data, offset)
        chunks.append([kind, data[offset + 8:offset + 8 + size]])
        offset += 8 + size
    if not chunks or chunks[0][0] != b'JSON': raise ValueError('GLB has no leading JSON chunk')
    document = json.loads(chunks[0][1].decode('utf-8'))
    nodes = document.get('nodes', [])
    for name, extras in extras_by_node.items():
        matches = [node for node in nodes if node.get('name') == name]
        if len(matches) != 1: raise ValueError(f'Expected one node named {name!r}, found {len(matches)}')
        merged = matches[0].get('extras') if isinstance(matches[0].get('extras'), dict) else {}
        merged.update(json.loads(json.dumps(extras)))
        matches[0]['extras'] = merged
    text = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    chunks[0][1] = text + b' ' * (-len(text) % 4)
    body = b''.join(struct.pack('<I4s', len(chunk), kind) + chunk for kind, chunk in chunks)
    temporary = path.with_name(path.name + '.extras.tmp')
    temporary.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    temporary.replace(path)


# Morph deltas at or below these are float noise, not motion: Blender writes normal deltas of ~1e-7 on every vertex of
# every shape key (about 1.2 MB on a talking head). A micron of position and 1e-4 of a unit normal (0.006 degrees) are
# far below anything a renderer shows.
MORPH_POSITION_EPSILON = 1e-6
MORPH_NORMAL_EPSILON = 1e-4


def _read_glb(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data): raise ValueError('Not a glTF 2.0 binary file')
    chunks, offset = [], 12
    while offset < len(data):
        size, kind = struct.unpack_from('<I4s', data, offset)
        chunks.append([kind, data[offset + 8:offset + 8 + size]])
        offset += 8 + size
    if not chunks or chunks[0][0] != b'JSON': raise ValueError('GLB has no leading JSON chunk')
    return json.loads(chunks[0][1].decode('utf-8')), chunks


def _write_glb(path, document, chunks):
    text = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    chunks[0][1] = text + b' ' * (-len(text) % 4)
    body = b''.join(struct.pack('<I4s', len(chunk), kind) + chunk for kind, chunk in chunks)
    path = Path(path)
    temporary = path.with_name(path.name + '.glb.tmp')
    temporary.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    temporary.replace(path)


def prune_glb_morphs(path, position_epsilon=MORPH_POSITION_EPSILON, normal_epsilon=MORPH_NORMAL_EPSILON):
    """Drop float-noise morph deltas from a GLB in place, storing the rest as sparse accessors.

    Blender's glTF exporter writes a NORMAL delta for every vertex of every shape key,
    and on a talking head nearly all of them are float noise (at most 1.5e-7), which
    also keeps its sparse-accessor option from ever kicking in: about 1.2 MB a head
    (E8 allows 3 MB). Every morph target delta whose largest component is at most
    `position_epsilon` (POSITION, meters) or `normal_epsilon` (NORMAL and TANGENT) is
    set to zero; a target with few deltas becomes a sparse accessor (the moving
    vertices' indices and values over glTF's zero fill; an all-zero one keeps one
    explicit zero, since Unreal's importer drops a primitive whose target accessor
    has neither data nor sparse values), and a dense one keeps a plain buffer view. POSITION min and
    max are recomputed, base attributes, indices, images and animation data are
    copied untouched, and every buffer view stays 4-byte aligned. `export_glb` runs
    it after Blender's exporter. Returns {'before', 'after' (bytes), 'targets'
    (target accessors rewritten), 'values' (deltas kept), 'dropped' (non-zero
    deltas dropped)}.
    """
    position_epsilon, normal_epsilon = _number(position_epsilon, 'Position epsilon', 0), _number(normal_epsilon, 'Normal epsilon', 0)
    before = Path(path).stat().st_size
    document, chunks = _read_glb(path)
    stats = {'before': before, 'after': before, 'targets': 0, 'values': 0, 'dropped': 0}
    binary_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b'BIN\x00'), None)
    buffers, views, accessors = document.get('buffers', []), document.get('bufferViews', []), document.get('accessors', [])
    # Only a single self-contained buffer, with no extension that points into buffer views, is rewritten.
    if binary_index is None or len(buffers) != 1 or 'uri' in buffers[0] or any(v.get('buffer', 0) != 0 for v in views): return stats
    if any(key in (document.get('extensionsUsed') or []) for key in ('KHR_draco_mesh_compression', 'EXT_meshopt_compression')): return stats
    binary = chunks[binary_index][1]
    epsilon = {}
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            for target in primitive.get('targets', []) or []:
                for attribute, index in target.items():
                    limit = position_epsilon if attribute == 'POSITION' else normal_epsilon
                    epsilon[index] = min(limit, epsilon.get(index, limit))
    shared = {i for i, a in enumerate(accessors) if i not in epsilon}
    for i in epsilon:
        a = accessors[i]
        if a.get('componentType') != 5126 or a.get('type') != 'VEC3' or a.get('normalized'): shared.add(i)
    targets = [i for i in epsilon if i not in shared]

    def view_bytes(index):
        v = views[index]
        start = v.get('byteOffset', 0)
        return binary[start:start + v['byteLength']], v.get('byteStride')

    def read(accessor):
        count = accessor['count']
        values = [(0.0, 0.0, 0.0)] * count
        if 'bufferView' in accessor:
            data, stride = view_bytes(accessor['bufferView'])
            stride, start = stride or 12, accessor.get('byteOffset', 0)
            values = [struct.unpack_from('<3f', data, start + i * stride) for i in range(count)]
        sparse = accessor.get('sparse')
        if sparse:
            fmt = {5121: 'B', 5123: 'H', 5125: 'I'}[sparse['indices']['componentType']]
            data, _ = view_bytes(sparse['indices']['bufferView'])
            where = struct.unpack_from(f'<{sparse["count"]}{fmt}', data, sparse['indices'].get('byteOffset', 0))
            data, _ = view_bytes(sparse['values']['bufferView'])
            flat = struct.unpack_from(f'<{3 * sparse["count"]}f', data, sparse['values'].get('byteOffset', 0))
            values = list(values)
            for n, i in enumerate(where): values[i] = flat[n * 3:n * 3 + 3]
        return values

    # Buffer views still used by anything other than the rewritten targets are copied as they are.
    used = set()
    for i, a in enumerate(accessors):
        if i in targets: continue
        if 'bufferView' in a: used.add(a['bufferView'])
        if 'sparse' in a: used.update((a['sparse']['indices']['bufferView'], a['sparse']['values']['bufferView']))
    for image in document.get('images', []):
        if 'bufferView' in image: used.add(image['bufferView'])
    out, new_views, remap = bytearray(), [], {}

    def append(blob, extra=None):
        out.extend(bytes(-len(out) % 4))
        view = {'buffer': 0, 'byteOffset': len(out), 'byteLength': len(blob)}
        if extra: view.update(extra)
        out.extend(blob)
        new_views.append(view)
        return len(new_views) - 1

    for index in sorted(used):
        data, _ = view_bytes(index)
        remap[index] = append(data, {k: v for k, v in views[index].items() if k not in ('buffer', 'byteOffset', 'byteLength')})
    for i, a in enumerate(accessors):
        if i in targets: continue
        if 'bufferView' in a: a['bufferView'] = remap[a['bufferView']]
        if 'sparse' in a:
            a['sparse']['indices']['bufferView'] = remap[a['sparse']['indices']['bufferView']]
            a['sparse']['values']['bufferView'] = remap[a['sparse']['values']['bufferView']]
    for image in document.get('images', []):
        if 'bufferView' in image: image['bufferView'] = remap[image['bufferView']]
    for i in targets:
        a = accessors[i]
        values = read(a)
        kept = []
        for n, v in enumerate(values):
            if max(abs(v[0]), abs(v[1]), abs(v[2])) > epsilon[i]: kept.append((n, v))
            elif v != (0.0, 0.0, 0.0): stats['dropped'] += 1
        for key in ('bufferView', 'byteOffset', 'sparse'): a.pop(key, None)
        count = a['count']
        if len(kept) * (12 + (2 if count < 65536 else 4)) < count * 12:
            # Unreal's glTF importer drops a primitive whose target accessor has neither data nor sparse values, so an
            # all-zero target keeps one explicit zero.
            stored = kept or [(0, (0.0, 0.0, 0.0))]
            wide = count >= 65536
            indices = struct.pack(f'<{len(stored)}{"I" if wide else "H"}', *[n for n, _ in stored])
            flat = struct.pack(f'<{3 * len(stored)}f', *[c for _, v in stored for c in v])
            a['sparse'] = {'count': len(stored), 'indices': {'bufferView': append(indices), 'componentType': 5125 if wide else 5123},
                           'values': {'bufferView': append(flat)}}
        elif kept:
            dense = [(0.0, 0.0, 0.0)] * count
            for n, v in kept: dense[n] = v
            a['bufferView'] = append(struct.pack(f'<{3 * count}f', *[c for v in dense for c in v]), {'target': 34962})
        if 'min' in a or 'max' in a or any(t.get('POSITION') == i for m in document.get('meshes', []) for p in m.get('primitives', []) for t in p.get('targets', []) or []):
            points = [v for _, v in kept] + ([(0.0, 0.0, 0.0)] if len(kept) < count else [])
            a['min'] = [min(p[k] for p in points) for k in range(3)]
            a['max'] = [max(p[k] for p in points) for k in range(3)]
        stats['targets'] += 1
        stats['values'] += len(kept)
    out.extend(bytes(-len(out) % 4))
    document['bufferViews'] = new_views
    buffers[0]['byteLength'] = len(out)
    chunks[binary_index][1] = bytes(out)
    _write_glb(path, document, chunks)
    stats['after'] = Path(path).stat().st_size
    return stats


# Property used by Blender adapters and the GLB export postprocessor.

EXTRAS_PROPERTY = 'agent_meshes_extras'
