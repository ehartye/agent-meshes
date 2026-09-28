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
OREN={'height':1.88,'presentation':'male','build':1.3,'costume':{
    'shirt':{'color':'#ece6d6'},'jacket':{'color':'#b8612f','badge':'#5d8a52'},'trousers':{'color':'#2e6b7c','cargo':True,'pockets':True},
    'belt':{'pouches':1},'backpack':{},'gloves':{}}}
TESS={'height':1.14,'age':'child','costume':{
    'shirt':{'color':'#e9c25a'},'overalls':{'color':'#3b6a86','cuffs':'#86b3c9','buttons':'#d9a441','cargo':True,'pockets':True}}}
KIT={'height':1.36,'age':'child','presentation':'male','costume':{
    'hoodie':{'color':'#5c7d4a'},'trousers':{'color':'#2f4a73','cargo':True},'backpack':{}}}
CAST={'mara':MARA,'oren':OREN,'tess':TESS,'kit':KIT}
BODY=['tailored-torso','left-sleeve','right-sleeve','trouser-yoke','left-leg','right-leg']

def mix(a,b,t):return a+(b-a)*t
def parts(config):return {p['name']:p for p in character.geometry(config)}
def fused_name(name):return 'layer-top' if name in BODY[:3] else 'layer-bottom'

class CostumeParameters(unittest.TestCase):
    def test_slots_fill_defaults_and_stay_idempotent(self):
        p=character.parameters(TESS)
        self.assertEqual(character.parameters({'costume':{'shirt':{},'overalls':{}}})['costume']['overalls']['cargo'],False)
        self.assertIn('color',p['costume']['shirt'])
        self.assertEqual(character.parameters(p),p)
        self.assertIsNone(character.parameters({})['costume'])

    def test_invalid_costumes_reject(self):
        bad=[{'cape':{}},{'shirt':{'colour':'#ffffff'},'trousers':{}},{'shirt':{'color':'red'},'trousers':{}},
             {'shirt':{},'trousers':{},'belt':{'pouches':5}},{'shirt':{},'trousers':{},'belt':{'pouches':True}},
             {'jacket':{},'trousers':{}},{'shirt':{},'jacket':{},'hoodie':{},'trousers':{}},
             {'shirt':{}},{'shirt':{},'trousers':{},'overalls':{}},{'shirt':{},'trousers':{'cargo':'yes'}},{'shirt':{},'trousers':{'pockets':1}},
             {'shirt':{},'trousers':{'color':None}},'jacket',{}]
        for costume in bad:
            with self.subTest(costume=costume),self.assertRaises(ValueError):
                character.parameters({'costume':costume})
        with self.assertRaises(ValueError):
            character.parameters({'vacuum':True,'costume':{'shirt':{},'trousers':{}}})

class BodyBuild(unittest.TestCase):
    def test_build_broadens_the_frame_and_rejects_out_of_range(self):
        """A broad build (the board's Adult Reference) has wider shoulders, a deeper chest and thicker limbs."""
        base={'height':1.88,'presentation':'male'};broad=dict(base,build=1.3)
        a,b=character.landmarks(base),character.landmarks(broad)
        self.assertGreater(b['shoulder_w'],a['shoulder_w']*1.08)
        span=lambda config,name,axis:(lambda v:max(p[axis] for p in v)-min(p[axis] for p in v))(parts(config)[name]['vertices'])
        self.assertGreater(span(broad,'tailored-torso',2),span(base,'tailored-torso',2)*1.12)
        self.assertGreater(span(broad,'left-leg',0),span(base,'left-leg',0)*1.05)
        self.assertEqual(character.geometry(dict(base,build=1.0)),character.geometry(base))
        for bad in [.5,2,True,'big']:
            with self.subTest(build=bad),self.assertRaises(ValueError):character.parameters({'build':bad})

class GarmentLayers(unittest.TestCase):
    def test_board_layers_and_props_are_present(self):
        expected={
            'mara':['layer-top','layer-bottom','layer-shirt-front','layer-jacket-lapel-left','layer-jacket-lapel-right',
                    'layer-jacket-collar','layer-jacket-hem','layer-bib','layer-strap-left','layer-strap-right',
                    'layer-belt','layer-buckle','layer-pouch-0','layer-pouch-2','layer-left-cargo-pocket',
                    'layer-left-sleeve-patch','layer-jacket-chest-pocket-left','left-hand-glove','right-hand-glove','layer-neck-plate'],
            'oren':['layer-left-hip-pocket','layer-right-sleeve-patch','layer-shirt-front','layer-jacket-lapel-left','layer-belt','layer-buckle','layer-backpack',
                    'layer-pack-strap-left','layer-pack-strap-right','left-hand-glove','layer-right-cargo-pocket'],
            'tess':['layer-left-hip-pocket','layer-right-cargo-pocket','layer-back-bib','layer-bib','layer-strap-left','layer-bib-pocket','layer-left-leg-cuff','layer-right-leg-cuff',
                    'layer-left-sleeve-cuff','layer-bib-button-left'],
            'kit':['layer-hood','layer-hoodie-zip','layer-hoodie-pocket','layer-hoodie-drawstring-left',
                   'layer-hoodie-hem','layer-hood-lining','layer-backpack','layer-pack-strap-left','layer-left-cargo-pocket'],
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

    def test_straps_reach_their_anchors(self):
        """Shoulder straps never end in mid-air: pack straps continue under the arm to the pack,
        and bib-overall straps meet a back bib at the waistband."""
        for name in ['oren','kit']:
            config=CAST[name];by_name=parts(config)
            pack=by_name['layer-backpack']['vertices']
            for label in ['left','right']:
                lower=by_name['layer-pack-strap-'+label+'-lower']['vertices']
                with self.subTest(name=name,side=label):
                    self.assertGreater(max(v[2] for v in lower),min(v[2] for v in by_name['layer-pack-strap-'+label]['vertices'])-.001)
                    # Its rear end reaches the pack's side.
                    rear=min(lower,key=lambda v:v[2])
                    self.assertLess(abs(rear[0]),max(abs(v[0]) for v in pack))
                    self.assertTrue(min(v[1] for v in pack)<rear[1]<max(v[1] for v in pack))
                    self.assertLess(rear[2],max(v[2] for v in pack)+.02)
        d=character.landmarks(TESS);s=d['s'];by_name=parts(TESS)
        bib=by_name['layer-back-bib']['vertices'];top=max(v[1] for v in bib)
        self.assertLess(min(v[1] for v in bib),d['hip_y']+.036*s)
        for label in ['left','right']:
            strap=by_name['layer-strap-'+label]['vertices'];back=[v for v in strap if v[2]<0]
            self.assertLess(min(v[1] for v in back),top)

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

    def test_overalls_bib_rises_from_a_waistband(self):
        """Overalls close round the waist, so the bib grows out of a band instead of hanging like an apron."""
        for config in [TESS,MARA]:
            d=character.landmarks(config);s=d['s'];by_name=parts(config)
            band=by_name['layer-overalls-waistband']['vertices'];bib=by_name['layer-bib']['vertices']
            lo,hi=min(v[1] for v in band),max(v[1] for v in band)
            with self.subTest(height=config['height']):
                self.assertLessEqual(lo,d['hip_y'])
                self.assertGreaterEqual(hi,d['hip_y']+.035*s)
                self.assertTrue(lo<min(v[1] for v in bib)<hi-.02*s,'bib hem must tuck under the band')
                back=[v for v in band if v[2]<0];self.assertTrue(back,'band wraps the back')
                for label in ['left','right']:self.assertIn('layer-overalls-side-button-'+label,by_name)
                # The band covers the bib hem it overlaps.
                body=character.body_surface(config)
                hem=[v for v in bib if v[1]<hi-.012*s]
                band_out=max(body.value(v) for v in band if abs(v[0])<.02*s and v[2]>0)
                self.assertLess(max(body.value(v) for v in hem),band_out)

    def test_belt_and_pouches_stand_over_the_overalls_waistband(self):
        """Stacked layers never show through each other: belt over waistband, pouches over belt."""
        d=character.landmarks(MARA);s=d['s'];by_name=parts(MARA);body=character.body_surface(MARA)
        def outer(name):
            v=by_name[name]['vertices'];return v[:len(v)//2]
        lo,hi=d['hip_y']+.012*s,d['hip_y']+.035*s
        belt=[v for v in outer('layer-belt') if lo-.01*s<=v[1]<=hi+.01*s]
        for v in outer('layer-overalls-waistband'):
            if not lo<=v[1]<=hi:continue
            # The belt surface over this waistband point stands further out.
            over=min(belt,key=lambda b:math.hypot(math.atan2(b[2],b[0])-math.atan2(v[2],v[0]),(b[1]-v[1])/(.1*s)))
            with self.subTest(point=v):self.assertGreater(body.value(over),body.value(v))
        # Below its top edge (which tucks under the belt) a pouch covers the belt.
        hi=d['hip_y']+.03*s
        pouch=[v for v in outer('layer-pouch-0') if lo<=v[1]<=hi]
        angles=sorted(math.atan2(v[2],v[0]) for v in pouch);inside=lambda v:angles[0]+.05<math.atan2(v[2],v[0])<angles[-1]-.05
        near=[v for v in outer('layer-belt') if lo<=v[1]<=hi and inside(v)]
        self.assertGreater(min(body.value(v) for v in pouch if inside(v)),max(body.value(v) for v in near))
        self.assertLess(max(v[1] for v in by_name['layer-overalls-waistband']['vertices']),min(v[1] for v in by_name['layer-jacket-hem']['vertices'])-.001*s)

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
                    # Chunky: a shaft above the ankle and a broad forefoot.
                    self.assertGreater(max(v[1] for v in by_name[side+'-boot-shaft']['vertices']),.25*s)
                    self.assertGreater(max(v[0] for v in upper)-min(v[0] for v in upper),.11*s)

    def test_sole_wraps_toe_and_heel_with_a_heel_block(self):
        for config in self.CONFIGS:
            by_name=parts(config);s=character.landmarks(config)['s']
            sole=by_name['left-outsole']['vertices']
            front=max(v[2] for v in sole);back=min(v[2] for v in sole)
            with self.subTest(config=config):
                self.assertGreater(max(v[1] for v in sole if v[2]>front-.02*s),.045*s)
                self.assertGreater(max(v[1] for v in sole if v[2]<back+.02*s),.045*s)
                arch=[v[1] for v in sole if abs(v[2]-.03*s)<.012*s and v[1]<.015*s]
                self.assertTrue(arch and min(arch)>.004*s,'midfoot is recessed between heel block and ball')

    def test_tall_shaft_and_seated_cuff(self):
        """A work boot rises to mid-shin; its padded cuff hugs the shaft rim with no gap, and the
        trouser leg ends on the cuff instead of vanishing into the boot."""
        for config in self.CONFIGS:
            by_name=parts(config);s=character.landmarks(config)['s']
            shaft=by_name['left-boot-shaft']['vertices'];cuff=by_name['left-boot-cuff']['vertices']
            with self.subTest(config=config):
                self.assertGreater(max(v[1] for v in cuff),.28*s)
                # The cuff's lower rim tucks inside the shaft wall, all the way round.
                lo=min(v[1] for v in cuff);rim=[v for v in cuff if v[1]<lo+1e-9]
                shaft_top=[v for v in shaft if abs(v[1]-max(w[1] for w in shaft))<1e-9]
                cx=sum(v[0] for v in shaft_top)/len(shaft_top);cz=sum(v[2] for v in shaft_top)/len(shaft_top)
                reach=lambda points:max(math.hypot(v[0]-cx,v[2]-cz) for v in points)
                self.assertLess(reach(rim),reach(shaft_top))
                self.assertLess(lo,max(v[1] for v in shaft))
                # The shaft starts inside the foot upper.
                self.assertLess(min(v[1] for v in shaft),max(v[1] for v in by_name['left-boot']['vertices'])-.05*s)
                tread=by_name['left-boot-tread']['vertices']
                self.assertGreater(min(v[1] for v in tread),.003*s)
        for config in [MARA,TESS]:
            by_name=parts(config);s=character.landmarks(config)['s']
            leg=by_name.get('layer-left-leg-hem') or by_name['layer-left-leg-cuff']
            with self.subTest(config=config['height']):
                self.assertGreater(min(v[1] for v in leg['vertices']),max(v[1] for v in by_name['left-boot-cuff']['vertices'])-.012*s)

    def test_boot_details(self):
        for config,laces in [({},True),(MARA,True),({'vacuum':True},False)]:
            by_name=parts(config)
            with self.subTest(config=config):
                for piece in ['shaft','cuff','tread']:self.assertIn('left-boot-'+piece,by_name)
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

    def test_trousers_and_belt_skin_as_one_garment_over_the_hip(self):
        """The hip blends down the upper thigh, the crotch shares both thighs, and a pouch or
        pocket takes the weights of the cloth it sits on."""
        d=character.landmarks(MARA);s=d['s'];hip=d['hip_y']
        front=walk.skin_weights('layer-bottom',[(.096*s,hip-.12*s,.1*s)],d)[0]
        self.assertTrue(.2<front['pelvis']<.8,front)
        crotch=walk.skin_weights('layer-bottom',[(0,hip-.1*s,0)],d)[0]
        self.assertAlmostEqual(crotch['left-thigh'],crotch['right-thigh'])
        by_name=parts(MARA);pouch=by_name['layer-pouch-0']['vertices']
        low=[v for v in pouch if v[1]<hip-.02*s]
        self.assertTrue(all(row.get('left-thigh',0)+row.get('right-thigh',0)>0 for row in walk.skin_weights('layer-pouch-0',low,d)))
        # A cargo pocket and the leg under it share weights: standoff does not change the blend.
        under=(.096*s+.07*s,mix(d['hip_y']*.53,hip,.4),0);proud=(under[0]+.012*s,under[1],0)
        a,b=walk.skin_weights('layer-bottom',[under,proud],d)
        for bone in set(a)|set(b):self.assertAlmostEqual(a.get(bone,0),b.get(bone,0),places=3)

    def test_boot_shaft_follows_the_shin_and_sole_the_foot(self):
        d=character.landmarks(MARA);by_name=parts(MARA)
        sole=walk.skin_weights('left-outsole',by_name['left-outsole']['vertices'],d)
        self.assertTrue(all(row=={'left-foot':1} for row in sole))
        cuff=walk.skin_weights('left-boot-cuff',by_name['left-boot-cuff']['vertices'],d)
        self.assertTrue(all(row.get('left-shin',0)>.9 for row in cuff))

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

        Thick pieces (pouches) may pivot a little on their seat, in proportion to their standoff.
        The hip and knee blend over a long reach, so the cloth stretches and the spacing to one
        sampled body vertex moves a few millimetres; check-garments on the built GLB is the
        binding penetration test."""
        for name in ['mara','kit']:
            config=CAST[name];d=character.landmarks(config);s=d['s'];by_name=parts(config)
            body=[(fused_name(n),v,'sleeve' in n) for n in BODY for v in by_name[n]['vertices']]
            for part in by_name.values():
                if not part['name'].startswith('layer-') or part['name'].startswith('layer-backpack'):continue
                sample=part['vertices'][::max(1,len(part['vertices'])//24)]
                # Pair each point with the body under it: nearest, strongly preferring the same height.
                # Torso-hung layers sit on the torso, never on the arm that hangs beside them.
                under=body if 'sleeve' in part['name'] else [b for b in body if not b[2]]
                pairs=[min(under,key=lambda b:math.dist(b[1],v)+3*abs(b[1][1]-v[1]))[:2] for v in sample]
                rest=[math.dist(v,b[1]) for v,b in zip(sample,pairs)]
                for gait in ['walk','jog']:
                    for k in range(8):
                        phase=k/8
                        moved=walk.skinned_vertices(part['name'],sample,d,phase,gait)
                        anchors=[walk.skinned_vertices(n,[v],d,phase,gait)[0] for n,v in pairs]
                        drift=max(abs(math.dist(a,b)-r)-.25*r for a,b,r in zip(moved,anchors,rest))
                        with self.subTest(name=name,part=part['name'],gait=gait,phase=phase):
                            self.assertLess(drift,.013*s)

    def test_swinging_hands_clear_the_tool_pouches(self):
        """Belt pouches sit off the arm's swing lane, so a hand never brushes into one."""
        config=MARA;d=character.landmarks(config);s=d['s'];by_name=parts(config)
        pouch=[v for n,p in by_name.items() if n.startswith('layer-pouch') for v in p['vertices'][::2]]
        for side in ['left','right']:
            hand=[v for n,p in by_name.items() if n.startswith(side+'-') and any(t in n for t in ['palm','finger','thumb','glove']) for v in p['vertices'][::3]]
            for gait in ['walk','jog']:
                for k in range(16):
                    moved=walk.skinned_vertices(side+'-hand',hand,d,k/16,gait)
                    bag=walk.skinned_vertices('layer-pouch-0',pouch,d,k/16,gait)
                    gap=min(math.dist(a,b) for a in moved for b in bag)
                    with self.subTest(side=side,gait=gait,phase=k/16):self.assertGreater(gap,.01*s)

if __name__=='__main__':unittest.main()
