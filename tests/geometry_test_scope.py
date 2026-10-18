"""Explicit sweep deferrals; unlisted tests always stay in the merge lane."""
from collections import OrderedDict
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest


def flatten(tests):
    for test in tests:
        if isinstance(test, unittest.TestSuite):yield from flatten(test)
        else:yield test


def select_suite(tests, deferred, lane='full'):
    if lane not in ('merge','full'):raise ValueError('unknown geometry test lane: '+lane)
    cases=list(flatten(tests));ids={t.id() for t in cases}
    unknown=set(deferred)-ids
    if unknown:raise ValueError('unknown deferred tests: '+', '.join(sorted(unknown)))
    if any(not isinstance(reason,str) or not reason.strip() for reason in deferred.values()):raise ValueError('deferred tests need reasons')
    return unittest.TestSuite(t for t in cases if lane=='full' or t.id() not in deferred)


def scoped_tests(file, tests):
    lane=os.environ.get('AGENT_MESHES_TEST_LANE','full')
    manifest=json.loads(Path(__file__).with_name('geometry-sweeps.json').read_text())
    cases=list(flatten(tests));by_name={'.'.join(t.id().split('.')[-2:]):t.id() for t in cases}
    policy=manifest[Path(file).name]
    unknown=set(policy)-set(by_name)
    if unknown:raise ValueError('unknown deferred tests: '+', '.join(sorted(unknown)))
    selected=select_suite(unittest.TestSuite(cases),{by_name[name]:reason for name,reason in policy.items()},lane)
    print(f'Geometry scope: {Path(file).name} lane={lane}, {selected.countTestCases()}/{len(cases)} cases',flush=True)
    return selected


class MeshFixtures:
    """One preparation per input, bounded to this process; every caller receives isolated data."""
    def __init__(self, build, capacity=32):
        self.build=build;self.capacity=capacity;self.prepared=OrderedDict()
    def get(self, config):
        key=json.dumps(config,sort_keys=True,allow_nan=False)
        if key not in self.prepared:
            self.prepared[key]=self.build(deepcopy(config))
            if len(self.prepared)>self.capacity:self.prepared.popitem(last=False)
        self.prepared.move_to_end(key)
        return deepcopy(self.prepared[key])


def _character(config):
    recipes=str(Path(__file__).resolve().parents[1]/'recipes')
    if recipes not in sys.path:sys.path.insert(0,recipes)
    import stylized_character as character
    meshes=character.Meshes();character.geometry(config,meshes)
    return meshes.parts,meshes.lofts

character_fixtures=MeshFixtures(_character)
