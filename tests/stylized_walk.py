"""Shared gait geometry contracts; no Blender required."""
import math
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'recipes'))

class WalkContract(unittest.TestCase):
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
                        foot=pose[side+'-foot'][0]
                        if (phase+offset)%1<.6:self.assertAlmostEqual(foot[1],layout['s']*.14,places=6)
                        self.assertGreaterEqual(foot[1],layout['s']*.14-1e-7)

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
        # The wider shirt hem must not follow the swinging arms.
        self.assertEqual(walk.skin_weights('flight-jacket',[(.17,layout['hip_y']+.04,0)],layout),[{'spine':1}])

if __name__=='__main__':unittest.main()
