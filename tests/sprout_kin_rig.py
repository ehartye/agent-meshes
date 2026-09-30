"""Species skeleton and source-region weights, independent of Blender."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_sprout_kin import anatomy, geometry
from agent_meshes_sprout_rig import skeleton, region_weights


class SproutRig(unittest.TestCase):
    def test_hierarchy_and_species_joints(self):
        for age in ['adult','child']:
            a=anatomy(age=age);bones=skeleton(a);seen=set()
            for name,b in bones.items():
                self.assertTrue(b['parent'] is None or b['parent'] in seen)
                self.assertGreater(np.linalg.norm(np.array(b['tail'])-b['head']),1e-5)
                seen.add(name)
            for s in ['l','r']:
                self.assertEqual(bones['metatarsal_'+s]['parent'],'shin_'+s)
                self.assertEqual(bones['toes_'+s]['parent'],'metatarsal_'+s)
                np.testing.assert_allclose(bones['metatarsal_'+s]['head'],a['joints']['hock_'+s])
                self.assertEqual(bones['eye_'+s.upper()]['parent'],'head')
                self.assertEqual(sum(n.startswith('finger_'+s) for n in bones),4)
            self.assertEqual(bones['tail_base']['parent'],'pelvis')
            self.assertEqual(bones['head']['parent'],'neck_upper')
            self.assertEqual(sum(n.startswith('crest_') for n in bones),2*a['crest_count'])
            self.assertFalse(set(bones)&{p['name'] for p in geometry(age=age)})

    def test_regions_cannot_pick_unrelated_limbs(self):
        a=anatomy();j=a['joints'];bones=skeleton(a)
        cases=[(j['head'],'bulb-head',{'head'}),
               (j['elbow_l'],'arm_l',{'clavicle_l','upperarm_l','forearm_l','hand_l'}),
               (j['hock_l'],'leg_l',{'pelvis','thigh_l','shin_l','metatarsal_l','toes_l'}),
               (j['tail_mid'],'tail',{'pelvis','tail_base','tail_tip'}),
               (j['neck_mid'],'neck',{'spine_high','neck_lower','neck_middle','neck_upper','head'})]
        for point,region,allowed in cases:
            w=region_weights(point,region,a)
            self.assertTrue(set(w)<=allowed,(region,w))
            self.assertAlmostEqual(sum(w.values()),1)
            self.assertTrue(all(n in bones and v>0 for n,v in w.items()))
        self.assertEqual(region_weights(j['head'],'bulb-head',a),{'head':1.0})
        with self.assertRaises(ValueError):region_weights([0,0,0],'missing',a)
        for point in [[0,0], [0,0,float('nan')], [0,float('inf'),0]]:
            with self.assertRaises(ValueError):region_weights(point,'bulb-head',a)

    def test_elbow_and_hock_blend_continuously_across_joint(self):
        a=anatomy();j=a['joints']
        for joint,region,first,second in [('elbow_l','arm_l','upperarm_l','forearm_l'),('hock_l','leg_l','shin_l','metatarsal_l')]:
            w=region_weights(j[joint],region,a)
            self.assertAlmostEqual(w[first],.5,places=6)
            self.assertAlmostEqual(w[second],.5,places=6)
            for offset in [-1e-5,1e-5]:
                p=np.array(j[joint])+[0,0,offset];q=region_weights(p,region,a)
                self.assertLess(abs(q.get(first,0)-w[first]),.001)


if __name__=='__main__':unittest.main()
