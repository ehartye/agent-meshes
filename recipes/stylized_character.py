"""Deterministic stylized anatomy study, independent of any game or character.

geometry(parameters) returns named Y-up mesh data using only the standard library.
build_character(parameters) adapts those meshes to the agent-meshes Blender runner.
This is a static authoring recipe, not an animation-ready human topology generator.
"""
import bisect
import math
import re

VERSION = 1
DEFAULTS = dict(height=1.82, age='adult', presentation='female', species='human',
                vacuum=False, skin='#b97d57', hair='#363544', accent='#d47d48',
                eyes='#507d76', costume=None)

def parameters(values):
    if not isinstance(values, dict) or set(values) - set(DEFAULTS):
        raise ValueError('Unknown character parameters')
    p = dict(DEFAULTS, **values)
    if isinstance(p['height'], bool) or not isinstance(p['height'], (int,float)) or not math.isfinite(p['height']) or not .7 <= p['height'] <= 2.5:
        raise ValueError('height must be finite and in 0.7..2.5 metres')
    for key, choices in [('age', ('adult','child')), ('presentation', ('female','male')), ('species', ('human','alien'))]:
        if p[key] not in choices: raise ValueError(f'{key} must be one of {choices}')
    if not isinstance(p['vacuum'], bool): raise ValueError('vacuum must be a boolean')
    for key in ['skin','hair','accent','eyes']:
        if not isinstance(p[key], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',p[key]):
            raise ValueError(f'{key} must be a six-digit hex color')
    p['costume']=costume_parameters(p['costume'])
    if p['vacuum'] and p['costume']: raise ValueError('costume layers apply to unsuited characters')
    return p

def mix(a,b,t): return a+(b-a)*t
def gauss(x,y,cx,cy,sx,sy): return math.exp(-((x-cx)/sx)**2-((y-cy)/sy)**2)

def interpolate(rows, subdivisions=4):
    """Bounded cubic interpolation avoids overshooting positive cross sections."""
    result=[]
    for i in range(len(rows)-1):
        a,b=rows[i],rows[i+1]
        prev=rows[max(0,i-1)]; nxt=rows[min(len(rows)-1,i+2)]
        for j in range(subdivisions):
            t=j/subdivisions
            row=[]
            for k in range(len(a)):
                value=.5*((2*a[k])+(-prev[k]+b[k])*t+(2*prev[k]-5*a[k]+4*b[k]-nxt[k])*t*t+(-prev[k]+3*a[k]-3*b[k]+nxt[k])*t*t*t)
                row.append(max(min(a[k],b[k]),min(max(a[k],b[k]),value)))
            result.append(tuple(row))
    return result+[tuple(rows[-1])]

class Meshes:
    def __init__(self): self.parts=[]; self.lofts={}
    def mesh(self,name,vertices,faces,color,roughness=.65,metalness=0):
        self.parts.append(dict(name=name,vertices=vertices,faces=faces,color=color,roughness=roughness,metalness=metalness))
    def rings(self,name,rows,color,axis='y',segments=32,smooth=4):
        # rows: axial coordinate, center U, center V, radius U, radius V
        self.lofts[name]=rows
        rows=interpolate(rows,smooth); verts=[]
        for a,u,v,ru,rv in rows:
            for j in range(segments):
                angle=j*math.tau/segments
                point=(u+ru*math.cos(angle),a,v+rv*math.sin(angle))
                if axis=='z': point=(point[0],point[2],point[1])
                verts.append(point)
        faces=[]
        for i in range(len(rows)-1):
            for j in range(segments):
                a=i*segments+j; b=i*segments+(j+1)%segments
                faces.append((a,a+segments,b+segments,b))
        faces += [tuple(range(segments)),tuple(reversed(range((len(rows)-1)*segments,len(verts))))]
        if axis=='z': faces=[tuple(reversed(f)) for f in faces]
        self.mesh(name,verts,faces,color)
    def ellipsoid(self,name,center,radius,color):
        rows=[]
        for i in range(25):
            a=-math.pi/2+math.pi*(.001+.998*i/24)
            rows.append((center[1]+radius[1]*math.sin(a),center[0],center[2],radius[0]*math.cos(a),radius[2]*math.cos(a)))
        self.rings(name,rows,color,segments=32,smooth=1)
    def tube(self,name,points,radii,color):
        # Parallel-transport helper is deliberately not required by pure geometry().
        # Build short curve cross sections in a stable local frame.
        rows=interpolate([(*p,r) for p,r in zip(points,radii)],5)
        verts=[]; n=12
        for i,(*p,r) in enumerate(rows):
            a=rows[max(0,i-1)]; b=rows[min(len(rows)-1,i+1)]
            tangent=[b[k]-a[k] for k in range(3)]; length=math.hypot(*tangent)
            tangent=[v/length for v in tangent]
            axis=(0,0,1) if abs(tangent[2])<.9 else (1,0,0)
            u=(tangent[1]*axis[2]-tangent[2]*axis[1],tangent[2]*axis[0]-tangent[0]*axis[2],tangent[0]*axis[1]-tangent[1]*axis[0])
            length=math.hypot(*u); u=[v/length for v in u]
            v=(tangent[1]*u[2]-tangent[2]*u[1],tangent[2]*u[0]-tangent[0]*u[2],tangent[0]*u[1]-tangent[1]*u[0])
            for j in range(n):
                t=j*math.tau/n
                verts.append(tuple(p[k]+r*(u[k]*math.cos(t)+v[k]*math.sin(t)) for k in range(3)))
        faces=[(i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j) for i in range(len(rows)-1) for j in range(n)]
        faces += [tuple(reversed(range(n))),tuple(range((len(rows)-1)*n,len(verts)))]
        self.mesh(name,verts,faces,color)

def face_shape(x,y,rx,ry,rz):
    """Front of one continuous head: orbit, cheek, nose bridge, lips and chin."""
    X=x/rx; Y=y/ry
    jaw=1-.20*max(0,-Y)**.8
    base=rz*math.sqrt(max(0,1-(X/jaw)**2-Y*Y))
    relief=0
    for side in [-1,1]:
        relief-=.115*gauss(X,Y,side*.36,.14,.28,.20)  # orbital recess
        relief+=.075*gauss(X,Y,side*.48,-.13,.27,.24) # cheek bone
        relief+=.055*gauss(X,Y,side*.35,.35,.31,.13)  # brow ridge
        relief+=.09*gauss(X,Y,side*.13,-.15,.10,.095) # alar wing
    relief+=.19*gauss(X,Y,0,.12,.105,.36)            # bridge
    relief+=.32*gauss(X,Y,0,-.085,.15,.14)           # nose tip
    relief+=.047*gauss(X,Y,0,-.31,.29,.06)           # upper lip
    relief+=.065*gauss(X,Y,0,-.40,.27,.07)           # lower lip
    relief+=.075*gauss(X,Y,0,-.67,.36,.18)           # chin
    return base+rz*relief

def anatomy_head(m,cx,cy,cz,rx,ry,rz,skin,hair,eye_color,style,alien=False):
    verts=[]; faces=[]; n=96; count=64
    for i in range(count+1):
        lat=-math.pi/2+math.pi*(.0001+.9998*i/count)
        Y=math.sin(lat); jaw=1-.20*max(0,-Y)**.8
        for j in range(n):
            t=math.tau*j/n; x=rx*math.cos(lat)*math.cos(t)*jaw; y=ry*Y
            z=rz*math.cos(lat)*math.sin(t)
            if math.sin(t)>0:
                base=rz*math.sqrt(max(0,1-(x/(rx*jaw))**2-Y*Y))
                z+=(face_shape(x,y,rx,ry,rz)-base)*math.sin(t)**4
            verts.append((cx+x,cy+y,cz+z))
    faces=[(i*n+j,(i+1)*n+j,(i+1)*n+(j+1)%n,i*n+(j+1)%n) for i in range(count) for j in range(n)]
    faces += [tuple(range(n)),tuple(reversed(range(count*n,(count+1)*n)))]
    m.mesh('face',verts,faces,skin)
    def surface(x,y,offset=0): return (cx+x,cy+y,cz+face_shape(x,y,rx,ry,rz)+offset)
    eye_centers=[(-.36*rx,.14*ry,'left'),(.36*rx,.14*ry,'right')]
    if alien: eye_centers.append((0,.49*ry,'crown'))
    for ex,ey,name in eye_centers:
        w=rx*(.25 if name=='crown' else .30); eh=ry*.102
        def eye_point(u,v):
            x=ex+u*w; y=ey+v*eh*max(0,1-u*u)**.65
            return surface(x,y,.002+rx*.043*max(0,1-u*u)*(1-v*v))
        ev=[]; ef=[]; nu=32; nv=12
        for j in range(nv+1):
            for i in range(nu+1): ev.append(eye_point(-.999+1.998*i/nu,-1+2*j/nv))
        for j in range(nv):
            for i in range(nu):
                a=j*(nu+1)+i; ef.append((a,a+1,a+nu+2,a+nu+1))
        m.mesh(name+'-eye-white',ev,ef,'#efece0')
        def eye_surface(dx,dy,offset):
            u=dx/w; v=dy/(eh*max(.01,1-u*u)**.65)
            return surface(ex+dx,ey+dy,.002+rx*.043*max(0,1-u*u)*(1-v*v)+offset)
        def eye_disk(suffix,rw,rh,offset,color):
            dv=[eye_surface(0,0,offset)];df=[];n=40
            for ring in range(1,7):
                for j in range(n):
                    t=j*math.tau/n;dv.append(eye_surface(rw*ring/6*math.cos(t),rh*ring/6*math.sin(t),offset))
            for j in range(n): df.append((0,1+j,1+(j+1)%n))
            for ring in range(5):
                for j in range(n):
                    a=1+ring*n+j;b=1+ring*n+(j+1)%n;df.append((a,a+n,b+n,b))
            m.mesh(name+suffix,dv,df,color)
        eye_disk('-iris',eh*.73,eh*.88,.0015,eye_color)
        eye_disk('-pupil',eh*.35,eh*.55,.002,'#172634')
        m.ellipsoid(name+'-catchlight',eye_surface(-rx*.02,ry*.023,.003),(rx*.012,ry*.012,.001),'#ffffff')
        for upper in [True,False]:
            points=[eye_point(-.98+1.96*i/16,1 if upper else -1) for i in range(17)]
            m.tube(name+('-upper-eyelid' if upper else '-lower-eyelid'),points,[rx*.028]*17,skin)
            if upper: m.tube(name+'-lash',[(x,y-.001,z+.0015) for x,y,z in points],[rx*.011]*17,'#453b3e')
        brow=[surface(ex+w*u,ey+eh*2.05+(1-u*u)*.005,.003) for u in [-1,-.7,-.35,0,.35,.7,1]]
        m.tube(name+'-brow',brow,[rx*v for v in [.007,.019,.026,.028,.025,.017,.003]],hair)
    # Lip line with corners and cupid's bow follows the same face surface.
    mouth=[]
    for i in range(21):
        u=-1+2*i/20; y=ry*(-.35+.025*abs(u)+.028*u*u)
        mouth.append(surface(u*rx*.30,y,.0015))
    m.tube('mouth-line',mouth,[rx*(.005+.006*math.sin(math.pi*i/20)) for i in range(21)],'#794b47' if not alien else '#65526e')
    lip_color='#'+''.join(f'{round(int(skin[i:i+2],16)*.80+v*.20):02x}' for i,v in zip((1,3,5),(180,105,100)))
    for upper in [True,False]:
        points=[]
        for i in range(17):
            u=-.93+1.86*i/16
            y=ry*(-.35+.025*abs(u)+.028*u*u)+(1-u*u)*ry*(.021 if upper else -.028)
            points.append(surface(u*rx*.30,y,.002))
        m.tube('upper-lip' if upper else 'lower-lip',points,[rx*(.002+.016*math.sin(math.pi*i/16)) for i in range(17)],lip_color)
    for side,name in [(-1,'left'),(1,'right')]:
        nostril=[surface(side*rx*(.095+.06*i/6),ry*(-.155+.012*math.sin(i*math.pi/6)),.001) for i in range(7)]
        m.tube(name+'-nostril',nostril,[rx*.009]*7,'#714c49' if not alien else '#65526e')
        # Ear body and raised helix, with an inset concha.
        m.ellipsoid(name+'-ear',(cx+side*rx*.96,cy-.012,cz),(rx*.24,ry*.29,rz*.24),skin)
        m.ellipsoid(name+'-ear-concha',(cx+side*rx*1.065,cy-.012,cz+rz*.17),(rx*.115,ry*.18,.008),'#a26758' if not alien else '#748780')
        points=[(cx+side*rx*(1.02+.16*math.cos(t)),cy-.01+ry*.23*math.sin(t),cz+rz*.2) for t in [(-1.5+i*5.1/20) for i in range(21)]]
        m.tube(name+'-ear-helix',points,[rx*.025]*21,skin)
    if alien:
        for side in [-1,1]:
            points=[(cx+side*rx*.58,cy+ry*.72,cz-.015),(cx+side*rx*.82,cy+ry*1.15,cz-.03),(cx+side*rx*1.2,cy+ry*1.23,cz-.02)]
            m.tube('sensory-frond-'+str(side),points,[rx*.10,rx*.075,rx*.018],skin)
    else:
        # Scalp cap has a shaped hairline, exposed forehead, temples and occiput.
        hv=[]; hf=[]; hn=64; hm=20
        for i in range(hm+1):
            for j in range(hn):
                t=math.tau*j/hn; front=max(0,math.sin(t)); end=mix(1.85,1.00,front**3)
                a=.002+(end-.002)*i/hm
                hv.append((cx+(rx+.009)*math.sin(a)*math.cos(t),cy+(ry+.012)*math.cos(a),cz+(rz+.011)*math.sin(a)*math.sin(t)))
        hf=[(i*hn+j,(i+1)*hn+j,(i+1)*hn+(j+1)%hn,i*hn+(j+1)%hn) for i in range(hm) for j in range(hn)]
        m.mesh('hair-cap',hv,hf,hair)
        for i in range(6):
            x=rx*(-.85+i*.30)
            points=[(cx+x*.5,cy+ry*.91,cz+rz*.45),(cx+x,cy+ry*.61,cz+rz*.86),(cx+x+rx*.18,cy+ry*(.34+.09*(i%3)),cz+rz*.91)]
            m.tube('swept-hair-lock-'+str(i),points,[rx*.16,rx*.17,rx*.012],hair)
        if style=='female':
            points=[(cx,cy+ry*.1,cz-rz*.95),(cx+.025,cy-ry*.52,cz-rz*1.3),(cx+.04,cy-ry*1.17,cz-rz*1.35)]
            m.tube('tied-hair',points,[rx*.46,rx*.35,rx*.09],hair)

def landmarks(values=None):
    """Shared body measurements for geometry, bindings and gait; metres, Y up."""
    p=parameters({} if values is None else values)
    h=p['height']; child=p['age']=='child'; alien=p['species']=='alien';s=h/1.82
    head_h=(.46 if child else .365)*s*(1.08 if alien else 1)
    rx=head_h*(.43 if alien else .405); ry=head_h/2; rz=head_h*.355
    head_y=h-ry-.014*s-(.04*s if alien else 0)
    shoulder_y=head_y-ry-.105*s; hip_y=h*(.43 if child else .48)
    shoulder_w=(.405 if p['presentation']=='female' else .445)*s
    if child: shoulder_w*=.94
    hip_w=(.35 if p['presentation']=='female' else .335)*s
    chest_y=mix(hip_y,shoulder_y,.72); waist_y=mix(hip_y,shoulder_y,.28)
    return dict(h=h,s=s,child=child,alien=alien,rx=rx,ry=ry,rz=rz,head_y=head_y,shoulder_y=shoulder_y,hip_y=hip_y,shoulder_w=shoulder_w,hip_w=hip_w,chest_y=chest_y,waist_y=waist_y)

# --- Garment layers and work boots -------------------------------------------
# A costume dresses the same body in layered clothes. Slots are optional except
# that a costume needs a shirt or hoodie and exactly one of overalls/trousers.
# costume=None keeps the fitted flight garment. Colors are six-digit hex; a None
# default marks an optional detail (badge, cuffs, trim).
COSTUME_SLOTS=dict(
    shirt=dict(color='#e8e2d0'),
    jacket=dict(color='#c8672e',badge=None),
    hoodie=dict(color='#5c7d4a',trim='#e0873a',badge=None),
    overalls=dict(color='#3a6f86',cuffs=None,cargo=False,buttons='#c9ccd0'),
    trousers=dict(color='#263b51',cuffs=None,cargo=False),
    belt=dict(color='#4a3426',buckle='#b9bec4',pouches=0,pouch='#6a5638'),
    backpack=dict(color='#3a3a3e',straps='#2d2a2c'),
    gloves=dict(color='#3a3436',trim=None),
    boots=dict(color='#56565c',sole='#2b2a2e',toe='#48484e',laces='#e08a3a',collar='#6c5d50'),
    neck_ring=dict(color='#9aa1a8'),
)
BODY_LOFTS=['tailored-torso','trouser-yoke','left-leg','right-leg','left-sleeve','right-sleeve','neck']

def costume_parameters(value):
    """Validate a costume and fill each slot's defaults; idempotent on its own output."""
    if value is None: return None
    if not isinstance(value,dict) or set(value)-set(COSTUME_SLOTS):
        raise ValueError('costume must map known garment slots to field dicts')
    result={}
    for slot,fields in value.items():
        schema=COSTUME_SLOTS[slot]
        if not isinstance(fields,dict) or set(fields)-set(schema): raise ValueError(f'costume {slot} has unknown fields')
        layer=dict(schema,**fields)
        for key,v in layer.items():
            if key=='pouches': ok=isinstance(v,int) and not isinstance(v,bool) and 0<=v<=4
            elif key=='cargo': ok=isinstance(v,bool)
            else: ok=(v is None and schema[key] is None) or (isinstance(v,str) and re.fullmatch(r'#[0-9a-fA-F]{6}',v))
            if not ok: raise ValueError(f'costume {slot}.{key} is invalid')
        result[slot]=layer
    if 'shirt' not in result and 'hoodie' not in result: raise ValueError('costume needs a shirt or hoodie')
    if 'jacket' in result and ('shirt' not in result or 'hoodie' in result): raise ValueError('a jacket goes over a shirt, not a hoodie')
    if ('overalls' in result)==('trousers' in result): raise ValueError('costume needs exactly one of overalls or trousers')
    return result

def shade(color,k):
    return '#'+''.join(f'{max(0,min(255,round(int(color[i:i+2],16)*k))):02x}' for i in (1,3,5))
def vadd(a,b): return tuple(x+y for x,y in zip(a,b))
def vsub(a,b): return tuple(x-y for x,y in zip(a,b))
def vscale(a,k): return tuple(x*k for x in a)
def vcross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def vunit(a):
    n=math.hypot(*a); return tuple(x/n for x in a)
def smooth01(lo,hi,v):
    t=max(0,min(1,(v-lo)/(hi-lo))); return t*t*(3-2*t)

class BodySurface:
    """Implicit union of ring lofts: negative inside, positive outside, zero on the skin.

    Garment layers raycast onto it, so a slab's inner face sits inside the body and its
    outer face follows the surface normal. Lofts use the same interpolation as rings().
    """
    def __init__(self,lofts):
        named=lofts if isinstance(lofts,dict) else {i:rows for i,rows in enumerate(lofts)}
        self.pieces={}
        for name,rows in named.items():
            fine=interpolate(rows,4); self.pieces[name]=([r[0] for r in fine],fine)
    def start(self,name): return self.pieces[name][0][0]
    def section(self,name,a):
        """(axial, centre u, centre v, radius u, radius v) of one loft at axial coordinate a."""
        keys,rows=self.pieces[name]
        if a<=keys[0]: return rows[0]
        if a>=keys[-1]: return rows[-1]
        i=bisect.bisect_right(keys,a); p,q=rows[i-1],rows[i]; t=(a-p[0])/(q[0]-p[0])
        return tuple(mix(x,y,t) for x,y in zip(p,q))
    def value(self,point):
        x,y,z=point; best=1e9
        for name,(keys,rows) in self.pieces.items():
            _,u,v,ru,rv=self.section(name,y)
            best=min(best,max(math.hypot((x-u)/ru,(z-v)/rv)-1,max(keys[0]-y,y-keys[-1])/.02))
        return best
    def normal(self,point,eps=5e-4):
        gradient=[]
        for axis in range(3):
            step=tuple(eps if k==axis else 0 for k in range(3))
            gradient.append(self.value(vadd(point,step))-self.value(vsub(point,step)))
        return vunit(gradient)
    def cast(self,origin,direction,limit=.6,step=.004):
        """First point where a ray from inside the body reaches the skin."""
        direction=vunit(direction); at=lambda t: vadd(origin,vscale(direction,t))
        if self.value(origin)>=0: raise ValueError('garment ray must start inside the body')
        lo=t=0
        while t<limit:
            t+=step
            if self.value(at(t))>=0:
                hi=t
                for _ in range(24):
                    mid=(lo+hi)/2
                    if self.value(at(mid))>=0: hi=mid
                    else: lo=mid
                return at(hi)
            lo=t
        raise ValueError('garment ray never leaves the body')

def layer_patch(m,body,name,color,rays,thickness,lift=0,embed=.004,rim=.45,wrap=False,roughness=.85,metalness=0):
    """Closed garment slab raycast onto the body; rays[i][j]=(origin,direction).

    i runs across the patch and j along it; wrap joins the i ends into a band. The inner
    face sits `embed` inside the skin, so a layer never floats. The outer face stands
    lift+thickness out along the surface normal and eases to `rim` of the thickness at
    open edges, so patches read as sewn cloth rather than cut plates. lift may be a
    function of (i, j) for layers stacked over other layers.
    """
    nu=len(rays); nv=len(rays[0]); outer=[]; inner=[]
    for i in range(nu):
        for j in range(nv):
            origin,direction=rays[i][j]
            p=body.cast(origin,direction); n=body.normal(p)
            base=lift(i,j) if callable(lift) else lift
            edge=min(j,nv-1-j) if wrap else min(i,nu-1-i,j,nv-1-j)
            outer.append(vadd(p,vscale(n,base+thickness*(rim,.82,1)[min(edge,2)])))
            inner.append(vadd(p,vscale(n,-embed)))
    count=nu*nv; index=lambda i,j: (i%nu)*nv+j; faces=[]
    for i in range(nu if wrap else nu-1):
        for j in range(nv-1):
            quad=(index(i,j),index(i+1,j),index(i+1,j+1),index(i,j+1))
            faces.append(quad); faces.append(tuple(k+count for k in reversed(quad)))
    directed={(a,b) for f in faces[::2] for a,b in zip(f,f[1:]+f[:1])}
    for a,b in sorted(e for e in directed if (e[1],e[0]) not in directed):
        faces.append((b,a,a+count,b+count))
    m.mesh(name,outer+inner,faces,color,roughness,metalness)

def loop_tube(m,name,points,radius,color,segments=10,roughness=.8):
    """Closed tube through a loop of points (a padded collar or rolled edge)."""
    verts=[]; n=len(points)
    for k,p in enumerate(points):
        tangent=vunit(vsub(points[(k+1)%n],points[k-1]))
        u=vunit(vcross(tangent,(0,1,0) if abs(tangent[1])<.9 else (1,0,0))); v=vcross(tangent,u)
        for j in range(segments):
            t=j*math.tau/segments
            verts.append(vadd(p,vadd(vscale(u,radius*math.cos(t)),vscale(v,radius*math.sin(t)))))
    faces=[(k*segments+j,k*segments+(j+1)%segments,((k+1)%n)*segments+(j+1)%segments,((k+1)%n)*segments+j)
           for k in range(n) for j in range(segments)]
    m.mesh(name,verts,faces,color,roughness)

def merge_parts(m,start,name):
    """Join parts[start:] into one named mesh with the first part's finish."""
    pieces=m.parts[start:]; del m.parts[start:]; verts=[]; faces=[]
    for part in pieces:
        offset=len(verts); verts+=part['vertices']; faces+=[tuple(i+offset for i in f) for f in part['faces']]
    m.mesh(name,verts,faces,pieces[0]['color'],pieces[0]['roughness'],pieces[0]['metalness'])

def _profile(points,z):
    rows=interpolate(points,8)
    if z<=rows[0][0]: return rows[0][1]
    for a,b in zip(rows,rows[1:]):
        if z<=b[0]: return mix(a[1],b[1],(z-a[0])/(b[0]-a[0]))
    return rows[-1][1]

# Work boot in unit-height metres (x half width, heel -z, toe +z, sole at y=0).
BOOT_HEEL,BOOT_TOE,BOOT_HEEL_ROUND,BOOT_TOE_ROUND=-.105,.245,.05,.075
BOOT_WIDTH=[(-.105,.054),(-.06,.058),(0,.059),(.07,.061),(.15,.067),(.20,.064),(.245,.058)]
BOOT_TOP=[(-.105,.085),(-.092,.15),(-.078,.19),(-.058,.205),(.058,.205),(.083,.172),(.112,.132),(.15,.108),(.195,.098),(.225,.088),(.245,.068)]
BOOT_SOLE=[(-.105,.056),(-.088,.047),(-.06,.042),(-.03,.040),(0,.033),(.08,.030),(.15,.032),(.2,.040),(.232,.050),(.245,.054)]
BOOT_ARCH=[(-.105,0),(-.036,0),(-.024,.007),(.07,.006),(.108,0),(.245,0)]
BOOT_TOE_CAP=.168

def boot_section(z):
    """Half width, sole-rim height, top height, arch lift and cross-section exponent at z."""
    width=_profile(BOOT_WIDTH,z)
    if z<BOOT_HEEL+BOOT_HEEL_ROUND: width*=math.sqrt(max(0,1-((BOOT_HEEL+BOOT_HEEL_ROUND-z)/BOOT_HEEL_ROUND)**2))
    if z>BOOT_TOE-BOOT_TOE_ROUND: width*=math.sqrt(max(0,1-((z-BOOT_TOE+BOOT_TOE_ROUND)/BOOT_TOE_ROUND)**2))
    sole=_profile(BOOT_SOLE,z); top=max(sole+.012,_profile(BOOT_TOP,z))
    return width,sole,top,max(0,_profile(BOOT_ARCH,z)),mix(3.6,2.4,smooth01(.06,.2,z))

def boot_top_point(z,x):
    """Point on the upper at lateral offset x (unit scale), and its outward normal in y-z."""
    width,sole,top,_,exponent=boot_section(z)
    c=min(1,abs(x)/width)**(exponent/2); y=sole+(top-sole)*math.sqrt(1-c*c)**(2/exponent)
    slope=(boot_section(z+.002)[2]-boot_section(z-.002)[2])/.004
    return (x,y,z),vunit((0,1,-slope))

def work_boot(m,label,lx,side,s,colors):
    """Chunky work boot: one lofted surface split into an upper, a toe cap and an outsole.

    The outsole is the lower band of the same surface: it shares its rim vertices with
    the upper, wraps up the heel and toe, carries a heel block ahead of a recessed arch
    and has a planar tread at y=0 whose heel and toe vertices are the gait's pivots.
    Nothing flares past the upper's outline. The shaft reaches above the ankle.
    """
    stations=[]
    for k in range(7):
        phi=.14+(math.pi/2-.14)*k/6; stations.append(BOOT_HEEL+BOOT_HEEL_ROUND*(1-math.cos(phi)))
    a,b=BOOT_HEEL+BOOT_HEEL_ROUND,BOOT_TOE-BOOT_TOE_ROUND; n=math.ceil((b-a)/.011)
    stations+=[mix(a,b,k/n) for k in range(1,n)]
    for k in range(6,-1,-1):
        phi=.14+(math.pi/2-.14)*k/6; stations.append(BOOT_TOE-BOOT_TOE_ROUND*(1-math.cos(phi)))
    upper_count=16
    def section(z):
        width,sole,top,arch,exponent=boot_section(z); e=2/exponent
        loop=[]
        for k in range(upper_count+1):
            t=math.pi*k/upper_count; c=math.cos(t)
            loop.append((width*math.copysign(abs(c)**e,c),sole+(top-sole)*abs(math.sin(t))**e))
        chamfer=.008; tread=max(width*.35,width-chamfer/math.tan(math.radians(58)))
        loop+=[(-width,mix(sole,arch+chamfer,.5)),(-width,arch+chamfer),(-tread,arch),(-tread/2,arch),(0,arch),
               (tread/2,arch),(tread,arch),(width,arch+chamfer),(width,mix(arch+chamfer,sole,.5))]
        shift=-side*.010*smooth01(.08,BOOT_TOE,z)
        return [((lx/s+shift+x)*s,y*s,z*s) for x,y in loop]
    rings=[section(z) for z in stations]
    toe=next(i for i,z in enumerate(stations) if z>=BOOT_TOE_CAP)
    sole_loop=list(range(upper_count,len(rings[0])))+[0]
    def band(name,first,last,loop,color,roughness):
        verts=[rings[i][k] for i in range(first,last+1) for k in loop]; w=len(loop); faces=[]
        for i in range(last-first):
            for k in range(w-1): faces.append((i*w+k,(i+1)*w+k,(i+1)*w+k+1,i*w+k+1))
        if first==0: faces.append(tuple(range(w)))
        if last==len(rings)-1: faces.append(tuple(range((last-first)*w,(last-first+1)*w)))
        m.mesh(name,verts,faces,color,roughness)
    upper_loop=list(range(upper_count+1))
    band(label+'-boot',0,toe,upper_loop,colors['color'],.7)
    band(label+'-boot-toe-cap',toe,len(rings)-1,upper_loop,colors['toe'],.62)
    band(label+'-outsole',0,len(rings)-1,sole_loop,colors['sole'],.9)
    # Padded collar hugs the shaft opening where the leg enters.
    collar=[]
    for k in range(28):
        t=k*math.tau/28; z=-.007+.066*math.sin(t); width,_,top,_,_=boot_section(z)
        collar.append(((lx/s+(width-.005)*math.cos(t))*s,(min(top,.205)-.004)*s,z*s))
    loop_tube(m,label+'-boot-collar',collar,.013*s,colors['collar'])
    if colors['laces']:
        rows=[mix(.064,.124,k/4) for k in range(5)]
        def eyelet(z,x):
            point,normal=boot_top_point(z,x)
            return vscale(vadd((lx/s+point[0],point[1],point[2]),vscale(normal,.004)),s)
        start=len(m.parts)
        for k in range(4):
            for x0 in [-.021,.021]:
                a,b=eyelet(rows[k],x0),eyelet(rows[k+1],-x0)
                m.tube(label+'-lace-'+str(k)+str(x0),[a,vadd(vscale(vadd(a,b),.5),(0,.002*s,.002*s)),b],[.0042*s]*3,colors['laces'])
        m.tube(label+'-lace-bar',[eyelet(rows[0],-.021),eyelet(rows[0],0),eyelet(rows[0],.021)],[.0042*s]*3,colors['laces'])
        merge_parts(m,start,label+'-boot-laces')
        start=len(m.parts)
        for z in rows:
            for x0 in [-.024,.024]: m.ellipsoid(label+'-eyelet',eyelet(z,x0),(.0055*s,.0055*s,.0055*s),'#b9bec4')
        merge_parts(m,start,label+'-boot-eyelets'); m.parts[-1].update(roughness=.35,metalness=.7)

def dress(m,costume,d):
    """Layer the costume over the body lofts already in m (Y up, +z front)."""
    body=BodySurface({name:m.lofts[name] for name in BODY_LOFTS})
    s=d['s'];hip=d['hip_y'];sh=d['shoulder_y'];sw=d['shoulder_w'];hw=d['hip_w'];chest=d['chest_y']
    wrist=hip+.095*s; knee=hip*.53; sx=sw*.49; wx=sx+.092*s
    top=costume.get('jacket') or costume.get('hoodie') or costume['shirt']
    bottom=costume.get('overalls') or costume['trousers']
    def count(length,spacing=.012): return max(4,round(length/(spacing*s))+1)
    def torso(y): return 'tailored-torso' if y>=body.start('tailored-torso')+.004*s else 'trouser-yoke'
    def around(piece,y,t):
        _,u,v,_,_=body.section(piece,y); return ((u,y,v),(math.cos(t),0,math.sin(t)))
    def facing(y,x,back=False):
        """Ray from the torso axis reaching the front (or back) skin at lateral offset x."""
        _,u,v,ru,rv=body.section(torso(y),y); t=math.acos(max(-1,min(1,(x-u)/ru)))*(-1 if back else 1)
        return ((u,y,v),(ru*math.cos(t),0,rv*math.sin(t)))
    def front_patch(name,color,y0,y1,left,right,thickness,**options):
        nu=count(right(y1)-left(y1)); nv=count(y1-y0)
        rays=[[facing(mix(y0,y1,j/(nv-1)),mix(left(mix(y0,y1,j/(nv-1))),right(mix(y0,y1,j/(nv-1))),i/(nu-1))) for j in range(nv)] for i in range(nu)]
        layer_patch(m,body,name,color,rays,thickness*s,**options)
    def ring_band(name,color,piece,y0,y1,thickness,t0=0,t1=math.tau,**options):
        wrap=t1-t0>=math.tau-1e-9; nu=24 if wrap else max(6,round(24*(t1-t0)/math.tau)); nv=count(y1-y0,.01)
        rays=[[around(piece(mix(y0,y1,j/(nv-1))) if callable(piece) else piece,mix(y0,y1,j/(nv-1)),mix(t0,t1,i/(nu if wrap else nu-1))) for j in range(nv)] for i in range(nu)]
        layer_patch(m,body,name,color,rays,thickness*s,wrap=wrap,**options)
    def over_shoulder(name,color,x_front,x_top,x_back,y_front,y_back,width,thickness,lift):
        """Strap from the front, over the shoulder, down the back, raycast in sagittal planes."""
        origin_y=chest-.04*s
        _,_,v,_,rv=body.section('tailored-torso',y_front); front=math.atan2(y_front-origin_y,v+rv)
        _,_,v,_,rv=body.section('tailored-torso',y_back); back=math.pi+math.atan2(origin_y-y_back,rv-v)
        nv=count((back-front)*.16); rays=[]
        for i in range(4):
            row=[]
            for j in range(nv):
                phi=mix(front,back,j/(nv-1))
                x=mix(x_front,x_top,smooth01(front,math.pi/2,phi)) if phi<math.pi/2 else mix(x_top,x_back,smooth01(math.pi/2,back,phi))
                row.append(((x+mix(-width/2,width/2,i/3),origin_y,0),(0,math.sin(phi),math.cos(phi))))
            rays.append(row)
        layer_patch(m,body,name,color,rays,thickness*s,lift=lift*s)
    def surface_point(ray,offset=0):
        p=body.cast(*ray); return vadd(p,vscale(body.normal(p),offset))
    # Neck ring plate: every settler wears the tech collar.
    if 'neck_ring' in costume:
        m.ellipsoid('layer-neck-plate',(0,sh+.053*s,.074*s),(.022*s,.015*s,.007*s),shade(costume['neck_ring']['color'],.7))
        m.parts[-1].update(roughness=.35,metalness=.6)
    # Innermost visible layers first; each later layer stands proud of the ones below.
    jacket=costume.get('jacket'); hoodie=costume.get('hoodie'); overalls=costume.get('overalls')
    hem=hip+.045*s
    opening=lambda y: mix(sw*.085,sw*.2,smooth01(hem,sh,y)**.8)
    bib_top=mix(hip,sh,.74); strap_x=sw*.15
    if jacket:
        # The shirt shows in the open front and rises to the neck ring.
        neckline=lambda y: min(opening(y)+.012*s,body.section('tailored-torso',y)[3]*.62)
        front_patch('layer-shirt-front',costume['shirt']['color'],hem-.004*s,sh+.052*s,lambda y:-neckline(y),neckline,.003)
    if overalls:
        bib=lambda y: mix(hw*.27,sw*.17,smooth01(hip,bib_top,y))
        front_patch('layer-bib',overalls['color'],hip,bib_top,lambda y:-bib(y),bib,.005,lift=.004*s)
        front_patch('layer-bib-pocket',shade(overalls['color'],.9),mix(hip,bib_top,.5),mix(hip,bib_top,.86),lambda y:-sw*.075,lambda y:sw*.075,.004,lift=.009*s)
        for side,label in [(-1,'left'),(1,'right')]:
            if jacket:
                # Straps rise from the bib and run under the open jacket's lapel.
                end=bib_top+.09*s; x0=strap_x
                centre=lambda y,side=side: side*mix(x0,opening(end)+.02*s,smooth01(bib_top,end,y))
                front_patch('layer-strap-'+label,overalls['color'],bib_top-.02*s,end,lambda y,c=centre:c(y)-sw*.035,lambda y,c=centre:c(y)+sw*.035,.004,lift=.004*s)
            else:
                over_shoulder('layer-strap-'+label,overalls['color'],side*strap_x,side*sw*.23,side*sw*.12,bib_top-.02*s,hip+.08*s,sw*.07,.004,.004)
            button=surface_point(facing(bib_top-.014*s,side*strap_x),.006*s)
            m.ellipsoid('layer-bib-button-'+label,button,(.011*s,.011*s,.007*s),overalls['buttons'])
            m.parts[-1].update(roughness=.35,metalness=.6)
    if jacket:
        for side,label in [(-1,'left'),(1,'right')]:
            inner=lambda y,side=side: side*opening(y); outer=lambda y,side=side: side*(opening(y)+.03*s)
            front_patch('layer-jacket-lapel-'+label,shade(jacket['color'],.94),hem,sh+.012*s,
                        (outer if side<0 else inner),(inner if side<0 else outer),.006,lift=.005*s)
        # Turned collar on the shoulder slope, rising behind the neck.
        points=[]
        _,_,_,ru,_=body.section('tailored-torso',sh+.02*s); end=math.acos(min(1,(opening(sh)+.018*s)/ru))
        for k in range(17):
            t=mix(end,-math.pi-end,k/16); lift=.6+.4*math.cos(math.pi*k/16-math.pi/2)
            origin=(0,sh-.02*s,0); direction=(math.cos(t)*.8,.55+.25*(1-lift),math.sin(t)*.8)
            points.append(surface_point((origin,direction),.008*s))
        m.tube('layer-jacket-collar',points,[s*(.010+.008*math.sin(math.pi*k/16)) for k in range(17)],jacket['color'])
        _,u,v,ru,rv=body.section('tailored-torso',hem+.02*s); gap=math.acos(min(1,(opening(hem)+.02*s)/ru))
        ring_band('layer-jacket-hem',shade(jacket['color'],.9),torso,hem,hem+.035*s,.007,t0=math.pi-gap,t1=math.tau+gap,lift=.006*s)
        if jacket['badge']:
            m.ellipsoid('layer-jacket-badge',surface_point(around('left-sleeve',sh-.085*s,math.pi-.45)),(.006*s,.026*s,.024*s),jacket['badge'])
    if hoodie:
        points=[]
        _,_,_,ru,_=body.section('tailored-torso',sh+.02*s); end=math.acos(min(1,sw*.14/ru))
        for k in range(17):
            t=mix(end,-math.pi-end,k/16); back=math.sin(math.pi*k/16)
            points.append(surface_point(((0,sh-.02*s,0),(math.cos(t)*.8,.6-.15*back,math.sin(t)*.8)),.02*s*back+.006*s))
        m.tube('layer-hood',points,[s*(.012+.03*math.sin(math.pi*k/16)**1.5) for k in range(17)],hoodie['color'])
        drape=surface_point(facing(sh-.045*s,0,back=True))
        m.ellipsoid('layer-hood-drape',vadd(drape,(0,0,.004*s)),(sw*.2,.06*s,.02*s),shade(hoodie['color'],.92))
        zip_points=[surface_point(facing(mix(hip+.03*s,sh+.03*s,k/7),0),.0015*s) for k in range(8)]
        m.tube('layer-hoodie-zip',zip_points,[.004*s]*8,shade(hoodie['color'],.55))
        for side,label in [(-1,'left'),(1,'right')]:
            cord=[surface_point(facing(sh+mix(.015,-.09,k/4)*s,side*(.03+.004*k/4)*s),.002*s) for k in range(5)]
            m.tube('layer-hoodie-drawstring-'+label,cord,[.0035*s,.0035*s,.0035*s,.0035*s,.0055*s],hoodie['trim'])
        start=len(m.parts)
        for side in [-1,1]:
            lo,hi=sorted([side*.018*s,side*sw*.21])
            front_patch('layer-hoodie-pocket-'+str(side),shade(hoodie['color'],.95),mix(hip,sh,.12),mix(hip,sh,.36),lambda y,lo=lo:lo,lambda y,hi=hi:hi,.006,lift=.003*s)
        merge_parts(m,start,'layer-hoodie-pocket')
        ring_band('layer-hoodie-hem',shade(hoodie['color'],.85),torso,hip+.02*s,hip+.06*s,.007,lift=.002*s)
        if hoodie['badge']:
            m.ellipsoid('layer-hoodie-badge',surface_point(around('left-sleeve',sh-.085*s,math.pi-.45)),(.006*s,.026*s,.024*s),hoodie['badge'])
    for side,label in [(-1,'left'),(1,'right')]:
        ring_band('layer-'+label+'-sleeve-cuff',shade(top['color'],.86),label+'-sleeve',wrist+.004*s,wrist+.036*s,.006)
        if bottom['cargo']:
            t0=math.pi-.15 if side<0 else .15
            y0,y1=mix(knee,hip,.22),mix(knee,hip,.58)
            ring_band('layer-'+label+'-cargo-pocket',shade(bottom['color'],.93),label+'-leg',y0,y1,.011,t0=t0-.5,t1=t0+.5,rim=.35)
            ring_band('layer-'+label+'-cargo-flap',shade(bottom['color'],.8),label+'-leg',mix(y0,y1,.7),y1+.008*s,.004,t0=t0-.53,t1=t0+.53,lift=.009*s)
        if bottom['cuffs']:
            ring_band('layer-'+label+'-leg-cuff',bottom['cuffs'],label+'-leg',.2*s,.238*s,.011,rim=.6)
        else:
            ring_band('layer-'+label+'-leg-hem',shade(bottom['color'],.9),label+'-leg',.195*s,.225*s,.006,rim=.6)
    belt=costume.get('belt')
    if belt:
        ring_band('layer-belt',belt['color'],torso,hip+.004*s,hip+.042*s,.007,rim=.8,roughness=.6,
                  lift=lambda i,j: s*(.003+.007*max(0,math.sin(i*math.tau/24))**2))
        front_patch('layer-buckle',belt['buckle'],hip-.001*s,hip+.047*s,lambda y:-.024*s,lambda y:.024*s,.005,lift=.014*s,rim=.7,roughness=.35,metalness=.7)
        for k,t in enumerate([math.pi/2-1.22,math.pi/2+1.22,-math.pi/2+.6,-math.pi/2-.6][:belt['pouches']]):
            ring_band('layer-pouch-'+str(k),belt['pouch'],torso,hip-.036*s,hip+.034*s,.026,t0=t-.27,t1=t+.27,lift=.006*s,rim=.3)
            ring_band('layer-pouch-'+str(k)+'-flap',shade(belt['pouch'],.78),torso,hip-.01*s,hip+.034*s,.006,t0=t-.28,t1=t+.28,lift=.03*s,rim=.9)
    pack=costume.get('backpack')
    if pack:
        for side,label in [(-1,'left'),(1,'right')]:
            over_shoulder('layer-pack-strap-'+label,pack['straps'],side*sw*.2,side*sw*.25,side*sw*.17,mix(hip,sh,.42),mix(hip,sh,.6),sw*.075,.007,.012)
        y0,y1=mix(hip,sh,.22),mix(hip,sh,.92); back=surface_point(facing(mix(y0,y1,.5),0,back=True))[2]
        width=sw*.3; depth=.11*s; c=back-depth*.5+.012*s
        m.rings('layer-backpack',[(y0,0,c+.01*s,width*.72,depth*.38),(y0+.035*s,0,c,width,depth*.5),(y1-.05*s,0,c,width*.97,depth*.5),(y1,0,c+.012*s,width*.7,depth*.34)],pack['color'])
        m.ellipsoid('layer-backpack-pocket',(0,mix(y0,y1,.32),c-depth*.5+.004*s),(width*.62,(y1-y0)*.2,.02*s),shade(pack['color'],.85))
    gloves=costume.get('gloves')
    if gloves:
        for side,label in [(-1,'left'),(1,'right')]:
            x=side*wx; start=len(m.parts)
            m.rings(label+'-hand-glove',[(wrist-.07*s,x,.066*s,.044*s,.026*s),(wrist-.05*s,x,.067*s,.048*s,.03*s),(wrist-.012*s,x,.06*s,.037*s,.032*s),(wrist+.016*s,x,.055*s,.044*s,.045*s)],gloves['color'])
            m.tube(label+'-glove-thumb',[(side*(wx-.022*s),wrist-.035*s,.068*s),(side*(wx-.042*s),wrist-.045*s,.08*s)],[.022*s,.018*s],gloves['color'])
            merge_parts(m,start,label+'-hand-glove')
            if gloves['trim']:
                m.rings(label+'-hand-glove-strap',[(wrist-.004*s,x,.058*s,.041*s,.036*s),(wrist+.01*s,x,.056*s,.043*s,.04*s)],gloves['trim'])

def geometry(values=None,meshes=None):
    p=parameters({} if values is None else values); m=Meshes() if meshes is None else meshes; dims=landmarks(p)
    s=dims['s'];h=dims['h'];child=dims['child'];alien=dims['alien'];eva=p['vacuum']
    rx,ry,rz,head_y,shoulder_y,hip_y,shoulder_w,hip_w,chest_y,waist_y=(dims[k] for k in ['rx','ry','rz','head_y','shoulder_y','hip_y','shoulder_w','hip_w','chest_y','waist_y'])
    skin=p['skin'];accent=p['accent'];navy='#263b51';ivory='#dfdfcc'
    body=ivory if eva else accent; trouser=ivory if eva else navy
    costume=p['costume']
    if costume:
        body=(costume.get('jacket') or costume.get('hoodie') or costume['shirt'])['color']
        trouser=(costume.get('overalls') or costume['trousers'])['color']
    ring=costume.get('neck_ring') if costume else None
    # Outer garments add ease over the body: a jacket or hoodie is roomier than a
    # fitted shirt, and work trousers hang looser below the knee than a flight suit.
    loose_top=bool(costume and (costume.get('jacket') or costume.get('hoodie')))
    def ease(rows,k,add,below=9,above=-9):
        return [(a,u,v,ru*k+add*s,rv*k+add*s) if above<=a<below else (a,u,v,ru,rv) for a,u,v,ru,rv in rows]
    top_ease=(lambda rows: ease(rows,1.04,.008,below=shoulder_y+.03*s)) if loose_top else (lambda rows: rows)
    leg_ease=(lambda rows: ease(rows,1.07,.006,above=.26*s)) if costume else (lambda rows: rows)
    m.rings('tailored-torso',top_ease([(hip_y+.026*s,0,0,hip_w*.47,.105*s),(hip_y+.04*s,0,0,hip_w*.5,.11*s),(waist_y,0,0,hip_w*.41,.096*s),(chest_y,0,.005*s,shoulder_w*.46,.115*s),(shoulder_y,0,0,shoulder_w*.50,.094*s),(shoulder_y+.065*s,0,0,.075*s,.065*s)]),body)
    m.rings('neck',[(shoulder_y+.02*s,0,0,.053*s,.051*s),(head_y-ry*.55,0,0,.058*s,.053*s)],skin)
    m.rings('collar',[(shoulder_y+.038*s,0,0,.076*s,.071*s),(shoulder_y+.068*s,0,0,.071*s,.067*s)],ring['color'] if ring else navy)
    if ring: m.parts[-1].update(roughness=.4,metalness=.55)
    if not costume: m.rings('waist-belt',[(hip_y+.02*s,0,0,hip_w*.502,.113*s),(hip_y+.058*s,0,0,hip_w*.488,.112*s)],navy)
    m.rings('trouser-yoke',[(hip_y-.083*s,0,0,hip_w*.44,.080*s),(hip_y-.015*s,0,0,hip_w*.51,.11*s),(hip_y+.035*s,0,0,hip_w*.49,.109*s)],trouser)
    if not costume:
        # A small rounded control panel is embedded in the fitted flight garment.
        m.ellipsoid('chest-terminal',(-.065*s,chest_y,.115*s),(.049*s,.065*s,.017*s),navy)
        m.ellipsoid('chest-readout',(-.065*s,chest_y+.012*s,.133*s),(.034*s,.025*s,.004*s),'#75d5d0')
        m.tube('front-fastener',[(.025*s,hip_y+.1*s,.11*s),(.025*s,chest_y,.124*s),(.025*s,shoulder_y,.097*s)],[.003*s]*3,navy)
    boots=costume.get('boots',COSTUME_SLOTS['boots']) if costume else COSTUME_SLOTS['boots']
    if eva: boots=dict(color=ivory,sole=navy,toe=shade(ivory,.9),laces=None,collar=navy)
    for side,label in [(-1,'left'),(1,'right')]:
        lx=side*.096*s; knee_y=hip_y*.53
        m.rings(label+'-leg',leg_ease([(.15*s,lx,-.006*s,.04*s,.045*s),(.27*s,lx,-.006*s,.052*s,.06*s),(knee_y-.08*s,lx,-.014*s,.066*s,.068*s),(knee_y,lx,.015*s,.059*s,.061*s),(hip_y-.20*s,lx,0,.083*s,.087*s),(hip_y-.025*s,lx,0,.097*s,.103*s),(hip_y+.035*s,lx,0,.084*s,.084*s)]),trouser)
        if not costume: m.ellipsoid(label+'-knee-panel',(lx,knee_y,.081*s),(.047*s,.063*s,.013*s),accent)
        work_boot(m,label,lx,side,s,boots)
        # Tapered sleeve contours include deltoid, elbow and forearm.
        wrist_y=hip_y+.095*s; elbow_y=mix(wrist_y,shoulder_y,.49)
        sx=shoulder_w*.49; wx=sx+.092*s
        m.rings(label+'-sleeve',(lambda rows: ease(rows,1.05,.006) if loose_top else rows)([(wrist_y,side*wx,.055*s,.038*s,.039*s),(elbow_y-.06*s,side*(wx-.009*s),.03*s,.048*s,.047*s),(elbow_y,side*(wx-.015*s),.012*s,.045*s,.047*s),(elbow_y+.1*s,side*(sx+.033*s),0,.062*s,.063*s),(shoulder_y-.022*s,side*sx,0,.073*s,.077*s),(shoulder_y+.026*s,side*(sx-.05*s),0,.06*s,.06*s)]),body)
        if not costume: m.rings(label+'-wrist-seal',[(wrist_y-.009*s,side*wx,.055*s,.041*s,.043*s),(wrist_y+.025*s,side*wx,.052*s,.042*s,.044*s)],navy)
        hand_color=ivory if eva else skin
        m.rings(label+'-palm',[(wrist_y-.086*s,side*wx,.066*s,.038*s,.02*s),(wrist_y-.052*s,side*wx,.067*s,.043*s,.025*s),(wrist_y+.007*s,side*wx,.055*s,.027*s,.024*s)],hand_color)
        for finger in range(4):
            fx=side*(wx+(-1.5+finger)*.020*s); length=[.051,.067,.062,.045][finger]*s
            m.tube(label+'-finger-'+str(finger),[(fx,wrist_y-.063*s,.067*s),(fx,wrist_y-.093*s-length*.45,.081*s),(fx,wrist_y-.086*s-length,.084*s)],[.010*s,.009*s,.006*s],hand_color)
        m.tube(label+'-thumb',[(side*(wx-.022*s),wrist_y-.035*s,.068*s),(side*(wx-.057*s),wrist_y-.053*s,.09*s),(side*(wx-.055*s),wrist_y-.083*s,.103*s)],[.019*s,.013*s,.008*s],hand_color)
    if not eva:
        anatomy_head(m,0,head_y,0,rx,ry,rz,skin,p['hair'],p['eyes'],p['presentation'],alien)
    else:
        # Pressure shell and visor are fitted over the same head envelope.
        m.ellipsoid('helmet-shell',(0,head_y,0),(rx*1.24,ry*1.13,rz*1.3),ivory)
        m.ellipsoid('visor-gasket',(0,head_y,rz*.79),(rx*1.09,ry*.77,rz*.60),navy)
        m.ellipsoid('visor',(0,head_y+.006*s,rz*.95),(rx*.98,ry*.65,rz*.51),'#34576a')
        m.tube('visor-highlight',[(-rx*.65,head_y+ry*.42,rz*1.31),(-rx*.28,head_y+ry*.48,rz*1.40),(rx*.11,head_y+ry*.46,rz*1.43)],[.004*s]*3,'#a5ded6')
        m.rings('helmet-collar',[(head_y-ry*1.0,0,0,rx*.89,rz*.92),(head_y-ry*.87,0,0,rx*.92,rz*.98)],accent)
        for side in [-1,1]:
            m.ellipsoid('helmet-radio-'+str(side),(side*rx*1.16,head_y,0),(.025*s,.055*s,.049*s),accent)
            m.ellipsoid('air-tank-'+str(side),(side*.081*s,chest_y-.035*s,-.167*s),(.065*s,.208*s,.07*s),ivory)
            m.rings('tank-band-'+str(side),[(chest_y-.08*s,side*.081*s,-.167*s,.067*s,.072*s),(chest_y-.052*s,side*.081*s,-.167*s,.067*s,.072*s)],navy)
        m.tube('air-hose',[(.08*s,chest_y-.17*s,-.17*s),(.24*s,chest_y-.2*s,-.1*s),(.235*s,chest_y-.23*s,.09*s),(.12*s,chest_y-.16*s,.14*s)],[.014*s]*4,'#d9b66c')
    if costume: dress(m,costume,dims)
    return m.parts

def body_surface(values=None):
    """The implicit body that a character's garment layers are raycast onto."""
    m=Meshes(); geometry(values,m)
    return BodySurface({name:m.lofts[name] for name in BODY_LOFTS})

def build_character(values=None):
    """Blender adapter: Y-up recipe data becomes Z-up authoring scene geometry."""
    from agent_meshes_author import make_mesh, material, fuse_meshes, topology_report
    import bmesh
    import bpy
    result=[]; materials={}
    for part in geometry(values):
        color=part['color']; key=(color,part['roughness'],part['metalness'])
        if key not in materials:
            srgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
            linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in srgb]
            materials[key]=material('finish-'+color[1:],linear,metalness=part['metalness'],roughness=part['roughness'])
        obj=make_mesh(part['name'],[(x,-z,y) for x,y,z in part['vertices']],part['faces'],materials[key])
        bm=bmesh.new(); bm.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(obj.data); bm.free()
        for polygon in obj.data.polygons: polygon.use_smooth=True
        result.append(obj)
    # Solid garment and hand surfaces: source pieces remain deterministic design data.
    # A costume's fused top and bottom are the first garment layers.
    dressed=parameters(values or {})['costume'] is not None
    groups=[('layer-top' if dressed else 'flight-jacket',['tailored-torso','left-sleeve','right-sleeve']),
            ('layer-bottom' if dressed else 'trousers',['trouser-yoke','left-leg','right-leg'])]
    for side in ['left','right']:
        groups.append((side+'-hand',[side+'-palm',side+'-thumb']+[side+'-finger-'+str(i) for i in range(4)]))
    for name,names in groups:
        pieces=[obj for obj in result if obj.name in names]
        finish=pieces[0].data.materials[0]
        result=[obj for obj in result if obj not in pieces]
        voxel=(.0014 if 'hand' in name else .003)*parameters(values or {})['height']/1.82
        fused=fuse_meshes(pieces,name,voxel_size=voxel,smooth_passes=3,expected_components=None)
        # OpenVDB can leave a detached single-cell chip at a grazing seam.
        # Remove only sub-two-cell fragments of <= 12 vertices. A detached finger
        # or sleeve must still fail; never keep only the largest component blindly.
        bm=bmesh.new(); bm.from_mesh(fused.data)
        unseen=set(bm.verts); components=[]
        while unseen:
            queue=[unseen.pop()]; component=[]
            while queue:
                vertex=queue.pop();component.append(vertex)
                for edge in vertex.link_edges:
                    neighbor=edge.other_vert(vertex)
                    if neighbor in unseen: unseen.remove(neighbor);queue.append(neighbor)
            components.append(component)
        components.sort(key=len,reverse=True)
        for component in components[1:]:
            span=max(max(v.co[k] for v in component)-min(v.co[k] for v in component) for k in range(3))
            if len(component)>12 or span>voxel*2 or len(component)>len(components[0])*.001:
                bm.free();raise ValueError(f'{name}: disconnected anatomical component ({len(component)} vertices)')
            bmesh.ops.delete(bm,geom=component,context='VERTS')
        bm.to_mesh(fused.data);bm.free()
        # Concept review has a bounded mesh budget, independent of voxel density.
        # Preserve silhouette through quadric collapse, then verify the final mesh.
        budget=1600 if 'hand' in name else 6000
        triangles=sum(len(face.vertices)-2 for face in fused.data.polygons)
        if triangles>budget:
            bpy.context.view_layer.objects.active=fused
            reduction=fused.modifiers.new('concept-triangle-budget','DECIMATE')
            reduction.ratio=budget/triangles
            bpy.ops.object.modifier_apply(modifier=reduction.name)
        for face in fused.data.polygons: face.use_smooth=True
        report=topology_report([tuple(v.co) for v in fused.data.vertices],[tuple(f.vertices) for f in fused.data.polygons])
        if report!={'components':1,'boundary_edges':0,'nonmanifold_edges':0}:
            raise ValueError(f'{name}: invalid fused anatomy {report}')
        fused.data.materials.clear(); fused.data.materials.append(finish); result.append(fused)
    return result
