"""E0 skeleton-quality experiment — DRIVER (stable venv, no GPU deps).

Sweeps (toy x num_samples x temperature x seed), one skel_experiment.py
subprocess per combo (UniRig generation sometimes dies natively on a bad roll —
isolation turns a crash into a data point). Resumable: combos with an existing
result json are skipped. Crashes are recorded as {"error": "crash"} rows.

usage: python skel_matrix.py [exp_dir]
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import numpy as np

import body_plans

RIGGING = Path(__file__).parent
GALLERY = RIGGING.parent / "gallery"
# Interpreter of the isolated UniRig environment (set UNIRIG_PYTHON).
ISO_PY = os.environ["UNIRIG_PYTHON"]

TOYS = {
    "fox": "c686134433de",       # quadruped, boneless bushy tail
    "horse": "0bc1478f5f3f",     # quadruped, boneless tail + armor
    "spider": "ba4eb57e0f56",    # 8 legs, rigged with 6 chains at 2048
    "snake": "dd310291a565",     # limbless, only ~8 joints at 2048
    "alien": "a8b2a8e0d0af",     # biped whose arms detect as 1/0 (parked bug)
}
DENSITIES = [2048, 8192, 16384]
TEMPS = ["", "0.8"]              # "" = model default (1.5)
SEEDS = [42, 7]

EXP = Path(sys.argv[1]) if len(sys.argv) > 1 else RIGGING / "exp_e0"
EXP.mkdir(exist_ok=True)

combos = [(t, d, tp, s) for t in TOYS for d in DENSITIES for tp in TEMPS for s in SEEDS]
print(f"matrix: {len(combos)} combos -> {EXP}", flush=True)

for i, (tag, dens, temp, seed) in enumerate(combos):
    name = f"{tag}_n{dens}_t{temp or 'def'}_s{seed}"
    out_json = EXP / f"{name}.json"
    if out_json.exists():
        print(f"[{i+1}/{len(combos)}] {name} cached", flush=True)
        continue
    env = dict(os.environ)
    env.update({"MESH_NPZ": str(GALLERY / TOYS[tag] / "rig" / "mesh.npz"),
                "OUT_JSON": str(out_json), "OUT_NPZ": str(EXP / f"{name}.npz"),
                "DENS": str(dens), "SKEL_TEMP": temp, "SEED": str(seed), "TOY": tag,
                "HF_HUB_OFFLINE": "1", "KMP_DUPLICATE_LIB_OK": "TRUE"})
    t0 = time.time()
    r = subprocess.run([ISO_PY, str(RIGGING / "skel_experiment.py")],
                       env=env, capture_output=True, text=True, timeout=900)
    dt = round(time.time() - t0, 1)
    if not out_json.exists():   # native crash ("No parts generated" roll) = data
        out_json.write_text(json.dumps({
            "toy": tag, "num_samples": dens, "seed": seed, "error": "crash",
            "temperature": float(temp) if temp else "default(1.5)", "secs": dt}))
        print(f"[{i+1}/{len(combos)}] {name}: CRASH in {dt}s", flush=True)
    else:
        # analysis (classify = numpy LAPACK) belongs HERE in the stable venv —
        # it aborts natively in the iso env once torch/CUDA is initialized
        s = np.load(EXP / f"{name}.npz")
        joints, parents = s["joints"], s["parents"]
        info = body_plans.classify(joints, parents)
        info.update({"toy": tag, "num_samples": dens, "seed": seed,
                     "temperature": float(temp) if temp else "default(1.5)",
                     "tail_chain": body_plans.tail_chain_len(joints, list(parents)),
                     "secs": dt})
        out_json.write_text(json.dumps(info))
        print(f"[{i+1}/{len(combos)}] {name}: plan={info.get('plan')} feet={info.get('feet')} "
              f"side={info.get('side_limbs')} tail={info.get('tail_chain')} J={info.get('joints')} {dt}s", flush=True)

print("MATRIX COMPLETE", flush=True)
