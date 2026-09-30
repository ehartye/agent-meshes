"""Explicit anatomical section profiles for standing, centered A-pose sculpts.

Coordinates are Blender metres (+Z up, -Y front, +X character left). Profiles are
measured from each sculpt; this is not an automatic anatomy detector. The output
can drive proportion_targets/reproportion; inspect joint placement after warping.
"""
import numpy as np
from agent_meshes_reproportion import Landmark


def section(vertices, height, side=0, part='all', half=.008, separation=.02):
    """Take a horizontal band, optionally separating trunk and hanging arm.

    On one side the largest X gap separates inner/outer clusters. An outer
    request without a gap fails rather than silently using the torso as an arm.
    An inner request without a gap returns the whole half-section.
    """
    v=np.asarray(vertices,float)
    if v.ndim!=2 or v.shape[1]!=3 or not len(v) or not np.isfinite(v).all():
        raise ValueError('vertices must be a nonempty finite Nx3 array')
    if side not in (-1,0,1) or part not in ('all','inner','outer'):
        raise ValueError('invalid section side or part')
    if not np.isfinite([height,half,separation]).all() or half<=0 or separation<=0:
        raise ValueError('section dimensions must be finite and positive')
    if part!='all' and side==0: raise ValueError('separated sections require side -1 or 1')
    band=v[abs(v[:,2]-height)<half]
    if side: band=band[band[:,0]*side>0]
    if not len(band): raise ValueError(f'empty section at height {height}, side {side}')
    if part=='all': return band
    xs=np.sort(abs(band[:,0]));gaps=np.diff(xs)
    spacing=gaps[gaps>1e-7]
    threshold=max(separation,3*float(np.median(spacing))) if len(spacing) else separation
    if not len(gaps) or gaps.max()<threshold:
        if part=='outer': raise ValueError(f'no separated arm at height {height}, side {side}')
        return band
    i=int(gaps.argmax());cut=(xs[i]+xs[i+1])/2
    return band[abs(band[:,0])>=cut] if part=='outer' else band[abs(band[:,0])<cut]


def humanoid_landmarks(vertices, profile, half=.008, separation=.02):
    """Build a proportion landmark set from measured source heights.

    Required profile entries: crotch/neck/chin heights, shoulder XYZ on +X,
    legs {ankle,calf,knee,thigh,hip}, arms {upperarm,elbow,forearm,wrist,hand},
    torso/head {name:height} maps, and fingertip_x separating hands from trunk.
    The corresponding negative-X shoulder is mirrored. Other measurements use
    each side's actual geometry, preserving source asymmetry.
    """
    v=np.asarray(vertices,float)
    # Also validates geometry before extrema or profile measurements are used.
    section(v,float(v[0,2]) if v.ndim==2 and len(v) and v.shape[1]==3 else 0,half=half)
    required={'crotch','neck','chin','shoulder','legs','arms','torso','head','fingertip_x'}
    if required-profile.keys(): raise ValueError('missing profile entries: '+str(sorted(required-profile.keys())))
    for key,names in [('legs',{'ankle','calf','knee','thigh','hip'}),('arms',{'upperarm','elbow','forearm','wrist','hand'})]:
        if names-profile[key].keys(): raise ValueError('missing '+key+' profile sections')
    shoulder=np.asarray(profile['shoulder'],float)
    if shoulder.shape!=(3,) or not np.isfinite(shoulder).all() or shoulder[0]<=0:
        raise ValueError('shoulder must be finite XYZ on positive X')
    if not np.isfinite(profile['fingertip_x']) or profile['fingertip_x']<=0:
        raise ValueError('fingertip_x must be positive and finite')
    take=lambda z,side=0,part='all': section(v,z,side,part,half,separation)
    landmarks={}
    def add(name,p,group,axis=None): landmarks[name]=Landmark(np.asarray(p,float),group,axis)
    def ring(points,side):
        return (points.min(0)+points.max(0))/2,{
            'out':points[np.argmax(points[:,0]*side)],'in':points[np.argmin(points[:,0]*side)],
            'front':points[np.argmin(points[:,1])],'back':points[np.argmax(points[:,1])]}
    def trunk(z): return np.vstack([take(z,s,'inner') for s in (1,-1)])
    sole=float(v[:,2].min());crotch=profile['crotch'];neck=profile['neck']
    add('sole',(0,0,sole),'leg')
    add('crotch',(0,trunk(crotch)[:,1].mean(),crotch),'torso')
    for label,side in [('L',1),('R',-1)]:
        add('shoulder_'+label,shoulder*np.array([side,1,1]),'torso')
        for name,z in profile['legs'].items():
            center,ext=ring(take(z,side,'inner'),side);add(name+'_'+label,center,'leg')
            if name in ('calf','knee','thigh'):
                for k,p in ext.items(): add(f'{name}_{k}_{label}',p,'leg',(f'ankle_{label}',f'hip_{label}'))
        feet=v[(v[:,2]<sole+.04)&(v[:,0]*side>0)]
        if not len(feet): raise ValueError('no foot geometry on side '+label)
        add('toe_'+label,feet[np.argmin(feet[:,1])],'leg');add('heel_'+label,feet[np.argmax(feet[:,1])],'leg')
        for name,z in profile['arms'].items():
            center,ext=ring(take(z,side,'outer'),side);add(name+'_'+label,center,'arm_'+label)
            if name in ('upperarm','forearm'):
                for k,p in ext.items(): add(f'{name}_{k}_{label}',p,'arm_'+label,(f'hand_{label}',f'shoulder_{label}'))
        hand=v[v[:,0]*side>profile['fingertip_x']]
        if not len(hand): raise ValueError('no fingertip geometry on side '+label)
        add('fingertip_'+label,hand[np.argmin(hand[:,2])],'arm_'+label)
    for name,z in profile['torso'].items():
        points=trunk(z);center,ext=ring(points,1)
        add(name+'_axis',(0,center[1],z),'torso')
        ext['left']=points[np.argmax(points[:,0])];ext['right']=points[np.argmin(points[:,0])]
        for k in ('front','back','left','right'): add(name+'_'+k,ext[k],'torso',('crotch','neck'))
    add('neck',(0,take(neck)[:,1].mean(),neck),'torso')
    chin=take(profile['chin']);add('chin',chin[np.argmin(chin[:,1])],'head')
    add('crown',v[np.argmax(v[:,2])],'head')
    for name,z in profile['head'].items():
        points=take(z)
        for k,axis,fn in [('front',1,np.argmin),('back',1,np.argmax),('left',0,np.argmax),('right',0,np.argmin)]:
            add(name+'_'+k,points[fn(points[:,axis])],'head')
    return landmarks
