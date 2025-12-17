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
  overlay: document.getElementById("net-overlay"),
  overlayTitle: document.getElementById("net-overlay-title"),
  overlayDesc: document.getElementById("net-overlay-desc"),
  overlayTimer: document.getElementById("net-overlay-timer"),
  overlayRetry: document.getElementById("net-overlay-retry"),
  overlayClose: document.getElementById("net-overlay-close"),
};

function setStatus(t){
  if(ui.status) ui.status.textContent = t;
}

function showNetOverlay({title, desc, seconds, canClose=true, canRetry=true}={}){
  if(!ui.overlay) return;
  if(ui.overlayTitle && typeof title === "string") ui.overlayTitle.textContent = title;
  if(ui.overlayDesc && typeof desc === "string") ui.overlayDesc.textContent = desc;
  if(ui.overlayTimer){
    ui.overlayTimer.textContent = (typeof seconds === "number") ? `남은 시간: ${seconds}s` : "";
  }
  if(ui.overlayRetry) ui.overlayRetry.style.display = canRetry ? "" : "none";
  if(ui.overlayClose) ui.overlayClose.style.display = canClose ? "" : "none";
  ui.overlay.classList.add("show");
  ui.overlay.setAttribute("aria-hidden", "false");
}

function hideNetOverlay(){
  if(!ui.overlay) return;
  ui.overlay.classList.remove("show");
  ui.overlay.setAttribute("aria-hidden", "true");
}

if(ui.overlayRetry){
  ui.overlayRetry.addEventListener("click", ()=>location.reload());
}
if(ui.overlayClose){
  ui.overlayClose.addEventListener("click", ()=>hideNetOverlay());
}

setStatus("오프라인");

function comboToRocks(combo){
  const c = combo|0;
  if(c < 3) return 0;
  if(c === 3) return 1;
  if(c === 4) return 2;
  return Math.min(6, c - 2);
}

let waitTimer = null;
let waitRemain = 0;
let joinedAt = 0;
let resolved = false;

function beginCountdown(seconds){
  try{ if(waitTimer) clearInterval(waitTimer); }catch{}
  waitRemain = seconds|0;
  showNetOverlay({ title: "매칭 중…", desc: "상대방을 찾는 중입니다.", seconds: waitRemain, canClose: true, canRetry: false });
  waitTimer = setInterval(()=>{
    waitRemain -= 1;
    if(waitRemain < 0) waitRemain = 0;
    // still waiting
    if(mode !== "online"){
      showNetOverlay({ title: "매칭 중…", desc: "상대방을 찾는 중입니다.", seconds: waitRemain, canClose: true, canRetry: false });
    }
    if(waitRemain <= 0 && mode !== "online"){
      try{ clearInterval(waitTimer); }catch{}
      waitTimer = null;
      setStatus("오프라인");
      mode = "offline";
      showNetOverlay({ title: "매칭 실패", desc: "20초 안에 상대를 찾지 못했습니다.", seconds: undefined, canClose: true, canRetry: true });
    }
  }, 1000);
}

function startMatching(){
  if(mode !== "offline"){
    location.reload();
    return;
  }
  if(!game){
    showNetOverlay({ title: "로딩 중…", desc: "게임 준비가 끝난 뒤 다시 눌러주세요.", canClose: true, canRetry: false });
    return;
  }
  resolved = false;
  mode = "matching";
  setStatus("연결 중…");
  beginCountdown(20);
  bootOnline();
}

if(ui.matchBtn){
  ui.matchBtn.addEventListener("click", startMatching);
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
  joinedAt = Date.now();

  refs = roomRefs({db, api, roomId});

  roomUnsub?.();
  roomUnsub = watchRoom({ db, api, roomId, onRoom: onRoomUpdate });

  oppUnsub?.();
  oppUnsub = subscribeOppState({ api, statesRef: refs.statesRef, pid, onOpp: ({state})=>{
    if(ui.oppTitle){
      const score = state?.score ?? 0;
      ui.oppTitle.textContent = `상대 (점수 ${score})`;
    }
    // win detection
    if(state?.over && !resolved){
      resolved = true;
      try{ if(game) game.canDrop = false; }catch{}
      showNetOverlay({ title: "승리!", desc: "상대가 게임오버 되었습니다.", seconds: undefined, canClose: true, canRetry: true });
    }
    drawOpp(state);
  }});

  evUnsub?.();
  evUnsub = subscribeEvents({ api, eventsRef: refs.eventsRef, pid, onEvent: onEventRecv });

  // publish loop
  if(publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(()=>{
    if(!game || mode === "offline") return;
    publishMyState({ api, statesRef: refs.statesRef, pid, state: game.getNetState() }).catch(()=>{});
  }, 120);

  // hook combo -> attack & gameover -> result
  if(game){
    game.onComboEnd = (cnt)=>{
      if(mode === "offline" || !refs || !refs.eventsRef) return;
      const n = comboToRocks(cnt);
      if(n <= 0) return;
      pushEvent({ api, eventsRef: refs.eventsRef, event: { from: pid, kind: "rocks", payload: { n } } }).catch(()=>{});
    };
    game.onGameOver = ()=>{
      if(mode === "offline" || !refs || !refs.eventsRef) return;
      if(!resolved){
        resolved = true;
        showNetOverlay({ title: "패배", desc: "내 게임오버!", seconds: undefined, canClose: true, canRetry: true });
      }
      pushEvent({ api, eventsRef: refs.eventsRef, event: { from: pid, kind: "over", payload: { score: game?.score ?? 0 } } }).catch(()=>{});
    };
  }
}

function onRoomUpdate(room){
  if(mode === "offline") return;
  if(!room || !room.meta){
    setStatus("방 없음(오프라인)");
    return;
  }

  const meta = room.meta;
  const players = room.players || {};
  const ids = Object.keys(players);

  if(ids.length >= 2){
    setStatus("연결됨");
    mode = "online";
    try{ if(waitTimer) clearInterval(waitTimer); }catch{}
    waitTimer = null;
    hideNetOverlay();
  }else{
    setStatus("연결 대기…");
  }
  if(ui.oppTitle) ui.oppTitle.textContent = ids.length >= 2 ? "상대" : "상대 (연결 대기…)";

  if(ids.length === 2 && meta.state === "open"){
    setRoomState({ api, metaRef: refs.metaRef }, "playing").catch(()=>{});
  }
}

function onEventRecv({key, ev}){
  if(!ev) return;
  // ignore stale events from previous occupants
  if(joinedAt && ev.t && ev.t < joinedAt - 5000){
    try{ api.remove(api.child(refs.eventsRef, key)).catch(()=>{}); }catch{}
    return;
  }
  if(ev.kind === "rocks"){
    const n = Math.max(0, Math.min(12, (ev.payload && ev.payload.n) || 0));
    try{ game?.dropRocks?.(n); }catch{}
  }

  if(ev.kind === "over"){
    if(!resolved){
      resolved = true;
      try{ if(game) game.canDrop = false; }catch{}
      showNetOverlay({ title: "승리!", desc: "상대가 게임오버 되었습니다.", seconds: undefined, canClose: true, canRetry: true });
    }
  }

  // consume immediately to avoid leaving logs
  try{ api.remove(api.child(refs.eventsRef, key)).catch(()=>{}); }catch{}
}

async function bootOnline(){
  if(!game) return;
  if(mode !== "matching") return;

  try{
    fb = initFirebase();
    db = fb.db;
    api = fb.api;
  }catch(e){
    mode = "offline";
    setStatus("오프라인");
    showNetOverlay({ title: "연결 실패", desc: "Firebase 설정이 없거나 잘못되었습니다.", seconds: undefined, canClose: true, canRetry: true });
    return;
  }

  try{
    lobbyId = stableLobbyId();
    // sweep old rooms/slots periodically so signals don't linger
    try{ await sweepLobbySlots({db, api, lobbyId, maxTeams: 10}); }catch{}
    sweepTimer = setInterval(()=>{ try{ sweepLobbySlots({db, api, lobbyId, maxTeams:10}).catch(()=>{}); }catch{} }, 20000);

    setStatus("연결 중…");

    const joined = await joinLobby({ db, api, lobbyId, name: "Player", maxTeams: 10 });
    await enterRoom(joined);

    setStatus("연결 대기…");
  }catch(e){
    mode = "offline";
    setStatus("오프라인");
    showNetOverlay({ title: "연결 실패", desc: "온라인 연결에 실패했습니다. (Firebase 설정 또는 네트워크 확인)", seconds: undefined, canClose: true, canRetry: true });
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

  if(mode !== "offline" && db && api && roomId && refs){
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
  // 온라인은 "매칭" 버튼을 눌렀을 때만 시작
  setStatus("오프라인");
});

// In case event was dispatched before this module loaded
if(window.__shapeGame){
  game = window.__shapeGame;
  setStatus("오프라인");
}
