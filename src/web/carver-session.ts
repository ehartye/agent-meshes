import { carveRequest } from '../render/carving.ts';
import type { CarveRequest, SolidResult } from '../render/carving.ts';

/** Narrow transport boundary, shared by the browser worker and deterministic protocol tests. */
export interface CarverTransport {
  postMessage(value: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface Pending { id:number; request:CarveRequest; resolve:(result:SolidResult|null)=>void; reject:(error:Error)=>void }
export function createCarverSession(worker:CarverTransport,init:unknown,resolutions:readonly number[]) {
  let running:Pending|null=null,queued:Pending|null=null,serial=0,dead:Error|null=null;
  const fail=(error:Error)=>{dead=error;running?.reject(error);queued?.reject(error);running=queued=null;worker.terminate();};
  const send=(job:Pending)=>{running=job;try{worker.postMessage({type:'carve',id:job.id,request:job.request})}catch(error){fail(error instanceof Error?error:new Error(String(error)))}};
  worker.onmessage=event=>{
    if(dead)return;const data=event.data;
    if(data.id===0&&data.error){fail(new Error(data.error));return}
    if(!running||data.id!==running.id){fail(new Error('Unexpected carving worker response'));return}
    if(queued)running.resolve(null);else if(data.error)running.reject(new Error(data.error));else running.resolve(data.result);
    running=null;if(queued){const next=queued;queued=null;send(next)}
  };
  worker.onerror=event=>fail(new Error(event.message||'Carving worker failed'));
  worker.onmessageerror=()=>fail(new Error('Carving worker returned unreadable data'));
  try{worker.postMessage({type:'init',options:init})}catch(error){fail(error instanceof Error?error:new Error(String(error)))}
  return{
    update(input:CarveRequest):Promise<SolidResult|null>{
      if(dead)return Promise.reject(dead);
      let request:CarveRequest;try{request=carveRequest(input,resolutions)}catch(error){return Promise.reject(error)}
      return new Promise((resolve,reject)=>{
        const job={id:++serial,request,resolve,reject};
        if(running){running.resolve(null);queued?.resolve(null);queued=job}else send(job);
      });
    },
    dispose(){if(dead)return;dead=new Error('Carver is disposed');running?.resolve(null);queued?.resolve(null);running=queued=null;worker.onmessage=worker.onerror=worker.onmessageerror=null;worker.terminate();},
  };
}
