"""One-shot, idempotent SkinTokens sidecar setup (see README.md here).

Clones VAST-AI-Research/SkinTokens at the pinned commit, applies the sdpa
patch (no flash-attn build needed on sm_120/Windows), drops the shim, builds
the uv venv, downloads checkpoints, and smoke-tests skin generation on the
repo's giraffe example. Safe to re-run; each step skips work already done.

usage: python setup_sidecar.py [--skip-smoke]
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.environ.get("SKINTOKENS_DIR", r"C:\Users\ehart\repos\SkinTokens")
REPO_URL = "https://github.com/VAST-AI-Research/SkinTokens.git"
PIN = "273b691"          # last reviewed commit; bump deliberately, re-check patch
VENV_PY = os.path.join(SIDECAR, ".venv", "Scripts", "python.exe")
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"


def run(args, **kw):
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-smoke", action="store_true")
    opts = ap.parse_args()

    # 1. clone at the pin
    if not os.path.isdir(os.path.join(SIDECAR, ".git")):
        run(["git", "clone", REPO_URL, SIDECAR])
        run(["git", "-C", SIDECAR, "checkout", PIN])

    # 2. sdpa patch (idempotent: skip when already applied)
    chk = subprocess.run(["git", "-C", SIDECAR, "apply", "--check",
                          os.path.join(HERE, "tokenrig-sdpa.patch")],
                         capture_output=True)
    if chk.returncode == 0:
        run(["git", "-C", SIDECAR, "apply", os.path.join(HERE, "tokenrig-sdpa.patch")])
    else:
        print("patch already applied (or upstream changed — verify manually)")

    # 3. flash-attn sdpa shim at repo root (import target for their try-blocks)
    shutil.copy(os.path.join(HERE, "flash_attn_interface.py"),
                os.path.join(SIDECAR, "flash_attn_interface.py"))

    # 4. venv + deps (uv caches wheels; rebuild is cheap)
    if not os.path.exists(VENV_PY):
        run(["uv", "venv", "--python", "3.11"], cwd=SIDECAR)
    run(["uv", "pip", "install", "--python", VENV_PY,
         "torch==2.7.0", "--index-url", TORCH_INDEX])
    run(["uv", "pip", "install", "--python", VENV_PY,
         "-r", os.path.join(SIDECAR, "requirements.txt")])
    run(["uv", "pip", "install", "--python", VENV_PY, "scipy"])  # asset.py needs it, not in their reqs

    # 5. checkpoints (hf skips files already present)
    run([VENV_PY, "download.py", "--model"], cwd=SIDECAR)

    # 6. smoke test: full rig on their giraffe example
    if not opts.skip_smoke:
        out = os.path.join(SIDECAR, "results", "setup_check.glb")
        if os.path.exists(out):
            os.remove(out)
        run([VENV_PY, "demo.py", "--input", os.path.join(SIDECAR, "examples", "giraffe.glb"),
             "--output", out], cwd=SIDECAR)
        if not os.path.exists(out):
            sys.exit("smoke test produced no output GLB")
        print(f"\nSIDECAR READY — smoke output: {out}")


if __name__ == "__main__":
    main()
