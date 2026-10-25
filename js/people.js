// 行人：分段骨架小人（大腿/小腿/脚、上臂/前臂/手、骨盆/躯干/脖子/头），有五官、发型、服装和配饰。
// 每种部件一个实例化网格；骨架每帧在 CPU 上按关节角度连乘矩阵。会靠右走、互相让路、下雨打伞、没伞小跑、按喇叭挥手、走天桥过街。
'use strict';
(function () {
  const PP = H.people = {};
  const C = () => H.world.C;
  PP.list = [];

  const SKIN = ['#f6d7bf', '#efc4a2', '#e2b08a', '#c98f69', '#a86f4c', '#f3cdb0', '#d9a07a'];
  const HAIR = ['#1d1a18', '#2e2420', '#4a3426', '#6b4a32', '#8d8a86', '#b5773f', '#d8b06a', '#2a2a3a', '#7a3b2e'];
  const TOPS = ['#e85d4a', '#3b6fb6', '#f2a33a', '#3a9d5d', '#8a5cc2', '#f4f1ea', '#2b2f36', '#e0699a', '#1f9aa5', '#d9c27a', '#7fb8e6', '#c64f6b', '#f7f3e8', '#6b8e4e', '#ffcf5c'];
  const SHIRTS = ['#ffffff', '#f4f1ea', '#cfe0f2', '#f6e3e8', '#e6f0dc'];
  const JACKET = ['#2f3e5c', '#6b4f3a', '#3c4f3a', '#8a2f2f', '#2b2f36', '#c9a26b', '#4a6b8a', '#d0d4d8', '#b5523b'];
  const PANTS = ['#2f3e5c', '#1f2328', '#6b5a45', '#8a8f96', '#3c4f3a', '#4a5f86', '#d8cdb8', '#5a4a6a'];
  const DENIM = ['#3d5a80', '#2f4766', '#5b7aa3', '#22324a'];
  const SKIRT = ['#e85d4a', '#3b6fb6', '#f2a33a', '#8a5cc2', '#2b2f36', '#e0699a', '#1f9aa5', '#f4e1c1', '#7a9a5a'];
  const SHOES = ['#f2f2f2', '#22252a', '#6b4a32', '#c0392b', '#3b6fb6', '#e8d5b0'];
  const BAGS = ['#3b3f45', '#8a5a3c', '#c0392b', '#2f6fb5', '#d39a3a', '#5a7a4a', '#e0699a', '#f2a33a'];
  const UMB = ['#e84a3c', '#ffd23f', '#2f80ed', '#27ae60', '#ff7eb6', '#8e5cff', '#1abc9c', '#ff9f1c', '#e8f1f8'];

  // ---------- 几何 ----------
  const V2 = (r, y) => new THREE.Vector2(r, y);
  function lathe(pts, seg, sx = 1, sz = 1) {
    const g = new THREE.LatheGeometry(pts.map(([r, y]) => V2(r, y)), seg);
    if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
    return g;
  }
  const ni = (g) => (g.index ? g.toNonIndexed() : g);
  function merge(list) { return THREE.BufferGeometryUtils.mergeBufferGeometries(list.map(ni)); }
  function at(g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    g = g.clone();
    if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return g;
  }
  function flatUV(g, u, v) { const a = g.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u, v); return g; }
  const sph = (r, ws = 14, hs = 10, ps = 0, pl = Math.PI * 2, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl);
  // 鞋：圆角盒，脚尖收窄、压低
  function shoeGeo(w, h, l, r, y0) {
    const g = H.roundedBox(w, h, l, r, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i), t = H.clamp((z + 0.02) / (l / 2), 0, 1);
      p.setX(i, p.getX(i) * (1 - 0.24 * t * t));
      if (p.getY(i) > 0) p.setY(i, p.getY(i) - 0.024 * t);
    }
    g.computeVertexNormals();
    g.translate(0, y0, 0.045);
    return g;
  }

  function buildGeos() {
    const G = {};
    G.thigh = lathe([[0, -0.445], [0.035, -0.44], [0.056, -0.415], [0.061, -0.36], [0.072, -0.22], [0.082, -0.1], [0.086, -0.03], [0.072, 0.02], [0.036, 0.05], [0, 0.056]], 14);
    G.shin = lathe([[0, -0.43], [0.03, -0.425], [0.038, -0.385], [0.045, -0.3], [0.061, -0.15], [0.063, -0.09], [0.058, -0.03], [0.046, 0.01], [0, 0.03]], 14, 1, 0.92);
    G.uarm = lathe([[0, -0.3], [0.03, -0.295], [0.04, -0.27], [0.044, -0.17], [0.049, -0.06], [0.054, 0], [0.046, 0.04], [0, 0.056]], 12);
    G.farm = lathe([[0, -0.27], [0.022, -0.265], [0.029, -0.245], [0.034, -0.18], [0.041, -0.06], [0.042, -0.01], [0.031, 0.02], [0, 0.03]], 12, 1, 0.86);
    // 手：扁的手掌 + 朝前的拇指（左右手对称，不用镜像）
    G.hand = merge([at(sph(1, 12, 10), 0, -0.07, 0, 0, 0, 0, 0.026, 0.07, 0.044), at(sph(1, 8, 6), 0, -0.04, 0.034, -0.5, 0, 0, 0.015, 0.032, 0.015)]);
    G.pelvis = lathe([[0, -0.13], [0.07, -0.125], [0.12, -0.09], [0.15, -0.03], [0.155, 0.03], [0.14, 0.09], [0.12, 0.11], [0, 0.115]], 18, 1.15, 0.78);
    G.torso = lathe([[0, -0.03], [0.125, -0.02], [0.12, 0.06], [0.134, 0.16], [0.152, 0.27], [0.163, 0.36], [0.16, 0.42], [0.14, 0.47], [0.1, 0.51], [0.055, 0.54], [0, 0.546]], 20, 1.17, 0.74);
    G.neck = lathe([[0, -0.01], [0.046, -0.01], [0.044, 0.06], [0.041, 0.11], [0, 0.112]], 12);
    // 头：脸贴图只在球面上，耳朵和鼻子的 UV 指到后脑（白色区域）
    G.head = merge([
      at(sph(0.1, 28, 20), 0, 0, 0, 0, 0, 0, 0.9, 1.08, 0.96),
      flatUV(at(sph(1, 10, 8), 0.087, -0.006, -0.004, 0, 0, 0, 0.011, 0.024, 0.019), 0.75, 0.5),
      flatUV(at(sph(1, 10, 8), -0.087, -0.006, -0.004, 0, 0, 0, 0.011, 0.024, 0.019), 0.75, 0.5),
      flatUV(at(sph(1, 10, 8), 0, -0.02, 0.092, 0, 0, 0, 0.013, 0.016, 0.015), 0.75, 0.5),
    ]);
    G.shoe = shoeGeo(0.1, 0.07, 0.25, 0.034, -0.042);
    G.sole = shoeGeo(0.106, 0.018, 0.258, 0.008, -0.083);
    // 服装
    G.collar = at(new THREE.TorusGeometry(0.062, 0.015, 6, 18), 0, 0.505, -0.004, Math.PI / 2, 0, 0, 1.05, 1, 0.88);
    G.belt = at(new THREE.TorusGeometry(0.128, 0.012, 5, 26), 0, 0.0, 0, Math.PI / 2, 0, 0, 1.17, 1, 0.77);
    G.front = H.roundedBox(0.075, 0.4, 0.02, 0.008, 1); G.front.translate(0, 0.27, 0.111);
    G.hood = at(sph(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), 0, 0.47, -0.095, -0.9, 0, 0, 1.05, 0.7, 0.62);
    G.skirt = lathe([[0, -0.37], [0.21, -0.37], [0.205, -0.33], [0.17, -0.18], [0.145, -0.05], [0.136, 0.02], [0, 0.03]], 20, 1.12, 0.88);
    G.dress = lathe([[0, -0.6], [0.27, -0.6], [0.265, -0.56], [0.2, -0.34], [0.155, -0.12], [0.137, 0.02], [0, 0.03]], 20, 1.12, 0.92);
    G.backpack = merge([
      at(H.roundedBox(0.27, 0.34, 0.11, 0.045, 2), 0, 0.28, -0.17),
      at(H.roundedBox(0.2, 0.12, 0.04, 0.02, 1), 0, 0.2, -0.235),
      at(H.roundedBox(0.034, 0.32, 0.014, 0.006, 1), 0.085, 0.3, 0.112),
      at(H.roundedBox(0.034, 0.32, 0.014, 0.006, 1), -0.085, 0.3, 0.112),
    ]);
    G.xbag = merge([
      at(H.roundedBox(0.03, 0.64, 0.012, 0.005, 1), 0, 0.26, 0.118, 0, 0, 0.72),
      at(H.roundedBox(0.03, 0.62, 0.012, 0.005, 1), 0, 0.26, -0.118, 0, 0, -0.72),
      at(H.roundedBox(0.19, 0.15, 0.065, 0.026, 2), -0.2, -0.02, 0.05),
    ]);
    G.handbag = merge([
      at(H.roundedBox(0.24, 0.18, 0.09, 0.032, 2), 0, -0.17, 0),
      at(new THREE.TorusGeometry(0.06, 0.008, 5, 12, Math.PI), 0, -0.08, 0),
    ]);
    // 发型（以头中心为原点）
    const cap = (tl, tilt, r = 0.105) => at(sph(r, 26, 12, 0, Math.PI * 2, 0, tl), 0, 0.004, -0.006, -tilt, 0, 0, 0.93, 1.1, 1.0);
    const band = (t0, tl, r = 0.109) => at(sph(r, 26, 10, Math.PI / 2 + 0.36 * Math.PI, Math.PI * 2 - 0.72 * Math.PI, t0, tl), 0, 0.004, -0.004, 0, 0, 0, 0.95, 1.1, 1.0);
    G.hair_short = cap(Math.PI * 0.52, 0.3);
    G.hair_side = merge([cap(Math.PI * 0.52, 0.28), at(sph(1, 12, 8), 0.035, 0.07, 0.07, 0, 0, -0.4, 0.06, 0.028, 0.04)]);
    G.hair_bob = merge([cap(Math.PI * 0.5, 0.25, 0.107), band(Math.PI * 0.42, Math.PI * 0.33)]);
    G.hair_long = merge([cap(Math.PI * 0.5, 0.25, 0.107), band(Math.PI * 0.42, Math.PI * 0.44), at(sph(1, 14, 10), 0, -0.15, -0.07, 0.15, 0, 0, 0.1, 0.19, 0.045)]);
    G.hair_pony = merge([cap(Math.PI * 0.52, 0.32), at(sph(0.022, 8, 6), 0, 0.02, -0.105), at(new THREE.CapsuleGeometry(0.032, 0.15, 4, 8), 0, -0.07, -0.14, 0.45)]);
    G.hair_bun = merge([cap(Math.PI * 0.52, 0.3), at(sph(0.048, 12, 10), 0, 0.085, -0.075)]);
    G.cap = merge([at(sph(0.108, 26, 10, 0, Math.PI * 2, 0, Math.PI * 0.44), 0, 0.014, 0, 0, 0, 0, 0.95, 1.05, 1.0),
      at(new THREE.CylinderGeometry(0.07, 0.072, 0.01, 18), 0, 0.044, 0.09, 0.12, 0, 0, 1.05, 1, 1.3)]);
    // 伞：八根伞骨的八角伞面 + 顶珠
    G.canopy = merge([lathe([[0.6, -0.02], [0.56, 0.1], [0.44, 0.2], [0.26, 0.27], [0, 0.3]], 8), at(sph(0.025, 8, 6), 0, 0.31, 0)]);
    G.stick = new THREE.CylinderGeometry(0.011, 0.011, 1, 6);
    return G;
  }

  // ---------- 脸贴图：4 种表情（最后一种戴眼镜），白底，乘以肤色 ----------
  function faceTexture() {
    const W = 512, Hh = 256, c = document.createElement('canvas'); c.width = W; c.height = Hh * 4;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, Hh * 4);
    for (let i = 0; i < 4; i++) {
      const oy = i * Hh, cx = 128, ey = oy + 134;
      // 腮红
      x.fillStyle = 'rgba(255,135,135,0.28)';
      for (const sd of [-1, 1]) { x.beginPath(); x.ellipse(cx + sd * 46, ey + 26, 12, 9, 0, 0, 7); x.fill(); }
      // 眉毛
      x.strokeStyle = 'rgba(70,50,40,0.85)'; x.lineWidth = 4.5; x.lineCap = 'round';
      for (const sd of [-1, 1]) { x.beginPath(); x.moveTo(cx + sd * 18, ey - 22); x.quadraticCurveTo(cx + sd * 29, ey - 28 - (i === 2 ? 3 : 0), cx + sd * 40, ey - 22); x.stroke(); }
      // 眼睛
      for (const sd of [-1, 1]) {
        x.fillStyle = '#231b18'; x.beginPath(); x.ellipse(cx + sd * 29, ey, 7.5, 11, 0, 0, 7); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.95)'; x.beginPath(); x.arc(cx + sd * 29 - 2.5, ey - 4, 2.6, 0, 7); x.fill();
      }
      // 嘴
      x.strokeStyle = '#b4544a'; x.lineWidth = 4;
      if (i === 1) { x.fillStyle = '#b4544a'; x.beginPath(); x.ellipse(cx, ey + 40, 6, 5, 0, 0, 7); x.fill(); }
      else if (i === 2) { x.beginPath(); x.moveTo(cx - 9, ey + 40); x.lineTo(cx + 9, ey + 40); x.stroke(); }
      else { x.beginPath(); x.arc(cx, ey + 32, 12, 0.25 * Math.PI, 0.75 * Math.PI); x.stroke(); }
      if (i === 3) {
        x.strokeStyle = '#2b2b30'; x.lineWidth = 3.5;
        for (const sd of [-1, 1]) { x.beginPath(); x.roundRect(cx + sd * 29 - 15, ey - 13, 30, 26, 8); x.stroke(); }
        x.beginPath(); x.moveTo(cx - 14, ey - 4); x.lineTo(cx + 14, ey - 4); x.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = H.maxAniso || 4;
    return t;
  }

  // 部件：几何、材质、每人最多几个
  let G = null;
  const parts = {};
  const PER = {
    pelvis: 1, torso: 1, neck: 1, head: 1, thigh: 2, shin: 2, shoe: 2, sole: 2, uarm: 2, farm: 2, hand: 2,
    collar: 1, belt: 1, front: 1, hood: 1, skirt: 1, dress: 1, backpack: 1, xbag: 1, handbag: 1,
    hair_short: 1, hair_side: 1, hair_bob: 1, hair_long: 1, hair_pony: 1, hair_bun: 1, cap: 1, canopy: 1, stick: 1,
  };
  function makeParts(scene, max) {
    G = buildGeos();
    PP.G = G;
    const fab = H.tex.plaster.clone(); fab.needsUpdate = true; fab.repeat.set(3, 3);
    const M = {
      cloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, map: fab }),
      skin: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }),
      head: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, map: faceTexture() }),
      hair: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, side: THREE.DoubleSide }),
      shoe: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }),
      bag: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }),
      umb: H.mat.patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, side: THREE.DoubleSide })),
    };
    // 每个人一张脸：实例属性 aFace 选图集里的哪一行
    M.head.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFace;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_UV\nvUv.y = (vUv.y + 3.0 - aFace) * 0.25;\n#endif');
    };
    const MAT = {
      pelvis: 'cloth', torso: 'cloth', neck: 'skin', head: 'head', thigh: 'cloth', shin: 'cloth', shoe: 'shoe', sole: 'shoe',
      uarm: 'cloth', farm: 'cloth', hand: 'skin', collar: 'cloth', belt: 'bag', front: 'cloth', hood: 'cloth', skirt: 'cloth', dress: 'cloth',
      backpack: 'bag', xbag: 'bag', handbag: 'bag', cap: 'cloth', canopy: 'umb', stick: 'shoe',
    };
    for (const k in PER) {
      const geo = G[k];
      if (k === 'head') { geo.setAttribute('aFace', new THREE.InstancedBufferAttribute(new Float32Array(max), 1)); }
      const m = new THREE.InstancedMesh(geo, M[MAT[k] || 'hair'], max * PER[k]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false; m.count = 0;
      m.setColorAt(0, new THREE.Color());
      scene.add(m);
      parts[k] = m;
    }
  }

  // ---------- 外貌 ----------
  function randomize(p, rng, i) {
    p.kid = rng.chance(0.1);
    p.fem = rng.chance(0.5);
    p.s = p.kid ? rng.range(0.6, 0.7) : rng.range(0.9, 1.01);
    p.hs = p.kid ? 1.22 : 1;
    p.width = p.kid ? 0.92 : (p.fem ? rng.range(0.88, 1.0) : rng.range(0.97, 1.1));
    p.skin = new THREE.Color(rng.pick(SKIN)); p.hairC = new THREE.Color(rng.pick(HAIR));
    const roll = rng();
    let outfit;
    if (p.fem) outfit = roll < 0.2 ? 'tee' : roll < 0.42 ? 'skirt' : roll < 0.6 ? 'dress' : roll < 0.8 ? 'jacket' : 'hoodie';
    else outfit = roll < 0.33 ? 'tee' : roll < 0.52 ? 'shirt' : roll < 0.72 ? 'jacket' : roll < 0.88 ? 'hoodie' : 'shorts';
    p.outfit = outfit;
    const top = new THREE.Color(outfit === 'jacket' ? rng.pick(JACKET) : outfit === 'shirt' ? rng.pick(SHIRTS) : rng.pick(TOPS));
    p.top = top;
    p.top2 = outfit === 'jacket' ? new THREE.Color(rng.pick(SHIRTS)) : outfit === 'hoodie' ? top.clone().offsetHSL(0, 0, -0.12) : top.clone().offsetHSL(0, -0.05, 0.08);
    p.legs = new THREE.Color(outfit === 'tee' || outfit === 'shorts' ? rng.pick(DENIM) : rng.pick(PANTS));
    p.skirtC = new THREE.Color(outfit === 'dress' ? rng.pick(TOPS) : rng.pick(SKIRT));
    if (outfit === 'dress') p.top = p.skirtC.clone();
    p.shortSleeve = outfit === 'tee' || outfit === 'shorts' || (outfit === 'dress' && rng.chance(0.6));
    p.bareShin = outfit === 'shorts' || outfit === 'skirt' || outfit === 'dress';
    p.shoe = new THREE.Color(rng.pick(SHOES));
    p.soleC = new THREE.Color(p.shoe.getHex() === 0xf2f2f2 ? '#d9d9d9' : '#f2f0ea');
    p.bagC = new THREE.Color(rng.pick(BAGS));
    p.umbC = new THREE.Color(rng.pick(UMB));
    const hr = rng();
    p.hair = p.fem ? (hr < 0.28 ? 'hair_bob' : hr < 0.58 ? 'hair_long' : hr < 0.84 ? 'hair_pony' : 'hair_bun')
      : (hr < 0.55 ? 'hair_short' : hr < 0.85 ? 'hair_side' : 'hair_short');
    p.cap = !p.fem && rng.chance(0.14) || p.kid && rng.chance(0.25);
    p.bag = p.kid ? (rng.chance(0.7) ? 'backpack' : null) : (roll < 0.5 ? (rng.chance(0.3) ? 'backpack' : rng.chance(0.4) ? 'xbag' : (p.fem && rng.chance(0.4) ? 'handbag' : null)) : (rng.chance(0.25) ? 'backpack' : null));
    p.face = rng.chance(0.15) ? 3 : rng.int(0, 2);
    p.hasUmb = rng.chance(0.72);
    p.baseSpeed = (p.kid ? 0.95 : 1.0) * rng.range(1.05, 1.45);
    p.seed = rng() * 100;
    parts.head.geometry.attributes.aFace.setX(i, p.face);
    parts.head.geometry.attributes.aFace.needsUpdate = true;
  }

  PP.init = function (scene, max) { PP.max = max; makeParts(scene, max); PP.rng = H.rng(2024); };

  function spawn(p, camZ, rng, anywhere) {
    const side = rng.chance(0.5) ? 1 : -1;
    p.side = side; p.dir = rng.chance(0.5) ? 1 : -1;
    const R = PP.range;
    p.z = anywhere ? camZ + rng.range(-R, R) : camZ + (rng.chance(0.5) ? 1 : -1) * rng.range(R * 0.7, R);
    p.lane = rng.range(-0.35, 0.35);
    p.x = side * (C().PED_MID + p.lane); p.y = C().SY;
    p.phase = rng() * 10; p.state = 'walk'; p.timer = rng.range(8, 40); p.wave = 0; p.waveCD = 0; p.bridgeCD = 0;
    p.umbOpen = 0; p.speed = p.baseSpeed; p.yaw = p.dir > 0 ? 0 : Math.PI; p.path = null;
  }

  PP.populate = function (count, camZ) {
    PP.range = 190;
    PP.list.length = 0;
    const rng = PP.rng;
    for (let i = 0; i < Math.min(count, PP.max); i++) { const p = {}; randomize(p, rng, i); spawn(p, camZ, rng, true); PP.list.push(p); }
  };

  PP.honk = function (pos) {
    for (const p of PP.list) {
      if (Math.hypot(p.x - pos.x, p.z - pos.z) < 22 && p.waveCD <= 0) { p.wave = 1.8; p.waveCD = 6; }
    }
  };

  // ---------- 骨架矩阵 ----------
  const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _sv = new THREE.Vector3();
  const TMP = new THREE.Matrix4(), OUT = new THREE.Matrix4(), SC = new THREE.Matrix4();
  const B = new THREE.Matrix4(), PEL = new THREE.Matrix4(), TOR = new THREE.Matrix4(), NECK = new THREE.Matrix4(), HEAD = new THREE.Matrix4();
  const TH = new THREE.Matrix4(), SH = new THREE.Matrix4(), FT = new THREE.Matrix4(), UA = new THREE.Matrix4(), FA = new THREE.Matrix4(), HN = new THREE.Matrix4();
  const HANDW = [new THREE.Vector3(), new THREE.Vector3()];
  function child(out, parent, x, y, z, ax, ay, az, order) {
    _e.set(ax, ay, az, order || 'XYZ'); _q.setFromEuler(_e);
    TMP.compose(_v.set(x, y, z), _q, _one);
    return out.multiplyMatrices(parent, TMP);
  }
  let counters = {};
  function emit(k, m, col, sx, sy, sz) {
    const im = parts[k], i = counters[k]++;
    if (sx !== undefined) { SC.makeScale(sx, sy, sz); OUT.multiplyMatrices(m, SC); im.setMatrixAt(i, OUT); }
    else im.setMatrixAt(i, m);
    im.setColorAt(i, col);
  }
  const UP = new THREE.Vector3(0, 1, 0);
  const STICK = new THREE.Color('#2b2b2e');

  function pose(p, t, wind) {
    const s = p.s;
    const mv = H.clamp(p.speed / 1.25, 0, 1);
    const run = p.speed > 1.95;
    // 穿裙子的人步子小一点，腿不会把裙摆顶穿
    const skirtK = p.outfit === 'dress' ? 0.55 : p.outfit === 'skirt' ? 0.75 : 1;
    const Ah = (run ? 0.62 : 0.4) * mv * skirtK, Ak = (run ? 1.35 : 0.72) * mv * skirtK, Aa = (run ? 0.7 : 0.36) * mv;
    const ph = p.phase;
    const bob = -(run ? 0.05 : 0.026) * mv * (1 - Math.cos(2 * ph)) / 2;
    const lean = run ? 0.16 : 0.03 * mv;
    const idle = 1 - mv;
    const headYaw = idle * 0.45 * Math.sin(t * 0.37 + p.seed) * Math.sin(t * 0.13 + p.seed * 2);
    _q.setFromAxisAngle(UP, p.yaw);
    B.compose(_v.set(p.x, p.y, p.z), _q, _sv.set(s, s, s));
    child(PEL, B, 0, 0.95 + bob, 0, 0, 0.09 * Math.sin(ph) * mv, 0.03 * Math.sin(ph) * mv, 'YZX');
    const dressed = p.outfit === 'dress';
    emit('pelvis', PEL, dressed ? p.skirtC : (p.outfit === 'skirt' ? p.skirtC : p.legs), p.width, 1, 1);
    if (p.outfit === 'skirt') emit('skirt', PEL, p.skirtC, p.width, 1, 1);
    if (dressed) emit('dress', PEL, p.skirtC, p.width, 1, 1);
    child(TOR, PEL, 0, 0.1, 0, lean, -0.12 * Math.sin(ph) * mv, -0.02 * Math.sin(ph) * mv, 'YXZ');
    emit('torso', TOR, p.top, p.width, 1, 1);
    emit('collar', TOR, p.top2, p.width, 1, 1);
    if (!dressed && p.outfit !== 'skirt') emit('belt', TOR, STICK, p.width, 1, 1);
    if (p.outfit === 'jacket' || p.outfit === 'hoodie' || p.outfit === 'shirt') emit('front', TOR, p.top2);
    if (p.outfit === 'hoodie') emit('hood', TOR, p.top, p.width, 1, 1);
    if (p.bag === 'backpack') emit('backpack', TOR, p.bagC, p.width, 1, 1);
    if (p.bag === 'xbag') emit('xbag', TOR, p.bagC, p.width, 1, 1);
    // 头
    child(NECK, TOR, 0, 0.5, 0, -lean * 0.6, headYaw * 0.4, 0, 'YXZ');
    emit('neck', NECK, p.skin);
    child(HEAD, NECK, 0, 0.13, 0.012, 0, headYaw * 0.6, 0, 'YXZ');
    emit('head', HEAD, p.skin, p.hs, p.hs, p.hs);
    if (p.cap) emit('cap', HEAD, p.bagC, p.hs, p.hs, p.hs);
    else emit(p.hair, HEAD, p.hairC, p.hs, p.hs, p.hs);
    // 腿：大腿前后摆，摆动相膝盖弯，脚尽量放平
    for (const sd of [-1, 1]) {
      const fs = ph + (sd > 0 ? Math.PI : 0);
      const h = Ah * Math.sin(fs);
      const k = 0.06 + Ak * Math.pow(Math.max(0, Math.cos(fs)), 1.4);
      const a = (h - k) * 0.85;
      child(TH, PEL, sd * 0.088 * p.width, -0.045, 0, -h, 0, sd * 0.025, 'ZYX');
      emit('thigh', TH, dressed ? p.skin : p.outfit === 'skirt' ? p.skin : p.legs);
      child(SH, TH, 0, -0.42, 0, k, 0, 0);
      emit('shin', SH, p.bareShin ? p.skin : p.legs);
      child(FT, SH, 0, -0.4, 0, a, 0, 0);
      emit('shoe', FT, p.shoe); emit('sole', FT, p.soleC);
    }
    // 手臂：和同侧腿反向摆；打伞的右手举着；被按喇叭时挥手
    for (const sd of [-1, 1]) {
      const fs = ph + (sd > 0 ? Math.PI : 0);
      let sw = -Aa * Math.sin(fs), elb = 0.22 + Math.max(0, sw) * 0.9 + (run ? 1.05 : 0), abd = sd * 0.07;
      if (sd > 0 && p.umbOpen > 0.01) { sw = 0.5; elb = 1.45; abd = 0.12; }
      if (sd > 0 && p.wave > 0) { sw = 0.1; abd = 2.5 + Math.sin(t * 12) * 0.25; elb = 0.45 + Math.sin(t * 12 + 1) * 0.3; }
      if (sd < 0 && p.bag === 'handbag') { elb = 0.35; sw *= 0.4; }
      child(UA, TOR, sd * 0.185 * p.width, 0.43, 0, -sw, 0, abd, 'ZYX');
      emit('uarm', UA, p.top);
      child(FA, UA, 0, -0.285, 0, -elb, 0, 0);
      emit('farm', FA, p.shortSleeve ? p.skin : p.top);
      child(HN, FA, 0, -0.262, 0, 0, 0, 0);
      emit('hand', HN, p.skin);
      HANDW[sd > 0 ? 1 : 0].set(0, -0.06, 0).applyMatrix4(HN);
    }
    // 手提包挂在左手下面，始终竖直
    if (p.bag === 'handbag') {
      const hw = HANDW[0];
      _q.setFromAxisAngle(UP, p.yaw); OUT.compose(hw, _q, _sv.set(s, s, s));
      emit('handbag', OUT, p.bagC);
    }
    // 伞
    if (p.umbOpen > 0.01) {
      const u = p.umbOpen, hw = HANDW[1];
      _q.identity();
      OUT.compose(_v.set(hw.x, hw.y + 0.4 * s * u, hw.z), _q, _sv.set(s, 0.8 * s * u, s));
      emit('stick', OUT, STICK);
      _e.set(wind.y * 0.02, 0, -wind.x * 0.02); _q.setFromEuler(_e);
      OUT.compose(_v.set(hw.x, hw.y + 0.8 * s * u, hw.z), _q, _sv.set(s * (0.3 + 0.7 * u), s * u, s * (0.3 + 0.7 * u)));
      emit('canopy', OUT, p.umbC);
    }
  }

  // ---------- 行为 ----------
  function startPath(p, pts, reverse) {
    p.path = reverse ? pts.slice().reverse() : pts;
    p.pathI = 0; p.state = 'path';
  }
  function followPath(p, dt) {
    const pts = p.path;
    let remain = p.speed * dt * (Math.abs(pts[Math.min(p.pathI + 1, pts.length - 1)][1] - pts[p.pathI][1]) > 0.5 ? 0.8 : 1);
    while (remain > 0 && p.pathI < pts.length - 1) {
      const b = pts[p.pathI + 1];
      const dx = b[0] - p.x, dy = b[1] - p.y, dz = b[2] - p.z;
      const d = Math.hypot(dx, dz) || Math.abs(dy);
      if (d <= remain || d < 1e-4) { p.x = b[0]; p.y = b[1]; p.z = b[2]; p.pathI++; remain -= d; continue; }
      const f = remain / d;
      p.x += dx * f; p.y += dy * f; p.z += dz * f; remain = 0;
      const ty = Math.atan2(dx, dz);
      let dyaw = ty - p.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      p.yaw += dyaw * Math.min(1, dt * 8);
    }
    if (p.pathI >= pts.length - 1) {
      // 下了天桥：到另一侧人行道继续走，方向跟过桥方向一致
      const end = pts[pts.length - 1], prev = pts[pts.length - 2];
      p.side = Math.sign(end[0]); p.dir = Math.sign(end[2] - prev[2]) || 1;
      p.state = 'walk'; p.path = null; p.y = C().SY; p.bridgeCD = 25; p.timer = 20;
      p.lane = (p.x * p.side - C().PED_MID);
    }
  }

  PP.update = function (dt, camPos, ctx) {
    const rng = PP.rng, list = PP.list;
    const wet = ctx.precip > 0.18;
    const t = (PP.t = (PP.t || 0) + dt);
    const bridges = H.world.bridgePaths(camPos.z, PP.range + 60);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (Math.abs(p.z - camPos.z) > PP.range + 10 && p.state !== 'path') { spawn(p, camPos.z, rng, false); continue; }
      p.waveCD -= dt; p.bridgeCD -= dt;
      const wantUmb = wet && p.hasUmb;
      p.umbOpen = H.clamp(p.umbOpen + (wantUmb ? 1.5 : -2) * dt, 0, 1);
      const hurry = (wet && !p.hasUmb) || ctx.hail > 0.3 ? 1.75 : 1;
      let target = p.baseSpeed * hurry;
      if (p.wave > 0) { p.wave -= dt; target = 0; }
      if (p.state === 'path') {
        p.speed = H.damp(p.speed, p.wave > 0 ? 0 : p.baseSpeed * hurry, 3, dt);
        followPath(p, dt);
        p.phase += dt * p.speed * (p.speed > 1.95 ? 2.9 : 4.5) / p.s;
        continue;
      }
      if (p.state === 'idle') {
        target = 0; p.timer -= dt;
        if (p.timer <= 0) { p.state = 'walk'; p.timer = rng.range(15, 50); }
      } else {
        p.timer -= dt;
        if (p.timer <= 0) { p.state = 'idle'; p.timer = rng.range(2, 7); }
      }
      // 走到天桥口：有一定概率上桥过街
      if (p.bridgeCD <= 0 && p.state === 'walk') {
        for (const pts of bridges) {
          const a = pts[0], b = pts[pts.length - 1];
          if (p.side > 0 && Math.abs(p.z - a[2]) < 0.6) { p.bridgeCD = 12; if (rng() < 0.45) { startPath(p, pts, false); break; } }
          else if (p.side < 0 && Math.abs(p.z - b[2]) < 0.6) { p.bridgeCD = 12; if (rng() < 0.45) { startPath(p, pts, true); break; } }
        }
        if (p.state === 'path') continue;
      }
      // 车道：靠右走
      let wantX = p.side * C().PED_MID + (-p.dir) * 0.42 + p.lane * 0.5;
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const q = list[j];
        if (q.side !== p.side || q.state === 'path') continue;
        const dz = (q.z - p.z) * p.dir;
        if (dz <= 0 || dz > 2.6) continue;
        const dx = q.x - p.x;
        if (Math.abs(dx) < 0.55) {
          wantX = p.x - Math.sign(dx || (p.side * -p.dir)) * 0.7;
          if (q.dir === p.dir && q.speed < p.speed && dz < 1.2) target = Math.min(target, q.speed);
        }
      }
      const pdx = ctx.player.x - p.x, pdz = (ctx.player.z - p.z) * p.dir;
      if (Math.abs(ctx.player.y - p.y) < 1.5) {
        if (pdz > 0 && pdz < 3 && Math.abs(pdx) < 0.7) { wantX = p.x - Math.sign(pdx || 1) * 0.8; if (pdz < 1.0) target *= 0.3; }
        if (Math.hypot(pdx, ctx.player.z - p.z) < 2.2 && p.waveCD <= 0 && ctx.playerWalking && rng() < 0.01) { p.wave = 1.6; p.waveCD = 20; }
      }
      wantX = p.side * H.clamp(wantX * p.side, C().PED_IN, C().PED_OUT);
      p.speed = H.damp(p.speed, target, 3, dt);
      const vx = H.clamp((wantX - p.x) * 1.6, -0.7, 0.7);
      p.x += vx * dt;
      p.z += p.dir * p.speed * dt;
      p.y = C().SY;
      const tgtYaw = Math.atan2(vx, p.dir * Math.max(p.speed, 0.3));
      let dy = tgtYaw - p.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      p.yaw += dy * Math.min(1, dt * 6);
      p.phase += dt * p.speed * (p.speed > 1.95 ? 2.9 : 4.5) / p.s;
    }
    // 绘制
    counters = {}; for (const k in PER) counters[k] = 0;
    for (const p of list) pose(p, t, ctx.wind);
    for (const k in parts) {
      const im = parts[k];
      im.count = counters[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  };

  PP.rebase = function (dz) {
    for (const p of PP.list) { p.z += dz; if (p.path) p.path = p.path.map(([x, y, z]) => [x, y, z + dz]); }
  };

  // 玩家与行人的碰撞（圆形；高度差大的不算，比如桥上和桥下）
  PP.collide = function (pos, r) {
    for (const p of PP.list) {
      if (Math.abs(p.y - pos.y) > 1.2) continue;
      const dx = pos.x - p.x, dz = pos.z - p.z, rr = r + 0.28 * p.s;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d; pos.x += dx * k; pos.z += dz * k; }
    }
  };
})();
