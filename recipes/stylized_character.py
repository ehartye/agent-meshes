"""Deterministic stylized anatomy study, independent of any game or character.

geometry(parameters) returns named Y-up mesh data using only the standard library.
build_character(parameters) adapts those meshes to the agent-meshes Blender runner.
This is a static authoring recipe, not an animation-ready human topology generator.
"""
import math
import re

VERSION = 1
DEFAULTS = dict(height=1.82, age='adult', presentation='female', species='human',
                vacuum=False, skin='#b97d57', hair='#363544', accent='#d47d48',
                eyes='#507d76')

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
    def __init__(self): self.parts=[]
    def mesh(self,name,vertices,faces,color,roughness=.65,material=None):
        part=dict(name=name,vertices=vertices,faces=faces,color=color,roughness=roughness)
        if material:part['material']=material  # glass: opacity, ior, double_sided
        self.parts.append(part)
    def rings(self,name,rows,color,axis='y',segments=32,smooth=4):
        # rows: axial coordinate, center U, center V, radius U, radius V
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

# Clear-glass vacuum helmet. The bubble is fitted to the head it holds (face, eyes, hair, ears, fronds), not
# scaled from height, so a child's helmet is smaller than an adult's and an alien's follows its own head.
HELMET_CLEARANCE=.022   # metres from face/hair to the glass inner surface (the fit's minimum)
HELMET_GLASS=dict(opacity=.16,ior=1.5,double_sided=True)

def ellipsoid_clearance(point,center,radii):
    """Signed distance from a point to an axis-aligned ellipsoid surface: positive inside, negative outside.

    Bisection on the Lagrange parameter of the closest-point problem (Eberly, "Distance from a Point to an
    Ellipse, an Ellipsoid, or a Hyperellipsoid"); exact to about 1e-7 m and robust inside and outside.
    """
    y=[max(abs(point[k]-center[k]),1e-9) for k in range(3)];e=radii
    inside=sum((y[k]/e[k])**2 for k in range(3))<=1
    def g(t):return sum((e[k]*y[k]/(t+e[k]*e[k]))**2 for k in range(3))-1
    lo=-min(e)**2+1e-15;hi=max(0.0,max(e)*math.hypot(*y))
    if g(hi)>0:hi=max(e)**2*4+math.hypot(*y)*max(e)*4
    for _ in range(90):
        mid=(lo+hi)/2
        if g(mid)>0:lo=mid
        else:hi=mid
    t=(lo+hi)/2;closest=[e[k]*e[k]*y[k]/(t+e[k]*e[k]) for k in range(3)]
    distance=math.dist(closest,y)
    return distance if inside else -distance

def helmet_fit(points,neck_radius,clearance=HELMET_CLEARANCE,max_aspect=1.3):
    """Fit a round glass bubble around a head's points (metres, Y up, facing +Z, symmetric in X).

    The bubble is the smallest axis-aligned ellipsoid (by coordinate descent on its side, top, bottom, front and
    back extents) that keeps every point at least `clearance` inside it, stays round (longest radius at most
    `max_aspect` times the shortest) and leaves a neck opening wider than `neck_radius`, cut just below the
    lowest point. So the helmet follows the head it holds: a child's is smaller, an alien's follows its own
    head. Returns center, radii, cut_y (the opening's plane), opening_radius and the achieved clearance.
    """
    points=list({tuple(round(c/.003)*.003 for c in v) for v in points})
    if len(points)<4:raise ValueError('helmet_fit needs the head points')
    lo=[min(v[k] for v in points) for k in range(3)];hi=[max(v[k] for v in points) for k in range(3)]
    cut_y=lo[1]-.004
    def shape(x):
        side,top,bottom,front,back=x
        return (0.0,(top+bottom)/2,(front+back)/2),(side,(top-bottom)/2,(front-back)/2)
    def opening(center,radii):
        u=(cut_y-center[1])/radii[1]
        return 0 if abs(u)>=1 else min(radii[0],radii[2])*math.sqrt(1-u*u)
    def approx_ok(center,radii,margin):
        # First-order (Sampson) distance -f/|grad f| to the surface, positive inside; exact enough near it.
        # The last failing point is tried first, so most rejected trials cost one point.
        ia,ib,ic=(1/r**2 for r in radii);cy,cz=center[1],center[2]
        for index,(x,y,z) in enumerate(candidates):
            y-=cy;z-=cz;f=x*x*ia+y*y*ib+z*z*ic-1;gx,gy,gz=x*ia,y*ib,z*ic
            if -f<margin*2*math.sqrt(gx*gx+gy*gy+gz*gz):
                if index:candidates.insert(0,candidates.pop(index))
                return False
        return True
    width=max(abs(lo[0]),abs(hi[0]))
    # Points deep inside the bounds' ellipsoid never decide the fit.
    norm=lambda v:(v[0]/width)**2+((v[1]-(lo[1]+hi[1])/2)/((hi[1]-lo[1])/2))**2+((v[2]-(lo[2]+hi[2])/2)/((hi[2]-lo[2])/2))**2
    candidates=[v for v in points if norm(v)>.45]
    def near_surface(center,radii):
        # Points the first-order distance puts within 1 cm of the clearance; the rest cannot decide an exact check.
        ia,ib,ic=(1/r**2 for r in radii);cy,cz=center[1],center[2];out=[]
        for v in candidates:
            x,y,z=v[0],v[1]-cy,v[2]-cz;f=x*x*ia+y*y*ib+z*z*ic-1;g=2*math.sqrt((x*ia)**2+(y*ib)**2+(z*ic)**2)
            if -f/g<clearance+.01:out.append(v)
        return out
    def fits(x,exact=False):
        center,radii=shape(x)
        if min(radii)<=0 or max(radii)>max_aspect*min(radii) or opening(center,radii)<neck_radius:return False
        if not exact:return approx_ok(center,radii,clearance)
        return all(ellipsoid_clearance(v,center,radii)>=clearance for v in near_surface(center,radii))
    grow=3*clearance;x=[width+grow,hi[1]+grow,lo[1]-grow,hi[2]+grow,lo[2]-grow]
    while not fits(x):
        c=(x[3]+x[4])/2;y=(x[1]+x[2])/2
        x=[x[0]*1.1,y+(x[1]-y)*1.1,y+(x[2]-y)*1.1,c+(x[3]-c)*1.1,c+(x[4]-c)*1.1]
    # Tighten each extent toward the points in turn; later rounds let earlier extents benefit.
    tight=[width,hi[1],lo[1],hi[2],lo[2]]
    for _ in range(3):
        for k in range(5):
            a,b=tight[k],x[k]
            for _ in range(16):
                trial=list(x);trial[k]=(a+b)/2
                if fits(trial):b=trial[k]
                else:a=trial[k]
            x[k]=b
    # The search used the first-order distance; confirm exactly and let out any slack it missed.
    while not fits(x,exact=True):
        c=(x[3]+x[4])/2;y=(x[1]+x[2])/2
        x=[x[0]*1.002,y+(x[1]-y)*1.002,y+(x[2]-y)*1.002,c+(x[3]-c)*1.002,c+(x[4]-c)*1.002]
    center,radii=shape(x)
    return dict(center=center,radii=radii,cut_y=cut_y,opening_radius=opening(center,radii),
                clearance=min(ellipsoid_clearance(v,center,radii) for v in near_surface(center,radii)))

def vacuum_helmet(m,fit,s,colors,segments=96,rings=48):
    """Hollow bubble helmet on a fitted ellipsoid: a clear glass window over the face, a cream crown-and-back shell
    with thickness, a gold rim around the window and the neck opening, a neck seal down to the suit, and lamps.

    One latitude-longitude bubble (neck cut to crown) is split by the window plane, which leans back from the
    chin to the crown: glass in front of it (the face, and the profile from the side), shell behind (crown and
    back). Triangles are clipped exactly at the plane, so glass and shell share their edge vertices. The glass is
    the bubble surface itself, so the fit's clearance is the distance from the face to the glass.
    """
    (cx,cy,cz),radii=fit['center'],fit['radii'];thick=.009*s
    lean=math.radians(12);f=(0,-math.sin(lean),math.cos(lean));k=-.06  # window plane: d.f=k, d on the unit bubble
    lat_cut=math.asin(max(-1,min(1,(fit['cut_y']-cy)/radii[1])))
    def world(d,grow=0):return tuple(c+(r+grow)*v for c,r,v in zip((cx,cy,cz),radii,d))
    def unit(p):return tuple((p[i]-(cx,cy,cz)[i])/radii[i] for i in range(3))
    def side(d):return d[1]*f[1]+d[2]*f[2]-k
    # The whole bubble as triangles: rings from the neck cut to a crown vertex.
    dirs=[];tris=[]
    for r in range(rings):
        lat=mix(lat_cut,math.pi/2,r/rings)
        for j in range(segments):
            lon=j*math.tau/segments;dirs.append((math.cos(lat)*math.sin(lon),math.sin(lat),math.cos(lat)*math.cos(lon)))
    dirs.append((0,1,0));crown=len(dirs)-1
    for r in range(rings):
        for j in range(segments):
            a=r*segments+j;b=r*segments+(j+1)%segments
            if r==rings-1:tris.append((a,b,crown));continue
            tris+=[(a,b,b+segments),(a,b+segments,a+segments)]
    points=[world(d) for d in dirs];value=[side(d) for d in dirs]
    split={}
    def cut(i,j):
        key=(min(i,j),max(i,j))
        if key not in split:
            t=value[i]/(value[i]-value[j]);split[key]=len(points)
            points.append(tuple(a+(b-a)*t for a,b in zip(points[i],points[j])));value.append(0.0)
        return split[key]
    glass,shell=[],[]
    for tri in tris:
        for keep,out in [(lambda v:v>=0,glass),(lambda v:v<=0,shell)]:
            poly=[]
            for q in range(3):
                i,j=tri[q],tri[(q+1)%3]
                if keep(value[i]):poly.append(i)
                if (value[i]>0)!=(value[j]>0) and value[i]!=0 and value[j]!=0:poly.append(cut(i,j))
            poly=[v for q,v in enumerate(poly) if v!=poly[q-1]]
            if len(poly)>=3 and not all(value[v]==0 for v in poly):out.append(tuple(poly))
    def compact(faces,grow=0):
        used=sorted({v for face in faces for v in face});remap={v:q for q,v in enumerate(used)}
        verts=[points[v] if not grow else world(unit(points[v]),grow) for v in used]
        return verts,[tuple(remap[v] for v in face) for face in faces],remap
    gv,gf,_=compact(glass)
    m.mesh('helmet-glass',gv,gf,colors['glass'],roughness=.04,material=dict(HELMET_GLASS))
    m.parts[-1]['fit']=dict(fit)
    # Shell: inner surface on the bubble, outer `thick` beyond, closed along the window edge and the neck.
    inner,faces,remap=compact(shell);outer=[world(unit(p),thick) for p in inner];count=len(inner)
    edges={}
    for face in faces:
        for q in range(len(face)):
            a,b=face[q],face[(q+1)%len(face)];edges[(a,b)]=edges.get((a,b),0)+1
    sf=[tuple(reversed(face)) for face in faces]+[tuple(v+count for v in face) for face in faces]
    sf+=[(a,b,b+count,a+count) for (a,b) in edges if (b,a) not in edges]
    m.mesh('helmet-shell',inner+outer,sf,colors['shell'],roughness=.45)
    # Gold rims: along the window edge (an exact planar ellipse) and around the neck opening, outside the shell.
    rim=.006*s;radius=math.sqrt(1-k*k);e2=(0,f[2],-f[1])
    def edge_dir(theta):return tuple(k*f[q]+radius*(math.cos(theta)*(1,0,0)[q]+math.sin(theta)*e2[q]) for q in range(3))
    above=lambda theta:edge_dir(theta)[1]-math.sin(lat_cut)
    # The edge runs over the crown (theta=pi/2 points up) between its two crossings of the neck cut.
    lo,hi=math.pi/2,math.pi/2+math.pi
    if above(hi)>0:thetas=[math.pi/2+math.tau*q/160 for q in range(161)]
    else:
        for _ in range(60):
            mid=(lo+hi)/2
            if above(mid)>0:lo=mid
            else:hi=mid
        end=lo;thetas=[math.pi-end+(2*end-math.pi)*q/120 for q in range(121)]
    rim_points=[world(edge_dir(t),thick*.5) for t in thetas]
    m.tube('helmet-rim',rim_points,[rim]*len(rim_points),colors['rim'])
    ring=[world((math.cos(lat_cut)*math.sin(lon),math.sin(lat_cut),math.cos(lat_cut)*math.cos(lon)),thick*.5) for lon in [j*math.tau/48 for j in range(49)]]
    m.tube('helmet-neck-ring',ring,[rim*1.5]*len(ring),colors['rim'])
    # A glint arc on the glass, upper left, reads as a reflection in flat light.
    def surface(lat,lon,grow):return world((math.cos(lat)*math.sin(lon),math.sin(lat),math.cos(lat)*math.cos(lon)),grow)
    glint=[surface(math.radians(30+7*math.sin(math.pi*q/8)),math.radians(-46+4.5*q),.002) for q in range(9)]
    m.tube('helmet-glint',glint,[.0028*s*math.sin(math.pi*(q+.5)/9.5) for q in range(9)],'#f4fbff')
    # Lamps sit on the rim at its widest point on each side.
    for sign,label in [(-1,'left'),(1,'right')]:
        d=edge_dir(0 if sign>0 else math.pi);lamp=world(d,thick+.012*s)
        m.ellipsoid(label+'-helmet-lamp',lamp,(.016*s,.034*s,.030*s),colors['lamp'])
        m.ellipsoid(label+'-helmet-lamp-lens',(lamp[0]+sign*.013*s,lamp[1],lamp[2]),(.005*s,.022*s,.019*s),colors['rim'])
    return fit

def fieldwork_suit(m,dims,colors):
    """Direction A "Fieldwork" suit language over the shared suit body: teal shoulder and elbow pads, olive belt
    and thigh pouches, chest harness straps and a life-support backpack. Parts are rigid to the bone they ride."""
    s=dims['s'];hip=dims['hip_y'];shoulder=dims['shoulder_y'];chest=dims['chest_y'];sx=dims['shoulder_w']*.49
    wrist=hip+.095*s;elbow=mix(wrist,shoulder,.49);wx=sx+.092*s;knee=hip*.53
    for side,label in [(-1,'left'),(1,'right')]:
        m.ellipsoid(label+'-shoulder-pad',(side*(sx+.004*s),shoulder+.012*s,0),(.068*s,.036*s,.074*s),colors['pad'])
        m.ellipsoid(label+'-elbow-pad',(side*(wx-.013*s),elbow,-.004*s),(.05*s,.052*s,.05*s),colors['pad'])
        m.rings(label+'-thigh-pouch',[(hip-.20*s,side*.172*s,.004*s,.022*s,.042*s),(hip-.185*s,side*.176*s,.004*s,.03*s,.052*s),
            (hip-.10*s,side*.178*s,.004*s,.032*s,.055*s),(hip-.085*s,side*.174*s,.004*s,.024*s,.046*s)],colors['pouch'])
        m.rings('belt-pouch-'+label,[(hip-.02*s,side*.12*s,.098*s,.034*s,.018*s),(hip-.01*s,side*.12*s,.102*s,.04*s,.024*s),
            (hip+.05*s,side*.12*s,.103*s,.04*s,.025*s),(hip+.06*s,side*.12*s,.1*s,.032*s,.019*s)],colors['pouch'])
        m.tube(label+'-chest-strap',[(side*.1*s,shoulder+.03*s,-.02*s),(side*.11*s,shoulder-.02*s,.1*s),(side*.085*s,chest,.125*s),(side*.07*s,hip+.08*s,.112*s)],[.009*s]*4,colors['strap'])
    m.rings('backpack',[(chest-.23*s,0,-.15*s,.14*s,.05*s),(chest-.21*s,0,-.16*s,.155*s,.07*s),(chest+.07*s,0,-.165*s,.16*s,.075*s),
        (chest+.1*s,0,-.16*s,.15*s,.066*s),(chest+.115*s,0,-.15*s,.12*s,.045*s)],colors['pack'],axis='y')
    m.ellipsoid('backpack-panel',(0,chest-.06*s,-.232*s),(.092*s,.1*s,.012*s),colors['pad'])
    m.ellipsoid('backpack-emblem',(0,chest-.05*s,-.243*s),(.03*s,.03*s,.004*s),colors['rim'])

FIELDWORK=dict(suit='#e4d8bc',shell='#ece2c8',pad='#2f7f7a',pouch='#6d7043',strap='#2d3440',rim='#d6a23e',
               boot='#5d573c',sole='#2b2c2e',glove='#2d6763',pack='#ddd0b0',glass='#eaf6ff')

def fieldwork_colors(parts):
    """Recolor the shared suit body in direction A's palette: cream suit, teal pads and gloves, olive boots."""
    for part in parts:
        name=part['name']
        if part.get('head') or name.startswith('helmet') or 'helmet-lamp' in name:continue
        if 'outsole' in name:part['color']=FIELDWORK['sole']
        elif 'boot' in name or name.endswith('-ankle'):part['color']=FIELDWORK['boot']
        elif any(t in name for t in ['-palm','-finger','-thumb']):part['color']=FIELDWORK['glove']
        elif 'knee-panel' in name:part['color']=FIELDWORK['pad']
        elif name in ['waist-belt','collar','front-fastener'] or 'wrist-seal' in name:part['color']=FIELDWORK['strap']
        elif part['color'].lower()=='#dfdfcc':part['color']=FIELDWORK['suit']

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

def geometry(values=None):
    p=parameters({} if values is None else values); m=Meshes(); dims=landmarks(p)
    s=dims['s'];h=dims['h'];child=dims['child'];alien=dims['alien'];eva=p['vacuum']
    rx,ry,rz,head_y,shoulder_y,hip_y,shoulder_w,hip_w,chest_y,waist_y=(dims[k] for k in ['rx','ry','rz','head_y','shoulder_y','hip_y','shoulder_w','hip_w','chest_y','waist_y'])
    skin=p['skin'];accent=p['accent'];navy='#263b51';ivory='#dfdfcc'
    body=ivory if eva else accent; trouser=ivory if eva else navy
    m.rings('tailored-torso',[(hip_y+.026*s,0,0,hip_w*.47,.105*s),(hip_y+.04*s,0,0,hip_w*.5,.11*s),(waist_y,0,0,hip_w*.41,.096*s),(chest_y,0,.005*s,shoulder_w*.46,.115*s),(shoulder_y,0,0,shoulder_w*.50,.094*s),(shoulder_y+.065*s,0,0,.075*s,.065*s)],body)
    m.rings('neck',[(shoulder_y+.02*s,0,0,.053*s,.051*s),(head_y-ry*.55,0,0,.058*s,.053*s)],skin)
    m.rings('collar',[(shoulder_y+.038*s,0,0,.076*s,.071*s),(shoulder_y+.068*s,0,0,.071*s,.067*s)],navy)
    m.rings('waist-belt',[(hip_y+.02*s,0,0,hip_w*.502,.113*s),(hip_y+.058*s,0,0,hip_w*.488,.112*s)],navy)
    m.rings('trouser-yoke',[(hip_y-.083*s,0,0,hip_w*.44,.080*s),(hip_y-.015*s,0,0,hip_w*.51,.11*s),(hip_y+.035*s,0,0,hip_w*.49,.109*s)],trouser)
    # A small rounded control panel is embedded in the fitted flight garment.
    m.ellipsoid('chest-terminal',(-.065*s,chest_y,.115*s),(.049*s,.065*s,.017*s),navy)
    m.ellipsoid('chest-readout',(-.065*s,chest_y+.012*s,.133*s),(.034*s,.025*s,.004*s),'#75d5d0')
    m.tube('front-fastener',[(.025*s,hip_y+.1*s,.11*s),(.025*s,chest_y,.124*s),(.025*s,shoulder_y,.097*s)],[.003*s]*3,navy)
    for side,label in [(-1,'left'),(1,'right')]:
        lx=side*.096*s; knee_y=hip_y*.53
        m.rings(label+'-leg',[(.14*s,lx,0,.046*s,.052*s),(.27*s,lx,-.006*s,.052*s,.06*s),(knee_y-.08*s,lx,-.014*s,.066*s,.068*s),(knee_y,lx,.015*s,.059*s,.061*s),(hip_y-.20*s,lx,0,.083*s,.087*s),(hip_y-.025*s,lx,0,.097*s,.103*s),(hip_y+.035*s,lx,0,.084*s,.084*s)],trouser)
        m.ellipsoid(label+'-knee-panel',(lx,knee_y,.081*s),(.047*s,.063*s,.013*s),accent)
        # Boot is a foot volume: narrow heel, high instep, wide ball, tapered toe.
        rows=[(-.098*s,lx,.073*s,.034*s,.04*s),(-.075*s,lx,.09*s,.054*s,.066*s),(0,lx,.094*s,.058*s,.071*s),(.075*s,lx,.074*s,.068*s,.051*s),(.155*s,lx-side*.008*s,.05*s,.073*s,.028*s),(.216*s,lx-side*.013*s,.039*s,.052*s,.017*s),(.239*s,lx-side*.014*s,.037*s,.015*s,.012*s)]
        m.rings(label+'-boot',rows,ivory if eva else '#526579',axis='z')
        sole=[(z,x,.012*s,ru,.012*s) for z,x,y,ru,rv in rows]
        m.rings(label+'-outsole',sole,navy,axis='z')
        m.rings(label+'-ankle',[(.09*s,lx,-.014*s,.053*s,.054*s),(.17*s,lx,-.015*s,.048*s,.05*s),(.205*s,lx,-.01*s,.05*s,.051*s)],ivory if eva else '#526579')
        m.tube(label+'-boot-seam',[(lx-.047*s,.125*s,.018*s),(lx-.056*s,.084*s,.09*s),(lx-.05*s,.062*s,.17*s)],[.003*s]*3,accent)
        # Tapered sleeve contours include deltoid, elbow and forearm.
        wrist_y=hip_y+.095*s; elbow_y=mix(wrist_y,shoulder_y,.49)
        sx=shoulder_w*.49; wx=sx+.092*s
        m.rings(label+'-sleeve',[(wrist_y,side*wx,.055*s,.038*s,.039*s),(elbow_y-.06*s,side*(wx-.009*s),.03*s,.048*s,.047*s),(elbow_y,side*(wx-.015*s),.012*s,.045*s,.047*s),(elbow_y+.1*s,side*(sx+.033*s),0,.062*s,.063*s),(shoulder_y-.022*s,side*sx,0,.073*s,.077*s),(shoulder_y+.026*s,side*(sx-.05*s),0,.06*s,.06*s)],body)
        m.rings(label+'-wrist-seal',[(wrist_y-.009*s,side*wx,.055*s,.041*s,.043*s),(wrist_y+.025*s,side*wx,.052*s,.042*s,.044*s)],navy)
        hand_color=ivory if eva else skin
        m.rings(label+'-palm',[(wrist_y-.086*s,side*wx,.066*s,.038*s,.02*s),(wrist_y-.052*s,side*wx,.067*s,.043*s,.025*s),(wrist_y+.007*s,side*wx,.055*s,.027*s,.024*s)],hand_color)
        for finger in range(4):
            fx=side*(wx+(-1.5+finger)*.020*s); length=[.051,.067,.062,.045][finger]*s
            m.tube(label+'-finger-'+str(finger),[(fx,wrist_y-.063*s,.067*s),(fx,wrist_y-.093*s-length*.45,.081*s),(fx,wrist_y-.086*s-length,.084*s)],[.010*s,.009*s,.006*s],hand_color)
        m.tube(label+'-thumb',[(side*(wx-.022*s),wrist_y-.035*s,.068*s),(side*(wx-.057*s),wrist_y-.053*s,.09*s),(side*(wx-.055*s),wrist_y-.083*s,.103*s)],[.019*s,.013*s,.008*s],hand_color)
    head_start=len(m.parts)
    anatomy_head(m,0,head_y,0,rx,ry,rz,skin,p['hair'],p['eyes'],p['presentation'],alien)
    for part in m.parts[head_start:]:part['head']=True  # what a helmet must hold
    if eva:
        # The bubble is fitted to this head's face, eyes, hair and ears, with room for the jaw to open.
        points=[v for part in m.parts[head_start:] for v in part['vertices']]
        chin=[(x,y-.12*ry,z) for part in m.parts[head_start:] if part['name']=='face' for x,y,z in part['vertices'] if y<head_y-.3*ry and z>0]
        fit=helmet_fit(points+chin,neck_radius=.075*s)
        colors=dict(FIELDWORK,lamp=accent)
        vacuum_helmet(m,fit,s,colors)
        cut=fit['cut_y'];opening=fit['opening_radius']
        m.rings('helmet-neck-seal',[(shoulder_y+.035*s,0,0,opening*1.02,opening*.92),(mix(shoulder_y,cut,.5),0,0,opening*.98,opening*.9),(cut-.002*s,0,fit['center'][2]*.5,opening*.97,opening*.9)],FIELDWORK['strap'])
        fieldwork_suit(m,dims,colors)
        m.tube('air-hose',[(.1*s,chest_y-.02*s,-.2*s),(.2*s,chest_y-.12*s,-.12*s),(.2*s,chest_y-.16*s,.06*s),(.1*s,chest_y-.1*s,.13*s)],[.011*s]*4,FIELDWORK['strap'])
        fieldwork_colors(m.parts)
    return m.parts

def build_character(values=None):
    """Blender adapter: Y-up recipe data becomes Z-up authoring scene geometry."""
    from agent_meshes_author import make_mesh, material, fuse_meshes, topology_report
    import bmesh
    import bpy
    result=[]; materials={}
    for part in geometry(values):
        color=part['color']; glass=part.get('material') or {}; key=(color,part['roughness'],tuple(sorted(glass.items())))
        if key not in materials:
            srgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
            linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in srgb]
            # Glass (opacity, ior, double_sided) exports as glTF alphaMode BLEND; see agent_meshes_author.material.
            materials[key]=material(('glass-' if glass else 'finish-')+color[1:],linear,roughness=part['roughness'],**glass)
        obj=make_mesh(part['name'],[(x,-z,y) for x,y,z in part['vertices']],part['faces'],materials[key])
        bm=bmesh.new(); bm.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(obj.data); bm.free()
        for polygon in obj.data.polygons: polygon.use_smooth=True
        result.append(obj)
    # Solid garment and hand surfaces: source pieces remain deterministic design data.
    groups=[('flight-jacket',['tailored-torso','left-sleeve','right-sleeve']),
            ('trousers',['trouser-yoke','left-leg','right-leg'])]
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
