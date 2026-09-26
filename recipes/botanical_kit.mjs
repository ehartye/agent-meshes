// Small deterministic botanical vocabulary. Returns ordinary agent-meshes operations.
// Stage and location remain explicit inputs; no random draw can change a harvest type.
export function foliageOperations({family='hardware-peanut',world='home',stage='mature',seed=7,scale=1}={}){
  if(!['hardware-peanut','soup-tomato','fern','lantern-reed','moss'].includes(family))throw new Error('Unknown foliage family');
  if(!['home','upside'].includes(world)||!['seedling','mature'].includes(stage))throw new Error('Unsupported world or stage');
  if(!Number.isSafeInteger(seed)||!Number.isFinite(scale)||scale<=0||scale>10)throw new Error('Invalid seed or scale');
  let state=seed>>>0;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
  const ops=[],s=scale*(stage==='seedling'?.38:1),leafColor=world==='upside'?'#749f9d':'#60886b';
  function add(name,type,size,position,color,extra={}){const{geometry={},...fields}=extra;ops.push({op:'add',part:{name,geometry:{type,size:size.map(v=>v*s),segments:20,...geometry},position:position.map(v=>v*s),color,material:{metalness:0,roughness:.72},...fields}});}
  const q=(axis,d)=>[...axis.map(v=>v*Math.sin(d*Math.PI/360)),Math.cos(d*Math.PI/360)];
  function rod(name,a,b,d,color){const v=b.map((v,i)=>v-a[i]),l=Math.hypot(...v),u=v.map(v=>v/l),r=u[1]<-.99999?[1,0,0,0]:[u[2],0,-u[0],1+u[1]],n=Math.hypot(...r);add(name,'cylinder',[d,l,d],a.map((v,i)=>(v+b[i])/2),color,{rotation:r.map(v=>v/n)});}
  function leaf(name,p,length,width,angle,color=leafColor){
    // Tapered closed leaf with a midrib, rather than a sphere or flat square.
    add(name,'lathe',[width,length,.035],p,color,{rotation:q([0,0,1],angle),geometry:{segments:12,profile:[[0,-.5],[.18,-.37],[.43,-.13],[.5,.06],[.34,.3],[0,.5]]}});
    const a=angle*Math.PI/180;rod(name+'-vein',[p[0]+Math.sin(a)*length*.38,p[1]-Math.cos(a)*length*.38,p[2]+.019],[p[0]-Math.sin(a)*length*.35,p[1]+Math.cos(a)*length*.35,p[2]+.019],.012,'#b3c68a');
  }
  if(family==='moss'){
    for(let i=0;i<22;i++){const a=random()*Math.PI*2,r=Math.sqrt(random())*.47;add('cushion-'+i,'sphere',[.21,.08+random()*.1,.2],[Math.cos(a)*r,.06,Math.sin(a)*r],i%3?'#73976d':'#a8b778');}
    return ops;
  }
  if(family==='fern'){
    for(let j=0;j<7;j++){
      const a=j*Math.PI*2/7+.2,dx=Math.cos(a),dz=Math.sin(a),height=.6+random()*.2;
      const points=[[0,0,0],[dx*.16,height*.58,dz*.16],[dx*.48,height*.84,dz*.48],[dx*.66,height*.74,dz*.66]];
      for(let k=0;k<3;k++)rod('frond-'+j+'-'+k,points[k],points[k+1],.018,'#4f8065');
      for(let k=0;k<5;k++){const t=(k+1)/6,x=dx*(.12+t*.48),z=dz*(.12+t*.48),y=height*(.53+.34*Math.sin(t*Math.PI*.7));for(const side of [-1,1])leaf(`pinna-${j}-${k}-${side}`,[x+side*.07,y,z],.24*(1-t*.55),.10,side*(55+k*5),j%2?'#487d6f':'#73a37a');}
    }return ops;
  }
  if(family==='lantern-reed'){
    for(let j=0;j<5;j++){
      const x=(j-2)*.15,z=(random()-.5)*.26,h=.9+random()*.65;
      rod('stalk-'+j,[x,0,z],[x+.08,h,z],.036,'#497a82');
      for(let k=0;k<3;k++)leaf(`reed-leaf-${j}-${k}`,[x+(k%2?-.14:.15),.25+k*.23,z],.45,.105,k%2?55:-55,'#83b9b0');
      add('lantern-husk-'+j,'lathe',[.23,.36,.23],[x+.08,h+.10,z],'#708fab',{geometry:{profile:[[0,-.5],[.38,-.35],[.5,-.05],[.34,.3],[0,.5]]}});
      add('lantern-core-'+j,'sphere',[.16,.2,.17],[x+.08,h+.10,z+.065],'#ccdfab');
    }return ops;
  }
  const tomato=family==='soup-tomato';
  const top=tomato?1.13:.66;
  rod('main-stem',[0,0,0],[.045,top,0],.037,'#4a775d');
  for(let i=0;i<5;i++){
    const side=i%2?-1:1,y=.18+i*(tomato?.155:.075),spread=.15+random()*.11,z=(random()-.5)*.15;
    rod('branch-'+i,[.02,y-.06,0],[side*spread,y+.065,z],.021,'#4a775d');
    leaf('leaf-'+i,[side*(spread+.04),y+.1,z],tomato?.35:.29,tomato?.17:.20,side*-50);
    leaf('leaf-back-'+i,[side*spread*.6,y+.02,z-.1],.23,.15,side*52,'#a0b674');
  }
  if(stage==='mature')for(let i=0;i<3;i++){
    const x=(i-1)*.23,y=tomato?.60+i*.15:(world==='upside'?1.02+i*.085:.10),z=.15+(i%2)*.06;
    if(tomato){
      rod('fruit-stem-'+i,[.025,y+.18,0],[x,y+.09,z],.015,leafColor);
      add('fruit-'+i,'sphere',[.30,.27,.29],[x,y,z],world==='upside'?'#eccba9':'#d9664e');
      for(let l=0;l<5;l++)leaf(`calyx-${i}-${l}`,[x+(l-2)*.018,y+.14,z],.105,.048,(l-2)*45,'#4f8065');
      if(world==='upside')rod('fruit-tether-'+i,[x,.03,z],[x,y-.13,z],.009,'#d7caae');
    }else{
      add('pod-'+i,'lathe',[.22,.43,.21],[x,y+.12,z],'#c69e60',{geometry:{profile:[[0,-.5],[.4,-.4],[.5,-.22],[.30,0],[.49,.22],[.35,.41],[0,.5]]}});
      if(world==='upside'){
        for(const side of [-1,1])leaf(`fin-${i}-${side}`,[x+side*.16,y+.13,z],.25,.14,side*-65,'#96ccc0');
        rod('pod-tether-'+i,[x,.02,z],[x,y-.08,z],.009,'#d7caae');
      }
    }
  }
  return ops;
}
