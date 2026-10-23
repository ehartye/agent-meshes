"""Procedural spider skeleton template (stable venv, pure numpy — no bpy).

UniRig has no body-plan prior, so its spider rolls drop/merge legs. Instead we
fit a spider rig to the mesh, structured after mesh2motion's reference spider
(`mesh2motion-app/static/rigs/reference/spider.png`): a central spine
(cephalothorax->head) with a trailing abdomen along the body's symmetry axis, and
8 legs. The legs are placed on the MESH so the bones line up with the actual legs:
each roots at the detected cephalothorax perimeter (where the leg emerges — near
the centerline on the reference's thin body, but out at the rim on a fat toy) and
runs its joints down the leg's medial axis to the detected foot.

Output is a candidate .npz in UniRig's normalized format (skintokens_skin reads
it). `mocap.ensure_rigged` fires it only for pose==manylegs; build() self-gates
to None on non-spiders so a mis-tagged toy falls back to the UniRig roll.
"""
import numpy as np

N_LEGS = 8
JOINTS_PER_LEG = 4
SPINE_JOINTS = 4        # hips -> head, forward along the body medial
TAIL_JOINTS = 4         # hips -> abdomen tip, backward along the body medial
UP = np.array([0.0, 1.0, 0.0], np.float32)


def _normalize(verts):
    """[-1,1] box — identical to skintokens_skin._normalize so joints line up."""
    lo, hi = verts.min(0), verts.max(0)
    center = (lo + hi) / 2
    scale = float((hi - lo).max() / 2) or 1.0
    return ((verts - center) / scale).astype(np.float32)


def _leg_hub(V):
    """Center the legs radiate from — the cephalothorax, NOT the mesh centroid
    (the abdomen pulls the centroid rearward). Trimmed-centroid iteration."""
    c = V.mean(0)
    for _ in range(6):
        r = np.linalg.norm(V[:, [0, 2]] - c[[0, 2]], axis=1)
        c = V[r < np.median(r)].mean(0)
    return c


def _lobe_stats(V, c, r, mem):
    """(tip, tangential thickness, reach) for a lobe of ground-ring vertices."""
    outer = mem[r[mem] > np.percentile(r[mem], 65)]
    tip = V[outer[V[outer, 1].argmin()]]                  # outermost-lowest = the foot
    rad = np.array([tip[0] - c[0], tip[2] - c[2]])
    rad /= np.linalg.norm(rad) + 1e-9
    tang = np.array([-rad[1], rad[0]])
    thick = float(np.ptp((V[outer][:, [0, 2]] - c[[0, 2]]) @ tang))
    return tip, thick, float(np.hypot(tip[0] - c[0], tip[2] - c[2]))


def _detect_feet(V, c):
    """The 8 leg feet, from the best of two foot-band heights. A tight band (0.35 of
    the mesh height) isolates the feet cleanly on a toy that stands flat, but a robot
    spider holds its side legs higher, so a tight band drops them and the split below
    fabricates duplicate feet at the rear. Try both bands and keep whichever gives the
    most evenly-spread feet (largest smallest-azimuth-gap)."""
    def min_gap(feet):
        faz = np.sort(np.arctan2(feet[:, 2] - c[2], feet[:, 0] - c[0]))
        return np.diff(np.r_[faz, faz[0] + 2 * np.pi]).min()

    tight = _feet_at_band(V, c, 0.35)
    if tight is not None and min_gap(tight) >= np.radians(2):
        return tight                              # tight band gave 8 distinct feet -> keep it
    wide = _feet_at_band(V, c, 0.45)              # tight band had duplicates -> widen
    if wide is not None and (tight is None or min_gap(wide) > min_gap(tight)):
        return wide
    return tight


def _feet_at_band(V, c, band):
    """8 leg feet from the low-Y ring at the given band height. Split the ring into
    angular lobes, then separate legs from the two things that fool a naive splitter:
      - the ABDOMEN is a fat blob — reject lobes whose tangential thickness is a big
        outlier (a leg is a thin spoke; the bench abdomen ran ~10x a leg).
      - MANDIBLES/pedipalps are short front stubs — keep the 8 lobes that reach
        furthest (real legs radiate out).
    Then recover MERGED legs: if fewer than 8 remain, split the widest lobe until 8.
    Feet are snapped coplanar; ordered by azimuth. None if it can't resolve 8."""
    r = np.linalg.norm(V[:, [0, 2]] - c[[0, 2]], axis=1)
    y = V[:, 1]
    ground = y < y.min() + band * (y.max() - y.min())
    ring = r > np.percentile(r[ground], 55)
    fe = np.where(ground & ring)[0]
    if len(fe) < N_LEGS * 4:
        return None
    az = np.arctan2(V[fe, 2] - c[2], V[fe, 0] - c[0])
    order = np.argsort(az)
    M = len(order)
    gaps = np.diff(np.r_[az[order], az[order][0] + 2 * np.pi])
    cut = np.where(gaps > np.radians(10))[0]
    if len(cut) < 5:                                      # far too few lobes -> not a spider
        return None
    lobes = []
    for j in range(len(cut)):
        lo = (cut[j - 1] + 1) if j > 0 else (cut[-1] + 1)
        hi = cut[j]
        idxs = (list(range(lo, M)) + list(range(0, hi + 1))) if lo > hi \
            else list(range(lo, hi + 1))
        mem = fe[order[idxs]]
        if len(mem) >= 3:
            lobes.append(mem)

    thicks = [_lobe_stats(V, c, r, mem)[1] for mem in lobes]
    med = np.median(thicks)
    legs = [mem for mem, t in zip(lobes, thicks) if t < 3.0 * med]   # drop the abdomen

    def azspan(mem):
        am = np.sort(np.arctan2(V[mem, 2] - c[2], V[mem, 0] - c[0]))
        return am[-1] - am[0]

    while len(legs) < N_LEGS:                             # recover merged legs
        wi = max(range(len(legs)), key=lambda i: azspan(legs[i]))
        mem = legs[wi]
        am = np.arctan2(V[mem, 2] - c[2], V[mem, 0] - c[0])
        left, right = mem[am < np.median(am)], mem[am >= np.median(am)]
        if len(left) < 3 or len(right) < 3:
            return None                                   # can't split -> give up
        legs[wi:wi + 1] = [left, right]

    stats = sorted((_lobe_stats(V, c, r, mem) for mem in legs),
                   key=lambda s: -s[2])[:N_LEGS]          # 8 furthest-reaching
    feet = np.array([s[0] for s in stats], np.float32)
    feet[:, 1] = np.percentile(feet[:, 1], 25)            # coplanar ground
    return feet[np.argsort(np.arctan2(feet[:, 2] - c[2], feet[:, 0] - c[0]))]


def _crammed(feet, c, right):
    """A detection is crammed/lopsided if two feet share an azimuth (tiny gap) or
    the left/right split is uneven — a spider is bilaterally symmetric, so both mean
    the ground-band splitter piled several legs onto one and missed the mirror."""
    if feet is None:
        return True
    faz = np.sort(np.arctan2(feet[:, 2] - c[2], feet[:, 0] - c[0]))
    gap = np.diff(np.r_[faz, faz[0] + 2 * np.pi]).min()
    left = int(((feet - c) @ right < 0).sum())
    return gap < np.radians(10) or left != len(feet) - left


def _feet_symmetric(V, c, fwd, right, band=0.35, min_sep=16.0):
    """Symmetric fallback when the azimuth-lobe splitter crams legs (a mesh where
    several leg tips fold onto one azimuth and the mirror side is missed). A spider is
    symmetric about its sagittal plane, so fold the ground-ring tips onto one side,
    cluster into N_LEGS/2 leg-angles (min separation enforced so two legs can't share
    one), then mirror to N_LEGS feet. None if it can't resolve the halves cleanly."""
    K = N_LEGS // 2
    r = np.linalg.norm(V[:, [0, 2]] - c[[0, 2]], axis=1)
    y = V[:, 1]
    ground = y < y.min() + band * (y.max() - y.min())
    tips = V[ground][r[ground] > np.percentile(r[ground], 70)]     # outer ring = leg tips
    rel = tips - c
    th = np.abs(np.degrees(np.arctan2(rel @ right, rel @ fwd)))     # fold: 0=front .. 180=back
    rr = np.hypot(rel @ fwd, rel @ right)
    if len(th) < K * 3:
        return None
    centers = np.percentile(th, np.linspace(5, 95, K))             # 1-D k-means -> K leg angles
    for _ in range(40):
        a = np.argmin(np.abs(th[:, None] - centers[None, :]), axis=1)
        nc = np.array([th[a == k].mean() if (a == k).any() else centers[k] for k in range(K)])
        if np.allclose(nc, centers, atol=0.3):
            break
        centers = nc
    centers = np.sort(centers)
    merged = [centers[0]]                                          # enforce min separation
    for mval in centers[1:]:
        if mval - merged[-1] < min_sep:
            merged[-1] = (merged[-1] + mval) / 2
        else:
            merged.append(mval)
    centers = np.array(merged)
    if len(centers) < K:                                          # collapsed -> keep the normal roll
        return None
    a = np.argmin(np.abs(th[:, None] - centers[None, :]), axis=1)
    feet = []
    for k, mval in enumerate(centers):
        sel = a == k
        rad = float(np.median(rr[sel])) if sel.any() else float(np.median(rr))
        for sgn in (1.0, -1.0):                                    # mirror each angle L and R
            ang = np.radians(sgn * mval)
            feet.append(c + rad * (np.cos(ang) * fwd + np.sin(ang) * right))
    feet = np.array(feet, np.float32)
    # the mirror is horizontal (hub height); drop feet to the actual ground — the
    # low leg-tip height — so they read as feet, not mid-body (else the retarget's
    # low-Y leg-finder misses them: crystal's tips sat above its foot band).
    feet[:, 1] = float(np.percentile(tips[:, 1], 20))
    return feet[np.argsort(np.arctan2(feet[:, 2] - c[2], feet[:, 0] - c[0]))]


def _symmetry(V, c):
    """The bilateral symmetry frame, and a hub locked onto it. A spider is symmetric
    about its sagittal plane, so find the horizontal mirror-plane (normal + OFFSET)
    that best folds the mesh onto itself — searching the offset too, not just forcing
    the plane through the leg-hub, is what fixes an off-centre hub that skews the leg
    azimuths (a duplicate on one side, a missing mirror leg on the other). Returns the
    hub PROJECTED onto that plane, the forward axis (in-plane, pointing away from the
    heavier abdomen), and the left-right axis (the plane normal)."""
    from scipy.spatial import cKDTree
    S = V[:: max(1, len(V) // 3000)].astype(np.float64)
    tree = cKDTree(S)
    best = None
    for deg in range(0, 180, 2):
        th = np.radians(deg)
        n = np.array([-np.sin(th), 0.0, np.cos(th)])     # candidate plane normal
        proj = S @ n
        d = proj.mean()                                  # best offset along the normal
        refl = S - 2.0 * (proj - d)[:, None] * n
        err = float(tree.query(refl)[0].mean())
        if best is None or err < best[0]:
            best = (err, n, d)
    _, n, d = best
    c_on = (c - ((c @ n) - d) * n).astype(np.float32)    # hub, snapped onto the plane
    fwd = np.array([n[2], 0.0, -n[0]], np.float32)       # in-plane (perpendicular to n)
    fwd /= np.linalg.norm(fwd) + 1e-9
    if fwd[[0, 2]] @ (V.mean(0) - c_on)[[0, 2]] > 0:     # point away from the abdomen
        fwd = -fwd
    right = (n / (np.linalg.norm(n) + 1e-9)).astype(np.float32)
    return c_on, fwd, right


def _leg(V, c, foot, r_body, wedge):
    """4 joints spaced evenly by ARC LENGTH down the leg's medial axis. Binning by
    radius bunched joints where a bent leg turns (both mid joints piled at the knee,
    leaving one long bone to the foot — a robot leg curled its shin into the torso).
    So build a fine medial polyline (cross-section centres from the rim to the foot),
    then resample 4 joints at even distance ALONG it. Isolate the leg with an angular
    `wedge` (adaptive, so a close neighbour's verts don't drag the knee sideways)."""
    h = foot - c
    h[1] = 0.0
    R = np.linalg.norm(h)
    if R < 1e-6:
        return None
    h /= R
    r = np.linalg.norm(V[:, [0, 2]] - c[[0, 2]], axis=1)
    legaz = np.arctan2(foot[2] - c[2], foot[0] - c[0])
    az = np.arctan2(V[:, 2] - c[2], V[:, 0] - c[0])
    daz = np.abs((az - legaz + np.pi) % (2 * np.pi) - np.pi)
    on_leg = (daz < wedge) & (r > 0.6 * r_body) & (r < 1.15 * R)
    leg = V[on_leg]
    rl = r[on_leg]
    if len(leg) < 8:
        return None

    def core_centroid(band):
        if not len(band):
            return None
        ctr = band.mean(0)
        d = np.linalg.norm(band - ctr, axis=1)
        core = band[d <= np.percentile(d, 55)]         # drop hair/outliers -> tube centre
        return core.mean(0) if len(core) else ctr
    # fine medial polyline: cross-section centres in many thin radial slices, then the
    # detected foot as the end point
    fine = np.linspace(r_body, R, 13)
    poly = [bc for k in range(12)
            if (bc := core_centroid(leg[(rl >= fine[k]) & (rl < fine[k + 1])])) is not None]
    if len(poly) < 3:
        return None
    poly = np.array(poly + [foot], np.float32)
    arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(poly, axis=0), axis=1))]
    if arc[-1] < 1e-6:
        return None
    js = []                                            # resample 4 joints at even arc-length
    for k in range(JOINTS_PER_LEG):
        t = arc[-1] * k / (JOINTS_PER_LEG - 1)
        i = int(np.clip(np.searchsorted(arc, t), 1, len(poly) - 1))
        f = (t - arc[i - 1]) / (arc[i] - arc[i - 1] + 1e-9)
        js.append(poly[i - 1] + (poly[i] - poly[i - 1]) * f)
    js[-1] = js[-1] + 0.22 * (js[-2] - js[-1])         # pull the tip in off the surface
    return np.array(js, np.float32)


def _spine_tail(V, c, fwd, right):
    """Spine (hips->head, +fwd) and abdomen tail (hips->tip, -fwd) placed along the
    BODY's medial axis — band centroids of the central mass near the sagittal plane,
    so the bones stay INSIDE the cephalothorax/abdomen instead of overshooting on
    fixed reference offsets (which poked out the front on smaller-bodied toys)."""
    rel = V - c
    f = rel @ fwd
    lat = np.abs(rel @ right)
    span = (f.max() - f.min()) or 1.0
    body = lat < 0.14 * span                       # tight sagittal band -> body core only
    fb, Vb = f[body], V[body]

    def chain(extent, n):
        edges = np.linspace(0.0, extent, n + 1)
        out = []
        for k in range(1, n + 1):
            lo, hi = sorted((edges[k - 1], edges[k]))
            sel = (fb >= lo) & (fb < hi)
            out.append(Vb[sel].mean(0) if sel.sum() >= 4 else c + fwd * edges[k])
        return out
    # spine forward reach kept short of the front tip (the cephalothorax is small, so
    # reaching to the extreme front overshoots the mesh); abdomen fills its big bulb
    return (chain(np.percentile(fb, 80), SPINE_JOINTS),    # forward into the cephalothorax
            chain(np.percentile(fb, 4), TAIL_JOINTS))       # backward to the abdomen tip


# ---------- connectivity leg isolation ----------
# The wedge/azimuth detectors guess where legs are from vertex clouds; the MESH
# knows. Weld seam-split verts, cut the torso core, and the legs fall out as
# connected components — one chain per real leg by construction (no cramming,
# no wedge scooping the carapace, tips at the true leg ends). Proven on the
# green/crystal spider (foreleg + sock-foot fixes); primary path, with the
# detector pipeline as fallback for meshes that don't separate cleanly.
ISO_CUTS = [0.42, 0.36, 0.30, 0.25, 0.20, 0.16]   # torso-cut sweep, outer -> inner


def _iso_split(mesh, c, rcut):
    """Connected components (vert arrays, >=20 verts) after cutting the torso core."""
    r = np.linalg.norm(mesh.vertices[:, [0, 2]] - c[[0, 2]], axis=1)
    keep = ~(r < rcut)[mesh.faces].any(axis=1)
    sub = mesh.copy()
    sub.update_faces(keep)
    sub.remove_unreferenced_vertices()
    return [cm.vertices.view(np.ndarray).astype(np.float32)
            for cm in sub.split(only_watertight=False) if len(cm.vertices) >= 20]


def _iso_tip(pts, c):
    """A component's foot: outermost-lowest vertex."""
    rr = np.linalg.norm(pts[:, [0, 2]] - c[[0, 2]], axis=1)
    outer = pts[rr > np.percentile(rr, 85)]
    return outer[outer[:, 1].argmin()]


def _iso_components(V, F, c, R_mean):
    """(the 8 leg components at the outer cut, sweep dict) or None. Legs = the
    long-reach components whose tips sit near the ground (abdomen/head ride high)."""
    import trimesh
    mesh = trimesh.Trimesh(V.copy(), F.copy(), process=True)   # process welds seam verts
    sweep = {rf: _iso_split(mesh, c, rf * R_mean) for rf in ISO_CUTS}
    comps = [p for p in sweep[ISO_CUTS[0]]
             if np.linalg.norm(p[:, [0, 2]] - c[[0, 2]], axis=1).max() > 0.6 * R_mean]
    ylo, yspan = V[:, 1].min(), float(np.ptp(V[:, 1]))
    legs = [p for p in comps if _iso_tip(p, c)[1] < ylo + 0.30 * yspan]
    if len(legs) != N_LEGS:
        return None
    return legs, sweep


def _iso_legs(V, F, c, fwd, right, R_mean):
    """8 leg joint-chains from mesh connectivity, or None. Per leg: coxa just
    inside the leg at the torso junction, tip at the true end, mids at even
    arc-length. Legs are matched into mirror PAIRS and their joints averaged
    across the sagittal plane, so the bones come out exactly symmetric (the
    mesh is bilateral; independent per-leg fits drift apart on noise)."""
    got = _iso_components(V, F, c, R_mean)
    if got is None:
        return None
    legs, sweep = got

    def attach(tip):
        """(attach radius, component at the DEEPEST clean cut). The deep component
        extends inward to the real leg/torso junction so the coxa sits just inside
        the leg — the shallow component stops at the outer cut ring. Growth cap:
        one cut deeper only adds a thin ring to a real leg (<~1.5x); swallowing a
        mandible/underbelly chunk jumps the count and bends the medial off the leg."""
        base = next(p for p in sweep[ISO_CUTS[0]]
                    if np.linalg.norm(p - tip, axis=1).min() < 1e-4)
        att, deep = ISO_CUTS[0], base
        for rf in ISO_CUTS[1:]:
            holder = next((p for p in sweep[rf]
                           if np.linalg.norm(p - tip, axis=1).min() < 1e-4), None)
            if holder is None or len(holder) > 1.5 * len(base):
                break
            att, deep = rf, holder
        return att * R_mean, deep

    def medial(pts, tip, r_att):
        r = np.linalg.norm(pts[:, [0, 2]] - c[[0, 2]], axis=1)
        edges = np.linspace(r_att, r.max(), 13)
        poly = []
        for k in range(12):
            b = pts[(r >= edges[k]) & (r < edges[k + 1])]
            if len(b):
                ctr = b.mean(0)
                d = np.linalg.norm(b - ctr, axis=1)
                poly.append(b[d <= np.percentile(d, 60)].mean(0))
        poly.append(tip)
        if len(poly) < 4:
            return None
        poly = np.array(poly, np.float32)
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(poly, axis=0), axis=1))]
        js = []
        for k in range(JOINTS_PER_LEG):                # even arc-length, always
            t = arc[-1] * k / (JOINTS_PER_LEG - 1)
            i = int(np.clip(np.searchsorted(arc, t), 1, len(poly) - 1))
            f = (t - arc[i - 1]) / (arc[i] - arc[i - 1] + 1e-9)
            js.append(poly[i - 1] + (poly[i] - poly[i - 1]) * f)
        return np.array(js, np.float32)

    def sang(pts):                                     # signed angle in the body frame
        rel = _iso_tip(pts, c) - c
        return float(np.degrees(np.arctan2(rel @ right, rel @ fwd)))

    angs = [sang(p) for p in legs]
    left = sorted([i for i in range(N_LEGS) if angs[i] < 0], key=lambda i: angs[i])
    rite = sorted([i for i in range(N_LEGS) if angs[i] >= 0], key=lambda i: angs[i])
    if len(left) != N_LEGS // 2 or len(rite) != N_LEGS // 2:
        return None
    up = np.array([0.0, 1.0, 0.0], np.float32)

    def to_frame(J):
        rel = J - c
        return np.stack([rel @ fwd, rel @ right, rel[:, 1]], 1)

    def from_frame(F_):
        return (c + F_[:, 0:1] * fwd + F_[:, 1:2] * right + F_[:, 2:3] * up).astype(np.float32)

    leg_js = {}
    used = set()
    for i in left:
        j = min((j for j in rite if j not in used), key=lambda j: abs(-angs[i] - angs[j]))
        used.add(j)
        ra, deep_i = attach(_iso_tip(legs[i], c))
        rb, deep_j = attach(_iso_tip(legs[j], c))
        # SHALLOWER of the two junctions, so the pair's polylines span the same
        # radial range and average point-to-point (a deeper start on one side made
        # the averaged mid joints cut corners through the air)
        r_att = max(ra, rb)
        a = medial(deep_i, _iso_tip(legs[i], c), r_att)
        b = medial(deep_j, _iso_tip(legs[j], c), r_att)
        if a is None or b is None:
            return None
        fa, fb = to_frame(a), to_frame(b)
        fb[:, 1] *= -1                                 # mirror right leg into left frame
        avg = (fa + fb) / 2                            # shared symmetric shape
        avg_r = avg.copy()
        avg_r[:, 1] *= -1
        leg_js[i] = from_frame(avg)
        leg_js[j] = from_frame(avg_r)
    order = sorted(range(N_LEGS), key=lambda i: np.arctan2(_iso_tip(legs[i], c)[2] - c[2],
                                                           _iso_tip(legs[i], c)[0] - c[0]))
    return [leg_js[i] for i in order]


def lock_leg_weights(mesh_npz, rigged_npz):
    """Post-skin: clear CROSS-LEG weights — verts of a leg's mesh component may not
    ride another leg's bones. SkinTokens bleeds weight between CLOSE feet (the green
    spider's rear pair leaked ~16% of one foot onto the other rear leg's tip — floppy
    foot on every draw, so it's proximity, not a bad roll). Axial (hips/spine/tail)
    weights are left alone: a furry rear-leg component carries a fringe of abdomen
    fur, and stealing those verts onto the leg chain made the legs deform the
    abdomen as they walked. Returns re-owned vert count, 0 if the legs don't
    isolate (nothing changed)."""
    from scipy.spatial import cKDTree
    m = np.load(str(mesh_npz))
    rd = dict(np.load(str(rigged_npz), allow_pickle=True))
    V = _normalize(m["vertices"].astype(np.float32))
    J = np.asarray(rd["joints"], float)
    W = rd["weights"].copy()
    if len(J) != 1 + SPINE_JOINTS + TAIL_JOINTS + N_LEGS * JOINTS_PER_LEG:
        return 0
    c = _leg_hub(V)
    c, fwd, right = _symmetry(V, c)
    rr = np.linalg.norm(V[:, [0, 2]] - c[[0, 2]], axis=1)
    R_mean = float(np.percentile(rr, 98))
    got = _iso_components(V, m["faces"], c, R_mean)
    if got is None:
        return 0
    legs, _ = got
    tips = [J[9 + li * JOINTS_PER_LEG + JOINTS_PER_LEG - 1] for li in range(N_LEGS)]
    fixed = 0
    for pts in legs:
        li = int(np.argmin([np.linalg.norm(pts - t, axis=1).min() for t in tips]))
        chain = list(range(9 + li * JOINTS_PER_LEG, 9 + (li + 1) * JOINTS_PER_LEG))
        other = np.ones(W.shape[1], bool)
        other[chain] = False
        other[:9] = False                              # axial bones keep their verts
        mine = cKDTree(pts).query(V, k=1)[0] < 1e-5    # original verts in this component
        had = W[np.ix_(mine, np.where(other)[0])].sum(1) > 1e-6
        W[np.ix_(mine, np.where(other)[0])] = 0.0
        for v in np.where(mine)[0][W[mine].sum(1) < 1e-8]:   # emptied -> nearest chain bone
            nb = chain[int(np.argmin([np.linalg.norm(V[v] - J[b]) for b in chain]))]
            W[v, nb] = 1.0
        W[mine] /= (W[mine].sum(1, keepdims=True) + 1e-9)
        fixed += int(had.sum())
    if fixed:
        rd["weights"] = W
        np.savez(str(rigged_npz), **rd)
    return fixed


def build(mesh_npz, out_npz):
    """Fit a spider rig (medial spine/abdomen + mesh-medial legs) to the mesh.
    Returns out_npz Path on success, None if the mesh isn't a clean 8-legged body."""
    from pathlib import Path
    m = np.load(str(mesh_npz))
    V = _normalize(m["vertices"].astype(np.float32))
    c = _leg_hub(V)
    c, fwd, right = _symmetry(V, c)               # lock the hub onto the symmetry plane
    feet = _detect_feet(V, c)                      # ...so leg azimuths come out symmetric
    if _crammed(feet, c, right):                   # splitter piled legs onto one azimuth?
        sym = _feet_symmetric(V, c, fwd, right)    # ...fold + mirror into 8 symmetric feet
        if sym is not None:
            feet = sym
    if feet is None:
        return None
    R_mean = float(np.mean([np.linalg.norm((f - c) * [1, 0, 1]) for f in feet]))
    # Move the leg/spine connection point BACKWARD along the body axis. The legs
    # converge slightly forward of where they actually attach (the forward-pointing
    # legs curve back to the body), so rooting them at the raw hub leaves the front
    # legs' proximal bones ahead of the mesh. Shifting the hub rear-ward drops the
    # front legs onto their legs (measured: 88%->100% inside) without moving the rear.
    c_iso = c.copy()                              # isolation measures from the true centre
    c = c - fwd * 0.20 * R_mean
    joints = [c.astype(np.float32)]               # 0 = hips (root)
    parents = [-1]

    def add_chain(pts):                           # spine / abdomen / a leg off hips
        prev = 0
        for p in pts:
            joints.append(np.asarray(p, np.float32))
            parents.append(prev)
            prev = len(joints) - 1
    spine, tail = _spine_tail(V, c, fwd, right)
    add_chain(spine)                              # 1..4  hips -> head
    add_chain(tail)                               # 5..8  hips -> abdomen tip
    # PRIMARY: legs from mesh connectivity (one chain per real leg, symmetric,
    # coxa at the torso junction, tip at the true end) — measured from the
    # UNshifted hub (the backward shift above is for the root joint only).
    # Falls back to the wedge detector when the mesh doesn't separate cleanly.
    iso = _iso_legs(V, m["faces"], c_iso, fwd, right, R_mean) if "faces" in m else None
    if iso is not None:
        for leg in iso:
            prev = 0
            for j in leg:
                joints.append(np.asarray(j, np.float32))
                parents.append(prev)
                prev = len(joints) - 1
    else:
        # cephalothorax rim = a fraction of the mean foot reach (the coverage/thinness
        # detectors are fooled by the hairy mesh); legs space evenly from here to the foot
        r_body = 0.28 * R_mean
        # per-leg wedge half-width: don't let it reach a close neighbour's azimuth (feet
        # are azimuth-sorted), else that leg's verts drag this knee sideways out of the tube
        faz = np.arctan2(feet[:, 2] - c[2], feet[:, 0] - c[0])
        for i, foot in enumerate(feet):
            gap = min((faz[i] - faz[i - 1]) % (2 * np.pi),
                      (faz[(i + 1) % N_LEGS] - faz[i]) % (2 * np.pi))
            wedge = min(np.radians(17), 0.42 * gap)
            leg = _leg(V, c, foot, r_body, wedge)
            if leg is None:
                return None
            prev = 0
            for j in leg:
                joints.append(j.astype(np.float32))
                parents.append(prev)
                prev = len(joints) - 1

    J = np.array(joints, np.float32)
    names = [f"bone_{i}" for i in range(len(J))]   # sidecar renames to bone_N by order
    kids = {i: [] for i in range(len(J))}
    for i, p in enumerate(parents):
        if p >= 0:
            kids[p].append(i)
    T = J.copy()
    for i in range(len(J)):
        if kids[i]:
            T[i] = J[kids[i][0]]
        elif parents[i] >= 0:
            T[i] = J[i] + (J[i] - J[parents[i]])
    # leg_smooth: skintokens_skin Laplacian-smooths the weights this many passes
    np.savez(str(out_npz), joints=J, parents=np.array(parents),
             names=np.array(names, dtype=object), tails=T, leg_smooth=4)
    return Path(out_npz)
