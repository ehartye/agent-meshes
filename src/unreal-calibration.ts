/** A diagnostic fixture, not game content. Positions are baked into each named mesh so
 * asset-local bounds retain marker locations after import. glTF metres/Y-up/RH map
 * to UE centimetres/Z-up/LH as (x,z,y)*100 (UE5.8 GLTF ConversionUtilities.h). */
export const UNREAL_AXIS_CALIBRATION = [
  {name:'CalibrationOrigin',gltfCenter:[0,0,0],unrealCenterCm:[0,0,0]},
  {name:'GltfPositiveX',gltfCenter:[1,0,0],unrealCenterCm:[100,0,0]},
  {name:'GltfPositiveY',gltfCenter:[0,2,0],unrealCenterCm:[0,0,200]},
  {name:'GltfPositiveZ',gltfCenter:[0,0,3],unrealCenterCm:[0,300,0]},
].map(m=>({...m,unrealCenterCm:m.unrealCenterCm as [number,number,number],unrealSizeCm:[14,22,18] as [number,number,number]}));

export function createUnrealAxisCalibrationGLB(): Uint8Array {
  const buffers:Buffer[]=[],views:unknown[]=[],accessors:unknown[]=[],meshes:unknown[]=[],nodes:unknown[]=[];
  let offset=0;
  function attribute(values:number[],type:string,min?:number[],max?:number[]) {
    const data=Buffer.alloc(values.length*4); values.forEach((v,i)=>data.writeFloatLE(v,i*4));
    const view=views.length; views.push({buffer:0,byteOffset:offset,byteLength:data.length,target:34962}); buffers.push(data);offset+=data.length;
    const index=accessors.length; accessors.push({bufferView:view,componentType:5126,count:values.length/3,type,...(min?{min,max}:{})});return index;
  }
  const faces=[[[1,0,0],[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]],[[-1,0,0],[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]],[[0,1,0],[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]],[[0,-1,0],[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]],[[0,0,1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],[[0,0,-1],[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]];
  const half=[.07,.09,.11];
  for(const marker of UNREAL_AXIS_CALIBRATION) {
    const positions:number[]=[],normals:number[]=[];
    for(const face of faces) for(const i of [1,2,3,1,3,4]) { positions.push(...face[i].map((v,a)=>marker.gltfCenter[a]+v*half[a]));normals.push(...face[0]); }
    const pos=attribute(positions,'VEC3',marker.gltfCenter.map((v,a)=>v-half[a]),marker.gltfCenter.map((v,a)=>v+half[a]));
    const normal=attribute(normals,'VEC3');
    meshes.push({name:marker.name,primitives:[{attributes:{POSITION:pos,NORMAL:normal},material:0}]}); nodes.push({name:marker.name,mesh:meshes.length-1});
  }
  const bin=Buffer.concat(buffers),json={asset:{version:'2.0',generator:'agent-meshes axis calibration'},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials:[{name:'Calibration',pbrMetallicRoughness:{baseColorFactor:[.8,.2,.1,1],metallicFactor:0,roughnessFactor:1}}],buffers:[{byteLength:bin.length}],bufferViews:views,accessors};
  const raw=Buffer.from(JSON.stringify(json)),text=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(text);
  const out=Buffer.alloc(12+8+text.length+8+bin.length);out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(text.length,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);const start=20+text.length;out.writeUInt32LE(bin.length,start);out.writeUInt32LE(0x004e4942,start+4);bin.copy(out,start+8);return new Uint8Array(out);
}
