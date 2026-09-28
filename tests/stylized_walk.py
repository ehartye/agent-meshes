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
            self.assertEqual(len(namespace['jog_pose'](namespace['landmarks']({}),.1)),18)

    def test_foot_roll_internal_joins_are_smooth(self):
        import stylized_character as character
        import stylized_walk as walk
        # A C2 join leaves only jerk * eps between the one-sided second differences;
        # the fitted foot roll is brisk, so the step is fine enough to separate the two.
        d=character.landmarks({});eps=1e-6
        for gait in ['walk','jog']:
            settings=walk.gait_settings(gait);stance=settings['stance']
            for p in [stance*settings['heel_flat'],stance*settings['toe_from'],stance+(1-stance)*settings['peak_at'],stance+(1-stance)*settings['flat_at']]:
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
                # Acceleration is continuous too: the toe roll carries through toe-off. A
                # smooth join leaves jerk * h between the one-sided differences, so h is small.
                h=2e-6;f=lambda t:point(p+t)
                before=tuple((x-2*y+z)/h**2 for x,y,z in zip(f(-2*h),f(-h),f(0)))
                after=tuple((x-2*y+z)/h**2 for x,y,z in zip(f(0),f(h),f(2*h)))
                self.assertLess(math.dist(before,after),.05*max(1,math.hypot(*before)))

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
                        if p<walk.gait_settings('walk')['stance']:self.assertAlmostEqual(minimum,0,places=6)
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

    def test_every_vertex_keeps_one_to_four_influences(self):
        # glTF skins carry at most four joints per vertex. On a short torso the pelvis,
        # lumbar and chest blends overlap the elbow blend, so a jacket vertex can touch five.
        import stylized_character as character
        import stylized_walk as walk
        for values in [{},{'height':1.12,'age':'child','species':'alien'},{'height':1.19,'age':'child'},{'height':.7,'age':'child'}]:
            d=character.landmarks(values);s=d['s']
            grid=[(x*s,y*d['h'],0) for x in [-.3+.005*i for i in range(121)] for y in [.3+.0025*j for j in range(221)]]
            # A remeshed jacket vertex of the 1.12 m alien child that reached five joints.
            grid.append((-.14977,.60209,.03855))
            for name in ['flight-jacket','trousers','front-fastener','neck']:
                for row in walk.skin_weights(name,grid,d):
                    self.assertTrue(1<=len(row)<=4,(values,name,row))
                    self.assertAlmostEqual(sum(row.values()),1)

    def test_articulation_and_attached_torso(self):
        import stylized_character as character
        import stylized_walk as walk
        d=character.landmarks({});rest=walk.rest_bones(d)
        for gait in ['walk','jog']:
            bends=[]
            for i in range(100):
                phase=i/100;pose=walk.gait_pose(d,phase,gait);rotations=walk.gait_rotations(phase,gait)
                # The chest turns against the pelvis; the lumbar splits the difference.
                self.assertLessEqual(rotations['pelvis'][0]*rotations['chest'][0],0)
                self.assertAlmostEqual(rotations['spine'][0],(rotations['pelvis'][0]+rotations['chest'][0])/2)
                for bone in ['pelvis','spine','chest','neck','head','left-thigh','right-thigh','left-upper-arm','right-upper-arm']:
                    parent=rest[bone]['parent']
                    expected=walk.w_add(pose[parent][0],walk._body_rotate(walk.w_sub(rest[bone]['head'],rest[parent]['head']),rotations[parent]))
                    self.assertLess(math.dist(expected,pose[bone][0]),1e-9)
                upper=walk.w_unit(walk.w_sub(pose['left-upper-arm'][1],pose['left-upper-arm'][0]))
                lower=walk.w_unit(walk.w_sub(pose['left-forearm'][1],pose['left-forearm'][0]))
                bends.append(math.acos(max(-1,min(1,walk.w_dot(upper,lower)))))
            self.assertGreater(max(bends)-min(bends),.1)
            if gait=='jog':self.assertGreater(min(bends),.8)

class ClipFrames(unittest.TestCase):
    def test_clips_key_both_contacts_on_frames(self):
        import stylized_walk as walk
        # The rig-right foot lands half a cycle after the left: an even frame count keys
        # both touchdowns, so the mirrored legs are sampled alike. Ties round up.
        self.assertEqual([walk.clip_frames(t) for t in [.75,.9,1.1,1.35,1.2]],[46,54,66,82,72])
        self.assertEqual(walk.clip_frames(.75,30),22)

class Hands(unittest.TestCase):
    def test_declared_hand_frames_match_the_authored_hands(self):
        import stylized_character as character
        import stylized_walk as walk
        for values in [{},{'age':'child','height':1.1},{'vacuum':True}]:
            d=character.landmarks(values);parts={p['name']:p['vertices'] for p in character.geometry(values)}
            frames=walk.hand_frames(d)
            for side,label in [(-1,'left'),(1,'right')]:
                palm,thumb=frames[label+'-hand']['palm'],frames[label+'-hand']['thumb']
                # Palms face the thigh and thumbs point forward at rest.
                self.assertEqual(palm,(-side,0,0));self.assertEqual(thumb,(0,0,1))
                def centroid(points):return tuple(sum(v[k] for v in points)/len(points) for k in range(3))
                def extent(points,k):return max(v[k] for v in points)-min(v[k] for v in points)
                hand=parts[label+'-palm'];center=centroid(hand)
                # The palm is thin across the palm normal and broad front to back.
                self.assertLess(extent(hand,0),extent(hand,2)*.7)
                # The thumb sits forward of the palm, and toward the palm side.
                offset=walk.w_sub(centroid(parts[label+'-thumb']),center)
                self.assertGreater(walk.w_dot(offset,thumb),.02*d['s'])
                self.assertGreater(walk.w_dot(offset,palm),0)
                # Fingers stand in a row front to back, index forward, and curl toward the palm.
                knuckles=[parts[label+'-finger-'+str(i)][:12] for i in range(4)]
                tips=[parts[label+'-finger-'+str(i)][-12:] for i in range(4)]
                rows=[walk.w_dot(centroid(k),thumb) for k in knuckles]
                self.assertEqual(rows,sorted(rows,reverse=True))
                for knuckle,tip in zip(knuckles,tips):
                    self.assertGreater(walk.w_dot(walk.w_sub(centroid(tip),centroid(knuckle)),palm),.008*d['s'])

def _gait_measures(walk,d,gait,n=120):
    """Body measures as agent-meshes' gait command takes them from the exported bones."""
    settings=walk.gait_settings(gait);rows=[];deg=180/math.pi;scale=1.75/d['h']
    for i in range(n):
        phase=i/n;pose=walk.gait_pose(d,phase,gait);rot=walk.gait_rotations(phase,gait)
        hips=walk.w_sub(pose['right-thigh'][0],pose['left-thigh'][0]);shoulders=walk.w_sub(pose['right-upper-arm'][0],pose['left-upper-arm'][0])
        trunk=walk.w_sub(pose['neck'][0],pose['pelvis'][0])
        def pitch(name):u=walk._body_rotate((0,1,0),rot[name]);return math.atan2(u[2],u[1])*deg
        row=dict(head=pose['head'][0][1]*scale,roll=math.atan2(hips[1],hips[0])*deg,pelvis_yaw=math.atan2(-hips[2],hips[0])*deg,
                 shoulder_yaw=math.atan2(-shoulders[2],shoulders[0])*deg,lean=math.atan2(trunk[2],trunk[1])*deg,chest=pitch('chest'),head_pitch=pitch('head'))
        for side in ['left','right']:
            hip,knee,ankle=(pose[side+b][0] for b in ['-thigh','-shin','-foot'])
            a,b=walk.w_sub(knee,hip),walk.w_sub(ankle,knee)
            row[side+'_knee']=math.acos(max(-1,min(1,walk.w_dot(a,b)/math.hypot(*a)/math.hypot(*b))))*deg
            line=walk.w_sub(ankle,hip);off=walk.w_sub(a,walk.w_mul(line,walk.w_dot(a,line)/walk.w_dot(line,line)))
            row[side+'_forward_knee']=off[2]>=-1e-9
            arm=walk.w_sub(pose[side+'-forearm'][0],pose[side+'-upper-arm'][0])
            row[side+'_arm']=math.atan2(arm[2],-arm[1]);row[side+'_leg']=math.atan2(a[2],-a[1])
            row[side+'_planted']=(phase+(0 if side=='left' else .5))%1<settings['stance']
        rows.append(row)
    return rows

def _pearson(a,b):
    ma=sum(a)/len(a);mb=sum(b)/len(b)
    return sum((x-ma)*(y-mb) for x,y in zip(a,b))/math.sqrt(sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b))

class NaturalGait(unittest.TestCase):
    """The walk and jog meet the natural-gait ranges agent-meshes' gait checks apply to exported clips."""
    def test_body_moves_like_a_person_in_both_gaits(self):
        import stylized_character as character
        import stylized_walk as walk
        ranges={'walk':dict(bob=(.025,.06),lean=(3,8),counter=8),'jog':dict(bob=(.05,.10),lean=(8,15),counter=12)}
        for values in [{},{'height':1.22,'age':'child'},{'height':1.88,'presentation':'male'}]:
            d=character.landmarks(values)
            for gait,r in ranges.items():
                rows=_gait_measures(walk,d,gait);col=lambda k:[row[k] for row in rows]
                span=lambda k:max(col(k))-min(col(k))
                with self.subTest(values=values,gait=gait):
                    self.assertTrue(r['bob'][0]<=span('head')<=r['bob'][1],span('head'))
                    head=col('head');low=min(head);peaks=sum(1 for i in range(len(head)) if head[i]>head[i-1] and head[i]>=head[(i+1)%len(head)] and head[i]-low>.5*span('head'))
                    self.assertEqual(peaks,2)
                    self.assertTrue(.3<=span('head_pitch')/span('chest')<=.7)
                    lean=sum(col('lean'))/len(rows);self.assertTrue(r['lean'][0]<=lean<=r['lean'][1],lean)
                    relative=[a-b for a,b in zip(col('shoulder_yaw'),col('pelvis_yaw'))]
                    self.assertGreaterEqual(max(relative)-min(relative),r['counter'])
                    self.assertLess(_pearson(col('shoulder_yaw'),col('pelvis_yaw')),0)
                    # Swing-side hip drops in single support: the +X hip is low while only the -X foot is down.
                    left_only=[row['roll'] for row in rows if row['left_planted'] and not row['right_planted']]
                    right_only=[-row['roll'] for row in rows if row['right_planted'] and not row['left_planted']]
                    for drops in [left_only,right_only]:self.assertTrue(3<=max(-v for v in drops)<=7,drops)
                    for side in ['left','right']:
                        self.assertTrue(all(col(side+'_forward_knee')),'knee bends backward')
                        self.assertLess(_pearson(col(side+'_arm'),col(side+'_leg')),-.5)
                    both_up=any(not row['left_planted'] and not row['right_planted'] for row in rows)
                    self.assertEqual(both_up,gait=='jog')

    def test_walk_strides_out(self):
        import stylized_character as character
        import stylized_walk as walk
        # A person covers about 1.5 leg lengths (hip to ankle) per walk cycle: Walk_Loop's
        # stride is 0.72 x height. A shorter stride with the same knee curve is a shuffle.
        for values in [{},{'height':1.22,'age':'child'}]:
            d=character.landmarks(values);length=walk.leg_length(d);s=walk.gait_settings('walk')
            stride=length*s['stride']/s['stance']
            self.assertGreaterEqual(stride/length,1.55,values)
            self.assertAlmostEqual(walk.travel_speed(d,'walk',1.0)*1.0,stride)
        self.assertGreaterEqual(walk.leg_length(character.landmarks({}))*1.55/1.82,.62)

    def test_grounded_sole_moves_with_the_ground(self):
        import stylized_character as character
        import stylized_walk as walk
        # Every outsole or boot vertex within 1 mm of the floor on two frames in a row
        # moves at travel speed: no heel graze before touchdown, no toe slip at liftoff.
        for values,seconds in [({},{'walk':1.05,'jog':.75}),({'height':1.22,'age':'child'},{'walk':.9,'jog':.65})]:
            d=character.landmarks(values);rest=walk.rest_bones(d)
            parts={p['name']:p['vertices'] for p in character.geometry(values)}
            sole=[walk.w_sub(v,rest['left-foot']['head']) for n,vs in parts.items() if n.startswith('left-') and any(t in n for t in ['boot','outsole','ankle']) for v in vs]
            for gait,duration in seconds.items():
                frames=walk.clip_frames(duration);dt=duration/frames;speed=walk.travel_speed(d,gait,frames/60)
                def posed(phase):
                    a,b=walk.gait_pose(d,phase,gait)['left-foot'];u=walk.w_sub(b,a)
                    angle=math.atan2(u[2],u[1])-math.atan2(.20,-.08)
                    return [walk.w_add(a,walk.w_rotate_x(v,angle)) for v in sole]
                shots=[posed(k/frames) for k in range(frames+1)];worst=0
                for k in range(frames):
                    for p,q in zip(shots[k],shots[k+1]):
                        if p[1]<.001 and q[1]<.001:worst=max(worst,math.hypot((q[2]-p[2])/dt+speed,(q[0]-p[0])/dt)/speed)
                with self.subTest(values=values,gait=gait):self.assertLessEqual(worst,.1)

    def test_walk_straightens_the_stance_knee(self):
        import stylized_character as character
        import stylized_walk as walk
        # Mid-stance knee is nearly straight; Walk_Loop's never bends less than 17 degrees.
        rows=_gait_measures(walk,character.landmarks({}),'walk')
        self.assertLess(min(row['left_knee'] for row in rows if row['left_planted']),15)

if __name__=='__main__':unittest.main()
