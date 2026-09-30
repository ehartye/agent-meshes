"""The soft-lips kid head (test_lips_kid.py) on a body skeleton: a full-body character's face.

The head bone is not the root: `root` -> `spine` -> `head`, as in a walking character, and `add_eye_bones` hangs the
eyes under that head. A torso bound to `spine` stands below the face. The rig declares `skeleton='body'`.
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
import bpy

import test_lips_kid as kid
from agent_meshes_author import add_eye_bones, bind_rigid, ellipsoid_geometry, face_contract, material, mesh_from_geometry

TORSO = []


def body_rig(head, eye_left, eye_right, name='Face rig'):
    data = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    bones = {}
    for bone, start, end, parent in (('root', (0, 0, -.6), (0, 0, -.5), None), ('spine', (0, 0, -.45), (0, 0, .02), 'root'),
                                     ('head', (0, 0, .03), (0, 0, .25), 'spine')):
        b = data.edit_bones.new(bone); b.head = start; b.tail = end; b.roll = 0
        if parent: b.parent = bones[parent]
        bones[bone] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    add_eye_bones(rig, eye_left, eye_right)
    torso = mesh_from_geometry('torso', ellipsoid_geometry((0, 0, -.2), (.16, .09, .22)), [material('jacket', '#d47d48')])
    bind_rigid(torso, rig, 'spine')
    TORSO.append(torso)
    return rig


def build():
    kid.face_skeleton = body_rig
    kid.face_contract = lambda root, objects, **options: face_contract(root, objects, skeleton='body', **options)
    return kid.build() + TORSO
