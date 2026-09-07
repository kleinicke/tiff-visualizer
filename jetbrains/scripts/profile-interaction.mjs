import {writeFile, mkdir} from 'node:fs/promises';
const output = new URL('../build/interaction-profile/', import.meta.url);
await mkdir(output, {recursive:true});
const target=(await(await fetch('http://127.0.0.1:9223/json/list')).json()).find(t=>t.url.includes('/image/'));
if (!target) throw new Error('Open an image in the development IDE first');
const timeout = setTimeout(() => { console.error('Interaction profile timed out'); process.exit(1); }, 20000);
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const jobs=new Map();ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.id)jobs.get(m.id)?.(m.result)};
const send=(method,params={})=>new Promise(r=>{jobs.set(++id,r);ws.send(JSON.stringify({id,method,params}))});
await send('Profiler.enable');await send('Profiler.start');
await send('Runtime.evaluate',{expression:`window.frameSamples=[];window.profileEnd=performance.now()+4000;let last=performance.now();function tick(t){frameSamples.push(t-last);last=t;if(t<profileEnd)requestAnimationFrame(tick)}requestAnimationFrame(tick)`});
for(let i=0;i<180;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:250+i%90*3,y:300+i%50*3}); await new Promise(r=>setTimeout(r,16));}
const {profile}=await send('Profiler.stop');await writeFile(new URL(`hover-${Date.now()}.cpuprofile`, output),JSON.stringify(profile));
const counts=new Map();for(const s of profile.samples||[])counts.set(s,(counts.get(s)||0)+1);
console.log(profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,count:counts.get(n.id)||0})).sort((a,b)=>b.count-a.count).slice(0,12));
console.log((await send('Runtime.evaluate',{expression:`JSON.stringify({readout:document.getElementById('web-status-size').textContent,frames:frameSamples.length,median:frameSamples.sort((a,b)=>a-b)[Math.floor(frameSamples.length/2)]})`,returnByValue:true})).result.value);ws.close();clearTimeout(timeout);
