import { expect, it } from 'vitest';
import { createCarverSession } from '../src/web/carver-session.ts';
import type { SolidResult } from '../src/render/carving.ts';

class FakeWorker {
  sent: unknown[]=[];terminated=false;onmessage:((e:MessageEvent)=>void)|null=null;onerror:((e:ErrorEvent)=>void)|null=null;onmessageerror:((e:MessageEvent)=>void)|null=null;
  postMessage(value:unknown){this.sent.push(value)} terminate(){this.terminated=true}
  reply(data:unknown){this.onmessage?.({data} as MessageEvent)}
}
const result={mesh:{positions:new Float32Array(),indices:new Uint32Array(),normals:new Float32Array()},removed:null,stats:{resolution:32,cached:true,samples:100,gridMs:0,totalMs:1}} satisfies SolidResult;
it('coalesces queued changes, settles superseded calls and delivers only the latest requested surface',async()=>{
  const worker=new FakeWorker(),session=createCarverSession(worker,{},[32]);
  const first=session.update({cutter:null,resolution:32}),second=session.update({cutter:null,resolution:32}),last=session.update({cutter:null,resolution:32});
  expect(await first).toBe(null);expect(await second).toBe(null);expect(worker.sent).toHaveLength(2);
  worker.reply({id:1,result});expect(worker.sent).toHaveLength(3);worker.reply({id:3,result});expect(await last).toBe(result);session.dispose();
});
it('keeps the active request on invalid input and recovers after a per-request worker error',async()=>{
  const worker=new FakeWorker(),session=createCarverSession(worker,{},[32]),first=session.update({cutter:null,resolution:32});
  await expect(session.update({cutter:null,resolution:31})).rejects.toThrow();worker.reply({id:1,result});expect(await first).toBe(result);
  const failed=session.update({cutter:null,resolution:32});worker.reply({id:2,error:'bad field'});await expect(failed).rejects.toThrow('bad field');
  const next=session.update({cutter:null,resolution:32});worker.reply({id:3,result});expect(await next).toBe(result);session.dispose();
});
it('settles pending calls and rejects future work after disposal or a fatal worker error',async()=>{
  const worker=new FakeWorker(),session=createCarverSession(worker,{},[32]),first=session.update({cutter:null,resolution:32}),last=session.update({cutter:null,resolution:32});
  session.dispose();expect(await first).toBe(null);expect(await last).toBe(null);expect(worker.terminated).toBe(true);await expect(session.update({cutter:null,resolution:32})).rejects.toThrow(/disposed/i);
  const other=new FakeWorker(),broken=createCarverSession(other,{},[32]),pending=broken.update({cutter:null,resolution:32});other.reply({id:0,error:'init failed'});await expect(pending).rejects.toThrow('init failed');await expect(broken.update({cutter:null,resolution:32})).rejects.toThrow('init failed');expect(other.terminated).toBe(true);
});
