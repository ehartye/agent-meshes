"""Render fixed-camera Workbench previews of a trusted build() source inside one Blender run: no GLB, no browser.

One job:  blender -b --python scripts/blender-preview.py -- job.json
Worker:   blender -b --python scripts/blender-preview.py -- --worker <queue directory>

A job is JSON: {"source", "outDir", "views", "shadings", "poses": [{"name", "shapes": {key: weight}}], "size",
"sheet", "rest", "hide", "target"}. The one-shot run writes `<job>.done` ({ok, error?}); the worker takes each
`<id>.job.json` dropped in its queue, writes `<id>.done.json`, and keeps a heartbeat in `worker.json` until a `stop`
file appears. Every job writes its PNGs and a `preview.json` manifest into outDir.
Blender coordinates: Z up, the face looks down -Y, the character's left is +X.
"""
import fnmatch
import json
import math
import os
from pathlib import Path
import runpy
import sys
import time
import traceback

sys.dont_write_bytecode = True

import bpy
from mathutils import Vector

LIB = Path(__file__).resolve().parent / 'blender_lib'
# Camera presets: (yaw degrees round Z from the front toward the character's left, pitch degrees up, zoom, framing).
# The front camera stands on -Y looking +Y at the face. `close` frames the middle of the face (eyes to mouth).
VIEWS = {
    'front': (0, 0, 1.0, 'head'), 'q34': (35, 5, 1.0, 'head'), 'side': (90, 0, 1.0, 'head'), 'below': (0, -30, 1.0, 'head'),
    'above': (0, 30, 1.0, 'head'), 'close': (0, 0, .55, 'head'), 'back': (180, 0, 1.0, 'head'),
    'body-front': (0, 0, 1.0, 'body'), 'body-q34': (35, 5, 1.0, 'body'), 'body-side': (90, 0, 1.0, 'body'), 'body-back': (180, 0, 1.0, 'body'),
}
SHADINGS = ('matcap', 'wire', 'cavity', 'zebra', 'color')
LENS = 85.0


def report(path, value):
    """Readers never see a half-written file, including through the Store launcher."""
    temporary = str(path) + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def forget_modules(roots):
    """Drop modules loaded from the source's folder or the helper library, so an edited helper is re-read next job."""
    roots = [str(Path(r).resolve()).lower() for r in roots]
    for name, module in list(sys.modules.items()):
        path = getattr(module, '__file__', None)
        if path and any(str(Path(path).resolve()).lower().startswith(root) for root in roots): del sys.modules[name]


def build_objects(source):
    sys.path[:0] = [p for p in (str(source.parent), str(LIB)) if p not in sys.path]
    forget_modules([source.parent, LIB])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    namespace = runpy.run_path(str(source), run_name='__agent_meshes_asset__')
    build = namespace.get('build')
    if not callable(build): raise ValueError('Authoring source must define build() returning a list of bpy objects')
    objects = build()
    if not isinstance(objects, list) or not objects: raise ValueError('build() must return a nonempty list of bpy objects')
    return objects


def world_points(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try: return [evaluated.matrix_world @ v.co for v in mesh.vertices]
    finally: evaluated.to_mesh_clear()


def bounds(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def framing(meshes, target):
    """The (center, radius) of the body and of the head: the named target, else the mesh with face shape keys, else
    the top seventh of the body."""
    everything = [p for obj in meshes for p in world_points(obj)]
    lo, hi = bounds(everything)
    body = ((lo + hi) / 2, (hi - lo).length / 2)
    chosen = []
    if target:
        chosen = [obj for obj in meshes if fnmatch.fnmatch(obj.name, target)]
        if not chosen: raise ValueError(f'No mesh matches --target {target}')
    else:
        chosen = [obj for obj in meshes if obj.data.shape_keys and 'eyeBlinkLeft' in obj.data.shape_keys.key_blocks]
    if chosen:
        points = [p for obj in chosen for p in world_points(obj)]
        # A face mesh that also carries a neck reaches the shoulders: frame its top 70% only.
        hlo, hhi = bounds(points)
        top = [p for p in points if p.z >= hhi.z - .7 * (hhi.z - hlo.z)] if not target else points
        hlo, hhi = bounds(top)
    else:
        hhi = hi.copy(); hlo = Vector((lo.x, lo.y, hi.z - (hi.z - lo.z) / 7))
        top = [p for p in everything if p.z >= hlo.z]
        hlo, hhi = bounds(top)
    head = ((hlo + hhi) / 2, max(1e-4, (hhi - hlo).length / 2))
    return {'body': body, 'head': head}


def place_camera(camera, center, radius, yaw, pitch, zoom):
    fov = 2 * math.atan(18 / LENS)
    distance = radius * zoom / math.sin(fov / 2) * 1.02
    y, p = math.radians(yaw), math.radians(pitch)
    direction = Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p)))
    camera.location = center + direction * distance
    camera.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = LENS
    camera.data.clip_start = distance / 100
    camera.data.clip_end = distance * 10


def set_shading(scene, shading, wires):
    sh = scene.display.shading
    sh.show_cavity = False
    sh.show_object_outline = False
    sh.show_specular_highlight = True
    for wire in wires: wire.hide_render = shading != 'wire'
    if shading in ('matcap', 'wire', 'zebra'):
        sh.light = 'MATCAP'
        sh.studio_light = 'check_reflection_horizontal.exr' if shading == 'zebra' else 'clay_studio.exr'
        sh.color_type = 'OBJECT' if shading == 'wire' else 'SINGLE'
        sh.single_color = (.8, .8, .8)
    elif shading == 'cavity':
        sh.light = 'STUDIO'
        sh.color_type = 'SINGLE'
        sh.single_color = (.85, .85, .85)
        sh.show_cavity = True
        sh.cavity_type = 'BOTH'
        sh.cavity_ridge_factor = sh.cavity_valley_factor = 2.0
        sh.curvature_ridge_factor = sh.curvature_valley_factor = 2.0
    else:
        sh.light = 'STUDIO'
        sh.color_type = 'MATERIAL'
        # Workbench draws a material's viewport color: take it from the node tree's base color.
        for mat in bpy.data.materials:
            node = mat.node_tree and next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if node is not None: mat.diffuse_color = tuple(node.inputs['Base Color'].default_value)


def add_wires(meshes, size):
    """A copy of each mesh (same data, modifiers, parent) drawn as thin dark wires over the matcap."""
    wires = []
    for obj in meshes:
        wire = obj.copy()
        bpy.context.scene.collection.objects.link(wire)
        modifier = wire.modifiers.new('preview_wire', 'WIREFRAME')
        modifier.thickness = size * .0012
        modifier.use_even_offset = False
        modifier.offset = 1.0
        modifier.use_replace = True
        wire.color = (.05, .05, .08, 1)
        obj.color = (.82, .82, .82, 1)
        wire.hide_render = True
        wires.append(wire)
    return wires


def set_pose(meshes, shapes):
    """Every shape key named in `shapes` on every mesh takes its weight; every other key rests at 0."""
    found = set()
    for obj in meshes:
        keys = obj.data.shape_keys
        if not keys: continue
        for block in keys.key_blocks[1:]:
            block.value = shapes.get(block.name, 0.0)
            if block.name in shapes: found.add(block.name)
    missing = sorted(set(shapes) - found)
    if missing: raise ValueError(f'No mesh has shape key(s): {", ".join(missing)}')


def contact_sheet(files, columns, size, path):
    """The PNGs in rows of `columns`, into one image (pixels composed with numpy)."""
    import numpy as np
    rows = math.ceil(len(files) / columns)
    sheet = np.ones((rows * size, columns * size, 4), dtype=np.float32)
    for n, file in enumerate(files):
        image = bpy.data.images.load(file)
        w, h = image.size
        pixels = np.array(image.pixels[:], dtype=np.float32).reshape(h, w, 4)
        r, c = divmod(n, columns)
        # Blender's pixel rows run bottom to top: the first row of the sheet is its top.
        top = (rows - 1 - r) * size
        sheet[top:top + min(h, size), c * size:c * size + min(w, size)] = pixels[:size, :size]
        bpy.data.images.remove(image)
    out = bpy.data.images.new('preview_sheet', columns * size, rows * size, alpha=True)
    out.pixels = sheet.ravel()
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)


def run_job(job):
    started = time.time()
    source = Path(job['source']).resolve()
    out = Path(job['outDir']).resolve()
    out.mkdir(parents=True, exist_ok=True)
    views, shadings = job['views'], job['shadings']
    for view in views:
        if view not in VIEWS: raise ValueError(f'Unknown view {view}; choose from {", ".join(VIEWS)}')
    for shading in shadings:
        if shading not in SHADINGS: raise ValueError(f'Unknown shading {shading}; choose from {", ".join(SHADINGS)}')
    objects = build_objects(source)
    scene = bpy.context.scene
    if job.get('rest', True):
        for obj in objects:
            if getattr(obj, 'type', None) == 'ARMATURE': obj.data.pose_position = 'REST'
    hide = job.get('hide') or []
    meshes = []
    for obj in objects:
        if getattr(obj, 'type', None) != 'MESH': continue
        if any(fnmatch.fnmatch(obj.name, pattern) for pattern in hide): obj.hide_render = True; continue
        meshes.append(obj)
    if not meshes: raise ValueError('No mesh left to render')
    scene.render.engine = 'BLENDER_WORKBENCH'
    size = int(job.get('size', 512))
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.display.render_aa = '8'
    scene.world = scene.world or bpy.data.worlds.new('preview')
    camera = bpy.data.objects.new('preview_camera', bpy.data.cameras.new('preview_camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    poses = job.get('poses') or [{'name': 'rest', 'shapes': {}}]
    set_pose(meshes, {})
    frames = framing(meshes, job.get('target'))
    wires = add_wires(meshes, frames['head'][1] * 2) if 'wire' in shadings else []
    files = []
    for pose in poses:
        set_pose(meshes, pose.get('shapes', {}))
        bpy.context.view_layer.update()
        for view in views:
            yaw, pitch, zoom, which = VIEWS[view]
            center, radius = frames[which]
            place_camera(camera, center, radius, yaw, pitch, zoom)
            for shading in shadings:
                set_shading(scene, shading, wires)
                name = f"{pose['name']}-{view}-{shading}.png"
                scene.render.filepath = str(out / name)
                bpy.ops.render.render(write_still=True)
                files.append(name)
    sheet = None
    if job.get('sheet') and files:
        sheet = 'sheet.png'
        contact_sheet([str(out / f) for f in files], len(views) * len(shadings), size, str(out / sheet))
    manifest = {'version': 1, 'source': str(source), 'blender': bpy.app.version_string, 'views': views, 'shadings': shadings,
                'poses': poses, 'size': size, 'files': files, 'sheet': sheet, 'seconds': round(time.time() - started, 2)}
    report(out / 'preview.json', manifest)
    return manifest


def worker(queue):
    import threading
    queue.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    version = bpy.app.version_string

    # The heartbeat beats from its own thread (it touches no bpy data), so a long job does not read as a dead worker.
    def beat():
        while not stop.is_set():
            report(queue / 'worker.json', {'pid': os.getpid(), 'time': time.time(), 'blender': version})
            stop.wait(1)
    threading.Thread(target=beat, daemon=True).start()
    try:
        while not (queue / 'stop').exists():
            jobs = sorted(queue.glob('*.job.json'), key=lambda p: p.stat().st_mtime)
            if not jobs:
                time.sleep(.1)
                continue
            job_file = jobs[0]
            name = job_file.name[:-len('.job.json')]
            running = queue / f'{name}.running.json'
            os.replace(job_file, running)
            try:
                manifest = run_job(json.loads(running.read_text(encoding='utf-8')))
                report(queue / f'{name}.done.json', {'ok': True, 'manifest': manifest})
            except BaseException:
                report(queue / f'{name}.done.json', {'ok': False, 'error': traceback.format_exc()})
            finally:
                running.unlink(missing_ok=True)
    finally:
        stop.set()
        time.sleep(.2)
        (queue / 'stop').unlink(missing_ok=True)
        (queue / 'worker.json').unlink(missing_ok=True)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    if argv[:1] == ['--worker']:
        worker(Path(argv[1]).resolve())
    else:
        if len(argv) != 1: raise ValueError('Expected a job.json argument')
        job_path = Path(argv[0]).resolve()
        report(str(job_path) + '.pid', {'pid': os.getpid()})
        try:
            manifest = run_job(json.loads(job_path.read_text(encoding='utf-8')))
            report(str(job_path) + '.done', {'ok': True, 'manifest': manifest})
        except BaseException:
            report(str(job_path) + '.done', {'ok': False, 'error': traceback.format_exc()})
            raise
