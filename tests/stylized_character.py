"""Geometry contract for the reusable character recipe (no Blender required)."""
import importlib.util
import math
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'recipes' / 'stylized_character.py'

class CharacterContract(unittest.TestCase):
    def recipe(self):
        self.assertTrue(SOURCE.is_file(), 'Reusable character recipe must exist in the tool')
        spec = importlib.util.spec_from_file_location('character', SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_repeatable_anatomy_and_ground_contact(self):
        recipe = self.recipe()
        config = {'height': 1.82, 'age': 'adult', 'presentation': 'female'}
        first = recipe.geometry(config)
        self.assertEqual(first, recipe.geometry(config))
        by_name = {p['name']: p for p in first}
        self.assertIn('face', by_name)
        self.assertIn('left-upper-eyelid', by_name)
        self.assertIn('left-thumb', by_name)
        foot = by_name['left-boot']['vertices']
        self.assertGreater(max(v[2] for v in foot), .18)
        self.assertLess(min(v[2] for v in foot), -.05)
        self.assertAlmostEqual(min(v[1] for p in first for v in p['vertices']), 0, places=5)
        for part in first:
            self.assertTrue(all(math.isfinite(c) for v in part['vertices'] for c in v))
            self.assertTrue(all(0 <= i < len(part['vertices']) for f in part['faces'] for i in f))

    def test_variants_and_bad_parameters(self):
        recipe = self.recipe()
        for species in ['human', 'alien']:
            for age, height in [('adult', 1.8), ('child', 1.2)]:
                for vacuum in [False, True]:
                    parts = recipe.geometry({'species':species,'age':age,'height':height,'vacuum':vacuum})
                    self.assertEqual(len(parts), len({p['name'] for p in parts}))
                    self.assertGreater(len(parts), 20)
                    self.assertLess(max(v[1] for p in parts for v in p['vertices']), height * 1.15)
        for invalid in [{'height':float('nan')}, {'height':-1}, {'species':'typo'}, {'vacuum':'false'}, {'unexpected':1}]:
            with self.assertRaises(ValueError): recipe.geometry(invalid)

# The Space to Grow cast (the recipe's reference fixture): height, age, presentation, species.
CAST = {
    'mara': dict(height=1.82, age='adult', presentation='female', species='human', hair='#363544'),
    'oren': dict(height=1.88, age='adult', presentation='male', species='human', hair='#252c37'),
    'tess': dict(height=1.22, age='child', presentation='female', species='human', hair='#614036'),
    'kit': dict(height=1.19, age='child', presentation='male', species='human', hair='#303944'),
    'pip': dict(height=1.65, age='adult', presentation='female', species='alien'),
    'nori': dict(height=1.12, age='child', presentation='female', species='alien'),
}

def _point_triangle(p, a, b, c):
    """Closest distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5)."""
    sub = lambda u, v: (u[0]-v[0], u[1]-v[1], u[2]-v[2])
    dot = lambda u, v: u[0]*v[0]+u[1]*v[1]+u[2]*v[2]
    ab, ac, ap = sub(b, a), sub(c, a), sub(p, a)
    d1, d2 = dot(ab, ap), dot(ac, ap)
    if d1 <= 0 and d2 <= 0: return math.dist(p, a)
    bp = sub(p, b); d3, d4 = dot(ab, bp), dot(ac, bp)
    if d3 >= 0 and d4 <= d3: return math.dist(p, b)
    vc = d1*d4 - d3*d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        v = d1/(d1-d3); return math.dist(p, tuple(a[k]+v*ab[k] for k in range(3)))
    cp = sub(p, c); d5, d6 = dot(ab, cp), dot(ac, cp)
    if d6 >= 0 and d5 <= d6: return math.dist(p, c)
    vb = d5*d2 - d1*d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        w = d2/(d2-d6); return math.dist(p, tuple(a[k]+w*ac[k] for k in range(3)))
    va = d3*d6 - d5*d4
    if va <= 0 and d4-d3 >= 0 and d5-d6 >= 0:
        w = (d4-d3)/((d4-d3)+(d5-d6)); return math.dist(p, tuple(b[k]+w*(c[k]-b[k]) for k in range(3)))
    denom = 1/(va+vb+vc); v, w = vb*denom, vc*denom
    return math.dist(p, tuple(a[k]+ab[k]*v+ac[k]*w for k in range(3)))

class VacuumHelmetContract(unittest.TestCase):
    recipe = CharacterContract.recipe

    def suited(self, name):
        parts = self.recipe().geometry(dict(CAST[name], vacuum=True))
        return parts, {p['name']: p for p in parts}

    def head_parts(self, parts):
        """Everything the helmet holds, as the recipe reports it (face, eyes, hair, ears, fronds)."""
        return [p for p in parts if p.get('head')]

    def mesh_clearance(self, head, glass):
        """Closest approach of head/hair vertices to the actual glass triangles (not the fitted ellipsoid)."""
        gv = glass['vertices']; tris = []
        for f in glass['faces']:
            for i in range(1, len(f)-1): tris.append((gv[f[0]], gv[f[i]], gv[f[i+1]]))
        points = [v for p in head for v in p['vertices'][::2]]
        sample = gv[::5]
        # Only the points nearest the glass matter: rank by distance to glass vertices, check the closest exactly.
        coarse = sorted(points, key=lambda q: min(math.dist(q, g) for g in sample))[:40]
        best = float('inf')
        for q in coarse:
            for t in tris:
                if min(math.dist(q, x) for x in t) < best + .03: best = min(best, _point_triangle(q, *t))
        return best

    def test_glass_helmet_holds_the_living_face(self):
        for name in CAST:
            parts, by = self.suited(name)
            with self.subTest(name=name):
                for required in ['face', 'left-eye-white', 'left-upper-eyelid', 'mouth-line', 'helmet-glass', 'helmet-shell', 'helmet-rim', 'helmet-neck-ring', 'helmet-neck-seal']:
                    self.assertIn(required, by)
                glass = by['helmet-glass']
                self.assertLess(glass['material']['opacity'], .35)
                self.assertTrue(glass['material']['double_sided'])
                self.assertLessEqual(glass['roughness'], .1)
                for opaque in ['helmet-shell', 'helmet-rim', 'face']: self.assertNotIn('material', by[opaque])
                for old in ['visor', 'visor-gasket', 'helmet-collar']: self.assertNotIn(old, by)
                self.assertIn('face', {p['name'] for p in self.head_parts(parts)})

    def test_clearance_from_face_and_hair_to_glass_is_15_to_40_mm(self):
        for name in CAST:
            parts, by = self.suited(name)
            head = self.head_parts(parts)
            with self.subTest(name=name):
                clearance = self.mesh_clearance(head, by['helmet-glass'])
                self.assertGreaterEqual(clearance, .015)
                self.assertLessEqual(clearance, .04)
                self.assertGreaterEqual(by['helmet-glass']['fit']['clearance'], .015)
                self.assertLessEqual(by['helmet-glass']['fit']['clearance'], .04)

    def test_nothing_of_the_head_leaves_the_helmet(self):
        for name in CAST:
            parts, by = self.suited(name)
            fit = by['helmet-glass']['fit']
            head = [v for p in self.head_parts(parts) for v in p['vertices']]
            with self.subTest(name=name):
                self.assertGreater(min(v[1] for v in head), fit['cut_y'])
                self.assertGreater(fit['opening_radius'], .06 * CAST[name]['height'] / 1.82)

    def test_helmet_size_follows_the_head_not_the_height(self):
        size = {}
        for name in CAST:
            _, by = self.suited(name); size[name] = by['helmet-glass']['fit']['radii']
        for child, adult in [('tess', 'mara'), ('kit', 'oren'), ('nori', 'pip')]:
            self.assertLess(max(size[child]), max(size[adult]) - .01)
        # A child's head is proportionally larger, so its helmet shrinks less than its height does.
        self.assertGreater(max(size['kit'])/max(size['oren']), 1.19/1.88 + .05)
        # The alien's wide, fronded head gives a differently shaped bubble.
        human = size['oren'][0]/size['oren'][1]; alien = size['pip'][0]/size['pip'][1]
        self.assertGreater(abs(alien - human), .04)

    def test_helmet_fit_is_derived_from_points(self):
        fit = self.recipe().helmet_fit
        ball = [(math.cos(a)*.1, 1.5+math.sin(a)*.1, 0) for a in [i*math.tau/40 for i in range(40)]] + [(0, 1.5, .1), (0, 1.5, -.1)]
        small, large = fit(ball, neck_radius=.05), fit([(x*1.5, 1.5+(y-1.5)*1.5, z*1.5) for x, y, z in ball], neck_radius=.05)
        self.assertAlmostEqual(small['clearance'], .022, places=3)
        self.assertGreater(min(large['radii']), max(small['radii']))

    def test_head_clears_the_whole_bubble_glass_and_shell(self):
        # The shell's inner surface is the same bubble: an ear or ponytail behind the window must clear it too.
        for name in CAST:
            parts, by = self.suited(name)
            head = self.head_parts(parts)
            with self.subTest(name=name):
                self.assertGreaterEqual(self.mesh_clearance(head, by['helmet-shell']), .015)

    def test_face_and_ears_sit_behind_the_glass_not_the_rim(self):
        # The window plane is placed from the head: every face, eye and ear vertex from the back of the ears forward
        # is in front of it with room to spare, so the rim never crosses an ear and the profile reads through glass.
        # The back of the skull and the hair may run on into the shell.
        for name in CAST:
            parts, by = self.suited(name)
            fit = by['helmet-glass']['fit']; window = fit['window']
            back = min(v[2] for p in self.head_parts(parts) if 'ear' in p['name'] for v in p['vertices'])
            with self.subTest(name=name):
                for part in self.head_parts(parts):
                    if 'hair' in part['name']: continue
                    for v in part['vertices']:
                        if v[2] < back: continue
                        d = [(v[k]-fit['center'][k])/fit['radii'][k] for k in range(3)]
                        self.assertGreaterEqual(sum(d[k]*window['normal'][k] for k in range(3)) - window['offset'], .02, part['name'])

    def test_side_pods_sit_on_the_shell_behind_the_ears_in_suit_colors(self):
        for name in CAST:
            parts, by = self.suited(name)
            fit = by['helmet-glass']['fit']; window = fit['window']
            ears = [v for p in parts if p.get('head') and 'ear' in p['name'] for v in p['vertices']]
            skin = self.recipe().parameters(dict(CAST[name], vacuum=True))
            with self.subTest(name=name):
                pods = [p for p in parts if 'helmet-pod' in p['name']]
                self.assertEqual(len(pods), 4)
                for pod in pods:
                    self.assertNotIn(pod['color'].lower(), {skin['skin'].lower(), skin['accent'].lower()})
                    for v in pod['vertices']:
                        d = [(v[k]-fit['center'][k])/fit['radii'][k] for k in range(3)]
                        self.assertLess(sum(d[k]*window['normal'][k] for k in range(3)), window['offset'])
                    self.assertLess(max(v[2] for v in pod['vertices']), min(v[2] for v in ears))

    def test_glass_declares_what_it_holds_for_the_build_enclosure_check(self):
        for name in CAST:
            parts, by = self.suited(name)
            with self.subTest(name=name):
                encloses = by['helmet-glass']['extras']['encloses']
                self.assertEqual(encloses['parts'], [p['name'] for p in self.head_parts(parts)])
                self.assertEqual(encloses['with'], ['helmet-shell'])
                self.assertEqual((encloses['clearance'], encloses['maxClearance']), (.015, .04))
        clothed = self.recipe().geometry(dict(CAST['mara'], vacuum=False))
        self.assertFalse(any('extras' in p for p in clothed))

    def test_fieldwork_suit_language(self):
        parts, by = self.suited('mara')
        for required in ['backpack', 'left-shoulder-pad', 'right-elbow-pad', 'left-thigh-pouch', 'belt-pouch-left']:
            self.assertIn(required, by)
        self.assertEqual(by['left-knee-panel']['color'], by['left-shoulder-pad']['color'])
        self.assertEqual(by['helmet-rim']['color'], by['helmet-neck-ring']['color'])
        clothed = {p['name'] for p in self.recipe().geometry(dict(CAST['mara'], vacuum=False))}
        self.assertFalse(any(n.startswith('helmet') or 'pouch' in n or n == 'backpack' for n in clothed))

if __name__ == '__main__': unittest.main()
