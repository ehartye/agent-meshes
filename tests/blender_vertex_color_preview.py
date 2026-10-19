"""Measure actual Workbench PNGs, including a GLB reimport, not just shading settings."""
import argparse
import json
from pathlib import Path
import runpy
import sys

import bpy

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
out = parser.parse_args(sys.argv[sys.argv.index('--') + 1:]).output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
run_job = runpy.run_path(str(ROOT / 'scripts/blender-preview.py'))['run_job']

SOURCE = '''import bpy
def build():
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = 'Painted cube'
    attrs = obj.data.color_attributes
    unused = attrs.new(name='RenderRed', type='FLOAT_COLOR', domain=DOMAIN)
    for item in unused.data: item.color = (.7, .04, .05, 1)
    paint = attrs.new(name='ActiveGreen', type='FLOAT_COLOR', domain=DOMAIN)
    for item in paint.data: item.color = (.04, .7, .08, .12)
    attrs.active_color_index = 1
    attrs.render_color_index = 0
    material = bpy.data.materials.new('Gray material')
    material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (.3, .3, .3, 1)
    obj.data.materials.append(material)
    return [obj]
'''


def center_pixel(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        width, height = image.size
        index = ((height // 2) * width + width // 2) * 4
        return list(image.pixels[index:index + 4])
    finally:
        bpy.data.images.remove(image)


def green(pixel):
    return pixel[1] - max(pixel[0], pixel[2]) > .2


proof = {'ok': False, 'blender': bpy.app.version_string, 'cases': {}}
for domain in ('POINT', 'CORNER'):
    case = out / domain.lower()
    case.mkdir()
    script = case / 'asset.py'
    script.write_text(SOURCE.replace('DOMAIN', repr(domain)), encoding='utf8')
    manifest = run_job({'source': str(script), 'outDir': str(case / 'source'), 'views': ['body-front'],
                        'shadings': ['vertex', 'color'], 'size': 128, 'sheet': True})
    vertex = center_pixel(case / 'source/rest-body-front-vertex.png')
    material = center_pixel(case / 'source/rest-body-front-color.png')
    assert green(vertex), vertex
    assert max(material[:3]) - min(material[:3]) < .03, material
    obj = bpy.data.objects['Painted cube']
    attrs = obj.data.color_attributes
    assert [a.name for a in attrs] == ['RenderRed', 'ActiveGreen']
    assert attrs.active_color_index == 1 and attrs.render_color_index == 0
    shader = next(n for n in obj.data.materials[0].node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    assert all(abs(a - b) < 1e-6 for a, b in zip(shader.inputs['Base Color'].default_value, (.3, .3, .3, 1)))
    assert not shader.inputs['Base Color'].is_linked
    # ACTIVE export follows the render selection. Align explicitly, outside preview.
    attrs.render_color_index = attrs.active_color_index
    from agent_meshes_author import export_glb
    glb = case / 'model.glb'
    export_glb(str(glb), [obj], vertex_color='ACTIVE', all_vertex_colors=False)
    run_job({'source': str(glb), 'outDir': str(case / 'exported'), 'views': ['body-front'],
             'shadings': ['vertex'], 'size': 128})
    exported = center_pixel(case / 'exported/rest-body-front-vertex.png')
    assert green(exported), exported
    proof['cases'][domain] = {'sourceGreen': True, 'exportedGreen': True, 'vertexPixel': vertex,
                              'materialPixel': material, 'exportedPixel': exported, 'files': manifest['files']}
proof['ok'] = True
(out / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf8')
print('VERTEX_COLOR_PREVIEW_RESULT ' + json.dumps(proof))
