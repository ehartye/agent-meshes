"""Export coincident donor/garment cut vertices under a two-bone bend."""
import bpy
import numpy as np
from agent_meshes_garment_partition import partition_surface
from agent_meshes_author import make_mesh,bind_skin

def build():
    v=np.array([[-1,0,0],[1,0,0],[1,0,1],[-1,0,1]],float)
    result=partition_surface(v,[(0,1,2),(0,2,3)],np.tile([0,-1,0],(4,1)),
                             [{'a':1},{'b':1},{'b':1},{'a':1}],[v[:,0]-.2,v[:,2]-.15])
    bpy.ops.object.armature_add();arm=bpy.context.object;arm.name='cut-rig'
    bpy.ops.object.mode_set(mode='EDIT')
    a=arm.data.edit_bones[0];a.name='a';a.head=(0,0,0);a.tail=(0,0,1)
    b=arm.data.edit_bones.new('b');b.head=(1,0,0);b.tail=(1,0,1)
    bpy.ops.object.mode_set(mode='OBJECT')
    objects=[arm]
    for name in ('source','garment'):
        data=result[name];obj=make_mesh(name,data['vertices'],data['faces']);bind_skin(obj,arm,data['weights'])
        matrix=obj.matrix_world.copy();obj.parent=None;obj.matrix_world=matrix;objects.append(obj)
    for frame,angle in [(0,0),(10,.9),(20,-.6),(30,0)]:
        for name,scale in [('a',-.3),('b',1)]:
            bone=arm.pose.bones[name];bone.rotation_mode='XYZ';bone.rotation_euler=(angle*scale,angle*.2,0)
            bone.keyframe_insert('rotation_euler',frame=frame)
    arm.animation_data.action.name='bend'
    bpy.context.scene.frame_set(0)
    return objects
