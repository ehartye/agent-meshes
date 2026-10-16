"""Launch the exact inference snapshot with one explicit replacement of its source root.

Run in the caller-supplied isolated UniRig interpreter; never install or download.
The raw snapshot remains unchanged for provenance and comparison.
"""
from pathlib import Path
import ast
import os
import sys

source = Path(__file__).resolve().parent / 'upstream/rig_skin_test.py'
root = os.environ['AGENT_MESHES_COMFY_ROOT']
tree = ast.parse(source.read_text(encoding='utf-8-sig'), filename=str(source))
assignments = [node for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'COMFY' for target in node.targets)]
if len(assignments) != 1:
    raise RuntimeError('Pinned UniRig COMFY assignment changed; review the adapter')
assignments[0].value = ast.Constant(value=root)
ast.fix_missing_locations(tree)
sys.path.insert(0, str(source.parent))
exec(compile(tree, str(source), 'exec'), {'__name__': '__main__', '__file__': str(source)})
