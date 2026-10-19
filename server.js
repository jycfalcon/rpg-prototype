const http      = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RPG Server OK');
});
const wss = new WebSocket.Server({ server });

// ── CONSTANTS ─────────────────────────────────────────────────────────────
// Map sizes
const W = 2400, H = 2400;             // slime map
const TOWN_W = 1200, TOWN_H = 1200;   // town

// Spawn / portal coordinates
const TOWN_SPAWN_X  = 600,  TOWN_SPAWN_Y  = 500;  // player enters town here
const SLIME_ENTRY_X = 1200, SLIME_ENTRY_Y = 250;  // player enters slime map here
const RETURN_PORTAL_X = 1200, RETURN_PORTAL_Y = 200; // return portal in slime map

// NPC positions in town (server validates proximity for heal)
const TOWN_HEALER_X = 600, TOWN_HEALER_Y = 300;

// Game constants
const P_ATK = 3, ATK_RANGE = 50;
const S_HP=60,   S_ATK=5,  S_SPEED=105, S_R=14,  S_DEF=8,  S_MDEF=4;
const G_HP=350,  G_ATK=18, G_SPEED=62,  G_R=26,  G_DEF=30, G_MDEF=15;
const K_HP=3000, K_SPEED=48, K_R=40,               K_DEF=80, K_MDEF=50;
const K_NORMAL_ATK=10, K_LUNGE_ATK=25, K_EQ_ATK=25;
const K_NORMAL_ATK_RANGE=65, K_LUNGE_START_RANGE=200, K_EQ_TRIGGER_RANGE=220;
const K_EQ_RADIUS=240, K_EQ_WINDUP=2.2;
const K_NORMAL_ATK_CD=2.5, K_LUNGE_CD=8.0, K_EQ_CD=16.0;
const NORMAL_ATK_RANGE=55, NORMAL_ATK_CD=1.8;
const BOUNCE_SPEED=155, BOUNCE_DURATION=0.45, HOP_HEIGHT=26, BOUNCE_ABORT_DIST=85;
const LUNGE_START_RANGE=150, LUNGE_SKILL_CD=6.0, LUNGE_DURATION=0.32;
const WINDUP_NORMAL=0.55, WINDUP_GIANT=0.75;
const LUNGE_SPEED=360, RECOVERY_DUR=0.38;
const AGGRO_RANGE=210, DEAGGRO_RANGE=380;
const ROAM_SPEED=0.38, ROAM_INT_MIN=5, ROAM_INT_MAX=10, ROAM_RADIUS=130;
const SPAWN_INTERVAL=20, MAX_SLIMES=20, SPAWN_BATCH_MIN=4;
const STUN_DURATION=5.0;
const NPC_INTERACT_RANGE=65;

// XP awards per kill
const MOB_XP = { normal: 10, giant: 50, king: 500 };
// XP needed to reach next level: 100 + (level-1) * 50
function xpToNext(level) { return 100 + (level - 1) * 50; }

// ── STATE ─────────────────────────────────────────────────────────────────
const players  = new Map();
let   slimes   = [];
let   nextPid  = 1, nextSid = 1;
let   spawnT   = 10, totalSpawned = 0;
let   lastTick = Date.now();

// ── HELPERS ───────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// mapId is optional — if provided, only returns players on that map
function alivePlayers(mapId) {
  const out = [];
  for (const [id, p] of players) {
    if (!p.state || p.state.dead) continue;
    if (mapId && p.currentMap !== mapId) continue;
    out.push({ id, ...p.state });
  }
  return out;
}

function nearestPlayer(x, y, mapId) {
  let best = null, bestD = Infinity;
  for (const [id, p] of players) {
    if (!p.state || p.state.dead) continue;
    if (mapId && p.currentMap !== mapId) continue;
    const d = Math.hypot(p.state.x - x, p.state.y - y);
    if (d < bestD) { best = { id, ...p.state }; bestD = d; }
  }
  return { player: best, dist: bestD };
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg, excludeId) {
  const d = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(d);
  }
}
function broadcastAll(msg) {
  const d = JSON.stringify(msg);
  for (const [, p] of players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(d);
  }
}
function broadcastToMap(msg, mapId) {
  const d = JSON.stringify(msg);
  for (const [, p] of players) {
    if (p.currentMap === mapId && p.ws.readyState === WebSocket.OPEN) p.ws.send(d);
  }
}
function sendToPlayer(pid, msg) {
  const p = players.get(pid);
  if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
}

// ── DAMAGE FORMULAS ───────────────────────────────────────────────────────
// physical_dmg = ATK × 100 / (100 + target_DEF)  — minimum 1
// magic_dmg    = MATK × 100 / (100 + target_MDEF) — minimum 1
function physDmg(atk, targetDef)  { return Math.max(1, Math.floor(atk  * 100 / (100 + (targetDef  || 0)))); }
function magicDmg(matk, targetMdef){ return Math.max(1, Math.floor(matk * 100 / (100 + (targetMdef || 0)))); }

// ── XP + LEVELLING ────────────────────────────────────────────────────────
function awardXP(pid, amount) {
  const p = players.get(pid);
  if (!p || !p.state || p.currentMap !== 'slime_map') return;
  p.state.xp += amount;
  let leveledUp = false;
  while (p.state.xp >= p.state.xpToNext) {
    p.state.xp      -= p.state.xpToNext;
    p.state.level   += 1;
    p.state.xpToNext = xpToNext(p.state.level);
    p.state.statPoints  += 3;
    p.state.skillPoints += 1;
    leveledUp = true;
  }
  send(p.ws, {
    type: 'xp_update',
    xp: p.state.xp, level: p.state.level,
    xpToNext: p.state.xpToNext,
    statPoints:  p.state.statPoints,
    skillPoints: p.state.skillPoints,
    leveledUp,
  });
}

// ── CHARACTER STATS ───────────────────────────────────────────────────────
// Formula: base_hp = 20 + (level-1)*5, max_hp = floor(base * (1 + vit * 0.1))
// For now the client sends computed maxHp — server trusts it for prototype
// Full server-side computation with Supabase verification comes next session

function defaultMaxHp(charClass) {
  // Level 1 starting values based on class starting VIT
  const vit = { warrior: 6, archer: 1, mage: 3 }[charClass] || 4;
  return Math.floor(20 * (1 + vit * 0.1));
}

// ── SPAWN ─────────────────────────────────────────────────────────────────
function mkSlime(isGiant, isKing, x, y) {
  return {
    id: isKing ? 'king' : String(nextSid++),
    x, y,
    r:     isKing ? K_R     : isGiant ? G_R     : S_R,
    hp:    isKing ? K_HP    : isGiant ? G_HP    : S_HP,
    maxHp: isKing ? K_HP    : isGiant ? G_HP    : S_HP,
    atk:   isKing ? K_NORMAL_ATK : isGiant ? G_ATK : S_ATK,
    def:   isKing ? K_DEF  : isGiant ? G_DEF  : S_DEF,
    mdef:  isKing ? K_MDEF : isGiant ? G_MDEF : S_MDEF,
    speed: isKing ? K_SPEED : isGiant ? G_SPEED : S_SPEED,
    isGiant, isKing,
    bodyCol:  isKing ? '#1a0038' : isGiant ? '#922b21' : '#27ae60',
    shineCol: isKing ? '#7b00d4' : isGiant ? '#e74c3c' : '#5bff8a',
    alive: true, kbx: 0, kby: 0, flash: 0,
    animT: Math.random() * Math.PI * 2,
    state: 'roam', roamTarget: null, roamTimer: Math.random() * 3,
    atkPhase: 'idle', atkPhaseTimer: 0,
    normalAtkCd:  isKing ? 2.0 : 0.5 + Math.random() * 1.5,
    lungeSkillCd: isKing ? 4 + Math.random() * 2 : 3 + Math.random() * 3,
    earthquakeCd: isKing ? 5 + Math.random() * 3 : 0,
    earthquakeRadius: isKing ? K_EQ_RADIUS : 0,
    bounceTargetX: 0, bounceTargetY: 0,
    hasHit: false, hopArc: 0,
    lungeLockedAngle: 0, lungeStartX: 0, lungeStartY: 0,
    lungeVelX: 0, lungeVelY: 0,
  };
}

function doSpawnSlime() {
  totalSpawned++;
  const isGiant = totalSpawned % 10 === 0;
  const alive = alivePlayers('slime_map');
  let x, y, t = 0;
  do {
    x = 40 + Math.random() * (W - 80);
    y = 40 + Math.random() * (H - 80);
    t++;
  } while (alive.some(p => Math.hypot(x - p.x, y - p.y) < 260) && t < 20);
  slimes.push(mkSlime(isGiant, false, x, y));
  if (isGiant) broadcastToMap({ type: 'float', x, y, text: '⚠ GIANT', color: '#e74c3c', size: 14 }, 'slime_map');
}

function doSpawnKing() {
  const a = Math.random() * Math.PI * 2;
  const d = 450 + Math.random() * 150;
  const x = clamp(W / 2 + Math.cos(a) * d, K_R + 20, W - K_R - 20);
  const y = clamp(H / 2 + Math.sin(a) * d, K_R + 20, H - K_R - 20);
  slimes.push(mkSlime(false, true, x, y));
  broadcastToMap({ type: 'float', x, y, text: '⚠ SLIME KING', color: '#a855f7', size: 16 }, 'slime_map');
}

// ── GAME LOOP ─────────────────────────────────────────────────────────────
function tick() {
  const now = Date.now();
  const dt  = Math.min((now - lastTick) / 1000, 0.05);
  lastTick  = now;

  // Spawn timer always ticks — world is ready when players arrive
  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = SPAWN_INTERVAL;
    const aliveCount = slimes.filter(s => s.alive && !s.isKing).length;
    const n = Math.min(MAX_SLIMES - aliveCount, SPAWN_BATCH_MIN + Math.floor(Math.random() * 2));
    for (let i = 0; i < n; i++) doSpawnSlime();
  }

  if (players.size === 0) return;

  // Slime AI only runs when players are on slime_map
  const slimeMapPlayers = [...players.values()].filter(p => p.currentMap === 'slime_map' && p.state && !p.state.dead);

  if (slimeMapPlayers.length > 0) {
    for (const s of slimes) {
      if (!s.alive) continue;
      s.animT += dt;
      s.flash  = Math.max(0, s.flash - dt);
      s.kbx   *= Math.pow(0.01, dt);
      s.kby   *= Math.pow(0.01, dt);

      const { player: near, dist: distP } = nearestPlayer(s.x, s.y, 'slime_map');

      if (s.state === 'roam') {
        const aggroR = s.isKing ? 260 : AGGRO_RANGE;
        if (near && distP < aggroR) {
          s.state = 'aggro';
          broadcastToMap({ type: 'slime_aggro', slimeId: s.id, isKing: s.isKing }, 'slime_map');
        } else {
          s.roamTimer -= dt;
          if (s.roamTimer <= 0 || !s.roamTarget) {
            const ra = Math.random() * Math.PI * 2;
            const rd = 40 + Math.random() * ROAM_RADIUS;
            s.roamTarget = {
              x: clamp(s.x + Math.cos(ra) * rd, s.r + 10, W - s.r - 10),
              y: clamp(s.y + Math.sin(ra) * rd, s.r + 10, H - s.r - 10),
            };
            s.roamTimer = ROAM_INT_MIN + Math.random() * (ROAM_INT_MAX - ROAM_INT_MIN);
          }
          const rx = s.roamTarget.x - s.x, ry = s.roamTarget.y - s.y;
          const rd2 = Math.hypot(rx, ry);
          if (rd2 > 12) {
            s.x += (rx / rd2) * s.speed * ROAM_SPEED * dt;
            s.y += (ry / rd2) * s.speed * ROAM_SPEED * dt;
          }
        }
      } else { // aggro
        if (!s.isKing && distP > DEAGGRO_RANGE) {
          s.state = 'roam'; s.roamTimer = 0; s.roamTarget = null; s.atkPhase = 'idle';
        } else if (near) {
          if (s.normalAtkCd  > 0) s.normalAtkCd  -= dt;
          if (s.lungeSkillCd > 0) s.lungeSkillCd -= dt;
          if (s.earthquakeCd > 0) s.earthquakeCd -= dt;

          const nRange = s.isKing ? K_NORMAL_ATK_RANGE : NORMAL_ATK_RANGE;
          const lRange = s.isKing ? K_LUNGE_START_RANGE : LUNGE_START_RANGE;
          const wDur   = (s.isKing || s.isGiant) ? WINDUP_GIANT : WINDUP_NORMAL;
          const nCd    = s.isKing ? K_NORMAL_ATK_CD : NORMAL_ATK_CD;
          const lCd    = s.isKing ? K_LUNGE_CD : LUNGE_SKILL_CD;

          if (s.atkPhase === 'idle') {
            if (distP > s.r + 14) {
              const cx = near.x - s.x, cy = near.y - s.y, cd = Math.hypot(cx, cy);
              s.x += (cx / cd) * s.speed * dt;
              s.y += (cy / cd) * s.speed * dt;
            }
            if (s.isKing && s.earthquakeCd <= 0 && distP <= K_EQ_TRIGGER_RANGE) {
              s.atkPhase = 'earthquake_windup'; s.atkPhaseTimer = K_EQ_WINDUP;
              s.earthquakeCd = K_EQ_CD; s.hasHit = false;
            } else if (s.lungeSkillCd <= 0 && distP <= lRange) {
              s.atkPhase = 'lunge_windup'; s.atkPhaseTimer = wDur;
              s.lungeSkillCd = lCd; s.hasHit = false;
              s.lungeTargetId = near.id; // lock onto player — teleports to them on fire
            } else if (s.normalAtkCd <= 0 && distP <= nRange) {
              s.atkPhase = 'normal_bounce'; s.atkPhaseTimer = BOUNCE_DURATION;
              s.bounceTargetX = near.x; s.bounceTargetY = near.y;
              s.normalAtkCd = nCd; s.hasHit = false;
            }

          } else if (s.atkPhase === 'normal_bounce') {
            s.atkPhaseTimer -= dt;
            const prog = 1 - s.atkPhaseTimer / BOUNCE_DURATION;
            s.hopArc = -Math.sin(prog * Math.PI) * HOP_HEIGHT;
            const lx = s.bounceTargetX - s.x, ly = s.bounceTargetY - s.y;
            const ld = Math.hypot(lx, ly);
            if (ld > 6) {
              s.x = clamp(s.x + (lx / ld) * BOUNCE_SPEED * dt, s.r, W - s.r);
              s.y = clamp(s.y + (ly / ld) * BOUNCE_SPEED * dt, s.r, H - s.r);
            }
            if (!s.hasHit) {
              for (const p of alivePlayers('slime_map')) {
                if (Math.hypot(p.x - s.x, p.y - s.y) <= s.r + 16) {
                  s.hasHit = true; s.flash = 0.15;
                  const _pDef = players.get(p.id)?.state?.currentDef || 0;
                  const _dmg  = physDmg(s.isKing ? K_NORMAL_ATK : s.atk, _pDef);
                  sendToPlayer(p.id, { type: 'player_hit', slimeId: s.id, amount: _dmg, stun: false });
                  s.atkPhase = 'recovery'; s.atkPhaseTimer = RECOVERY_DUR; s.hopArc = 0;
                  break;
                }
              }
              if (!s.hasHit && near && Math.hypot(near.x - s.bounceTargetX, near.y - s.bounceTargetY) > BOUNCE_ABORT_DIST) {
                s.atkPhase = 'idle'; s.normalAtkCd = 0.6; s.hopArc = 0;
              }
            }
            if (s.atkPhaseTimer <= 0) { s.atkPhase = 'recovery'; s.atkPhaseTimer = RECOVERY_DUR; s.hopArc = 0; }

          } else if (s.atkPhase === 'lunge_windup') {
            s.atkPhaseTimer -= dt;
            // Slow approach during windup (visual only — teleport fires on completion)
            if (near && distP > s.r + 10) {
              const cx = near.x - s.x, cy = near.y - s.y, cd = Math.hypot(cx, cy);
              s.x += (cx / cd) * s.speed * 0.12 * dt;
              s.y += (cy / cd) * s.speed * 0.12 * dt;
            }
            if (s.atkPhaseTimer <= 0) {
              // Instant teleport to locked target's current position
              const tgt = s.lungeTargetId ? players.get(s.lungeTargetId) : null;
              if (tgt && tgt.state && !tgt.state.dead) {
                s.x = clamp(tgt.state.x, s.r, W - s.r);
                s.y = clamp(tgt.state.y, s.r, H - s.r);
                const _pDef = tgt.state.currentDef || 0;
                const _dmg  = physDmg(s.isKing ? K_LUNGE_ATK : Math.floor(s.atk * 1.5), _pDef);
                sendToPlayer(s.lungeTargetId, { type: 'player_hit', slimeId: s.id, amount: _dmg, stun: false });
              }
              s.lungeTargetId = null;
              s.atkPhase = 'recovery'; s.atkPhaseTimer = RECOVERY_DUR * (s.isKing ? 1.5 : 1);
            }

          } else if (s.atkPhase === 'lunge') {
            // Legacy travel phase — no longer entered; safe fallthrough
            s.atkPhase = 'recovery'; s.atkPhaseTimer = RECOVERY_DUR;


          } else if (s.atkPhase === 'earthquake_windup') {
            s.atkPhaseTimer -= dt;
            if (s.atkPhaseTimer <= 0) {
              broadcastToMap({ type: 'earthquake_hit', slimeId: s.id, x: s.x, y: s.y, radius: s.earthquakeRadius }, 'slime_map');
              for (const p of alivePlayers('slime_map')) {
                if (Math.hypot(p.x - s.x, p.y - s.y) <= s.earthquakeRadius) {
                  const _pMdef = players.get(p.id)?.state?.currentMdef || 0;
              const _eqDmg = magicDmg(K_EQ_ATK, _pMdef);
              sendToPlayer(p.id, { type: 'player_hit', slimeId: s.id, amount: _eqDmg, stun: STUN_DURATION });
                }
              }
              s.lungeSkillCd = 0;
              s.atkPhase = 'recovery'; s.atkPhaseTimer = 0.5;
            }

          } else if (s.atkPhase === 'recovery') {
            s.atkPhaseTimer -= dt;
            if (s.atkPhaseTimer <= 0) s.atkPhase = 'idle';
          }
        }
      }

      s.x = clamp(s.x + s.kbx * dt, s.r, W - s.r);
      s.y = clamp(s.y + s.kby * dt, s.r, H - s.r);
    }
  }

  slimes = slimes.filter(s => s.alive);

  // Broadcast world state — only to players on the slime map
  if (slimeMapPlayers.length > 0) {
    const worldMsg = JSON.stringify({
      type: 'world',
      slimes: slimes.map(s => ({
        id: s.id, x: s.x, y: s.y, r: s.r,
        hp: s.hp, maxHp: s.maxHp,
        isGiant: s.isGiant, isKing: s.isKing,
        bodyCol: s.bodyCol, shineCol: s.shineCol,
        flash: s.flash, animT: s.animT, state: s.state,
        atkPhase: s.atkPhase, atkPhaseTimer: s.atkPhaseTimer,
        hopArc: s.hopArc, lungeLockedAngle: s.lungeLockedAngle, lungeTargetId: s.lungeTargetId || null,
        earthquakeRadius: s.earthquakeRadius,
      })),
    });
    for (const p of slimeMapPlayers) p.ws.send(worldMsg);
  }
}

setInterval(tick, 1000 / 20);

// ── CONNECTIONS ───────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const id = String(nextPid++);

  // All players start in town
  const initMaxHp = 32; // will be updated on auth message
  players.set(id, {
    ws,
    currentMap: 'town',
    state: {
      x: TOWN_SPAWN_X, y: TOWN_SPAWN_Y,
      hp: initMaxHp, maxHp: initMaxHp,
      dead: false, facing: 'down', rolling: false,
      atkTimer: 0, atkAngle: 0, stunned: false,
      charName: 'Player', charClass: 'warrior',
      level: 1, xp: 0, xpToNext: 100, statPoints: 0, skillPoints: 1,
      skinTone: 0, hairStyle: 0, hairColor: 0,
      weaponSubtype: null,
    },
  });
  console.log(`[+] Player ${id} — total: ${players.size}`);

  // Welcome: includes spawn position and current map
  const others = [];
  for (const [pid, p] of players) {
    if (pid !== id && p.state) others.push({ ...p.state, id: pid });
  }
  send(ws, {
    type: 'welcome', id, others,
    slimes: [],          // always empty — slimes only sent to slime_map players
    map: 'town',
    x: TOWN_SPAWN_X, y: TOWN_SPAWN_Y,
  });
  broadcast({ type: 'join', id }, id);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const p   = players.get(id);
      if (!p) return;

      // ── AUTH ───────────────────────────────────────────────────────────
      // Client sends this on WS open — updates name, class, hp from character data
      if (msg.type === 'auth') {
        const maxHp = msg.maxHp || defaultMaxHp(msg.charClass);
        p.state.charName     = msg.charName  || 'Player';
        p.state.charClass    = msg.charClass || 'warrior';
        p.state.maxHp        = maxHp;
        p.state.hp           = maxHp;
        p.state.skinTone     = msg.skinTone     || 0;
        p.state.hairStyle    = msg.hairStyle    || 0;
        p.state.hairColor    = msg.hairColor    || 0;
        p.state.weaponSubtype = msg.weaponSubtype || null;
        send(ws, {
          type: 'auth_ok', maxHp, charName: p.state.charName,
          level: p.state.level, xp: p.state.xp,
          xpToNext: p.state.xpToNext, statPoints: p.state.statPoints,
          skillPoints: p.state.skillPoints,
        });
        return;
      }

      // ── STATE ──────────────────────────────────────────────────────────
      if (msg.type === 'state') {
        const state = { ...p.state, ...msg, id, currentMap: p.currentMap };
        // Keep server-side truth for level/xp
        state.level      = p.state.level;
        state.xp         = p.state.xp;
        state.xpToNext   = p.state.xpToNext;
        state.statPoints = p.state.statPoints;
        p.state = state;
        broadcast({ type: 'state', player: state }, id);
      }

      // ── ATTACK ─────────────────────────────────────────────────────────
      if (msg.type === 'attack') {
        if (p.currentMap !== 'slime_map') return;
        const s = slimes.find(s => s.alive && s.id === msg.slimeId);
        if (!s || !p.state) return;
        const dist = Math.hypot(p.state.x - s.x, p.state.y - s.y);
        const playerRange = p.state.currentRange || ATK_RANGE;
        if (dist > playerRange + s.r + 25) return;
        // Use player's computed ATK from state broadcast — physical attack vs slime DEF
        const playerAtk = p.state.currentAtk || P_ATK;
        const dmg = physDmg(playerAtk, s.def);
        s.hp -= dmg; s.flash = 0.15;
        // Knockback only for melee — ranged (bow) gets none
        const isRanged = (p.state.currentRange || ATK_RANGE) > ATK_RANGE;
        if (!isRanged) {
          const ang = Math.atan2(s.y - p.state.y, s.x - p.state.x);
          const kb  = s.isKing ? 18 : 80;
          s.kbx = Math.cos(ang) * kb; s.kby = Math.sin(ang) * kb;
        }
        s.state = 'aggro';
        broadcastToMap({ type: 'slime_hit', slimeId: s.id, x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, dmg }, 'slime_map');
        if (s.hp <= 0) {
          s.alive = false;
          broadcastToMap({ type: 'slime_killed', slimeId: s.id, isKing: s.isKing, isGiant: s.isGiant, x: s.x, y: s.y }, 'slime_map');
          // Award XP to all players on slime_map
          const xpAmt = s.isKing ? MOB_XP.king : s.isGiant ? MOB_XP.giant : MOB_XP.normal;
          for (const [pid] of players) awardXP(pid, xpAmt);
        }
      }

      // ── INTERACT ───────────────────────────────────────────────────────
      // Healer: validate proximity server-side, restore HP
      if (msg.type === 'interact') {
        if (p.currentMap !== 'town' || !p.state) return;

        if (msg.npcId === 'healer') {
          const dist = Math.hypot(p.state.x - TOWN_HEALER_X, p.state.y - TOWN_HEALER_Y);
          if (dist > NPC_INTERACT_RANGE + 20) return; // small extra tolerance
          p.state.hp = p.state.maxHp;
          send(ws, { type: 'healed', hp: p.state.maxHp });
        }
        // storage: client handles opening the panel, no server action needed yet
        // portal: handled via teleport message
      }

      // ── TELEPORT ───────────────────────────────────────────────────────
      // Client requests map change after player confirms on world map panel
      if (msg.type === 'teleport') {
        const dest = msg.destination;
        if (!p.state) return;
        if (dest === p.currentMap) return; // already there

        let spawnX, spawnY;
        if (dest === 'slime_map') {
          spawnX = SLIME_ENTRY_X; spawnY = SLIME_ENTRY_Y;
        } else {
          spawnX = TOWN_SPAWN_X; spawnY = TOWN_SPAWN_Y;
        }

        p.currentMap   = dest;
        p.state.x      = spawnX;
        p.state.y      = spawnY;
        p.state.dead   = false;
        p.state.stunned = false;

        send(ws, {
          type: 'map_change',
          map: dest,
          x: spawnX, y: spawnY,
          slimes: dest === 'slime_map' ? slimes.map(s => ({
            id: s.id, x: s.x, y: s.y, r: s.r,
            hp: s.hp, maxHp: s.maxHp,
            isGiant: s.isGiant, isKing: s.isKing,
            bodyCol: s.bodyCol, shineCol: s.shineCol,
            flash: s.flash, animT: s.animT, state: s.state,
            atkPhase: s.atkPhase, atkPhaseTimer: s.atkPhaseTimer,
            hopArc: s.hopArc, lungeLockedAngle: s.lungeLockedAngle, lungeTargetId: s.lungeTargetId || null,
            earthquakeRadius: s.earthquakeRadius,
          })) : [],
        });

        // Notify others about position change
        broadcast({ type: 'state', player: { ...p.state, id, currentMap: dest } }, id);
      }

      // ── CHAT ───────────────────────────────────────────────────────────
      if (msg.type === 'chat') {
        const text = String(msg.text || '').trim().slice(0, 100);
        if (text) broadcastAll({ type: 'chat', from: id, text });
      }

      // ── RESPAWN ────────────────────────────────────────────────────────
      // Always respawns to town at healer position
      // ── ACTIVE SKILLS ──────────────────────────────────────────────────
      if (msg.type === 'use_skill') {
        const sp = players.get(id);
        if (!sp?.state) return;

        if (msg.skillId === 'arrow_rain') {
          if (sp.currentMap !== 'slime_map') return;
          const { targetX, targetY, skillLevel, aoeRadius = 100 } = msg;
          const dist = Math.hypot(sp.state.x - targetX, sp.state.y - targetY);
          if (dist > 165) return; // 150px cast range + tolerance
          broadcastToMap({ type: 'skill_aoe', skillId: 'arrow_rain', x: targetX, y: targetY, radius: aoeRadius }, 'slime_map');
          const numHits = 4 + (skillLevel || 1);
          const atkVal  = sp.state.currentAtk || 5;
          for (let i = 0; i < numHits; i++) {
            setTimeout(() => {
              for (const s of slimes) {
                if (!s.alive) continue;
                if (Math.hypot(s.x - targetX, s.y - targetY) > aoeRadius + s.r) continue;
                const dmg = physDmg(Math.floor(atkVal * 0.5), s.def);
                s.hp -= dmg; s.flash = 0.1;
                broadcastToMap({ type: 'slime_hit', slimeId: s.id, x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, dmg }, 'slime_map');
                if (s.hp <= 0) {
                  s.alive = false;
                  broadcastToMap({ type: 'slime_killed', slimeId: s.id, isKing: s.isKing, isGiant: s.isGiant, x: s.x, y: s.y }, 'slime_map');
                  const xp = s.isKing ? MOB_XP.king : s.isGiant ? MOB_XP.giant : MOB_XP.normal;
                  for (const [pid] of players) awardXP(pid, xp);
                }
              }
              broadcastToMap({ type: 'skill_hit', skillId: 'arrow_rain', x: targetX, y: targetY }, 'slime_map');
            }, i * 450);
          }
        }

        if (msg.skillId === 'shield_bash') {
          if (sp.currentMap !== 'slime_map') return;
          const s = slimes.find(sl => sl.alive && sl.id === msg.targetSlimeId);
          if (!s) return;
          const dist = Math.hypot(sp.state.x - s.x, sp.state.y - s.y);
          if (dist > ATK_RANGE * 1.5 + s.r + 30) return;
          const lv = msg.skillLevel || 1;
          const dmgMult = 1.5 + lv * 0.3;
          const stunDur = 1.5 + lv * 0.5;
          const dmg = physDmg(Math.floor((sp.state.currentAtk || 5) * dmgMult), s.def);
          s.hp -= dmg; s.flash = 0.3;
          s.atkPhase = 'recovery'; s.atkPhaseTimer = stunDur;
          broadcastToMap({ type: 'slime_hit',  slimeId: s.id, x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, dmg }, 'slime_map');
          broadcastToMap({ type: 'skill_hit',  skillId: 'shield_bash', x: s.x, y: s.y }, 'slime_map');
          if (s.hp <= 0) {
            s.alive = false;
            broadcastToMap({ type: 'slime_killed', slimeId: s.id, isKing: s.isKing, isGiant: s.isGiant, x: s.x, y: s.y }, 'slime_map');
            const xp = s.isKing ? MOB_XP.king : s.isGiant ? MOB_XP.giant : MOB_XP.normal;
            for (const [pid] of players) awardXP(pid, xp);
          }
        }

        // Buff skills — broadcast to party within 250px
        if (msg.skillId === 'haste' || msg.skillId === 'battle_cry') {
          for (const [pid, other] of players) {
            if (!other.state || other.currentMap !== sp.currentMap) continue;
            if (Math.hypot(sp.state.x - other.state.x, sp.state.y - other.state.y) <= 250) {
              send(other.ws, { type: 'skill_buff', skillId: msg.skillId, skillLevel: msg.skillLevel, casterId: id, duration: msg.duration });
            }
          }
        }
      }

      if (msg.type === 'respawn') {
        p.currentMap    = 'town';
        p.state.x       = TOWN_SPAWN_X;
        p.state.y       = TOWN_SPAWN_Y;
        p.state.hp      = p.state.maxHp || 32;
        p.state.dead    = false;
        p.state.stunned = false;
        send(ws, {
          type: 'map_change',
          map: 'town',
          x: TOWN_SPAWN_X, y: TOWN_SPAWN_Y,
          slimes: [],
        });
      }

    } catch (e) {
      console.error(`[msg error] player ${id}:`, e.message);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`[-] Player ${id} — total: ${players.size}`);
    broadcast({ type: 'leave', id });
  });

  ws.on('error', e => console.error(`[ws error] player ${id}:`, e.message));
});

// ── STARTUP ───────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[uncaught]',  e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  for (let i = 0; i < 4; i++) doSpawnSlime();
  doSpawnKing();
});
