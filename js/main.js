import { initFirebase } from "./firebase.js";
import {
  joinLobby, watchRoom, roomRefs,
  setRoomState,
  publishMyState, subscribeOppState,
  pushEvent, subscribeEvents,
  tryCleanupRoom, releaseSlot, sweepLobbySlots
} from "./netplay.js";

// --- UI
const ui = {
  matchBtn: document.getElementById("match-btn"),
  status: document.getElementById("net-status"),
  oppTitle: document.getElementById("opp-title"),
  oppCanvas: document.getElementById("opp-canvas"),
};

function setStatus(t){
  if(ui.status) ui.status.textContent = t;
}

if(ui.matchBtn){
  ui.matchBtn.addEventListener("click", ()=>location.reload());
}

// --- Online flow
function stableLobbyId(){
  const s = location.origin + location.pathname;
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "suika_" + (h>>>0).toString(36);
}

let fb=null, db=null, api=null;
let lobbyId="", roomId="", mySlot=null, pid="";
let hbTimer=null;
let refs=null;
let roomUnsub=null, oppUnsub=null, evUnsub=null;
let publishTimer=null;
let sweepTimer=null;
let mode="offline";

// game instance
let game=null;

// Opp render
const oppCtx = ui.oppCanvas ? ui.oppCanvas.getContext("2d") : null;
function drawOpp(state){
  if(!oppCtx || !ui.oppCanvas) return;
  const cv = ui.oppCanvas;
  oppCtx.clearRect(0,0,cv.width,cv.height);

  // background
  oppCtx.fillStyle = "rgba(255,255,255,0.35)";
  oppCtx.fillRect(0,0,cv.width,cv.height);

  if(!state || !state.bodies || !state.w || !state.h) return;

  const shapes = window.SHAPES || [];
  const scaleX = cv.width / state.w;
  const scaleY = cv.height / state.h;
  const scale = Math.min(scaleX, scaleY);

  for(const b of state.bodies){
    const x = b.x * scaleX;
    const y = b.y * scaleY;
    const a = b.a || 0;
    const isRock = !!b.r;

    let size = (shapes[b.i]?.size || (shapes[0]?.size || 14)) * scale;
    if(size < 2) size = 2;

    oppCtx.save();
    oppCtx.translate(x,y);
    oppCtx.rotate(a);

    if(isRock){
      drawRock(oppCtx, size);
    }else{
      const type = shapes[b.i]?.type || "circle";
      const color = shapes[b.i]?.color || "#FF6B6B";
      drawShape(oppCtx, type, color, size);
    }

    oppCtx.restore();
  }
}

function drawShape(ctx, type, color, size){
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = Math.max(1, size * 0.12);

  ctx.beginPath();
  if(type === "circle" || type === "bigcircle"){
    ctx.arc(0,0,size,0,Math.PI*2);
  }else if(type === "triangle"){
    poly(ctx, 3, size);
  }else if(type === "pentagon"){
    poly(ctx, 5, size);
  }else if(type === "hexagon"){
    poly(ctx, 6, size);
  }else if(type === "square"){
    ctx.rect(-size*0.8,-size*0.8,size*1.6,size*1.6);
  }else if(type === "rectangle"){
    ctx.rect(-size*1.1,-size*0.6,size*2.2,size*1.2);
  }else if(type === "diamond"){
    ctx.moveTo(0,-size);
    ctx.lineTo(size*0.75,0);
    ctx.lineTo(0,size);
    ctx.lineTo(-size*0.75,0);
    ctx.closePath();
  }else if(type === "isoceles"){
    ctx.moveTo(0,-size*1.3);
    ctx.lineTo(size*0.7,size*0.7);
    ctx.lineTo(-size*0.7,size*0.7);
    ctx.closePath();
  }else{
    ctx.arc(0,0,size,0,Math.PI*2);
  }

  ctx.fill();
  ctx.stroke();
}

function poly(ctx, n, r){
  for(let i=0;i<n;i++){
    const ang = (Math.PI*2*i)/n - Math.PI/2;
    const x = Math.cos(ang)*r;
    const y = Math.sin(ang)*r;
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  }
  ctx.closePath();
}

function drawRock(ctx, size){
  ctx.fillStyle = "#7f8c8d";
  ctx.strokeStyle = "#2d3436";
  ctx.lineWidth = Math.max(1, size * 0.18);

  const r = size * 0.95;
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const ang = (Math.PI*2*i)/6;
    const rr = r * (0.82 + (i%2)*0.12);
    const x = Math.cos(ang)*rr;
    const y = Math.sin(ang)*rr;
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // x_x face
  ctx.strokeStyle = "#1f1f1f";
  ctx.lineWidth = Math.max(1, size * 0.16);
  const eg = size * 0.33;
  const ey = -size * 0.05;
  const cross = size * 0.14;
  const drawX = (cx, cy) => {
    ctx.beginPath();
    ctx.moveTo(cx - cross, cy - cross);
    ctx.lineTo(cx + cross, cy + cross);
    ctx.moveTo(cx - cross, cy + cross);
    ctx.lineTo(cx + cross, cy - cross);
    ctx.stroke();
  };
  drawX(-eg, ey);
  drawX(eg, ey);

  ctx.beginPath();
  ctx.moveTo(-size*0.22, size*0.32);
  ctx.lineTo(size*0.22, size*0.32);
  ctx.stroke();
}

async function enterRoom(joined){
  roomId = joined.roomId;
  mySlot = joined.slot;
  pid = joined.pid;
  hbTimer = joined.hbTimer;

  refs = roomRefs({db, api, roomId});

  roomUnsub?.();
  roomUnsub = watchRoom({ db, api, roomId, onRoom: onRoomUpdate });

  oppUnsub?.();
  oppUnsub = subscribeOppState({ api, statesRef: refs.statesRef, pid, onOpp: ({state})=>{
    if(ui.oppTitle){
      const score = state?.score ?? 0;
      ui.oppTitle.textContent = `상대 (점수 ${score})`;
    }
    drawOpp(state);
  }});

  evUnsub?.();
  evUnsub = subscribeEvents({ api, eventsRef: refs.eventsRef, pid, onEvent: onEventRecv });

  // publish loop
  if(publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(()=>{
    if(!game || mode !== "online") return;
    publishMyState({ api, statesRef: refs.statesRef, pid, state: game.getNetState() }).catch(()=>{});
  }, 120);
}

function onRoomUpdate(room){
  if(mode !== "online") return;
  if(!room || !room.meta){
    setStatus("방 없음(오프라인)");
    return;
  }

  const meta = room.meta;
  const players = room.players || {};
  const ids = Object.keys(players);

  setStatus(ids.length >= 2 ? "연결됨" : "연결 대기…");
  if(ui.oppTitle) ui.oppTitle.textContent = ids.length >= 2 ? "상대" : "상대 (연결 대기…)";

  if(ids.length === 2 && meta.state === "open"){
    setRoomState({ api, metaRef: refs.metaRef }, "playing").catch(()=>{});
  }
}

function onEventRecv({key, ev}){
  if(!ev) return;
  if(ev.kind === "rocks"){
    const n = Math.max(0, Math.min(12, (ev.payload && ev.payload.n) || 0));
    try{ game?.dropRocks?.(n); }catch{}
  }

  // consume immediately to avoid leaving logs
  try{ api.remove(api.child(refs.eventsRef, key)).catch(()=>{}); }catch{}
}

async function bootOnline(){
  // Wait for game first
  if(!game) return;

  // hook combo -> attack
  game.onComboEnd = (cnt)=>{
    if(mode !== "online" || !refs || !refs.eventsRef) return;
    if(cnt >= 3){
      pushEvent({ api, eventsRef: refs.eventsRef, event: { from: pid, kind: "rocks", payload: { n: cnt } } }).catch(()=>{});
    }
  };

  try{
    fb = initFirebase();
    db = fb.db;
    api = fb.api;
  }catch(e){
    setStatus("오프라인");
    return;
  }

  try{
    lobbyId = stableLobbyId();
    // sweep old rooms/slots periodically so signals don't linger
    try{ await sweepLobbySlots({db, api, lobbyId, maxTeams: 10}); }catch{}
    sweepTimer = setInterval(()=>{ try{ sweepLobbySlots({db, api, lobbyId, maxTeams:10}).catch(()=>{}); }catch{} }, 20000);

    mode = "online";
    setStatus("연결 중…");

    const joined = await joinLobby({ db, api, lobbyId, name: "Player", maxTeams: 10 });
    await enterRoom(joined);

    setStatus("연결 대기…");
  }catch(e){
    mode = "offline";
    setStatus("오프라인");
  }
}

// --- Cleanup: remove my nodes, then delete room if empty
let _exitCleaned = false;
function bestEffortExitCleanup(){
  if(_exitCleaned) return;
  _exitCleaned = true;

  try{ if(publishTimer) clearInterval(publishTimer); }catch{}
  try{ if(sweepTimer) clearInterval(sweepTimer); }catch{}
  try{ if(hbTimer) clearInterval(hbTimer); }catch{}

  try{ roomUnsub?.(); }catch{}
  try{ oppUnsub?.(); }catch{}
  try{ evUnsub?.(); }catch{}

  if(mode === "online" && db && api && roomId && refs){
    // 1) 내 노드 먼저 제거(가능하면 onDisconnect도 있지만, 즉시 정리 시도)
    try{ if(refs.playersRef && pid) api.remove(api.child(refs.playersRef, pid)).catch(()=>{}); }catch{}
    try{ if(refs.statesRef && pid) api.remove(api.child(refs.statesRef, pid)).catch(()=>{}); }catch{}

    // 2) room cleanup은 위 remove가 반영된 뒤에 보이도록 약간 지연해서 재시도
    //    (unload 상황에서는 await가 어려워서 best-effort로 1회 더)
    try{
      setTimeout(()=>{ tryCleanupRoom({ db, api, roomId }).catch(()=>{}); }, 250);
    }catch{}

    // 3) lobby slot 해제
    try{ if(lobbyId) releaseSlot({ db, api, lobbyId, slot: mySlot }).catch(()=>{}); }catch{}
  }

  // prune lobby mm if empty
  try{ if(db && api && lobbyId) releaseSlot({ db, api, lobbyId, slot: null }).catch(()=>{}); }catch{}
}

window.addEventListener("beforeunload", bestEffortExitCleanup);
window.addEventListener("pagehide", bestEffortExitCleanup);
document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState === "hidden") bestEffortExitCleanup();
});

// If game over and user closes overlay/reloads, cleanup will run via unload.
window.addEventListener('shapeGameReady', (e)=>{
  game = e?.detail?.game || window.__shapeGame || null;
  // boot online once game exists
  bootOnline();
});

// In case event was dispatched before this module loaded
if(window.__shapeGame){
  game = window.__shapeGame;
  bootOnline();
}
