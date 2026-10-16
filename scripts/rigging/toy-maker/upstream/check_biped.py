"""One-command biped byte-identity gate (#10).

Runs the frozen baseline rig (tests/baselines/biped_rig.npz — the android's
rigged_input snapshot) + the tracked flat walk clip through retarget2 and
compares the output GLB's sha256 against tests/baselines/biped_walk.sha256.

The biped path is sacred: any PR that does NOT intend to change biped output
must leave this green. A PR that intentionally changes it (e.g. #14 root bob)
regenerates the hash with --update and says so in the PR body.

usage: python rigging/check_biped.py [--update]
"""
import hashlib
import os
import subprocess
import sys
import tempfile

RIGGING = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(RIGGING)
BASE = os.path.join(REPO, "tests", "baselines")
RIG = os.path.join(BASE, "biped_rig.npz")
HASH = os.path.join(BASE, "biped_walk.sha256")
PY = sys.executable


def main():
    out = os.path.join(tempfile.mkdtemp(prefix="biped_gate_"), "walk.glb")
    r = subprocess.run(
        [PY, os.path.join(RIGGING, "retarget2.py")], cwd=RIGGING,
        env={**os.environ, "RIGGED_INPUT": RIG,
             "CLIP_PATH": os.path.join(RIGGING, "clips", "walk.npz"),
             "OUT_GLB": out, "SHOW_SKELETON": "0", "KMP_DUPLICATE_LIB_OK": "TRUE"},
        capture_output=True, text=True)
    if not os.path.exists(out):
        sys.exit("retarget2 produced no GLB:\n" + (r.stderr or "")[-800:])
    digest = hashlib.sha256(open(out, "rb").read()).hexdigest()
    if "--update" in sys.argv:
        with open(HASH, "w") as f:
            f.write(digest + "\n")
        print(f"baseline updated: {digest}")
        return
    want = open(HASH).read().strip()
    if digest == want:
        print(f"BIPED GATE OK ({digest[:12]}...)")
    else:
        sys.exit(f"BIPED GATE FAILED\n  expected {want}\n  got      {digest}\n"
                 f"If this change to biped output is INTENTIONAL, rerun with "
                 f"--update and call it out in the PR.")


if __name__ == "__main__":
    main()
