"""R1 sweep: official-style mix sampling (65536 pts, 8192 vertex samples) vs the
E0 baseline, on the two hardest toys. Hit-rates decide adoption.

Baselines (E0 + spider_sweep, surface-only):
  spider @2048: >=6 legs 3/17 (18%), 8 legs 1/17 (6%)
  fox: tail>=2 only in 16384+t0.8 rolls (2/2 there; 0 elsewhere at 2048)
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

RIGGING = Path(__file__).parent
sys.path.insert(0, str(RIGGING))
import numpy as np

import body_plans

GALLERY = RIGGING.parent / "gallery"
ISO_PY = (r"C:\Users\ehart\AppData\Local\Programs\comfy-env\envs"
          r"\unirig-nodes\.pixi\envs\default\python.exe")
EXP = RIGGING / "exp_r1"
EXP.mkdir(exist_ok=True)

TOYS = {"spider": "ba4eb57e0f56", "fox": "c686134433de"}
SEEDS = [1, 2, 3, 4, 5, 7, 9, 11, 13, 42]
CONFIGS = [("mix64k", 65536, 8192, ""), ("mix64k_t08", 65536, 8192, "0.8")]

for tag, tid in TOYS.items():
    for cname, dens, vsamp, temp in CONFIGS:
        for seed in SEEDS:
            name = f"{tag}_{cname}_s{seed}"
            oj = EXP / f"{name}.json"
            if oj.exists():
                print(f"{name} cached", flush=True)
                continue
            env = dict(os.environ)
            env.update({"MESH_NPZ": str(GALLERY / tid / "rig" / "mesh.npz"),
                        "OUT_JSON": str(oj), "OUT_NPZ": str(EXP / f"{name}.npz"),
                        "DENS": str(dens), "VSAMP": str(vsamp), "SKEL_TEMP": temp,
                        "SEED": str(seed), "TOY": tag,
                        "HF_HUB_OFFLINE": "1", "KMP_DUPLICATE_LIB_OK": "TRUE"})
            t0 = time.time()
            subprocess.run([ISO_PY, str(RIGGING / "skel_experiment.py")], env=env,
                           capture_output=True, text=True, timeout=900)
            dt = round(time.time() - t0, 1)
            if not oj.exists():
                oj.write_text(json.dumps({"error": "crash"}))
                print(f"{name}: CRASH {dt}s", flush=True)
                continue
            s = np.load(EXP / f"{name}.npz")
            info = body_plans.classify(s["joints"], s["parents"])
            info["tail_chain"] = body_plans.tail_chain_len(s["joints"], list(s["parents"]))
            info["secs"] = dt
            oj.write_text(json.dumps(info))
            print(f"{name}: plan={info['plan']} feet={info['feet']} "
                  f"tail={info['tail_chain']} J={info['joints']} {dt}s", flush=True)

# ---- summary ----
print("\n=== R1 hit-rates ===")
for tag in TOYS:
    for cname, *_ in CONFIGS:
        rows = [json.loads((EXP / f"{tag}_{cname}_s{s}.json").read_text()) for s in SEEDS
                if (EXP / f"{tag}_{cname}_s{s}.json").exists()]
        rows = [r for r in rows if "error" not in r]
        if not rows:
            continue
        n = len(rows)
        if tag == "spider":
            print(f"spider {cname}: >=6 legs {sum(r['feet'] >= 6 for r in rows)}/{n}, "
                  f"8 legs {sum(r['feet'] == 8 for r in rows)}/{n} "
                  f"(baseline 3/17, 1/17)")
        else:
            print(f"fox    {cname}: 4 feet {sum(r['feet'] == 4 for r in rows)}/{n}, "
                  f"tail>=2 {sum(r['tail_chain'] >= 2 for r in rows)}/{n} "
                  f"(baseline tail: 2/12 overall, only at 16384+t0.8)")
print("SWEEP DONE", flush=True)
