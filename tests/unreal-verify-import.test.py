"""Mock contracts for unavailable vs valid false measurements; no Unreal required."""
import importlib.util
import json
import os
import pathlib
import sys
import types
import unittest
import tempfile
from unittest.mock import patch

class Property:
    def __init__(self, **values): self.values=values
    def get_editor_property(self,key): return self.values[key]
    def set_editor_property(self,key,value):
        if key not in self.values:raise AttributeError('unsupported '+key)
        self.values[key]=value

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
    def get_editor_property(self,key):
        if key=='body_setup':return Property(collision_trace_flag='CTF_USE_DEFAULT',double_sided_geometry=False)
        return []

class Contracts(unittest.TestCase):
    def test_actual_false_and_full_size_not_extent(self):
        facts=module.static_mesh_facts(Mesh())
        self.assertEqual(facts['triangles'],[12,6]);self.assertIs(facts['naniteEnabled'],False)
        self.assertEqual(facts['fullPrecisionUVs'],[False,True]);self.assertEqual(facts['boundsCm']['size'],[20,40,80]);self.assertEqual(facts['boundsCm']['center'],[0,40,40]);self.assertNotIn('measurementErrors',facts)
        self.assertEqual(facts['collisionTraceFlag'],'CTF_USE_DEFAULT');self.assertIs(facts['doubleSidedGeometry'],False)
    def test_body_setup_unavailable_keeps_other_measurements(self):
        class Unsupported(Mesh):
            def get_editor_property(self,key):
                if key=='body_setup':return None
                return super().get_editor_property(key)
        facts=module.static_mesh_facts(Unsupported())
        self.assertEqual(facts['triangles'],[12,6]);self.assertIsNone(facts['collisionTraceFlag']);self.assertIsNone(facts['doubleSidedGeometry'])
        self.assertIn('BodySetup',facts['measurementErrors']['collisionTraceFlag'])
    def test_unknown_collision_enum_does_not_become_default(self):
        class Unsupported(Mesh):
            def get_editor_property(self,key):
                if key=='body_setup':return Property(collision_trace_flag='CTF_MAX',double_sided_geometry=False)
                return super().get_editor_property(key)
        facts=module.static_mesh_facts(Unsupported())
        self.assertIsNone(facts['collisionTraceFlag']);self.assertIs(facts['doubleSidedGeometry'],False)
    def test_commandlet_default_query_fallback(self):
        previous=module.unreal.get_editor_subsystem;module.unreal.get_editor_subsystem=lambda _:None
        try:facts=module.static_mesh_facts(Mesh())
        finally:module.unreal.get_editor_subsystem=previous
        self.assertIs(facts['naniteEnabled'],False);self.assertEqual(facts['fullPrecisionUVs'],[False,True])
    def assert_lookup_unavailable(self, unreal_api, reason):
        with patch.object(module, 'unreal', unreal_api):
            facts = module.static_mesh_facts(Mesh())
        self.assertEqual(facts['path'], '/Game/Prop')
        self.assertEqual(facts['vertices'], [24, 12])
        self.assertEqual(facts['triangles'], [12, 6])
        self.assertEqual(facts['naniteTriangles'], 0)
        self.assertEqual(facts['boundsCm']['size'], [20, 40, 80])
        self.assertIsNone(facts['naniteEnabled'])
        self.assertEqual(facts['fullPrecisionUVs'], [None, None])
        for key in ['naniteEnabled', 'fullPrecisionUVs[0]', 'fullPrecisionUVs[1]']:
            self.assertIn(reason, facts['measurementErrors'][key])
    def test_missing_subsystem_class_keeps_geometry(self):
        self.assert_lookup_unavailable(types.SimpleNamespace(get_editor_subsystem=lambda _:Subsystem()), 'StaticMeshEditorSubsystem')
    def test_subsystem_lookup_failure_keeps_geometry(self):
        def unavailable(_): raise RuntimeError('registered subsystem lookup failed')
        self.assert_lookup_unavailable(types.SimpleNamespace(StaticMeshEditorSubsystem=object(), get_editor_subsystem=unavailable), 'registered subsystem lookup failed')
    def test_default_object_lookup_failure_keeps_geometry(self):
        def unavailable(_): raise RuntimeError('default query object lookup failed')
        self.assert_lookup_unavailable(types.SimpleNamespace(StaticMeshEditorSubsystem=object(), get_editor_subsystem=lambda _:None, get_default_object=unavailable), 'default query object lookup failed')
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

class ImportOptionsContracts(unittest.TestCase):
    def api(self):
        common=Property(use_full_precision_u_vs=False)
        mesh_pipeline=Property(build_nanite=True,collision=True,import_collision_according_to_mesh_name=True,generate_lightmap_u_vs=False)
        pipeline=Property(mesh_pipeline=mesh_pipeline,common_meshes_properties=common)
        pipeline.get_path_name=lambda:'/Game/Verify/Prop/__VerifyOptions/Interchange.Interchange'
        library=types.SimpleNamespace(duplicate_loaded_asset=lambda source,destination:pipeline)
        api=types.SimpleNamespace(EditorAssetLibrary=library,load_asset=lambda path:object(),SoftObjectPath=lambda path:path,
            CollisionTraceFlag=types.SimpleNamespace(CTF_USE_DEFAULT='CTF_USE_DEFAULT',CTF_USE_SIMPLE_AND_COMPLEX='CTF_USE_SIMPLE_AND_COMPLEX',CTF_USE_SIMPLE_AS_COMPLEX='CTF_USE_SIMPLE_AS_COMPLEX',CTF_USE_COMPLEX_AS_SIMPLE='CTF_USE_COMPLEX_AS_SIMPLE'))
        return api,pipeline,mesh_pipeline,common
    def test_sets_and_reads_pipeline_options_before_import_and_preserves_gltf_specific_stage(self):
        api,pipeline,mesh_pipeline,common=self.api()
        params=Property(override_pipelines=[])
        with patch.object(module,'unreal',api):
            configured,keep_alive=module.configure_import(params,{'schema':1,'interchange':{'buildNanite':False,'useFullPrecisionUVs':True,'collision':False}},'/Game/Verify/Prop')
        self.assertIs(mesh_pipeline.values['build_nanite'],False);self.assertIs(mesh_pipeline.values['collision'],False);self.assertIs(common.values['use_full_precision_u_vs'],True)
        self.assertEqual(len(params.values['override_pipelines']),2)
        self.assertIn('DefaultGLTFPipeline',params.values['override_pipelines'][1]);self.assertEqual(configured['interchange'],{'buildNanite':False,'useFullPrecisionUVs':True,'collision':False})
        self.assertIn(pipeline,keep_alive)
    def test_missing_pipeline_property_fails_explicitly(self):
        api,pipeline,mesh_pipeline,common=self.api();del common.values['use_full_precision_u_vs']
        with patch.object(module,'unreal',api):
            with self.assertRaisesRegex(Exception,'use_full_precision_u_vs'):
                module.configure_import(Property(override_pipelines=[]),{'schema':1,'interchange':{'useFullPrecisionUVs':True}},'/Game/Verify/Prop')
    def test_postimport_body_settings_are_read_back_and_unavailable_is_fatal(self):
        api,*_=self.api()
        body=Property(collision_trace_flag='CTF_USE_DEFAULT',double_sided_geometry=False)
        class Imported(Mesh):
            def get_editor_property(self,key):return body if key=='body_setup' else super().get_editor_property(key)
        with patch.object(module,'unreal',api):
            applied=module.apply_static_import_options(Imported(),{'collisionTraceFlag':'complex-as-simple','doubleSidedGeometry':True})
        self.assertEqual(applied,{'collisionTraceFlag':'complex-as-simple','doubleSidedGeometry':True})
        self.assertEqual(body.values['collision_trace_flag'],'CTF_USE_COMPLEX_AS_SIMPLE');self.assertIs(body.values['double_sided_geometry'],True)
        del body.values['double_sided_geometry']
        with patch.object(module,'unreal',api):
            with self.assertRaisesRegex(Exception,'double_sided_geometry'):
                module.apply_static_import_options(Imported(),{'doubleSidedGeometry':True})
    def test_python_boundary_rejects_unknown_or_mistyped_fields(self):
        for options in [{'schema':1,'interchange':{'buildNanite':False,'typo':1}},{'schema':1,'postImport':{'doubleSidedGeometry':1}},{'schema':1}]:
            with self.assertRaisesRegex(ValueError,'import options'):module.validate_import_options(options)
    def run_main(self,options,static=True,break_property=False):
        api,pipeline,mesh_pipeline,common=self.api()
        if break_property:del mesh_pipeline.values['build_nanite']
        events=[];body=Property(collision_trace_flag='CTF_USE_DEFAULT',double_sided_geometry=False)
        class Imported(Mesh):
            def get_editor_property(self,key):return body if key=='body_setup' else super().get_editor_property(key)
            def get_class(self):return types.SimpleNamespace(get_name=lambda:'StaticMesh')
        mesh=Imported()
        params=Property(override_pipelines=[])
        def import_asset(destination,source,received):
            events.append('import')
            self.assertIs(received,params)
            if options.get('interchange'):
                self.assertEqual(len(params.values['override_pipelines']),2)
                if 'buildNanite' in options['interchange']:self.assertEqual(mesh_pipeline.values['build_nanite'],options['interchange']['buildNanite'])
                if 'useFullPrecisionUVs' in options['interchange']:self.assertEqual(common.values['use_full_precision_u_vs'],options['interchange']['useFullPrecisionUVs'])
            else:self.assertEqual(params.values['override_pipelines'],[])
            return True
        api.InterchangeManager=types.SimpleNamespace(get_interchange_manager_scripted=lambda:types.SimpleNamespace(import_asset=import_asset),create_source_data=lambda path:path)
        api.ImportAssetParameters=lambda:params
        api.EditorAssetLibrary.does_directory_exist=lambda path:False
        api.EditorAssetLibrary.list_assets=lambda *args,**kwargs:['/Game/Verify/Prop.Prop','/Game/Verify/Prop/__VerifyOptions/Interchange.Interchange'] if static else []
        api.EditorAssetLibrary.load_asset=lambda path:mesh
        api.StaticMesh=Imported;api.SkeletalMesh=type('SkeletalMesh',(),{})
        api.StaticMeshEditorSubsystem=object();api.get_editor_subsystem=lambda _:Subsystem()
        api.SystemLibrary=types.SimpleNamespace(get_engine_version=lambda:'test')
        api.log=lambda _:None;api.log_error=lambda _:None
        original_facts=module.static_mesh_facts
        def facts(obj):
            events.append('measure')
            for key,value in options.get('postImport',{}).items():
                if key=='doubleSidedGeometry':self.assertEqual(body.values['double_sided_geometry'],value)
                if key=='collisionTraceFlag':self.assertEqual(body.values['collision_trace_flag'],module.COLLISION_FLAGS[value])
            return original_facts(obj)
        with tempfile.TemporaryDirectory() as directory:
            request=pathlib.Path(directory)/'request.json';report=pathlib.Path(directory)/'report.json'
            request.write_text(json.dumps({'glb':'prop.glb','destination':'/Game/Verify/Prop','report':str(report),'importOptions':options}),encoding='utf-8')
            with patch.object(module,'unreal',api),patch.dict(os.environ,{'AGENT_MESHES_UNREAL_REQUEST':str(request)}),patch.object(module,'static_mesh_facts',facts):module.main()
            return json.loads(report.read_text()),events
    def test_main_importer_receives_configuration_then_body_settings_are_applied_before_measurement(self):
        options={'schema':1,'interchange':{'buildNanite':False,'useFullPrecisionUVs':True},'postImport':{'collisionTraceFlag':'complex-as-simple','doubleSidedGeometry':True}}
        report,events=self.run_main(options)
        self.assertIs(report['ok'],True);self.assertEqual(events,['import','measure'])
        self.assertEqual(report['importConfiguration']['requested'],options)
        self.assertEqual(len(report['assets']),1)
        self.assertEqual(report['staticMeshes'][0]['collisionTraceFlag'],'CTF_USE_COMPLEX_AS_SIMPLE')
        self.assertEqual(len(report['importConfiguration']['applied']['postImport']),1)
    def test_main_does_not_start_import_when_requested_property_is_unsupported(self):
        report,events=self.run_main({'schema':1,'interchange':{'buildNanite':False}},break_property=True)
        self.assertIs(report['ok'],False);self.assertIs(report['importReturned'],False);self.assertEqual(events,[])
        self.assertIn('build_nanite',report['error']);self.assertEqual(report['importConfiguration']['applied'],{})
    def test_main_fails_postimport_request_without_static_targets_and_keeps_default_import_stack(self):
        report,events=self.run_main({'schema':1,'postImport':{'doubleSidedGeometry':True}},static=False)
        self.assertIs(report['ok'],False);self.assertEqual(events,['import']);self.assertIn('no StaticMesh',report['error'])

if __name__=='__main__':unittest.main()
