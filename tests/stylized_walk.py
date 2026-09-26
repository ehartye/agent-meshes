"""Shared gait geometry contracts; no Blender required."""
import math
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'recipes'))

class WalkContract(unittest.TestCase):
    def test_embedded_recipe_needs_no_sibling_module(self):
        from unittest.mock import patch
        recipe=Path(__file__).resolve().parents[1]/'recipes'
        namespace={}
        exec((recipe/'stylized_character.py').read_text(),namespace)
        exec((recipe/'stylized_walk.py').read_text(),namespace)
        original_import=__import__
        def import_without_sibling(name,*args,**kwargs):
            if name=='stylized_character':raise ModuleNotFoundError(name)
            return original_import(name,*args,**kwargs)
        with patch('builtins.__import__',side_effect=import_without_sibling):
            self.assertEqual(len(namespace['jog_pose'](namespace['landmarks']({}),.1)),16)

    def test_foot_roll_internal_joins_are_smooth(self):
        import stylized_character as character
        import stylized_walk as walk
        d=character.landmarks({});eps=1e-5
        for gait in ['walk','jog']:
            stance=walk.gait_settings(gait)['stance']
            for p in [stance*.23,stance*.60,stance+(1-stance)*.22,stance+(1-stance)*.72]:
                for endpoint in [0,1]:
                    def point(t):return walk.gait_pose(d,t,gait)['left-foot'][endpoint]
                    a,b,c,e,f=[point(p+k*eps) for k in [-2,-1,0,1,2]]
                    before=tuple((z-2*y+x)/eps**2 for x,y,z in zip(a,b,c))
                    after=tuple((z-2*y+x)/eps**2 for x,y,z in zip(c,e,f))
                    self.assertLess(math.dist(before,after),.05)

    def test_heel_toe_roll_supports_actual_mesh_without_sliding(self):
        import stylized_character as character
        import stylized_walk as walk
        d=character.landmarks({});rest=walk.rest_bones(d)['left-foot']
        parts=character.geometry({})
        sole=next(p['vertices'] for p in parts if p['name']=='left-outsole')
        local=[walk.w_sub(v,rest['head']) for v in sole]
        for gait in ['walk','jog']:
            settings=walk.gait_settings(gait);stance=settings['stance']
            angles=[]
            for i in range(201):
                phase=i/200;pose=walk.gait_pose(d,phase,gait)
                a,b=pose['left-foot'];direction=walk.w_sub(b,a)
                angle=math.atan2(direction[2],direction[1])-math.atan2(.20,-.08)
                angles.append(angle)
                verts=[walk.w_add(a,walk.w_rotate_x(v,angle)) for v in local]
                minimum=min(v[1] for v in verts)
                self.assertGreaterEqual(minimum,-1e-8)
                if phase%1<stance:self.assertAlmostEqual(minimum,0,places=7)
            self.assertLess(min(angles),-.12)
            self.assertGreater(max(angles),.3 if gait=='jog' else .2)
            # The material heel/toe in contact travels at constant treadmill speed.
            length=sum(math.dist(walk.rest_bones(d)[n]['head'],walk.rest_bones(d)[n]['tail']) for n in ['left-thigh','left-shin'])
            for p in [.05*stance,.9*stance]:
                values=[]
                for phase in [p-1e-5,p+1e-5]:
                    a,b=walk.gait_pose(d,phase,gait)['left-foot'];direction=walk.w_sub(b,a)
                    angle=math.atan2(direction[2],direction[1])-math.atan2(.20,-.08)
                    pivot=min(local,key=lambda v:walk.w_rotate_x(v,angle)[1])
                    values.append(walk.w_add(a,walk.w_rotate_x(pivot,angle))[2])
                self.assertAlmostEqual((values[1]-values[0])/2e-5,-length*settings['stride']/stance,places=6)

    def test_walk_contact_has_continuous_velocity_and_acceleration(self):
        import stylized_character as character
        import stylized_walk as walk
        d=character.landmarks({});eps=1e-5
        for gait in ['walk','jog']:
            stance=walk.gait_settings(gait)['stance']
            def point(p):return walk.gait_pose(d,p,gait)['left-foot'][0]
            for p in [0,stance,1]:
                a,b,c=point(p-eps),point(p),point(p+eps)
                self.assertLess(math.dist(tuple((y-x)/eps for x,y in zip(a,b)),tuple((y-x)/eps for x,y in zip(b,c))),.005)
                # Sole roll also has zero angular acceleration at these joins.
                self.assertLess(math.hypot(*( (x-2*y+z)/eps**2 for x,y,z in zip(a,b,c))),.08)

    def test_jog_and_walk_anatomy_sweep(self):
        import stylized_character as character
        import stylized_walk as walk
        for age in ['adult','child']:
            for species in ['human','alien']:
                for height in [.7,1.2,1.82,2.5]:
                    d=character.landmarks({'height':height,'age':age,'species':species})
                    rest=walk.rest_bones(d)
                    for gait in ['walk','jog']:
                        poses=[walk.gait_pose(d,i/100,gait) for i in range(100)]
                        for pose in poses:
                            for name,(a,b) in pose.items():
                                self.assertTrue(all(math.isfinite(v) for v in a+b))
                                self.assertAlmostEqual(math.dist(a,b),math.dist(rest[name]['head'],rest[name]['tail']),places=6)
                        self.assertEqual(walk.gait_pose(d,0,gait),walk.gait_pose(d,1,gait))
                        self.assertGreater(max(p['pelvis'][0][0] for p in poses)-min(p['pelvis'][0][0] for p in poses),.008*d['s'])
                        if gait=='jog':
                            length=sum(math.dist(rest[n]['head'],rest[n]['tail']) for n in ['left-thigh','left-shin'])
                            self.assertTrue(any(all(walk._foot_path((i/100+offset)%1,walk.gait_settings(gait),length)[0]>.005*d['s'] for offset in [0,.5]) for i in range(100)))

    def test_loop_contact_and_bone_lengths(self):
        import stylized_character as character
        self.assertTrue(hasattr(character,'landmarks'),'Character recipe must expose shared rig landmarks')
        import stylized_walk as walk
        for age,height in [('adult',1.82),('child',1.2)]:
            for species in ['human','alien']:
                layout=character.landmarks({'height':height,'age':age,'species':species})
                rest=walk.rest_bones(layout)
                start=walk.walk_pose(layout,0); end=walk.walk_pose(layout,1)
                self.assertEqual(start,end)
                for step in range(120):
                    phase=step/120;pose=walk.walk_pose(layout,phase)
                    for name in rest:
                        self.assertAlmostEqual(math.dist(*pose[name]),math.dist(rest[name]['head'],rest[name]['tail']),places=6)
                    for side,offset in [('left',0),('right',.5)]:
                        foot=pose[side+'-foot'][0];p=(phase+offset)%1
                        _,angle=walk.foot_target(layout,p)
                        minimum=min(foot[1]+walk.w_rotate_x(walk.w_mul(v,layout['s']),angle)[1] for v in walk._sole_pivots())
                        if p<.6:self.assertAlmostEqual(minimum,0,places=6)
                        self.assertGreaterEqual(minimum,-1e-7)

    def test_weights_and_determinism(self):
        import stylized_character as character
        self.assertTrue(hasattr(character,'landmarks'))
        import stylized_walk as walk
        layout=character.landmarks({});bones=walk.rest_bones(layout)
        for name,vertices in [('flight-jacket',[(0,1.3,0),(-.24,1.1,.04),(.25,1.3,0)]),('trousers',[(-.1,.8,0),(.1,.45,0)]),('left-boot',[(-.1,0,.2)]),('face',[(0,1.7,0)])]:
            rows=walk.skin_weights(name,vertices,layout)
            self.assertEqual(rows,walk.skin_weights(name,vertices,layout))
            for row in rows:
                self.assertAlmostEqual(sum(row.values()),1)
                self.assertTrue(1<=len(row)<=4)
                self.assertTrue(all(n in bones and 0<w<=1 for n,w in row.items()))
        self.assertEqual(walk.skin_weights('left-boot',[(-.1,0,.2)],layout),[{'left-foot':1}])
        # The hem follows the same pelvis as the belt and trouser yoke.
        self.assertEqual(walk.skin_weights('flight-jacket',[(.17,layout['hip_y']+.04,0)],layout),[{'pelvis':1}])

    def test_articulation_and_attached_torso(self):
        import stylized_character as character
        import stylized_walk as walk
        d=character.landmarks({});rest=walk.rest_bones(d)
        for gait in ['walk','jog']:
            bends=[]
            for i in range(100):
                phase=i/100;pose=walk.gait_pose(d,phase,gait);rotations=walk.gait_rotations(phase,gait)
                self.assertAlmostEqual(rotations['pelvis'][0],-rotations['spine'][0])
                for bone in ['pelvis','spine','head','left-thigh','right-thigh','left-upper-arm','right-upper-arm']:
                    parent=rest[bone]['parent']
                    expected=walk.w_add(pose[parent][0],walk._body_rotate(walk.w_sub(rest[bone]['head'],rest[parent]['head']),rotations[parent]))
                    self.assertLess(math.dist(expected,pose[bone][0]),1e-9)
                upper=walk.w_unit(walk.w_sub(pose['left-upper-arm'][1],pose['left-upper-arm'][0]))
                lower=walk.w_unit(walk.w_sub(pose['left-forearm'][1],pose['left-forearm'][0]))
                bends.append(math.acos(max(-1,min(1,walk.w_dot(upper,lower)))))
            self.assertGreater(max(bends)-min(bends),.1)
            if gait=='jog':self.assertGreater(min(bends),.8)

if __name__=='__main__':unittest.main()
