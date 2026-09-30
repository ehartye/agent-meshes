"""Rest tessellation must survive thickness, clipping and animation."""
import bpy,copy,json
import numpy as np
from agent_meshes_garment_fit import fit_surface_offsets
from agent_meshes_author import make_mesh

def build():
    # Real warped hip quad: reversing its inner copy changes the inferred
    # diagonal and makes a positively offset shell intersect its own donor.
    v=[[.0864811316,.0202749725,.4159927964],[.0859648436,.0222281925,.4091838598],
       [.0786280632,.0285314992,.4081701040],[.0819839239,.0249371752,.4151329994]]
    n=[[.756477,.638163,.143141],[.712624,.694460,.099461],[.593480,.798203,.103217],[.683346,.725060,.085596]]
    f=[[0,1,2,3]];w=[{'hip':1.}]*4
    result=fit_surface_offsets(v,f,n,w,v,f,w,[{'hip':np.eye(4)}],offset=.00065,minimum_offset=.00065,thickness=.000659,iterations=0)
    assert result['report']['max_body_pairs']==0,'A copied offset quad cuts its own donor because its inner diagonal changed'
    assert result['report']['max_self_pairs']==0
    assert all(len(p)==3 for p in result['faces']),'Export needs the exact collision-tested triangles, including rims'
    from agent_meshes_tessellation import triangulate_surface
    before=copy.deepcopy((v,f));meshes=len(bpy.data.meshes)
    triangles=triangulate_surface(v,f)
    assert len(bpy.data.meshes)==meshes,'Temporary tessellation mesh leaked'
    assert (v,f)==before,'Tessellation moved source geometry'
    assert triangles['source_faces']==[0,0] and len(triangles['faces'])==2
    # Compare directly to Blender's render/export topology, including a concave ngon.
    points=v+[[0,0,0],[2,0,0],[2,2,0],[1,1,0],[0,2,0]]
    faces=f+[[4,5,6,7,8]]
    temp=bpy.data.meshes.new('reference');temp.from_pydata(points,[],faces);temp.calc_loop_triangles()
    expected=[tuple(t.vertices) for t in temp.loop_triangles];parents=[t.polygon_index for t in temp.loop_triangles]
    bpy.data.meshes.remove(temp)
    actual=triangulate_surface(points,faces)
    assert actual['faces']==expected and actual['source_faces']==parents
    assert triangulate_surface(points,expected)['faces']==expected
    for verts,polys in [([],f),(v,[]),(v,[[0,1,99]]),(v,[[0,1,1]]),(v,[[True,1,2]]),([[float('inf'),0,0]]*4,f)]:
        try:triangulate_surface(verts,polys)
        except ValueError:pass
        else:raise AssertionError('Invalid tessellation input accepted')
    assert len(bpy.data.meshes)==meshes
    shell=make_mesh('frozen-shell',result['vertices'],result['faces'])
    from agent_meshes_face import EXTRAS_PROPERTY
    # Carry the collision-tested geometry across the export boundary. The TS
    # test compares oriented triangles, allowing export vertex splits/reordering.
    shell[EXTRAS_PROPERTY]=json.dumps({'testedTriangles':[
        [[result['vertices'][i][0],result['vertices'][i][2],-result['vertices'][i][1]] for i in face]
        for face in result['faces']]})
    return [shell]
