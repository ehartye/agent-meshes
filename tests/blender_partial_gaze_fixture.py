"""The real combined-body fixture opts into gaze without claiming a facial contract."""
import importlib.util
from pathlib import Path
source = Path(__file__).with_name('blender_sculpt_eye_rig_fixture.py')
spec = importlib.util.spec_from_file_location('sculpt_eyes_fixture', source)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def build():
    return fixture.build(partial=True)
