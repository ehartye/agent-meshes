"""Merge selection and fixture-isolation controls; no Blender required."""
import ast
import io
import json
from pathlib import Path
import unittest
from geometry_test_scope import select_suite, MeshFixtures

class Selection(unittest.TestCase):
    def cases(self):
        class Existing(unittest.TestCase):
            def test_contract(self): pass
            def test_sweep(self): pass
            def test_new_regression(self): pass
        return unittest.defaultTestLoader.loadTestsFromTestCase(Existing)

    def test_full_retains_every_case_and_merge_defaults_new_cases_to_keep(self):
        tests=self.cases(); ids=[t.id() for t in tests]; sweep=next(i for i in ids if i.endswith('test_sweep'))
        full=select_suite(tests,{sweep:'matrix'},lane='full')
        self.assertEqual([t.id() for t in full],ids)
        merge=select_suite(self.cases(),{sweep:'matrix'},lane='merge')
        self.assertEqual([t.id() for t in merge],[i for i in ids if i!=sweep])

    def test_unknown_policy_or_lane_fails_instead_of_silently_losing_coverage(self):
        with self.assertRaisesRegex(ValueError,'unknown'):select_suite(self.cases(),{'missing':'matrix'},lane='merge')
        with self.assertRaisesRegex(ValueError,'lane'):select_suite(self.cases(),{},lane='typo')

    def test_manifest_names_real_test_methods(self):
        root=Path(__file__).parent
        for file,policy in json.loads((root/'geometry-sweeps.json').read_text()).items():
            tree=ast.parse((root/file).read_text())
            names={c.name+'.'+m.name for c in tree.body if isinstance(c,ast.ClassDef)
                   for m in c.body if isinstance(m,ast.FunctionDef) and m.name.startswith('test_')}
            self.assertFalse(set(policy)-names,file)
            self.assertTrue(all(reason.strip() for reason in policy.values()),file)

    def test_deferred_class_does_not_execute_expensive_setup(self):
        class Expensive(unittest.TestCase):
            @classmethod
            def setUpClass(cls):raise AssertionError('excluded preparation ran')
            def test_sweep(self):pass
        tests=unittest.defaultTestLoader.loadTestsFromTestCase(Expensive)
        ids={t.id():'matrix' for t in tests}
        selected=select_suite(tests,ids,lane='merge')
        result=unittest.TextTestRunner(stream=io.StringIO()).run(selected)
        self.assertTrue(result.wasSuccessful());self.assertEqual(result.testsRun,0)

class FixtureIsolation(unittest.TestCase):
    def test_preparation_is_reused_but_inputs_and_returned_meshes_are_isolated(self):
        built=[]
        def build(config):
            built.append(config['height']);config['producer_note']='local'
            return ([{'vertices':[[0,config['height'],0]]}],{'leg':[[config['height'],0]]})
        fixtures=MeshFixtures(build,capacity=2);config={'height':2}
        first,lofts=fixtures.get(config)
        self.assertEqual(config,{'height':2})
        first[0]['vertices'][0][1]=99;lofts['leg'][0][0]=99
        second,again=fixtures.get({'height':2})
        self.assertEqual(second[0]['vertices'],[[0,2,0]]);self.assertEqual(again,{'leg':[[2,0]]})
        self.assertEqual(built,[2])
        self.assertEqual(fixtures.get({'height':3})[0][0]['vertices'],[[0,3,0]])
        fixtures.get({'height':4});fixtures.get({'height':2})
        self.assertEqual(built,[2,3,4,2],'bounded eviction regenerates rather than retaining every mesh')

if __name__=='__main__':unittest.main()
