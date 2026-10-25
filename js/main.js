// 主程序：渲染器、第一人称控制（步行 / 开车 / 骑车）、召唤载具、天气/时间/画质菜单、HUD、浮动原点、主循环
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('h404.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('h404.' + k, JSON.stringify(v)); } catch (e) { /* 隐私模式 */ } },
  };
  const QUALITY = {
    mid: { name: '中', pr: 1, shadow: 1024, dist: 360, peds: 45, lamps: 2, detail: 70 },
    midhi: { name: '中上', pr: 1.5, shadow: 2048, dist: 520, peds: 70, lamps: 4, detail: 110 },
    high: { name: '高', pr: 2, shadow: 4096, dist: 680, peds: 100, lamps: 6, detail: 160 },
  };
  const TIMES = { dawn: ['清晨', 6.6], day: ['白天', 14], dusk: ['黄昏', 18.1], night: ['夜晚', 22] };
  const SUMMON = [
    { key: 'hatch', kind: 'car', name: '两厢小车' }, { key: 'sedan', kind: 'car', name: '三厢轿车' }, { key: 'suv', kind: 'car', name: 'SUV' },
    { key: 'shared', kind: 'bike', name: '共享单车' }, { key: 'road', kind: 'bike', name: '公路车' },
  ];

  // ---------- 渲染器 ----------
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  H.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 2200);
  scene.add(camera);

  let quality = store.get('quality', 'midhi');
  if (!QUALITY[quality]) quality = 'midhi';
  function resize() {
    const q = QUALITY[quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ---------- 搭场景 ----------
  H.tex.build();
  H.mat.build();
  H.sky.init(scene, renderer);
  H.world.init(scene);
  H.interior.init(scene);
  H.weather.init(scene);
  H.people.init(scene, QUALITY.high.peds);
  H.veh.init(scene);
  const C = H.world.C;
  // 出生点旁边停着的那辆车
  H.veh.spawnCar('hatch', '#2f9e9a', C.SHOX, -9, 0);
  const lampLights = [];
  for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xffd59a, 0, 24, 2); scene.add(l); lampLights.push(l); }

  function applyQuality() {
    const q = QUALITY[quality];
    H.world.drawDist = q.dist;
    H.detail.radius = q.detail;
    H.sky.setShadowSize(q.shadow);
    resize();
    H.people.populate(q.peds, player.pos.z);
    document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === quality));
  }

  // ---------- 玩家 ----------
  const SPAWN_X = C.CURB + 2.7;
  const player = {
    pos: new THREE.Vector3(SPAWN_X, C.SY, -4), yaw: 0, pitch: -0.02, vy: 0, onGround: true,
    footY: C.SY, bob: 0, stepAcc: 0, veh: null, lookYaw: 0, lookPitch: -0.06, idleLook: 0,
  };
  const inCar = () => player.veh && player.veh.type === 'car';
  const onBike = () => player.veh && player.veh.type === 'bike';
  let sens = store.get('sens', 1);
  const keys = {};
  let started = false, paused = true, locked = false;
  let mouseDX = 0, mouseDY = 0;

  // ---------- 输入 ----------
  window.addEventListener('keydown', (e) => {
    if (e.repeat) { keys[e.code] = true; return; }
    keys[e.code] = true;
    if (!started) return;
    if (e.code === 'Escape' && !locked) { setPaused(!paused); return; } // 没锁定鼠标时 Esc 自己开关菜单
    if (paused) return;
    const v = player.veh;
    if (e.code === 'KeyF') useVehicle();
    if (e.code === 'KeyE' && !v) H.interior.interact();
    if (e.code === 'KeyC') summon('car');
    if (e.code === 'KeyB') summon('bike');
    if (e.code === 'KeyL' && inCar()) { v.lights = { auto: 'on', on: 'off', off: 'auto' }[v.lights]; toast('车灯：' + { auto: '自动', on: '常开', off: '关闭' }[v.lights]); }
    if (e.code === 'KeyL' && onBike()) { H.veh.bikeLight = !H.veh.bikeLight; toast(H.veh.bikeLight ? '车灯：开' : '车灯：关'); }
    if (e.code === 'KeyV' && inCar()) { v.wiperMode = { auto: 'slow', slow: 'fast', fast: 'off', off: 'auto' }[v.wiperMode]; toast('雨刮：' + { auto: '自动', slow: '慢速', fast: '快速', off: '关闭' }[v.wiperMode]); }
    if (e.code === 'KeyH' && inCar()) { H.audio.horn(true); H.people.honk(v.state); }
    if (e.code === 'KeyH' && onBike()) { H.audio.bell(); H.people.honk(v.state); }
    if (e.code === 'KeyT') { const ks = Object.keys(TIMES); const cur = ks.findIndex((k) => Math.abs(TIMES[k][1] - H.sky.hours) < 0.01); setTime(ks[(cur + 1) % ks.length]); }
    if (e.code === 'KeyM') toast(H.audio.toggleMute() ? '已静音' : '声音已打开');
    if (e.code === 'KeyG') { H.weather.strike(camera.position, true); }
    if (e.code === 'Digit0') setWeatherAuto(!H.weather.auto);
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 8) setWeather(H.weather.ORDER[n - 1]);
    if (e.code === 'Tab') { e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'KeyH') H.audio.horn(false); });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; H.audio.horn(false); });
  document.addEventListener('mousemove', (e) => {
    // 正常走指针锁定；锁不上（比如被嵌在不允许 pointer-lock 的 iframe 里）就按住左键拖动看
    if (locked || (started && !paused && (e.buttons & 1))) { mouseDX += e.movementX; mouseDY += e.movementY; }
  });
  canvas.addEventListener('click', () => {
    if (started && !locked) lock();
    else if (started && !paused && !player.veh) H.interior.interact(); // 锁定鼠标后点左键也能开门、按电梯
  });
  function lock() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 不支持就算了 */ } }
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (started) setPaused(!locked);
  });

  // ---------- 上下载具 ----------
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  function useVehicle() {
    const v = player.veh;
    if (!v) {
      if (H.interior.indoor) return; // 屋里不能隔着墙上车
      if (!player.onGround) return;  // 跳在半空不能上车
      const ref = H.veh.nearest(player.pos);
      if (!ref) return;
      const nv = H.veh.take(ref);
      player.veh = nv; nv.occupied = true; player.vx = player.vz = 0;
      let ly = player.yaw - nv.state.yaw; ly = Math.atan2(Math.sin(ly), Math.cos(ly));
      player.lookYaw = ly * 0.3; player.lookPitch = nv.type === 'car' ? -0.06 : -0.12;
      if (nv.type === 'car') { H.audio.door(); toast('已上车 · W 油门 · S 刹车/倒车 · A/D 转向'); }
      else { H.audio.thunk(200, 0.12); toast('骑上车了 · W 蹬车 · S 刹车 · A/D 转向 · Shift 冲刺'); }
      hintT = 8;
      return;
    }
    const sp = Math.abs(v.state.speed);
    if (sp > (v.type === 'car' ? 2.5 : 3)) { toast(v.type === 'car' ? '先把车停下来再下车' : '先停下来再下车'); return; }
    // 下车点先按实心楼体推一下：贴着店面停车时别把人放进墙里（楼打开以后墙是室内碰撞，会把人推进屋里）
    if (v.type === 'car') { v.doorPos(tmpV); H.world.collide(tmpV, 0.32, false); player.pos.set(tmpV.x, H.world.groundY(tmpV.x), tmpV.z); H.audio.door(); H.audio.horn(false); }
    else { v.mountPos(tmpV); H.world.collide(tmpV, 0.32, false); player.pos.set(tmpV.x, H.world.surfaceY(tmpV.x, tmpV.z, v.state.y), tmpV.z); H.audio.thunk(180, 0.1); }
    player.footY = player.pos.y; player.vy = 0; player.onGround = true; player.vx = player.vz = 0;
    player.yaw = v.state.yaw + player.lookYaw; player.pitch = player.lookPitch;
    v.occupied = false; player.veh = null;
  }
  function summon(kind, key) {
    if (player.veh) { toast('先下车再召唤'); return; }
    if (H.interior.indoor) { toast('屋里放不下，到街上再召唤'); return; }
    if (H.interior.balcony) { toast('阳台上放不下，到街上再召唤'); return; }
    if (!player.onGround) { toast('落地再召唤'); return; }
    const v = kind === 'car' ? H.veh.summonCar(player, key) : H.veh.summonBike(player, key);
    if (!v) { toast(kind === 'car' ? '附近停车带满了，换个地方再试' : '身边没地方放自行车'); return; }
    const name = kind === 'car' ? H.veh.MODELS[v.model].name : (v.style === 'shared' ? '共享单车' : '公路车');
    toast(`召唤了一辆${name} · 走过去按 F ${kind === 'car' ? '上车' : '骑车'}`);
    H.audio.thunk(320, 0.12);
  }

  // ---------- 天气 / 时间 ----------
  function setWeather(k, instant) {
    H.weather.auto = false; H.weather.set(k, instant); store.set('weather', k);
    $('wAuto').classList.remove('on');
    refreshWeatherUI(); toast(`天气：${H.weather.TYPES[k].icon} ${H.weather.TYPES[k].name}`);
  }
  function setWeatherAuto(on) {
    H.weather.auto = on; $('wAuto').classList.toggle('on', on); toast(on ? '天气：自动变化' : '天气：固定'); refreshWeatherUI();
  }
  function setTime(k) {
    H.sky.hours = TIMES[k][1]; store.set('time', k);
    document.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === k));
    toast('时间：' + TIMES[k][0]);
  }
  function refreshWeatherUI() {
    document.querySelectorAll('[data-w]').forEach((b) => b.classList.toggle('on', b.dataset.w === H.weather.target && !H.weather.auto));
  }
  H.weather.onChange = (k) => { refreshWeatherUI(); if (H.weather.auto && started) toast(`天气转为 ${H.weather.TYPES[k].icon} ${H.weather.TYPES[k].name}`); };

  // ---------- UI ----------
  function buildUI() {
    const wg = $('wGrid');
    H.weather.ORDER.forEach((k, i) => {
      const t = H.weather.TYPES[k];
      const b = document.createElement('button'); b.className = 'chip'; b.dataset.w = k;
      b.innerHTML = `<span class="ic">${t.icon}</span><span>${t.name}</span><kbd>${i + 1}</kbd>`;
      b.onclick = () => setWeather(k); wg.appendChild(b);
    });
    $('wAuto').onclick = () => setWeatherAuto(!H.weather.auto);
    const sg = $('sGrid');
    for (const it of SUMMON) {
      const b = document.createElement('button'); b.className = 'chip';
      b.innerHTML = `<span class="ic">${it.kind === 'car' ? '🚗' : '🚲'}</span><span>${it.name}</span>`;
      b.onclick = () => summon(it.kind, it.key); sg.appendChild(b);
    }
    const tg = $('tGrid');
    for (const k in TIMES) {
      const b = document.createElement('button'); b.className = 'chip'; b.dataset.t = k; b.textContent = TIMES[k][0];
      b.onclick = () => setTime(k); tg.appendChild(b);
    }
    $('tFlow').onclick = () => { H.sky.flowTime = !H.sky.flowTime; $('tFlow').classList.toggle('on', H.sky.flowTime); };
    const qg = $('qGrid');
    for (const k in QUALITY) {
      const b = document.createElement('button'); b.className = 'chip'; b.dataset.q = k; b.textContent = QUALITY[k].name;
      b.onclick = () => { quality = k; store.set('quality', k); applyQuality(); }; qg.appendChild(b);
    }
    $('sens').value = sens; $('sens').oninput = (e) => { sens = parseFloat(e.target.value); store.set('sens', sens); };
    $('vol').value = H.audio.volume = store.get('vol', 0.8); $('vol').oninput = (e) => { H.audio.setVolume(parseFloat(e.target.value)); store.set('vol', H.audio.volume); };
    $('startBtn').onclick = start;
    $('resumeBtn').onclick = () => { lock(); setPaused(false); };
  }
  function setPaused(p) {
    paused = p;
    $('menu').classList.toggle('show', p && started);
    $('hud').classList.toggle('dim', p);
  }
  let toastT = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); toastT = 2.4; }

  function start() {
    if (started) return;
    started = true;
    H.audio.init(); H.audio.setVolume(H.audio.volume);
    $('title').classList.add('hide');
    $('hud').classList.remove('hidden');
    // 封面是夜里下小雨；进游戏换回玩家自己选的天气和时间
    if (cover) {
      H.weather.set(H.weather.TYPES[wk] ? wk : 'clear', true); refreshWeatherUI();
      H.sky.hours = (TIMES[tk] || TIMES.day)[1];
    }
    player.pos.set(SPAWN_X, C.SY, -4); player.footY = player.pos.y; player.yaw = 0; player.pitch = -0.02; camera.fov = 72;
    lock();
    setPaused(false);
    toast('欢迎来到 404 高速路 · 走到车边按 F 上车 · C 召唤汽车 · B 召唤自行车');
    hintT = 14;
  }
  let hintT = 0;

  // ---------- 步行 ----------
  function walk(dt) {
    const p = player;
    p.yaw -= mouseDX * 0.0022 * sens; p.pitch -= mouseDY * 0.0022 * sens;
    p.pitch = H.clamp(p.pitch, -1.45, 1.45);
    const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const s = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const run = keys.ShiftLeft || keys.ShiftRight;
    const indoor = !!H.interior.indoor;
    const slow = 1 - (indoor ? 0 : H.weather.snowCover) * 0.25;
    const sp = (run ? 5.4 : 2.4) * slow;
    let vx = 0, vz = 0;
    if (f || s) {
      const l = Math.hypot(f, s);
      vx = (-Math.sin(p.yaw) * f + Math.cos(p.yaw) * s) / l * sp;
      vz = (-Math.cos(p.yaw) * f - Math.sin(p.yaw) * s) / l * sp;
    }
    // 地上跟手；空中保持起跳时的惯性，方向键只能慢慢修正（这样跳起来是斜着往前飞的抛物线）
    const ctl = p.onGround ? 10 : 1.4;
    p.vx = H.damp(p.vx || 0, vx, ctl, dt); p.vz = H.damp(p.vz || 0, vz, ctl, dt);
    p.pos.x += p.vx * dt; p.pos.z += p.vz * dt;
    H.world.collide(p.pos, 0.32, false, true);
    H.interior.collide(p.pos, 0.32);
    H.people.collide(p.pos, 0.3);
    H.veh.collideAgainst(p.pos, 0.3, null);
    // 跳 / 落地。脚下的面：地面、路缘（15cm 自动迈上去）、天桥台阶和桥面
    // 脚下的面：地面、路缘、天桥、楼里的地面和楼梯、能站的顶（长椅、矮墙、床、沙发坐面、茶几……只有步行的人能踩）
    const y0 = p.pos.y;
    const gy = H.world.surfaceY(p.pos.x, p.pos.z, y0, true);
    // 站在电梯轿厢里：起跳带上轿厢的速度，头顶不能穿过轿厢顶
    const plat = indoor ? H.interior.platform(p.pos.x, p.pos.z, y0) : null;
    if (keys.Space && p.onGround) {
      // 跳高：室外顶点约 1.15m，屋里（含阳台）约 0.64m。在不在屋里按当前位置现算（IN.indoor 是上一帧的）
      p.vy = (H.interior.indoorAt(p.pos) ? 3.92 : 5.27) + (plat ? plat.vy : 0); p.onGround = false;
      // 起跳那一下：水平速度直接到位（不等加速），往前蹬地再多给一点
      if (f || s) { p.vx = vx * 1.12; p.vz = vz * 1.12; }
    }
    // 竖直方向按匀加速精确积分：跳多高和帧率无关
    p.pos.y += p.vy * dt - 6 * dt * dt; p.vy -= 12 * dt;
    // 头顶限位：楼板、门楣、阳台板、公交亭顶棚、遮阳篷、门廊顶、天桥拱棚、电梯轿厢顶；绝不把人压到脚下的面以下
    let cy = H.world.ceilingY(p.pos.x, p.pos.z, y0);
    if (plat) cy = Math.min(cy, plat.top);
    if (p.pos.y + 1.75 > cy) { p.pos.y = Math.max(gy, cy - 1.75); p.vy = Math.min(p.vy, plat ? plat.vy : 0); }
    const wet = indoor ? 0 : H.weather.wet, snowy = indoor ? 0 : H.weather.snowCover;
    if (p.pos.y <= gy) { if (!p.onGround && p.vy < -2) H.audio.step(wet, snowy, true); p.pos.y = gy; p.vy = 0; p.onGround = true; }
    else if (p.onGround && p.pos.y - gy < 0.35) { p.pos.y = gy; p.vy = 0; } // 下台阶时贴着走，不一蹦一蹦
    else p.onGround = false; // 从高处走下去是在下落：不能空中再起跳，惯性照空中算
    p.footY = H.damp(p.footY, p.pos.y, 18, dt);
    const hs = Math.hypot(p.vx, p.vz);
    if (p.onGround && hs > 0.3) {
      p.bob += dt * hs * 2.6;
      p.stepAcc += hs * dt;
      if (p.stepAcc > (run ? 1.1 : 0.72)) { p.stepAcc = 0; H.audio.step(wet, snowy, run); }
    } else p.bob = H.damp(p.bob, Math.round(p.bob / Math.PI) * Math.PI, 6, dt);
    const bobY = Math.abs(Math.sin(p.bob)) * 0.045 * Math.min(1, hs / 2.4);
    camera.position.set(p.pos.x + Math.cos(p.yaw) * Math.sin(p.bob) * 0.015, p.footY + 1.62 + bobY, p.pos.z - Math.sin(p.yaw) * Math.sin(p.bob) * 0.015);
    camera.rotation.set(p.pitch, p.yaw, Math.sin(p.bob) * 0.004 * hs, 'YXZ');
    camera.fov = H.damp(camera.fov, run && hs > 3 ? 78 : 72, 4, dt);
  }

  // ---------- 开车 / 骑车的视角 ----------
  function look(dt, v, yawLim, pMin, pMax, pRest) {
    const p = player;
    if (mouseDX || mouseDY) p.idleLook = 0; else p.idleLook += dt;
    p.lookYaw -= mouseDX * 0.0022 * sens; p.lookPitch -= mouseDY * 0.0022 * sens;
    p.lookYaw = H.clamp(p.lookYaw, -yawLim, yawLim); p.lookPitch = H.clamp(p.lookPitch, pMin, pMax);
    if (p.idleLook > 1.6 && Math.abs(v.state.speed) > 3) { p.lookYaw = H.damp(p.lookYaw, 0, 1.5, dt); p.lookPitch = H.damp(p.lookPitch, pRest, 1.5, dt); }
  }
  function driveCam(dt) {
    const p = player, c = p.veh;
    look(dt, c, 2.1, -0.7, 0.55, -0.06);
    c.group.updateMatrixWorld(true);
    c.eyeWorld(tmpV);
    const sp = Math.abs(c.state.speed);
    let shake = Math.min(1, sp / 30) * 0.004 + (c.state.scrape ? 0.01 : 0);
    if (c.state.bump > 0) { shake += Math.min(0.05, c.state.bump * 0.004); H.audio.thunk(55, Math.min(0.6, c.state.bump * 0.05)); c.state.bump = 0; }
    tmpV.x += (Math.random() - 0.5) * shake; tmpV.y += (Math.random() - 0.5) * shake;
    camera.position.copy(tmpV);
    const lean = H.clamp(-(c.state.latAcc || 0) * 0.004, -0.04, 0.04);
    camera.rotation.set(p.lookPitch, c.state.yaw + p.lookYaw, lean, 'YXZ');
    camera.fov = H.damp(camera.fov, 68 + Math.min(12, sp * 0.3), 3, dt);
    p.pos.set(c.state.x, 0, c.state.z);
  }
  function rideCam(dt) {
    const p = player, b = p.veh;
    look(dt, b, 1.7, -1.15, 0.6, -0.12);
    b.eyeWorld(tmpV);
    if (b.state.bump > 0) { tmpV.y += (Math.random() - 0.5) * 0.04; H.audio.thunk(90, Math.min(0.4, b.state.bump * 0.06)); b.state.bump = 0; }
    camera.position.copy(tmpV);
    camera.rotation.set(p.lookPitch, b.state.yaw + p.lookYaw, b.state.lean * 0.55, 'YXZ');
    camera.fov = H.damp(camera.fov, 72 + Math.min(6, Math.abs(b.state.speed) * 0.6), 3, dt);
    p.pos.set(b.state.x, b.state.y, b.state.z);
  }

  // ---------- 浮动原点 ----------
  function maybeRebase() {
    const z = player.veh ? player.veh.state.z : player.pos.z;
    if (Math.abs(z) < 1024) return;
    const dz = -Math.round(z / 64) * 64;
    H.world.rebase(dz); H.people.rebase(dz); H.veh.rebase(dz); H.weather.rebase(dz);
    player.pos.z += dz; camera.position.z += dz; attract.z += dz;
  }

  // ---------- 主循环 ----------
  const attract = { z: 0, t: 0 };
  const shelter = new THREE.Vector4();
  const near = [];
  let last = performance.now(), lampT = 0, fpsAcc = 0, fpsN = 0, fps = 0, hudT = 0;
  const wctx = { light: 1, pxScale: 600, groundY: H.world.groundY, surfaceY: H.veh.surfaceY, shelter, rooms: H.interior.boxes, inside: H.interior.inside };
  const pedPlayer = new THREE.Vector3();

  function frame(now) { requestAnimationFrame(frame); tick(now); }
  function tick(now) {
    let dt = H.clamp((now - last) / 1000, 0, 0.05); last = now;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    const realDt = dt;
    if (started && paused) dt = 0;
    const k = keys;
    const env = { wet: H.weather.wet, snow: H.weather.snowCover, hail: H.weather.hailCover };

    if (!started) {
      attract.t += realDt;
      if (cover) {
        // 封面：站在 K403+997 那间客厅里，镜头只有呼吸一样的轻微晃动
        player.pos.copy(cover.pos); player.footY = cover.pos.y;
        camera.position.set(cover.pos.x, cover.pos.y + 1.62 + Math.sin(attract.t * 0.6) * 0.004, cover.pos.z);
        // 构图是按 2:1 调的（电视右边框在视线右边约 55°）：屏幕窄时把竖直视角放宽（最多 95°），还装不下就往电视那边转
        const tanV = Math.max(Math.tan(36 * Math.PI / 180), 1.45 / camera.aspect);
        camera.fov = Math.min(95, Math.atan(tanV) * 360 / Math.PI);
        const halfH = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect), turn = Math.max(0, Math.atan(1.45) - halfH);
        camera.rotation.set(cover.pitch + Math.sin(attract.t * 0.23) * 0.004, cover.yaw - turn + Math.sin(attract.t * 0.17) * 0.008, 0, 'YXZ');
      } else {
        // 标题画面（封面那栋楼没找到时）：镜头沿着路慢慢往前飘
        attract.z -= realDt * 7;
        camera.position.set(-1.8 + Math.sin(attract.t * 0.2) * 0.5, 1.9 + Math.sin(attract.t * 0.5) * 0.08, attract.z);
        camera.rotation.set(-0.03, Math.sin(attract.t * 0.13) * 0.25, 0, 'YXZ');
        player.pos.z = attract.z;
      }
      dt = realDt;
    } else if (!paused) {
      if (inCar()) {
        player.veh.drive(dt, { up: k.KeyW || k.ArrowUp, down: k.KeyS || k.ArrowDown, left: k.KeyA || k.ArrowLeft, right: k.KeyD || k.ArrowRight, brake: k.Space }, env);
        driveCam(dt);
      } else if (onBike()) {
        player.veh.ride(dt, { up: k.KeyW || k.ArrowUp, down: k.KeyS || k.ArrowDown, left: k.KeyA || k.ArrowLeft, right: k.KeyD || k.ArrowRight, sprint: k.ShiftLeft || k.ShiftRight }, env);
        rideCam(dt);
      } else walk(dt);
    }
    mouseDX = 0; mouseDY = 0;
    camera.updateProjectionMatrix();
    maybeRebase();
    H.veh.update(dt, camera.position, player.veh);

    // 世界生成；走近公寓 / 商铺时把楼"打开"（现场生成室内）
    H.world.update(camera.position.z, camera.position, started ? 5 : 8);
    const pv0 = player.veh;
    H.interior.update(dt, camera.position, pv0 ? tmpV2.set(pv0.state.x, pv0.state.y || 0, pv0.state.z) : player.pos, (started || !!cover) && !pv0);
    // 天气 + 天空
    const lightLevel = H.clamp((H.sky.hemi.intensity * 0.6 + H.sky.sun.intensity * 0.18), 0.12, 1);
    wctx.light = lightLevel;
    wctx.pxScale = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    if (inCar()) shelter.set(player.veh.state.x, 1.6, player.veh.state.z, 1.15); else shelter.set(0, 0, 0, 0);
    H.weather.update(dt, camera.position, wctx);
    const wo = H.weather.out;
    wo.fog = Math.min(wo.fog, H.world.drawDist + 20);
    H.sky.update(dt, wo, tmpV2.copy(camera.position).setY(0));
    H.sky.follow(camera);
    // 闪电 -> 雷声
    while (H.weather.strikes.length) { const s = H.weather.strikes.shift(); H.audio.thunder(s.dist, s.cloudOnly); }
    if (H.weather.impacts) H.audio.hailTicks(Math.ceil(H.weather.impacts * 0.25), H.weather.carImpacts > 0 && inCar(), inCar());

    // 夜灯
    const lo = H.sky.lightsOn, L = H.mat.list;
    L.win.emissiveIntensity = 0.12 + lo * 1.25;
    H.detail.setLight(lightLevel, lo);
    L.curtain.emissiveIntensity = lo * 0.95;
    L.sign.emissiveIntensity = 0.1 + lo * 1.4;
    L.gantry.emissiveIntensity = 0.04 + lo * 0.45;
    L.bridgesign.emissiveIntensity = 0.04 + lo * 0.6;
    L.lamp.emissiveIntensity = 0.25 + lo * 5;
    L.pool.opacity = lo * 0.5;
    L.red.emissiveIntensity = 0.3 + lo * (Math.sin(now * 0.004) > 0 ? 3 : 0.2);
    renderer.toneMappingExposure = 1.0 + H.sky.night * 0.2;
    lampT -= realDt;
    if (lampT <= 0) {
      lampT = 0.3;
      H.world.nearLamps(camera.position, QUALITY[quality].lamps, near);
      lampLights.forEach((l, i) => { if (near[i]) l.position.set(near[i].x, near[i].y - 0.3, near[i].z); });
    }
    lampLights.forEach((l, i) => { l.intensity = i < near.length ? lo * 2.0 : 0; });
    if (started && lo > 0.5 && H.veh.bikeLight === undefined) H.veh.bikeLight = true;

    // 车
    for (const v of H.veh.list) if (v.type === 'car') v.updateLights(lo);
    if (inCar()) {
      const c = player.veh;
      c.updateGlass(dt || 0.0001, { rain: H.weather.rainAmt, hail: H.weather.hailAmt, snow: H.weather.snowAmt, light: lightLevel });
      c.updateDash(realDt, { km: H.world.km(c.state.z), weather: H.weather.TYPES[H.weather.target].name, icon: H.weather.TYPES[H.weather.target].icon, clock: clockText() });
    }

    // 行人（骑车时也会给你让路；开车时不在人行道上）
    const pv = player.veh;
    if (inCar()) pedPlayer.set(999, 0, 999); else if (pv) pedPlayer.set(pv.state.x, pv.state.y, pv.state.z); else pedPlayer.copy(player.pos);
    H.people.update(dt, camera.position, {
      player: pedPlayer, playerWalking: !pv,
      precip: H.weather.rainAmt + H.weather.hailAmt * 0.8 + H.weather.snowAmt * 0.6, hail: H.weather.hailAmt, wind: H.weather.windVec,
    });

    // 声音
    H.audio.update(realDt, {
      rain: H.weather.rainAmt + H.weather.hailAmt * 0.25, wind: H.weather.cur.wind, inCar: (inCar() || !!H.interior.indoor) && started,
      speed: inCar() ? pv.state.speed : 0, throttle: inCar() ? pv.state.throttle : 0, engineOn: inCar() && started && !paused, scrape: inCar() ? pv.state.scrape : 0,
      bike: onBike() && !paused ? Math.abs(pv.state.speed) : 0, pedaling: onBike() && pv.state.pedaling, indoor: !!H.interior.indoor,
      day: H.sky.night < 0.3, clear: H.weather.rainAmt + H.weather.snowAmt + H.weather.hailAmt < 0.02 && H.weather.cur.overcast < 0.5,
    });

    // HUD
    hudT -= realDt;
    if (toastT > 0) { toastT -= realDt; if (toastT <= 0) $('toast').classList.remove('show'); }
    // 空气墙：墙本身看不见，走到跟前时把"加载失败"显示在屏幕上
    const px = player.veh ? player.veh.state.x : player.pos.x;
    $('wallMsg').classList.toggle('show', started && !paused && !inCar() && H.world.WALL - Math.abs(px) < 1.3);
    if (started && hudT <= 0) { hudT = 0.1; updateHUD(); }
    renderer.render(scene, camera);
  }
  H.veh.onWiperEnd = () => { if (inCar()) H.audio.wiper(); };

  function clockText() {
    const h = Math.floor(H.sky.hours), m = Math.floor((H.sky.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  function updateHUD() {
    const t = H.weather.TYPES[H.weather.target], v = player.veh;
    $('hWeather').textContent = `${t.icon} ${t.name}${H.weather.auto ? ' · 自动' : ''}`;
    $('hClock').textContent = clockText();
    $('hKm').textContent = H.world.km(v ? v.state.z : player.pos.z);
    $('hSpeed').textContent = v ? `${Math.round(Math.abs(v.state.speed) * 3.6)} km/h` : '';
    $('fps').textContent = `${fps} FPS`;
    let hint = '';
    if (inCar()) hint = hintT > 0 ? 'W 油门 · S 刹车/倒车 · A/D 转向 · 空格 手刹 · H 喇叭 · L 车灯 · V 雨刮 · F 下车' : '';
    else if (onBike()) hint = hintT > 0 ? 'W 蹬车 · S 刹车 · A/D 转向 · Shift 冲刺 · H 车铃 · L 车灯 · F 下车' : '';
    else {
      const ia = H.interior.aim(camera);
      const ref = H.interior.indoor ? null : H.veh.nearest(player.pos);
      if (ia) hint = ia;
      else if (ref) {
        const kind = ref.v ? ref.v.type : ref.p.kind;
        hint = kind === 'car' ? '按 F 上车' : '按 F 骑车';
      } else if (hintT > 0) hint = 'WASD 走路 · Shift 跑 · E 开门 · C 召唤汽车 · B 召唤自行车 · 1–8 天气 · T 时间 · Esc 菜单';
      $('cross').classList.toggle('aim', !!ia);
    }
    hintT -= 0.1;
    $('hint').textContent = hint; $('hint').classList.toggle('show', !!hint);
    $('cross').style.display = v ? 'none' : 'block';
  }

  // ---------- 启动 ----------
  buildUI();
  resize();
  const wk = store.get('weather', 'clear');
  H.weather.set(H.weather.TYPES[wk] ? wk : 'clear', true);
  refreshWeatherUI();
  const tk = store.get('time', 'day');
  H.sky.hours = (TIMES[tk] || TIMES.day)[1];
  document.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tk));
  // 初始几块同步生成，避免第一眼看到空地
  H.world.drawDist = QUALITY[quality].dist;
  H.detail.radius = QUALITY[quality].detail;
  H.sky.setShadowSize(QUALITY[quality].shadow);
  document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === quality));
  const t0 = performance.now();
  H.world.drawDist = 200; H.world.update(0, camera.position, 0, true); H.world.drawDist = QUALITY[quality].dist;
  H.people.populate(QUALITY[quality].peds, 0);
  console.log('初始生成耗时', Math.round(performance.now() - t0), 'ms');
  // 封面：K403+997 那间公寓客厅，夜里下小雨（这栋楼先同步生成好再撤掉加载画面）
  const cover = H.interior.cover();
  if (cover) {
    H.weather.set('drizzle', true); H.sky.hours = 22;
    $('coverTag').textContent = `${cover.km} 公寓的房间`;
  }
  $('loading').classList.add('hide');
  $('startBtn').disabled = false;
  // 调试：把当前画面存到 tools/shots/（只在本地服务器下有效）
  function shot(name) {
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/jpeg', 0.88);
    return fetch('/__shot?name=' + encodeURIComponent(name || 'shot'), { method: 'POST', body: url }).then((r) => r.text());
  }
  // 调试：快进若干秒（不等真实时间）
  function step(sec, fdt = 1 / 30) { const n = Math.round(sec / fdt); for (let i = 0; i < n; i++) tick(last + fdt * 1000); last = performance.now(); }
  window.__h404 = { cover, renderer, scene, camera, player, setWeather, setTime, start, shot, step, keys, useVehicle, summon, quality: () => quality, interior: H.interior };
  requestAnimationFrame(frame);
})();
