const video = document.getElementById('inputVideo');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const message = document.getElementById('cameraMessage');
const leftState = document.getElementById('leftState');
const rightState = document.getElementById('rightState');
const activeKey = document.getElementById('activeKey');
const touchScore = document.getElementById('touchScore');
const output = document.getElementById('textOutput');
const count = document.getElementById('count');
const showLabels = document.getElementById('showLabels');
const soundToggle = document.getElementById('soundToggle');

// MediaPipe landmark IDs: thumb tip=4, index/middle/ring/pinky joints and tips.
const keyPoints = [
  {id:8,key:'A',name:'Index tip'}, {id:7,key:'S',name:'Index joint'},
  {id:6,key:'D',name:'Index joint 2'}, {id:5,key:'F',name:'Index base'},
  {id:12,key:'G',name:'Middle tip'}, {id:11,key:'H',name:'Middle joint'},
  {id:10,key:'J',name:'Middle joint 2'}, {id:9,key:'K',name:'Middle base'},
  {id:16,key:'L',name:'Ring tip'}, {id:15,key:'Q',name:'Ring joint'},
  {id:14,key:'W',name:'Ring joint 2'}, {id:13,key:'E',name:'Ring base'},
  {id:20,key:'R',name:'Pinky tip'}, {id:19,key:'T',name:'Pinky joint'},
  {id:18,key:'Y',name:'Pinky joint 2'}, {id:17,key:'U',name:'Pinky base'},
  {id:3,key:'Z',name:'Thumb joint'}, {id:2,key:'X',name:'Thumb joint 2'},
  {id:1,key:'C',name:'Thumb base'}
];
let handsModel, camera, lastTouch = false, lastKey = '', lastTouchTime = 0;
let audioCtx;

function resizeCanvas(){
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width*dpr);
  canvas.height = Math.round(r.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function drawPoint(x,y,label,active=false){
  const w=canvas.clientWidth, h=canvas.clientHeight;
  const px=x*w, py=y*h;
  ctx.beginPath(); ctx.arc(px,py,active?9:5,0,Math.PI*2);
  ctx.fillStyle=active?'#fff28a':'#55f0d0'; ctx.fill();
  ctx.strokeStyle=active?'#fff28a':'#1c796f'; ctx.lineWidth=2; ctx.stroke();
  if(showLabels.checked && label){
    ctx.font='bold 12px ui-monospace,monospace';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillStyle='#061321'; ctx.fillText(label,px+1,py-8+1);
    ctx.fillStyle='#ffffff'; ctx.fillText(label,px,py-8);
  }
}
function playClick(){
  if(!soundToggle.checked)return;
  try{
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    const osc=audioCtx.createOscillator(), gain=audioCtx.createGain();
    osc.frequency.value=660; gain.gain.value=.04;
    osc.connect(gain);gain.connect(audioCtx.destination);
    osc.start();osc.stop(audioCtx.currentTime+.045);
  }catch(e){}
}
function typeKey(key){
  const start=output.selectionStart,end=output.selectionEnd;
  if(key==='⌫'){
    if(start===end && start>0) output.setRangeText('',start-1,start,'end');
    else output.setRangeText('',start,end,'end');
  } else if(key==='SPACE') output.setRangeText(' ',start,end,'end');
  else output.setRangeText(key,start,end,'end');
  output.dispatchEvent(new Event('input'));
  activeKey.textContent=key;
  playClick();
}
output.addEventListener('input',()=>count.textContent=`${output.value.length} CHARACTERS`);

function onResults(results){
  const w=canvas.clientWidth,h=canvas.clientHeight;
  ctx.clearRect(0,0,w,h);
  let foundLeft=false,foundRight=false, currentTouch=false, detectedKey='', bestScore=1;
  if(results.multiHandLandmarks){
    results.multiHandLandmarks.forEach((lm,i)=>{
      const handed=results.multiHandedness?.[i]?.label || 'Hand';
      if(handed==='Left')foundLeft=true; else foundRight=true;
      // Draw hand skeleton using standard MediaPipe connections.
      const connections=window.HAND_CONNECTIONS || [];
      ctx.lineWidth=2;ctx.strokeStyle='rgba(83,169,255,.8)';
      connections.forEach(([a,b])=>{
        if(!lm[a]||!lm[b])return;
        ctx.beginPath();ctx.moveTo(lm[a].x*w,lm[a].y*h);ctx.lineTo(lm[b].x*w,lm[b].y*h);ctx.stroke();
      });
      const thumb=lm[4];
      // Thumb touching a labeled landmark triggers its key.
      keyPoints.forEach(p=>{
        const point=lm[p.id];
        const d=dist(thumb,point);
        const threshold=(p.id===3||p.id===2||p.id===1)?0.045:0.055;
        const active=d<threshold;
        if(active && d<bestScore){bestScore=d;detectedKey=p.key;currentTouch=true;}
        drawPoint(point.x,point.y,p.key,active);
      });
      drawPoint(thumb.x,thumb.y,'TH',false);
      // Palm center = space gesture when thumb approaches landmark 0 (wrist) isn't useful,
      // so backspace is assigned to thumb touching wrist.
      const wrist=lm[0], wd=dist(thumb,wrist);
      if(wd<0.075 && wd<bestScore){bestScore=wd;detectedKey='⌫';currentTouch=true;}
      // Palm center marker
      const palm={x:(lm[0].x+lm[5].x+lm[17].x)/3,y:(lm[0].y+lm[5].y+lm[17].y)/3};
      drawPoint(palm.x,palm.y,'SPACE',dist(thumb,palm)<.045);
      if(dist(thumb,palm)<.045 && .045<bestScore){detectedKey='SPACE';currentTouch=true;bestScore=.045;}
    });
  }
  leftState.textContent=foundLeft?'TRACKING':'NOT FOUND';
  rightState.textContent=foundRight?'TRACKING':'NOT FOUND';
  touchScore.textContent=Number.isFinite(bestScore)&&bestScore<1?bestScore.toFixed(3):'—';
  if(currentTouch && detectedKey){
    const now=Date.now();
    // Only type on a fresh touch; user must lift thumb before next character.
    if(!lastTouch && now-lastTouchTime>180){
      typeKey(detectedKey);lastTouchTime=now;
    }
    lastKey=detectedKey;
  } else {
    activeKey.textContent='—';
  }
  lastTouch=currentTouch;
  message.classList.toggle('hidden',!!results.multiHandLandmarks?.length);
  statusEl.textContent=results.multiHandLandmarks?.length?'TRACKING':'CAMERA ON · FIND HAND';
}

async function start(){
  if(!navigator.mediaDevices?.getUserMedia){
    statusEl.textContent='HTTPS REQUIRED';
    alert('Camera needs HTTPS or localhost. Open the GitHub Pages https:// link.');
    return;
  }
  try{
    statusEl.textContent='STARTING CAMERA…';
    handsModel = new Hands({locateFile:(file)=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
    handsModel.setOptions({maxNumHands:2,modelComplexity:1,minDetectionConfidence:.6,minTrackingConfidence:.55});
    handsModel.onResults(onResults);
    camera = new Camera(video,{onFrame:async()=>{await handsModel.send({image:video});},width:1280,height:720});
    await camera.start();
    video.style.opacity='1';
    message.classList.add('hidden');
    statusEl.textContent='CAMERA ON';
  }catch(err){
    console.error(err);
    statusEl.textContent='CAMERA ERROR';
    alert('Could not start camera. Allow camera permission and open the site over HTTPS. Details: '+err.message);
  }
}

const startButton=document.createElement('button');
startButton.textContent='START CAMERA';
startButton.className='start-button';
startButton.addEventListener('click',start);
document.querySelector('.topbar').appendChild(startButton);
document.getElementById('copyBtn').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(output.value);statusEl.textContent='TEXT COPIED';}
  catch(e){output.select();document.execCommand('copy');statusEl.textContent='TEXT COPIED';}
});
document.getElementById('clearBtn').addEventListener('click',()=>{output.value='';output.dispatchEvent(new Event('input'));output.focus();activeKey.textContent='—';});
