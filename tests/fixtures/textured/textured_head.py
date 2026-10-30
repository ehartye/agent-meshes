"""Real-Blender fixture: a head with an embedded image texture, optionally inside an enclosing bubble.

ENCLOSES is None for a GLB that declares no enclosure, and TEXTURED False leaves the head untextured. The build
test rewrites those two lines. The texture is a tiny generated PNG that image_material packs into the exported GLB.
"""
import json
import math
import tempfile
from pathlib import Path

import bpy
from agent_meshes_author import image_material, make_mesh, material

ENCLOSES = None
TEXTURED = True


def sphere(name, radius, center, mat, rings=12, segments=16):
    vertices = [(center[0], center[1], center[2] - radius)]
    for i in range(1, rings):
        a = -math.pi / 2 + math.pi * i / rings
        for j in range(segments):
            t = math.tau * j / segments
            vertices.append((center[0] + radius * math.cos(a) * math.cos(t), center[1] + radius * math.cos(a) * math.sin(t), center[2] + radius * math.sin(a)))
    vertices.append((center[0], center[1], center[2] + radius))
    faces = [(0, 1 + (j + 1) % segments, 1 + j) for j in range(segments)]
    for i in range(rings - 2):
        for j in range(segments):
            a = 1 + i * segments + j; b = 1 + i * segments + (j + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    top = len(vertices) - 1; last = 1 + (rings - 2) * segments
    faces += [(last + j, last + (j + 1) % segments, top) for j in range(segments)]
    return make_mesh(name, vertices, faces, mat)


def png(directory, role, color):
    image = bpy.data.images.new('fixture ' + role, width=4, height=4)
    image.generated_color = color
    path = directory / (role + '.png')
    image.filepath_raw, image.file_format = str(path), 'PNG'
    image.save()
    bpy.data.images.remove(image)
    return path


def build():
    if TEXTURED:
        directory = Path(tempfile.mkdtemp(prefix='mesh-textured-'))
        paths = {role: png(directory, role, color) for role, color in
                 [('base_color', (.2, .4, .6, 1)), ('normal', (.5, .5, 1, 1)), ('roughness', (.6, .6, .6, 1))]}
        skin = image_material('skin', uv_layer='UVMap', normal_strength=1, **paths)
    else:
        skin = material('skin', '#c08060', roughness=.6)
    head = sphere('head', .1, (0, 0, 1.6), skin)
    layer = head.data.uv_layers.new(name='UVMap')
    for loop in head.data.loops:
        x, y, z = head.data.vertices[loop.vertex_index].co
        layer.data[loop.index].uv = (math.atan2(y, x) / math.tau + .5, (z - 1.5) / .2)
    objects = [head]
    if ENCLOSES is not None:
        bubble = sphere('bubble', .16, (0, 0, 1.6), material('bubble-glass', '#e8f6ff', roughness=.05, opacity=.2, ior=1.5), rings=16, segments=24)
        bubble['agent_meshes_extras'] = json.dumps({'encloses': ENCLOSES})
        objects.append(bubble)
    return objects
