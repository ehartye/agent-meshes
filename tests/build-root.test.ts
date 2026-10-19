/** @lane merge
 * @subject src/build-provenance.ts
 */
import {afterEach,expect,it} from 'vitest';
import {link,mkdir,mkdtemp,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,parse,relative} from 'node:path';
import {captureBuildInputs,captureBuildRoot} from '../src/build-provenance.ts';
const cleanup:string[]=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'mesh-project-root-')));cleanup.push(parent);
 const root=join(parent,'project');const leaf=join(root,'assets','barrel');
 await mkdir(leaf,{recursive:true});await mkdir(join(root,'lib'));
 await writeFile(join(root,'lib','shared.py'),'WIDTH=1\n');await writeFile(join(root,'defaults.json'),'{}');
 await writeFile(join(leaf,'build.json'),'{}');await writeFile(join(leaf,'asset.py'),'# asset\n');
 const args={configFile:join(leaf,'build.json'),projectRoot:'../..',configurations:[{path:'../../defaults.json'},{path:'build.json'}],script:join(leaf,'asset.py'),output:join(leaf,'generated')};
 return{parent,root,leaf,args};
}
it('shares one declared library from two leaf configs and writes root-relative identities',async()=>{
 const {root,leaf,args}=await fixture();const second=join(root,'assets','tank');await mkdir(second);await writeFile(join(second,'build.json'),'{}');await writeFile(join(second,'asset.py'),'# tank');
 const firstRoot=await captureBuildRoot(args);expect(firstRoot.base).toBe(root);expect(firstRoot.receipt).toEqual({relativeToConfig:'../..',scope:'project-root'});
 const first=await captureBuildInputs(args.configFile,args.script,[{dir:'lib'}],args.output,firstRoot.base);
 const nextRoot=await captureBuildRoot({...args,configFile:join(second,'build.json'),script:join(second,'asset.py'),output:join(second,'generated')});
 const next=await captureBuildInputs(join(second,'build.json'),'asset.py',[{dir:'lib'}],join(second,'generated'),nextRoot.base);
 expect(first.config.path).toBe('assets/barrel/build.json');expect(first.entry.path).toBe('assets/barrel/asset.py');expect(next.entry.path).toBe('assets/tank/asset.py');
 expect(first.files.find(file=>file.path==='lib/shared.py')).toEqual(next.files.find(file=>file.path==='lib/shared.py'));
 await writeFile(join(root,'lib','shared.py'),'WIDTH=2\n');await expect(first.assertUnchanged()).rejects.toThrow(/changed/i);await expect(next.assertUnchanged()).rejects.toThrow(/changed/i);
 expect(leaf).not.toBe(root);
});
it('allows a leaf root and ordinary output/staging creation without root mtime failures',async()=>{
 const {args,leaf}=await fixture();const local=await captureBuildRoot({...args,projectRoot:'.',configurations:[{path:'build.json'}]});
 await mkdir(join(leaf,'stage'));await writeFile(join(leaf,'stage','model.glb'),'output');await mkdir(args.output);await local.assertUnchanged();
});
it('rejects roots and config/script/output locations outside the explicit boundary',async()=>{
 const {parent,root,args}=await fixture();
 for(const projectRoot of [parse(root).root,relative(dirname(args.configFile),parse(root).root).split('\\').join('/'),root,'C:/absolute','C:\\absolute',''])await expect(captureBuildRoot({...args,projectRoot})).rejects.toThrow(/root/i);
 await expect(captureBuildRoot({...args,projectRoot:'../../..'})).resolves.toHaveProperty('base',parent);
 await expect(captureBuildRoot({...args,projectRoot:'..',configurations:[]})).resolves.toHaveProperty('base',dirname(dirname(args.configFile)));
 await writeFile(join(parent,'outside.py'),'# outside');
 for(const change of [{projectRoot:'../../../missing'},{script:join(parent,'outside.py')},{output:join(parent,'output')},{configurations:[{path:'../../../outside.py'}]}])await expect(captureBuildRoot({...args,...change})).rejects.toThrow(/root|outside|missing|contain/i);
 await expect(captureBuildRoot({...args,output:root})).rejects.toThrow(/output/i);
});
it('detects root replacement while permitting byte-identical replacement inputs to be checked separately',async()=>{
 const {root,args}=await fixture();const captured=await captureBuildRoot(args);await rename(root,`${root}-old`);await mkdir(root);await expect(captured.assertUnchanged()).rejects.toThrow(/root.*changed|changed.*root/i);
});
it('rejects linked root, script, config and output ancestors without following them',async()=>{
 const {parent,root,leaf,args}=await fixture();const alias=join(parent,'alias');await symlink(root,alias,process.platform==='win32'?'junction':'dir');
 await expect(captureBuildRoot({...args,configFile:join(alias,'assets','barrel','build.json'),script:join(alias,'assets','barrel','asset.py'),output:join(alias,'assets','barrel','generated')})).rejects.toThrow(/link|alias/i);
 const linkedSource=join(root,'linked-source');await symlink(leaf,linkedSource,process.platform==='win32'?'junction':'dir');
 await expect(captureBuildRoot({...args,configFile:join(linkedSource,'build.json'),projectRoot:'..',configurations:[{path:'../defaults.json'}]})).rejects.toThrow(/link/i);
 await expect(captureBuildRoot({...args,script:join(linkedSource,'asset.py')})).rejects.toThrow(/link/i);
 await symlink(join(root,'lib'),join(leaf,'output-link'),process.platform==='win32'?'junction':'dir');await expect(captureBuildRoot({...args,output:join(leaf,'output-link','new')})).rejects.toThrow(/link/i);
});
it('rejects hardlinked explicit-root config and entry files while keeping legacy behavior',async()=>{
 const {leaf,args}=await fixture();await link(args.script,join(leaf,'entry-alias.py'));
 await expect(captureBuildRoot(args)).rejects.toThrow(/hard.link/i);
 await expect(captureBuildInputs(args.configFile,args.script,[],args.output,dirname(dirname(leaf)))).rejects.toThrow(/hard.link/i);
 await expect(captureBuildInputs(args.configFile,args.script,[],args.output)).resolves.toBeDefined();
 await rm(join(leaf,'entry-alias.py'));await link(args.configFile,join(leaf,'config-alias.json'));await expect(captureBuildRoot(args)).rejects.toThrow(/hard.link/i);
});

it('keeps direct root-scoped input capture inside its boundary and refuses input traversal',async()=>{
 const {parent,root,args}=await fixture();await writeFile(join(parent,'outside.py'),'# outside');
 await expect(captureBuildInputs(args.configFile,join(parent,'outside.py'),[],args.output,root)).rejects.toThrow(/inside.*root/i);
 await expect(captureBuildInputs(args.configFile,args.script,[{path:'../outside.py'}],args.output,root)).rejects.toThrow(/unsafe/i);
 await expect(captureBuildInputs(args.configFile,args.script,[],join(parent,'output'),root)).rejects.toThrow(/inside.*root/i);
});
