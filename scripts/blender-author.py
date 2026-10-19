"""Run a trusted build() source and export its returned objects as a GLB.

blender -b --python-exit-code 1 --python scripts/blender-author.py -- source.py model.glb
"""
import json
import os
from pathlib import Path
import runpy
import sys
import traceback

sys.dont_write_bytecode = True

import bpy


def report(path, value):
    """Readers never see a half-written sentinel, including through the Store launcher."""
    temporary = str(path) + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def main(source, output):
    sys.path[:0] = [str(source.parent), str(Path(__file__).resolve().parent / 'blender_lib')]
    from agent_meshes_read_audit import ReadAudit
    audit = ReadAudit(runtime_roots=[str(Path(bpy.app.binary_path).resolve().parent), sys.base_prefix],
                      ignored_roots=[str(output)] + ([sys.pycache_prefix] if sys.pycache_prefix else []))
    from agent_meshes_author import export_glb

    bpy.ops.wm.read_factory_settings(use_empty=True)
    namespace = runpy.run_path(str(source), run_name='__agent_meshes_asset__')
    build = namespace.get('build')
    if not callable(build):
        raise ValueError('Authoring source must define build() returning a list of bpy objects')
    objects = build()
    if not isinstance(objects, list) or not objects or any(not isinstance(obj, bpy.types.Object) for obj in objects):
        raise ValueError('build() must return a nonempty list of bpy objects')
    meshes = sum(obj.type == 'MESH' for obj in objects)
    if not meshes:
        raise ValueError('build() must return at least one mesh')
    export_options = {}
    for source_name, option in [('EXPORT_VERTEX_COLOR', 'vertex_color'),
                                ('EXPORT_ALL_VERTEX_COLORS', 'all_vertex_colors')]:
        if source_name in namespace:
            export_options[option] = namespace[source_name]
    export_glb(str(output), objects, animation_mode=namespace.get('EXPORT_ANIMATION_MODE', 'ACTIONS'),
               **export_options)
    return meshes, audit.finish()


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    if len(argv) != 2:
        raise ValueError('Expected source.py and output.glb arguments')
    source, output = map(lambda value: Path(value).resolve(), argv)
    report(str(output) + '.pid', {'pid': os.getpid()})
    try:
        meshes, audit = main(source, output)
        report(str(output) + '.done', {'ok': True, 'meshes': meshes, 'blender': bpy.app.version_string, 'readAudit': audit})
    except BaseException:
        report(str(output) + '.done', {'ok': False, 'error': traceback.format_exc()})
        raise
