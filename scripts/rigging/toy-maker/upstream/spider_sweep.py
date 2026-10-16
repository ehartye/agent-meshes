"""Spider-specific seed sweep: how often does UniRig roll >6 leg chains?"""
import json, os, subprocess, sys, time
from pathlib import Path
RIGGING = Path(__file__).parent
sys.path.insert(0, str(RIGGING))
import numpy as np
import body_plans
ISO_PY = (r"C:\Users\ehart\AppData\Local\Programs\comfy-env\envs"
          r"\unirig-nodes\.pixi\envs\default\python.exe")
EXP = RIGGING / "exp_spider"; EXP.mkdir(exist_ok=True)
MESH = RIGGING.parent / "gallery" / "ba4eb57e0f56" / "rig" / "mesh.npz"
combos = [(2048, "", s) for s in (1, 2, 3, 4, 5, 6, 8, 9, 11, 13)] + \
         [(4096, "", s) for s in (1, 3, 5, 42)] + [(2048, "0.8", s) for s in (1, 3, 5)]
for i, (dens, temp, seed) in enumerate(combos):
    name = f"sp_n{dens}_t{temp or 'def'}_s{seed}"
    oj = EXP / f"{name}.json"
    if oj.exists():
        print(f"[{i+1}] {name} cached"); continue
    env = dict(os.environ)
    env.update({"MESH_NPZ": str(MESH), "OUT_JSON": str(oj), "OUT_NPZ": str(EXP / f"{name}.npz"),
                "DENS": str(dens), "SKEL_TEMP": temp, "SEED": str(seed), "TOY": "spider",
                "HF_HUB_OFFLINE": "1", "KMP_DUPLICATE_LIB_OK": "TRUE"})
    r = subprocess.run([ISO_PY, str(RIGGING / "skel_experiment.py")], env=env,
                       capture_output=True, text=True, timeout=900)
    if not oj.exists():
        oj.write_text(json.dumps({"error": "crash"})); print(f"[{i+1}] {name}: CRASH"); continue
    s = np.load(EXP / f"{name}.npz")
    info = body_plans.classify(s["joints"], s["parents"])
    oj.write_text(json.dumps(info))
    print(f"[{i+1}] {name}: plan={info['plan']} feet={info['feet']} J={info['joints']}", flush=True)
print("SWEEP DONE")
