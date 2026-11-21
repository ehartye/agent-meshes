"""Read the Mixamo folder and its registry from a Blender source.

The folder holds the owner's Adobe Mixamo downloads. It can be any directory, such as a private repository cloned on
each of their machines (`AGENT_MESHES_MIXAMO_DIR`). The registry describing it lives in the managed home, and
`node scripts/mixamo-library.mjs` writes it. Nothing here copies a file: a build reads the FBX where it lies, and only
what the build makes from it (a GLB of the project's own character, baked frames) leaves the machine.

Each entry carries the fields of the `.json` sidecar beside its FBX (schema `agent-meshes/mixamo-asset/1`): `kind`
(`clip`, `clip-with-skin` or `character`), `title`, `tags`, `note`, `motion` (the hips' motion summary) and `preview`
(the GIF's file name). An FBX without a sidecar has its kind from the file, its title from the file name, no tags and
`motion` and `preview` of None.

`registry`, `entry` and `clip_path` rescan the folder through Node when its FBX files or their sidecars no longer match
the registry, for example after a pull. `mixamo_dir` and `registry_file` are pure Python. `import_fbx` needs Blender.
"""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

REGISTRY_SCHEMA = 'agent-meshes/mixamo-registry/3'
REGISTRY_FILE = 'mixamo-registry.json'
SCRIPT = Path(__file__).resolve().parent.parent / 'mixamo-library.mjs'


def _home(env):
    return Path(env['AGENT_MESHES_HOME']).resolve() if env.get('AGENT_MESHES_HOME') else Path.home() / '.agent-meshes'


def mixamo_dir(env=None):
    """AGENT_MESHES_MIXAMO_DIR, else `mixamo` in the managed home (AGENT_MESHES_HOME, else ~/.agent-meshes)."""
    env = os.environ if env is None else env
    if env.get('AGENT_MESHES_MIXAMO_DIR'): return Path(env['AGENT_MESHES_MIXAMO_DIR']).resolve()
    return _home(env) / 'mixamo'


def registry_file(env=None):
    """The registry in the managed home; it is never written inside the folder."""
    return _home(os.environ if env is None else env) / REGISTRY_FILE


def _fbx_files(directory, base=None):
    """{relative path: (bytes, mtime in ms)} of every FBX, skipping dot files and folders (`.git`, the dotted temporary
    names the Node writer uses) and node_modules, as the Node scan does."""
    base = directory if base is None else base
    found = {}
    with os.scandir(directory) as entries:
        for item in entries:
            if item.name.startswith('.'): continue
            if item.is_dir(follow_symlinks=False):
                if item.name != 'node_modules': found.update(_fbx_files(item.path, base))
            elif item.is_file(follow_symlinks=False) and item.name.lower().endswith('.fbx'):
                info = item.stat(follow_symlinks=False)
                found[Path(os.path.relpath(item.path, base)).as_posix()] = (info.st_size, info.st_mtime_ns // 1_000_000)
    return found


def _sidecar_of(file):
    """The sidecar beside an FBX: the same path with `.json` for the extension, as the Node scan names it."""
    return file[:-4] + '.json' if file.lower().endswith('.fbx') else file + '.json'


def _sidecar_files(directory, files):
    """{relative path: (bytes, mtime in ms)} of every sidecar beside one of these FBX files, as the Node scan records."""
    found = {}
    for file in files:
        path = Path(directory) / _sidecar_of(file)
        if path.is_file():
            info = path.stat()
            found[_sidecar_of(file)] = (info.st_size, info.st_mtime_ns // 1_000_000)
    return found


def _read(env):
    path = registry_file(env)
    if not path.is_file(): return None
    data = json.loads(path.read_text(encoding='utf8'))
    return data if data.get('schema') == REGISTRY_SCHEMA else None


def _describes(data, directory):
    if data is None or not Path(data.get('directory', '')).exists(): return False
    if not os.path.samefile(data['directory'], directory): return False
    listed = {item['file']: (item['bytes'], item['mtimeMs']) for item in data['entries'] + data['skipped']}
    files = _fbx_files(directory)
    if listed != files: return False
    sidecars = {item['file']: (item['bytes'], item['mtimeMs']) for item in data.get('sidecars', [])}
    return sidecars == _sidecar_files(directory, files)


def registry(directory=None, env=None):
    """The parsed registry of the folder, refreshed first when the folder has changed."""
    env = dict(os.environ if env is None else env)
    directory = mixamo_dir(env) if directory is None else Path(directory).resolve()
    if not directory.is_dir():
        raise FileNotFoundError(f'No Mixamo folder at {directory}: set AGENT_MESHES_MIXAMO_DIR, or add downloads with "node scripts/mixamo-library.mjs add <file>"')
    data = _read(env)
    if _describes(data, directory): return data
    node = shutil.which('node', path=env.get('PATH'))
    if not node: raise RuntimeError(f'The Mixamo folder changed and refreshing its registry needs Node: run "node {SCRIPT} refresh"')
    run = subprocess.run([node, str(SCRIPT), 'refresh'], env={**env, 'AGENT_MESHES_MIXAMO_DIR': str(directory)}, capture_output=True, text=True)
    if run.returncode != 0: raise RuntimeError(f'Refreshing the Mixamo registry failed: {run.stderr.strip()}')
    return _read(env)


def entry(name, directory=None, env=None):
    """One registry entry by id, with its sidecar fields (`kind`, `title`, `tags`, `note`, `motion`, `preview`)."""
    for item in registry(directory, env)['entries']:
        if item['id'] == name: return item
    raise KeyError(f'Unknown Mixamo entry: {name} (see "node scripts/mixamo-library.mjs list")')


def clip_path(name, directory=None, env=None):
    """The absolute path of one registered file, after checking its bytes still match the registry."""
    data = registry(directory, env)
    item = next((item for item in data['entries'] if item['id'] == name), None)
    if item is None: raise KeyError(f'Unknown Mixamo entry: {name} (see "node scripts/mixamo-library.mjs list")')
    path = (Path(data['directory']) / item['file']).resolve()
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
