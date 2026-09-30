"""Explicit local skin-weight edits without renormalizing unrelated influences."""
from math import fsum, isfinite
from numbers import Integral, Real

import numpy as np


def _fraction(value):
    return (not isinstance(value, (bool, np.bool_)) and isinstance(value, Real)
            and isfinite(value) and 0 <= value <= 1)


def ellipsoid_falloff(vertices, center, radii, strength=1):
    """Compact C1 field: strength * max(1 - squared ellipsoid radius, 0)^2.

    All positions share the caller's coordinate frame. This is a spatial brush,
    not topology-aware selection: use a separate mask for disconnected surfaces.
    """
    vertices = np.asarray(vertices, dtype=float)
    center, radii = np.asarray(center, dtype=float), np.asarray(radii, dtype=float)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or not np.isfinite(vertices).all():
        raise ValueError('Finite Nx3 vertices required')
    if center.shape != (3,) or not np.isfinite(center).all():
        raise ValueError('Finite three-coordinate center required')
    if radii.shape != (3,) or not np.isfinite(radii).all() or np.any(radii <= 0):
        raise ValueError('Three positive finite radii required')
    if not _fraction(strength):
        raise ValueError('Strength must be a finite fraction in [0, 1]')
    # Overflow means a point is well outside the finite support.
    with np.errstate(over='ignore'):
        distance = np.sum(((vertices-center)/radii)**2, axis=1)
    return float(strength)*np.maximum(1-distance, 0)**2


def transfer_influence(weights, source, target, amounts, max_influences=4):
    """Move each fraction of source weight to target; return independent row dicts.

    Other named weights and each row's total are preserved, not normalized.
    Amount zero or absent/zero source is an exact row-value no-op. Fully emptied
    source entries are removed. Changed rows exceeding max_influences are
    rejected; nothing is silently pruned. Unchanged rows keep their existing
    influence count. Inputs are never mutated, including on validation failure.
    """
    if not isinstance(source, str) or not source or not isinstance(target, str) or not target or source == target:
        raise ValueError('Distinct nonempty source and target bone names required')
    if isinstance(max_influences, (bool, np.bool_)) or not isinstance(max_influences, Integral) or max_influences < 1:
        raise ValueError('Positive integer influence limit required')
    amounts = list(amounts)
    if len(weights) != len(amounts) or any(not _fraction(a) for a in amounts):
        raise ValueError('One finite transfer fraction in [0, 1] per row required')
    result = []
    for row, amount in zip(weights, amounts):
        if not isinstance(row, dict) or not row:
            raise ValueError('Nonempty named weight rows required')
        for name, value in row.items():
            if (not isinstance(name, str) or not name or isinstance(value, (bool, np.bool_))
                    or not isinstance(value, Real) or not isfinite(value) or value < 0):
                raise ValueError('Named nonnegative finite weights required')
        try:
            total = fsum(row.values())
        except OverflowError as exc:
            raise ValueError('Finite positive total weight required') from exc
        if not isfinite(total) or total <= 0:
            raise ValueError('Finite positive total weight required')
        out = row.copy()
        # NumPy scalar arithmetic can otherwise round a partial float64 transfer
        # to a full float32 donor, silently removing an influence.
        donor = float(row.get(source, 0))
        moved = float(amount)*donor
        if moved:
            remainder = donor-moved
            if remainder:
                out[source] = remainder
            else:
                del out[source]
            out[target] = float(row.get(target, 0))+moved
            if not isfinite(out[target]):
                raise ValueError('Transferred target weight must stay finite')
            if sum(value > 0 for value in out.values()) > max_influences:
                raise ValueError('Transfer exceeds the influence limit; no weights were pruned')
        result.append(out)
    return result
