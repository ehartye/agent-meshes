"""Garment layers and work boots for the stylized character recipe (no Blender required)."""
import math
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'recipes'))
import stylized_character as character
import stylized_walk as walk

MARA={'height':1.82,'presentation':'female','costume':{
    'shirt':{'color':'#e8e2d0'},'jacket':{'color':'#c8672e','badge':'#5d8a52'},
    'overalls':{'color':'#3a6f86','cargo':True},'belt':{'pouches':3},'gloves':{},'boots':{},'neck_ring':{}}}
OREN={'height':1.88,'presentation':'male','costume':{
    'shirt':{'color':'#ece6d6'},'jacket':{'color':'#b8612f'},'trousers':{'color':'#2e6b7c','cargo':True},
    'belt':{},'backpack':{},'gloves':{}}}
TESS={'height':1.22,'age':'child','costume':{
    'shirt':{'color':'#e9c25a'},'overalls':{'color':'#4d7fa0','cuffs':'#86b3c9','buttons':'#d9a441'}}}
KIT={'height':1.19,'age':'child','presentation':'male','costume':{
    'hoodie':{'color':'#5c7d4a'},'trousers':{'color':'#2f4a73','cargo':True},'backpack':{}}}
CAST={'mara':MARA,'oren':OREN,'tess':TESS,'kit':KIT}
BODY=['tailored-torso','left-sleeve','right-sleeve','trouser-yoke','left-leg','right-leg']

def parts(config):return {p['name']:p for p in character.geometry(config)}
def fused_name(name):return 'layer-top' if name in BODY[:3] else 'layer-bottom'

class CostumeParameters(unittest.TestCase):
    def test_slots_fill_defaults_and_stay_idempotent(self):
        p=character.parameters(TESS)
        self.assertEqual(p['costume']['overalls']['cargo'],False)
        self.assertIn('color',p['costume']['shirt'])
        self.assertEqual(character.parameters(p),p)
        self.assertIsNone(character.parameters({})['costume'])

    def test_invalid_costumes_reject(self):
        bad=[{'cape':{}},{'shirt':{'colour':'#ffffff'},'trousers':{}},{'shirt':{'color':'red'},'trousers':{}},
             {'shirt':{},'trousers':{},'belt':{'pouches':5}},{'shirt':{},'trousers':{},'belt':{'pouches':True}},
             {'jacket':{},'trousers':{}},{'shirt':{},'jacket':{},'hoodie':{},'trousers':{}},
             {'shirt':{}},{'shirt':{},'trousers':{},'overalls':{}},{'shirt':{},'trousers':{'cargo':'yes'}},
             {'shirt':{},'trousers':{'color':None}},'jacket',{}]
        for costume in bad:
            with self.subTest(costume=costume),self.assertRaises(ValueError):
                character.parameters({'costume':costume})
        with self.assertRaises(ValueError):
            character.parameters({'vacuum':True,'costume':{'shirt':{},'trousers':{}}})

class GarmentLayers(unittest.TestCase):
    def test_board_layers_and_props_are_present(self):
        expected={
            'mara':['layer-top','layer-bottom','layer-shirt-front','layer-jacket-lapel-left','layer-jacket-lapel-right',
                    'layer-jacket-collar','layer-jacket-hem','layer-bib','layer-strap-left','layer-strap-right',
                    'layer-belt','layer-buckle','layer-pouch-0','layer-pouch-2','layer-left-cargo-pocket',
                    'layer-jacket-badge','left-hand-glove','right-hand-glove','layer-neck-plate'],
            'oren':['layer-shirt-front','layer-jacket-lapel-left','layer-belt','layer-buckle','layer-backpack',
                    'layer-pack-strap-left','layer-pack-strap-right','left-hand-glove','layer-right-cargo-pocket'],
            'tess':['layer-bib','layer-strap-left','layer-bib-pocket','layer-left-leg-cuff','layer-right-leg-cuff',
                    'layer-left-sleeve-cuff','layer-bib-button-left'],
            'kit':['layer-hood','layer-hoodie-zip','layer-hoodie-pocket','layer-hoodie-drawstring-left',
                   'layer-hoodie-hem','layer-backpack','layer-pack-strap-left','layer-left-cargo-pocket'],
        }
        for name,config in CAST.items():
            by_name=parts(config)
            with self.subTest(name=name):
                for part in expected[name]:self.assertIn(part,{fused_name(n) if n in BODY else n for n in by_name})
                for gone in ['left-knee-panel','chest-terminal','front-fastener','left-ankle','left-boot-seam']:
                    self.assertNotIn(gone,by_name)
                self.assertEqual(len(by_name),len(character.geometry(config)))
        self.assertNotIn('layer-strap-left',parts({**OREN}))
        self.assertNotIn('left-hand-glove',parts(TESS))

    def test_hood_and_tool_pouches_read_at_lineup_size(self):
        """A hoodie's hood lies on the upper back above the pack; tool pouches hang onto the thigh."""
        d=character.landmarks(KIT);s=d['s'];sh=d['shoulder_y'];by_name=parts(KIT);body=character.body_surface(KIT)
        hood=by_name['layer-hood-back']['vertices']
        self.assertLess(min(v[1] for v in hood),sh-.09*s)
        self.assertLess(min(v[2] for v in hood),min(v[2] for v in by_name['tailored-torso']['vertices'] if v[1]>sh-.09*s)-.015*s)
        self.assertLessEqual(max(v[1] for v in by_name['layer-backpack']['vertices']),sh-.085*s)
        self.assertGreater(max(body.value(v) for v in hood),0)
        d=character.landmarks(MARA);s=d['s'];by_name=parts(MARA)
        pouch=by_name['layer-pouch-0']['vertices']
        self.assertLess(min(v[1] for v in pouch),d['hip_y']-.045*s)

    def test_every_layer_is_seated_on_the_body(self):
        """Each slab's inner face is embedded and its outer face stands proud: nothing floats."""
        for name,config in CAST.items():
            body=character.body_surface(config)
            for part in character.geometry(config):
                if not part['name'].startswith('layer-') or part['name'].startswith('layer-backpack'):continue
                values=[body.value(v) for v in part['vertices']]
                with self.subTest(name=name,part=part['name']):
                    self.assertLess(min(values),0,'layer does not touch the body')
                    self.assertGreater(max(values),0,'layer is buried in the body')

    def test_layer_patch_is_a_closed_slab_between_body_and_offset(self):
        m=character.Meshes()
        rows=[(0,0,0,.1,.1),(1,0,0,.1,.1)]
        m.rings('tube',rows,'#ffffff')
        body=character.BodySurface([rows])
        rays=[[((0,.3+.1*j,0),(math.cos(.2*i),0,math.sin(.2*i))) for j in range(5)] for i in range(5)]
        character.layer_patch(m,body,'patch','#000000',rays,thickness=.01,embed=.004)
        patch=m.parts[-1];half=len(patch['vertices'])//2
        outer,inner=patch['vertices'][:half],patch['vertices'][half:]
        self.assertTrue(all(body.value(v)<0 for v in inner))
        self.assertTrue(all(body.value(v)>0 for v in outer))
        radii=[math.hypot(v[0],v[2]) for v in outer]
        self.assertAlmostEqual(max(radii),.11,places=3)
        edges={}
        for face in patch['faces']:
            for a,b in zip(face,face[1:]+face[:1]):edges[frozenset((a,b))]=edges.get(frozenset((a,b)),0)+1
        self.assertTrue(all(count==2 for count in edges.values()),'slab must be closed')

class WorkBoots(unittest.TestCase):
    CONFIGS=[{},MARA,TESS,{'vacuum':True},{'species':'alien','age':'child','height':1.12}]

    def test_sole_is_one_continuous_piece_with_the_upper(self):
        for config in self.CONFIGS:
            by_name=parts(config);s=character.landmarks(config)['s']
            for side in ['left','right']:
                sole=by_name[side+'-outsole']['vertices']
                upper=by_name[side+'-boot']['vertices']+by_name[side+'-boot-toe-cap']['vertices']
                with self.subTest(config=config,side=side):
                    self.assertGreaterEqual(sum(1 for v in sole if v[1]==0),20,'planar tread')
                    upper_keys={tuple(round(c,9) for c in v) for v in upper}
                    shared=[v for v in sole if tuple(round(c,9) for c in v) in upper_keys]
                    self.assertGreaterEqual(len(shared),40,'sole rim must be the upper boundary')
                    # No flared plate: the sole never extends past the upper's outline.
                    for axis in [0,2]:
                        self.assertLessEqual(max(v[axis] for v in sole),max(v[axis] for v in upper)+1e-9)
                        self.assertGreaterEqual(min(v[axis] for v in sole),min(v[axis] for v in upper)-1e-9)
                    # Chunky: an ankle-high shaft and a broad forefoot.
                    self.assertGreater(max(v[1] for v in upper),.19*s)
                    self.assertGreater(max(v[0] for v in upper)-min(v[0] for v in upper),.11*s)

    def test_sole_wraps_toe_and_heel_with_a_heel_block(self):
        for config in self.CONFIGS:
            by_name=parts(config);s=character.landmarks(config)['s']
            sole=by_name['left-outsole']['vertices']
            front=max(v[2] for v in sole);back=min(v[2] for v in sole)
            with self.subTest(config=config):
                self.assertGreater(max(v[1] for v in sole if v[2]>front-.02*s),.045*s)
                self.assertGreater(max(v[1] for v in sole if v[2]<back+.02*s),.045*s)
                arch=[v[1] for v in sole if abs(v[2]-.03*s)<.012*s and v[1]<.01*s]
                self.assertTrue(arch and min(arch)>.004*s,'midfoot is recessed between heel block and ball')

    def test_boot_details(self):
        for config,laces in [({},True),(MARA,True),({'vacuum':True},False)]:
            by_name=parts(config)
            with self.subTest(config=config):
                self.assertIn('left-boot-collar',by_name)
                self.assertEqual('left-boot-laces' in by_name,laces)

class GarmentRig(unittest.TestCase):
    def test_garments_bind_to_body_bones(self):
        for name,config in CAST.items():
            d=character.landmarks(config)
            for part in character.geometry(config):
                n=fused_name(part['name']) if part['name'] in BODY else part['name']
                if not (n.startswith('layer-') or n.endswith('-glove') or 'boot' in n or 'outsole' in n):continue
                rows=walk.skin_weights(n,part['vertices'],d)
                with self.subTest(name=name,part=n):
                    self.assertFalse(any('head' in row for row in rows))
                    self.assertTrue(all(abs(sum(row.values())-1)<1e-6 for row in rows))

    def test_eased_top_keeps_its_side_seam_on_the_torso(self):
        """A roomy jacket or hoodie must not pull its side panel along with a swinging arm (armpit fold)."""
        def side_arm_weight(config):
            d=character.landmarks(config);s=d['s'];torso=parts(config)['tailored-torso']['vertices']
            side=[v for v in torso if d['chest_y']-.1*s<v[1]<d['shoulder_y']-.04*s]
            rows=walk.skin_weights('layer-top',side,d)
            return max(sum(w for bone,w in row.items() if 'arm' in bone) for row in rows)
        for name in ['mara','oren','kit']:
            config=CAST[name];plain={k:v for k,v in config.items() if k!='costume'}
            with self.subTest(name=name):
                self.assertLessEqual(side_arm_weight(config),side_arm_weight(plain)+.05)

    def test_boot_shaft_follows_the_shin_and_sole_the_foot(self):
        d=character.landmarks(MARA);by_name=parts(MARA)
        sole=walk.skin_weights('left-outsole',by_name['left-outsole']['vertices'],d)
        self.assertTrue(all(row=={'left-foot':1} for row in sole))
        collar=walk.skin_weights('left-boot-collar',by_name['left-boot-collar']['vertices'],d)
        self.assertTrue(all(row.get('left-shin',0)>.9 for row in collar))

    def test_skinned_vertices_follow_the_rig(self):
        d=character.landmarks({});rest=walk.rest_bones(d)
        for gait in ['walk','jog']:
            pose=walk.gait_pose(d,.3,gait)
            for bone in ['left-foot','right-hand','left-shin']:
                name={'left-foot':'left-outsole','right-hand':'right-hand','left-shin':'layer-bottom'}[bone]
                point=rest[bone]['head']
                if bone=='left-shin':point=(point[0],point[1]-.15,point[2])
                moved=walk.skinned_vertices(name,[point],d,.3,gait)[0]
                self.assertLess(abs(math.dist(moved,pose[bone][0])-math.dist(point,rest[bone]['head'])),1e-9)

    def test_layers_ride_the_body_through_walk_and_jog(self):
        """Paired layer/body points keep their spacing at 8 phases of each clip (no floating or sinking).

        Thick pieces (pouches) may pivot a little on their seat, in proportion to their standoff."""
        for name in ['mara','kit']:
            config=CAST[name];d=character.landmarks(config);s=d['s'];by_name=parts(config)
            body=[(fused_name(n),v) for n in BODY for v in by_name[n]['vertices'][::3]]
            for part in by_name.values():
                if not part['name'].startswith('layer-') or part['name'].startswith('layer-backpack'):continue
                sample=part['vertices'][::max(1,len(part['vertices'])//24)]
                pairs=[min(body,key=lambda b:math.dist(b[1],v)) for v in sample]
                rest=[math.dist(v,b[1]) for v,b in zip(sample,pairs)]
                for gait in ['walk','jog']:
                    for k in range(8):
                        phase=k/8
                        moved=walk.skinned_vertices(part['name'],sample,d,phase,gait)
                        anchors=[walk.skinned_vertices(n,[v],d,phase,gait)[0] for n,v in pairs]
                        drift=max(abs(math.dist(a,b)-r)-.25*r for a,b,r in zip(moved,anchors,rest))
                        with self.subTest(name=name,part=part['name'],gait=gait,phase=phase):
                            self.assertLess(drift,.006*s)

if __name__=='__main__':unittest.main()
