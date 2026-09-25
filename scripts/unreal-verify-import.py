"""Headless Unreal import check for `agent-meshes verify-unreal`.

Run by UnrealEditor-Cmd's pythonscript commandlet. Reads a request JSON named by the
AGENT_MESHES_UNREAL_REQUEST environment variable ({glb, destination, report}),
imports the GLB through Interchange into `destination`, and writes a JSON report of
what Unreal created. The Node side parses the log for errors and warnings between
the AGENT_MESHES_IMPORT_BEGIN and AGENT_MESHES_IMPORT_END markers.
"""
import json
import os
import traceback

import unreal


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


def material_facts(material):
    """A material slot's material and the base material it instances (Interchange's glTF M_Default multiplies the
    base color by the mesh's vertex colors, COLOR_0, through its MF_BaseColor function)."""
    if material is None: return None
    facts = {'name': material.get_name()}
    try:
        facts['base'] = material.get_base_material().get_path_name().split('.')[0]
    except Exception:
        facts['error'] = traceback.format_exc()
    return facts


def static_mesh_facts(mesh):
    lods = mesh.get_num_lods()
    return {'path': mesh.get_path_name().split('.')[0], 'lods': lods, 'vertices': [mesh.get_num_vertices(lod) for lod in range(lods)]}


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
        report['importReturned'] = bool(manager.import_asset(destination, source, parameters))
        for path in unreal.EditorAssetLibrary.list_assets(destination, recursive=True, include_folder=False):
            obj = unreal.EditorAssetLibrary.load_asset(path)
            if obj is None:
                continue
            report['assets'].append({'path': path.split('.')[0], 'class': asset_class(obj)})
            if isinstance(obj, unreal.SkeletalMesh):
                report['skeletalMeshes'].append(skeletal_mesh_facts(obj))
            elif isinstance(obj, unreal.StaticMesh):
                report['staticMeshes'].append(static_mesh_facts(obj))
        report['ok'] = True
    except Exception:
        report['error'] = traceback.format_exc()
        unreal.log_error('agent-meshes verify-unreal script failed: ' + report['error'])
    unreal.log('AGENT_MESHES_IMPORT_END')
    with open(request['report'], 'w', encoding='utf-8') as handle:
        json.dump(report, handle, indent=1)


main()
