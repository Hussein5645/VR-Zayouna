import * as THREE from './assets/three.module.js';

// ---------------------------------------------------------------------------
// Tour content lives in tour.json (spaces, images, label positions, logo).
// ---------------------------------------------------------------------------
const status=document.querySelector('#status'),place=document.querySelector('#place'),vr=document.querySelector('#vr'),editBox=document.querySelector('#edit');
let tour;
try{tour=await (await fetch('./tour.json',{cache:'no-store'})).json()}
catch(e){status.textContent='Could not read tour.json: '+e.message;throw e}
const spaces=tour.spaces,indexOf=new Map(spaces.map((s,i)=>[s.id,i]));
const params=new URLSearchParams(location.search),editMode=params.has('edit');
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI;
const heading=i=>rad(spaces[i].heading||0);
const links=i=>(spaces[i].labels||[]).map(l=>indexOf.get(l.to)).filter(j=>j!==undefined);
document.title=tour.title||document.title;
for(const s of spaces)for(const l of s.labels||[])if(l.to!==undefined&&!indexOf.has(l.to))console.warn(`tour.json: space "${s.id}" has a label pointing to unknown space "${l.to}"`);

const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.xr.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.prepend(renderer.domElement);
const world=new THREE.Scene(),camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,.05,100);camera.position.set(0,0,0);
const material=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.BackSide});const sphere=new THREE.Mesh(new THREE.SphereGeometry(40,64,40),material);world.add(sphere);
// Labels sit in a group that turns with the panorama, so their yaw is relative to the image.
const group=new THREE.Group();world.add(group);
// Lights only affect the 3D labels; the panorama uses an unlit material.
world.add(new THREE.HemisphereLight(0xffffff,0x0b1012,1.4));const eyeLight=new THREE.PointLight(0xffffff,.9,0,0);world.add(eyeLight);
let current=-1,busy=false,yaw=0,pitch=0,drag=false,moved=false,last={x:0,y:0},hover=null,pending=null,transition=null,waitingFor=-1;

// ---------------------------------------------------------------------------
// Panorama loading: .jpg/.png through the browser, .hdr through a worker.
// ---------------------------------------------------------------------------
const loader=new THREE.TextureLoader(),cache=new Map();let hdrQueue=Promise.resolve();
function progress(i,text){if(waitingFor!==i)return;status.hidden=false;status.textContent=`Loading ${spaces[i].name}… ${text}`}
function prepare(t){t.colorSpace=THREE.SRGBColorSpace;t.generateMipmaps=false;t.minFilter=t.magFilter=THREE.LinearFilter;return t}
function loadHDR(i){
 // One decode at a time keeps memory reasonable on Quest.
 const job=hdrQueue.then(()=>new Promise((resolve,reject)=>{
  const worker=new Worker('./hdr-worker.js');
  worker.onmessage=({data:m})=>{
   if(m.type==='progress')return progress(i,m.phase==='downloading'?m.pct+'%':'decoding');
   worker.terminate();
   if(m.type==='error')return reject(new Error(m.message));
   const t=prepare(new THREE.DataTexture(m.data,m.width,m.height,THREE.RGBAFormat,THREE.UnsignedByteType));
   t.needsUpdate=true;t.onUpdate=()=>{t.image.data=null};// free the CPU copy once it is on the GPU
   resolve(t);
  };
  worker.onerror=e=>{worker.terminate();reject(new Error(e.message||'HDR worker failed'))};
  worker.postMessage({url:new URL(spaces[i].image,location.href).href,maxWidth:Math.min(tour.hdrMaxWidth||8192,renderer.capabilities.maxTextureSize),exposure:spaces[i].exposure??1});
 }));
 hdrQueue=job.catch(()=>{});
 return job;
}
function texture(i){
 if(!cache.has(i)){const src=spaces[i].image;cache.set(i,(/\.hdr$/i.test(src)?loadHDR(i):loader.loadAsync(src).then(prepare)).catch(e=>{cache.delete(i);throw e}))}
 return cache.get(i);
}
// Keep only the current space and the spaces it links to in memory.
function keepNearby(i){
 const keep=new Set([i,...links(i)]);
 for(const [j,p] of cache)if(!keep.has(j)){cache.delete(j);p.then(t=>t.dispose(),()=>{})}
 for(const j of keep)if(j!==i)texture(j).then(t=>renderer.initTexture(t)).catch(()=>{});
}

// ---------------------------------------------------------------------------
// 3D labels: a bevelled pill slab with a lit edge, a soft shadow behind it,
// and a stem with a glowing pin. Each one floats at its own distance.
// ---------------------------------------------------------------------------
function pillShape(w,h){const r=h/2,s=new THREE.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.absarc(w/2-r,0,r,-Math.PI/2,Math.PI/2);s.lineTo(-w/2+r,h/2);s.absarc(-w/2+r,0,r,Math.PI/2,Math.PI*1.5);return s}
function glowTexture(inner,outer){const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,inner);g.addColorStop(1,outer);ctx.fillStyle=g;ctx.fillRect(0,0,128,128);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.userData.shared=true;return t}
const shadowMap=glowTexture('rgba(0,0,0,.85)','rgba(0,0,0,0)'),haloMap=glowTexture('rgba(255,255,255,.9)','rgba(255,255,255,0)');
const SLAB_DEPTH=.04,BEVEL=.02,FRONT=SLAB_DEPTH+BEVEL+.002;

function labelFace(text,icon){
 const c=document.createElement('canvas'),ctx=c.getContext('2d'),font='600 64px system-ui,"Segoe UI",sans-serif';
 ctx.font=font;const left=icon?152:72;c.width=Math.ceil(left+ctx.measureText(text).width+72);c.height=160;
 if(icon){ctx.fillStyle='rgba(255,255,255,.95)';ctx.beginPath();ctx.arc(80,80,44,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#1d2a2e';ctx.lineWidth=9;ctx.lineCap=ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(62,80);ctx.lineTo(98,80);ctx.moveTo(84,64);ctx.lineTo(100,80);ctx.lineTo(84,96);ctx.stroke()}
 ctx.font=font;ctx.fillStyle='white';ctx.textBaseline='middle';ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=6;ctx.shadowOffsetY=2;ctx.fillText(text,left,84);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return {map:t,aspect:c.width/c.height};
}
function makeLabel(spec){
 const target=indexOf.get(spec.to),clickable=target!==undefined;
 const text=spec.text??(clickable?spaces[target].name:'');
 const distance=spec.distance??4,h=.34*Math.pow(distance/4,.6)*(spec.scale??1);// far labels shrink, but stay readable
 const face=labelFace(text,clickable),w=h*face.aspect;
 const root=new THREE.Group(),float=new THREE.Group();root.add(float);
 const add=(geometry,mat,x,y,z)=>{const m=new THREE.Mesh(geometry,mat);m.position.set(x,y,z);m.renderOrder=2;mat.userData.opacity=mat.opacity;float.add(m);return m};
 add(new THREE.PlaneGeometry(w*1.5,h*2.6),new THREE.MeshBasicMaterial({map:shadowMap,transparent:true,opacity:.55,depthWrite:false}),0,-h*.12,-.18);
 add(new THREE.ExtrudeGeometry(pillShape(w,h),{depth:SLAB_DEPTH,bevelEnabled:true,bevelThickness:BEVEL,bevelSize:.016,bevelSegments:5,curveSegments:24}),new THREE.MeshStandardMaterial({color:0x1d2a2e,roughness:.4,metalness:.2,transparent:true,opacity:.93}),0,0,0);
 add(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:face.map,transparent:true,depthWrite:false}),0,0,FRONT);
 const stem=h*1.3;
 add(new THREE.CylinderGeometry(.005,.005,stem,8),new THREE.MeshStandardMaterial({color:0xffffff,emissive:0x667077,transparent:true,opacity:.8}),0,-h/2-stem/2,SLAB_DEPTH/2);
 add(new THREE.SphereGeometry(.03,20,14),new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xbfc8cc,transparent:true}),0,-h/2-stem,SLAB_DEPTH/2);
 const halo=add(new THREE.PlaneGeometry(.2,.2),new THREE.MeshBasicMaterial({map:haloMap,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending}),0,-h/2-stem,SLAB_DEPTH/2+.01);
 const p=rad(spec.pitch??-6),y=rad(spec.yaw??0);
 root.position.set(Math.sin(y)*Math.cos(p)*distance,Math.sin(p)*distance,-Math.cos(y)*Math.cos(p)*distance);
 root.userData={target:clickable?target:undefined,float,halo,phase:Math.random()*6.28,lift:0};
 return root;
}
function clearLabels(){for(const root of [...group.children]){group.remove(root);root.traverse(m=>{if(!m.isMesh)return;m.geometry.dispose();if(m.material.map&&!m.material.map.userData.shared)m.material.map.dispose();m.material.dispose()})}}
function buildLabels(){
 clearLabels();group.rotation.y=heading(current);group.updateMatrixWorld();
 for(const spec of spaces[current].labels||[]){if(spec.to!==undefined&&!indexOf.has(spec.to))continue;const root=makeLabel(spec);group.add(root);root.lookAt(0,0,0)}
}
function labelOpacity(k){group.traverse(m=>{if(m.isMesh)m.material.opacity=m.material.userData.opacity*k})}
function animateLabels(t,dt){
 for(const root of group.children){
  const u=root.userData,target=root===hover?1:0;u.lift+=(target-u.lift)*Math.min(dt*10,1);
  // Hovered labels come toward you; all labels drift gently so they read as objects in space.
  u.float.position.set(0,Math.sin(t*1.3+u.phase)*.025,u.lift*.25);
  let s=1+u.lift*.08;if(root===pending)s*=1+Math.sin(t*8)*.04;
  u.float.scale.setScalar(s);u.halo.scale.setScalar(1+Math.sin(t*2.4+u.phase)*.25);
 }
}

// ---------------------------------------------------------------------------
// Logo: tour.logo.style "white" turns a dark logo into white for dark scenes;
// "original" uses the file as is.
// ---------------------------------------------------------------------------
const brand=new THREE.Group();brand.visible=false;world.add(brand);
async function loadLogo(){
 const logo=tour.logo;if(!logo?.image)return;
 const img=new Image();img.src=logo.image;await img.decode();
 const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
 if(logo.style!=='original'){const d=ctx.getImageData(0,0,c.width,c.height),p=d.data;for(let i=0;i<p.length;i+=4){const a=p[i+3]/255*(1-(p[i]+p[i+1]+p[i+2])/765);p[i]=p[i+1]=p[i+2]=255;p[i+3]=a*255}ctx.putImageData(d,0,0)}
 const html=document.querySelector('#logo');html.src=c.toDataURL();html.hidden=!!session;
 // In VR the logo rests on a small dark slab below eye level.
 const map=new THREE.CanvasTexture(c);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;
 const w=.7,h=w*c.height/c.width,padX=.1,padY=.07;
 const slab=new THREE.Mesh(new THREE.ExtrudeGeometry(pillShape(w+padX*2,h+padY*2),{depth:.02,bevelEnabled:true,bevelThickness:.012,bevelSize:.01,bevelSegments:4,curveSegments:24}),new THREE.MeshStandardMaterial({color:0x1d2a2e,roughness:.45,metalness:.2,transparent:true,opacity:.85}));
 const face=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false}));face.position.z=.034;
 brand.add(slab,face);brand.position.set(0,-1.45,-2.6);brand.lookAt(0,0,0);
}

// ---------------------------------------------------------------------------
// Directional panorama reprojection gives a Street View-style forward step.
// ---------------------------------------------------------------------------
const incomingMaterial=new THREE.ShaderMaterial({
 side:THREE.BackSide,depthTest:false,depthWrite:false,precision:'highp',
 uniforms:{fromImage:{value:null},toImage:{value:null},fromHeading:{value:0},toHeading:{value:0},progress:{value:0},travelStrength:{value:.22},travelDirection:{value:new THREE.Vector3(0,0,-1)}},
 vertexShader:`varying vec3 panoDirection;void main(){panoDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
 fragmentShader:`
 uniform sampler2D fromImage;uniform sampler2D toImage;uniform float fromHeading;uniform float toHeading;
 uniform float progress;uniform float travelStrength;uniform vec3 travelDirection;
 varying vec3 panoDirection;
 vec2 panoramaUV(vec3 ray,float heading){
   ray=normalize(ray);
   float c=cos(heading),s=sin(heading);
   ray=vec3(c*ray.x-s*ray.z,ray.y,s*ray.x+c*ray.z);
   return vec2(fract(atan(ray.z,-ray.x)/6.28318530718+1.0),acos(clamp(-ray.y,-1.0,1.0))/3.14159265359);
 }
 void main(){
   vec3 ray=normalize(panoDirection);
   float move=progress*progress*(3.0-2.0*progress);
   // The old view advances; the arriving view settles at its capture point.
   vec2 fromUV=panoramaUV(ray+travelDirection*travelStrength*move,fromHeading);
   vec2 toUV=panoramaUV(ray-travelDirection*travelStrength*.35*(1.0-move),toHeading);
   float blend=smoothstep(.15,.90,progress);
   gl_FragColor=mix(texture2D(fromImage,fromUV),texture2D(toImage,toUV),blend);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
 }`
});
const incoming=new THREE.Mesh(sphere.geometry,incomingMaterial);incoming.renderOrder=1;incoming.visible=false;world.add(incoming);
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const ease=t=>t*t*t*(t*(t*6-15)+10);
function blendTo(t,direction,target){return new Promise(resolve=>{const u=incomingMaterial.uniforms;u.fromImage.value=material.map;u.toImage.value=t;u.fromHeading.value=heading(current);u.toHeading.value=heading(target);u.progress.value=0;u.travelStrength.value=reducedMotion.matches?0:renderer.xr.isPresenting?.10:.22;u.travelDirection.value.copy(direction);sphere.visible=false;incoming.visible=true;transition={elapsed:0,duration:reducedMotion.matches?.25:.72,resolve,target}})}
function show(i){current=i;buildLabels();place.textContent=spaces[i].name}
function updateTransition(dt){
 if(!transition)return;
 transition.elapsed+=dt;
 const progress=Math.min(transition.elapsed/transition.duration,1),blend=ease(progress);
 incomingMaterial.uniforms.progress.value=blend;
 // Let destinations disappear, then gently reveal the new destinations.
 const markerOpacity=progress<.5?1-ease(progress*2):ease((progress-.5)*2);
 if(progress>=.5&&!transition.swapped){show(transition.target);transition.swapped=true}
 labelOpacity(markerOpacity);
 if(progress===1){material.map=incomingMaterial.uniforms.toImage.value;material.needsUpdate=true;sphere.rotation.y=heading(current);sphere.visible=true;incoming.visible=false;incomingMaterial.uniforms.fromImage.value=null;incomingMaterial.uniforms.toImage.value=null;incomingMaterial.uniforms.progress.value=0;const done=transition.resolve;transition=null;done()}
}
async function go(i,direction=new THREE.Vector3(0,0,-1),from=null){
 if(busy||i===current&&material.map)return;
 busy=true;pending=from;waitingFor=i;
 try{
  const t=await texture(i);
  renderer.initTexture(t);
  status.hidden=true;
  if(material.map)await blendTo(t,direction,i);
  else{material.map=t;material.needsUpdate=true;sphere.rotation.y=heading(i);show(i)}
  keepNearby(i);
 }catch(e){console.error(e);status.hidden=false;status.replaceChildren(document.createTextNode(`${spaces[i].name} could not load. `));const b=document.createElement('button');b.textContent='Retry';b.onclick=()=>go(i,direction);status.append(b)}
 finally{busy=false;pending=null;waitingFor=-1}
}

// ---------------------------------------------------------------------------
// Input: mouse/touch drag on desktop, controller rays in VR.
// ---------------------------------------------------------------------------
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),tmp=new THREE.Vector3();
function hit(){let o=ray.intersectObjects(group.children,true)[0]?.object;while(o&&o.parent!==group)o=o.parent;return o?.userData.target!==undefined?o:null}
function activate(){const m=hit();if(m){m.getWorldPosition(tmp);go(m.userData.target,new THREE.Vector3(tmp.x,0,tmp.z).normalize(),m)}else if(editMode)copySpot()}
renderer.domElement.addEventListener('pointerdown',e=>{drag=true;moved=false;last={x:e.clientX,y:e.clientY};renderer.domElement.setPointerCapture(e.pointerId)});renderer.domElement.addEventListener('pointermove',e=>{pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);if(drag){const dx=e.clientX-last.x,dy=e.clientY-last.y;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;yaw-=dx*.004;pitch=Math.max(-1.45,Math.min(1.45,pitch+dy*.004));last={x:e.clientX,y:e.clientY}}});renderer.domElement.addEventListener('pointerup',e=>{drag=false;if(!moved){pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);ray.setFromCamera(pointer,camera);activate()}});renderer.domElement.addEventListener('pointercancel',()=>drag=false);
const controllers=[];for(let i=0;i<2;i++){const c=renderer.xr.getController(i);world.add(c);const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-5)]),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.5}));c.add(line);c.addEventListener('select',()=>{ray.setFromXRController(c);activate()});controllers.push(c)}

// ---------------------------------------------------------------------------
// Edit mode (open with ?edit): shows yaw/pitch under the cursor for the
// current space; click empty space to copy a ready-made label line.
// ---------------------------------------------------------------------------
function spotUnderPointer(){const d=ray.ray.direction;let y=deg(Math.atan2(d.x,-d.z)+heading(current));y=((y+540)%360)-180;return {yaw:Math.round(y),pitch:Math.round(deg(Math.asin(d.y)))}}
function showSpot(){if(!editMode||current<0)return;const s=spotUnderPointer();editBox.textContent=`Editing "${spaces[current].id}"   yaw ${s.yaw}   pitch ${s.pitch}   · click to copy`}
function copySpot(){const s=spotUnderPointer(),line=`{ "to": "", "yaw": ${s.yaw}, "pitch": ${s.pitch}, "distance": 4 },`;navigator.clipboard?.writeText(line).catch(()=>{});editBox.textContent='Copied: '+line;console.log(`[${spaces[current].id}]`,line)}
editBox.hidden=!editMode;

let session=null;async function checkVR(){try{if(navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr')){vr.disabled=false;vr.textContent='Enter VR'}else{vr.textContent='VR: open on Quest';vr.disabled=true}}catch{vr.textContent='VR unavailable'}}vr.onclick=async()=>{try{if(session){await session.end();return}session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor']});renderer.xr.setReferenceSpaceType('local');await renderer.xr.setSession(session);document.querySelector('#top').hidden=true;document.querySelector('#logo').hidden=true;document.querySelector('#hint').hidden=true;session.addEventListener('end',()=>{session=null;document.querySelector('#top').hidden=false;document.querySelector('#logo').hidden=false;vr.textContent='Enter VR'})}catch(e){session=null;status.hidden=false;status.textContent='VR could not start. Try Enter VR again.'}};
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
let time=performance.now(),clock=0;
renderer.setAnimationLoop(()=>{
 const now=performance.now(),dt=Math.min((now-time)/1000,.1);time=now;clock+=dt;
 if(!renderer.xr.isPresenting){camera.rotation.set(-pitch,yaw,0,'YXZ');ray.setFromCamera(pointer,camera);hover=hit();if(!drag)showSpot();renderer.domElement.style.cursor=hover?'pointer':drag?'grabbing':editMode?'crosshair':'grab'}
 else{hover=null;for(const c of controllers){ray.setFromXRController(c);const h=hit();if(h)hover=h}}
 animateLabels(clock,dt);brand.visible=renderer.xr.isPresenting;
 const view=renderer.xr.isPresenting?renderer.xr.getCamera():camera;sphere.position.copy(view.position);incoming.position.copy(view.position);eyeLight.position.copy(view.position);
 updateTransition(dt);renderer.render(world,camera);
});
checkVR();loadLogo().catch(e=>console.warn('Logo could not load',e));
go(indexOf.get(params.get('space'))??indexOf.get(tour.start)??0);
setTimeout(()=>document.querySelector('#hint').style.opacity='0',6500);
