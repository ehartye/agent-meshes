"""Pure-Python face-rig geometry checks; Blender is not required.

Coordinates follow Blender: Z up, the face looks down -Y, character left is +X.
"""
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
import agent_meshes_author
from agent_meshes_face import (
    ARKIT_GAZE, ARKIT_NAMES, ARKIT_REQUIRED, CANONICAL_EMOTIONS, JawHinge, cut_faces, ellipsoid_geometry, eyeball_geometry, folded_faces, join_geometry,
    face_contract_extras, lid_clearance, lid_geometry, merge_glb_node_extras, mirror_x, mouth_cavity_geometry,
    recommended_gaze, shutter_geometry, socket_geometry, soft_offset, symmetric_offsets, teeth_row_geometry,
    tongue_geometry, validate_face_contract_extras,
)

CENTER, RADIUS = (.032, -.07, .05), .012
WEIGHTS = (0, .25, .5, .75, 1)


def distance(a, b): return math.dist(a, b)


def mix(rest, morphs, weights):
    return [tuple(r[k] + sum(w * (m[i][k] - r[k]) for m, w in zip(morphs, weights)) for k in range(3)) for i, r in enumerate(rest)]


def signed_volume(vertices, faces):
    volume = 0
    for face in faces:
        a = vertices[face[0]]
        for i in range(1, len(face) - 1):
            b, c = vertices[face[i]], vertices[face[i + 1]]
            volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    return volume


def closed_and_consistent(test, vertices, faces):
    edges = {}
    for face in faces:
        for a, b in zip(face, face[1:] + face[:1]):
            edges.setdefault((min(a, b), max(a, b)), []).append((a, b))
    test.assertTrue(all(len(uses) == 2 and uses[0] == uses[1][::-1] for uses in edges.values()), 'closed, consistently wound shell')


def normals(vertices, faces):
    result = []
    for face in faces:
        a, b, c = (vertices[i] for i in face[:3])
        u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
        result.append((u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]))
    return result


def no_inversion(test, rest, target, faces):
    for n0, n1 in zip(normals(rest, faces), normals(target, faces)):
        if math.hypot(*n0) < 1e-14: continue
        test.assertGreater(sum(a * b for a, b in zip(n0, n1)), 0, 'triangle orientation is kept')


class ContractConstantsTests(unittest.TestCase):
    def test_required_names_match_the_arkit_face_contract(self):
        self.assertEqual(len(ARKIT_REQUIRED), 21)
        self.assertEqual(len(set(ARKIT_REQUIRED)), 21)
        self.assertEqual(len(ARKIT_NAMES), 52)
        self.assertTrue(set(ARKIT_REQUIRED) <= set(ARKIT_NAMES) and set(ARKIT_GAZE) <= set(ARKIT_NAMES))
        self.assertEqual(sorted(CANONICAL_EMOTIONS), ['angry', 'happy', 'neutral', 'sad', 'scared', 'surprised'])
        self.assertEqual(CANONICAL_EMOTIONS['surprised']['jawOpen'], .6)

    def test_author_module_reexports_the_face_helpers(self):
        for name in ('lid_geometry', 'JawHinge', 'teeth_row_geometry', 'face_contract_extras', 'build_eye', 'face_skeleton', 'add_jaw_open'):
            self.assertTrue(hasattr(agent_meshes_author, name), name)


class LidTests(unittest.TestCase):
    def lids(self, **options):
        return lid_geometry(CENTER, RADIUS, **options)

    def assert_clear(self, lids, required=RADIUS + .0005):
        rest, (blink, squint, wide) = lids['vertices'], (lids['morphs'][k] for k in ('blink', 'squint', 'wide'))
        moved = [i for i, (a, b) in enumerate(zip(rest, blink)) if distance(a, b) > 1e-7]
        self.assertGreater(len(moved), 20)
        worst = math.inf
        for b in WEIGHTS:
            for s in (0, 1):
                for w in (0, 1):
                    positions = mix(rest, (blink, squint, wide), (b, s, w))
                    worst = min(worst, min(distance(positions[i], CENTER) for i in range(len(rest))))
        self.assertGreaterEqual(worst, required - 1e-9, f'lid vertices stay outside radius + 0.5 mm, worst {worst}')
        return worst

    def test_round_lids_keep_mid_blink_clearance_alone_and_with_squint(self):
        lids = self.lids()
        self.assert_clear(lids)
        self.assertGreaterEqual(lids['min_clearance'], .0005 - 1e-9)
        self.assertGreater(lids['upper_radius'], lids['lower_radius'])

    def test_large_upper_sweep_pushes_the_lid_shell_out_instead_of_cutting_the_eye(self):
        wide_open = self.lids(opening=(50, 55, 40), meet=-15, corner=1.75)
        self.assert_clear(wide_open)
        narrow = self.lids(opening=(40, 20, 15), meet=0)
        self.assertGreater(wide_open['upper_radius'], narrow['upper_radius'])
        # The straight-chord bound: a sweep of D degrees needs R >= (r + c) / cos(D / 2).
        sweep = 55 + 15 + 4
        self.assertGreaterEqual(wide_open['upper_radius'], (RADIUS + .0005) / math.cos(math.radians(sweep / 2)) - 1e-9)

    def test_clearance_holds_between_the_sampled_weights(self):
        lids = self.lids()
        self.assertGreaterEqual(lid_clearance(CENTER, RADIUS, lids['vertices'], [lids['morphs'][k] for k in ('blink', 'squint', 'wide')]), .0005 - 1e-9)
        # A naive straight chord across the eye is detected.
        rest = [(CENTER[0], CENTER[1] - RADIUS * 1.01 * math.cos(math.radians(50)), CENTER[2] + RADIUS * 1.01 * math.sin(math.radians(50)))]
        closed = [(CENTER[0], CENTER[1] - RADIUS * 1.01 * math.cos(math.radians(-20)), CENTER[2] + RADIUS * 1.01 * math.sin(math.radians(-20)))]
        self.assertLess(lid_clearance(CENTER, RADIUS, rest, [closed]), 0)

    def test_blink_closes_the_opening_with_overlap_and_squint_narrows_it(self):
        lids = self.lids(opening=(45, 38, 30), meet=-8, overlap=4, squint=.45)
        self.assertTrue(.25 <= lids['squint_ratio'] <= .6)
        edges = lids['edges']
        for key in ('upper', 'lower'):
            self.assertEqual(len(edges[key]), len(edges['yaw']))
        center = len(edges['yaw']) // 2
        self.assertAlmostEqual(edges['yaw'][center], 0)
        self.assertAlmostEqual(edges['upper'][center]['rest'], 38)
        self.assertAlmostEqual(edges['lower'][center]['rest'], -30)
        for upper, lower in zip(edges['upper'], edges['lower']):
            self.assertLessEqual(upper['blink'], lower['blink'] - 4 + 1e-9, 'upper lid passes in front of the lower lid')
            self.assertGreaterEqual(upper['squint'], lower['squint'])
        self.assertGreater(edges['upper'][center]['squint'], edges['lower'][center]['squint'] + 10)

    def test_squint_outside_the_contract_band_is_rejected(self):
        for value in (.1, .7):
            with self.subTest(squint=value), self.assertRaises(ValueError):
                self.lids(squint=value)

    def test_lid_shells_are_closed_and_morphs_keep_orientation(self):
        lids = self.lids()
        closed_and_consistent(self, lids['vertices'], lids['faces'])
        self.assertGreater(signed_volume(lids['vertices'], lids['faces']), 0)
        for key, target in lids['morphs'].items():
            with self.subTest(morph=key):
                self.assertEqual(len(target), len(lids['vertices']))
                for weight in (.5, 1):
                    no_inversion(self, lids['vertices'], mix(lids['vertices'], [target], [weight]), lids['faces'])
        no_inversion(self, lids['vertices'], mix(lids['vertices'], [lids['morphs']['blink'], lids['morphs']['squint']], [1, 1]), lids['faces'])

    def test_settings_that_fold_the_lid_rim_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'fold'):
            self.lids(opening=(45, 38, 30), corner=.5)

    def test_wide_raises_the_upper_lid(self):
        lids = self.lids()
        for edge in lids['edges']['upper']:
            self.assertGreaterEqual(edge['wide'], edge['rest'])
        middle = lids['edges']['upper'][len(lids['edges']['yaw']) // 2]
        self.assertGreater(middle['wide'] - middle['rest'], 5)

    def test_rejects_bad_parameters(self):
        for options in (dict(opening=(0, 30, 30)), dict(opening=(40, 30)), dict(meet=50), dict(clearance=-1), dict(columns=2), dict(rows=0), dict(thickness=0)):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.lids(**options)
        with self.assertRaises(ValueError):
            lid_geometry(CENTER, 0)


class ShutterTests(unittest.TestCase):
    def test_shutter_blades_slide_in_planes_in_front_of_the_eye(self):
        shutter = shutter_geometry(CENTER, RADIUS)
        rest, morphs = shutter['vertices'], shutter['morphs']
        closed_and_consistent(self, rest, shutter['faces'])
        for b in WEIGHTS:
            for s in (0, 1):
                positions = mix(rest, (morphs['blink'], morphs['squint'], morphs['wide']), (b, s, 0))
                self.assertGreaterEqual(min(distance(p, CENTER) for p in positions), RADIUS + .0005 - 1e-9)
        # Blades translate: every vertex of one blade moves by the same vector.
        deltas = {tuple(round(t[k] - r[k], 9) for k in range(3)) for r, t in zip(rest, morphs['blink'])}
        self.assertEqual(len(deltas), 2)
        self.assertTrue(.25 <= shutter['squint_ratio'] <= .6)
        self.assertGreater(shutter['upper_plane'], shutter['lower_plane'])

    def test_closed_shutters_cover_the_lens_with_overlap(self):
        shutter = shutter_geometry(CENTER, RADIUS, overlap=.002)
        upper_edge, lower_edge = shutter['edges']['upper'], shutter['edges']['lower']
        self.assertLessEqual(upper_edge['blink'], lower_edge['blink'] - .002 + 1e-9)
        self.assertGreater(upper_edge['rest'], lower_edge['rest'])


class EyeballTests(unittest.TestCase):
    def test_eyeball_has_white_iris_and_pupil_slots_around_the_gaze_axis(self):
        eye = eyeball_geometry(CENTER, RADIUS, iris=26, pupil=12, rings=16, segments=24)
        self.assertEqual(eye['materials'], ['eye_white', 'eye_iris', 'eye_pupil'])
        self.assertEqual(set(eye['material_indices']), {0, 1, 2})
        self.assertEqual(len(eye['material_indices']), len(eye['faces']))
        for vertex in eye['vertices']:
            self.assertAlmostEqual(distance(vertex, CENTER), RADIUS)
        closed_and_consistent(self, eye['vertices'], eye['faces'])
        self.assertGreater(signed_volume(eye['vertices'], eye['faces']), 0)
        for face, slot in zip(eye['faces'], eye['material_indices']):
            front = sum(-(eye['vertices'][i][1] - CENTER[1]) for i in face) / len(face) / RADIUS
            if slot == 2: self.assertGreater(front, math.cos(math.radians(12)) - 1e-9)
            if slot == 0: self.assertLess(front, math.cos(math.radians(26)) + 1e-9)

    def test_socket_cup_sits_between_eyeball_and_lids(self):
        socket = socket_geometry(CENTER, RADIUS, radius=.0135, hole=55)
        for vertex in socket['vertices']:
            self.assertAlmostEqual(distance(vertex, CENTER), .0135)
            forward = -(vertex[1] - CENTER[1]) / .0135
            self.assertLessEqual(forward, math.cos(math.radians(55)) + 1e-9)

    def test_recommended_gaze_keeps_the_iris_center_inside_the_opening(self):
        gaze = recommended_gaze(opening=(45, 38, 30), iris=26)
        self.assertLess(gaze['yawMax'], 45)
        self.assertLess(gaze['pitchMax'], 30)
        self.assertGreater(gaze['pitchMax'], 5)


class JawTests(unittest.TestCase):
    jaw = JawHinge(pivot=(0, .01, .01), angle=20, mouth_z=-.04, half_width=.025, corner_falloff=.02, band=.03, back_band=.03)

    def test_lower_lip_moves_fully_and_upper_lip_stays(self):
        self.assertEqual(self.jaw.weight((0, -.08, -.0405)), 1)
        self.assertEqual(self.jaw.weight((0, -.08, -.0395)), 0)
        self.assertEqual(self.jaw.weight((.02, -.08, -.06)), 1)
        beyond = self.jaw.weight((.06, -.06, -.045))
        self.assertTrue(0 < beyond < 1, beyond)
        self.assertEqual(self.jaw.weight((0, .08, -.06)), 0, 'the back of the head does not swing with the jaw')

    def test_hinge_drops_the_chin_down_and_back_about_the_pivot(self):
        chin = (0, -.07, -.09)
        target, = self.jaw.targets([chin], weight=1)
        self.assertLess(target[2], chin[2] - .005)
        self.assertGreater(target[1], chin[1])
        self.assertAlmostEqual(distance(target, self.jaw.pivot), distance(chin, self.jaw.pivot))

    def test_rigid_plate_and_carried_parts_move_as_one_body(self):
        parts = [(0, -.06, -.05), (.01, -.05, -.06), (-.02, -.04, -.07)]
        moved = self.jaw.targets(parts, weight=1)
        for i in range(3):
            for j in range(3):
                self.assertAlmostEqual(distance(parts[i], parts[j]), distance(moved[i], moved[j]))
        falloff = self.jaw.targets(parts)
        self.assertEqual(falloff, moved, 'everything below the mouth inside the slit gets full weight')
        half = self.jaw.targets(parts, weight=[.5, .5, .5])
        self.assertLess(distance(half[0], parts[0]), distance(moved[0], parts[0]))

    def test_default_back_falloff_does_not_fold_the_skin_under_the_chin(self):
        head = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=64)
        jaw = JawHinge(pivot=(0, -.005, .1), angle=18, mouth_z=.075, half_width=.022)
        self.assertEqual(folded_faces(head['vertices'], jaw.targets(head['vertices']), head['faces']), [])
        sharp = JawHinge(pivot=(0, -.005, .1), angle=18, mouth_z=.075, half_width=.022, back_band=.03)
        self.assertGreater(len(folded_faces(head['vertices'], sharp.targets(head['vertices']), head['faces'])), 10)

    def test_rejects_extreme_hinges(self):
        for options in (dict(angle=40), dict(angle=0), dict(half_width=0), dict(band=-1)):
            with self.subTest(options=options), self.assertRaises(ValueError):
                JawHinge(**(dict(pivot=(0, 0, 0), angle=20, mouth_z=-.04, half_width=.02) | options))


class MouthTests(unittest.TestCase):
    arch = dict(center=(0, -.08, -.035), half_width=.024, depth=.02)

    def test_teeth_rows_in_three_styles_hang_from_the_gum_line(self):
        for style in ('rounded', 'saw', 'grille'):
            for row in ('upper', 'lower'):
                with self.subTest(style=style, row=row):
                    teeth = teeth_row_geometry(style, row=row, count=6, height=.008, **self.arch)
                    self.assertEqual(teeth['count'], 6)
                    heights = [v[2] for v in teeth['vertices']]
                    if row == 'upper':
                        self.assertAlmostEqual(max(heights), -.035, places=6)
                        self.assertAlmostEqual(min(heights), -.043, places=6)
                    else:
                        self.assertAlmostEqual(min(heights), -.035, places=6)
                        self.assertAlmostEqual(max(heights), -.027, places=6)
                    self.assertGreater(signed_volume(teeth['vertices'], teeth['faces']), 0)
                    closed_and_consistent(self, teeth['vertices'], teeth['faces'])

    def test_sizes_make_buck_teeth_and_fangs(self):
        plain = teeth_row_geometry('rounded', count=2, height=.006, **self.arch)
        buck = teeth_row_geometry('rounded', count=2, height=.006, sizes=[(1.2, 1.5), (1.2, 1.5)], **self.arch)
        self.assertLess(min(v[2] for v in buck['vertices']), min(v[2] for v in plain['vertices']) - .002)
        with self.assertRaises(ValueError):
            teeth_row_geometry('rounded', count=2, height=.006, sizes=[(1, 1)], **self.arch)
        with self.assertRaises(ValueError):
            teeth_row_geometry('molar', count=2, height=.006, **self.arch)

    def test_mouth_cavity_is_a_bag_open_to_the_front(self):
        cavity = mouth_cavity_geometry((0, -.075, -.04), width=.05, height=.04, depth=.05)
        ys = [v[1] for v in cavity['vertices']]
        self.assertAlmostEqual(min(ys), -.075)
        self.assertAlmostEqual(max(ys), -.025)
        self.assertEqual(len(cavity['rim']), 32)
        tongue = tongue_geometry((0, -.06, -.052), length=.035, width=.03, thickness=.008)
        closed_and_consistent(self, tongue['vertices'], tongue['faces'])
        self.assertGreater(signed_volume(tongue['vertices'], tongue['faces']), 0)


class SkinRegionTests(unittest.TestCase):
    def test_soft_offset_falls_off_smoothly_and_mirrors(self):
        vertices = [(.03, -.08, .06), (.03, -.08, .08), (-.03, -.08, .06), (.03, -.08, .2)]
        targets = soft_offset(vertices, (.03, -.08, .06), .02, (0, 0, .004))
        self.assertAlmostEqual(targets[0][2] - vertices[0][2], .004)
        self.assertEqual(targets[1], vertices[1])
        self.assertEqual(targets[2], vertices[2])
        left, right = symmetric_offsets(vertices, (.03, -.08, .06), .02, (.002, 0, .004))
        self.assertEqual(left, soft_offset(vertices, (.03, -.08, .06), .02, (.002, 0, .004)))
        self.assertAlmostEqual(right[2][0] - vertices[2][0], -.002)
        self.assertAlmostEqual(right[2][2] - vertices[2][2], .004)
        self.assertEqual(mirror_x((1, 2, 3)), (-1, 2, 3))
        ellipsoid = soft_offset(vertices, (.03, -.08, .07), (.01, .01, .02), (0, 0, .004))
        self.assertGreater(ellipsoid[1][2], vertices[1][2])

    def test_ellipsoid_is_a_closed_outward_head_blank(self):
        head = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=24, segments=32)
        closed_and_consistent(self, head['vertices'], head['faces'])
        self.assertGreater(signed_volume(head['vertices'], head['faces']), 0)
        zs = [v[2] for v in head['vertices']]
        self.assertAlmostEqual(min(zs), .005)
        self.assertAlmostEqual(max(zs), .235)

    def test_cut_faces_removes_regions_and_reindexes(self):
        vertices = [(x, 0, z) for z in range(3) for x in range(3)]
        faces = [(r * 3 + c, r * 3 + c + 1, r * 3 + c + 4, r * 3 + c + 3) for r in range(2) for c in range(2)]
        kept, kept_faces, mapping = cut_faces(vertices, faces, lambda centroid: centroid[0] < 1 and centroid[2] < 1)
        self.assertEqual(len(kept_faces), 3)
        self.assertEqual(len(kept), 8)
        self.assertEqual(mapping[0], None)
        self.assertTrue(all(0 <= i < len(kept) for face in kept_faces for i in face))


class JoinTests(unittest.TestCase):
    def test_parts_join_into_one_mesh_with_the_union_of_morph_names(self):
        skin = {'vertices': [(0, 0, 0), (1, 0, 0), (0, 1, 0)], 'faces': [(0, 1, 2)], 'materials': ['skin'],
                'morphs': {'jawOpen': [(0, 0, -1), (1, 0, 0), (0, 1, 0)], 'browInnerUp': [(0, 0, 0), (1, 0, 1), (0, 1, 0)]}}
        teeth = {'vertices': [(0, 0, 2), (1, 0, 2), (0, 1, 2), (1, 1, 2)], 'faces': [(0, 1, 2), (1, 3, 2)], 'materials': ['teeth_lower', 'skin'],
                 'material_indices': [0, 1], 'morphs': {'jawOpen': [(0, 0, 1), (1, 0, 1), (0, 1, 1), (1, 1, 1)]}}
        lids = {'vertices': [(5, 0, 0), (6, 0, 0), (5, 1, 0)], 'faces': [(0, 1, 2)], 'materials': ['skin'],
                'morphs': {'eyeBlinkLeft': [(5, 0, 1), (6, 0, 1), (5, 1, 1)]}}
        joined = join_geometry([skin, teeth, lids])
        self.assertEqual(joined['materials'], ['skin', 'teeth_lower'])
        self.assertEqual(joined['faces'], [(0, 1, 2), (3, 4, 5), (4, 6, 5), (7, 8, 9)])
        self.assertEqual(joined['material_indices'], [0, 1, 0, 0])
        self.assertEqual(list(joined['morphs']), ['jawOpen', 'browInnerUp', 'eyeBlinkLeft'])
        for targets in joined['morphs'].values():
            self.assertEqual(len(targets), 10)
        self.assertEqual(joined['morphs']['jawOpen'][3], (0, 0, 1))
        self.assertEqual(joined['morphs']['browInnerUp'][3], (0, 0, 2), 'parts without a morph keep their rest positions')
        self.assertEqual(joined['morphs']['eyeBlinkLeft'][0], (0, 0, 0))
        with self.assertRaises(ValueError):
            join_geometry([{'vertices': [(0, 0, 0)], 'faces': [], 'materials': ['a'], 'morphs': {'x': []}}])


class ContractExtrasTests(unittest.TestCase):
    def morphs(self): return list(ARKIT_REQUIRED) + ['noseSneerLeft', 'noseSneerRight']

    def test_extras_carry_the_contract_with_canonical_presets(self):
        extras = face_contract_extras(self.morphs(), yaw_max=28, pitch_max=18, exposed_teeth=['upper incisors'])
        face = extras['arkitFace']
        self.assertEqual(face['contract'], 'arkit-face/1')
        self.assertEqual(face['gaze'], {'yawMax': 28, 'pitchMax': 18})
        self.assertEqual(face['lidFollow'], {'down': .35, 'up': .25})
        self.assertEqual(face['exposedTeeth'], ['upper incisors'])
        self.assertEqual(face['emotions']['angry']['noseSneerLeft'], .7)
        self.assertEqual(face['emotions']['sad']['eyeLookDownLeft'], .4)
        self.assertEqual(validate_face_contract_extras(extras, self.morphs()), [])
        json.dumps(extras)

    def test_heads_without_a_feature_drop_its_curves(self):
        face = face_contract_extras(list(ARKIT_REQUIRED), yaw_max=25, pitch_max=15)['arkitFace']
        self.assertNotIn('noseSneerLeft', face['emotions']['angry'])
        self.assertEqual(face['exposedTeeth'], [])

    def test_validation_names_each_problem(self):
        extras = face_contract_extras(self.morphs(), yaw_max=28, pitch_max=18)
        face = extras['arkitFace']
        face['contract'] = 'arkit-face/2'; face['gaze']['yawMax'] = -1; face['emotions']['happy']['smile'] = .5
        del face['exposedTeeth']
        errors = validate_face_contract_extras(extras, self.morphs())
        self.assertTrue(any('contract' in e for e in errors))
        self.assertTrue(any('yawMax' in e for e in errors))
        self.assertTrue(any('smile' in e for e in errors))
        self.assertTrue(any('exposedTeeth' in e for e in errors))
        with self.assertRaises(ValueError):
            face_contract_extras(list(ARKIT_REQUIRED)[1:], yaw_max=25, pitch_max=15)


class GlbExtrasTests(unittest.TestCase):
    def glb(self, document, binary=b'\x00\x00\x00\x00'):
        text = json.dumps(document).encode()
        text += b' ' * (-len(text) % 4)
        body = struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(binary), b'BIN\x00') + binary
        return struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body

    def test_node_extras_are_merged_without_touching_the_binary_chunk(self):
        document = {'asset': {'version': '2.0'}, 'nodes': [{'name': 'Face rig', 'extras': {'keep': 1}}, {'name': 'other'}], 'buffers': [{'byteLength': 4}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.glb'
            path.write_bytes(self.glb(document, b'\x01\x02\x03\x04'))
            merge_glb_node_extras(path, {'Face rig': {'arkitFace': {'contract': 'arkit-face/1', 'label': 'é'}}})
            data = path.read_bytes()
            magic, version, length = struct.unpack_from('<4sII', data)
            self.assertEqual((magic, version, length), (b'glTF', 2, len(data)))
            json_length, = struct.unpack_from('<I', data, 12)
            self.assertEqual(json_length % 4, 0)
            patched = json.loads(data[20:20 + json_length])
            self.assertEqual(patched['nodes'][0]['extras'], {'keep': 1, 'arkitFace': {'contract': 'arkit-face/1', 'label': 'é'}})
            self.assertEqual(data[-4:], b'\x01\x02\x03\x04')
            with self.assertRaises(ValueError):
                merge_glb_node_extras(path, {'missing': {}})


if __name__ == '__main__':
    unittest.main()
