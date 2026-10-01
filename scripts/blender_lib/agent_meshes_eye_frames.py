"""Eye authoring in explicit rest-space frames (Blender Z-up coordinates).

The existing continuous-lid solver works in its canonical -Y frame. This adapter
keeps its geometry, shape targets and position-based masks in one world frame.
It does not change the solver, gaze bones or the face verifier's view directions.
"""
import math
from numbers import Real

__all__ = ['oriented_eye_hole', 'oriented_eyeball_geometry', 'eye_bone_frame']


def _point(value, label):
    try:
        value = tuple(value)
    except TypeError as exc:
        raise ValueError(label + ' must contain three finite numbers') from exc
    if len(value) != 3 or any(isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(v) for v in value):
        raise ValueError(label + ' must contain three finite numbers')
    return tuple(float(v) for v in value)


def _unit(value, label):
    v = _point(value, label)
    scale = max(abs(x) for x in v)
    if scale == 0:
        raise ValueError(label + ' must not be zero')
    scaled = tuple(x / scale for x in v)
    length = math.hypot(*scaled)
    return tuple(x / length for x in scaled)


def _cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


class _Frame:
    def __init__(self, center, forward, up):
        self.center = _point(center, 'Eye center')
        self.forward = _unit(forward, 'Eye forward')
        up = _unit(up, 'Eye up')
        right = _cross(up, self.forward)
        if math.hypot(*right) < 1e-8:
            raise ValueError('Eye forward and up must not be parallel')
        self.right = _unit(right, 'Eye right')
        self.up = _cross(self.forward, self.right)
        self.axes = (self.right, tuple(-x for x in self.forward), self.up)

    def world(self, p):
        return tuple(self.center[k] + sum(p[j]*self.axes[j][k] for j in range(3)) for k in range(3))

    def local(self, p):
        return tuple(sum((p[k]-self.center[k])*axis[k] for k in range(3)) for axis in self.axes)

    def metadata(self):
        return {'center': self.center, 'forward': self.forward, 'up': self.up}


def eye_bone_frame(center, *, forward=(0, -1, 0), up=(0, 0, 1)):
    """A world-space Blender edit-bone matrix with local Y up and local Z optical.

    Author the eye bone with this rest frame before binding/baking animation.
    For a transformed armature use rig.matrix_world.inverted() @ Matrix(result)
    as the edit bone's matrix and set its length separately. Apply nonuniform or
    mirrored armature scale first; a rotation frame cannot undo scale/shear.
    Existing keyed offsets and bindings are not retargeted by this pure helper.
    In the exported standard glTF frame, the viewer's local-Y yaw and local-X
    pitch act around this eye's up and right axes, including side-set/rolled eyes.
    """
    frame = _Frame(center, forward, up)
    return [[frame.right[k], frame.up[k], frame.forward[k], frame.center[k]] for k in range(3)] + [[0., 0., 0., 1.]]


def oriented_eyeball_geometry(center, radius, *, forward=(0, -1, 0), up=(0, 0, 1), **options):
    """An eyeball whose iris/pupil points along `forward`; options are eyeball_geometry's.

    `up` defines the top of a slit pupil. Non-unit directions are normalized and
    up is orthogonalized against forward. Zero, nonfinite or parallel directions
    are rejected. Output vertices are in the input center's world/rest space.
    """
    from agent_meshes_face import eyeball_geometry
    frame = _Frame(center, forward, up)
    result = eyeball_geometry((0, 0, 0), radius, **options)
    return dict(result, vertices=[frame.world(p) for p in result['vertices']])


def oriented_eye_hole(vertices, faces, center, eye_radius, *, forward=(0, -1, 0), up=(0, 0, 1), **options):
    """A continuous skin eye in an explicit frame, compatible with build_eye and eye_hole_mask.

    All points and centers are world/rest-space Blender coordinates. `forward`
    aims the eye and `up` sets its lid orientation; they follow the same rules as
    oriented_eyeball_geometry. Remaining options go to eye_hole. Only continuous
    construction is supported; mirrored twin shaping assumes a global midline
    and is rejected. Cut side-set eyes separately and leave earlier lid regions
    intact. build_eye uses the returned frame to orient its matching eyeball.

    Angular metadata (opening, yaw columns, envelopes) stays in the declared eye
    frame. Geometry, motion, paint, centers, window and still callbacks are in
    world/rest space. Do not discard the frame when passing the hole onward.
    This does not reorient a skeleton or certify gaze/face-contract acceptance.
    """
    from agent_meshes_face import eye_hole
    frame = _Frame(center, forward, up)
    if options.get('style', 'continuous') != 'continuous':
        raise ValueError('Oriented eye holes require continuous skin lids')
    if options.get('twin', False):
        raise ValueError('Oriented eye holes do not support mirrored twin shaping')
    local = [frame.local(_point(p, 'Skin vertex')) for p in vertices]
    hole = eye_hole(local, faces, (0, 0, 0), eye_radius, **options)
    result = dict(hole, vertices=[frame.world(p) for p in hole['vertices']], frame=frame.metadata())
    lids = hole['lids']
    result['lids'] = dict(lids, center=frame.center,
        vertices=[frame.world(p) for p in lids['vertices']],
        morphs={name: [frame.world(p) for p in points] for name, points in lids['morphs'].items()})
    result['motion'] = [(frame.world(rest), {name: frame.world(p) for name, p in moved.items()}) for rest, moved in hole['motion']]
    result['lash'] = {name: [frame.world(p) for p in points] for name, points in hole['lash'].items()}
    result['lining_points'] = [frame.world(p) for p in hole['lining_points']]
    result['window'] = dict(hole['window'], center=frame.center,
                            level=lambda p: hole['window']['level'](frame.local(p)))
    result['still'] = lambda p: hole['still'](frame.local(p))
    return result
