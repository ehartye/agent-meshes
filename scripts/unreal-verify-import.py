"""Headless Unreal import check for `agent-meshes verify-unreal`.

Run by UnrealEditor-Cmd's pythonscript commandlet. Reads a request JSON named by the
AGENT_MESHES_UNREAL_REQUEST environment variable ({glb, destination, report}),
imports the GLB through Interchange into `destination`, and writes a JSON report of
what Unreal created. The Node side parses the log for errors and warnings between
the AGENT_MESHES_IMPORT_BEGIN and AGENT_MESHES_IMPORT_END markers.
"""
import json
import math
import os
import re
import traceback

import unreal

COLLISION_FLAGS = {
    'default': 'CTF_USE_DEFAULT',
    'simple-and-complex': 'CTF_USE_SIMPLE_AND_COMPLEX',
    'simple-as-complex': 'CTF_USE_SIMPLE_AS_COMPLEX',
    'complex-as-simple': 'CTF_USE_COMPLEX_AS_SIMPLE',
}
INTERCHANGE_PROPERTIES = {
    'buildNanite': ('mesh_pipeline', 'build_nanite'),
    'useFullPrecisionUVs': ('common_meshes_properties', 'use_full_precision_u_vs'),
    'collision': ('mesh_pipeline', 'collision'),
    'importCollisionAccordingToMeshName': ('mesh_pipeline', 'import_collision_according_to_mesh_name'),
    'generateLightmapUVs': ('mesh_pipeline', 'generate_lightmap_u_vs'),
}


def collision_flag_name(value):
    """The stored UBodySetup enum; CTF_USE_DEFAULT is deliberately not project-resolved."""
    match = re.search(r'\bCTF_[A-Z_]+\b', str(value))
    if match is None or match.group(0) not in COLLISION_FLAGS.values():
        raise ValueError('Unreal returned an unsupported collision trace flag: ' + str(value))
    return match.group(0)


def validate_import_options(options):
    """Defend the Python request boundary as well as the public Node JSON parser."""
    def fail(message):
        raise ValueError('Invalid Unreal import options: ' + message)
    if not isinstance(options, dict) or set(options) - {'schema', 'interchange', 'postImport'}:
        fail('unsupported root fields or non-object')
    if type(options.get('schema')) is not int or options['schema'] != 1:
        fail('schema must be 1')
    count = 0
    for section, allowed in [('interchange', set(INTERCHANGE_PROPERTIES)), ('postImport', {'collisionTraceFlag', 'doubleSidedGeometry'})]:
        if section not in options:
            continue
        values = options[section]
        if not isinstance(values, dict) or set(values) - allowed:
            fail('unsupported ' + section + ' fields or non-object')
        for key, value in values.items():
            count += 1
            if key == 'collisionTraceFlag':
                if not isinstance(value, str) or value not in COLLISION_FLAGS:
                    fail('unsupported collisionTraceFlag')
            elif type(value) is not bool:
                fail(section + '.' + key + ' must be a boolean')
    if count == 0:
        fail('declare at least one supported setting')


def configure_import(parameters, options, destination):
    """Duplicate the engine's glTF defaults into scratch; preserve the glTF-specific second stage.

    UE5.8 BaseEngine.ini chooses DefaultGLTFAssetsPipeline + DefaultGLTFPipeline.
    OverridePipelines replaces that whole stack, so supplying only a bare generic
    pipeline would silently lose the glTF extension/material stage. Never modify the
    loaded engine pipeline asset itself. Its scratch duplicate is deleted with Verify.
    """
    validate_import_options(options)
    values = options.get('interchange', {})
    if not values:
        return {}, []
    base = '/Interchange/Pipelines/DefaultGLTFAssetsPipeline.DefaultGLTFAssetsPipeline'
    gltf = '/Interchange/Pipelines/DefaultGLTFPipeline.DefaultGLTFPipeline'
    source_pipeline = unreal.load_asset(base)
    if source_pipeline is None:
        raise RuntimeError('Cannot load the engine DefaultGLTFAssetsPipeline')
    # A commandlet's registry may not have scanned plugin content yet; use the
    # loaded-object variant rather than its AssetData/path-based counterpart.
    pipeline = unreal.EditorAssetLibrary.duplicate_loaded_asset(source_pipeline, destination + '/__VerifyOptions/Interchange')
    if pipeline is None:
        raise RuntimeError('Cannot duplicate the engine DefaultGLTFAssetsPipeline into the scratch project')
    gltf_pipeline = unreal.load_asset(gltf)
    if gltf_pipeline is None:
        raise RuntimeError('Cannot load the engine DefaultGLTFPipeline; import options will not fall back to a different pipeline')
    applied = {}
    for key, value in values.items():
        owner_key, property_key = INTERCHANGE_PROPERTIES[key]
        owner = pipeline.get_editor_property(owner_key)
        if owner is None:
            raise RuntimeError('Unsupported Interchange property owner: ' + owner_key)
        owner.set_editor_property(property_key, value)
        actual = owner.get_editor_property(property_key)
        if type(actual) is not bool or actual != value:
            raise RuntimeError('Interchange property readback differs for ' + key + ' (' + property_key + ')')
        applied[key] = actual
    paths = [pipeline.get_path_name(), gltf]
    parameters.set_editor_property('override_pipelines', [unreal.SoftObjectPath(path) for path in paths])
    if len(parameters.get_editor_property('override_pipelines')) != 2:
        raise RuntimeError('Interchange did not retain the two configured glTF pipeline overrides')
    return {'interchange': applied, 'pipelines': [base, gltf]}, [pipeline, gltf_pipeline]


def apply_static_import_options(mesh, settings):
    """Apply explicit BodySetup settings after import, before facts. No runtime physics claim."""
    body = mesh.get_editor_property('body_setup')
    if body is None:
        raise RuntimeError('Requested post-import settings, but StaticMesh has no BodySetup: ' + mesh.get_path_name())
    applied = {}
    for key, value in settings.items():
        if key == 'collisionTraceFlag':
            body.set_editor_property('collision_trace_flag', getattr(unreal.CollisionTraceFlag, COLLISION_FLAGS[value]))
            actual = collision_flag_name(body.get_editor_property('collision_trace_flag'))
            if actual != COLLISION_FLAGS[value]:
                raise RuntimeError('BodySetup collision_trace_flag readback differs for ' + mesh.get_path_name())
            applied[key] = value
        elif key == 'doubleSidedGeometry':
            body.set_editor_property('double_sided_geometry', value)
            actual = body.get_editor_property('double_sided_geometry')
            if type(actual) is not bool or actual != value:
                raise RuntimeError('BodySetup double_sided_geometry readback differs for ' + mesh.get_path_name())
            applied[key] = actual
        else:
            raise ValueError('Unsupported post-import setting: ' + key)
    return applied


def asset_class(obj):
    return obj.get_class().get_name()


def bone_parents(mesh):
    """Each bone of the mesh's reference skeleton mapped to its parent bone (None for the root).

    USkinnedMeshComponent::GetParentBone (SkinnedMeshComponent.cpp, UE 5.7) reads the skinned
    asset's reference skeleton, so a transient, unregistered component is enough.
    """
    component = unreal.new_object(unreal.SkeletalMeshComponent)
    component.set_skeletal_mesh_asset(mesh)
    parents = {}
    for index in range(component.get_num_bones()):
        name = component.get_bone_name(index)
        parent = component.get_parent_bone(name)
        parents[str(name)] = None if parent is None or str(parent) == 'None' else str(parent)
    return parents


def skeletal_mesh_facts(mesh):
    facts = {'path': mesh.get_path_name().split('.')[0], 'morphTargets': [str(n) for n in mesh.get_all_morph_target_names()]}
    skeleton = mesh.get_editor_property('skeleton')
    facts['skeleton'] = skeleton.get_path_name().split('.')[0] if skeleton else None
    # UAnimPoseExtensions::GetReferencePose / GetBoneNames (AnimationBlueprintLibrary AnimPose.h, UE 5.7):
    # the skeleton's reference pose lists every bone in reference-skeleton order.
    facts['bones'] = [str(n) for n in unreal.AnimPoseExtensions.get_bone_names(unreal.AnimPoseExtensions.get_reference_pose(skeleton))] if skeleton else []
    try:
        facts['boneParents'] = bone_parents(mesh)
    except Exception:
        facts['boneParentsError'] = traceback.format_exc()
    subsystem = unreal.get_editor_subsystem(unreal.SkeletalMeshEditorSubsystem)
    lods = subsystem.get_lod_count(mesh)
    facts['lods'] = lods
    facts['vertices'] = [subsystem.get_num_verts(mesh, lod) for lod in range(lods)]
    facts['materialSlots'] = len(mesh.get_editor_property('materials'))
    # USkeletalMesh::bHasVertexColors: the import kept the GLB's COLOR_0 (skin paint).
    value = getattr(mesh, 'has_vertex_colors', None)
    facts['hasVertexColors'] = bool(value() if callable(value) else value) if value is not None else None
    facts['materials'] = [material_facts(slot.get_editor_property('material_interface')) for slot in mesh.get_editor_property('materials')]
    return facts


def effective_surface(material):
    """The blend mode and two-sidedness a material renders with: the first instance in the parent chain that
    overrides them (MaterialInstanceBasePropertyOverrides), else the base UMaterial's own settings. Interchange
    makes glTF glass (alphaMode BLEND) an instance of MI_Default_Blend, whose override is BLEND_TRANSLUCENT."""
    blend = two_sided = None
    current = material
    for _ in range(16):
        if current is None: break
        if isinstance(current, unreal.MaterialInstance):
            overrides = current.get_editor_property('base_property_overrides')
            if blend is None and overrides.get_editor_property('override_blend_mode'):
                blend = overrides.get_editor_property('blend_mode')
            if two_sided is None and overrides.get_editor_property('override_two_sided'):
                two_sided = overrides.get_editor_property('two_sided')
            current = current.get_editor_property('parent')
            continue
        if blend is None: blend = current.get_editor_property('blend_mode')
        if two_sided is None: two_sided = current.get_editor_property('two_sided')
        break
    # unreal enums print as '<BlendMode.BLEND_TRANSLUCENT: 2>'.
    name = None if blend is None else (re.search(r'BLEND_[A-Z_]+', str(blend)) or re.search(r'\w+', str(blend))).group(0)
    return {'blendMode': name, 'twoSided': None if two_sided is None else bool(two_sided)}


def material_facts(material):
    """A material slot's material, the base material it instances (Interchange's glTF M_Default multiplies the
    base color by the mesh's vertex colors, COLOR_0, through its MF_BaseColor function), and its effective blend
    mode and two-sidedness (glass must import translucent)."""
    if material is None: return None
    facts = {'name': material.get_name()}
    try:
        facts['base'] = material.get_base_material().get_path_name().split('.')[0]
    except Exception:
        facts['error'] = traceback.format_exc()
    try:
        facts.update(effective_surface(material))
    except Exception:
        facts['surfaceError'] = traceback.format_exc()
    return facts


def static_mesh_facts(mesh):
    lods = mesh.get_num_lods()
    facts = {'path': mesh.get_path_name().split('.')[0], 'lods': lods, 'vertices': [mesh.get_num_vertices(lod) for lod in range(lods)]}
    # These are render-resource (fallback for Nanite) triangles, not source/Nanite cluster counts.
    # UE5.8: UStaticMesh::GetNumTriangles / GetBoundingBox; StaticMeshEditorSubsystem
    # GetNaniteSettings / GetLodBuildSettings. Keep unknown distinct from false/zero.
    errors = {}
    def measure(key, operation):
        try:
            return operation()
        except Exception as exc:
            errors[key] = type(exc).__name__ + ': ' + str(exc)
            return None
    def nonnegative(value):
        if value < 0:
            raise ValueError('Unreal returned an unavailable negative measurement')
        return int(value)
    def setting(value):
        if not isinstance(value, bool):
            raise ValueError('Unreal did not return a boolean build setting')
        return value
    def body_property(key):
        body = mesh.get_editor_property('body_setup')
        if body is None:
            raise RuntimeError('StaticMesh BodySetup unavailable')
        return body.get_editor_property(key)
    def vector(value):
        result = [float(value.x), float(value.y), float(value.z)]
        if not all(math.isfinite(component) for component in result):
            raise ValueError('Unreal returned non-finite bounds')
        return result
    def bounds():
        box = mesh.get_bounding_box()
        low, high = vector(box.min), vector(box.max)
        return {'space': 'asset-local', 'includesBoundsExtensions': True,
                'min': low, 'max': high,
                'center': [(a + b) / 2 for a, b in zip(low, high)],
                'size': [b - a for a, b in zip(low, high)]}
    facts['triangles'] = [measure('triangles[' + str(lod) + ']', lambda lod=lod: nonnegative(mesh.get_num_triangles(lod))) for lod in range(lods)]
    facts['naniteTriangles'] = measure('naniteTriangles', lambda: nonnegative(mesh.get_num_nanite_triangles()))
    facts['boundsCm'] = measure('boundsCm', bounds)
    facts['collisionTraceFlag'] = measure('collisionTraceFlag', lambda: collision_flag_name(body_property('collision_trace_flag')))
    facts['doubleSidedGeometry'] = measure('doubleSidedGeometry', lambda: setting(body_property('double_sided_geometry')))
    # PythonScriptCommandlet does not instantiate every editor subsystem. These getters
    # are asset queries with no initialized subsystem state (UE5.8 source); use a
    # class-default query object there. These calls never modify the default object.
    def query_subsystem():
        query = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
        if query is None:
            query = unreal.get_default_object(unreal.StaticMeshEditorSubsystem)
        if query is None:
            raise RuntimeError('StaticMeshEditorSubsystem lookup returned no query object')
        return query
    subsystem = measure('staticMeshEditorSubsystem', query_subsystem)
    if subsystem is None:
        # Optional inspection APIs can be absent without losing geometry already read.
        reason = errors['staticMeshEditorSubsystem']
        facts['naniteEnabled'] = None
        errors['naniteEnabled'] = reason
        facts['fullPrecisionUVs'] = [None for _ in range(lods)]
        for lod in range(lods):
            errors['fullPrecisionUVs[' + str(lod) + ']'] = reason
    else:
        facts['naniteEnabled'] = measure('naniteEnabled', lambda: setting(subsystem.get_nanite_settings(mesh).get_editor_property('enabled')))
        facts['fullPrecisionUVs'] = [measure('fullPrecisionUVs[' + str(lod) + ']', lambda lod=lod: setting(subsystem.get_lod_build_settings(mesh, lod).get_editor_property('use_full_precision_u_vs'))) for lod in range(lods)]
    if errors:
        facts['measurementErrors'] = errors
    try:
        facts['materials'] = [material_facts(slot.get_editor_property('material_interface')) for slot in mesh.get_editor_property('static_materials')]
    except Exception:
        facts['materialsError'] = traceback.format_exc()
    return facts


def main():
    with open(os.environ['AGENT_MESHES_UNREAL_REQUEST'], encoding='utf-8') as handle:
        request = json.load(handle)
    destination = request['destination']
    report = {'ok': False, 'engineVersion': unreal.SystemLibrary.get_engine_version(), 'destination': destination,
              'importReturned': False, 'assets': [], 'skeletalMeshes': [], 'staticMeshes': []}
    unreal.log('AGENT_MESHES_IMPORT_BEGIN')
    try:
        if unreal.EditorAssetLibrary.does_directory_exist(destination):
            unreal.EditorAssetLibrary.delete_directory(destination)
        manager = unreal.InterchangeManager.get_interchange_manager_scripted()
        source = unreal.InterchangeManager.create_source_data(request['glb'])
        parameters = unreal.ImportAssetParameters()
        parameters.is_automated = True
        options = request.get('importOptions')
        # Retain strong references until synchronous import_asset returns; its soft
        # paths must still resolve when Interchange duplicates the override stack.
        pipeline_references = []
        if options is not None:
            report['importConfiguration'] = {'requested': options, 'applied': {}}
            applied, pipeline_references = configure_import(parameters, options, destination)
            report['importConfiguration']['applied'] = applied
        report['importReturned'] = bool(manager.import_asset(destination, source, parameters))
        for path in unreal.EditorAssetLibrary.list_assets(destination, recursive=True, include_folder=False):
            if path.startswith(destination + '/__VerifyOptions/'):
                continue
            obj = unreal.EditorAssetLibrary.load_asset(path)
            if obj is None:
                continue
            report['assets'].append({'path': path.split('.')[0], 'class': asset_class(obj)})
            if isinstance(obj, unreal.SkeletalMesh):
                report['skeletalMeshes'].append(skeletal_mesh_facts(obj))
            elif isinstance(obj, unreal.StaticMesh):
                if options is not None and options.get('postImport'):
                    applied = apply_static_import_options(obj, options['postImport'])
                    report['importConfiguration']['applied'].setdefault('postImport', []).append({'mesh': obj.get_path_name().split('.')[0], 'settings': applied})
                report['staticMeshes'].append(static_mesh_facts(obj))
        if options is not None and options.get('postImport') and not report['staticMeshes']:
            raise RuntimeError('Requested post-import StaticMesh settings, but Interchange created no StaticMesh')
        report['ok'] = True
    except Exception:
        report['error'] = traceback.format_exc()
        unreal.log_error('agent-meshes verify-unreal script failed: ' + report['error'])
    unreal.log('AGENT_MESHES_IMPORT_END')
    with open(request['report'], 'w', encoding='utf-8') as handle:
        json.dump(report, handle, indent=1)


if __name__ == '__main__':
    main()
