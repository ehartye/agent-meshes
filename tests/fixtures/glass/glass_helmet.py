"""Real-Blender fixture: a head inside a clear, double-sided glass bubble, skinned to one bone.

build() returns the objects for the build runner to export. The bubble uses material(opacity=...),
the lens material(transmission=..., ior=...); tests check the GLB's alphaMode, extensions and
Unreal's translucent import.
"""
import bpy
from agent_meshes_author import bind_skin, make_mesh, material


def sphere(name, radius, center, mat, rings=16, segments=24):
    import math
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


def build():
    skin = material('skin', '#c08060', roughness=.6)
    glass = material('visor-glass', '#e8f6ff', roughness=.05, opacity=.2, ior=1.5)
    lens = material('lens-glass', '#ffffff', roughness=0, transmission=1, ior=1.45)
    head = sphere('head', .1, (0, 0, 1.6), skin)
    bubble = sphere('bubble', .16, (0, 0, 1.6), glass, rings=24, segments=32)
    eye = sphere('lens', .02, (.12, -.2, 1.6), lens)
    data = bpy.data.armatures.new('rig'); rig = bpy.data.objects.new('rig', data)
    bpy.context.collection.objects.link(rig); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    bone = data.edit_bones.new('head'); bone.head = (0, 0, 1.4); bone.tail = (0, 0, 1.8)
    bpy.ops.object.mode_set(mode='OBJECT')
    for obj in (head, bubble, eye):
        bind_skin(obj, rig, [{'head': 1}] * len(obj.data.vertices))
        # Skinned meshes export at the scene root (glTF ignores a skinned node's parent transform).
        world = obj.matrix_world.copy(); obj.parent = None; obj.matrix_world = world
    return [head, bubble, eye, rig]
