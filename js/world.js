// 无限延伸的公路：按 64m 分块生成/回收；路面、标线、人行道、路灯、行道树、公交站、门架标志、人行天桥、两侧建筑、边界空气墙
'use strict';
(function () {
  const Wd = H.world = {};
  // 横断面（从中心线往外）：车道 3.5m | 停车带 2.6m | 路缘 | 人行道 4.3m | 地块
  const CH = 64, LANE = 3.5, SHO = 2.6, ROAD = LANE + SHO, CURB = ROAD + 0.3, WALK = CURB + 4.3, LOT = WALK + 0.2, SY = 0.15;
  const SHOX = LANE + SHO / 2 + 0.05; // 停车带中线
  Wd.C = { CH, LANE, SHO, SHOX, ROAD, CURB, WALK, LOT, SY, PED_IN: CURB + 2.35, PED_OUT: CURB + 3.95, PED_MID: CURB + 3.05 };
  Wd.chunks = new Map();
  Wd.originZ = 0;              // 世界 z = 渲染 z + originZ
  Wd.drawDist = 520;
  Wd.groundY = (x) => (Math.abs(x) < ROAD ? 0 : SY);
  Wd.WALL = WALK + 46 - 0.2; // 地块铺装和外面草地的交界：空气墙所在位置（墙本身不画，提示显示在屏幕上）
  // 人行天桥：桥面高度、半宽、台阶位置（块内局部坐标，桥中心 z = BZ）
  const BR = { BZ: 32, YD: 5.75, XS: LOT + 2.6, HW: 1.6, SW0: LOT + 0.35, SW1: LOT + 2.55, L: 12.0, PX: CURB + 0.7 };
  Wd.BR = BR;
  const isBridge = (i) => ((i % 9) + 9) % 9 === 5 && ((i % 16) + 16) % 16 !== 8;
  // 台阶表面高度：u = 从桥面那头往下走的距离（0..12）
  function stairY(u) {
    if (u <= 0) return BR.YD;
    if (u <= 5.1) return BR.YD - u / 5.1 * 2.72;
    if (u <= 6.6) return BR.YD - 2.72;
    if (u <= BR.L) return BR.YD - 2.72 - (u - 6.6) / 5.4 * 2.88;
    return SY;
  }
  Wd.stairY = stairY;

  const BD = () => H.bld;

  function flat(w, d, ox = 0, oz = 0) {
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) + ox, -(p.getZ(i) + oz));
    return g;
  }

  // ---------- 门架标志牌贴图 ----------
  function gantryTexture() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
    const x = c.getContext('2d');
    const font = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    const row = (y, big, small) => {
      x.fillStyle = '#1f5fae'; x.beginPath(); x.roundRect(8, y + 8, 1008, 240, 34); x.fill();
      x.strokeStyle = '#ffffff'; x.lineWidth = 8; x.beginPath(); x.roundRect(22, y + 22, 980, 212, 26); x.stroke();
      // G404 红色盾牌
      x.fillStyle = '#d7322b'; x.beginPath(); x.roundRect(56, y + 62, 200, 132, 26); x.fill();
      x.fillStyle = '#fff'; x.font = `bold 84px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('G404', 156, y + 130);
      x.textAlign = 'left'; x.font = `bold 92px ${font}`; x.fillText(big, 300, y + 106);
      x.font = `48px ${font}`; x.fillText(small, 304, y + 186);
    };
    row(0, '404 高速路', '前方 ∞ km · 一路顺风');
    row(256, '欢迎来到 404 高速路', '页面没找到，路找到了');
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = H.maxAniso || 4;
    return t;
  }

  function bridgeTexture() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 96;
    const x = c.getContext('2d');
    x.fillStyle = '#2f8f83'; x.fillRect(0, 0, 1024, 96);
    x.fillStyle = '#ffffff'; x.font = 'bold 56px "PingFang SC","Hiragino Sans GB",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('404 人行天桥 · 过街请走天桥', 512, 50);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = H.maxAniso || 4;
    return t;
  }
  Wd.init = function (scene) {
    Wd.scene = scene;
    Wd.group = new THREE.Group(); scene.add(Wd.group);
    const gt = gantryTexture();
    H.mat.list.gantry = H.mat.patch(new THREE.MeshStandardMaterial({ map: gt, emissiveMap: gt, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.45 }), { noSnow: true });
    H.mat.shadow.gantry = 2;
    const bt = bridgeTexture();
    H.mat.list.bridgesign = H.mat.patch(new THREE.MeshStandardMaterial({ map: bt, emissiveMap: bt, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.5 }), { noSnow: true });
    H.mat.shadow.bridgesign = 2;
    H.mat.list.canopy = new THREE.MeshStandardMaterial({ color: '#bfe3ef', transparent: true, opacity: 0.45, roughness: 0.12, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
    H.mat.shadow.canopy = 0;
    // 远处的大地（跟随相机，按贴图周期吸附）
    const gg = new THREE.PlaneGeometry(2400, 2400); gg.rotateX(-Math.PI / 2);
    const uv = gg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 400, uv.getY(i) * 400);
    Wd.ground = new THREE.Mesh(gg, H.mat.ground); Wd.ground.position.y = -0.06; Wd.ground.receiveShadow = true;
    scene.add(Wd.ground);
  };

  // ---------- 路面和人行道 ----------
  function roadAndWalks(B, ch) {
    const i = ch.idx;
    B.add('asphalt', flat(ROAD * 2 + 0.6, CH, 0, 32), 0, 0, 32, 0, 0xffffff);
    for (const s of [-1, 1]) {
      // 路缘石略宽，外沿压在人行道下面，避免圆角处露出缝
      B.add('concrete', BD().rbox(0.36, 0.296, CH + 0.02, 0.06, 1), s * (ROAD + 0.18), -0.001, 32, 0, '#cfccc4');
      const sw0 = CURB - 0.05;
      B.add('tiles', flat(WALK - sw0, CH, s * (sw0 + (WALK - sw0) / 2), 32), s * (sw0 + (WALK - sw0) / 2), SY, 32, 0, '#ffffff');
      B.add('tiles', flat(46, CH, s * (WALK + 23), 32), s * (WALK + 23), SY - 0.002, 32, 0, '#d6d0c6');
    }
    // 路面只有这一条中心虚线：3m 实 5m 空（不画边线、车位线、斑马线；过街走人行天桥）
    for (let k = 0; k < 8; k++) B.add('paint', flat(0.15, 3), 0, 0.004, k * 8 + 1.5, 0, '#f4f4ef');
    // 井盖（圆的）
    const r = H.rng(i * 31 + 5);
    if (r.chance(0.5)) B.add('metal', BD().cyl(0.35, 0.02, 0.01, 18), r.pick([-1.8, 1.8]), 0.006, r.range(5, 59), 0, '#4a4d52');
  }

  // ---------- 街道家具 ----------
  function lamp(B, ch, side, z) {
    const px = CURB + 0.45, hx = px - (LANE - 0.15); // 灯头伸到车道边线上方
    const P = new (BD().Placer)(B, ch, side * px, SY, z, side > 0 ? 0 : Math.PI);
    const mc = '#4a5058';
    const arm = hx - 0.45 - 0.8;
    P.add('metal', BD().cyl(0.2, 0.5, 0.06), 0, 0.25, 0, 0, '#3b4047');
    P.add('metal', BD().cyl(0.085, 7.2, 0.04, 10), 0, 3.6, 0, 0, mc);
    P.add('metal', cachedTorus(), -0.8, 7.2, 0, 0, mc);
    P.add('metal', BD().cyl(0.055, arm, 0.02, 8), -0.8 - arm / 2, 8.0, 0, 0, mc, { rz: Math.PI / 2 });
    P.box('metal', 0.95, 0.18, 0.38, -hx, 7.86, 0, '#e8ebee', 0.08, 1);
    P.add('lamp', BD().quad(0.72, 0.26, [0, 0, 1, 1]), -hx, 7.85, 0, 0, 0xffffff, { rx: Math.PI / 2 });
    P.add('pool', poolQuad(11), -hx, -SY + 0.02, 0, 0, 0xffffff);
    P.add('pool', poolQuad(7), -0.3, 0.02, 0, 0, 0xffffff);
    P.circle(0, 0, 0.16);
    ch.lamps.push({ x: P.tx(-hx, 0), y: SY + 7.6, z: P.tz(-hx, 0) });
  }
  let _torus = null;
  function cachedTorus() { if (!_torus) _torus = new THREE.TorusGeometry(0.8, 0.055, 8, 14, Math.PI / 2); return _torus; }
  const _pools = {};
  function poolQuad(s) { if (!_pools[s]) { const g = new THREE.PlaneGeometry(s, s); g.rotateX(-Math.PI / 2); _pools[s] = g; } return _pools[s]; }

  function busStop(B, ch, side, z) {
    const P = new (BD().Placer)(B, ch, side * (CURB + 0.3), SY, z, side > 0 ? 0 : Math.PI);
    P.box('metal', 2.0, 0.12, 4.8, 0.9, 2.55, 0, '#eef1f3', 0.06, 2);
    P.box('glass', 0.04, 2.1, 4.4, 1.75, 0.35, 0, 0xffffff, 0, 0);
    P.box('glass', 1.5, 2.1, 0.04, 1.0, 0.35, -2.2, 0xffffff, 0, 0);
    for (const zz of [-2.25, 2.25]) for (const xx of [0.1, 1.75]) P.add('metal', BD().cyl(0.05, 2.55, 0.02, 8), xx, 1.275, zz, 0, '#5a6068');
    H.bld.bench(P, 1.35, 0.4, 0, H.rng(ch.idx));
    P.box('trim', 0.1, 0.42, 2.4, -0.05, 2.62, 0, '#2b7bb9', 0.05, 1);
    P.add('sign', BD().quad(2.2, 0.36, H.tex.signCell(23)), -0.11, 2.83, 0, BD().FACE.front, 0xffffff);
    P.solid(1.65, 1.85, -2.3, 2.3); P.solid(0.2, 1.8, -2.3, -2.1);
    P.circle(0.1, -2.25, 0.1); P.circle(0.1, 2.25, 0.1);
    ch.stops.push({ x: P.tx(1.3, 0), z: P.tz(1.3, 0), side });
  }

  function gantry(B, ch, z, row) {
    const mc = '#8c949c';
    const gx = CURB + 0.6;
    for (const s of [-1, 1]) {
      B.add('metal', BD().cyl(0.24, 7.6, 0.08, 14), s * gx, SY + 3.8, z, 0, mc);
      ch.circles.push({ x: s * gx, z, r: 0.3 });
    }
    B.add('metal', BD().rbox(gx * 2 + 0.4, 0.45, 0.45, 0.15, 1), 0, 7.3, z, 0, mc);
    B.add('metal', BD().rbox(6.6, 2.4, 0.22, 0.12, 1), 0, 8.6, z, 0, '#e8ebee');
    const v0 = row ? 0 : 0.5, v1 = row ? 0.5 : 1;
    const q = H.quad(6.4, 2.2, 0, v0 + 0.004, 1, v1 - 0.004);
    B.add('gantry', q, 0, 8.6, z + 0.12, 0, 0xffffff);
    B.add('gantry', q, 0, 8.6, z - 0.12, Math.PI, 0xffffff);
  }

  function furniture(B, ch, rng) {
    const i = ch.idx;
    for (const s of [-1, 1]) {
      const lampZ = s > 0 ? [8, 40] : [24, 56];
      lampZ.forEach((z) => lamp(B, ch, s, z));
      const stopHere = ((i % 5) + 5) % 5 === (s > 0 ? 2 : 4);
      const stopZ = s > 0 ? 24 : 40;
      // 行道树
      for (let z = 4; z < CH; z += 8) {
        if (lampZ.some((lz) => Math.abs(lz - z) < 2.5)) continue;
        if (stopHere && Math.abs(z - stopZ) < 4) continue;
        const P = new (BD().Placer)(B, ch, s * (CURB + 0.75), SY, z, s > 0 ? 0 : Math.PI);
        P.box('metal', 1.25, 0.03, 1.25, 0, 0, 0, '#3a3f45', 0.06, 1);
        H.bld.tree(P, 0, 0, rng.range(0.9, 1.2), rng);
        // 树与树之间：长椅 + 垃圾桶，或者一排自行车架（停着共享单车）
        const free = z + 4 < CH && !lampZ.some((lz) => Math.abs(lz - (z + 4)) < 2.2) && !(stopHere && Math.abs(z + 4 - stopZ) < 4)
          && !(ch.bridge && Math.abs(z + 4 - BR.BZ) < 3);
        const roll = rng();
        if (free && roll < 0.24) {
          H.bld.bench(P, 0.15, 4, 0, rng);
          P.add('metal', BD().cyl(0.26, 0.85, 0.08), -0.1, 0.43, 5.5, 0, rng.pick(['#3f6f58', '#4a6a8a', '#7a6a5a']));
          P.circle(-0.1, 5.5, 0.3);
        } else if (free && roll < 0.5) bikeRack(B, ch, P, 4, rng);
      }
      if (stopHere) busStop(B, ch, s, stopZ);
      if (rng.chance(0.3)) {
        const z = rng.pick(ch.bridge ? [14, 46] : [14, 30, 46]);
        const P = new (BD().Placer)(B, ch, s * (CURB + 0.25), SY, z, 0);
        P.add('metal', BD().cyl(0.13, 0.62, 0.06), 0, 0.31, 0, 0, '#d23b2e');
        P.add('metal', BD().cyl(0.17, 0.08, 0.03), 0, 0.6, 0, 0, '#d23b2e');
        P.add('metal', BD().cyl(0.06, 0.38, 0.03), 0, 0.3, 0, 0, '#c9c9c9', { rz: Math.PI / 2 });
        P.circle(0, 0, 0.2);
      }
    }
    // 百米桩
    for (let z = 0; z < CH; z++) {
      const wz = i * CH + z;
      if (wz % 100 === 0) {
        B.add('trim', BD().rbox(0.22, 0.6, 0.12, 0.05, 1), CURB + 0.15, SY + 0.3, z, 0, '#ffffff');
        B.add('trim', BD().rbox(0.23, 0.12, 0.13, 0.04, 1), CURB + 0.15, SY + 0.55, z, 0, '#d7322b');
      }
    }
    // 门架标志：约每公里一个；出生点前方也放一个“欢迎”
    if (i === -1) gantry(B, ch, 30, 1);
    else if (((i % 16) + 16) % 16 === 8) gantry(B, ch, 20, 0);
    if (ch.bridge) overpass(B, ch);
    parking(ch);
  }

  // ---------- 停车带里停的车 ----------
  const CAR_COLORS = ['#f2f2f0', '#1f2328', '#b8bec6', '#c0392b', '#2f6fb5', '#2f9e9a', '#e8a33a', '#5a6b4a', '#7a2f3a', '#ffffff', '#3d4a5c', '#d9c7a7'];
  Wd.CAR_COLORS = CAR_COLORS;
  // 停车用单独的随机数：以后调停车密度不会把两边的楼也打乱
  function parking(ch) {
    const rng = H.rng(ch.idx * 131 + 77);
    for (const s of [-1, 1]) {
      if (rng() < 0.25) continue; // 有的路段整段空着
      for (let z = 5; z < CH - 1; z += 6) {
        // 出生点那辆车的位置留空
        if (ch.idx === -1 && s > 0 && Math.abs(z - 55) < 6) continue;
        if (rng() < 0.19) { // 每个车位约 19% 有车（原来 38%，减半）
          const model = rng.pick(['hatch', 'sedan', 'suv', 'hatch', 'sedan']);
          ch.parked.push({ kind: 'car', model, color: rng.pick(CAR_COLORS), x: s * SHOX, z: z + rng.range(-0.4, 0.4), yaw: (s > 0 ? 0 : Math.PI) + rng.range(-0.03, 0.03) });
        }
      }
    }
  }
  // 自行车架：几个倒 U 形的架子，中间插着共享单车（垂直于路）
  const BIKE_SHARED = ['#f5c518', '#ff7a1a', '#2f80ed', '#2ec4a5', '#f5c518', '#ff7a1a'];
  function bikeRack(B, ch, P, lz, rng) {
    const n = rng.int(3, 5), gap = 0.72;
    let hoop = Wd._hoop;
    if (!hoop) { hoop = Wd._hoop = new THREE.TorusGeometry(0.34, 0.024, 8, 16, Math.PI); }
    for (let k = 0; k <= n; k++) {
      const z = lz + (k - n / 2) * gap;
      // 倒 U 形：两根立柱 + 顶上的半圆
      for (const dx of [-0.34, 0.34]) { P.add('metal', BD().cyl(0.024, 0.45, 0.01, 8), 0.1 + dx, 0.225, z, 0, '#8c949c'); P.circle(0.1 + dx, z, 0.05); }
      P.add('metal', hoop, 0.1, 0.45, z, 0, '#8c949c');
    }
    for (let k = 0; k < n; k++) {
      if (rng() < 0.2) continue;
      const z = lz + (k - (n - 1) / 2) * gap;
      const style = rng() < 0.85 ? 'shared' : 'road';
      const col = style === 'shared' ? rng.pick(BIKE_SHARED) : rng.pick(CAR_COLORS);
      ch.parked.push({ kind: 'bike', style, color: col, x: P.tx(0.1, z), z: P.tz(0.1, z), yaw: P.ry + (rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2), rack: true });
    }
  }

  // ---------- 人行天桥 ----------
  let _stairGeo = null, _archGeo = null;
  function stairGeo() {
    if (_stairGeo) return _stairGeo;
    // 侧面轮廓（X = 离桥面的水平距离，Y = 高度），两跑楼梯中间一个休息平台；下面是实心的
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(0, BR.YD);
    let x = 0, y = BR.YD;
    for (let k = 0; k < 17; k++) { x += 0.3; sh.lineTo(x, y); y -= 0.16; sh.lineTo(x, y); }
    x += 1.5; sh.lineTo(x, y);
    for (let k = 0; k < 18; k++) { y -= 0.16; sh.lineTo(x, y); x += 0.3; sh.lineTo(x, y); }
    sh.lineTo(x, 0); sh.lineTo(0, 0);
    _stairGeo = new THREE.ExtrudeGeometry(sh, { depth: BR.SW1 - BR.SW0, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 1 });
    return _stairGeo;
  }
  function archGeo() {
    if (_archGeo) return _archGeo;
    const g = new THREE.CylinderGeometry(2.0, 2.0, BR.XS * 2 + 0.6, 28, 1, true, -Math.PI / 2, Math.PI);
    g.rotateZ(Math.PI / 2); g.rotateX(-Math.PI / 2); g.scale(1, 0.42, 1);
    _archGeo = g; return g;
  }
  // 沿斜线放一根圆管（a、b 为两端点）
  function tube(B, key, a, b, r, color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    const g = BD().cyl(r, len, r * 0.4, 8);
    const ry = Math.atan2(dx, dz), rx = Math.atan2(Math.hypot(dx, dz), dy);
    B.add(key, g, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, ry, color, { rx });
  }
  function overpass(B, ch) {
    const { BZ, YD, XS, HW, SW0, SW1, L } = BR;
    const mc = '#9aa2aa';
    // 桥面板 + 铺装 + 两侧彩色挡板和名牌
    B.add('concrete', BD().rbox(XS * 2 + 0.2, 0.5, HW * 2 + 0.2, 0.12, 1), 0, YD - 0.27, BZ, 0, '#d9d6cf');
    B.add('tiles', flat(XS * 2, HW * 2, 0, BZ), 0, YD + 0.004, BZ, 0, '#eadfce');
    for (const sd of [-1, 1]) {
      B.add('trim', BD().rbox(XS * 2 + 0.3, 0.44, 0.08, 0.04, 1), 0, YD - 0.25, BZ + sd * (HW + 0.12), 0, '#2f8f83');
      B.add('bridgesign', H.quad(4.6, 0.43), 0, YD - 0.25, BZ + sd * (HW + 0.165), sd > 0 ? 0 : Math.PI, 0xffffff);
    }
    // 桥墩
    for (const sd of [-1, 1]) {
      const hgt = YD - 0.5 - SY;
      B.add('concrete', BD().cyl(0.34, hgt, 0.08, 18), sd * BR.PX, SY + hgt / 2, BZ, 0, '#cfcac0');
      B.add('concrete', BD().rbox(1.1, 0.3, HW * 2 - 0.2, 0.1, 1), sd * BR.PX, YD - 0.62, BZ, 0, '#c6c1b7');
      ch.circles.push({ x: sd * BR.PX, z: BZ, r: 0.4 });
    }
    // 桥面栏杆（玻璃 + 立柱 + 扶手），留出两头台阶的口子
    const rail = (x0, x1, z, y) => {
      const len = x1 - x0; if (len < 0.3) return;
      const n = Math.max(1, Math.round(len / 1.6));
      for (let k = 0; k <= n; k++) B.add('metal', BD().cyl(0.035, 1.05, 0.015, 8), x0 + len * k / n, y + 0.525, z, 0, mc);
      for (let k = 0; k < n; k++) B.add('glass', BD().rbox(len / n - 0.08, 0.86, 0.025, 0, 0), x0 + len * (k + 0.5) / n, y + 0.5, z, 0, 0xffffff);
      B.add('metal', BD().cyl(0.032, len, 0.012, 8), (x0 + x1) / 2, y + 1.07, z, 0, '#c9ced4', { rz: Math.PI / 2 });
      ch.boxes.push({ x0, x1, z0: z - 0.1, z1: z + 0.1, y0: y - 0.4, y1: y + 1.5 });
    };
    rail(-XS, SW0, BZ + HW - 0.06, YD); rail(SW1, XS, BZ + HW - 0.06, YD);
    rail(-XS, -SW1, BZ - HW + 0.06, YD); rail(-SW0, XS, BZ - HW + 0.06, YD);
    for (const sd of [-1, 1]) {
      const x = sd * (XS - 0.06);
      for (const z of [BZ - HW, BZ, BZ + HW]) B.add('metal', BD().cyl(0.035, 1.05, 0.015, 8), x, YD + 0.525, z, 0, mc);
      B.add('glass', BD().rbox(0.025, 0.86, HW * 2 - 0.1, 0, 0), x, YD + 0.5, BZ, 0, 0xffffff);
      B.add('metal', BD().cyl(0.032, HW * 2, 0.012, 8), x, YD + 1.07, BZ, 0, '#c9ced4', { rx: Math.PI / 2 });
      ch.boxes.push({ x0: x - 0.1, x1: x + 0.1, z0: BZ - HW, z1: BZ + HW, y0: YD - 0.4, y1: YD + 1.5 });
    }
    // 拱形雨棚
    // 拱脚在 YD+1.95，立柱站在桥面板外沿（z=±1.66），顶到拱面
    B.add('canopy', archGeo(), 0, YD + 1.95, BZ, 0, 0xffffff);
    for (let x = -XS; x <= XS + 0.01; x += XS / 4) for (const sd of [-1, 1]) B.add('metal', BD().cyl(0.04, 2.44, 0.015, 8), x, YD + 1.22, BZ + sd * 1.66, 0, mc);
    for (const sd of [-1, 1]) B.add('metal', BD().cyl(0.035, XS * 2 + 0.6, 0.012, 8), 0, YD + 2.43, BZ + sd * 1.66, 0, '#c9ced4', { rz: Math.PI / 2 });
    // 两头的台阶（右侧往 +z 下，左侧往 -z 下，中心对称）
    for (const sd of [1, -1]) {
      const zTop = BZ + sd * HW;
      const xOut = sd * SW1, xIn = sd * SW0;
      B.add('concrete', stairGeo(), xOut, 0, zTop, sd > 0 ? -Math.PI / 2 : Math.PI / 2, '#d4cfc6');
      // 台阶两侧扶手：上跑、平台、下跑三段
      const segs = [[0, 5.1], [5.1, 6.6], [6.6, L]];
      for (const xr of [xIn + sd * 0.07, xOut - sd * 0.07]) {
        for (const [u0, u1] of segs) {
          const a = [xr, stairY(u0) + 1.05, zTop + sd * u0], b = [xr, stairY(u1) + 1.05, zTop + sd * u1];
          tube(B, 'metal', a, b, 0.032, '#c9ced4');
          const n = Math.max(1, Math.round((u1 - u0) / 1.6));
          for (let k = 0; k <= n; k++) {
            const u = u0 + (u1 - u0) * k / n;
            B.add('metal', BD().cyl(0.035, 1.05, 0.015, 8), xr, stairY(u) + 0.525, zTop + sd * u, 0, mc);
          }
          const um = (u0 + u1) / 2, len = Math.hypot(u1 - u0, stairY(u0) - stairY(u1));
          const rx = Math.atan2(sd * (u1 - u0), stairY(u1) - stairY(u0));
          // 玻璃板长边沿着坡度方向（绕 x 轴转到坡度角）
          B.add('glass', BD().rbox(0.025, len - 0.1, 0.8, 0, 0), xr, stairY(um) + 0.5, zTop + sd * um, 0, 0xffffff, { rx });
        }
        // 楼梯两侧是实心墙：任何高度都不能从侧面钻进去
        ch.boxes.push({ x0: xr - 0.12, x1: xr + 0.12, z0: Math.min(zTop, zTop + sd * L), z1: Math.max(zTop, zTop + sd * L), y0: -1, y1: 9 });
      }
      // 楼梯顶端下方（站在地面时）是实心的
      ch.boxes.push({ x0: Math.min(xIn, xOut), x1: Math.max(xIn, xOut), z0: zTop - 0.12, z1: zTop + 0.12, y0: -1, y1: YD - 0.7 });
      ch.surf.push({ k: 'stair', x0: Math.min(xIn, xOut), x1: Math.max(xIn, xOut), zTop, dir: sd });
    }
    ch.surf.push({ k: 'deck', x0: -XS, x1: XS, z0: BZ - HW, z1: BZ + HW, y: YD });
    // 行人过街路线（右 -> 左）；反过来走就是左 -> 右
    const zr = BZ + HW, zl = BZ - HW, xm = (SW0 + SW1) / 2;
    ch.paths = [[
      [CURB + 3.1, SY, zr + L + 1.4], [xm, SY, zr + L + 0.7], [xm, SY, zr + L], [xm, stairY(6.6), zr + 6.6], [xm, stairY(5.1), zr + 5.1],
      [xm, YD, zr], [xm, YD, BZ], [-xm, YD, BZ], [-xm, YD, zl], [-xm, stairY(5.1), zl - 5.1], [-xm, stairY(6.6), zl - 6.6],
      [-xm, SY, zl - L], [-xm, SY, zl - L - 0.7], [-(CURB + 3.1), SY, zl - L - 1.4],
    ]];
  }

  // ---------- 两侧地块 ----------
  const WIDTH = { apartment: [14, 22], office: [20, 30], villa: [12, 16], shops: [10, 20], park: [5, 10] };
  function pickW(wts, rng) {
    let t = 0; for (const k in wts) t += wts[k];
    let r = rng() * t; for (const k in wts) { r -= wts[k]; if (r <= 0) return k; }
    return Object.keys(wts)[0];
  }
  function* fillSide(B, ch, side, rng) {
    if (ch.bridge) {
      // 台阶落地的地方留一块广场
      const r0 = side > 0 ? BR.BZ - 3 : BR.BZ - BR.HW - BR.L - 3.4, r1 = side > 0 ? BR.BZ + BR.HW + BR.L + 3.4 : BR.BZ + 3;
      yield* fillRange(B, ch, side, rng, 0, r0);
      const P = new (BD().Placer)(B, ch, side > 0 ? LOT : -LOT, SY, side > 0 ? r0 : r1, side > 0 ? 0 : Math.PI);
      BD().plaza(P, r1 - r0, rng);
      yield;
      yield* fillRange(B, ch, side, rng, r1, CH);
    } else yield* fillRange(B, ch, side, rng, 0, CH);
  }
  function* fillRange(B, ch, side, rng, zStart, zEnd) {
    const d = H.noise1(ch.idx * 0.09 + (side > 0 ? 0 : 37.5), 3);
    let wts, apt;
    if (d < 0.36) { wts = { villa: 0.62, shops: 0.14, apartment: 0.14, park: 0.1 }; apt = [4, 7]; }
    else if (d < 0.64) { wts = { apartment: 0.55, shops: 0.27, villa: 0.1, office: 0.05, park: 0.03 }; apt = [6, 11]; }
    else { wts = { office: 0.48, apartment: 0.27, shops: 0.25 }; apt = [8, 14]; }
    const off = d > 0.8 ? [16, 26] : [10, 18];
    let z = zStart;
    while (z < zEnd - 3) {
      let type = pickW(wts, rng);
      let w = rng.range(WIDTH[type][0], WIDTH[type][1]);
      const remain = zEnd - z;
      if (w > remain - 3) {
        if (remain >= 20 && type === 'office') w = remain;
        else if (remain >= 14) { if (type === 'office') type = 'apartment'; w = remain; }
        else if (remain >= 12 && type === 'villa') w = remain;
        else if (remain >= 10) { type = 'shops'; w = remain; }
        else { type = 'park'; w = remain; }
      }
      w = Math.min(w, remain);
      const P = new (BD().Placer)(B, ch, side > 0 ? LOT : -LOT, SY, side > 0 ? z : z + w, side > 0 ? 0 : Math.PI);
      const opt = type === 'office' ? { minF: off[0], maxF: off[1] } : { minF: apt[0], maxF: apt[1] };
      BD()[type](P, w, rng, opt);
      yield;
      z += w + (rng.chance(0.3) ? rng.range(0.8, 2.4) : 0);
    }
  }

  function* genChunk(ch) {
    const B = new H.Builder();
    const rng = H.rng(ch.idx * 7919 + 1234567);
    roadAndWalks(B, ch); yield;
    furniture(B, ch, rng); yield;
    yield* fillSide(B, ch, 1, rng);
    yield* fillSide(B, ch, -1, rng);
    B.build(H.mat.list, ch.group, H.mat.shadow);
    ch.hide = B.ranges; // 'h'+建筑id -> 实心楼体在合并网格里的区段
    ch.ready = true;
    if (H.veh && H.veh.fleet) H.veh.fleet.addChunk(ch);
  }

  function makeChunk(idx) {
    const ch = { idx, group: new THREE.Group(), boxes: [], circles: [], lamps: [], stops: [], surf: [], paths: [], wins: [], parked: [], blds: [], hide: {}, ready: false, bridge: isBridge(idx) };
    ch.group.position.z = idx * CH - Wd.originZ;
    ch.gen = genChunk(ch);
    Wd.group.add(ch.group);
    Wd.chunks.set(idx, ch);
    return ch;
  }
  function freeChunk(ch) {
    if (H.veh && H.veh.fleet) H.veh.fleet.removeChunk(ch);
    if (H.interior) H.interior.dropChunk(ch);
    ch.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    Wd.group.remove(ch.group);
    Wd.chunks.delete(ch.idx);
  }

  // focusZ 为渲染坐标；budget 毫秒内尽量多生成
  Wd.update = function (focusZ, cam, budget = 6, sync = false) {
    const fw = focusZ + Wd.originZ;
    const r = Wd.drawDist + 40;
    const a = Math.floor((fw - r) / CH), b = Math.floor((fw + r) / CH);
    for (let i = a; i <= b; i++) if (!Wd.chunks.has(i)) makeChunk(i);
    for (const [i, ch] of Wd.chunks) if (i < a - 2 || i > b + 2) freeChunk(ch);
    // 先生成离玩家近的
    const pending = [...Wd.chunks.values()].filter((c) => !c.ready)
      .sort((p, q) => Math.abs(p.idx * CH + 32 - fw) - Math.abs(q.idx * CH + 32 - fw));
    const t0 = performance.now();
    for (const ch of pending) {
      while (!ch.ready) {
        ch.gen.next();
        if (!sync && performance.now() - t0 > budget) break;
      }
      if (!sync && performance.now() - t0 > budget) break;
    }
    if (cam) {
      Wd.ground.position.x = Math.round(cam.x / 192) * 192; Wd.ground.position.z = Math.round(cam.z / 192) * 192;
      // 立体窗：近处的块拼出窗框/门把手，远处换回平面贴图
      let built = 0;
      for (const ch of Wd.chunks.values()) {
        if (!ch.ready) continue;
        const z0 = ch.group.position.z, d = Math.max(0, z0 - cam.z, cam.z - (z0 + CH));
        if (!ch.detail && d < H.detail.radius && (built < 1 || sync)) { ch.detail = H.detail.build(ch); ch.group.add(ch.detail); built++; }
        else if (ch.detail && d > H.detail.radius + 40) { ch.group.remove(ch.detail); H.detail.dispose(ch.detail); ch.detail = null; }
        if (ch.flat === undefined) ch.flat = ch.group.getObjectByName('winflat') || null;
        if (ch.flat) ch.flat.visible = !ch.detail;
      }
    }
    return pending.length;
  };

  // ---------- 碰撞：圆形推出 ----------
  // pos.y 是脚底高度；带 y0/y1 的盒子只挡这个高度范围内的人（天桥栏杆不挡桥下走路的人）
  // walker = true 表示是步行的玩家：已经"打开"的楼不再用整块实心盒子挡，改由 H.interior 的墙体挡
  Wd.collide = function (pos, r, solidStairs, walker) {
    const IN = H.interior;
    for (const ch of Wd.chunks.values()) {
      const gz = ch.group.position.z;
      const lz = pos.z - gz;
      if (lz < -r - 1 || lz > CH + r + 1) continue;
      for (const bx of ch.boxes) {
        if (bx.y1 !== undefined && (pos.y + 1.7 < bx.y0 || pos.y > bx.y1)) continue;
        if (walker && bx.bid && IN && IN.isOpen(bx.bid)) continue;
        const cx = H.clamp(pos.x, bx.x0, bx.x1), cz = H.clamp(lz, bx.z0, bx.z1);
        const dx = pos.x - cx, dz = lz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-8) { const d = Math.sqrt(d2), k = (r - d) / d; pos.x += dx * k; pos.z += dz * k; }
          else {
            // 圆心已进到盒子里：从最近的边推出去
            const opts = [[pos.x - bx.x0 + r, -1, 0], [bx.x1 - pos.x + r, 1, 0], [lz - bx.z0 + r, 0, -1], [bx.z1 - lz + r, 0, 1]];
            opts.sort((p, q) => p[0] - q[0]);
            pos.x += opts[0][1] * opts[0][0]; pos.z += opts[0][2] * opts[0][0];
          }
        }
      }
      if (solidStairs) {
        for (const sf of ch.surf) {
          if (sf.k !== 'stair') continue;
          const z0 = Math.min(sf.zTop, sf.zTop + sf.dir * BR.L), z1 = Math.max(sf.zTop, sf.zTop + sf.dir * BR.L);
          const cx = H.clamp(pos.x, sf.x0, sf.x1), cz = H.clamp(lz, z0, z1);
          const dx = pos.x - cx, dz = lz - cz, d2 = dx * dx + dz * dz;
          if (d2 < r * r && d2 > 1e-8) { const d = Math.sqrt(d2), k = (r - d) / d; pos.x += dx * k; pos.z += dz * k; }
        }
      }
      for (const c of ch.circles) {
        const dx = pos.x - c.x, dz = pos.z - gz - c.z, rr = r + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-8) { const d = Math.sqrt(d2), k = (rr - d) / d; pos.x += dx * k; pos.z += dz * k; }
      }
    }
    // 空气墙
    Wd.hitWall = Math.abs(pos.x) > Wd.WALL - r - 0.05;
    pos.x = H.clamp(pos.x, -(Wd.WALL - r), Wd.WALL - r);
  };

  // 能站的表面高度：地面、天桥台阶、桥面。只认比当前脚底高不超过 0.5m 的面（走到桥下不会被"吸"上桥）
  Wd.surfaceY = function (x, z, yNow) {
    let best = Wd.groundY(x);
    for (const ch of Wd.chunks.values()) {
      if (!ch.surf.length) continue;
      const lz = z - ch.group.position.z;
      if (lz < -2 || lz > CH + 2) continue;
      for (const sf of ch.surf) {
        if (x < sf.x0 || x > sf.x1) continue;
        let hgt;
        if (sf.k === 'deck') { if (lz < sf.z0 || lz > sf.z1) continue; hgt = sf.y; }
        else { const u = (lz - sf.zTop) * sf.dir; if (u < -0.05 || u > BR.L + 0.05) continue; hgt = stairY(u); }
        if (hgt <= yNow + 0.5 && hgt > best) best = hgt;
      }
    }
    if (H.interior) { const iy = H.interior.surfaceY(x, z, yNow); if (iy > best) best = iy; }
    return best;
  };
  // 附近天桥的行人路线（渲染坐标）
  Wd.bridgePaths = function (zc, range) {
    const out = [];
    for (const ch of Wd.chunks.values()) {
      if (!ch.paths.length || !ch.ready) continue;
      const gz = ch.group.position.z;
      if (Math.abs(gz + 32 - zc) > range) continue;
      for (const pth of ch.paths) out.push(pth.map(([x, y, z]) => [x, y, z + gz]));
    }
    return out;
  };

  // 最近的若干盏路灯（渲染坐标）
  Wd.nearLamps = function (p, n, out) {
    const list = [];
    for (const ch of Wd.chunks.values()) {
      if (!ch.ready) continue;
      const gz = ch.group.position.z;
      if (Math.abs(gz + 32 - p.z) > 120) continue;
      for (const l of ch.lamps) list.push({ x: l.x, y: l.y, z: l.z + gz, d: (l.x - p.x) ** 2 + (l.z + gz - p.z) ** 2 });
    }
    list.sort((a, b) => a.d - b.d);
    out.length = 0; for (let k = 0; k < Math.min(n, list.length); k++) out.push(list[k]);
    return out;
  };
  Wd.busStops = function (p, range) {
    const out = [];
    for (const ch of Wd.chunks.values()) {
      const gz = ch.group.position.z;
      for (const s of ch.stops) if (Math.abs(s.z + gz - p.z) < range) out.push({ x: s.x, z: s.z + gz, side: s.side });
    }
    return out;
  };

  Wd.rebase = function (dz) {
    Wd.originZ -= dz;
    for (const ch of Wd.chunks.values()) ch.group.position.z += dz;
  };
  // 里程：出生点为 K404+000，往 -z 方向开里程增加
  Wd.km = function (renderZ) {
    const m = Math.round(-(renderZ + Wd.originZ)) + 404000;
    const k = Math.floor(m / 1000), r = ((m % 1000) + 1000) % 1000;
    return `K${k}+${String(r).padStart(3, '0')}`;
  };
})();
