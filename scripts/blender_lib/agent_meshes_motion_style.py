"""Scale baked, rest-relative quaternion motion without character-specific axes.

Quaternion order is Blender's (w, x, y, z). Identity is the authored rest pose.
This scales the whole rotation, including splay and twist, not just flexion.
"""
import math
from numbers import Real


def _gain(value):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('Rotation gain must be finite and between zero and one')


def scale_rotation_samples(samples, gain):
    """Return scaled quaternion samples; never mutate inputs.

    Each rotation follows the shortest path from identity. For gains below one,
    reject half-turn samples (normalized abs(w) <= 1e-7) and adjacent samples
    crossing that path's 180-degree branch. The tolerance covers float32 roundoff.
    This is a
    sampled check, not a guarantee about motion between keys. Gain one validates
    samples and returns their original components exactly, without normalization.
    """
    _gain(gain)
    try:
        rows = [list(row) for row in samples]
    except TypeError as exc:
        raise ValueError('Quaternion samples must be an iterable of four-component rows') from exc
    if not rows:
        raise ValueError('Quaternion samples must not be empty')
    result, previous = [], None
    for row in rows:
        if len(row) != 4 or any(isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(v) for v in row):
            raise ValueError('Quaternion samples require four finite components')
        # Divide first so even finite components near float limits normalize safely.
        size = max(abs(v) for v in row)
        if size < 1e-12:
            raise ValueError('Quaternion samples must have nonzero length')
        q = [v / size for v in row]
        length = math.hypot(*q)
        q = [v / length for v in q]
        if gain != 1 and abs(q[0]) <= 1e-7:
            raise ValueError('Ambiguous half-turn rotation at the rest-angle branch')
        if q[0] < 0:
            q = [-v for v in q]
        if gain != 1 and previous is not None and sum(a * b for a, b in zip(previous, q)) < 0:
            raise ValueError('Track crosses the supported rest-angle branch')
        previous = q
        if gain == 1:
            result.append(row)
            continue
        vector_length = math.hypot(*q[1:])
        angle = math.atan2(vector_length, q[0]) * gain
        factor = math.sin(angle) / vector_length if vector_length else 0
        result.append([math.cos(angle), *(v * factor for v in q[1:])])
    return result


def scale_action_rotations(action, bones, gain):
    """Style selected bones in a Blender layered action in place.

    Requires one layer/strip, with all selected keyed quaternion tracks in one
    channelbag. Four synchronized channels, finite increasing key times, and no
    modifiers, muted curves or sampled-point curves are required. The caller must
    provide baked pose rotations in quaternion mode. Output uses LINEAR component
    interpolation; this is not continuous quaternion SLERP between keys.

    Validation of every selected track precedes all edits. Unselected curves are
    untouched. Gain one is an exact no-op after validation. Repeated calls compound
    gains; copy the source action when comparing styles.
    """
    _gain(gain)
    if isinstance(bones, (str, bytes)):
        raise ValueError('Select a nonempty iterable of unique bone names')
    try:
        names = list(bones)
    except TypeError as exc:
        raise ValueError('Select a nonempty iterable of unique bone names') from exc
    if not names or any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError('Select a nonempty iterable of unique bone names')
    layers = list(action.layers)
    if len(layers) != 1 or len(layers[0].strips) != 1:
        raise ValueError('Rotation styling requires one baked action layer and strip')
    paths = {}
    for name in names:
        escaped = name.replace('\\', '\\\\').replace('"', '\\"')
        paths[f'pose.bones["{escaped}"].rotation_quaternion'] = name
    grouped = {name: {} for name in names}
    selected_bag = None
    for bag_index, bag in enumerate(layers[0].strips[0].channelbags):
        for curve in bag.fcurves:
            name = paths.get(curve.data_path)
            if name is None:
                continue
            if selected_bag is not None and selected_bag != bag_index:
                raise ValueError('Selected rotations must belong to one action slot')
            selected_bag = bag_index
            if curve.array_index in grouped[name]:
                raise ValueError('Ambiguous rotation track: ' + name)
            if curve.modifiers or curve.mute or curve.sampled_points:
                raise ValueError('Rotation styling requires active baked keyframe curves: ' + name)
            grouped[name][curve.array_index] = curve
    edits = []
    for name, curves in grouped.items():
        if set(curves) != {0, 1, 2, 3}:
            raise ValueError('Missing quaternion channels: ' + name)
        times = [[key.co.x for key in curves[k].keyframe_points] for k in range(4)]
        if (not times[0] or any(t != times[0] for t in times[1:])
                or any(not math.isfinite(t) for t in times[0])
                or any(b <= a for a, b in zip(times[0], times[0][1:]))):
            raise ValueError('Quaternion channels require synchronized, finite increasing key times: ' + name)
        samples = [[curves[k].keyframe_points[i].co.y for k in range(4)] for i in range(len(times[0]))]
        try:
            scaled = scale_rotation_samples(samples, gain)
        except ValueError as exc:
            raise ValueError(f'{name}: {exc}') from exc
        edits.append((curves, scaled))
    if gain != 1:
        for curves, samples in edits:
            for i, q in enumerate(samples):
                for k in range(4):
                    key = curves[k].keyframe_points[i]
                    key.co.y = q[k]
                    key.interpolation = 'LINEAR'
            for curve in curves.values():
                curve.update()
    return {'bones': len(names), 'samples': sum(len(q) for _, q in edits), 'gain': gain}
