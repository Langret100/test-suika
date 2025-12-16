import { initFirebase } from "./firebase.js";
import { createAudio } from "./audio.js";
import { initMatchButton } from "./match.js";
import { MergeGame, drawOpponent } from "./mergegame.js";
import { CpuController } from "./cpu.js";
import { fitCanvases } from "./touch.js";
import {
  joinLobby, watchRoom, roomRefs,
  publishMyState, subscribeOppState,
  pushEvent, subscribeEvents
} from "./netplay.js";

const $ = (id)=>document.getElementById(id);

const ui = {
  cvMe: $("cvMe"),
  cvOpp: $("cvOpp"),
  cvNext: $("cvNext"),
  score: $("score"),
  level: $("level"),
  mode: $("mode"),
  oppTag: $("oppTag"),
  comboNum: $("comboNum"),
  btnStartCpu: $("btnStartCpu"),
  btnRestart: $("btnRestart"),
  btnSound: $("btnSound"),
  btnMatch: $("btnMatch"),
  btnFull: $("btnFull"),
  overlay: $("overlay"),
  overlayTitle: $("overlayTitle"),
  overlayDesc: $("overlayDesc"),
};

function safeSetText(el, txt){ if(el) el.textContent = String(txt); }

function showOverlay(title, desc, {showCpuBtn=false}={}){
  if(ui.overlay) ui.overlay.classList.remove("hidden");
  safeSetText(ui.overlayTitle, title || "");
  safeSetText(ui.overlayDesc, desc || "");
  if(ui.btnStartCpu) ui.btnStartCpu.style.display = showCpuBtn ? "inline-flex" : "none";
}
function hideOverlay(){ if(ui.overlay) ui.overlay.classList.add("hidden"); }

// --- Audio
const audio = createAudio({ musicUrl: "./assets/arcade-music.mp3" });
function syncSoundIcon(){
  if(!ui.btnSound) return;
  ui.btnSound.textContent = audio.muted ? "🔇" : "🔊";
}
ui.btnSound?.addEventListener("click", ()=>{
  try{ audio.toggle(); }catch{}
  syncSoundIcon();
});
syncSoundIcon();

// match button (reload)
initMatchButton({ buttonEl: ui.btnMatch, audio });

// fullscreen
ui.btnFull?.addEventListener("click", ()=>{
  const el = document.documentElement;
  try{
    if(!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }catch{}
});

// --- game instances
let meGame = null;
let cpuGame = null;
let cpuCtl = null;

let mode = "init"; // online | cpu
let raf = 0;

// --- online state
let db=null, api=null;
let roomId="", pid="";
let metaRef=null, playersRef=null, statesRef=null, eventsRef=null;
let roomUnsub=null, oppUnsub=null, evUnsub=null;

let oppObjects = null;

// --- sizing
const PLAY_ROWS = 23;
function fit(){
  fitCanvases(ui.cvMe, ui.cvOpp, ui.cvNext, PLAY_ROWS);
  meGame?.resizeToCanvas?.();
  cpuGame?.resizeToCanvas?.();
}
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", fit);
fit();

// --- input (watermelon-like)
let dragging = false;

function canvasToWorldX(ev){
  const rect = ui.cvMe.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (ui.cvMe.width / rect.width);
  return x;
}

function attachInput(game){
  if(!ui.cvMe || !game) return;

  ui.cvMe.addEventListener("pointerdown", (ev)=>{
    dragging = true;
    ui.cvMe.setPointerCapture?.(ev.pointerId);
    try{ audio.gestureStart?.(); }catch{}
    game.dropX = canvasToWorldX(ev);
  });

  ui.cvMe.addEventListener("pointermove", (ev)=>{
    if(!dragging) return;
    game.dropX = canvasToWorldX(ev);
  });

  const end = (ev)=>{
    if(!dragging) return;
    dragging = false;
    try{ ui.cvMe.releasePointerCapture?.(ev.pointerId); }catch{}
    game.dropX = canvasToWorldX(ev);
    game.drop();
  };
  ui.cvMe.addEventListener("pointerup", end);
  ui.cvMe.addEventListener("pointercancel", ()=>{ dragging=false; });

  document.addEventListener("keydown", (e)=>{
    if(mode==="init") return;
    if(e.repeat) return;
    if(e.code==="Space"){ e.preventDefault(); game.drop(); return; }
    if(e.code==="ArrowLeft"){ game.dropX = Math.max(0, game.dropX - (game.width*0.06)); return; }
    if(e.code==="ArrowRight"){ game.dropX = Math.min(game.width, game.dropX + (game.width*0.06)); return; }
  });
}

function startLoop(){
  cancelAnimationFrame(raf);
  let last = performance.now();
  let sendAcc = 0;

  const ctxNext = ui.cvNext?.getContext("2d");
  const ctxOpp = ui.cvOpp?.getContext("2d");

  const frame = (ts)=>{
    const dt = ts - last; last = ts;

    meGame?.tick?.(dt);
    meGame?.draw?.();

    // next preview
    if(ctxNext && meGame){
      ctxNext.clearRect(0,0,ctxNext.canvas.width, ctxNext.canvas.height);
      meGame.drawNext(ctxNext);
    }

    // opponent view
    if(ctxOpp){
      if(mode==="cpu" && cpuGame){
        // show CPU as opponent
        drawOpponent(ctxOpp, cpuGame.packState().objects);
      }else{
        drawOpponent(ctxOpp, oppObjects || []);
      }
    }

    // HUD
    if(meGame){
      safeSetText(ui.score, meGame.score|0);
      safeSetText(ui.level, meGame.level|0);
      safeSetText(ui.comboNum, (meGame._comboCount|0) || 0);
    }

    // online: publish state
    if(mode==="online" && api && statesRef && pid && meGame){
      sendAcc += dt;
      if(sendAcc >= 120){
        sendAcc = 0;
        publishMyState({ api, statesRef, pid, state: meGame.packState() }).catch(()=>{});
      }
    }

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

function stopOnlineSubs(){
  try{ roomUnsub?.(); }catch{}
  try{ oppUnsub?.(); }catch{}
  try{ evUnsub?.(); }catch{}
  roomUnsub = oppUnsub = evUnsub = null;
}

function startCpuMode(reason=""){
  stopOnlineSubs();
  mode = "cpu";
  safeSetText(ui.mode, "PC");
  safeSetText(ui.oppTag, "CPU");

  meGame = new MergeGame({
    canvas: ui.cvMe,
    seed: ((Math.random()*2**32)>>>0),
    onAttack: (n)=>{
      // CPU receives rocks
      cpuGame?.applyRocks?.(n|0);
    }
  });
  cpuGame = new MergeGame({
    canvas: document.createElement("canvas"),
    seed: ((Math.random()*2**32)>>>0),
    onAttack: (n)=>{
      // player receives rocks
      meGame?.applyRocks?.(n|0);
    }
  });
  // make cpu canvas same size for rendering
  cpuGame.cv.width = ui.cvOpp.width;
  cpuGame.cv.height = ui.cvOpp.height;
  cpuGame.resizeToCanvas();

  cpuCtl = new CpuController(cpuGame);
  cpuGame.tick = (dt)=>{
    cpuCtl.update(dt);
    MergeGame.prototype.tick.call(cpuGame, dt);
  };

  attachInput(meGame);
  hideOverlay();
  fit();
  startLoop();
}

function startOnlineMode({seed}){
  mode = "online";
  safeSetText(ui.mode, "온라인");
  safeSetText(ui.oppTag, "Player");

  meGame = new MergeGame({
    canvas: ui.cvMe,
    seed: (seed>>>0) || 1,
    onAttack: async (n)=>{
      if(!api || !eventsRef || !pid) return;
      const count = n|0;
      if(count < 3) return;
      await pushEvent({ api, eventsRef, event: { from: pid, kind: "rocks", n: count } }).catch(()=>{});
      // local sfx
      try{ audio.sfx?.("attackSend"); }catch{}
    }
  });

  attachInput(meGame);
  hideOverlay();
  fit();
  startLoop();
}

async function bootOnline(){
  try{
    const fb = initFirebase();
    db = fb.db; api = fb.api;
  }catch(e){
    showOverlay("Firebase 초기화 실패", "firebase-config.js 설정(키) 확인 후 다시 시도하세요. PC 대전으로 시작할 수 있음.", {showCpuBtn:true});
    ui.btnStartCpu.onclick = ()=>startCpuMode("firebase fail");
    return;
  }

  // lobby id from URL hash; if none, use default "public"
  let lobbyId = (location.hash || "").replace("#","").trim();
  if(!lobbyId) lobbyId = "public";

  showOverlay("온라인 연결 중…", "상대를 찾고 있어요. (안 되면 PC 대전으로 시작)", {showCpuBtn:true});
  ui.btnStartCpu.onclick = ()=>startCpuMode("manual");

  const j = await joinLobby({ db, api, lobbyId, name: "Player" });
  roomId = j.roomId; pid = j.pid;

  const refs = roomRefs({ db, api, roomId });
  metaRef = refs.metaRef; playersRef = refs.playersRef; statesRef = refs.statesRef; eventsRef = refs.eventsRef;

  // watch room: update opponent label
  roomUnsub = watchRoom({ db, api, roomId, onRoom: (room)=>{
    if(!room || !room.players) return;
    const opp = Object.entries(room.players).find(([k])=>k!==pid);
    if(opp){
      const name = opp[1]?.name || "Player";
      safeSetText(ui.oppTag, name);
    }
  }});

  // opponent state
  oppUnsub = subscribeOppState({ api, statesRef, pid, onOpp: ({state})=>{
    oppObjects = state?.objects || [];
  }});

  // events
  evUnsub = subscribeEvents({ api, eventsRef, pid, onEvent: async ({key, ev})=>{
    if(!ev) return;
    if(ev.kind === "rocks"){
      const n = ev.n|0;
      meGame?.applyRocks?.(n);
      try{ audio.sfx?.("attackHit"); }catch{}
    }
    // delete processed event to avoid replay
    try{ await api.remove(api.child(eventsRef, key)); }catch{}
  }});

  startOnlineMode({ seed: j.seed });
}

// restart button
ui.btnRestart?.addEventListener("click", ()=>{
  location.reload();
});

bootOnline();
