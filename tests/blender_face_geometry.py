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
from agent_meshes_face import _clip, _quality, _refine, _sharp_edges
from agent_meshes_face import (
    DEFAULT_LID_FOLLOW, attach_to_skin, nose_geometry, sculpt_lips, sculpt_skin, eye_hole, eye_hole_mask, eye_window, shutter_hole, skin_brow_geometry, skin_contact,
    ARKIT_GAZE, ARKIT_NAMES, ARKIT_REQUIRED, CANONICAL_EMOTIONS, COVERAGE_STATES, JawHinge, brow_ridge_geometry, chin_drop, cut_faces, cut_hole,
    eye_coverage, eye_coverage_problems, brow_plate_geometry, split_plates, rubber_mouth_geometry,
    ellipsoid_geometry, exposed_teeth_geometry, eyeball_geometry, folded_faces, front_surface, join_geometry,
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


def float32(value): return struct.unpack('<f', struct.pack('<f', value))[0]


# Head blanks: the round test head and the critic's wide, flat frog (Blender coordinates).
HEADS = {
    'round head': dict(center=(0, 0, .12), radii=(.085, .09, .115), mouth_z=.075, half_width=.022),
    'wide frog': dict(center=(0, 0, .12), radii=(.11, .085, .10), mouth_z=.088, half_width=.055),
}


def slit_blank(center, radii, mouth_z, half_width, rings=64, segments=72):
    """An ellipsoid head blank with the faces crossing the mouth line inside the slit removed (a stand-in for slit_mouth)."""
    blank = ellipsoid_geometry(center, radii, rings=rings, segments=segments)
    vertices = blank['vertices']
    def straddles(face):
        zs = [vertices[i][2] for i in face]
        return min(zs) < mouth_z < max(zs) and all(abs(vertices[i][0]) < half_width and vertices[i][1] < center[1] for i in face)
    faces = [f for f in blank['faces'] if not straddles(f)]
    return vertices, faces


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
        for yaw, upper, lower in zip(edges['yaw'], edges['upper'], edges['lower']):
            self.assertLessEqual(upper['blink'], lower['blink'] - 4 + 1e-9, 'upper lid passes in front of the lower lid')
            # Past the corners the lower lid tucks up behind the upper one (4 degrees), so they overlap, never abut.
            self.assertGreaterEqual(upper['squint'], lower['squint'] - 4 - 1e-9)
            if abs(yaw) >= 45: self.assertAlmostEqual(lower['rest'] - upper['rest'], 4)
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

    def test_a_wide_travel_the_lids_cannot_close_over_is_rejected(self):
        # blink 1 + wide 1 parts linear lids by the wide travel; closing that gap here folds the lid rim.
        with self.assertRaisesRegex(ValueError, 'uncovered|fold'):
            self.lids(wide=(20, 10))

    def test_settings_that_fold_the_lid_rim_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'fold'):
            self.lids(opening=(45, 38, 30), corner=.5)

    def test_lid_rims_are_rounded_not_square(self):
        # The round-4 critic saw slab-thick, square lid ends: the edge row now turns over a rounded bead.
        lids = self.lids()
        vertices, faces = lids['vertices'], lids['faces']
        sharp = _sharp_edges(vertices, faces, 50)
        middle = len(lids['edges']['yaw']) // 2
        edges = (lids['edges']['upper'][middle]['rest'], lids['edges']['lower'][middle]['rest'])
        elevation = lambda i: math.degrees(math.asin(max(-1, min(1, (vertices[i][2] - CENTER[2]) / distance(vertices[i], CENTER)))))
        # The outer face is what shows: its rim rounds over onto the inner layer (a crease stays inside, on the eyeball).
        outside = lambda i: distance(vertices[i], CENTER) > lids['lower_radius'] + .5 * lids['thickness'] and             not lids['lower_radius'] + lids['thickness'] < distance(vertices[i], CENTER) < lids['upper_radius'] + .5 * lids['thickness']
        near_edge = lambda i: abs(vertices[i][0] - CENTER[0]) < .3 * RADIUS and any(abs(elevation(i) - e) < 6 for e in edges) and outside(i)
        self.assertEqual([e for e in sharp if all(near_edge(i) for i in e)], [], 'no hard crease along the lid edges')
        closed_and_consistent(self, vertices, faces)

    def test_rounded_rims_still_close_without_a_slit_at_fine_sampling(self):
        # The rounded upper rim projects a little higher than a square one: the default overlap (6 degrees) keeps
        # blink 1 + wide 1 closed on the round-4 critic's 24 mm eyes, even on a 321-ray grid that finds a 0.1 mm slit.
        center, radius = (.052, -.04, .178), .024
        self.assertEqual(eye_coverage_problems(center, radius, lid_geometry(center, radius, opening=(50, 40, 30)), samples=321), [])

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
        shutter = shutter_geometry(CENTER, RADIUS, overlap=.005)
        upper_edge, lower_edge = shutter['edges']['upper'], shutter['edges']['lower']
        self.assertLessEqual(upper_edge['blink'], lower_edge['blink'] - .005 + 1e-9)
        self.assertGreater(upper_edge['rest'], lower_edge['rest'])


    def blade_spans(self, shutter, weights):
        """(bottom, top) of the upper and the lower blade at blink/squint/wide weights."""
        moved = mix(shutter['vertices'], [shutter['morphs'][k] for k in ('blink', 'squint', 'wide')], weights)
        upper, lower = moved[:8], moved[8:]
        span = lambda blade: (min(v[2] for v in blade), max(v[2] for v in blade))
        return span(upper), span(lower)

    def test_every_blink_squint_wide_combination_covers_the_eyeball(self):
        # The critic's Bolt (aperture 1.3 r) and the defaults. Blades translate, so edges are linear in the weights.
        grid = [k / 4 for k in range(5)]
        for options in ({}, dict(aperture=RADIUS * 1.3125), dict(squint=.3, wide=(.3, .2)), dict(opening=(.9, .8), meet=.2)):
            shutter = shutter_geometry(CENTER, RADIUS, **options)
            for b in grid:
                for s in grid:
                    for w in grid:
                        with self.subTest(options=options, weights=(b, s, w)):
                            (u0, u1), (l0, l1) = self.blade_spans(shutter, (b, s, w))
                            self.assertGreaterEqual(u1, CENTER[2] + RADIUS - 1e-9, 'the upper blade reaches past the top of the eyeball')
                            self.assertLessEqual(l0, CENTER[2] - RADIUS + 1e-9, 'the lower blade reaches past the bottom of the eyeball')
                            if b == 1: self.assertLess(u0, l1, 'a full blink closes the shutters')
            self.assertEqual(eye_coverage_problems(CENTER, RADIUS, shutter), [])

    def test_blink_and_squint_do_not_lift_the_lower_blade_off_the_eyeball(self):
        # Round-2 critic: at blink 1 + squint 1 the default 1.3 r blade stopped at -0.853 r.
        shutter = shutter_geometry(CENTER, RADIUS)
        _, (bottom, _) = self.blade_spans(shutter, (1, 1, 0))
        self.assertLessEqual(bottom, CENTER[2] - RADIUS + 1e-9)
        self.assertGreaterEqual(shutter['blade_height'], RADIUS * (1 + .447))

    def test_settings_that_cannot_cover_the_eyeball_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'blade'):
            shutter_geometry(CENTER, RADIUS, blade_height=1.3 * RADIUS)
        with self.assertRaisesRegex(ValueError, '(?i)overlap'):
            shutter_geometry(CENTER, RADIUS, overlap=.05 * RADIUS)


    def test_shutters_that_poke_out_of_the_skin_are_rejected(self):
        # A round head curves back faster than flat blades slide: the tall blades of a surface eye poke through
        # the forehead. A tin-can face with the eyes recessed behind it hides them.
        eye, radius = (.033, -.067, .145), .014
        round_head = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=64)
        vertices, faces = round_head['vertices'], round_head['faces']
        for center in (eye, mirror_x(eye)):
            cut = cut_hole(vertices, faces, center, .0185)
            vertices, faces = cut['vertices'], cut['faces']
        with self.assertRaisesRegex(ValueError, 'poke'):
            shutter_geometry(eye, radius, surface=front_surface(vertices, faces))
        tin = ellipsoid_geometry((0, 0, .13), (.075, .065, .10), rings=48, segments=64, exponent=6)
        vertices, faces = tin['vertices'], tin['faces']
        recessed = (.032, -.0415, .16)
        for center in (recessed, mirror_x(recessed)):
            cut = cut_hole(vertices, faces, (center[0], -.064, center[2]), .018)
            vertices, faces = cut['vertices'], cut['faces']
        shutters = shutter_geometry(recessed, .016, aperture=.021, surface=front_surface(vertices, faces))
        self.assertGreater(shutters['skin_clearance'], 0)


class EyeCoverageTests(unittest.TestCase):
    """Front-view ray casts over the eyeball disk: closed lids cover it, closing lids never uncover it."""

    def test_default_lids_and_shutters_cover_every_contract_state(self):
        for name, geometry in (('lids', lid_geometry(CENTER, RADIUS)), ('shutters', shutter_geometry(CENTER, RADIUS)),
                               ('almond lids', lid_geometry(CENTER, RADIUS, opening=(50, 55, 40), meet=-15, corner=1.75))):
            with self.subTest(eye=name):
                self.assertEqual(eye_coverage_problems(CENTER, RADIUS, geometry), [])

    def test_the_states_include_blink_alone_with_squint_and_with_wide(self):
        labels = [state['label'] for state in COVERAGE_STATES]
        for b in (.25, .5, .75, 1):
            self.assertIn(f'blink {b:g}', labels)
            self.assertIn(f'blink {b:g} + squint 1', labels)
        self.assertIn('blink 1 + wide 1', labels)
        self.assertIn('blink 1 + squint 1 + wide 1', labels)

    def test_a_full_blink_and_a_wide_eye_still_close(self):
        # Surprised (eyeWide 1) plus an idle blink: the lids and blades must still meet.
        for geometry in (lid_geometry(CENTER, RADIUS), shutter_geometry(CENTER, RADIUS)):
            with self.subTest(style=geometry['style']):
                seen = eye_coverage(CENTER, RADIUS, geometry, {'blink': 1, 'wide': 1})
                self.assertEqual(seen['visible'], [], 'nothing of the eyeball shows')
                self.assertGreater(seen['samples'], 200)

    def test_an_uncovered_sliver_is_reported(self):
        shutter = shutter_geometry(CENTER, RADIUS)
        # The round-2 defect: lift the lower blade's squint target so blink + squint leaves the bottom of the eye bare.
        broken = dict(shutter, morphs=dict(shutter['morphs']))
        broken['morphs']['squint'] = shutter['morphs']['squint'][:8] + [(x, y, z + .6 * RADIUS) for x, y, z in shutter['morphs']['squint'][8:]]
        problems = eye_coverage_problems(CENTER, RADIUS, broken)
        self.assertTrue(any(p.startswith('blink 1 + squint 1:') and 'eyeball' in p for p in problems), problems)
        # A blink that opens the lower blade further shows eyeball outside the neutral opening.
        opening = dict(shutter, morphs=dict(shutter['morphs']))
        opening['morphs']['blink'] = shutter['morphs']['blink'][:8] + [(x, y, z - .4 * RADIUS) for x, y, z in shutter['vertices'][8:]]
        problems = eye_coverage_problems(CENTER, RADIUS, opening)
        self.assertTrue(any(p.startswith('blink 0.25:') and 'outside the neutral opening' in p for p in problems), problems)


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
    jaw = JawHinge(pivot=(0, .01, .01), angle=20, mouth_z=-.04, half_width=.025, band=.03, back_band=.03)

    def test_lower_lip_moves_fully_and_upper_lip_stays(self):
        self.assertEqual(self.jaw.weight((0, -.08, -.0405)), 1)
        self.assertEqual(self.jaw.weight((0, -.08, -.0395)), 0)
        self.assertEqual(self.jaw.weight((.02, -.08, -.075)), 1, 'a band below the line the whole lower face moves')
        corner = self.jaw.weight((.02, -.08, -.0405))
        self.assertTrue(0 < corner < .6, 'the lower lip opens less toward the corners (a rounded mouth)')
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
        parts = [(0, -.06, -.05), (.01, -.05, -.075), (-.02, -.04, -.07)]
        moved = self.jaw.targets(parts, weight=1)
        for i in range(3):
            for j in range(3):
                self.assertAlmostEqual(distance(parts[i], parts[j]), distance(moved[i], moved[j]))
        falloff = self.jaw.targets(parts)
        self.assertEqual(falloff, moved, 'the middle of the lip and everything a band below the line get full weight')
        half = self.jaw.targets(parts, weight=[.5, .5, .5])
        self.assertLess(distance(half[0], parts[0]), distance(moved[0], parts[0]))

    def test_a_mid_head_pivot_swings_the_chin_back_and_up_instead_of_down(self):
        # The round-1 gap: a hinge near the middle of the head only opens a hole at the lips.
        head = HEADS['round head']
        vertices, faces = slit_blank(head['center'], head['radii'], head['mouth_z'], head['half_width'])
        jaw = JawHinge(pivot=(0, -.005, .1), angle=18, mouth_z=head['mouth_z'], half_width=head['half_width'], back_band=.06)
        report = chin_drop(vertices, jaw.targets(vertices))
        self.assertLess(report['drop'], 0, 'the lowest point rises')

    def test_seam_on_the_mouth_line_never_opens_by_float_rounding(self):
        # Blender stores float32: .088 rounds down, .086 and .075 round up. Neither may decide which lip moves.
        for mouth_z in (.088, .087, .08, .086, .075):
            with self.subTest(mouth_z=mouth_z):
                jaw = JawHinge(pivot=(0, .08, mouth_z), angle=8, mouth_z=mouth_z, half_width=.03, drop=.02)
                seam = (0.0, -.08, float32(mouth_z))
                self.assertEqual(jaw.weight(seam), 0, 'an untagged seam vertex is the upper lip')
                self.assertEqual(jaw.weight(seam, lower_lip=True), 1, 'a tagged seam vertex is the lower lip')
                upper, lower = jaw.targets([seam, seam], lower_lip=[1])
                self.assertEqual(upper, seam)
                self.assertLess(lower[2], seam[2] - .02)

    def test_drop_translates_the_jaw_down_and_fades_toward_the_hinge(self):
        jaw = JawHinge(pivot=(0, .08, .075), angle=0, mouth_z=.075, half_width=.03, drop=.02, drop_reach=.06)
        front, near = jaw.targets([(0, -.08, .05), (0, .06, .05)], weight=[1, 1])
        self.assertAlmostEqual(front[2], .03)
        self.assertAlmostEqual(front[1], -.08)
        self.assertGreater(near[2], .04, 'the drop fades out toward the hinge at the back')
        rigid = jaw.targets([(0, .06, .05)], weight=1)[0]
        self.assertAlmostEqual(rigid[2], .03, msg='weight=1 (rigid parts) always takes the full drop')

    def test_ear_hinge_drops_the_chin_by_a_tenth_of_the_head_without_folding(self):
        for label, head in HEADS.items():
            with self.subTest(head=label):
                vertices, faces = slit_blank(head['center'], head['radii'], head['mouth_z'], head['half_width'])
                jaw = JawHinge.ear(vertices, head['mouth_z'], head['half_width'])
                self.assertGreater(jaw.pivot[1], head['center'][1] + .5 * head['radii'][1], 'the hinge sits at the back, by the ear')
                self.assertAlmostEqual(jaw.pivot[2], head['mouth_z'])
                targets = jaw.targets(vertices)
                report = chin_drop(vertices, targets)
                self.assertGreaterEqual(report['ratio'], .1, report)
                self.assertLessEqual(report['ratio'], .2, report)
                self.assertEqual(folded_faces(vertices, targets, faces), [])
                above = [i for i, v in enumerate(vertices) if v[2] > head['mouth_z']]
                self.assertTrue(all(targets[i] == vertices[i] for i in above), 'the upper lip and everything above it stay put')
                lip = min((v for v in vertices if v[2] < head['mouth_z'] and abs(v[0]) < .005), key=lambda v: v[1])
                moved = jaw.targets([lip])[0]
                self.assertLess(moved[2] - lip[2], -report['drop'] * .9, 'the lower lip drops at least as far as the chin')
                self.assertGreater(moved[2] - lip[2], -3 * report['drop'], 'and the gape stays puppet-sized')

    def test_chin_drop_reports_the_lowest_point_against_the_height(self):
        rest = [(0, 0, 0), (0, 0, .2), (0, -.1, .05)]
        self.assertEqual(chin_drop(rest, [(0, 0, -.03), (0, 0, .2), (0, -.1, .05)]), {'drop': .03, 'height': .2, 'ratio': .15})
        self.assertAlmostEqual(chin_drop(rest, [(0, 0, .01), (0, 0, .2), (0, -.1, .05)])['drop'], -.01)

    def test_rejects_extreme_hinges(self):
        for options in (dict(angle=40), dict(angle=0), dict(half_width=0), dict(band=-1), dict(drop=-.01), dict(angle=0, drop=0), dict(drop_reach=0)):
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


class SurfaceFitTests(unittest.TestCase):
    frog = HEADS['wide frog']

    def test_front_surface_finds_the_skin_in_front_of_a_point(self):
        head = ellipsoid_geometry(self.frog['center'], self.frog['radii'], rings=48, segments=64)
        front = front_surface(head['vertices'], head['faces'])
        (cx, cy, cz), (rx, ry, rz) = self.frog['center'], self.frog['radii']
        for x, z in ((0, .12), (.05, .09), (-.08, .1)):
            exact = cy - ry * math.sqrt(1 - (x / rx) ** 2 - ((z - cz) / rz) ** 2)
            self.assertAlmostEqual(front(x, z), exact, delta=.001)
        self.assertIsNone(front(.5, .1), 'a point beside the head has no surface in front of it')

    def test_mouth_cavity_rim_follows_a_curved_face_without_poking_through(self):
        head = ellipsoid_geometry(self.frog['center'], self.frog['radii'], rings=48, segments=64)
        front = front_surface(head['vertices'], head['faces'])
        mouth_z, width = self.frog['mouth_z'], 2 * self.frog['half_width'] - .004
        flat = mouth_cavity_geometry((0, front(0, mouth_z) + .006, mouth_z - .002), width=width, height=.04, depth=.06)
        poking = [v for v in flat['vertices'] if front(v[0], v[2]) is not None and v[1] < front(v[0], v[2])]
        self.assertTrue(poking, 'a flat rim behind the middle of a wide mouth pokes out of the cheeks')
        fitted = mouth_cavity_geometry((0, front(0, mouth_z), mouth_z - .002), width=width, height=.04, depth=.06, surface=front, inset=.002)
        for v in fitted['vertices']:
            y = front(v[0], v[2])
            if y is not None: self.assertGreaterEqual(v[1], y + .002 - 1e-9)
        rim = [fitted['vertices'][i] for i in fitted['rim']]
        self.assertTrue(all(abs(v[1] - front(v[0], v[2]) - .002) < 1e-9 for v in rim), 'the rim hugs the skin, just behind it')

    def test_exposed_teeth_hang_in_front_of_the_closed_lower_lip(self):
        head = ellipsoid_geometry(self.frog['center'], self.frog['radii'], rings=48, segments=64)
        front = front_surface(head['vertices'], head['faces'])
        mouth_z = self.frog['mouth_z']
        for style in ('saw', 'rounded'):
            with self.subTest(style=style):
                teeth = exposed_teeth_geometry(front, (-.02, .02), mouth_z, length=.011, width=.007, style=style)
                self.assertEqual(teeth['count'], 2)
                self.assertAlmostEqual(min(v[2] for v in teeth['vertices']), mouth_z - .011, places=6)
                self.assertGreater(max(v[2] for v in teeth['vertices']), mouth_z, 'the root tucks under the upper lip')
                for v in teeth['vertices']:
                    if v[2] < mouth_z: self.assertLessEqual(v[1], front(v[0], v[2]) - teeth['clearance'] + 1e-9)
                self.assertGreaterEqual(teeth['clearance'], .0005)
                self.assertGreater(signed_volume(teeth['vertices'], teeth['faces']), 0)
                closed_and_consistent(self, teeth['vertices'], teeth['faces'])

    def test_cut_hole_leaves_a_smooth_rim_where_cut_faces_leaves_stairs(self):
        head = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=64)
        eye, radius = (.033, -.067, .145), .0185
        stairs, stair_faces, _ = cut_faces(head['vertices'], head['faces'], lambda c: math.dist(c, eye) < radius)
        used = {}
        for face in stair_faces:
            for a, b in zip(face, face[1:] + face[:1]): used[(min(a, b), max(a, b))] = used.get((min(a, b), max(a, b)), 0) + 1
        rim = {i for (a, b), n in used.items() if n == 1 for i in (a, b)}
        spread = [math.dist(stairs[i], eye) for i in rim]
        self.assertGreater(max(spread) - min(spread), .2 * radius, 'cut_faces leaves a stair-stepped rim')

        for blank, eye, radius in ((head, eye, radius), (ellipsoid_geometry((0, 0, .12), (.11, .085, .10), rings=56, segments=72), (.045, -.052, .182), .026)):
            cut = cut_hole(blank['vertices'], blank['faces'], eye, radius)
            # Every vertex on the hole's rim (edges used by one face near the eye) lies on the circle.
            count = {}
            for face in cut['faces']:
                for a, b in zip(face, face[1:] + face[:1]): count[(min(a, b), max(a, b))] = count.get((min(a, b), max(a, b)), 0) + 1
            rim = {i for (a, b), n in count.items() if n == 1 for i in (a, b) if math.dist(cut['vertices'][i], eye) < 2 * radius}
            self.assertGreater(len(rim), 12)
            self.assertEqual(rim, set(cut['boundary']) & rim)
            for i in rim: self.assertAlmostEqual(math.dist(cut['vertices'][i], eye), radius, delta=1e-7)
            self.assertTrue(all(math.dist(v, eye) >= radius - 1e-7 for v in cut['vertices']), 'no skin is left inside the hole')
            # Clipping keeps each face's orientation: nothing folds.
            for face, origin in zip(cut['faces'], cut['origin']):
                before = normals(blank['vertices'], [blank['faces'][origin]])[0]
                after = normals(cut['vertices'], [face])[0]
                self.assertGreater(sum(a * b for a, b in zip(before, after)), 0)
            closed = {k for k, n in count.items() if n == 2}
            self.assertTrue(all(n <= 2 for n in count.values()))
            self.assertTrue(closed)
        ellipse = cut_hole(head['vertices'], head['faces'], eye, (.02, .03, .015))
        for i in ellipse['boundary']:
            v = ellipse['vertices'][i]
            self.assertAlmostEqual(sum(((v[k] - eye[k]) / r) ** 2 for k, r in enumerate((.02, .03, .015))), 1, delta=1e-6)


class BrowTests(unittest.TestCase):
    """brow_ridge_geometry lays a heavy ridge on the skin over an eye in a dome (Mossjaw's brow is his ridge)."""
    # The round-4 critic's swamp creature: a squat head, big eyes high on domes, a heavy ridge over each.
    HEAD, EYE, R, OPENING = ((0, 0, .115), (.125, .09, .095)), (.052, -.04, .178), .024, (50, 40, 30)

    def skin(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=60, segments=80)
        vertices, faces = blank['vertices'], blank['faces']
        holes = {}
        for side, eye in (('L', self.EYE), ('R', mirror_x(self.EYE))):
            holes[side] = eye_hole(vertices, faces, eye, self.R, opening=self.OPENING)
            vertices, faces = holes[side]['vertices'], holes[side]['faces']
        return {'vertices': vertices, 'faces': faces}, holes

    def test_brow_ridge_lies_on_the_skin_at_rest_and_in_every_brow_morph(self):
        skin, holes = self.skin()
        # The critic's own settings, which floated the round-4 ridge 3-9 mm over the dome.
        left = brow_ridge_geometry(self.EYE, holes['L']['mound'], 'L', inner=15, outer=65, elevation=self.OPENING[1] + 20, height=16, arch=6,
                                   skin=skin, hole=holes['L'])
        self.assertEqual(sorted(left['morphs']), ['browDownLeft', 'browInnerUp', 'browOuterUpLeft'])
        closed_and_consistent(self, left['vertices'], left['faces'])
        self.assertGreater(signed_volume(left['vertices'], left['faces']), 0)
        self.assertLessEqual(skin_contact(left, skin)['gap'], .0005, 'at rest it lies on the skin itself')
        # Judged as the verifier does, against the skin and the lids: browDown lays the inner end on the upper lid.
        contact = left['contact']
        self.assertLessEqual(contact['gap'], .0005, contact)
        for name in left['morphs']:
            self.assertLessEqual(contact['poses'][name]['gap'], .0005, name)
            self.assertGreater(contact['poses'][name]['visible'], .5 * contact['visible'], f'{name} keeps the ridge above the skin')
        self.assertGreater(contact['visible'], .25, 'the ridge stands proud of the skin')
        inner = min(range(len(left['vertices'])), key=lambda i: left['vertices'][i][0])
        outer = max(range(len(left['vertices'])), key=lambda i: left['vertices'][i][0])
        down = left['morphs']['browDownLeft']
        self.assertLess(down[inner][2] - left['vertices'][inner][2], down[outer][2] - left['vertices'][outer][2] - .001, 'browDown drops the inner end most')
        self.assertGreater(left['morphs']['browInnerUp'][inner][2], left['vertices'][inner][2] + .001)
        self.assertGreater(left['morphs']['browOuterUpLeft'][outer][2], left['vertices'][outer][2] + .001)
        right = brow_ridge_geometry(mirror_x(self.EYE), holes['R']['mound'], 'R', inner=15, outer=65, elevation=60, height=16, arch=6,
                                    skin=skin, hole=holes['R'])
        self.assertEqual(sorted(right['morphs']), ['browDownRight', 'browInnerUp', 'browOuterUpRight'])
        for a, b in zip(left['vertices'], right['vertices']):
            for k in range(3): self.assertAlmostEqual(a[k], mirror_x(b)[k], delta=2e-4)

    def test_a_ridge_needs_the_skin_it_lies_on(self):
        with self.assertRaisesRegex(ValueError, 'skin'):
            brow_ridge_geometry(self.EYE, .03, 'L')


class AttachTests(unittest.TestCase):
    """attach_to_skin seats a small part on the skin and makes it ride the skin's morphs; skin_contact measures it."""
    HEAD = ((0, 0, .12), (.085, .09, .115))
    NOSE = (.012, .14)

    def skin(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=48, segments=64)
        front = front_surface(blank['vertices'], blank['faces'])
        x, z = self.NOSE
        center = (x, front(x, z), z)
        # noseSneerLeft swells the skin 3 mm forward under the nostril.
        sneer = soft_offset(blank['vertices'], center, .02, (0, -.003, .001))
        return dict(blank, morphs={'noseSneerLeft': sneer}), center

    def nostril(self, center):
        return ellipsoid_geometry(center, (.0035, .002, .0022), rings=8, segments=12)

    def test_a_part_that_ignores_the_skin_shape_is_buried_by_it(self):
        skin, center = self.skin()
        loose = self.nostril(center)
        contact = skin_contact(loose, skin)
        self.assertLessEqual(contact['gap'], .0005)
        self.assertLess(contact['poses']['noseSneerLeft']['visible'], .5 * contact['visible'], 'the swelling skin swallows it')

    def test_attach_seats_the_part_and_carries_the_skin_deltas_at_its_footprint(self):
        skin, center = self.skin()
        attached = attach_to_skin(self.nostril(center), skin, depth=.001)
        self.assertEqual(sorted(attached['morphs']), ['noseSneerLeft'])
        closed_and_consistent(self, attached['vertices'], attached['faces'])
        # Seated: the part's center sits 1 mm inside the skin.
        c = tuple(sum(v[k] for v in attached['vertices']) / len(attached['vertices']) for k in range(3))
        self.assertAlmostEqual(c[1] - front_surface(skin['vertices'], skin['faces'])(c[0], c[2]), .001, delta=.0003)
        # Each vertex moves as the skin surface under it (the swell, interpolated across the skin's 8 mm triangles).
        for rest, target in zip(attached['vertices'], attached['morphs']['noseSneerLeft']):
            self.assertTrue(-.0031 < target[1] - rest[1] < -.0018, target[1] - rest[1])
        contact = attached['contact']
        self.assertLessEqual(contact['gap'], .0005)
        self.assertLessEqual(contact['poses']['noseSneerLeft']['gap'], .0005)
        self.assertGreater(contact['poses']['noseSneerLeft']['visible'], .8 * contact['visible'])
        # Morphs that do not reach the part add nothing to it.
        far = attach_to_skin(self.nostril(center), dict(skin, morphs={'browInnerUp': soft_offset(skin['vertices'], (0, -.08, .2), .02, (0, 0, .004))}))
        self.assertEqual(far['morphs'], {})

    def test_skin_contact_measures_a_floating_part(self):
        skin, center = self.skin()
        lifted = self.nostril((center[0], center[1] - .0052, center[2]))  # its back 3 mm in front of the skin
        contact = skin_contact(lifted, skin)
        self.assertGreater(contact['gap'], .003)
        self.assertEqual(contact['floating'], contact['slices'], 'no slice touches')


def moved(rest, morphs, weights):
    """Positions at named morph weights (linear, as engines mix them)."""
    return [tuple(r[k] + sum(w * (morphs[n][i][k] - r[k]) for n, w in weights.items()) for k in range(3)) for i, r in enumerate(rest)]


class RobotPartsTests(unittest.TestCase):
    """Bolt's rigid brow plates, the skull / chin-plate split and the rubber mouth edge."""
    head = dict(center=(0, 0, .13), radii=(.075, .065, .10), mouth_z=.085)

    def blank(self):
        return ellipsoid_geometry(self.head['center'], self.head['radii'], rings=40, segments=56)

    def test_brow_plates_are_rigid_closed_bars_with_the_brow_morphs(self):
        plate = brow_plate_geometry((.032, -.068, .19), (.04, .005, .008), 'L')
        closed_and_consistent(self, plate['vertices'], plate['faces'])
        self.assertGreater(signed_volume(plate['vertices'], plate['faces']), 0)
        self.assertEqual(set(plate['morphs']), {'browDownLeft', 'browInnerUp', 'browOuterUpLeft'})
        rest = plate['vertices']
        for name, target in plate['morphs'].items():
            with self.subTest(morph=name):
                for i in range(len(rest)):
                    for j in range(i):
                        self.assertAlmostEqual(distance(rest[i], rest[j]), distance(target[i], target[j]), delta=1e-9, msg='the plate moves rigidly')
                self.assertGreaterEqual(max(distance(a, b) for a, b in zip(rest, target)), .001, 'the morph is not dead')
        inner = min(range(len(rest)), key=lambda i: rest[i][0])
        outer = max(range(len(rest)), key=lambda i: rest[i][0])
        dz = lambda name, i: plate['morphs'][name][i][2] - rest[i][2]
        self.assertLess(dz('browDownLeft', inner), dz('browDownLeft', outer) - .001, 'browDown lowers the inner end more')
        self.assertLess(dz('browDownLeft', outer), 0)
        self.assertGreater(dz('browInnerUp', inner), .001)
        self.assertGreater(dz('browOuterUpLeft', outer), .001)
        self.assertAlmostEqual(dz('browOuterUpLeft', inner), 0, delta=.0003, msg='browOuterUp pivots on the inner end')
        right = brow_plate_geometry((-.032, -.068, .19), (.04, .005, .008), 'R')
        self.assertEqual(set(right['morphs']), {'browDownRight', 'browInnerUp', 'browOuterUpRight'})
        for a, b in zip(sorted(plate['morphs']['browDownLeft']), sorted(mirror_x(p) for p in right['morphs']['browDownRight'])):
            for k in range(3): self.assertAlmostEqual(a[k], b[k], delta=1e-9)

    def test_brow_plates_stand_off_a_curved_face_at_every_weight(self):
        blank = self.blank()
        front = front_surface(blank['vertices'], blank['faces'])
        plate = brow_plate_geometry((.032, 0, .19), (.04, .005, .008), 'L', surface=front, clearance=.0005)
        names = list(plate['morphs'])
        for mask in range(1 << len(names)):
            weights = {n: 1 for k, n in enumerate(names) if mask >> k & 1}
            for x, y, z in moved(plate['vertices'], plate['morphs'], weights):
                skin = front(x, z)
                if skin is not None: self.assertLessEqual(y, skin - .0005 + 1e-9, weights)
        with self.assertRaises(ValueError):
            brow_plate_geometry((.032, -.068, .19), (.04, .005, .008), 'X')

    def test_a_boxy_blank_is_a_closed_superellipsoid(self):
        tin = ellipsoid_geometry((0, 0, .13), (.075, .065, .10), rings=24, segments=32, exponent=6)
        closed_and_consistent(self, tin['vertices'], tin['faces'])
        self.assertGreater(signed_volume(tin['vertices'], tin['faces']), 0)
        for x, y, z in tin['vertices']:
            self.assertAlmostEqual((abs(x) / .075) ** 6 + (abs(y) / .065) ** 6 + (abs(z - .13) / .10) ** 6, 1, delta=1e-9)
        # Flatter than the ellipsoid: a corner direction reaches much further out.
        self.assertGreater(max(x + z for x, y, z in tin['vertices'] if abs(y) < .01), .15)
        with self.assertRaises(ValueError):
            ellipsoid_geometry((0, 0, 0), (1, 1, 1), exponent=1)

    def test_split_plates_are_closed_thick_shells_clipped_at_the_split(self):
        blank = self.blank()
        parts = split_plates(blank['vertices'], blank['faces'], .08, .002)
        for key in ('skull', 'plate'):
            with self.subTest(part=key):
                part = parts[key]
                closed_and_consistent(self, part['vertices'], part['faces'])
                self.assertGreater(signed_volume(part['vertices'], part['faces']), 0)
                self.assertTrue(part['rim'], 'the cut edge is a rim of faces, not an open edge')
        self.assertGreaterEqual(min(v[2] for v in parts['skull']['vertices']), .08 - 1e-9)
        self.assertLessEqual(max(v[2] for v in parts['plate']['vertices']), .08 + 1e-9)
        # The rim is as thick as asked: each outer rim vertex has an inner partner `thickness` away, in the split plane.
        plate = parts['plate']
        for outer, inner in plate['rim'][:20]:
            self.assertAlmostEqual(distance(plate['vertices'][outer], plate['vertices'][inner]), .002, delta=.0003)
            self.assertAlmostEqual(plate['vertices'][inner][2], .08, delta=1e-9)

    def test_split_keeps_the_plate_rim_below_the_gum_line_and_off_the_mouth_line(self):
        blank = self.blank()
        with self.assertRaisesRegex(ValueError, 'gum'):
            split_plates(blank['vertices'], blank['faces'], .09, .002, gum_z=.088)
        parts = split_plates(blank['vertices'], blank['faces'], .085, .002, gap=.001, gum_z=.09)
        self.assertLessEqual(max(v[2] for v in parts['plate']['vertices']), .0845 + 1e-9)
        self.assertGreaterEqual(min(v[2] for v in parts['skull']['vertices']), .0855 - 1e-9)

    def test_rubber_mouth_edge_carries_the_mouth_shapes_and_rides_the_jaw(self):
        blank = self.blank()
        front = front_surface(blank['vertices'], blank['faces'])
        jaw = JawHinge.ear(blank['vertices'], self.head['mouth_z'], .035, angle=14, drop=.012)
        mouth = rubber_mouth_geometry(front, self.head['mouth_z'], .035, jaw=jaw)
        closed_and_consistent(self, mouth['vertices'], mouth['faces'])
        self.assertEqual(set(mouth['morphs']), {'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
                                                'mouthStretchLeft', 'mouthStretchRight', 'mouthFunnel', 'jawOpen'})
        rest, morphs = mouth['vertices'], mouth['morphs']
        for name, target in morphs.items():
            self.assertGreaterEqual(max(distance(a, b) for a, b in zip(rest, target)), .001, name)
        left = [i for i, v in enumerate(rest) if v[0] > .03]
        right = [i for i, v in enumerate(rest) if v[0] < -.02]
        self.assertTrue(all(morphs['mouthSmileLeft'][i][2] > rest[i][2] + .001 for i in left), 'smile lifts the left corner')
        self.assertTrue(all(distance(morphs['mouthSmileLeft'][i], rest[i]) < 1e-9 for i in right), 'the right corner stays')
        self.assertTrue(all(morphs['mouthFrownRight'][i][2] < rest[i][2] - .001 for i in right))
        middle = [i for i in mouth['upper'] if abs(rest[i][0]) < .005]
        self.assertTrue(all(morphs['mouthFunnel'][i][2] > rest[i][2] + .001 for i in middle), 'funnel rounds the lips apart')
        self.assertTrue(all(morphs['mouthFunnel'][i][0] < rest[i][0] - .001 for i in left), 'funnel pinches the corners in')
        # Every mouth shape slides the edge over the plates and lays it back on them: it never lifts off or sinks in.
        for name, target in morphs.items():
            if name == 'jawOpen': continue
            for x, y, z in target:
                skin = front(x, z)
                if skin is not None: self.assertLess(y, skin, name)
            gap = skin_contact({'vertices': rest, 'faces': mouth['faces'], 'morphs': {name: target}}, blank)['poses'][name]['gap']
            self.assertLessEqual(gap, .0005, name)
        upper, lower = mouth['upper'], mouth['lower']
        self.assertTrue(all(distance(morphs['jawOpen'][i], rest[i]) < 1e-12 for i in upper), 'the upper edge stays on the skull')
        self.assertTrue(all(morphs['jawOpen'][i][2] < rest[i][2] - .005 for i in lower), 'the lower edge rides the chin plate')
        for weights in ({'jawOpen': 1}, {'mouthSmileLeft': 1, 'mouthSmileRight': 1, 'jawOpen': .25}, {'mouthFunnel': 1, 'jawOpen': .6},
                        {'mouthStretchLeft': 1, 'mouthStretchRight': 1, 'mouthFrownLeft': 1, 'mouthFrownRight': 1, 'jawOpen': .3}):
            with self.subTest(weights=weights):
                self.assertEqual(folded_faces(rest, moved(rest, morphs, weights), mouth['faces']), [])
        for x, y, z in rest:
            skin = front(x, z)
            if skin is not None: self.assertLess(y, skin, 'the rubber edge sits proud of the plates')


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
        # The contract's fallback lift (.25) is under a pixel; the helpers write .8 so E2's lid follow shows.
        self.assertEqual(face['lidFollow'], {'down': .35, 'up': .8})
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


def edge_uses(faces):
    uses = {}
    for face in faces:
        for a, b in zip(face, face[1:] + face[:1]): uses.setdefault((min(a, b), max(a, b)), []).append((a, b))
    return uses


def triangles_of(faces):
    return [(face[0], face[k], face[k + 1]) for face in faces for k in range(1, len(face) - 1)]


class EyeHoleTests(unittest.TestCase):
    """eye_hole shapes the skin from the lids: a mound over them, a window cut, and a wall and lining that seal the eye."""
    HEAD = ((0, 0, .12), (.085, .09, .115))
    EYE, R, OPENING = (.033, -.067, .145), .014, (45, 38, 30)

    def hole(self, **options):
        blank = ellipsoid_geometry(*self.HEAD, rings=48, segments=64)
        return eye_hole(blank['vertices'], blank['faces'], self.EYE, self.R, opening=self.OPENING, **options)

    def test_the_window_holds_every_edge_travel_with_round_ends_inside_the_lids_reach(self):
        lids = lid_geometry(self.EYE, self.R, opening=self.OPENING)
        window = eye_window(lids, margin=6)

        def point(yaw, elevation, r=.02):
            y, e = math.radians(yaw), math.radians(elevation)
            return (self.EYE[0] + r * math.cos(e) * math.sin(y), self.EYE[1] - r * math.cos(e) * math.cos(y), self.EYE[2] + r * math.sin(e))
        for yaw, upper, lower in zip(lids['edges']['yaw'], lids['edges']['upper'], lids['edges']['lower']):
            if max(upper.values()) <= min(lower.values()): continue  # closed there in every state
            # Every edge position the eye can open to lies inside (near the corners a closing upper lid may pass under
            # the rim, in front of the lower lid, where the eye is shut anyway).
            for elevation in list(upper.values()) + list(lower.values()):
                if min(lower.values()) <= elevation <= max(upper.values()):
                    self.assertLess(window['level'](point(yaw, elevation)), 0, (yaw, elevation))
            # Where the eye can open, the whole travel lies at least the margin inside (the corner margin at the tips).
            tips = min(abs(yaw - y) for y, _ in (window['envelope'][0], max(window['envelope'])))
            for elevation in (max(upper.values()), min(lower.values())):
                self.assertLess(window['level'](point(yaw, elevation)), -5.9 if tips >= 15 else -1.9, (yaw, elevation))
        # The ends are round: past the widest opening point by the margin, the window closes.
        widest = max(abs(y) for y, _ in window['envelope'])
        self.assertGreater(window['level'](point(widest + 12, lids['meet'])), 5)
        # At the corners, where the lids meet and barely move, the window reaches only corner_margin (2 degrees) past
        # them, so no pointed pocket of wall and lining shows there (the round-4 inner-corner wedge).
        self.assertLess(window['level'](point(widest + 1, lids['meet'] + 1)), 0)
        self.assertGreater(window['level'](point(widest + 3.5, lids['meet'])), 0)
        # Everything the window opens onto is covered by the lids: their span reaches past it.
        self.assertLess(widest + 6, lids['edges']['yaw'][-1])
        round_ends = eye_window(lids, margin=6, corner_margin=6)
        self.assertLess(round_ends['level'](point(widest + 3, lids['meet'] + 2)), 0, 'corner_margin=margin gives the old round ends')
        self.assertLess(window['polar_max'], 75)
        with self.assertRaisesRegex(ValueError, 'shutter|cut_hole'):
            eye_window(shutter_geometry(self.EYE, self.R))

    def test_the_skin_stays_closed_and_meets_the_lids_all_round(self):
        hole = self.hole()
        vertices, faces, lids = hole['vertices'], hole['faces'], hole['lids']
        uses = edge_uses(faces)
        self.assertTrue(all(len(u) == 2 and u[0] == u[1][::-1] for u in uses.values()), 'one closed, consistently wound skin')
        outer = lids['upper_radius'] + lids['thickness']
        self.assertGreater(len(hole['rim']), 40)
        for i in hole['rim']:
            self.assertGreaterEqual(math.dist(vertices[i], self.EYE), outer + .00025 - 1e-9, 'the rim sits outside the lids')
            self.assertAlmostEqual(hole['window']['level'](vertices[i]), 0, delta=3)
        self.assertLessEqual(hole['rim_radius'][1], 1.3 * hole['mound'], 'the socket dip keeps the rim close to the lids')
        wall = {v for f in hole['wall'] for v in faces[f]} - set(hole['rim']) - set(hole['bevel'])
        for i in hole['bevel']:
            self.assertGreaterEqual(math.dist(vertices[i], self.EYE), outer - 1e-9, 'the bevel stays outside the lids')
        low, high = hole['lining']
        for i, v in enumerate(vertices):
            r = math.dist(v, self.EYE)
            if i in wall:
                self.assertGreaterEqual(r, self.R + .00025 - 1e-9, 'the lining never touches the eyeball')
                self.assertLessEqual(r, high + 1e-9, 'the wall ends under the lids')
            elif r < 3 * self.R:
                self.assertGreaterEqual(r, outer - 1e-6, 'no skin inside the lids: they never poke out')
        self.assertLess(low, lids['lower_radius'])
        self.assertLess(high, lids['upper_radius'])
        # No slivers in the skin: a sliver flips under the smallest morph. The wall and lining are narrow strips
        # between close rim vertices, but never degenerate.
        walls = set(hole['wall'])
        self.assertGreater(min(_quality(vertices, t) for t in triangles_of([f for i, f in enumerate(faces) if i not in walls])), 1e-3)
        self.assertGreater(min(_quality(vertices, t) for t in triangles_of([faces[i] for i in walls])), 1e-5)

    def test_the_rim_turns_into_the_wall_over_a_bevel_without_a_hard_crease(self):
        # join_face_parts marks edges turning by more than 60 degrees sharp: round 4's right-angled rim showed as a hard
        # seam round every eye. The bevel leaves the rim half way between the skin's slope and the wall.
        def creases(hole):
            rim = set(hole['rim'])
            edges = [e for e in edge_uses(hole['faces']) if rim.intersection(e)]
            sharp = [e for e in _sharp_edges(hole['vertices'], hole['faces'], 60) if rim.intersection(e)]
            return len(sharp) / len(edges)
        self.assertGreater(creases(self.hole(bevel=0)), .15)
        self.assertLess(creases(self.hole()), .02)

    def test_a_skin_that_runs_through_the_eye_is_mounded_over_it(self):
        # The frog's skin passes 5.7 mm above its eye's center: the mound pushes it out over the lids.
        blank = ellipsoid_geometry((0, 0, .12), (.11, .085, .10), rings=56, segments=72)
        eye = (.045, -.052, .182)
        hole = eye_hole(blank['vertices'], blank['faces'], eye, .02, opening=(48, 36, 28))
        outer = hole['lids']['upper_radius'] + hole['lids']['thickness']
        self.assertGreater(hole['pushed'], 100)
        self.assertGreaterEqual(hole['rim_radius'][0], outer)

    def test_the_morph_mask_keeps_rim_wall_and_lining_still(self):
        hole = self.hole()
        mask = eye_hole_mask(hole)
        vertices, faces = hole['vertices'], hole['faces']
        sealed = {v for f in hole['wall'] for v in faces[f]}
        self.assertTrue(all(mask(vertices[i]) == 0 for i in sealed))
        self.assertEqual(mask((.03, -.07, .06)), 1.0, 'the face far from the eye (the cheek by the mouth) moves freely')
        self.assertTrue([v for v in vertices if 0 < mask(v) < 1], 'the mask fades in smoothly')

    def test_refinement_splits_long_edges_near_the_eye_without_cracks_or_slivers(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=24, segments=32)
        near = lambda p: math.dist(p, self.EYE) < .03
        vertices, faces = _refine(blank['vertices'], blank['faces'], near, .003)
        closed_and_consistent(self, vertices, faces)
        self.assertAlmostEqual(signed_volume(vertices, faces), signed_volume(blank['vertices'], blank['faces']), delta=1e-6)
        for a, b in edge_uses(faces):
            if near(vertices[a]) or near(vertices[b]): self.assertLessEqual(math.dist(vertices[a], vertices[b]), .003 + 1e-12)
        self.assertGreater(min(_quality(vertices, t) for t in triangles_of(faces) if any(near(vertices[i]) for i in t)), .03)

    def test_snapping_the_clip_leaves_no_rim_slivers(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=48, segments=64)
        level = lambda p: math.dist(p, self.EYE) - .0185
        exact, snapped = _clip(blank['vertices'], blank['faces'], level), _clip(blank['vertices'], blank['faces'], level, snap=.15)
        worst = lambda cut: min(_quality(cut['vertices'], t) for t in triangles_of(cut['faces']))
        self.assertGreaterEqual(worst(snapped), worst(exact))
        for i in snapped['boundary']: self.assertAlmostEqual(math.dist(snapped['vertices'][i], self.EYE), .0185, delta=.0015)

    def test_default_lid_follow_lifts_the_lid_edge_you_can_see(self):
        # E2: eyeLookUp = 1 sets eyeWide = lidFollow.up; the edge's lift must show at 512 px (the verifier asks 1.5 mm).
        for radius in (.012, .014, .018):
            lids = lid_geometry(CENTER, radius)
            top = max(range(len(lids['vertices']) // 2), key=lambda i: -abs(lids['vertices'][i][0] - CENTER[0]) * 1e3
                      + (lids['edges']['upper'][len(lids['edges']['yaw']) // 2]['rest'] > 0))
            # The upper lid's edge vertex in the middle column: the one wide lifts most.
            lifts = [lids['morphs']['wide'][i][2] - lids['vertices'][i][2] for i in range(len(lids['vertices']) // 2)]
            lift = DEFAULT_LID_FOLLOW['up'] * max(lifts)
            with self.subTest(radius=radius):
                self.assertGreaterEqual(lift, .0015)
                self.assertGreaterEqual(DEFAULT_LID_FOLLOW['up'] * lids['wide'][0], 8, 'the helpers tie lid follow to the wide travel')


class ShutterHoleTests(unittest.TestCase):
    """shutter_hole seals a robot's face-plate eye hole: a tube straight back and a cap behind the eye."""

    def test_the_hole_is_a_sealed_tube_the_blades_slide_through(self):
        blank = ellipsoid_geometry((0, 0, .13), (.075, .065, .10), rings=48, segments=64, exponent=6)
        eye, r = (.032, -.0415, .16), .016
        hole = shutter_hole(blank['vertices'], blank['faces'], eye, r, hole_radius=.018, aperture=.021)
        vertices, faces = hole['vertices'], hole['faces']
        uses = edge_uses(faces)
        self.assertTrue(all(len(u) == 2 and u[0] == u[1][::-1] for u in uses.values()), 'one closed, consistently wound skin')
        for i in hole['rim']:
            self.assertAlmostEqual(math.hypot(vertices[i][0] - eye[0], vertices[i][2] - eye[2]), .018, delta=.0015)
            self.assertLess(vertices[i][1], eye[1] - r, 'the rim is on the face plate, in front of the eye')
        sealed = {v for f in hole['wall'] for v in faces[f]} - set(hole['rim'])
        for i in sealed:
            self.assertGreater(math.dist(vertices[i], eye), r + .001, 'the tube and cap never touch the eyeball')
            self.assertGreaterEqual(vertices[i][1], eye[1] - 1e-9, 'the tube runs back to the eye center, the cap behind it')
        self.assertEqual(hole['lids']['style'], 'shutter')
        self.assertGreaterEqual(hole['lids']['skin_clearance'], .0005, 'the blades were checked against the holed plate')
        with self.assertRaisesRegex(ValueError, 'recess'):
            shutter_hole(blank['vertices'], blank['faces'], (.032, -.06, .16), r, hole_radius=.018, aperture=.021)


class SkinBrowTests(unittest.TestCase):
    """skin_brow_geometry lays a kid's brow on the skin along its normal, sunk at the edges, in every pose."""
    # The round-5 critic's Pip-like head: a round face, big lidded eyes in eye holes, brows over the socket dip.
    HEAD, EYE, R, OPENING = ((0, 0, .13), (.088, .085, .11)), (.034, -.066, .152), .017, (46, 40, 30)

    def skin(self, morphs=True, masked=True):
        blank = ellipsoid_geometry(*self.HEAD, rings=56, segments=72)
        vertices, faces = blank['vertices'], blank['faces']
        holes = {}
        for side, eye in (('L', self.EYE), ('R', mirror_x(self.EYE))):
            holes[side] = eye_hole(vertices, faces, eye, self.R, opening=self.OPENING)
            vertices, faces = holes[side]['vertices'], holes[side]['faces']
        skin = {'vertices': vertices, 'faces': faces}
        if morphs:
            front = front_surface(vertices, faces)
            still = eye_hole_mask(*holes.values()) if masked else None
            down = symmetric_offsets(vertices, (.03, front(.03, .182), .182), .018, (0, -.001, -.004), mask=still)
            outer = symmetric_offsets(vertices, (.048, front(.048, .182), .182), .016, (0, 0, .004), mask=still)
            skin['morphs'] = {'browDownLeft': down[0], 'browDownRight': down[1], 'browOuterUpLeft': outer[0], 'browOuterUpRight': outer[1],
                              'browInnerUp': soft_offset(vertices, (0, front(0, .18), .18), (.03, .02, .016), (0, 0, .004), mask=still)}
        return skin, holes

    def assert_on_skin(self, brow, skin, hole):
        # Judged as the verifier does: against the skin and the lids.
        offset = len(skin['vertices'])
        lids = list(hole['lids']['vertices'])
        surface = {'vertices': skin['vertices'] + lids, 'faces': skin['faces'] + [tuple(i + offset for i in f) for f in hole['lids']['faces']],
                   'morphs': {name: list(targets) + lids for name, targets in (skin.get('morphs') or {}).items()}}
        contact = skin_contact(brow, surface)
        self.assertLessEqual(contact['gap'], .0005, 'at rest every slice touches the skin')
        self.assertEqual(contact['floating'], 0)
        self.assertGreater(contact['visible'], .3, 'the brow stands proud of the skin')
        for name, pose in contact['poses'].items():
            with self.subTest(pose=name):
                self.assertLessEqual(pose['gap'], .0005, name)
                self.assertGreater(pose['visible'], .5 * contact['visible'], f'{name} keeps the brow above the skin')
        return contact

    def test_a_brow_lies_on_the_skin_at_rest_and_in_every_pose(self):
        skin, holes = self.skin()
        # The critic's placements: every one floated 0.53-0.92 mm with the round-5 brow.
        placements = (((.013, .178), (.05, .181), {}), ((.013, .178), (.05, .181), {'height': .0045, 'thickness': .002}),
                      ((.013, .170), (.05, .172), {}), ((.013, .19), (.05, .192), {}), ((.012, .178), (.04, .18), {}))
        for inner, outer, options in placements:
            with self.subTest(inner=inner, outer=outer, **options):
                left = skin_brow_geometry(skin, 'L', inner=inner, outer=outer, hole=holes['L'], **options)
                self.assertEqual(sorted(left['morphs']), ['browDownLeft', 'browInnerUp', 'browOuterUpLeft'])
                closed_and_consistent(self, left['vertices'], left['faces'])
                self.assertGreater(signed_volume(left['vertices'], left['faces']), 0)
                self.assert_on_skin(left, skin, holes['L'])
                self.assertLessEqual(left['contact']['gap'], .0005)

    def test_the_cross_section_follows_the_skin_normal_and_stands_proud(self):
        skin, holes = self.skin(morphs=False)
        left = skin_brow_geometry(skin, 'L', inner=(.013, .178), outer=(.05, .181), thickness=.002, hole=holes['L'])
        self.assertLessEqual(skin_contact({'vertices': left['vertices'], 'faces': left['faces']}, skin)['gap'], .0005)
        # The outer end, where the forehead turns sideways, does not stand off as a tab: no vertex lies further off the
        # skin than the brow's own thickness, and the edges sink into it.
        from agent_meshes_face import _SkinIndex
        index = _SkinIndex(skin['vertices'], skin['faces'])
        heights = [index.nearest(v, limit=.02)[0] for v in left['vertices']]
        self.assertLessEqual(max(heights), .002 + 1e-4, 'no part of the brow stands further off the skin than its thickness')
        self.assertGreater(max(heights), .0014, 'the brow is a visible bump')
        self.assertLess(min(heights), 0, 'its edges sink into the skin')

    def test_brow_morphs_slide_the_brow_and_carry_the_skin_shapes(self):
        skin, holes = self.skin()
        left = skin_brow_geometry(skin, 'L', inner=(.013, .178), outer=(.05, .181), hole=holes['L'])
        right = skin_brow_geometry(skin, 'R', inner=(.013, .178), outer=(.05, .181), hole=holes['R'])
        self.assertEqual(sorted(right['morphs']), ['browDownRight', 'browInnerUp', 'browOuterUpRight'])
        for a, b in zip(left['vertices'], right['vertices']):
            for k in range(3): self.assertAlmostEqual(a[k], mirror_x(b)[k], delta=3e-4)
        rest = left['vertices']
        inner = min(range(len(rest)), key=lambda i: rest[i][0])
        outer = max(range(len(rest)), key=lambda i: rest[i][0])
        down = left['morphs']['browDownLeft']
        self.assertLess(down[inner][2], rest[inner][2] - .0035, 'browDown lowers the inner end')
        self.assertLess(down[inner][0], rest[inner][0] - .0015, 'browDown knits the inner end toward the nose')
        # Over the skin's own browDown shape (4 mm down at x = 30 mm, unmasked here) the brow rides it on top of its own slide.
        bare_skin, bare_holes = self.skin(morphs=False)
        bare = skin_brow_geometry(bare_skin, 'L', inner=(.013, .178), outer=(.05, .181), hole=bare_holes['L'])
        shaped_skin, shaped_holes = self.skin(masked=False)
        shaped = skin_brow_geometry(shaped_skin, 'L', inner=(.013, .178), outer=(.05, .181), hole=shaped_holes['L'])
        self.assert_on_skin(shaped, shaped_skin, shaped_holes['L'])
        middle = min(range(len(rest)), key=lambda i: abs(rest[i][0] - .03))
        drop = lambda brow: brow['morphs']['browDownLeft'][middle][2] - brow['vertices'][middle][2]
        self.assertLess(drop(shaped), drop(bare) - .0025)
        self.assertLess(down[inner][2] - rest[inner][2], down[outer][2] - rest[outer][2] - .001, 'browDown drops the inner end most')
        self.assertGreater(left['morphs']['browInnerUp'][inner][2], rest[inner][2] + .003)
        self.assertGreater(left['morphs']['browOuterUpLeft'][outer][2], rest[outer][2] + .003)
        self.assertEqual(set(left['laid']), {'browDownLeft', 'browOuterUpLeft', 'browInnerUp'}, 'poses already laid on the posed skin')
        # attach_to_skin afterwards does not add the skin's deltas a second time.
        again = attach_to_skin(left, skin)
        for name in left['morphs']:
            for a, b in zip(again['morphs'][name], left['morphs'][name]): self.assertAlmostEqual(math.dist(a, b), 0, delta=1e-9)

    def test_a_brow_needs_the_skin_itself(self):
        skin, holes = self.skin(morphs=False)
        front = front_surface(skin['vertices'], skin['faces'])
        with self.assertRaisesRegex(ValueError, 'skin'): skin_brow_geometry(front, 'L', (.013, .178), (.05, .181))
        with self.assertRaises(ValueError): skin_brow_geometry(skin, 'X', (.013, .178), (.05, .181))
        with self.assertRaisesRegex(ValueError, 'skin'): skin_brow_geometry(skin, 'L', (.013, .4), (.05, .4))


def max_dihedral(vertices, faces, near):
    """The largest angle (degrees) between neighbouring faces whose shared edge passes `near`."""
    normal = {}
    for index, face in enumerate(faces):
        a, b, c = (vertices[i] for i in face[:3])
        n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
             (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
        length = math.hypot(*n) or 1
        normal[index] = [x / length for x in n]
    owners = {}
    for index, face in enumerate(faces):
        for a, b in zip(face, face[1:] + face[:1]): owners.setdefault((min(a, b), max(a, b)), []).append(index)
    worst = 0
    for (a, b), users in owners.items():
        if len(users) != 2 or not (near(vertices[a]) or near(vertices[b])): continue
        dot = sum(x * y for x, y in zip(normal[users[0]], normal[users[1]]))
        worst = max(worst, math.degrees(math.acos(max(-1, min(1, dot)))))
    return worst


class NoseTests(unittest.TestCase):
    """nose_geometry sculpts a round button nose with nostril dimples into the skin, dense enough to stay smooth."""
    # The round-5 critic's Pip-like blank at its documented resolution.
    HEAD = ((0, 0, .13), (.088, .085, .11))
    TIP, SIZE = (0, .118), (.011, .01, .009)

    def blank(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=56, segments=72)
        return blank['vertices'], blank['faces']

    def near_nose(self, point): return abs(point[0]) < .02 and abs(point[2] - self.TIP[1]) < .02 and point[1] < -.05

    def test_a_soft_offset_sculpt_at_blank_resolution_makes_the_spike_the_owner_saw(self):
        vertices, faces = self.blank()
        front = front_surface(vertices, faces)(*self.TIP)
        spiked = soft_offset(vertices, (0, front, self.TIP[1]), (.011, .012, .010), (0, -.010, -.001))
        self.assertGreater(max_dihedral(spiked, faces, self.near_nose), 50, 'the old route: one vertex pulled out into a point')

    def test_the_nose_is_a_smooth_round_bulb_standing_out_of_the_face(self):
        vertices, faces = self.blank()
        before = front_surface(vertices, faces)(*self.TIP)
        nose = nose_geometry(vertices, faces, self.TIP, self.SIZE, nostrils=False)
        closed_and_consistent(self, nose['vertices'], nose['faces'])
        self.assertLess(max_dihedral(nose['vertices'], nose['faces'], self.near_nose), 25, 'no spike, no crease')
        after = front_surface(nose['vertices'], nose['faces'])
        self.assertAlmostEqual(before - after(*self.TIP), self.SIZE[2], delta=.0015, msg='it stands out by its projection')
        # Round, not pointed: half-way to its side edge it still stands out more than half its projection.
        half = self.SIZE[0] / 2, self.TIP[1]
        self.assertGreater(front_surface(vertices, faces)(*half) - after(*half), .5 * self.SIZE[2])
        # Blended: no step where it meets the face.
        edge_x = 1.4 * self.SIZE[0]
        self.assertAlmostEqual(after(edge_x, self.TIP[1]), front_surface(vertices, faces)(edge_x, self.TIP[1]), delta=2e-4)
        self.assertEqual(len(nose['material_indices']), len(nose['faces']))

    def test_nostril_dimples_under_the_tip_take_the_nostril_material(self):
        vertices, faces = self.blank()
        plain = nose_geometry(vertices, faces, self.TIP, self.SIZE, nostrils=False)
        nose = nose_geometry(vertices, faces, self.TIP, self.SIZE)
        self.assertEqual(set(plain['material_indices']), {0})
        dark = [f for f, m in zip(nose['faces'], nose['material_indices']) if m == 1]
        self.assertTrue(dark)
        centers = [tuple(sum(nose['vertices'][i][k] for i in f) / len(f) for k in range(3)) for f in dark]
        self.assertTrue(any(c[0] > .002 for c in centers) and any(c[0] < -.002 for c in centers), 'one dimple each side')
        self.assertTrue(all(c[2] < self.TIP[1] for c in centers), 'under the tip')
        from agent_meshes_face import _SkinIndex
        index = _SkinIndex(plain['vertices'], plain['faces'])
        self.assertEqual(len(nose['nostrils']), 2)
        for side, point in zip('LR', nose['nostrils']):
            with self.subTest(side=side):
                # The dimple is pressed into the bulb: its deepest point lies inside the plain nose.
                self.assertLess(index.nearest(point, limit=.02)[0], -.001)
        self.assertLess(max_dihedral(nose['vertices'], nose['faces'], self.near_nose), 40, 'soft dimples, no folds')

    def test_the_nose_sneer_lifts_each_wing_and_mirrors(self):
        vertices, faces = self.blank()
        nose = nose_geometry(vertices, faces, self.TIP, self.SIZE)
        left, right = symmetric_offsets(nose['vertices'], *nose['sneer'])
        wing = nose['nostrils'][0]
        i = min(range(len(nose['vertices'])), key=lambda i: math.dist(nose['vertices'][i], wing))
        self.assertGreater(left[i][2] - nose['vertices'][i][2], .002, 'noseSneerLeft lifts the left wing')
        self.assertLess(abs(right[i][2] - nose['vertices'][i][2]), abs(left[i][2] - nose['vertices'][i][2]) / 3)

    def test_rejects_a_nose_off_the_face(self):
        vertices, faces = self.blank()
        with self.assertRaisesRegex(ValueError, 'skin'): nose_geometry(vertices, faces, (0, .5), self.SIZE)
        with self.assertRaises(ValueError): nose_geometry(vertices, faces, self.TIP, (0, .01, .01))

class SculptSkinTests(unittest.TestCase):
    """sculpt_skin grows smooth-union forms (cheeks, a chin) out of a blank, refined where they are."""

    def test_cheeks_swell_smoothly_out_of_the_blank(self):
        blank = ellipsoid_geometry((0, 0, .13), (.088, .085, .11), rings=56, segments=72)
        cheeks = [((x, -.06, .11), (.024, .02, .02)) for x in (.045, -.045)]
        sculpted = sculpt_skin(blank['vertices'], blank['faces'], cheeks)
        closed_and_consistent(self, sculpted['vertices'], sculpted['faces'])
        for i, v in enumerate(blank['vertices']):
            if v[2] > .2 or v[1] > .03: self.assertEqual(sculpted['vertices'][i], v, 'far skin keeps its place and index')
        near = lambda p: abs(abs(p[0]) - .045) < .04 and abs(p[2] - .11) < .04 and p[1] < -.03
        self.assertLess(max_dihedral(sculpted['vertices'], sculpted['faces'], near), 25, 'no spike or crease')
        before, after = front_surface(blank['vertices'], blank['faces']), front_surface(sculpted['vertices'], sculpted['faces'])
        # The cheek's front stands on the ellipsoid (its front at y = -.08), in front of the blank there.
        self.assertAlmostEqual(after(.045, .11), -.08, delta=.0015)
        self.assertLess(after(.045, .11), before(.045, .11) - .004)
        self.assertEqual(after(0, .2), before(0, .2))
        # Symmetric shapes give a symmetric result.
        self.assertAlmostEqual(after(.05, .105), after(-.05, .105), delta=2e-4)

    def test_rejects_bad_shapes(self):
        blank = ellipsoid_geometry((0, 0, .13), (.088, .085, .11), rings=24, segments=32)
        with self.assertRaises(ValueError): sculpt_skin(blank['vertices'], blank['faces'], [])
        with self.assertRaises(ValueError): sculpt_skin(blank['vertices'], blank['faces'], [((0, -.08, .1), (0, .01, .01))])

class MouthLineSnapTests(unittest.TestCase):
    """slit_mouth first slides vertices a hair off the mouth line onto it, so its cut leaves no slivers to shade or fold."""

    def test_near_vertices_slide_along_their_crossing_edge_onto_the_line(self):
        from agent_meshes_face import _snap_to_plane
        blank = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=64)
        rows = sorted({round(v[2], 9) for v in blank['vertices']})
        mouth_z = min(rows, key=lambda z: abs(z - .075)) + .0001   # 0.1 mm above a ring: a sliver row
        snapped = _snap_to_plane(blank['vertices'], blank['faces'], mouth_z)
        moved = [i for i, (a, b) in enumerate(zip(blank['vertices'], snapped)) if a != b]
        self.assertTrue(moved)
        for i in moved:
            self.assertAlmostEqual(snapped[i][2], mouth_z, delta=1e-12)
            self.assertLess(math.dist(blank['vertices'][i], snapped[i]), .0006, 'only a hair')
        # Every vertex now either lies on the line or stays at least a quarter of an edge from it.
        for v in snapped:
            self.assertTrue(v[2] == mouth_z or abs(v[2] - mouth_z) > .0004, v)
        # It stays on the old surface (it slid along one of its edges).
        front = front_surface(blank['vertices'], blank['faces'])
        for i in moved:
            x, y, z = snapped[i]
            if y < -.03: self.assertAlmostEqual(front(x, z), y, delta=2e-4)

    def test_far_vertices_stay(self):
        from agent_meshes_face import _snap_to_plane
        blank = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=64)
        rows = sorted({round(v[2], 9) for v in blank['vertices']})
        mid = min(range(len(rows) - 1), key=lambda k: abs((rows[k] + rows[k + 1]) / 2 - .075))
        mouth_z = (rows[mid] + rows[mid + 1]) / 2
        self.assertEqual(_snap_to_plane(blank['vertices'], blank['faces'], mouth_z), [tuple(v) for v in blank['vertices']])

class LipTests(unittest.TestCase):
    """sculpt_lips shapes soft lips and a lip line into a skin face at rest, before slit_mouth cuts along the line."""
    HEAD = ((0, 0, .13), (.088, .085, .11))
    MOUTH_Z, HW = .088, .021

    def test_soft_lips_bulge_either_side_of_a_crease_on_the_mouth_line(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=56, segments=72)
        lips = sculpt_lips(blank['vertices'], blank['faces'], self.MOUTH_Z, self.HW)
        closed_and_consistent(self, lips['vertices'], lips['faces'])
        before, after = front_surface(blank['vertices'], blank['faces']), front_surface(lips['vertices'], lips['faces'])
        proud = lambda x, z: before(x, z) - after(x, z)
        upper, lower = max(proud(0, self.MOUTH_Z + k * .0005) for k in range(1, 12)), max(proud(0, self.MOUTH_Z - k * .0005) for k in range(1, 14))
        self.assertGreater(upper, .0008, 'the upper lip stands out')
        self.assertGreater(lower, upper, 'the lower lip is fuller')
        self.assertLess(proud(0, self.MOUTH_Z), .5 * upper, 'a crease runs along the line between them')
        self.assertLess(abs(proud(1.35 * self.HW, self.MOUTH_Z + .002)), 1e-4, 'the lips end at the corners')
        self.assertAlmostEqual(proud(.01, self.MOUTH_Z - .003), proud(-.01, self.MOUTH_Z - .003), delta=1e-4)
        # Soft lips: away from the lip line itself (a deliberate crease, where the slit is cut) no faces fold.
        near = lambda p: abs(p[0]) < .035 and .003 < abs(p[2] - self.MOUTH_Z) < .015 and p[1] < -.05
        self.assertLess(max_dihedral(lips['vertices'], lips['faces'], near), 20, 'soft, no creases between faces')
        # The mouth line is a row of vertices after sculpt_lips refines there, so slit_mouth cuts along it.
        from agent_meshes_face import _snap_to_plane
        snapped = _snap_to_plane(lips['vertices'], lips['faces'], self.MOUTH_Z)
        self.assertTrue(any(v[2] == self.MOUTH_Z and abs(v[0]) < self.HW for v in snapped))

    def test_rejects_bad_lips(self):
        blank = ellipsoid_geometry(*self.HEAD, rings=24, segments=32)
        with self.assertRaises(ValueError): sculpt_lips(blank['vertices'], blank['faces'], self.MOUTH_Z, 0)
        with self.assertRaisesRegex(ValueError, 'skin'): sculpt_lips(blank['vertices'], blank['faces'], .5, self.HW)

if __name__ == '__main__':
    unittest.main()
