/* =============================================================
   BANANA BATTLE
   An original artillery game inspired by the classic DOS/QBasic
   "Gorillas" — built from scratch. No original assets or code
   from Microsoft are used.

   Virtual resolution: 640 x 350 (VGA-ish), scaled to fit.
   ============================================================= */

(() => {
  "use strict";

  // ---- Virtual screen ------------------------------------------------
  const VW = 640;
  const VH = 350;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // Offscreen "terrain" canvas holds the destructible buildings.
  // Collision is done by sampling this canvas's alpha channel, so
  // explosion holes carved into it are automatically walkable/passable.
  const terrain = document.createElement("canvas");
  terrain.width = VW;
  terrain.height = VH;
  const tctx = terrain.getContext("2d", { willReadFrequently: true });
  tctx.imageSmoothingEnabled = false;

  // ---- DOS-style 16 colour palette -----------------------------------
  const PAL = {
    black:        "#000000",
    blue:         "#0000AA",
    green:        "#00AA00",
    cyan:         "#00AAAA",
    red:          "#AA0000",
    magenta:      "#AA00AA",
    brown:        "#AA5500",
    lightGray:    "#AAAAAA",
    gray:         "#555555",
    brightBlue:   "#5555FF",
    brightGreen:  "#55FF55",
    brightCyan:   "#55FFFF",
    brightRed:    "#FF5555",
    brightMagenta:"#FF55FF",
    yellow:       "#FFFF55",
    white:        "#FFFFFF"
  };

  const BUILDING_COLORS = [PAL.cyan, PAL.red, PAL.brightBlue, PAL.lightGray];

  // ---- Physics constants (tuned for the 640x350 field) ---------------
  const GRAVITY = 100;        // px / s^2 downward
  const SPEED_SCALE = 3;      // slider power -> px/s
  const WIND_SCALE = 3;       // wind units -> px/s^2 sideways
  const EXPLOSION_RADIUS = 18;
  const BANANA_R = 4;

  // ---- Game state machine --------------------------------------------
  const STATE = {
    TITLE: "TITLE",
    WAITING: "WAITING_FOR_INPUT",
    FLIGHT: "BANANA_IN_FLIGHT",
    EXPLOSION: "EXPLOSION",
    ROUND_OVER: "ROUND_OVER"
  };

  const game = {
    state: STATE.TITLE,
    buildings: [],
    gorillas: [],        // [p1, p2]
    current: 0,          // 0 or 1
    wind: 0,
    scores: [0, 0],
    banana: null,
    explosion: null,
    sun: { x: VW / 2, y: 30, r: 12, shocked: 0 },
    winner: -1,
    titleT: 0,
    // Each player keeps their own last-used aim so the sliders snap back
    // to where they left off when the turn returns to them.
    aim: [
      { angle: 45, velocity: 60 },
      { angle: 45, velocity: 60 }
    ]
  };

  // Persisted scores
  try {
    const s = JSON.parse(localStorage.getItem("bb_scores") || "null");
    if (Array.isArray(s) && s.length === 2) game.scores = [s[0] | 0, s[1] | 0];
  } catch (e) { /* ignore */ }

  // ---- DOM controls ---------------------------------------------------
  const el = {
    status: document.getElementById("status"),
    angle: document.getElementById("angle"),
    angleValue: document.getElementById("angleValue"),
    velocity: document.getElementById("velocity"),
    velocityValue: document.getElementById("velocityValue"),
    wind: document.getElementById("wind"),
    throwBtn: document.getElementById("throwButton"),
    newRoundBtn: document.getElementById("newRoundButton")
  };

  // Persisted per-player aim (so each player's last angle/power is remembered)
  try {
    const a = JSON.parse(localStorage.getItem("bb_aim") || "null");
    if (Array.isArray(a) && a.length === 2 && a[0] && a[1]) {
      game.aim = [
        { angle: clampAngle(a[0].angle), velocity: clampVel(a[0].velocity) },
        { angle: clampAngle(a[1].angle), velocity: clampVel(a[1].velocity) }
      ];
    }
  } catch (e) { /* ignore */ }

  el.angle.addEventListener("input", () => {
    el.angleValue.textContent = el.angle.value + "°";
    rememberAim();
  });
  el.velocity.addEventListener("input", () => {
    el.velocityValue.textContent = el.velocity.value;
    rememberAim();
  });
  el.throwBtn.addEventListener("click", onThrow);

  // Push the given player's saved aim onto the sliders.
  function applyAim(p) {
    const a = game.aim[p];
    el.angle.value = a.angle;
    el.velocity.value = a.velocity;
    el.angleValue.textContent = a.angle + "°";
    el.velocityValue.textContent = a.velocity;
  }

  // Store the current slider values as the active player's aim.
  function rememberAim() {
    if (game.state !== STATE.WAITING) return;
    game.aim[game.current] = {
      angle: parseFloat(el.angle.value),
      velocity: parseFloat(el.velocity.value)
    };
    saveAim();
  }
  el.newRoundBtn.addEventListener("click", () => {
    if (game.state === STATE.TITLE) startMatch();
    else newRound();
  });

  // ================================================================
  //  WORLD GENERATION
  // ================================================================
  function generateBuildings() {
    const list = [];
    let x = 0;
    const colorsInUse = BUILDING_COLORS.slice();
    let prevColor = null;
    while (x < VW) {
      let w = randInt(34, 62);
      if (x + w > VW) w = VW - x;
      const h = randInt(70, 250);
      const y = VH - h;
      // pick a colour that differs from the neighbour
      let c;
      do { c = pick(colorsInUse); } while (c === prevColor && colorsInUse.length > 1);
      prevColor = c;
      list.push({ x, y, width: w, height: h, color: c });
      x += w;
    }
    return list;
  }

  function paintTerrain() {
    tctx.clearRect(0, 0, VW, VH);
    for (const b of game.buildings) {
      // building body
      tctx.fillStyle = b.color;
      tctx.fillRect(b.x, b.y, b.width, b.height);

      // subtle top edge highlight
      tctx.fillStyle = "rgba(255,255,255,0.10)";
      tctx.fillRect(b.x, b.y, b.width, 2);

      // windows
      drawWindows(b);
    }
  }

  function drawWindows(b) {
    const marginX = 5;
    const stepX = 10;   // window spacing
    const stepY = 14;
    const winW = 4;
    const winH = 7;
    for (let wy = b.y + 8; wy < VH - winH; wy += stepY) {
      for (let wx = b.x + marginX; wx <= b.x + b.width - marginX - winW; wx += stepX) {
        // lit or dark, deterministic-ish random
        const lit = Math.random() < 0.6;
        tctx.fillStyle = lit ? PAL.yellow : PAL.gray;
        tctx.fillRect(wx, wy, winW, winH);
      }
    }
  }

  function placeGorillas() {
    // Left gorilla on a building in the first third,
    // right gorilla in the last third.
    const n = game.buildings.length;
    const li = randInt(1, Math.max(1, Math.floor(n / 3)));
    const ri = randInt(Math.min(n - 2, Math.floor((2 * n) / 3)), n - 2);
    const left = game.buildings[Math.min(li, n - 1)];
    const right = game.buildings[Math.max(ri, 0)];

    game.gorillas = [
      makeGorilla(left),
      makeGorilla(right)
    ];
  }

  function makeGorilla(b) {
    const width = 26;
    const height = 26;
    const x = Math.round(b.x + b.width / 2 - width / 2);
    const y = b.y - height; // sits on the rooftop
    return { x, y, width, height, alive: true, home: b };
  }

  // ================================================================
  //  ROUND / MATCH FLOW
  // ================================================================
  function startMatch() {
    game.scores = [0, 0];
    saveScores();
    newRound();
  }

  function newRound() {
    game.buildings = generateBuildings();
    paintTerrain();
    placeGorillas();
    game.wind = randInt(-8, 8);
    // Loser of last round (or player 0 at start) begins
    game.current = (game.winner === 1) ? 0 : (game.winner === 0 ? 1 : 0);
    game.winner = -1;
    game.banana = null;
    game.explosion = null;
    game.state = STATE.WAITING;
    applyAim(game.current);
    updateHUD();
    setControlsEnabled(true);
  }

  function onThrow() {
    if (game.state !== STATE.WAITING) return;
    const angle = parseFloat(el.angle.value);
    const power = parseFloat(el.velocity.value);
    // Save this player's aim so it returns next time it's their turn.
    game.aim[game.current] = { angle, velocity: power };
    saveAim();
    fireBanana(angle, power);
  }

  function fireBanana(angle, power) {
    const g = game.gorillas[game.current];
    // Player 2 (right) mirrors the angle so "higher slider = more up
    // and toward the opponent" for both players.
    const effAngle = game.current === 1 ? (180 - angle) : angle;
    const rad = effAngle * Math.PI / 180;
    const v = power * SPEED_SCALE;

    const startX = g.x + g.width / 2;
    const startY = g.y - 2;

    game.banana = {
      x: startX,
      y: startY,
      startX,
      startY,
      vx: Math.cos(rad) * v,
      vy: -Math.sin(rad) * v,
      active: true,
      spin: 0,
      trail: []
    };
    game.state = STATE.FLIGHT;
    setControlsEnabled(false);
    beep(660, 0.06, "square", 0.05);
  }

  function switchTurn() {
    game.current = game.current === 0 ? 1 : 0;
    game.state = STATE.WAITING;
    applyAim(game.current);
    updateHUD();
    setControlsEnabled(true);
  }

  function winRound(winnerIdx) {
    game.winner = winnerIdx;
    game.scores[winnerIdx]++;
    saveScores();
    game.state = STATE.ROUND_OVER;
    setControlsEnabled(false);
    el.newRoundBtn.disabled = false;
    updateHUD();
  }

  // ================================================================
  //  PHYSICS + COLLISION
  // ================================================================
  function updateFlight(dt) {
    const b = game.banana;
    if (!b || !b.active) return;

    // Sub-step so a fast banana can't tunnel through a thin building.
    const speed = Math.hypot(b.vx, b.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 2));
    const sdt = dt / steps;

    for (let i = 0; i < steps; i++) {
      // integrate
      b.vy += GRAVITY * sdt;
      b.vx += game.wind * WIND_SCALE * sdt;
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      b.spin += (b.vx >= 0 ? 1 : -1) * 0.5;

      // record trail
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 24) b.trail.shift();

      const movedFromStart =
        Math.hypot(b.x - b.startX, b.y - b.startY) > (game.gorillas[game.current].width);

      // Off the sides or bottom -> miss
      if (b.x < -20 || b.x > VW + 20 || b.y > VH + 40) {
        b.active = false;
        endMiss();
        return;
      }

      // Sun bump (cosmetic)
      if (dist(b.x, b.y, game.sun.x, game.sun.y) < game.sun.r + BANANA_R) {
        game.sun.shocked = 1.2;
      }

      if (movedFromStart) {
        // Gorilla hit?
        for (let gi = 0; gi < 2; gi++) {
          const g = game.gorillas[gi];
          if (!g.alive) continue;
          if (b.x >= g.x && b.x <= g.x + g.width &&
              b.y >= g.y && b.y <= g.y + g.height) {
            b.active = false;
            startExplosion(b.x, b.y, gi);
            return;
          }
        }
        // Building / terrain hit? (sample the destructible mask)
        if (b.y >= 0 && solidAt(b.x, b.y)) {
          b.active = false;
          startExplosion(b.x, b.y, -1);
          return;
        }
      }
    }
  }

  function solidAt(x, y) {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || px >= VW || py < 0 || py >= VH) return false;
    const a = tctx.getImageData(px, py, 1, 1).data[3];
    return a > 24;
  }

  function startExplosion(x, y, gorillaHitIdx) {
    game.explosion = {
      x, y,
      r: 2,
      max: EXPLOSION_RADIUS,
      t: 0,
      gorillaHitIdx,
      carved: false
    };
    game.state = STATE.EXPLOSION;
    beep(120, 0.28, "sawtooth", 0.09);
  }

  function updateExplosion(dt) {
    const ex = game.explosion;
    if (!ex) return;
    ex.t += dt;
    ex.r = Math.min(ex.max, ex.r + ex.max * dt * 6);

    // Carve the hole once, near the peak of the blast.
    if (!ex.carved && ex.r >= ex.max * 0.85) {
      carveHole(ex.x, ex.y, ex.max);
      ex.carved = true;
      // A gorilla standing where terrain vanished isn't destroyed by that
      // alone — only a direct banana hit counts, handled below.
    }

    if (ex.t > 0.5) {
      const hit = ex.gorillaHitIdx;
      game.explosion = null;
      if (hit >= 0) {
        game.gorillas[hit].alive = false;
        const winner = hit === 0 ? 1 : 0;
        winRound(winner);
      } else {
        switchTurn();
      }
    }
  }

  function carveHole(x, y, r) {
    tctx.save();
    tctx.globalCompositeOperation = "destination-out";
    tctx.beginPath();
    tctx.arc(x, y, r, 0, Math.PI * 2);
    tctx.fill();
    tctx.restore();
  }

  function endMiss() {
    game.state = STATE.EXPLOSION;
    // brief pause then switch (no explosion drawn)
    game.explosion = { x: 0, y: 0, r: 0, max: 0, t: 0, gorillaHitIdx: -1, carved: true, silent: true };
    setTimeout(() => {
      if (game.state === STATE.EXPLOSION) {
        game.explosion = null;
        switchTurn();
      }
    }, 250);
  }

  // ================================================================
  //  RENDERING
  // ================================================================
  function render() {
    // 1. clear to black
    ctx.fillStyle = PAL.black;
    ctx.fillRect(0, 0, VW, VH);

    if (game.state === STATE.TITLE) {
      drawTitle();
      return;
    }

    // 2. sun
    drawSun();

    // 3. wind indicator
    drawWind();

    // 4/5. buildings + windows (baked into terrain canvas, holes included)
    ctx.drawImage(terrain, 0, 0);

    // 6. gorillas
    for (let i = 0; i < 2; i++) drawGorilla(game.gorillas[i], i);

    // 7. banana
    if (game.banana && game.banana.active) drawBanana(game.banana);

    // 8. explosion
    if (game.explosion && !game.explosion.silent) drawExplosion(game.explosion);

    // 9. HUD text
    drawHUD();

    if (game.state === STATE.ROUND_OVER) drawRoundOver();
  }

  function drawSun() {
    const s = game.sun;
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();

    // rays
    ctx.strokeStyle = PAL.yellow;
    ctx.lineWidth = 1;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const r1 = s.r + 2;
      const r2 = s.r + 5;
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(ang) * r1, s.y + Math.sin(ang) * r1);
      ctx.lineTo(s.x + Math.cos(ang) * r2, s.y + Math.sin(ang) * r2);
      ctx.stroke();
    }

    // face
    ctx.fillStyle = PAL.black;
    ctx.fillRect(s.x - 5, s.y - 3, 2, 2);
    ctx.fillRect(s.x + 3, s.y - 3, 2, 2);
    if (s.shocked > 0) {
      // open "O" mouth
      ctx.beginPath();
      ctx.arc(s.x, s.y + 4, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // smile
      ctx.fillRect(s.x - 4, s.y + 4, 8, 1);
      ctx.fillRect(s.x - 4, s.y + 3, 1, 1);
      ctx.fillRect(s.x + 3, s.y + 3, 1, 1);
    }
  }

  function drawWind() {
    if (game.wind === 0) return;
    const cx = VW / 2;
    const y = VH - 4;
    const len = Math.abs(game.wind) * 4;
    const dir = Math.sign(game.wind);
    ctx.strokeStyle = PAL.brightRed;
    ctx.fillStyle = PAL.brightRed;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx + len * dir, y);
    ctx.stroke();
    // arrowhead
    ctx.beginPath();
    ctx.moveTo(cx + len * dir, y);
    ctx.lineTo(cx + len * dir - 4 * dir, y - 3);
    ctx.lineTo(cx + len * dir - 4 * dir, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  function drawGorilla(g, idx) {
    if (!g.alive) {
      // small tombstone / rubble marker
      ctx.fillStyle = PAL.gray;
      ctx.fillRect(g.x + 6, g.y + g.height - 6, g.width - 12, 6);
      return;
    }
    const x = g.x;
    const y = g.y;
    const body = PAL.brown;
    const dark = "#7A3D00";
    ctx.fillStyle = body;

    // head
    ctx.fillRect(x + 8, y + 0, 10, 8);
    // brow
    ctx.fillStyle = dark;
    ctx.fillRect(x + 8, y + 3, 10, 2);
    // eyes
    ctx.fillStyle = PAL.yellow;
    ctx.fillRect(x + 10, y + 4, 2, 2);
    ctx.fillRect(x + 14, y + 4, 2, 2);

    // torso
    ctx.fillStyle = body;
    ctx.fillRect(x + 6, y + 8, 14, 12);
    // chest
    ctx.fillStyle = dark;
    ctx.fillRect(x + 10, y + 10, 6, 8);

    // arms — the one facing the opponent is raised (ready to throw)
    ctx.fillStyle = body;
    if (idx === 0) {
      ctx.fillRect(x + 2, y + 6, 4, 10);      // left arm down
      ctx.fillRect(x + 20, y + 2, 4, 10);     // right arm up
    } else {
      ctx.fillRect(x + 20, y + 6, 4, 10);     // right arm down
      ctx.fillRect(x + 2, y + 2, 4, 10);      // left arm up
    }

    // legs
    ctx.fillStyle = body;
    ctx.fillRect(x + 7, y + 20, 5, 6);
    ctx.fillRect(x + 14, y + 20, 5, 6);
  }

  function drawBanana(b) {
    // trail
    for (let i = 0; i < b.trail.length; i++) {
      const p = b.trail[i];
      const a = i / b.trail.length;
      ctx.fillStyle = `rgba(255,255,85,${a * 0.5})`;
      ctx.fillRect(p.x | 0, p.y | 0, 2, 2);
    }
    // spinning banana: a curved crescent with brown tips
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.spin);

    // yellow crescent body (outer curve up top, inner curve underneath)
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    ctx.moveTo(-7, 1);
    ctx.quadraticCurveTo(0, -9, 7, 1);   // outer (top) edge
    ctx.quadraticCurveTo(0, -3, -7, 1);  // inner (bottom) edge
    ctx.closePath();
    ctx.fill();

    // ridge/shadow along the inside for a bit of depth
    ctx.strokeStyle = "rgba(120,60,0,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-5.5, 0.3);
    ctx.quadraticCurveTo(0, -3.6, 5.5, 0.3);
    ctx.stroke();

    // brown tips at each end
    ctx.fillStyle = PAL.brown;
    ctx.fillRect(-8, -1, 2, 3);
    ctx.fillRect(6, -1, 2, 3);

    ctx.restore();
  }

  function drawExplosion(ex) {
    const flick = (Math.floor(ex.t * 40) % 2 === 0);
    ctx.fillStyle = flick ? PAL.yellow : PAL.brightRed;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, ex.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = flick ? PAL.brightRed : PAL.brown;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, ex.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHUD() {
    ctx.font = "bold 12px 'Courier New', monospace";
    ctx.textBaseline = "top";
    // scores in the top corners (kept clear of the centred sun).
    // The active player's score is highlighted.
    ctx.textAlign = "left";
    ctx.fillStyle = (game.state === STATE.WAITING && game.current === 0) ? PAL.white : PAL.brightCyan;
    ctx.fillText((game.current === 0 && game.state === STATE.WAITING ? "▶ " : "") + "P1: " + game.scores[0], 6, 6);
    ctx.textAlign = "right";
    ctx.fillStyle = (game.state === STATE.WAITING && game.current === 1) ? PAL.white : PAL.brightMagenta;
    ctx.fillText("P2: " + game.scores[1] + (game.current === 1 && game.state === STATE.WAITING ? " ◀" : ""), VW - 6, 6);
    ctx.textAlign = "left";
  }

  function drawRoundOver() {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, VH / 2 - 34, VW, 68);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PAL.yellow;
    ctx.font = "bold 22px 'Courier New', monospace";
    ctx.fillText("PLAYER " + (game.winner + 1) + " SCORES A HIT!", VW / 2, VH / 2 - 8);
    ctx.fillStyle = PAL.white;
    ctx.font = "13px 'Courier New', monospace";
    ctx.fillText("Tap NEW ROUND to play on", VW / 2, VH / 2 + 16);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  function drawTitle() {
    game.titleT += 1;
    // starfield-ish backdrop
    ctx.fillStyle = PAL.black;
    ctx.fillRect(0, 0, VW, VH);

    drawSun();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PAL.yellow;
    ctx.font = "bold 40px 'Courier New', monospace";
    ctx.fillText("BANANA BATTLE", VW / 2, VH / 2 - 40);

    ctx.fillStyle = PAL.brightGreen;
    ctx.font = "14px 'Courier New', monospace";
    ctx.fillText("An artillery duel for two players", VW / 2, VH / 2 + 4);

    // little demo gorilla + banana
    const gy = VH / 2 + 40;
    ctx.fillStyle = PAL.brown;
    ctx.fillRect(VW / 2 - 40, gy, 14, 14);
    ctx.fillRect(VW / 2 + 26, gy, 14, 14);
    const bx = VW / 2 + Math.sin(game.titleT / 20) * 30;
    ctx.fillStyle = PAL.yellow;
    ctx.fillRect(bx, gy - 20 - Math.abs(Math.cos(game.titleT / 20)) * 14, 6, 4);

    if (Math.floor(game.titleT / 30) % 2 === 0) {
      ctx.fillStyle = PAL.white;
      ctx.font = "16px 'Courier New', monospace";
      ctx.fillText("Press NEW ROUND to begin", VW / 2, VH - 30);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  // ================================================================
  //  HUD / DOM sync
  // ================================================================
  function updateHUD() {
    el.wind.textContent = "WIND: " + (game.wind > 0 ? "+" : "") + game.wind +
      (game.wind === 0 ? "" : game.wind > 0 ? "  →" : "  ←");

    if (game.state === STATE.ROUND_OVER) {
      el.status.innerHTML = "PLAYER " + (game.winner + 1) + " WINS THE ROUND! " +
        "&nbsp; " + game.scores[0] + " &ndash; " + game.scores[1];
    } else {
      el.status.textContent =
        "PLAYER " + (game.current + 1) + " — TAKE AIM   [" +
        game.scores[0] + " : " + game.scores[1] + "]";
    }

    // NEW ROUND is the primary action only when a round has ended (or on the
    // title screen); otherwise THROW is the button to press.
    const newRoundIsPrimary =
      (game.state === STATE.ROUND_OVER || game.state === STATE.TITLE);
    el.newRoundBtn.classList.toggle("is-primary", newRoundIsPrimary);
    el.newRoundBtn.textContent =
      game.state === STATE.TITLE ? "START GAME" : "NEW ROUND";
  }

  function setControlsEnabled(on) {
    el.angle.disabled = !on;
    el.velocity.disabled = !on;
    el.throwBtn.disabled = !on;
    el.newRoundBtn.disabled = (game.state === STATE.WAITING) ? false : el.newRoundBtn.disabled;
    if (game.state === STATE.ROUND_OVER || game.state === STATE.TITLE) {
      el.newRoundBtn.disabled = false;
    }
  }

  // ================================================================
  //  MAIN LOOP
  // ================================================================
  let last = 0;
  function loop(ts) {
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05; // clamp big frame gaps

    // decay sun expression
    if (game.sun.shocked > 0) game.sun.shocked = Math.max(0, game.sun.shocked - dt);

    if (game.state === STATE.FLIGHT) updateFlight(dt);
    else if (game.state === STATE.EXPLOSION && game.explosion && !game.explosion.silent) {
      updateExplosion(dt);
    }

    render();
    requestAnimationFrame(loop);
  }

  // ================================================================
  //  AUDIO (WebAudio, created lazily so iOS unlocks on first tap)
  // ================================================================
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
  document.addEventListener("touchstart", ensureAudio, { once: true, passive: true });
  document.addEventListener("mousedown", ensureAudio, { once: true });

  function beep(freq, dur, type, vol) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || "square";
      osc.frequency.value = freq;
      gain.gain.value = vol || 0.05;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      gain.gain.setValueAtTime(vol || 0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.start(t);
      osc.stop(t + dur);
    } catch (e) { /* ignore */ }
  }

  // ================================================================
  //  HELPERS
  // ================================================================
  function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function dist(x1, y1, x2, y2) { return Math.hypot(x1 - x2, y1 - y2); }
  function saveScores() {
    try { localStorage.setItem("bb_scores", JSON.stringify(game.scores)); } catch (e) {}
  }
  function saveAim() {
    try { localStorage.setItem("bb_aim", JSON.stringify(game.aim)); } catch (e) {}
  }
  function clamp(v, lo, hi) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }
  function clampAngle(v) { return clamp(v, +el.angle.min, +el.angle.max); }
  function clampVel(v) { return clamp(v, +el.velocity.min, +el.velocity.max); }

  // ================================================================
  //  BOOT
  // ================================================================
  setControlsEnabled(false);   // title screen: only START GAME is active
  updateHUD();
  requestAnimationFrame(loop);
})();
