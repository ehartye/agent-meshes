"""Closed ribbed crew-neck bands and open jacket stands, in rest-space Z-up."""
import numpy as np
from numbers import Real


def neckband_mesh(lower,upper,*,thickness=.002,ribs=0,rib_depth=0.,closed=True):
    """Loft a rounded fabric cross-section along matching neckline contours.

    Contours run counterclockwise viewed from above, without a repeated endpoint.
    Their points describe the inner lower/upper edges; outer-wall ribs follow
    corresponding points vertically. Open stands receive end caps. This pure
    geometry helper does not fit skin, assign weights or certify posed clearance.
    """
    a=np.asarray(lower,float);b=np.asarray(upper,float)
    if a.ndim!=2 or a.shape[1]!=3 or len(a)<3 or b.shape!=a.shape or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('Matching finite Nx3 contours with at least three points required')
    if not isinstance(closed,bool):raise ValueError('closed must be boolean')
    for value,name,positive in [(thickness,'thickness',True),(rib_depth,'rib_depth',False)]:
        if isinstance(value,bool) or not isinstance(value,Real) or not np.isfinite(value) or (value<=0 if positive else value<0):
            raise ValueError(name+' must be finite and '+('positive' if positive else 'nonnegative'))
    if isinstance(ribs,bool) or not isinstance(ribs,int) or ribs<0:raise ValueError('ribs must be a nonnegative integer')
    segments=len(a) if closed else len(a)-1
    if ribs*4>segments:raise ValueError('Use at least four segments per rib')
    rise=b-a
    if np.any(rise[:,2]<=1e-8):raise ValueError('Upper contour must be above lower contour')
    center=(a+b)/2;tangent=np.roll(center,-1,axis=0)-np.roll(center,1,axis=0)
    if not closed:tangent[0]=center[1]-center[0];tangent[-1]=center[-1]-center[-2]
    normal=np.cross(tangent,rise);length=np.linalg.norm(normal,axis=1)
    if np.any(length<1e-10):raise ValueError('Contour has a collapsed tangent or vertical edge')
    normal/=length[:,None]
    rib=rib_depth*(.5+.5*np.cos(np.arange(len(a))*2*np.pi*ribs/segments)) if ribs else np.zeros(len(a))
    profile=[(0,0),(0,.5),(.08,1),(.92,1),(1,.5),(1,0),(.92,-.15),(.08,-.15)]
    vertices=[]
    for i in range(len(a)):
        for j,(height,offset) in enumerate(profile):
            vertices.append((a[i]+rise[i]*height+normal[i]*(thickness*offset+(rib[i] if j in (2,3) else 0))).tolist())
    faces=[];n=len(profile)
    for i in range(segments):
        nxt=(i+1)%len(a)
        for j in range(n):
            k=(j+1)%n;faces.append((i*n+j,nxt*n+j,nxt*n+k,i*n+k))
    if not closed:faces.extend([tuple(range(n)),tuple(reversed(range((len(a)-1)*n,len(a)*n)))])
    return vertices,faces
