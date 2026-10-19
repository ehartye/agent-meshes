"""Run each observer test in its own process: Python hooks cannot be removed."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'


class ReadAuditTests(unittest.TestCase):
    def run_probe(self, body, prelude='', options=''):
        with tempfile.TemporaryDirectory(prefix='mesh-read-audit-') as root:
            code = f"""import sys,json,os
from pathlib import Path
sys.path.insert(0, {str(LIB)!r})
from agent_meshes_read_audit import ReadAudit
root=Path({root!r})
(root/'data.bin').write_bytes(b'data')
(root/'module.py').write_text('VALUE=12')
sys.path.insert(0,str(root))
{prelude}
audit=ReadAudit({options})
{body}
print(json.dumps(audit.finish()))
"""
            result = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True, check=True)
            return json.loads(result.stdout), Path(root)

    def test_reads_imports_and_read_write_are_observed_but_writes_are_not(self):
        result, root = self.run_probe("(root/'data.bin').read_bytes()\nimport module\nwith open(root/'data.bin','r+b') as f: f.read()\n(root/'write.bin').write_bytes(b'output')")
        self.assertEqual(result['schema'], 1)
        self.assertTrue(result['installed'])
        self.assertIn(str(root/'data.bin'), result['reads'])
        self.assertIn(str(root/'module.py'), result['reads'])
        self.assertNotIn(str(root/'write.bin'), result['reads'])

    def test_relative_byte_paths_missing_attempts_and_os_open(self):
        result, root = self.run_probe("os.chdir(root)\nwith open(b'data.bin','rb') as f: f.read()\nfd=os.open('data.bin',os.O_RDONLY);os.close(fd)\ntry: open('optional.txt','rb')\nexcept FileNotFoundError: pass")
        self.assertIn(str(root/'data.bin'), result['reads'])
        self.assertIn(str(root/'optional.txt'), result['reads'])

    def test_unresolvable_descriptor_is_incomplete_and_observer_stops(self):
        result, root = self.run_probe("fd=os.open(root/'data.bin',os.O_RDONLY)\nwith open(fd,'rb',closefd=False) as f: f.read()\nos.close(fd)\naudit.finish()\n(root/'after.txt').write_text('after')\n(root/'after.txt').read_text()")
        self.assertGreater(result['unresolvedEvents'], 0)
        self.assertNotIn(str(root/'after.txt'), result['reads'])

    def test_existing_hook_can_refuse_installation_and_self_probe_exposes_it(self):
        prelude = "def refuse(event,args):\n    if event=='sys.addaudithook': raise RuntimeError('refused')\nsys.addaudithook(refuse)"
        result, _ = self.run_probe("(root/'data.bin').read_bytes()", prelude=prelude)
        self.assertFalse(result['installed'])

    def test_path_budget_reports_truncation_instead_of_complete_observation(self):
        result, _ = self.run_probe("(root/'data.bin').read_bytes()\n(root/'module.py').read_text()", options='max_paths=1')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['reads']), 1)

    def test_relative_os_open_is_incomplete_because_audit_event_omits_dir_fd(self):
        result, _ = self.run_probe("os.chdir(root)\nfd=os.open('data.bin',os.O_RDONLY);os.close(fd)")
        self.assertGreater(result['unresolvedEvents'], 0)


if __name__ == '__main__':
    unittest.main()
