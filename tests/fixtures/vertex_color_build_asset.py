"""Two-layer CORNER RGBA fixture for the normal build() wrapper."""
import bpy

EXPORT_VERTEX_COLOR = 'ACTIVE'
EXPORT_ALL_VERTEX_COLORS = False
COLORS = ((.13, .24, .35, .25), (.41, .52, .63, .5),
          (.69, .71, .83, .75), (.21, .37, .59, 1.0))


def build():
    mesh = bpy.data.meshes.new('Painted quad')
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    unused = mesh.color_attributes.new(name='UnusedWhite', type='FLOAT_COLOR', domain='CORNER')
    for item in unused.data:
        item.color = (1, 1, 1, 1)
    paint = mesh.color_attributes.new(name='CraftColor', type='FLOAT_COLOR', domain='CORNER')
    for item, color in zip(paint.data, COLORS):
        item.color = color
    mesh.color_attributes.active_color_index = 1
    mesh.color_attributes.render_color_index = 1
    material = bpy.data.materials.new('Paint material')
    material.use_nodes = True
    mesh.materials.append(material)
    obj = bpy.data.objects.new('Painted quad', mesh)
    bpy.context.collection.objects.link(obj)
    return [obj]
