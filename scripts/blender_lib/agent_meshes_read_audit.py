"""Bounded diagnostics for trusted authoring, not a sandbox or dependency closure.

CPython's open event fires before the operation, so missing-file attempts count.
Native file I/O, child processes, directory enumeration and network are not covered.
"""
import os
import sys


class ReadAudit:
    def __init__(self, runtime_roots=(), ignored_roots=(), max_paths=20000):
        self.reads = set()
        self.unresolved = 0
        self.truncated = False
        self.active = True
        self.installed = False
        self.result = None
        self.max_paths = max_paths
        self.runtime_roots = [os.path.realpath(root) for root in runtime_roots]
        self.ignored_roots = [os.path.normcase(os.path.realpath(root)) for root in ignored_roots]
        sys.addaudithook(self._event)
        # Existing hooks may silently refuse installation. Verify our own event.
        sys.audit('agent_meshes.read_audit_probe')

    def _path(self, path):
        if not isinstance(path, (str, bytes, os.PathLike)):
            self.unresolved += 1
            return
        try:
            value = os.path.realpath(os.fsdecode(path))
            key = os.path.normcase(value)
            if any(key == root or key.startswith(root + os.sep) for root in self.ignored_roots):
                return
            if len(self.reads) >= self.max_paths and value not in self.reads:
                self.truncated = True
            else:
                self.reads.add(value)
        except (TypeError, ValueError, OSError):
            self.unresolved += 1

    def _event(self, event, args):
        if not self.active:
            return
        if event == 'agent_meshes.read_audit_probe':
            self.installed = True
        elif event == 'open':
            path, mode, flags = args
            # os.open has mode=None; O_RDONLY is zero. Read/write opens matter.
            reads = ('r' in mode or '+' in mode) if isinstance(mode, str) else not (flags & os.O_WRONLY)
            if reads:
                # CPython's event omits dir_fd. A relative os.open path cannot
                # safely be resolved against cwd: it may use a different fd root.
                if mode is None and isinstance(path, (str, bytes)) and not os.path.isabs(path):
                    self.unresolved += 1
                else:
                    self._path(path)

    def finish(self):
        if self.result is not None:
            return self.result
        # Also cover source modules imported before observation started. Native
        # modules remain observable filenames, not proof of their internal reads.
        for module in list(sys.modules.values()):
            path = getattr(module, '__file__', None)
            if isinstance(path, str) and os.path.isabs(path):
                self._path(path)
        self.active = False
        self.result = {'schema': 1, 'installed': self.installed,
                       'reads': sorted(self.reads), 'runtimeRoots': self.runtime_roots,
                       'unresolvedEvents': self.unresolved, 'truncated': self.truncated}
        return self.result
