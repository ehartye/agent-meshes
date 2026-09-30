"""Fit open stands and ribbed bands to thick garments without changing anatomy."""
import math
import bpy
import numpy as np
from agent_meshes_author import make_mesh
from agent_meshes_neckbands import fit_neckband


def build():
    count=96
    vertices=[(.12*math.sin(t),-.12*math.cos(t),z)
              for z in (.8,.95,1.0,1.1) for t in np.linspace(0,math.tau,count,endpoint=False)]
    faces=[(r*count+i,r*count+(i+1)%count,(r+1)*count+(i+1)%count,(r+1)*count+i)
           for r in range(3) for i in range(count)]
    body=make_mesh('body',vertices,faces)
    for name in ('chest','shoulder'):body.vertex_groups.new(name=name)
    for v in body.data.vertices:
        w=.95 if v.co.x>0 else .05
        body.vertex_groups['chest'].add([v.index],w,'REPLACE')
        body.vertex_groups['shoulder'].add([v.index],1-w,'REPLACE')
    garment=body.copy();garment.data=body.data.copy();garment.name='garment'
    bpy.context.collection.objects.link(garment)
    for v in garment.data.vertices:
        v.co.x*=1.08;v.co.y*=1.08
        if v.co.z>1.09:v.co.z=1.005+.003*math.sin(v.index/count*math.tau)
    bpy.context.view_layer.objects.active=garment
    solid=garment.modifiers.new('Fabric thickness','SOLIDIFY');solid.thickness=.002;solid.offset=0
    bpy.ops.object.modifier_apply(modifier=solid.name)
    original_vertices=np.array([v.co[:] for v in garment.data.vertices])
    weights=lambda o:[{o.vertex_groups[g.group].name:g.weight for g in v.groups} for v in o.data.vertices]
    original_body=weights(body);original_garment=weights(garment)
    fit=dict(lower=.995,upper=1.015,opening_width=.04,surface_shape=lambda p,n:p+n*.010)
    raw=fit_neckband(body,garment,**fit,smooth_distance=0)
    result=fit_neckband(body,garment,**fit)
    points=np.asarray(result['vertices']).reshape(-1,8,3)
    assert .042<points[0,0,0]<.044 and -.044<points[-1,0,0]<-.042,'Stand ends must fit the authored opening'
    for column in range(len(points)):
        rows=result['weights'][column*8:(column+1)*8]
        assert all(row==rows[0] for row in rows),'Band columns must share attachment weights'
        assert abs(sum(rows[0].values())-1)<1e-7 and len(rows[0])<=4
    chest=[result['weights'][i*8].get('chest',0) for i in range(len(points))]
    raw_chest=[raw['weights'][i*8].get('chest',0) for i in range(len(points))]
    jump=lambda values:max(abs(a-b) for a,b in zip(values,values[1:]))
    assert jump(chest)<jump(raw_chest)*.6,'Fitting must reduce the source weight discontinuity'
    np.testing.assert_array_equal(original_vertices,[v.co[:] for v in garment.data.vertices])
    assert weights(body)==original_body,'Fitting cannot alter source anatomy weights'
    actual=weights(garment);half=len(actual)//2
    for i in range(half):
        assert actual[i]==actual[i+half],'Both sides of fabric must share the seam field'
        if original_vertices[i,2]<.95:assert actual[i]==original_garment[i],'Distant garment weights changed'
    band=make_mesh('stand',result['vertices'],result['faces'])
    shirt=fit_neckband(body,garment,lower=1.0,upper=1.02,clearance=.013,ribs=24,follow_garment_edge=True)
    assert len(shirt['vertices'])==144*8
    base=np.array(shirt['vertices']).reshape(-1,8,3)[:,0]
    assert base[:,2].min()>.999 and base[:,2].max()<1.007,'Must select the upper neckline, not hem'
    assert np.ptp(base[:,2])>.004,'Must preserve the actual non-planar garment boundary'
    top=np.array(shirt['vertices']).reshape(-1,8,3)[:,5]
    np.testing.assert_allclose(top[:,:2],base[:,:2],atol=1e-7,
        err_msg='The edge-following band must rise from its seam, not project across an unrelated body surface')
    ribbed=make_mesh('ribbed',shirt['vertices'],shirt['faces'])
    return [body,garment,band,ribbed]
