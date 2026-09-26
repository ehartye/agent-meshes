import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {foliageOperations} from '../recipes/botanical_kit.mjs';

describe('reproducible botanical study recipe',()=>{
  it('repeats geometry while keeping an authored outcome independent of variation seed',()=>{
    for(const family of ['hardware-peanut','soup-tomato','fern','lantern-reed','moss']){
      const settings={family,world:'upside',seed:37};
      const first=foliageOperations(settings);
      assert.deepEqual(foliageOperations(settings),first);
      assert.equal(new Set(first.map(o=>o.part.name)).size,first.length);
      assert.deepEqual(foliageOperations({...settings,seed:38}).map(o=>o.part.name),first.map(o=>o.part.name));
    }
  });
  it('keeps fruit out of seedlings and makes buoyancy visible only in the Upside',()=>{
    const names=settings=>foliageOperations(settings).map(o=>o.part.name);
    assert.equal(names({family:'soup-tomato',stage:'seedling'}).some(n=>n.startsWith('fruit-')),false);
    assert.equal(names({family:'soup-tomato',world:'home'}).some(n=>n.startsWith('fruit-tether')),false);
    assert.equal(names({family:'soup-tomato',world:'upside'}).filter(n=>n.startsWith('fruit-tether')).length,3);
    assert.equal(names({family:'hardware-peanut',world:'upside'}).filter(n=>n.startsWith('fin-')&&!n.endsWith('-vein')).length,6);
  });
  it('rejects invalid recipes instead of silently changing the plant',()=>{
    for(const bad of [{family:'unknown'},{world:'typo'},{stage:'ripe'},{scale:0},{scale:Infinity},{seed:.5}])assert.throws(()=>foliageOperations(bad));
  });
});
