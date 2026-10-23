"""Explicit-path CPU adapters around the pinned rigging source snapshots.

No dependency installation, model downloads, backend selection or network access.
NPZ inputs must be trusted: the imported upstream schema contains object arrays.
"""
from pathlib import Path
from contextlib import ExitStack
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[2]
UPSTREAM = HERE / 'upstream'
CATALOG = PACKAGE / 'scripts/reference-assets/rigs/catalog.json'


def catalog():
    return json.loads(CATALOG.read_text(encoding='utf-8'))


def library(identifier):
    for record in catalog()['libraries']:
        if record['id'] == identifier:
            return record
    raise ValueError(f'Unknown rig library: {identifier}')


def asset_path(record):
    return (CATALOG.parent / record['path']).resolve()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_payloads():
    inventory = json.loads((HERE / 'inventory.json').read_text(encoding='utf-8'))
    for record in catalog()['libraries']:
        if digest(asset_path(record)) != record['sha256']:
            raise ValueError(f'GLB hash mismatch: {record["id"]}')
    snapshots = [r for r in inventory['riggingFiles'] if 'destination' in r]
    for record in snapshots:
        if digest(PACKAGE / record['destination']) != record['sha256']:
            raise ValueError(f'Source snapshot hash mismatch: {record["sourcePath"]}')
    return {'libraries': len(catalog()['libraries']), 'sourceSnapshots': len(snapshots)}


def upstream(name):
    # Keep upstream's bare internal imports confined to this known source directory.
    if str(UPSTREAM) not in sys.path:
        sys.path.insert(0, str(UPSTREAM))
    spec = importlib.util.spec_from_file_location('rig_tools_' + name, UPSTREAM / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def output_path(value, *, suffix=None):
    path = Path(value).resolve()
    if suffix is not None and path.suffix != suffix:
        raise ValueError(f'Output must end in {suffix}: {path}')
    if path.is_relative_to(HERE) or path.is_relative_to(CATALOG.parent):
        raise ValueError('Write generated artifacts to an owned project directory outside the library')
    if path.exists():
        raise FileExistsError(f'Choose a fresh output path: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def extract(identifier, clip, output):
    import numpy as np
    record = library(identifier)
    match = next((c for c in record['clips'] if clip in (c['id'], c['name'])), None)
    if match is None:
        raise ValueError(f'Unknown clip {clip!r} in {identifier}')
    destination = output_path(output, suffix='.npz')
    # Upstream bake is fixed60Hz. Keep extraction at60Hz to preserve its time base.
    upstream('glb_clip').extract(asset_path(record), match['name'], destination, fps=60.)
    with np.load(destination, allow_pickle=True) as data:
        positions = data['pose_world'][:, :, :3, 3]
        if not np.isfinite(positions).all():
            raise ValueError('Extracted pose contains nonfinite values')
        frames = positions.shape[1]
        travel = float(np.linalg.norm(positions - positions[:, :1], axis=2).max())
    return {'output': str(destination), 'sha256': digest(destination), 'library': identifier,
            'clip': match['name'], 'fps': 60, 'frames': frames, 'maximumJointTravel': travel,
            'scope': 'upstream FK extraction; no runtime/skin/contact acceptance'}


def run_script(name, output, environment):
    destination = output_path(output)
    # No caller defaults or sibling paths: the adapter passes every input/output.
    with tempfile.TemporaryDirectory(prefix='meshes-rig-tools-') as directory:
        result = subprocess.run([sys.executable, str(UPSTREAM / (name + '.py'))],
                                cwd=directory, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                                                    **environment},
                                capture_output=True, text=True, check=False)
    if result.returncode != 0 or not destination.is_file():
        raise RuntimeError(f'{name} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}')
    return result.stdout


def retarget(identifier, rig, clip_npz, output, *, weight_policy='upstream', presentation='diagnostic'):
    import numpy as np
    record = library(identifier)
    if weight_policy not in ('upstream', 'preserve'):
        raise ValueError('weight_policy must be upstream or preserve')
    if presentation not in ('diagnostic', 'asset'):
        raise ValueError('presentation must be diagnostic or asset')
    destination = output_path(output, suffix='.glb')
    optional = output_path(destination.with_suffix('.usdz')) if presentation == 'asset' else None
    # Upstream may overwrite its implicit USDZ sibling. Confine both writes to a
    # fresh owned directory, then publish only this job's products exclusively.
    with tempfile.TemporaryDirectory(prefix='meshes-retarget-', dir=destination.parent) as directory:
        staged = Path(directory) / destination.name
        environment = {'RIGGED_INPUT': str(Path(rig).resolve()), 'CLIP_PATH': str(Path(clip_npz).resolve()),
                       'OUT_GLB': str(staged), 'SOURCE_LIB': identifier,
                       # Overlay mode avoids upstream's implicit optional USD export attempt.
                       'SHOW_SKELETON': '1' if presentation == 'diagnostic' else '0'}
        if weight_policy == 'preserve':
            environment.update(RIG_GEODESIC='0', RIG_UNSHRED='0')
        log = run_script(record['retarget'], staged, environment)
        # Verify actual authored curves before publishing the staged GLB.
        reader = upstream('glb_clip')
        from pygltflib import GLTF2
        glb = GLTF2().load(str(staged))
        rotations = [reader._accessor(glb, glb.binary_blob(), a.samplers[c.sampler].output)
                     for a in glb.animations for c in a.channels if c.target.path == 'rotation']
        if not rotations or any(not np.isfinite(r).all() for r in rotations):
            raise ValueError('Retarget produced missing/nonfinite rotation curves')
        # q/-q equivalence: minimum distance to either representation of the first pose.
        movement = max(float(np.minimum(np.linalg.norm(r-r[:1], axis=1),
                                        np.linalg.norm(r+r[:1], axis=1)).max()) for r in rotations)
        staged_optional = staged.with_suffix('.usdz')
        produced_optional = optional is not None and staged_optional.is_file()
        products = [(staged, destination)]
        if produced_optional:
            products.append((staged_optional, optional))
        _publish_outputs(products)
    return {'output': str(destination), 'sha256': digest(destination), 'frames': len(rotations[0]),
            'maximumQuaternionChange': movement, 'weightPolicy': weight_policy,
            'presentation': presentation,
            'optionalUsdz': str(optional) if produced_optional else None,
            'scope': 'actual CPU solve/bake; not art approval', 'log': log}


def _publish_outputs(products):
    """Reserve every final path exclusively before copying any staged artifact."""
    created = []
    try:
        with ExitStack() as stack:
            writers = []
            for source, destination in products:
                writer = stack.enter_context(destination.open('xb'))
                created.append(destination)
                writers.append((source, writer))
            for source, writer in writers:
                with source.open('rb') as reader:
                    shutil.copyfileobj(reader, writer)
    except BaseException:
        # Only remove paths successfully created by this call, after handles close.
        for destination in created:
            destination.unlink()
        raise


def reference_target(identifier, output):
    """Diagnostic target: selected bind-joint chains and remapped original donor skin.

    This exercises the imported solver; it is not auto-rigging a new character.
    Original local bind rotations are replaced by the solver's positional rest frame.
    """
    import numpy as np
    from pygltflib import GLTF2
    record = library(identifier)
    reader = upstream('glb_clip')
    glb = GLTF2().load(str(asset_path(record)))
    blob, skin = glb.binary_blob(), glb.skins[0]
    all_names = [glb.nodes[n].name for n in skin.joints]
    if identifier.startswith('human'):
        keep = {'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'head_leaf'}
        for side in ('l', 'r'):
            keep.update(f'{n}_{side}' for n in ('clavicle', 'upperarm', 'lowerarm', 'hand',
                                                'middle_01', 'thigh', 'calf', 'foot', 'ball', 'ball_leaf'))
    else:
        cfg = upstream('body_plans').LIBRARIES[identifier]
        keep = set(cfg['spine'] + cfg.get('tail', []))
        for group in ('legs', 'arms', 'wings', 'side_pair'):
            for chain in cfg.get(group, {}).values():
                keep.update(chain)
    selected = [i for i, name in enumerate(all_names) if name in keep]
    lookup = {old: new for new, old in enumerate(selected)}
    node_to_old = {node: i for i, node in enumerate(skin.joints)}
    parent_nodes = {child: i for i, node in enumerate(glb.nodes) for child in node.children or []}
    def nearest(old):
        node = skin.joints[old]
        while node in parent_nodes:
            node = parent_nodes[node]
            if node in node_to_old and node_to_old[node] in lookup:
                return lookup[node_to_old[node]]
        return -1
    parents = [nearest(old) for old in selected]
    if parents.count(-1) != 1:
        raise ValueError('Diagnostic target requires one selected root')
    ibm = reader._accessor(glb, blob, skin.inverseBindMatrices).reshape(-1, 4, 4).transpose(0, 2, 1)
    joints = np.linalg.inv(ibm)[selected, :3, 3]
    primitive = next(p for m in glb.meshes for p in m.primitives if p.attributes.JOINTS_0 is not None)
    vertices = reader._accessor(glb, blob, primitive.attributes.POSITION).astype(np.float32)
    faces = reader._accessor(glb, blob, primitive.indices).astype(np.uint32).reshape(-1, 3)
    indices = reader._accessor(glb, blob, primitive.attributes.JOINTS_0).astype(int)
    original_weights = reader._accessor(glb, blob, primitive.attributes.WEIGHTS_0)
    if glb.accessors[primitive.attributes.WEIGHTS_0].normalized:
        original_weights /= np.iinfo(reader._CT[glb.accessors[primitive.attributes.WEIGHTS_0].componentType]).max
    weights = np.zeros((len(vertices), len(selected)), np.float32)
    for column in range(indices.shape[1]):
        mapped = np.array([lookup.get(i, nearest(i)) for i in indices[:, column]])
        mapped[mapped < 0] = parents.index(-1)
        np.add.at(weights, (np.arange(len(vertices)), mapped), original_weights[:, column])
    weights /= np.maximum(weights.sum(1, keepdims=True), 1e-12)
    destination = output_path(output, suffix='.npz')
    np.savez(destination, vertices=vertices, faces=faces, weights=weights, joints=joints,
             parents=np.array(parents), names=np.array([all_names[i] for i in selected]), tails=joints)
    return destination


def readiness(*, unirig_root=None, unirig_python=None, skintokens_root=None, skintokens_python=None):
    from importlib.util import find_spec
    def external(root, interpreter, files):
        configured = root is not None and interpreter is not None
        checks = {'python': bool(interpreter and Path(interpreter).is_file())}
        for name in files:
            checks[name] = bool(root and (Path(root) / name).is_file())
        return {'configured': configured, 'filesPresent': checks,
                'executionVerified': False, 'readyToInspect': configured and all(checks.values())}
    return {'cpuModules': {name: find_spec(name) is not None for name in ('numpy', 'scipy', 'trimesh', 'pygltflib')},
            'unirig': external(unirig_root, unirig_python,
                               ['custom_nodes/ComfyUI-UniRig/nodes/unirig/direct.py',
                                'models/unirig/skeleton.safetensors', 'models/unirig/skin.safetensors']),
            'skintokens': external(skintokens_root, skintokens_python,
                                  ['demo.py', 'experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt']),
            'automaticFallback': False, 'scope': 'path/module presence only; no model import, downloads or inference'}


def infer_unirig(mesh, output, *, comfy_root, python):
    """Explicit external inference. The current import has not executed this backend."""
    state = readiness(unirig_root=comfy_root, unirig_python=python)['unirig']
    if not state['readyToInspect']:
        raise ValueError(f'Explicit UniRig environment/checkpoints are incomplete: {state}')
    destination = output_path(output, suffix='.npz')
    result = subprocess.run([str(Path(python).resolve()), str(HERE / 'unirig_worker.py')],
                            env={**os.environ, 'AGENT_MESHES_COMFY_ROOT': str(Path(comfy_root).resolve()),
                                 'MESH_NPZ': str(Path(mesh).resolve()), 'OUTPUT_NPZ': str(destination),
                                 'RIG_MODE': 'full', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                                 'PYTHONDONTWRITEBYTECODE': '1'},
                            cwd=destination.parent, capture_output=True, text=True, check=False)
    if not destination.is_file():
        raise RuntimeError(f'UniRig produced no output ({result.returncode}): {result.stdout}\n{result.stderr}')
    import numpy as np
    with np.load(destination, allow_pickle=True) as data:
        for name in ('joints', 'skin_weights'):
            if not np.isfinite(data[name]).all(): raise ValueError(f'Nonfinite UniRig {name}')
    return {'output': str(destination), 'sha256': digest(destination), 'processExit': result.returncode,
            'backend': 'unirig', 'automaticFallback': False, 'log': result.stdout}


def skin_skintokens(mesh, candidate, output, work_dir, *, sidecar_root, python):
    state = readiness(skintokens_root=sidecar_root, skintokens_python=python)['skintokens']
    if not state['readyToInspect']:
        raise ValueError(f'Explicit SkinTokens environment/checkpoints are incomplete: {state}')
    destination = output_path(output, suffix='.npz')
    work = Path(work_dir).resolve()
    if work.is_relative_to(HERE): raise ValueError('Use a project-owned work directory')
    work.mkdir(parents=True, exist_ok=False)
    module = upstream('skintokens_skin')
    module.SIDECAR, module.VENV_PY = str(Path(sidecar_root).resolve()), str(Path(python).resolve())
    module.skin_to_rig_result(str(Path(mesh).resolve()), str(Path(candidate).resolve()), str(destination), str(work))
    return {'output': str(destination), 'sha256': digest(destination), 'backend': 'skintokens',
            'automaticFallback': False, 'scope': 'explicit external wrapper; source allows up to4 same-backend retries'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('catalog')
    sub.add_parser('verify')
    ready = sub.add_parser('readiness')
    for name in ('unirig-root', 'unirig-python', 'skintokens-root', 'skintokens-python'):
        ready.add_argument('--' + name)
    ex = sub.add_parser('extract'); ex.add_argument('library'); ex.add_argument('clip'); ex.add_argument('output')
    target = sub.add_parser('reference-target'); target.add_argument('library'); target.add_argument('output')
    rt = sub.add_parser('retarget'); rt.add_argument('library'); rt.add_argument('rig'); rt.add_argument('clip'); rt.add_argument('output')
    rt.add_argument('--weight-policy', choices=['upstream', 'preserve'], default='upstream')
    rt.add_argument('--presentation', choices=['diagnostic', 'asset'], default='diagnostic',
                    help='asset also attempts the upstream optional USD export')
    template = sub.add_parser('spider-template'); template.add_argument('mesh'); template.add_argument('output')
    prep = sub.add_parser('prepare-skin'); prep.add_argument('mesh_glb'); prep.add_argument('rig'); prep.add_argument('output')
    infer = sub.add_parser('infer-unirig'); infer.add_argument('mesh'); infer.add_argument('output')
    infer.add_argument('--comfy-root', required=True); infer.add_argument('--python', required=True)
    skin = sub.add_parser('skin-skintokens'); skin.add_argument('mesh'); skin.add_argument('candidate')
    skin.add_argument('output'); skin.add_argument('work_dir')
    skin.add_argument('--sidecar-root', required=True); skin.add_argument('--python', required=True)
    args = parser.parse_args()
    if args.command == 'catalog': result = catalog()
    elif args.command == 'verify': result = verify_payloads()
    elif args.command == 'readiness':
        result = readiness(**{key: value for key, value in vars(args).items() if key != 'command'})
    elif args.command == 'extract': result = extract(args.library, args.clip, args.output)
    elif args.command == 'reference-target': result = {'output': str(reference_target(args.library, args.output))}
    elif args.command == 'retarget':
        result = retarget(args.library, args.rig, args.clip, args.output,
                          weight_policy=args.weight_policy, presentation=args.presentation)
    elif args.command == 'infer-unirig':
        result = infer_unirig(args.mesh, args.output, comfy_root=args.comfy_root, python=args.python)
    elif args.command == 'skin-skintokens':
        result = skin_skintokens(args.mesh, args.candidate, args.output, args.work_dir,
                                 sidecar_root=args.sidecar_root, python=args.python)
    elif args.command == 'spider-template':
        output = output_path(args.output, suffix='.npz')
        built = upstream('spider_template').build(Path(args.mesh).resolve(), output)
        if built is None: raise ValueError('Template did not detect a clean eight-legged mesh; no fallback ran')
        result = {'output': str(built), 'scope': 'template candidate; inspect before skinning'}
    else:
        output = output_path(args.output, suffix='.npz')
        log = run_script('prep_skin', output, {'SRC_GLB': str(Path(args.mesh_glb).resolve()),
                                              'RIG_NPZ': str(Path(args.rig).resolve()), 'OUT_RIGGED': str(output)})
        result = {'output': str(output), 'log': log}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
