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


def shard_suite(tests, shard):
    """Keep one of n interleaved slices of the cases ('2/4' is the second of four): the slices are disjoint and
    together hold every case, so n processes can share one file's work."""
    try:index,count=(int(part) for part in shard.split('/'))
    except (AttributeError,ValueError):raise ValueError('shard must be i/n: '+repr(shard)) from None
    if not 1<=index<=count:raise ValueError('shard must be i/n with 1 <= i <= n: '+repr(shard))
    cases=sorted(flatten(tests),key=lambda t:t.id())
    return unittest.TestSuite(t for position,t in enumerate(cases) if position%count==index-1)


def scoped_tests(file, tests):
    lane=os.environ.get('AGENT_MESHES_TEST_LANE','full')
    manifest=json.loads(Path(__file__).with_name('geometry-sweeps.json').read_text())
    cases=list(flatten(tests));by_name={'.'.join(t.id().split('.')[-2:]):t.id() for t in cases}
    policy=manifest[Path(file).name]
    unknown=set(policy)-set(by_name)
    if unknown:raise ValueError('unknown deferred tests: '+', '.join(sorted(unknown)))
    selected=select_suite(unittest.TestSuite(cases),{by_name[name]:reason for name,reason in policy.items()},lane)
    shard=os.environ.get('AGENT_MESHES_TEST_SHARD')
    if shard:
        whole=selected.countTestCases();selected=shard_suite(selected,shard)
        print(f'Geometry shard {shard}: {selected.countTestCases()} of the {whole} selected cases',flush=True)
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
