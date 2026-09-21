# Blender authoring helpers

The build runner adds this directory to Python's import path. Import the module
as `agent_meshes_author`. Blender is only needed when creating/exporting objects;
the sweep geometry function uses the Python standard library.

```python
from agent_meshes_author import make_mesh, material, shape_key, sweep_mesh

def build():
    centers = [(0, 0, 0), (0, 0, 1), (.2, 0, 2)]
    vertices, faces = sweep_mesh(centers, [(.2, .1)] * 3,
                                 radial_segments=32, initial_normal=(1, 0, 0))
    finish = material('Bronze', (.5, .25, .08), metalness=.9, roughness=.25)
    obj = make_mesh('Form', vertices, faces, finish)
    target, _ = sweep_mesh(centers, [(.3, .1)] * 3,
                           radial_segments=32, initial_normal=(1, 0, 0))
    shape_key(obj, 'Fullness', target)
    return [obj]
```

`sweep_mesh(centers, radii, radial_segments=48, twist=None,
initial_normal=None)` returns vertices and outward-wound faces with closed caps.
Centers are XYZ triples, radii are positive pairs, and twist is one angle in
radians per ring. Parallel transport minimizes frame rotation along the path.
Use the same explicit initial normal for every member of a morph family, so a
changing first tangent cannot select a different starting axis. The normal must
not be parallel to the first tangent. Avoid cusps and self-intersecting paths;
input validation cannot prove that an arbitrary sweep does not intersect itself.

`material(name, color, metalness=0, roughness=.4)` takes **linear** RGB components,
metalness and roughness in 0..1. `make_mesh(name, vertices, faces, material=None)`
creates a named mesh with smooth side faces and flat caps.

`shape_key(obj, name, vertices)` creates a named 0..1 morph at an explicit zero
rest weight. It checks finite coordinates and equal vertex count; authors must
also preserve vertex order and topology. Duplicate names and `Basis` are rejected.

`export_glb(path, objects)` exports selected objects, preserving PBR materials,
skins, animations, named morphs and authored rest weights. It does not apply
geometry modifiers, which can discard morph topology. Resolve required modifiers
before creating shape keys. The build runner normally calls this function for you.

Run geometry checks without Blender:

```sh
python tests/blender_author_geometry.py
```
