"""Mock contracts for unavailable vs valid false measurements; no Unreal required."""
import importlib.util
import pathlib
import sys
import types
import unittest

class Property:
    def __init__(self, **values): self.values=values
    def get_editor_property(self,key): return self.values[key]

class Subsystem:
    def get_nanite_settings(self,mesh): return Property(enabled=False)
    def get_lod_build_settings(self,mesh,lod): return Property(use_full_precision_u_vs=lod==1)

sys.modules['unreal']=types.SimpleNamespace(StaticMeshEditorSubsystem=object(),get_editor_subsystem=lambda _:Subsystem(),get_default_object=lambda _:Subsystem())
spec=importlib.util.spec_from_file_location('unreal_verify_import',pathlib.Path(__file__).parents[1]/'scripts/unreal-verify-import.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Mesh:
    def get_num_lods(self):return 2
    def get_num_vertices(self,lod):return [24,12][lod]
    def get_num_triangles(self,lod):return [12,6][lod]
    def get_num_nanite_triangles(self):return 0
    def get_path_name(self):return '/Game/Prop.Prop'
    def get_bounding_box(self):return types.SimpleNamespace(min=types.SimpleNamespace(x=-10,y=20,z=0),max=types.SimpleNamespace(x=10,y=60,z=80))
    def get_editor_property(self,key):return []

class Contracts(unittest.TestCase):
    def test_actual_false_and_full_size_not_extent(self):
        facts=module.static_mesh_facts(Mesh())
        self.assertEqual(facts['triangles'],[12,6]);self.assertIs(facts['naniteEnabled'],False)
        self.assertEqual(facts['fullPrecisionUVs'],[False,True]);self.assertEqual(facts['boundsCm']['size'],[20,40,80]);self.assertEqual(facts['boundsCm']['center'],[0,40,40]);self.assertNotIn('measurementErrors',facts)
    def test_commandlet_default_query_fallback(self):
        previous=module.unreal.get_editor_subsystem;module.unreal.get_editor_subsystem=lambda _:None
        try:facts=module.static_mesh_facts(Mesh())
        finally:module.unreal.get_editor_subsystem=previous
        self.assertIs(facts['naniteEnabled'],False);self.assertEqual(facts['fullPrecisionUVs'],[False,True])
    def test_unavailable_stays_null_with_reason(self):
        class Unsupported(Mesh):
            def get_num_triangles(self,lod):return -1
            def get_bounding_box(self):raise AttributeError('bounds API unavailable')
        class Missing(Subsystem):
            def get_nanite_settings(self,mesh):raise AttributeError('Nanite API unavailable')
            def get_lod_build_settings(self,mesh,lod):raise AttributeError('precision API unavailable')
        previous=module.unreal.get_editor_subsystem;module.unreal.get_editor_subsystem=lambda _:Missing()
        try:facts=module.static_mesh_facts(Unsupported())
        finally:module.unreal.get_editor_subsystem=previous
        self.assertEqual(facts['triangles'],[None,None]);self.assertIsNone(facts['boundsCm']);self.assertIsNone(facts['naniteEnabled']);self.assertEqual(facts['fullPrecisionUVs'],[None,None]);self.assertIn('bounds API unavailable',facts['measurementErrors']['boundsCm']);self.assertIn('negative',facts['measurementErrors']['triangles[0]'])

if __name__=='__main__':unittest.main()
