"""Read the local Mixamo folder and its registry from a Blender source.

The folder holds Adobe Mixamo downloads on the machine that downloaded them; `node scripts/mixamo-library.mjs add`
fills it and writes `registry.json`. Nothing here copies a file: a build reads the FBX where it lies, and only what the
build makes from it (a GLB of the project's own character, baked frames) leaves the machine.

`mixamo_dir`, `registry`, `entry` and `clip_path` are pure Python. `import_fbx` needs Blender.
"""
import hashlib
import json
import os
from pathlib import Path

REGISTRY_SCHEMA = 'agent-meshes/mixamo-registry/1'
REGISTRY_FILE = 'registry.json'


def mixamo_dir(env=None):
    """AGENT_MESHES_MIXAMO_DIR, else `mixamo` in the managed home (AGENT_MESHES_HOME, else ~/.agent-meshes)."""
    env = os.environ if env is None else env
    if env.get('AGENT_MESHES_MIXAMO_DIR'): return Path(env['AGENT_MESHES_MIXAMO_DIR']).resolve()
    home = Path(env['AGENT_MESHES_HOME']).resolve() if env.get('AGENT_MESHES_HOME') else Path.home() / '.agent-meshes'
    return home / 'mixamo'


def registry(directory=None):
    """The parsed registry of the folder."""
    directory = mixamo_dir() if directory is None else Path(directory)
    path = directory / REGISTRY_FILE
    if not path.is_file():
        raise FileNotFoundError(f'No Mixamo registry in {directory}: add downloads with "node scripts/mixamo-library.mjs add <file>"')
    data = json.loads(path.read_text(encoding='utf8'))
    if data.get('schema') != REGISTRY_SCHEMA:
        raise ValueError(f'{path}: expected schema {REGISTRY_SCHEMA}; run "node scripts/mixamo-library.mjs scan"')
    return data


def entry(name, directory=None):
    """One registry entry by id."""
    for item in registry(directory)['entries']:
        if item['id'] == name: return item
    raise KeyError(f'Unknown Mixamo entry: {name} (see "node scripts/mixamo-library.mjs list")')


def clip_path(name, directory=None):
    """The absolute path of one registered file, after checking its bytes still match the registry."""
    directory = mixamo_dir() if directory is None else Path(directory)
    item = entry(name, directory)
    path = (directory / item['file']).resolve()
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
        raise ValueError(f"{item['file']} changed since it was registered; run \"node scripts/mixamo-library.mjs scan\"")
    return path


def import_fbx(name, directory=None):
    """Import one registered file into the open Blender scene: {'objects': [...], 'armature': obj or None, 'actions': [...]}.

    Objects and actions are Blender's own, as its FBX importer made them: the armature keeps the importer's scale and
    rotation, and bones keep the file's names (`mixamorig:Hips`). Files downloaded for one character share a rest pose,
    so an action imported from one file plays on the armature imported from another.
    """
    import bpy
    path = clip_path(name, directory)
    objects, actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=str(path))
    made = [obj for obj in bpy.data.objects if obj not in objects]
    return {'objects': made, 'armature': next((obj for obj in made if obj.type == 'ARMATURE'), None),
            'actions': [action for action in bpy.data.actions if action not in actions]}
