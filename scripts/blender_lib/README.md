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

`fuse_meshes(objects, name, voxel_size, smooth_passes=2, expected_components=1)`
joins overlapping mesh pieces and voxel-remeshes their union into a continuous
surface. It then applies a `.5`-factor Smooth modifier for the requested passes.
Use it **before** adding shape keys, animation, final materials or UVs:

```python
from agent_meshes_author import fuse_meshes

figure = fuse_meshes(pieces, 'Figure', voxel_size=.011, smooth_passes=3)
# Assign materials, create UVs and derive morph vertices from figure.data now.
```

Voxel size is a positive finite distance in the scene's world units. It controls
the smallest retained detail: narrow limbs, gaps, or separate pieces can disappear
or merge at coarse settings. Start with overlapping solid pieces. Parent, location,
rotation, scale and parent-induced shear are baked directly into vertices;
reflections reverse face winding. The result is unparented, has an identity
transform, and stores world-space coordinates. The result is globally smooth
shaded; authors may override individual faces afterward. Unrelated objects sharing
an input's mesh data retain their original geometry.

The helper accepts 1–256 distinct mesh objects and 0–50 smoothing passes. It rejects
shape keys, unresolved modifiers, constraints, animation, and children outside
the input list before consuming inputs. Resolve those deliberately in the source
first; external children must be detached while preserving their world transforms.
A conservative 32-million
bounding-grid-cell budget rejects accidentally tiny voxels; it is not a guarantee
of Blender memory usage. The helper owns selection and object mode and **consumes
input objects once joining starts**, including when a later topology check fails.
Rebuild from the source recipe after a failure. Materials and UVs should be authored
on the returned topology, since voxel remeshing does not preserve their layout.

By default, the result must contain exactly one connected component, have faces,
and have zero boundary or overused edges. `expected_components` accepts 1–256 or
`None` to omit the component-count requirement; the closed-edge checks still run.
`topology_report(vertices, faces)` exposes the same pure-Python counts:
`components`, `boundary_edges` (one incident face), and `nonmanifold_edges` (more
than two incident faces). Components follow vertex/edge connectivity and include
isolated vertices. An empty mesh reports zero components. These checks do **not**
prove non-self-intersection, consistent winding, valid vertex fans, positive volume,
or absence of zero-area faces; assess the resulting shape and its deformations too.

`export_glb(path, objects)` exports selected objects, preserving PBR materials,
skins, animations, named morphs and authored rest weights. It does not apply
geometry modifiers, which can discard morph topology. Resolve required modifiers
before creating shape keys. The build runner normally calls this function for you.

Run geometry checks without Blender:

```sh
python tests/blender_author_geometry.py
```

The optional real-Blender fixture `tests/blender_author_fusion.py` defines `build()`
for the authoring runner. It checks pre-morph rejection, disconnected outputs,
transformed overlapping meshes, shared-data isolation, and post-fusion morphs.
Run it through `authorGLB` and validate its temporary GLB with `verifyGLB`; Blender
is not required by the pure-Python CI checks.
