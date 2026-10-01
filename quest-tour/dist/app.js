import * as THREE from './assets/three.module.js';
const scenes=[{name:'Observatory',image:'alma.jpg',heading:0},{name:'Mountain',image:'mountain.jpg',heading:0},{name:'Coast',image:'coast.jpg',heading:0}];
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.xr.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.prepend(renderer.domElement);
const world=new THREE.Scene(),camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,.05,100);camera.position.set(0,0,0);
const material=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.BackSide});const sphere=new THREE.Mesh(new THREE.SphereGeometry(40,64,40),material);world.add(sphere);
const group=new THREE.Group();world.add(group);const loader=new THREE.TextureLoader(),cache=new Map();const status=document.querySelector('#status'),place=document.querySelector('#place'),vr=document.querySelector('#vr');let current=0,busy=false,yaw=0,pitch=0,drag=false,moved=false,last={x:0,y:0},hover=null,transition=null;
function texture(i){if(!cache.has(i))cache.set(i,loader.loadAsync('./assets/'+scenes[i].image).then(t=>{t.colorSpace=THREE.SRGBColorSpace;t.generateMipmaps=false;t.minFilter=THREE.LinearFilter;return t}).catch(e=>{cache.delete(i);throw e}));return cache.get(i)}
function label(text){const c=document.createElement('canvas');c.width=512;c.height=128;const ctx=c.getContext('2d');ctx.fillStyle='rgba(15,25,28,.78)';ctx.beginPath();ctx.roundRect(4,4,504,120,60);ctx.fill();ctx.strokeStyle='rgba(255,255,255,.5)';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='white';ctx.font='500 38px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,66);const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;return new THREE.MeshBasicMaterial({map:tex,transparent:true,side:THREE.DoubleSide,depthTest:false})}
function hotspots(){for(const m of [...group.children]){group.remove(m);m.geometry.dispose();m.material.map?.dispose();m.material.dispose()}scenes.forEach((s,i)=>{if(i===current)return;const slot=group.children.length,a=slot===0?-.55:.55;const m=new THREE.Mesh(new THREE.PlaneGeometry(1.3,.325),label('◉  '+s.name));m.position.set(Math.sin(a)*4,-.55,-Math.cos(a)*4);m.lookAt(0,0,0);m.renderOrder=2;m.userData.target=i;group.add(m)})}
const brand=new THREE.Mesh(new THREE.PlaneGeometry(.65,.1625),label('YOUR LOGO'));brand.position.set(0,-1.6,-3);brand.visible=false;brand.renderOrder=2;world.add(brand);
// Directional panorama reprojection gives a Street View-style forward step.
const incomingMaterial=new THREE.ShaderMaterial({
 side:THREE.BackSide,depthTest:false,depthWrite:false,precision:'highp',
 uniforms:{fromImage:{value:null},toImage:{value:null},progress:{value:0},travelStrength:{value:.22},travelDirection:{value:new THREE.Vector3(0,0,-1)}},
 vertexShader:`varying vec3 panoDirection;void main(){panoDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
 fragmentShader:`
 uniform sampler2D fromImage;uniform sampler2D toImage;
 uniform float progress;uniform float travelStrength;uniform vec3 travelDirection;
 varying vec3 panoDirection;
 vec2 panoramaUV(vec3 ray){
   ray=normalize(ray);
   return vec2(fract(atan(ray.z,-ray.x)/6.28318530718+1.0),acos(clamp(-ray.y,-1.0,1.0))/3.14159265359);
 }
 void main(){
   vec3 ray=normalize(panoDirection);
   float move=progress*progress*(3.0-2.0*progress);
   // The old view advances; the arriving view settles at its capture point.
   vec2 fromUV=panoramaUV(ray+travelDirection*travelStrength*move);
   vec2 toUV=panoramaUV(ray-travelDirection*travelStrength*.35*(1.0-move));
   float blend=smoothstep(.15,.90,progress);
   gl_FragColor=mix(texture2D(fromImage,fromUV),texture2D(toImage,toUV),blend);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
 }`
});
const incoming=new THREE.Mesh(sphere.geometry,incomingMaterial);incoming.renderOrder=1;incoming.visible=false;world.add(incoming);
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const ease=t=>t*t*t*(t*(t*6-15)+10);
function blendTo(t,direction){return new Promise(resolve=>{incomingMaterial.uniforms.fromImage.value=material.map;incomingMaterial.uniforms.toImage.value=t;incomingMaterial.uniforms.progress.value=0;incomingMaterial.uniforms.travelStrength.value=reducedMotion.matches?0:renderer.xr.isPresenting?.10:.22;incomingMaterial.uniforms.travelDirection.value.copy(direction);sphere.visible=false;incoming.visible=true;transition={elapsed:0,duration:reducedMotion.matches?.25:.72,resolve}})}
function updateTransition(dt){
 if(!transition)return;
 transition.elapsed+=dt;
 const progress=Math.min(transition.elapsed/transition.duration,1),blend=ease(progress);
 incomingMaterial.uniforms.progress.value=blend;
 // Let destinations disappear, then gently reveal the new destinations.
 const markerOpacity=progress<.5?1-ease(progress*2):ease((progress-.5)*2);
 if(progress>=.5&&!transition.swapped){current=transition.target;hotspots();place.textContent=scenes[current].name;transition.swapped=true}
 for(const m of group.children)m.material.opacity=markerOpacity;
 if(progress===1){material.map=incomingMaterial.uniforms.toImage.value;material.needsUpdate=true;sphere.visible=true;incoming.visible=false;incomingMaterial.uniforms.fromImage.value=null;incomingMaterial.uniforms.toImage.value=null;incomingMaterial.uniforms.progress.value=0;const done=transition.resolve;transition=null;done()}
}
async function go(i,direction=new THREE.Vector3(0,0,-1)){
 if(busy||i===current&&material.map)return;
 busy=true;
 try{
  const t=await texture(i);
  renderer.initTexture(t);
  status.hidden=true;
  if(material.map){const completed=blendTo(t,direction);transition.target=i;await completed}
  else{material.map=t;material.needsUpdate=true;current=i;hotspots();place.textContent=scenes[i].name}
  scenes.forEach((_,j)=>{if(j!==i)texture(j).then(t=>renderer.initTexture(t)).catch(()=>{})});
 }catch(e){status.hidden=false;status.replaceChildren(document.createTextNode('Panorama could not load. '));const b=document.createElement('button');b.textContent='Retry';b.onclick=()=>go(i);status.append(b)}
 finally{busy=false}
}
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();function hit(){return ray.intersectObjects(group.children,false)[0]?.object}function activate(){const m=hit();if(m)go(m.userData.target,new THREE.Vector3(m.position.x,0,m.position.z).normalize())}
renderer.domElement.addEventListener('pointerdown',e=>{drag=true;moved=false;last={x:e.clientX,y:e.clientY};renderer.domElement.setPointerCapture(e.pointerId)});renderer.domElement.addEventListener('pointermove',e=>{pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);if(drag){const dx=e.clientX-last.x,dy=e.clientY-last.y;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;yaw-=dx*.004;pitch=Math.max(-1.45,Math.min(1.45,pitch+dy*.004));last={x:e.clientX,y:e.clientY}}});renderer.domElement.addEventListener('pointerup',e=>{drag=false;if(!moved){pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);ray.setFromCamera(pointer,camera);activate()}});renderer.domElement.addEventListener('pointercancel',()=>drag=false);
const controllers=[];for(let i=0;i<2;i++){const c=renderer.xr.getController(i);world.add(c);const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-5)]),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.5}));c.add(line);c.addEventListener('select',()=>{ray.setFromXRController(c);activate()});controllers.push(c)}
let session=null;async function checkVR(){try{if(navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr')){vr.disabled=false;vr.textContent='Enter VR'}else{vr.textContent='VR: open on Quest';vr.disabled=true}}catch{vr.textContent='VR unavailable'}}vr.onclick=async()=>{try{if(session){await session.end();return}session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor']});renderer.xr.setReferenceSpaceType('local');await renderer.xr.setSession(session);document.querySelector('#top').hidden=true;document.querySelector('#logo').hidden=true;document.querySelector('#hint').hidden=true;session.addEventListener('end',()=>{session=null;document.querySelector('#top').hidden=false;document.querySelector('#logo').hidden=false;vr.textContent='Enter VR'})}catch(e){session=null;status.hidden=false;status.textContent='VR could not start. Try Enter VR again.'}};
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});let time=performance.now();renderer.setAnimationLoop(()=>{const now=performance.now(),dt=Math.min((now-time)/1000,.1);time=now;if(!renderer.xr.isPresenting){camera.rotation.set(-pitch,yaw,0,'YXZ');ray.setFromCamera(pointer,camera);hover=hit();renderer.domElement.style.cursor=hover?'pointer':drag?'grabbing':'grab'}else{hover=null;for(const c of controllers){ray.setFromXRController(c);const h=hit();if(h)hover=h}}for(const m of group.children)m.scale.setScalar(m===hover?1.08:1);brand.visible=renderer.xr.isPresenting;const view=renderer.xr.isPresenting?renderer.xr.getCamera():camera;sphere.position.copy(view.position);incoming.position.copy(view.position);updateTransition(dt);renderer.render(world,camera)});checkVR();go(0);setTimeout(()=>document.querySelector('#hint').style.opacity='0',6500);
