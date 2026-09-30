"""Exercise digit dimensions through actual fusion, decimation and skin binding."""
import numpy as np
from agent_meshes_sprout_kin import anatomy, build_anatomy
from agent_meshes_sprout_rig import rig_anatomy, skeleton

EXPORT_ANIMATION_MODE = 'NLA_TRACKS'


def build(age):
    height = 1.12 if age == 'child' else 1.7
    objects, a = build_anatomy(age=age, height=height, finger_scale=.7, thumb_scale=.85)
    assert a['finger_scale'] == .7 and a['thumb_scale'] == .85
    objects, _ = rig_anatomy(objects, a)
    arm = next(o for o in objects if o.type == 'ARMATURE')
    body = next(o for o in objects if o.name == 'sprout-body')
    expected = skeleton(a)
    original = skeleton(anatomy(age=age, height=height))
    for name, bone in expected.items():
        np.testing.assert_allclose(arm.data.bones[name].head_local[:], bone['head'], atol=3e-7, rtol=0)
        np.testing.assert_allclose(arm.data.bones[name].tail_local[:], bone['tail'], atol=3e-7, rtol=0)
    vertices = np.array([v.co[:] for v in body.data.vertices])
    assert np.isfinite(vertices).all()
    for side in ('l', 'r'):
        for n in (0, 1):
            name = f'finger_{side}{n}_tip'
            # The new endpoint is inside a rounded tip, within its surface radius.
            # The old endpoint must be clear of the shortened surface.
            near = np.linalg.norm(vertices-expected[name]['tail'], axis=1).min()
            old = np.linalg.norm(vertices-original[name]['tail'], axis=1).min()
            assert near < .012*a['scale'], (age, name, 'missing shortened tip', near)
            assert old > .012*a['scale'], (age, name, 'surface still reaches old tip', old)
    deform = {b.name for b in arm.data.bones if b.use_deform}
    for vertex in body.data.vertices:
        row = {body.vertex_groups[g.group].name:g.weight for g in vertex.groups if g.weight>0}
        assert 1 <= len(row) <= 4 and set(row) <= deform
        assert all(np.isfinite(w) and 0 < w <= 1 for w in row.values())
        assert abs(sum(row.values())-1) < 2e-6
    print('SPROUT_DIGIT_CHECK', age, len(vertices), 'vertices; endpoints and skin weights verified')
    return objects
