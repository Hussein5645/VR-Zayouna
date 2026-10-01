import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tour content lives in tour.json (spaces, images, label positions, logo).
// ---------------------------------------------------------------------------
// Quest Browser grants a VR session when arriving from another VR page; remember it so we can enter without a click.
let granted=false;navigator.xr?.addEventListener('sessiongranted',()=>{granted=true;window.enterVR?.()});
const status=document.querySelector('#status'),place=document.querySelector('#place'),vr=document.querySelector('#vr'),editBox=document.querySelector('#edit');
let tour;
try{tour=await (await fetch('./tour.json',{cache:'no-store'})).json()}
catch(e){status.hidden=false;status.textContent='Could not read tour.json: '+e.message;throw e}
const spaces=tour.spaces,indexOf=new Map(spaces.map((s,i)=>[s.id,i]));
const params=new URLSearchParams(location.search),editMode=params.has('edit');
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI;
const heading=i=>rad(spaces[i].heading||0);
document.title=tour.title||document.title;
for(const s of spaces)for(const l of s.labels||[])if(l.to!==undefined&&!indexOf.has(l.to))console.warn(`tour.json: space "${s.id}" has a label pointing to unknown space "${l.to}"`);

const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.xr.enabled=true;renderer.xr.setFramebufferScaleFactor(1.4);/* render VR a bit above the default resolution so panoramas look sharp */renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.prepend(renderer.domElement);
const world=new THREE.Scene(),camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,.05,100);camera.position.set(0,0,0);world.background=new THREE.Color(0x0d1113);
// Human scale: y=0 is the real floor. Each panorama is wrapped on a "grounded" sphere centred at the
// space's cameraHeight, whose bottom is flattened into a floor and whose walls sit roomSize metres away.
// It stays fixed in the room (it no longer follows your head), so leaning gives real parallax on the floor.
// The room is a box-like shape: a flat floor at your feet, a flat ceiling at ceilingHeight and walls at roomSize.
// tour.roomScale shrinks or grows every room at once (walls and ceilings; the floor always stays at your feet).
const eyeHeight=i=>spaces[i]?.cameraHeight??1.6;
const ceilingAbove=i=>Math.max((spaces[i]?.ceilingHeight??2.8)*(tour.roomScale??1)-eyeHeight(i),.5);// metres from eye to ceiling
const roomSize=i=>Math.max((spaces[i]?.roomSize??5)*(tour.roomScale??1),eyeHeight(i)*1.6,ceilingAbove(i)*1.6);
const shapes=new Map();
// Presses the part of the sphere beyond `limit` (below the floor or above the ceiling) flat onto that plane, with a smooth bend.
const flatten=(y,limit)=>{const y1=limit*1.5;return Math.abs(y)>Math.abs(y1)?limit/y:1-y*y/(3*y1*y1)};
function groundedGeometry(h,R,c){
 const key=h+'/'+R+'/'+c;
 if(!shapes.has(key)){
  // Mirrored so the image reads correctly from inside (faces point inward), and turned so the image centre is straight ahead (yaw 0).
  const g=new THREE.SphereGeometry(R,128,96).scale(-1,1,1).rotateY(-Math.PI/2),pos=g.attributes.position,v=new THREE.Vector3();
  // Same projection as three.js GroundedSkybox for the floor, mirrored for the ceiling.
  for(let i=0;i<pos.count;i++){v.fromBufferAttribute(pos,i);if(v.y!==0){v.multiplyScalar(v.y<0?flatten(v.y,-h):flatten(v.y,c));pos.setXYZ(i,v.x,v.y,v.z)}}
  shapes.set(key,g);
 }
 return shapes.get(key);
}
function placeSpace(mesh,i){mesh.geometry=groundedGeometry(eyeHeight(i),roomSize(i),ceilingAbove(i));mesh.position.y=eyeHeight(i)}
// stage holds everything that belongs to the room; it only moves if the headset has no floor-level tracking.
const stage=new THREE.Group();world.add(stage);
// The panorama stays hidden until the first space is ready, so VR shows the dark loading room.
const material=new THREE.MeshBasicMaterial({color:0xffffff,depthWrite:false});const sphere=new THREE.Mesh(groundedGeometry(1.6,5,1.2),material);sphere.visible=false;stage.add(sphere);
// rig sits at the capture point (eye height). Labels, the VR logo and the VR loading screen live in it.
const rig=new THREE.Group();rig.position.y=1.6;stage.add(rig);
// Labels sit in a group that turns with the panorama, so their yaw is relative to the image.
const group=new THREE.Group();rig.add(group);
let floorLevel=true;
// Lights only affect the 3D labels; the panorama uses an unlit material.
world.add(new THREE.HemisphereLight(0xffffff,0x0b1012,1.4));const eyeLight=new THREE.PointLight(0xffffff,.9,0,0);world.add(eyeLight);
let current=-1,busy=false,yaw=0,pitch=0,drag=false,moved=false,last={x:0,y:0},hover=null,transition=null,waitingFor=-1;

// ---------------------------------------------------------------------------
// Panorama loading: .jpg/.png through the browser, .hdr through a worker.
// ---------------------------------------------------------------------------
const loader=new THREE.TextureLoader(),cache=new Map(),fraction=new Array(spaces.length).fill(0);let hdrQueue=Promise.resolve();
// fraction[i] goes 0 -> 1 per space (download ~85%, decode ~15%) and drives the loading bar.
function progress(i,f,text){fraction[i]=Math.max(fraction[i],f);updateLoader();if(waitingFor!==i)return;status.hidden=false;status.textContent=`Loading ${spaces[i].name}… ${text}`}
// Mipmaps + anisotropic filtering: an 8K panorama is always shown smaller than its pixels, so without
// them it looks grainy and shimmers (marble, chandeliers, text) — especially on the headset.
function prepare(t){t.colorSpace=THREE.SRGBColorSpace;t.generateMipmaps=true;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.anisotropy=renderer.capabilities.getMaxAnisotropy();return t}
function loadHDR(i){
 // One decode at a time keeps memory reasonable on Quest.
 const job=hdrQueue.then(()=>new Promise((resolve,reject)=>{
  const worker=new Worker('./hdr-worker.js');
  worker.onmessage=({data:m})=>{
   if(m.type==='progress')return m.phase==='decoding'?progress(i,.85,'decoding'):progress(i,m.pct<0?0:m.pct/100*.85,m.pct<0?Math.round(m.loaded/1048576)+' MB':m.pct+'%');
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
// On first load every space is downloaded, decoded and uploaded to the GPU,
// so moving between spaces afterwards is instant.
const loaderBox=document.querySelector('#loader'),loaderBar=document.querySelector('#loader-bar'),loaderText=document.querySelector('#loader-text');let ready=0,loading=true;
// The same loading screen in VR: logo, thin bar and counter floating in front of you.
const vrLoader=new THREE.Group();vrLoader.position.set(0,0,-2.4);vrLoader.visible=false;rig.add(vrLoader);
const vrTrack=new THREE.Mesh(new THREE.PlaneGeometry(1,.008),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.15,depthWrite:false}));
const vrFill=new THREE.Mesh(new THREE.PlaneGeometry(1,.008).translate(.5,0,0),new THREE.MeshBasicMaterial({color:0xcfd5d8}));vrFill.position.set(-.5,0,.001);vrFill.scale.x=.0001;
// A soft glint that sweeps along the filled part of the bar (it is a child of the fill, so it stays inside it).
const vrShine=new THREE.Mesh(new THREE.PlaneGeometry(.3,.03),new THREE.MeshBasicMaterial({map:glowTexture('rgba(255,255,255,1)','rgba(255,255,255,0)'),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));vrShine.position.z=.001;vrFill.add(vrShine);
const vrTextCanvas=document.createElement('canvas');vrTextCanvas.width=1024;vrTextCanvas.height=64;const vrTextMap=new THREE.CanvasTexture(vrTextCanvas);vrTextMap.colorSpace=THREE.SRGBColorSpace;
const vrText=new THREE.Mesh(new THREE.PlaneGeometry(1,.0625),new THREE.MeshBasicMaterial({map:vrTextMap,transparent:true,depthWrite:false}));vrText.position.y=-.08;
vrLoader.add(vrTrack,vrFill,vrText);
function updateLoader(){
 const p=fraction.reduce((a,b)=>a+b,0)/spaces.length,text=`Loading spaces ${ready} / ${spaces.length}  ·  ${Math.round(p*100)}%`;
 loaderBar.style.width=p*100+'%';vrFill.scale.x=Math.max(p,.0001);
 if(loaderText.textContent===text)return;
 loaderText.textContent=text;
 const ctx=vrTextCanvas.getContext('2d');ctx.clearRect(0,0,1024,64);ctx.font='500 28px "Segoe UI",system-ui,sans-serif';ctx.letterSpacing='5px';ctx.fillStyle='rgba(255,255,255,.6)';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text.toUpperCase(),512,34);vrTextMap.needsUpdate=true;
}
async function preloadAll(first){
 updateLoader();
 const order=[first,...spaces.keys()].filter((i,k,a)=>a.indexOf(i)===k);
 const results=await Promise.allSettled(order.map(i=>texture(i).then(t=>{renderer.initTexture(t);fraction[i]=1;ready++;updateLoader()})));
 results.forEach((r,k)=>{if(r.status==='rejected')console.warn(`Could not preload "${spaces[order[k]].id}"`,r.reason)});
 loading=false;loaderBox.classList.add('done');setTimeout(()=>loaderBox.hidden=true,600);
}

// ---------------------------------------------------------------------------
// 3D labels: a thin dark glass slab with a soft shadow behind it, placed at
// its own distance for depth. Labels stay still; pointing at one lights its edge.
// ---------------------------------------------------------------------------
function pillShape(w,h){const r=h/2,s=new THREE.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.absarc(w/2-r,0,r,-Math.PI/2,Math.PI/2);s.lineTo(-w/2+r,h/2);s.absarc(-w/2+r,0,r,Math.PI/2,Math.PI*1.5);return s}
function glowTexture(inner,outer){const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,inner);g.addColorStop(1,outer);ctx.fillStyle=g;ctx.fillRect(0,0,128,128);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.userData.shared=true;return t}
const shadowMap=glowTexture('rgba(0,0,0,.8)','rgba(0,0,0,0)');
const SLAB_DEPTH=.01,BEVEL=.005,FRONT=SLAB_DEPTH+BEVEL+.002,EDGE=.007;
let labelFade=1;

function labelFace(text,icon){
 const c=document.createElement('canvas'),ctx=c.getContext('2d'),font='500 50px "Segoe UI",system-ui,sans-serif';
 const setFont=()=>{ctx.font=font;ctx.letterSpacing='6px'};
 setFont();const left=icon?132:76;c.width=Math.ceil(left+ctx.measureText(text).width+70);c.height=160;setFont();
 if(icon){ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=4;ctx.beginPath();ctx.arc(80,80,20,0,Math.PI*2);ctx.stroke();ctx.fillStyle='white';ctx.beginPath();ctx.arc(80,80,7,0,Math.PI*2);ctx.fill()}
 ctx.fillStyle='white';ctx.textBaseline='middle';ctx.fillText(text,left,83);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return {map:t,aspect:c.width/c.height};
}
function makeLabel(spec){
 const target=indexOf.get(spec.to),clickable=target!==undefined;
 const text=(spec.text??(clickable?spaces[target].name:'')).toUpperCase();
 const p=rad(spec.pitch??-6),y=rad(spec.yaw??0),R=roomSize(current);
 // Keep the label inside the room: in front of the walls and above the floor, so its depth matches the image behind it.
 const surface=p<0?Math.min(R,eyeHeight(current)/Math.sin(-p)):p>0?Math.min(R,ceilingAbove(current)/Math.sin(p)):R;
 const distance=Math.min(spec.distance??R*.6,surface*.9),h=.24*Math.pow(distance/4,.6)*(spec.scale??1);// far labels shrink, but stay readable
 const face=labelFace(text,clickable),w=h*face.aspect;
 const root=new THREE.Group();
 const add=(geometry,mat,z)=>{const m=new THREE.Mesh(geometry,mat);m.position.z=z;m.renderOrder=2;mat.userData.opacity=mat.opacity;root.add(m);return m};
 add(new THREE.PlaneGeometry(w*1.35,h*2.4),new THREE.MeshBasicMaterial({map:shadowMap,transparent:true,opacity:.3,depthWrite:false}),-.08);
 const edge=add(new THREE.ShapeGeometry(pillShape(w+EDGE*2+BEVEL*2,h+EDGE*2+BEVEL*2),24),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.22,depthWrite:false}),SLAB_DEPTH/2);
 add(new THREE.ExtrudeGeometry(pillShape(w,h),{depth:SLAB_DEPTH,bevelEnabled:true,bevelThickness:BEVEL,bevelSize:BEVEL,bevelSegments:3,curveSegments:24}),new THREE.MeshStandardMaterial({color:0x0e1214,roughness:.55,metalness:0,transparent:true,opacity:.8}),0);
 add(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:face.map,transparent:true,depthWrite:false}),FRONT);
 root.position.set(Math.sin(y)*Math.cos(p)*distance,Math.sin(p)*distance,-Math.cos(y)*Math.cos(p)*distance);
 root.userData={target:clickable?target:undefined,edge,hot:0};
 return root;
}
function clearLabels(){for(const root of [...group.children]){group.remove(root);root.traverse(m=>{if(!m.isMesh)return;m.geometry.dispose();if(m.material.map&&!m.material.map.userData.shared)m.material.map.dispose();m.material.dispose()})}}
function buildLabels(){
 clearLabels();rig.position.y=eyeHeight(current);group.rotation.y=heading(current);
 const eye=rig.getWorldPosition(new THREE.Vector3());
 for(const spec of spaces[current].labels||[]){if(spec.to!==undefined&&!indexOf.has(spec.to))continue;const root=makeLabel(spec);group.add(root);root.lookAt(eye)}
}
function animateLabels(dt){
 for(const root of group.children){
  // No movement: the hovered label's edge brightens from a faint line to solid white.
  const u=root.userData;u.hot+=((root===hover?1:0)-u.hot)*Math.min(dt*12,1);
  u.edge.material.userData.opacity=.22+.73*u.hot;
  root.traverse(m=>{if(m.isMesh)m.material.opacity=m.material.userData.opacity*labelFade});
 }
}

// ---------------------------------------------------------------------------
// Logo: tour.logo.style "white" turns a dark logo into white for dark scenes;
// "original" uses the file as is.
// ---------------------------------------------------------------------------
const brand=new THREE.Group();brand.visible=false;rig.add(brand);
async function loadLogo(){
 const logo=tour.logo;if(!logo?.image)return;
 const img=new Image();img.src=logo.image;await img.decode();
 const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
 if(logo.style!=='original'){const d=ctx.getImageData(0,0,c.width,c.height),p=d.data;for(let i=0;i<p.length;i+=4){const a=p[i+3]/255*(1-(p[i]+p[i+1]+p[i+2])/765);p[i]=p[i+1]=p[i+2]=255;p[i+3]=a*255}ctx.putImageData(d,0,0)}
 const url=c.toDataURL(),html=document.querySelector('#logo');html.src=url;html.hidden=!!session;document.querySelector('#loader-logo').src=url;
 const map=new THREE.CanvasTexture(c);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;
 const loaderLogo=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4*c.height/c.width),new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false}));loaderLogo.position.y=.16;vrLoader.add(loaderLogo);
 // In VR the logo rests on a small dark slab below eye level.
 const w=.4,h=w*c.height/c.width,padX=.07,padY=.05;
 const slab=new THREE.Mesh(new THREE.ExtrudeGeometry(pillShape(w+padX*2,h+padY*2),{depth:SLAB_DEPTH,bevelEnabled:true,bevelThickness:BEVEL,bevelSize:BEVEL,bevelSegments:3,curveSegments:24}),new THREE.MeshStandardMaterial({color:0x0e1214,roughness:.55,metalness:0,transparent:true,opacity:.8}));
 const face=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false}));face.position.z=FRONT;
 brand.add(slab,face);brand.position.set(0,-1.2,-2.2);brand.lookAt(rig.getWorldPosition(new THREE.Vector3()));
}

// ---------------------------------------------------------------------------
// Directional panorama reprojection gives a Street View-style forward step.
// ---------------------------------------------------------------------------
const incomingMaterial=new THREE.ShaderMaterial({
 depthTest:false,depthWrite:false,precision:'highp',
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
   // Same mapping as the panorama mesh: image centre straight ahead (-Z), turning right moves right in the image.
   return vec2(.5+atan(ray.x,-ray.z)/6.28318530718,acos(clamp(-ray.y,-1.0,1.0))/3.14159265359);
 }
 // Mipmapped lookup whose gradient ignores the jump where the image wraps around, so no seam line appears.
 vec4 panoSample(sampler2D image,vec2 uv){
   vec2 dx=dFdx(uv),dy=dFdy(uv);
   dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
   return texture2DGradEXT(image,uv,dx,dy);
 }
 void main(){
   vec3 ray=normalize(panoDirection);
   float move=progress*progress*(3.0-2.0*progress);
   // The old view advances; the arriving view settles at its capture point.
   vec2 fromUV=panoramaUV(ray+travelDirection*travelStrength*move,fromHeading);
   vec2 toUV=panoramaUV(ray-travelDirection*travelStrength*.35*(1.0-move),toHeading);
   float blend=smoothstep(.15,.90,progress);
   gl_FragColor=mix(panoSample(fromImage,fromUV),panoSample(toImage,toUV),blend);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
 }`
});
const incoming=new THREE.Mesh(sphere.geometry,incomingMaterial);incoming.renderOrder=1;incoming.visible=false;stage.add(incoming);
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const ease=t=>t*t*t*(t*(t*6-15)+10);
function blendTo(t,direction,target){return new Promise(resolve=>{const u=incomingMaterial.uniforms;u.fromImage.value=material.map;u.toImage.value=t;u.fromHeading.value=heading(current);u.toHeading.value=heading(target);u.progress.value=0;u.travelStrength.value=reducedMotion.matches?0:renderer.xr.isPresenting?.10:.22;u.travelDirection.value.copy(direction);placeSpace(incoming,target);sphere.visible=false;incoming.visible=true;transition={elapsed:0,duration:reducedMotion.matches?.25:.72,resolve,target}})}
function show(i){current=i;buildLabels();place.textContent=spaces[i].name}
function updateTransition(dt){
 if(!transition)return;
 transition.elapsed+=dt;
 const progress=Math.min(transition.elapsed/transition.duration,1),blend=ease(progress);
 incomingMaterial.uniforms.progress.value=blend;
 // Let destinations disappear, then gently reveal the new destinations.
 const markerOpacity=progress<.5?1-ease(progress*2):ease((progress-.5)*2);
 if(progress>=.5&&!transition.swapped){show(transition.target);transition.swapped=true}
 labelFade=markerOpacity;
 if(progress===1){material.map=incomingMaterial.uniforms.toImage.value;material.needsUpdate=true;placeSpace(sphere,current);sphere.rotation.y=heading(current);sphere.visible=true;incoming.visible=false;incomingMaterial.uniforms.fromImage.value=null;incomingMaterial.uniforms.toImage.value=null;incomingMaterial.uniforms.progress.value=0;const done=transition.resolve;transition=null;done()}
}
async function go(i,direction=new THREE.Vector3(0,0,-1)){
 if(busy||i===current&&material.map)return;
 busy=true;waitingFor=i;
 try{
  const t=await texture(i);
  renderer.initTexture(t);
  status.hidden=true;
  if(material.map)await blendTo(t,direction,i);
  else{material.map=t;material.needsUpdate=true;placeSpace(sphere,i);sphere.rotation.y=heading(i);sphere.visible=true;show(i)}
 }catch(e){console.error(e);status.hidden=false;status.replaceChildren(document.createTextNode(`${spaces[i].name} could not load. `));const b=document.createElement('button');b.textContent='Retry';b.onclick=()=>go(i,direction);status.append(b)}
 finally{busy=false;waitingFor=-1}
}

// ---------------------------------------------------------------------------
// Input: mouse/touch drag on desktop, controller rays in VR.
// ---------------------------------------------------------------------------
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),tmp=new THREE.Vector3();
function hit(){let o=ray.intersectObjects(group.children,true)[0]?.object;while(o&&o.parent!==group)o=o.parent;return o?.userData.target!==undefined?o:null}
function activate(){const m=hit();if(m){m.getWorldPosition(tmp);go(m.userData.target,new THREE.Vector3(tmp.x,0,tmp.z).normalize())}else if(editMode)copySpot()}
renderer.domElement.addEventListener('pointerdown',e=>{drag=true;moved=false;last={x:e.clientX,y:e.clientY};renderer.domElement.setPointerCapture(e.pointerId)});renderer.domElement.addEventListener('pointermove',e=>{pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);if(drag){const dx=e.clientX-last.x,dy=e.clientY-last.y;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;yaw-=dx*.004;pitch=Math.max(-1.45,Math.min(1.45,pitch+dy*.004));last={x:e.clientX,y:e.clientY}}});renderer.domElement.addEventListener('pointerup',e=>{drag=false;if(!moved){pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);ray.setFromCamera(pointer,camera);activate()}});renderer.domElement.addEventListener('pointercancel',()=>drag=false);
const controllers=[];for(let i=0;i<2;i++){const c=renderer.xr.getController(i);world.add(c);const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-5)]),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.5}));c.add(line);c.addEventListener('select',()=>{ray.setFromXRController(c);activate()});controllers.push(c)}
// Quest hands: real hand meshes with hand tracking (pinch to select), controller models when holding controllers.
// The models come from the official WebXR input profiles; if they can't load, the pointer rays still work.
Promise.all([import('three/addons/webxr/XRHandModelFactory.js'),import('three/addons/webxr/XRControllerModelFactory.js')]).then(([{XRHandModelFactory},{XRControllerModelFactory}])=>{
 const handModels=new XRHandModelFactory(),controllerModels=new XRControllerModelFactory();
 for(let i=0;i<2;i++){
  const hand=renderer.xr.getHand(i);hand.add(handModels.createHandModel(hand,'mesh'));world.add(hand);
  const grip=renderer.xr.getControllerGrip(i);grip.add(controllerModels.createControllerModel(grip));world.add(grip);
 }
}).catch(e=>console.warn('Hand and controller models could not load',e));

// ---------------------------------------------------------------------------
// Edit mode (open with ?edit): shows yaw/pitch under the cursor for the
// current space; click empty space to copy a ready-made label line.
// ---------------------------------------------------------------------------
// Click the FLOOR at a doorway: the real distance is worked out from the camera height, and the label
// is placed at that distance just below eye level, so its depth matches the doorway.
function spotUnderPointer(){
 const d=ray.ray.direction;let y=deg(Math.atan2(d.x,-d.z)+heading(current));y=((y+540)%360)-180;
 const p=deg(Math.asin(d.y)),s={yaw:Math.round(y),pitch:Math.round(p)};
 if(p<-2)s.floor=Math.min(Math.round(eyeHeight(current)/Math.tan(rad(-p))*10)/10,roomSize(current));
 return s;
}
function showSpot(){if(!editMode||current<0)return;const s=spotUnderPointer();editBox.textContent=`Editing "${spaces[current].id}"   yaw ${s.yaw}   pitch ${s.pitch}`+(s.floor?`   floor ${s.floor} m`:'')+'   · click to copy'}
function copySpot(){const s=spotUnderPointer(),line=s.floor?`{ "to": "", "yaw": ${s.yaw}, "pitch": -4, "distance": ${s.floor} },`:`{ "to": "", "yaw": ${s.yaw}, "pitch": ${s.pitch}, "distance": ${Math.round(roomSize(current)*.6)} },`;navigator.clipboard?.writeText(line).catch(()=>{});editBox.textContent='Copied: '+line;console.log(`[${spaces[current].id}]`,line)}
editBox.hidden=!editMode;

// VR is the default: on a headset the loading screen offers Enter VR right away, and loading
// carries on inside VR. Browsers only allow entering VR after a click (or a granted session).
const loaderVR=document.querySelector('#loader-vr');
let session=null;async function checkVR(){try{if(navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr')){vr.disabled=false;vr.textContent='Enter VR';loaderVR.hidden=false;if(granted)enterVR()}else{vr.textContent='VR: open on Quest';vr.disabled=true}}catch{vr.textContent='VR unavailable'}}
window.enterVR=enterVR;vr.onclick=loaderVR.onclick=enterVR;
async function enterVR(){try{if(session){await session.end();return}session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','hand-tracking']});floorLevel=!session.enabledFeatures||session.enabledFeatures.includes('local-floor');renderer.xr.setReferenceSpaceType(floorLevel?'local-floor':'local');await renderer.xr.setSession(session);document.querySelector('#top').hidden=true;document.querySelector('#logo').hidden=true;document.querySelector('#hint').hidden=true;session.addEventListener('end',()=>{session=null;document.querySelector('#top').hidden=false;document.querySelector('#logo').hidden=false;vr.textContent='Enter VR'})}catch(e){session=null;status.hidden=false;status.textContent='VR could not start. Try Enter VR again.'}};
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
let time=performance.now();
renderer.setAnimationLoop(()=>{
 const now=performance.now(),dt=Math.min((now-time)/1000,.1);time=now;
 // In VR the capture point always sits at your actual eye height, so the floor is cameraHeight below your eyes
 // whether you stand, sit, or the headset's floor is set wrong. Turning and leaning still give real parallax.
 stage.position.y=renderer.xr.isPresenting?renderer.xr.getCamera().position.y-rig.position.y:0;
 if(!renderer.xr.isPresenting){camera.position.y=rig.position.y;camera.rotation.set(-pitch,yaw,0,'YXZ');ray.setFromCamera(pointer,camera);hover=hit();if(!drag)showSpot();renderer.domElement.style.cursor=hover?'pointer':drag?'grabbing':editMode?'crosshair':'grab'}
 else{hover=null;for(const c of controllers){ray.setFromXRController(c);const h=hit();if(h)hover=h}}
 animateLabels(dt);brand.visible=renderer.xr.isPresenting&&!loading;vrLoader.visible=renderer.xr.isPresenting&&loading;if(vrLoader.visible)vrShine.position.x=reducedMotion.matches?-1:(now/1400%1)*1.3-.15;
 const view=renderer.xr.isPresenting?renderer.xr.getCamera():camera;eyeLight.position.copy(view.position);
 updateTransition(dt);renderer.render(world,camera);
});
loadLogo().catch(e=>console.warn('Logo could not load',e));
const first=indexOf.get(params.get('space'))??indexOf.get(tour.start)??0;
status.hidden=true;checkVR();
await preloadAll(first);
await go(first);
setTimeout(()=>document.querySelector('#hint').style.opacity='0',6500);
