import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_sprout_kin import anatomy
from agent_meshes_sprout_rig import skin_regions

class RegionSources(unittest.TestCase):
    def test_garment_source_excludes_nearby_arms_and_tail(self):
        for age,height in [('adult',1.7),('child',1.12)]:
            selected=skin_regions(anatomy(age=age,height=height),['trunk','leg_l','leg_r'])
            self.assertEqual({p['name'] for p in selected},{'trunk','leg_l','leg_r'})
            self.assertTrue(all(p['vertices'] and p['faces'] for p in selected))
    def test_default_retains_body_skin_regions(self):
        names={p['name'] for p in skin_regions(anatomy())}
        self.assertTrue({'trunk','tail','bulb-head','arm_l','arm_r','leg_l','leg_r'}<=names)
        self.assertFalse(any(n.startswith(('eye_','crest-')) for n in names))
    def test_unknown_or_empty_selection_fails(self):
        for names in [[],['trunk','typo'],['eye_l'],'trunk']:
            with self.assertRaises(ValueError):skin_regions(anatomy(),names)
if __name__=='__main__':unittest.main()
