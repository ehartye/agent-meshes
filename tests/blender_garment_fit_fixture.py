"""Small real BVH regressions for pose-sampled, bounded garment fitting."""
import copy
import importlib.util
import numpy as np
from mathutils.bvhtree import BVHTree
from agent_meshes_author import make_mesh


def build():
    assert importlib.util.find_spec('agent_meshes_garment_fit'), 'Reusable pose-sampled garment fitting is missing'
    from agent_meshes_garment_fit import fit_surface_offsets
    identity=np.eye(4).tolist()
    vertices=[(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)]
    faces=[(0,1,2,3)]
    normals=[(0,0,2)]*4
    weights=[{'cloth':2.} for _ in vertices]
    obstacle=[(5,-.5,.15),(5,.5,.15),(5,.5,.25),(5,-.5,.25)]
    bodyweights=[{'body':3.} for _ in obstacle]
    pose={'cloth':identity,'body':identity}
    args=[vertices,faces,normals,weights,obstacle,faces,bodyweights,[pose]]
    frozen=copy.deepcopy(args)
    clear=fit_surface_offsets(*args,offset=.2,minimum_offset=.01)
    assert clear['report']['converged'] and clear['report']['iterations']==0
    np.testing.assert_allclose(clear['vertices'],np.array(vertices)+(0,0,.2))
    assert clear['offsets']==[.2]*4 and clear['weights']==[{'cloth':1.}]*4
    assert args==frozen, 'The source geometry, weights and animation must not change'
    assert clear==fit_surface_offsets(*args,offset=.2,minimum_offset=.01), 'Fitting must be deterministic'

    moved=np.eye(4);moved[0,3]=-5
    animated=copy.deepcopy(args);animated[-1]=[{'cloth':identity,'body':moved.tolist()}]
    result=fit_surface_offsets(*animated,offset=.2,minimum_offset=.01)
    assert result['report']['initial_max_body_pairs']>0, 'The animated obstacle must be tested'
    assert result['report']['converged'] and max(result['offsets'])<.15
    assert result['report']['sampled_poses']==2, 'Rest is always checked in addition to supplied poses'
    posed_body=np.array(obstacle)+(-5,0,0)
    assert not BVHTree.FromPolygons(posed_body.tolist(),faces).overlap(BVHTree.FromPolygons(result['vertices'],result['faces']))
    rest=copy.deepcopy(animated);rest[4]=posed_body.tolist();rest[-1]=[{'cloth':identity,'body':np.linalg.inv(moved).tolist()}]
    assert fit_surface_offsets(*rest,offset=.2,minimum_offset=.01)['report']['initial_max_body_pairs']>0
    blocked=fit_surface_offsets(*animated,offset=.2,minimum_offset=.18)
    assert not blocked['report']['converged'] and blocked['report']['max_body_pairs']>0
    assert min(blocked['offsets'])>=.18
    diagnosis=blocked['report']
    assert diagnosis.get('peak_body_pose')==1, 'Diagnostics must identify the supplied animated collision sample'
    assert diagnosis['initial_peak_body_pose']==1 and diagnosis['peak_self_pose'] is None
    assert diagnosis['reason']=='minimum_offset_reached'
    assert diagnosis['colliding_vertices_at_minimum']==diagnosis['colliding_vertices']==4
    example=diagnosis['body_pair_examples'][0]
    assert example['reference_face']==0 and example['reference_triangle'] in [0,1]
    assert example['source_vertices']==sorted(blocked['faces'][example['garment_face']])
    assert blocked['source_faces']==[0,0] and diagnosis['pair_unit']=='triangle'
    assert diagnosis['body_pair_examples'][0]['all_vertices_at_minimum']
    assert len(diagnosis['history'])==diagnosis['iterations']+1
    assert diagnosis['history'][0]['iteration']==0 and diagnosis['history'][-1]['max_body_pairs']==diagnosis['max_body_pairs']
    exhausted=fit_surface_offsets(*animated,offset=.2,minimum_offset=.01,iterations=0)
    assert not exhausted['report']['converged'] and exhausted['report']['iterations']==0
    assert exhausted['report']['reason']=='iteration_limit' and exhausted['report']['colliding_vertices_at_minimum']==0

    # Inward normals on a narrow V create a crossing that shrinking offsets removes.
    fold=[(-.1,-1,0),(-.1,1,0),(-.6,1,1),(-.6,-1,1),
          (.1,-1,0),(.6,-1,1),(.6,1,1),(.1,1,0)]
    foldfaces=[(0,1,2,3),(4,5,6,7)]
    folded=fit_surface_offsets(fold,foldfaces,[(1,0,.5)]*4+[(-1,0,.5)]*4,
        [{'cloth':1.}]*8,obstacle,faces,bodyweights,[pose],offset=.3,minimum_offset=.01)
    assert folded['report']['initial_max_self_pairs']>0
    assert folded['report']['initial_peak_self_pose']==0 and folded['report']['self_pair_examples']==[]
    assert folded['report']['converged'] and folded['report']['max_self_pairs']==0
    tree=BVHTree.FromPolygons(folded['vertices'],folded['faces'])
    assert not [(a,b) for a,b in tree.overlap(tree) if a<b and set(folded['faces'][a]).isdisjoint(folded['faces'][b])]

    shell=fit_surface_offsets(*args,offset=.2,minimum_offset=.03,thickness=.04)
    assert shell['report']['converged'] and len(shell['vertices'])==8
    np.testing.assert_allclose(np.array(shell['vertices'])[:,2],[.22]*4+[.18]*4)
    assert shell['weights']==[{'cloth':1.}]*8
    edges={}
    for face in shell['faces']:
        for a,b in zip(face,face[1:]+face[:1]):edges.setdefault(tuple(sorted((a,b))),[]).append((a,b))
    assert all(len(uses)==2 and uses[0]==uses[1][::-1] for uses in edges.values()), 'Shell must be closed with consistent winding'
    # Only the shell rim intersects this obstacle; neither outer nor inner panel does.
    rimargs=copy.deepcopy(args);rimargs[4]=[(-2,0,.195),(2,0,.195),(2,0,.205),(-2,0,.205)]
    rim=fit_surface_offsets(*rimargs,offset=.2,minimum_offset=.03,thickness=.04)
    assert rim['report']['initial_max_body_pairs']>0 and rim['report']['converged']

    invalid=[]
    def bad_arg(index,value):
        altered=copy.deepcopy(args);altered[index]=value;invalid.append((altered,{}))
    bad_arg(0,[]);bad_arg(0,[(float('nan'),0,0)]*4);bad_arg(1,[])
    bad_arg(1,[(0,1,99)]);bad_arg(1,[(0,1,1)]);bad_arg(2,[(0,0,0)]*4)
    bad_arg(3,[{'cloth':-1.}]*4);bad_arg(3,[{'cloth':0.}]*4)
    bad_arg(3,[{str(i):1. for i in range(5)}]*4);bad_arg(6,[{}]*4)
    bad_arg(7,[]);bad_arg(7,[{'cloth':identity}]);bad_arg(7,[{'cloth':[[1]],'body':identity}])
    nonaffine=np.eye(4);nonaffine[3,0]=1;bad_arg(7,[{'cloth':nonaffine.tolist(),'body':identity}])
    for params in ({'offset':float('inf')},{'minimum_offset':0},{'minimum_offset':.3},
                   {'thickness':-.1},{'thickness':.02},{'iterations':-1},{'iterations':1.5}):
        invalid.append((copy.deepcopy(args),params))
    nonmanifold=copy.deepcopy(args);nonmanifold[1]=[(0,1,2),(0,1,3),(0,1,2)]
    invalid.append((nonmanifold,{'thickness':.01}))
    for altered,params in invalid:
        try:fit_surface_offsets(*altered,**({'offset':.2,'minimum_offset':.01}|params))
        except ValueError:pass
        else:raise AssertionError(f'Invalid fitting input was accepted: {altered}, {params}')
    return [make_mesh('fitted_shell',shell['vertices'],shell['faces'])]
