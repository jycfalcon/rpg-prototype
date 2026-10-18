const http      = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => { res.writeHead(200); res.end('RPG OK'); });
const wss    = new WebSocket.Server({ server });

// ── CONSTANTS (mirror client) ─────────────────────────────────────────────
const W=2400,H=2400;
const P_ATK=3, ATK_RANGE=80;
const S_HP=15,S_ATK=3,S_SPEED=105,S_R=14;
const G_HP=70,G_ATK=8,G_SPEED=62,G_R=26;
const K_HP=200,K_SPEED=48,K_R=40;
const K_NORMAL_ATK=6,K_LUNGE_ATK=14,K_EQ_ATK=20;
const K_NORMAL_ATK_RANGE=65,K_LUNGE_START_RANGE=200,K_EQ_TRIGGER_RANGE=220;
const K_EQ_RADIUS=175,K_EQ_WINDUP=2.2;
const K_NORMAL_ATK_CD=2.5,K_LUNGE_CD=8.0,K_EQ_CD=16.0;
const NORMAL_ATK_RANGE=55,NORMAL_ATK_CD=1.8;
const BOUNCE_SPEED=155,BOUNCE_DURATION=0.45,HOP_HEIGHT=26,BOUNCE_ABORT_DIST=85;
const LUNGE_START_RANGE=150,LUNGE_SKILL_CD=6.0;
const WINDUP_NORMAL=0.55,WINDUP_GIANT=0.75;
const LUNGE_SPEED=360,RECOVERY_DUR=0.38;
const AGGRO_RANGE=210,DEAGGRO_RANGE=380;
const ROAM_SPEED=0.38,ROAM_INT_MIN=5,ROAM_INT_MAX=10,ROAM_RADIUS=130;
const SPAWN_INTERVAL=20,MAX_SLIMES=20,SPAWN_BATCH_MIN=4;
const STUN_DURATION=5.0;

// ── STATE ─────────────────────────────────────────────────────────────────
let nextPlayerId=1, nextSlimeId=1;
const players = new Map(); // id → { ws, state }
let slimes=[], spawnT=10, totalSpawned=0, lastTick=Date.now();

// ── HELPERS ───────────────────────────────────────────────────────────────
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function alivePlayers(){
  const r=[];
  for(const[id,p]of players){if(p.state&&!p.state.dead)r.push({id,...p.state});}
  return r;
}
function nearestPlayer(x,y){
  let best=null,bestD=Infinity;
  for(const p of alivePlayers()){const d=Math.hypot(p.x-x,p.y-y);if(d<bestD){best=p;bestD=d;}}
  return{player:best,dist:bestD};
}

function mkSlime(isGiant,isKing,x,y){
  return{
    id:isKing?'king':String(nextSlimeId++),
    x,y,
    r:isKing?K_R:isGiant?G_R:S_R,
    hp:isKing?K_HP:isGiant?G_HP:S_HP,
    maxHp:isKing?K_HP:isGiant?G_HP:S_HP,
    atk:isKing?K_NORMAL_ATK:isGiant?G_ATK:S_ATK,
    speed:isKing?K_SPEED:isGiant?G_SPEED:S_SPEED,
    isGiant,isKing,
    bodyCol:isKing?'#1a0038':isGiant?'#922b21':'#27ae60',
    shineCol:isKing?'#7b00d4':isGiant?'#e74c3c':'#5bff8a',
    alive:true,kbx:0,kby:0,flash:0,animT:Math.random()*Math.PI*2,
    state:isKing?'roam':'roam',roamTarget:null,roamTimer:Math.random()*3,
    atkPhase:'idle',atkPhaseTimer:0,
    normalAtkCd:isKing?2.0:0.5+Math.random()*1.5,
    lungeSkillCd:isKing?4+Math.random()*2:3+Math.random()*3,
    earthquakeCd:isKing?5+Math.random()*3:0,
    earthquakeRadius:isKing?K_EQ_RADIUS:0,
    bounceTargetX:0,bounceTargetY:0,hasHit:false,hopArc:0,
    lungeLockedAngle:0,lungeStartX:0,lungeStartY:0,lungeVelX:0,lungeVelY:0,
  };
}

function doSpawnSlime(){
  totalSpawned++;
  const isGiant=totalSpawned%10===0;
  const alive=alivePlayers();
  let x,y,t=0;
  do{x=40+Math.random()*(W-80);y=40+Math.random()*(H-80);t++;}
  while(alive.some(p=>Math.hypot(x-p.x,y-p.y)<260)&&t<20);
  slimes.push(mkSlime(isGiant,false,x,y));
  if(isGiant) broadcastAll({type:'float',x,y,text:'⚠ GIANT',color:'#e74c3c',size:14});
}
function doSpawnKing(){
  const a=Math.random()*Math.PI*2,d=450+Math.random()*150;
  const x=clamp(W/2+Math.cos(a)*d,K_R+20,W-K_R-20);
  const y=clamp(H/2+Math.sin(a)*d,K_R+20,H-K_R-20);
  slimes.push(mkSlime(false,true,x,y));
  broadcastAll({type:'float',x,y,text:'⚠ SLIME KING',color:'#a855f7',size:16});
}

// ── GAME LOOP ──────────────────────────────────────────────────────────────
function tick(){
  try{
  const now=Date.now();
  const dt=Math.min((now-lastTick)/1000,0.05);
  lastTick=now;
  if(players.size===0) return;

  // Spawning
  spawnT-=dt;
  if(spawnT<=0){
    spawnT=SPAWN_INTERVAL;
    const alive=slimes.filter(s=>s.alive&&!s.isKing).length;
    const n=Math.min(MAX_SLIMES-alive,SPAWN_BATCH_MIN+Math.floor(Math.random()*2));
    for(let i=0;i<n;i++) doSpawnSlime();
  }

  // Slime AI
  for(const s of slimes){
    if(!s.alive) continue;
    s.animT+=dt; s.flash=Math.max(0,s.flash-dt);
    s.kbx*=Math.pow(0.01,dt); s.kby*=Math.pow(0.01,dt);
    const{player:near,dist:distP}=nearestPlayer(s.x,s.y);

    if(s.state==='roam'){
      const aggroR=s.isKing?260:AGGRO_RANGE;
      if(near&&distP<aggroR){
        s.state='aggro';
        broadcastAll({type:'slime_aggro',slimeId:s.id,isKing:s.isKing});
      } else {
        s.roamTimer-=dt;
        if(s.roamTimer<=0||!s.roamTarget){
          const a=Math.random()*Math.PI*2,d=40+Math.random()*ROAM_RADIUS;
          s.roamTarget={x:clamp(s.x+Math.cos(a)*d,s.r+10,W-s.r-10),y:clamp(s.y+Math.sin(a)*d,s.r+10,H-s.r-10)};
          s.roamTimer=ROAM_INT_MIN+Math.random()*(ROAM_INT_MAX-ROAM_INT_MIN);
        }
        const rx=s.roamTarget.x-s.x,ry=s.roamTarget.y-s.y,rd=Math.hypot(rx,ry);
        if(rd>12){s.x+=(rx/rd)*s.speed*ROAM_SPEED*dt;s.y+=(ry/rd)*s.speed*ROAM_SPEED*dt;}
      }
    } else {
      if(!s.isKing&&distP>DEAGGRO_RANGE){s.state='roam';s.roamTimer=0;s.roamTarget=null;s.atkPhase='idle';}
      else if(near){
        if(s.normalAtkCd>0) s.normalAtkCd-=dt;
        if(s.lungeSkillCd>0) s.lungeSkillCd-=dt;
        if(s.earthquakeCd>0) s.earthquakeCd-=dt;
        const nRange=s.isKing?K_NORMAL_ATK_RANGE:NORMAL_ATK_RANGE;
        const lRange=s.isKing?K_LUNGE_START_RANGE:LUNGE_START_RANGE;
        const wDur=s.isKing||s.isGiant?WINDUP_GIANT:WINDUP_NORMAL;
        const nCd=s.isKing?K_NORMAL_ATK_CD:NORMAL_ATK_CD;
        const lCd=s.isKing?K_LUNGE_CD:LUNGE_SKILL_CD;

        if(s.atkPhase==='idle'){
          if(distP>s.r+14){const cx=near.x-s.x,cy=near.y-s.y,cd=Math.hypot(cx,cy);s.x+=(cx/cd)*s.speed*dt;s.y+=(cy/cd)*s.speed*dt;}
          if(s.isKing&&s.earthquakeCd<=0&&distP<=K_EQ_TRIGGER_RANGE){
            s.atkPhase='earthquake_windup';s.atkPhaseTimer=K_EQ_WINDUP;s.earthquakeCd=K_EQ_CD;s.hasHit=false;
          } else if(s.lungeSkillCd<=0&&distP<=lRange){
            s.atkPhase='lunge_windup';s.atkPhaseTimer=wDur;s.lungeSkillCd=lCd;s.hasHit=false;
            s.lungeLockedAngle=Math.atan2(near.y-s.y,near.x-s.x);
          } else if(s.normalAtkCd<=0&&distP<=nRange){
            s.atkPhase='normal_bounce';s.atkPhaseTimer=BOUNCE_DURATION;
            s.bounceTargetX=near.x;s.bounceTargetY=near.y;s.normalAtkCd=nCd;s.hasHit=false;
          }
        }
        else if(s.atkPhase==='normal_bounce'){
          s.atkPhaseTimer-=dt;
          const prog=1-s.atkPhaseTimer/BOUNCE_DURATION;
          s.hopArc=-Math.sin(prog*Math.PI)*HOP_HEIGHT;
          const lx=s.bounceTargetX-s.x,ly=s.bounceTargetY-s.y,ld=Math.hypot(lx,ly);
          if(ld>6){s.x=clamp(s.x+(lx/ld)*BOUNCE_SPEED*dt,s.r,W-s.r);s.y=clamp(s.y+(ly/ld)*BOUNCE_SPEED*dt,s.r,H-s.r);}
          if(!s.hasHit){
            for(const p of alivePlayers()){
              if(Math.hypot(p.x-s.x,p.y-s.y)<=s.r+16){
                s.hasHit=true;s.flash=0.15;
                const dmg=s.isKing?K_NORMAL_ATK:s.atk;
                sendToPlayer(p.id,{type:'player_hit',slimeId:s.id,amount:dmg,stun:false});
                s.atkPhase='recovery';s.atkPhaseTimer=RECOVERY_DUR;s.hopArc=0;break;
              }
            }
            if(!s.hasHit&&near&&Math.hypot(near.x-s.bounceTargetX,near.y-s.bounceTargetY)>BOUNCE_ABORT_DIST){
              s.atkPhase='idle';s.normalAtkCd=0.6;s.hopArc=0;
            }
          }
          if(s.atkPhaseTimer<=0){s.atkPhase='recovery';s.atkPhaseTimer=RECOVERY_DUR;s.hopArc=0;}
        }
        else if(s.atkPhase==='lunge_windup'){
          s.atkPhaseTimer-=dt;
          if(distP>s.r+10){const cx=near.x-s.x,cy=near.y-s.y,cd=Math.hypot(cx,cy);s.x+=(cx/cd)*s.speed*0.12*dt;s.y+=(cy/cd)*s.speed*0.12*dt;}
          if(s.atkPhaseTimer<=0){
            const pLen=s.isKing?300:230;
            s.atkPhase='lunge';s.atkPhaseTimer=pLen/LUNGE_SPEED+0.08;
            s.lungeStartX=s.x;s.lungeStartY=s.y;
            s.lungeVelX=Math.cos(s.lungeLockedAngle)*LUNGE_SPEED;
            s.lungeVelY=Math.sin(s.lungeLockedAngle)*LUNGE_SPEED;
            s.hasHit=false;
          }
        }
        else if(s.atkPhase==='lunge'){
          s.atkPhaseTimer-=dt;
          const pLen=s.isKing?300:230;
          const traveled=Math.hypot(s.x-s.lungeStartX,s.y-s.lungeStartY);
          if(traveled<pLen){s.x=clamp(s.x+s.lungeVelX*dt,s.r,W-s.r);s.y=clamp(s.y+s.lungeVelY*dt,s.r,H-s.r);}
          if(!s.hasHit){
            for(const p of alivePlayers()){
              if(Math.hypot(p.x-s.x,p.y-s.y)<=s.r+18){
                s.hasHit=true;
                sendToPlayer(p.id,{type:'player_hit',slimeId:s.id,amount:s.isKing?K_LUNGE_ATK:s.atk,stun:false});
                break;
              }
            }
          }
          if(traveled>=pLen||s.atkPhaseTimer<=0){
            s.lungeVelX=0;s.lungeVelY=0;
            s.atkPhase='recovery';s.atkPhaseTimer=RECOVERY_DUR*(s.isKing?1.5:1);
          }
        }
        else if(s.atkPhase==='earthquake_windup'){
          s.atkPhaseTimer-=dt;
          if(s.atkPhaseTimer<=0){
            broadcastAll({type:'earthquake_hit',slimeId:s.id,x:s.x,y:s.y,radius:s.earthquakeRadius});
            for(const p of alivePlayers()){
              if(Math.hypot(p.x-s.x,p.y-s.y)<=s.earthquakeRadius){
                sendToPlayer(p.id,{type:'player_hit',slimeId:s.id,amount:K_EQ_ATK,stun:STUN_DURATION});
              }
            }
            s.lungeSkillCd=0;
            s.atkPhase='recovery';s.atkPhaseTimer=0.5;
          }
        }
        else if(s.atkPhase==='recovery'){
          s.atkPhaseTimer-=dt;if(s.atkPhaseTimer<=0)s.atkPhase='idle';
        }
      }
    }
    s.x=clamp(s.x+s.kbx*dt,s.r,W-s.r);s.y=clamp(s.y+s.kby*dt,s.r,H-s.r);
  }

  slimes=slimes.filter(s=>s.alive);

  // Broadcast world state
  broadcastAll({
    type:'world',
    slimes:slimes.map(s=>({
      id:s.id,x:s.x,y:s.y,r:s.r,hp:s.hp,maxHp:s.maxHp,
      isGiant:s.isGiant,isKing:s.isKing,bodyCol:s.bodyCol,shineCol:s.shineCol,
      flash:s.flash,animT:s.animT,state:s.state,
      atkPhase:s.atkPhase,atkPhaseTimer:s.atkPhaseTimer,
      hopArc:s.hopArc,lungeLockedAngle:s.lungeLockedAngle,
      earthquakeRadius:s.earthquakeRadius,
    }))
  });
}

  }catch(e){ console.error('[tick error]', e.message); }
}

setInterval(tick, 1000/20);

// ── CONNECTIONS ───────────────────────────────────────────────────────────
wss.on('connection', ws=>{
  const id=String(nextPlayerId++);
  players.set(id,{ws,state:{x:W/2,y:H/2,hp:50,dead:false,facing:'down',rolling:false,atkTimer:0,atkAngle:0,stunned:false}});
  console.log(`[+] Player ${id} — total: ${players.size}`);

  const existing=[];
  for(const[pid,p]of players){if(pid!==id&&p.state)existing.push({...p.state,id:pid});}
  send(ws,{type:'welcome',id,others:existing,slimes});
  broadcast({type:'join',id},id);

  ws.on('message',raw=>{
    try{
      const msg=JSON.parse(raw);
      if(msg.type==='state'){
        const state={...msg,id};
        players.get(id).state=state;
        broadcast({type:'state',player:state},id);
      }
      if(msg.type==='attack'){
        const p=players.get(id);if(!p?.state)return;
        const s=slimes.find(s=>s.alive&&s.id===msg.slimeId);if(!s)return;
        const dist=Math.hypot(p.state.x-s.x,p.state.y-s.y);
        if(dist>ATK_RANGE+s.r+25)return; // +25 latency tolerance
        s.hp-=P_ATK;s.flash=0.15;
        const ang=Math.atan2(s.y-p.state.y,s.x-p.state.x);
        const kb=s.isKing?18:80;s.kbx=Math.cos(ang)*kb;s.kby=Math.sin(ang)*kb;
        s.state='aggro';
        broadcastAll({type:'slime_hit',slimeId:s.id,x:s.x,y:s.y,hp:s.hp,maxHp:s.maxHp});
        if(s.hp<=0){
          s.alive=false;
          broadcastAll({type:'slime_killed',slimeId:s.id,isKing:s.isKing,isGiant:s.isGiant,x:s.x,y:s.y});
        }
      }
      if(msg.type==='respawn'){
        if(players.get(id))players.get(id).state={x:W/2,y:H/2,hp:50,dead:false,facing:'down',rolling:false,atkTimer:0,atkAngle:0,stunned:false};
      }
    }catch(_){}
  });

  ws.on('close',()=>{
    players.delete(id);
    console.log(`[-] Player ${id} — total: ${players.size}`);
    broadcast({type:'leave',id});
  });
  ws.on('error',()=>{});
});

function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}
function broadcast(msg,excludeId){const d=JSON.stringify(msg);for(const[id,p]of players){if(id!==excludeId&&p.ws.readyState===WebSocket.OPEN)p.ws.send(d);}}
function broadcastAll(msg){const d=JSON.stringify(msg);for(const[,p]of players){if(p.ws.readyState===WebSocket.OPEN)p.ws.send(d);}}
function sendToPlayer(pid,msg){const p=players.get(pid);if(p?.ws.readyState===WebSocket.OPEN)p.ws.send(JSON.stringify(msg));}

// Initial spawn
for(let i=0;i<4;i++) doSpawnSlime();
doSpawnKing();

// Prevent crashes from killing the server
process.on('uncaughtException', e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

server.listen(PORT,()=>console.log(`Server on port ${PORT}`));
