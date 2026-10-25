// 载具：能开的汽车（两厢 / 三厢 / SUV）和能骑的自行车（共享单车 / 公路车）。
// 正在开的、召唤出来的、开过的是"动态载具"（完整模型：驾驶舱、雨刮、骑手的腿）；
// 停车带里的车和车架上的单车用实例化网格批量画，走过去按 F 就接管成动态载具。
'use strict';
(function () {
  const V = H.veh = {};
  V.list = [];          // 动态载具
  V.MAX_DYN = 8;
  const PI = Math.PI;
  const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
  const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

  // ---------- 小工具 ----------
  function TR(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _e.set(rx, ry, rz, 'XYZ'); _q.setFromEuler(_e);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.clone(), new THREE.Vector3(sx, sy, sz));
  }
  // 部件收集器：按"分组|材质"收几何，最后合并（一辆车只剩十几个网格）
  class Sink {
    constructor() { this.parts = new Map(); }
    add(group, mat, geo, m) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (m) g.applyMatrix4(m);
      const key = group + '|' + mat;
      if (!this.parts.has(key)) this.parts.set(key, []);
      this.parts.get(key).push(g);
    }
    merged() {
      const out = {};
      for (const [key, list] of this.parts) {
        const [group, mat] = key.split('|');
        const g = THREE.BufferGeometryUtils.mergeBufferGeometries(list);
        list.forEach((x) => x.dispose());
        g.computeBoundingSphere();
        (out[group] || (out[group] = {}))[mat] = g;
      }
      return out;
    }
  }
  // 带收分的圆角盒（车身/车舱）：顶部往里收出倾斜的挡风玻璃，法线用雅可比矩阵修正
  function taperBox(w, h, d, r, seg, bx, bzF, bzR) {
    const g = H.roundedBox(w, h, d, r, seg);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const t = (y + h / 2) / h;
      const bz = z < 0 ? bzF : bzR;
      const a = 1 - bx * t, d2 = 1 - bz * t, cx = -x * bx / h, cz = -z * bz / h;
      p.setXYZ(i, x * a, y, z * d2);
      const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
      const mx = nx / a, my = -cx / a * nx + ny - cz / d2 * nz, mz = nz / d2;
      const l = Math.hypot(mx, my, mz);
      n.setXYZ(i, mx / l, my / l, mz / l);
    }
    return g;
  }
  function rrShape(w, h, r) {
    const sh = new THREE.Shape(), x0 = -w / 2, y0 = -h / 2;
    sh.moveTo(x0 + r, y0); sh.lineTo(x0 + w - r, y0); sh.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    sh.lineTo(x0 + w, y0 + h - r); sh.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    sh.lineTo(x0 + r, y0 + h); sh.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    sh.lineTo(x0, y0 + r); sh.quadraticCurveTo(x0, y0, x0 + r, y0);
    return new THREE.ShapeGeometry(sh, 4);
  }
  // 两点之间的一根管子（关节处另加小球，转角不尖）
  function tube(a, b, r, seg = 8) {
    const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
    const d = new THREE.Vector3().subVectors(Bv, A), len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(Bv).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
    return g;
  }
  const ball = (r, p) => { const g = new THREE.SphereGeometry(r, 8, 6); g.translate(p[0], p[1], p[2]); return g; };
  function plateTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 80;
    const x = c.getContext('2d');
    x.fillStyle = '#1f5fae'; x.beginPath(); x.roundRect(2, 2, 252, 76, 12); x.fill();
    x.strokeStyle = '#fff'; x.lineWidth = 4; x.beginPath(); x.roundRect(8, 8, 240, 64, 8); x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold 50px "PingFang SC",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('路·404', 128, 42);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  // ---------- 车型 ----------
  // L 车长、W 车宽、by/bh 下车身底高/高度、cab* 车舱、tF/tR/tX 车舱顶部前/后/左右收分、wb 前后轮到中心、wr 轮半径、track 轮距一半
  const MODELS = {
    hatch: { name: '两厢小车', L: 4.25, W: 1.8, by: 0.33, bh: 0.62, cabL: 2.45, cabH: 0.62, cabZ: 0.15, tF: 0.5, tR: 0.25, tX: 0.13, rB: 0.26, rC: 0.16, wb: 1.35, wr: 0.33, track: 0.82 },
    sedan: { name: '三厢轿车', L: 4.7, W: 1.82, by: 0.31, bh: 0.57, cabL: 2.55, cabH: 0.58, cabZ: 0.08, tF: 0.55, tR: 0.5, tX: 0.14, rB: 0.24, rC: 0.16, wb: 1.45, wr: 0.32, track: 0.83 },
    suv: { name: 'SUV', L: 4.55, W: 1.9, by: 0.42, bh: 0.72, cabL: 2.8, cabH: 0.66, cabZ: 0.22, tF: 0.42, tR: 0.12, tX: 0.08, rB: 0.28, rC: 0.18, wb: 1.42, wr: 0.38, track: 0.86, rails: true },
  };
  V.MODELS = MODELS;
  function derive(M) {
    const D = {};
    D.k = M.W / 1.8; D.cabW = M.W - 0.14;
    D.top = M.by + M.bh; D.cabTop = D.top + M.cabH;
    D.wsB = M.cabZ - M.cabL / 2; D.wsT = M.cabZ - M.cabL / 2 * (1 - M.tF);
    D.rwB = M.cabZ + M.cabL / 2; D.rwT = M.cabZ + M.cabL / 2 * (1 - M.tR);
    D.wsAng = Math.atan2(D.wsT - D.wsB, M.cabH); D.wsLen = Math.hypot(M.cabH, D.wsT - D.wsB);
    D.rwAng = Math.atan2(D.rwB - D.rwT, M.cabH); D.rwLen = Math.hypot(M.cabH, D.rwB - D.rwT);
    D.eye = new THREE.Vector3(-0.2 * M.W, D.top + 0.24, M.cabZ + 0.07);
    D.rig = TR(D.eye.x, D.top - 0.08, D.wsB + 0.605, -0.52);
    const ws = D.wsLen / 0.8715;
    D.wipers = [{ px: -0.16 * D.k, len: 0.62 * ws }, { px: 0.44 * D.k, len: 0.5 * ws }];
    D.dropW = 2 * (D.cabW / 2 * (1 - M.tX / 2)) - 2 * M.rC + 0.08; D.dropH = D.wsLen - 0.05;
    D.wheelPos = [[-M.track, M.wr, -M.wb, 1], [M.track, M.wr, -M.wb, 1], [-M.track, M.wr, M.wb, 0], [M.track, M.wr, M.wb, 0]];
    D.circ = [-(M.L / 2 - M.W / 2), 0, M.L / 2 - M.W / 2]; D.cr = M.W / 2 + 0.02;
    return D;
  }

  // 汽车所有部件。full = 动态车（分组：body / w0..w3 / cab / steer / wip0 / wip1）；否则全部并进 body（停着的车）
  function carParts(M, D, S, full) {
    const { L, W, by, bh, cabL, cabH, cabZ, tF, tR, tX, rB, rC, wr } = M;
    const k = D.k, top = D.top, cabTop = D.cabTop, cabW = D.cabW;
    const rb0 = H.roundedBox, sg3 = full ? 3 : 2; // 停着的车用低一点的细分
    const rb = (w, h, d, r, seg) => rb0(w, h, d, r, full ? seg : Math.min(seg, 1));
    S.add('body', full ? 'paintClip' : 'paint', taperBox(W, bh, L, rB, sg3, 0.05, 0.08, 0.05), TR(0, by + bh / 2, 0));
    S.add('body', 'paint', taperBox(cabW, cabH, cabL, rC, sg3, tX, tF, tR), TR(0, top + cabH / 2, cabZ));
    // 挡风玻璃 / 后窗：只朝外，从车里看不到它
    const gw = 2 * (cabW / 2 * (1 - tX / 2)) - 2 * rC - 0.1;
    const wsF = TR(0, top + 0.015, D.wsB + 0.005, D.wsAng);
    S.add('body', 'glass', rrShape(gw, D.wsLen - 2 * rC - 0.02, 0.09), wsF.clone().multiply(TR(0, D.wsLen / 2 - 0.015, -0.013, 0, PI, 0)));
    const rwF = TR(0, top + 0.02, D.rwB - 0.005, -D.rwAng);
    S.add('body', 'glass', rrShape(gw - 0.1, D.rwLen - 2 * rC - 0.02, 0.08), rwF.clone().multiply(TR(0, D.rwLen / 2 - 0.02, 0.013)));
    for (const s of [-1, 1]) {
      // 侧窗：梯形，前沿跟着挡风玻璃的斜度
      const tAt = (y) => (y - top) / cabH;
      const zf = (y) => cabZ - cabL / 2 * (1 - tF * tAt(y)) + 0.2, zr = (y) => cabZ + cabL / 2 * (1 - tR * tAt(y)) - 0.22;
      const yb = top + 0.05, yt = cabTop - 0.09, yc = (yb + yt) / 2;
      const sh = new THREE.Shape();
      [[zf(yb), yb], [zr(yb), yb], [zr(yt), yt], [zf(yt), yt]].forEach(([z, y], i) => { const X = s > 0 ? -z : z; if (i) sh.lineTo(X, y - yc); else sh.moveTo(X, y - yc); });
      const sg = new THREE.ShapeGeometry(sh); sg.rotateY(s * PI / 2);
      const halfW = cabW / 2 * (1 - tX * tAt(yc)), tilt = Math.atan(cabW / 2 * tX / cabH);
      S.add('body', 'glass', sg, TR(s * (halfW + 0.006), yc, 0, 0, 0, s * tilt));
      S.add('body', 'paint', rb(0.03, yt - yb - 0.14, 0.1, 0.015, 1), TR(s * (halfW + 0.008), yc - 0.03, cabZ + 0.43, 0, 0, s * tilt));
      // 后视镜（外壳 + 朝后的镜面）
      S.add('body', 'dark', rb(0.09, 0.05, 0.08, 0.02, 1), TR(s * (W / 2 - 0.04), top + 0.05, D.wsB + 0.355));
      S.add('body', 'paint', rb(0.24, 0.15, 0.09, 0.05, 2), TR(s * (W / 2 + 0.1), top + 0.11, D.wsB + 0.355, 0, s * 0.12, 0));
      S.add('body', 'chrome', rb(0.2, 0.11, 0.01, 0.03, 1), TR(s * (W / 2 + 0.1), top + 0.11, D.wsB + 0.403, 0, s * 0.12, 0));
      S.add('body', 'head', rb(0.3, 0.12, 0.05, 0.05, 2), TR(s * 0.58 * k, by + bh * 0.72, -(L / 2 - 0.005)));
      S.add('body', 'tail', rb(0.34, 0.12, 0.05, 0.05, 2), TR(s * 0.6 * k, by + bh * 0.79, L / 2 - 0.005));
      S.add('body', 'chrome', rb(0.02, 0.03, 0.18, 0.012, 1), TR(s * (W / 2 + 0.005), by + bh * 0.84, cabZ - 0.1));
      if (M.rails) S.add('body', 'dark', rb(0.05, 0.05, cabL * 0.78, 0.02, 1), TR(s * (cabW / 2 * (1 - tX) - 0.14), cabTop + 0.03, cabZ));
    }
    S.add('body', 'dark', rb(W - 0.2, 0.16, 0.12, 0.06, 2), TR(0, by + 0.12, -(L / 2 + 0.005)));
    S.add('body', 'dark', rb(W - 0.2, 0.16, 0.12, 0.06, 2), TR(0, by + 0.12, L / 2 + 0.005));
    const plate = new THREE.PlaneGeometry(0.44, 0.14);
    S.add('body', 'plate', plate, TR(0, by + 0.23, -(L / 2 + 0.075), 0, PI, 0));
    S.add('body', 'plate', plate, TR(0, by + 0.25, L / 2 + 0.075));
    // 车轮
    const tire = H.roundedCylinder(wr, 0.24, 0.09, full ? 22 : 12); tire.rotateZ(PI / 2);
    const rim = H.roundedCylinder(wr * 0.6, 0.25, 0.04, full ? 16 : 8); rim.rotateZ(PI / 2);
    const hub = rb(0.26 * wr / 0.33, 0.05, 0.3 * wr / 0.33, 0.02, 1);
    D.wheelPos.forEach(([x, y, z], i) => {
      const grp = full ? 'w' + i : 'body', base = full ? new THREE.Matrix4() : TR(x, y, z);
      S.add(grp, 'rubber', tire, base);
      S.add(grp, 'chrome', rim, base.clone().multiply(TR(Math.sign(x) * 0.005)));
      S.add(grp, 'chrome', hub, base.clone().multiply(TR(Math.sign(x) * 0.01)));
    });
    if (!full) return;
    // ---------- 驾驶舱（位置都由车型尺寸推出来） ----------
    const e = D.eye, C = (mat, geo, m) => S.add('cab', mat, geo, m);
    C('inner', rb(1.62 * k, 0.22, 0.52, 0.09, 2), TR(0, top - 0.05, D.wsB + 0.195));
    C('inner', rb(0.5, 0.17, 0.05, 0.03, 2), TR(e.x, top + 0.15, D.wsB + 0.315, -0.3));
    C('inner', rb(1.58 * k, 0.05, cabL * 0.9, 0.02, 1), TR(0, by + 0.07, cabZ - 0.01));
    C('inner', rb(1.58 * k, 0.62, 0.05, 0.02, 1), TR(0, top - 0.27, D.wsB + 0.145));
    C('inner', rb(1.58 * k, 0.6, 0.05, 0.02, 1), TR(0, top - 0.27, D.rwB - 0.155));
    C('innerLight', rb(1.24 * k, 0.04, cabL * 0.58, 0.02, 1), TR(0, cabTop - 0.035, cabZ + 0.17));
    C('pillar', rb(1.2 * k, 0.07, 0.1, 0.03, 1), TR(0, cabTop - 0.08, D.wsT + 0.06));
    for (const s of [-1, 1]) {
      C('pillar', rb(0.065, D.wsLen - 0.07, 0.08, 0.03, 1), TR(s * 0.68 * k, (top + cabTop) / 2 - 0.04, (D.wsB + D.wsT) / 2 + 0.05, D.wsAng, 0, s * 0.06));
      C('pillar', rb(0.07, cabH - 0.04, 0.12, 0.03, 1), TR(s * 0.71 * k, top + cabH * 0.47, cabZ + 0.45, 0, 0, -s * 0.12));
      C('pillar', rb(0.07, cabH * 0.74, 0.2, 0.03, 1), TR(s * 0.62 * k, top + cabH * 0.52, (D.rwB + D.rwT) / 2 - 0.2, -D.rwAng, 0, -s * 0.12));
      C('inner', rb(0.06, 0.58, cabL * 0.9, 0.03, 1), TR(s * 0.76 * k, top - 0.33, cabZ)); // 门板（压在车身里，圆角处不露出来）
      C('seat', rb(0.12, 0.05, 0.5, 0.02, 1), TR(s * 0.71 * k, top - 0.09, cabZ - 0.15));
      C('seat', rb(0.52, 0.12, 0.52, 0.06, 2), TR(s * 0.37 * k, by + 0.25, e.z + 0.08));
      C('seat', rb(0.5, 0.68, 0.12, 0.06, 2), TR(s * 0.37 * k, top + 0.03, e.z + 0.4, -0.12));
      C('seat', rb(0.28, 0.2, 0.1, 0.05, 2), TR(s * 0.37 * k, top + 0.47, e.z + 0.46, -0.12));
    }
    C('seat', rb(1.3 * k, 0.14, 0.45, 0.06, 2), TR(0, by + 0.27, D.rwB - 0.45));
    C('seat', rb(1.3 * k, 0.5, 0.12, 0.06, 2), TR(0, top - 0.05, D.rwB - 0.26, -0.2));
    C('inner', rb(0.24, 0.3, 0.75, 0.06, 2), TR(0, by + 0.22, e.z - 0.52));
    C('dark', rb(0.2, 0.06, 0.025, 0.025, 1), TR(0, cabTop - 0.11, D.wsT + 0.04));
    C('inner', H.roundedCylinder(0.03, 0.3, 0.01, 8), D.rig.clone().multiply(TR(0, 0, 0.15, PI / 2)));
    // 方向盘（转向柱坐标系里）
    S.add('steer', 'dark', new THREE.TorusGeometry(0.18, 0.024, 10, 30));
    S.add('steer', 'inner', H.roundedCylinder(0.06, 0.05, 0.02, 14), TR(0, 0, 0, PI / 2));
    for (const a of [0, 2.1, -2.1]) S.add('steer', 'inner', rb(0.17, 0.03, 0.02, 0.01, 1), TR(Math.cos(a - PI / 2) * 0.09, Math.sin(a - PI / 2) * 0.09, 0, 0, 0, a - PI / 2));
    // 雨刮（各自转轴坐标系里）
    D.wipers.forEach((w, i) => {
      const arm = rb(w.len, 0.022, 0.018, 0.008, 1); arm.translate(w.len / 2, 0, 0);
      S.add('wip' + i, 'rubber', arm);
      S.add('wip' + i, 'rubber', rb(0.035, 0.035, 0.03, 0.012, 1));
    });
  }

  // ---------- 自行车 ----------
  // 局部坐标：车头朝 -z，原点在两轮中间的地面。返回关键尺寸
  const BK = { R: 0.34, FZ: -0.53, RZ: 0.52, HZ: -0.43, BB: new THREE.Vector3(0, 0.3, 0.02), CRANK: 0.17 };
  function bikeParts(style, S, full) {
    const { R, FZ, RZ, HZ } = BK, shared = style === 'shared';
    const tr = shared ? 0.027 : 0.02;
    const FRM = 'frame', FRT = full ? 'front' : 'frame';
    const fo = full ? TR(0, 0, -HZ) : null;                        // 车把那一组相对转向轴
    const at = (grp, m) => (grp === 'front' && fo ? fo.clone().multiply(m || new THREE.Matrix4()) : m);
    const T = (a, b, r = tr, mat = 'frame', grp = FRM) => { S.add(grp, mat, tube(a, b, r, full ? 8 : 6), at(grp)); if (full) S.add(grp, mat, ball(r, b), at(grp)); };
    const ts = full ? 30 : 16, tt = full ? 8 : 5;
    // 车轮
    const wheel = (grp, cz) => {
      const base = full ? new THREE.Matrix4() : TR(0, R, cz);
      const tire = new THREE.TorusGeometry(R - 0.022, 0.022, tt, ts); tire.rotateY(PI / 2);
      const rim = new THREE.TorusGeometry(R - 0.05, 0.011, 4, ts); rim.rotateY(PI / 2);
      S.add(grp, 'rubber', tire, base); S.add(grp, 'metal', rim, base);
      const n = shared ? 5 : (full ? 14 : 8);
      for (let i = 0; i < n; i++) {
        const sp = shared ? H.roundedBox(0.02, R - 0.06, 0.03, 0.008, 1) : H.roundedBox(0.004, R - 0.06, 0.004, 0, 0);
        S.add(grp, shared ? 'frame' : 'metal', sp, base.clone().multiply(TR(0, 0, 0, i / n * PI * 2)).multiply(TR(0, (R - 0.06) / 2, 0)));
      }
      const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.1, 10); hub.rotateZ(PI / 2);
      S.add(grp, 'metal', hub, base);
    };
    wheel(full ? 'fw' : 'frame', FZ); wheel(full ? 'rw' : 'frame', RZ);
    // 车架
    const BB = [0, 0.3, 0.02];
    if (shared) {
      T([0, 0.74, -0.46], [0, 0.98, -0.41], tr * 1.25);
      T([0, 0.74, -0.46], [0, 0.44, -0.22]); T([0, 0.44, -0.22], BB);
      T(BB, [0, 0.82, 0.14]);
      S.add(FRM, 'frame', H.roundedBox(0.035, 0.13, 0.62, 0.04, 1), TR(0.075, 0.31, 0.27));           // 链罩
      S.add(FRM, 'frame', H.roundedBox(0.06, 0.03, 0.1, 0.012, 1), TR(0, 0.62, 0.8));
      S.add(FRM, 'tail', H.roundedBox(0.07, 0.04, 0.02, 0.01, 1), TR(0, 0.63, 0.855));                 // 尾灯反光片
    } else {
      T([0, 0.76, -0.45], [0, 0.96, -0.41], tr * 1.25);
      T([0, 0.93, -0.41], [0, 0.88, 0.12]); T([0, 0.78, -0.44], BB); T(BB, [0, 0.9, 0.13]);
    }
    for (const s of [-1, 1]) {
      T(BB, [s * 0.06, R, RZ], tr * 0.65);
      T([0, shared ? 0.8 : 0.88, 0.135], [s * 0.06, R, RZ], tr * 0.6);
    }
    const seatTop = shared ? 0.93 : 1.0;
    T([0, shared ? 0.82 : 0.9, 0.14], [0, seatTop, 0.165], 0.016, 'metal');
    S.add(FRM, 'saddle', H.roundedBox(0.16, 0.065, 0.27, 0.03, 2), TR(0, seatTop + 0.03, 0.18));
    T([-0.05, 0.3, 0.08], [-0.16, 0.01, 0.18], 0.012, 'metal');                                             // 脚撑
    // 挡泥板（后）
    if (shared) {
      const fd = (cz, u0, arc, grp) => {
        const g = new THREE.TorusGeometry(R + 0.04, 0.014, 6, 16, arc); g.rotateZ(u0); g.rotateY(PI / 2);
        S.add(grp, 'frame', g, at(grp, TR(0, R, cz)));
      };
      fd(RZ, 1.25, 2.2, FRM); fd(FZ, 0.35, 1.6, FRT);
    }
    // 车把一组：前叉、把立、车把、握把、车铃、车筐
    for (const s of [-1, 1]) T([0, shared ? 0.74 : 0.76, -0.46], [s * 0.05, R, FZ], 0.016, 'frame', FRT);
    T([0, shared ? 0.98 : 0.96, -0.41], [0, 1.05, -0.44], 0.018, 'metal', FRT);
    const bw = shared ? 0.29 : 0.31, by = shared ? 1.06 : 1.04;
    T([-bw, by, -0.36], [-0.1, by, -0.43], 0.013, 'metal', FRT); T([-0.1, by, -0.43], [0.1, by, -0.43], 0.013, 'metal', FRT); T([0.1, by, -0.43], [bw, by, -0.36], 0.013, 'metal', FRT);
    for (const s of [-1, 1]) T([s * bw, by, -0.36], [s * (bw - 0.11), by, -0.39], 0.019, 'rubber', FRT);
    S.add(FRT, 'metal', ball(0.024, [-0.17, by + 0.03, -0.41]), at(FRT));
    if (shared) {
      // 车筐：四面 + 底面的铁丝网（贴图镂空），上口一圈粗边
      const bw2 = 0.38, bh2 = 0.22, bd2 = 0.3, bc = [0, 0.95, -0.67];
      const wall = (w, h, m) => { const g = new THREE.PlaneGeometry(w, h); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * 14, uv.getY(i) * h * 14); S.add(FRT, 'basket', g, at(FRT, m)); };
      wall(bw2, bh2, TR(bc[0], bc[1], bc[2] - bd2 / 2)); wall(bw2, bh2, TR(bc[0], bc[1], bc[2] + bd2 / 2));
      wall(bd2, bh2, TR(bc[0] - bw2 / 2, bc[1], bc[2], 0, PI / 2, 0)); wall(bd2, bh2, TR(bc[0] + bw2 / 2, bc[1], bc[2], 0, PI / 2, 0));
      wall(bw2, bd2, TR(bc[0], bc[1] - bh2 / 2, bc[2], -PI / 2));
      for (const [a, b] of [[[-bw2 / 2, bh2 / 2, -bd2 / 2], [bw2 / 2, bh2 / 2, -bd2 / 2]], [[-bw2 / 2, bh2 / 2, bd2 / 2], [bw2 / 2, bh2 / 2, bd2 / 2]], [[-bw2 / 2, bh2 / 2, -bd2 / 2], [-bw2 / 2, bh2 / 2, bd2 / 2]], [[bw2 / 2, bh2 / 2, -bd2 / 2], [bw2 / 2, bh2 / 2, bd2 / 2]]]) {
        S.add(FRT, 'metal', tube([a[0] + bc[0], a[1] + bc[1], a[2] + bc[2]], [b[0] + bc[0], b[1] + bc[1], b[2] + bc[2]], 0.009, 6), at(FRT));
      }
      S.add(FRT, 'head', H.roundedBox(0.08, 0.05, 0.03, 0.015, 1), at(FRT, TR(0, 0.78, -0.8))); // 车前灯挂在车筐下面
    }
    // 牙盘（中轴坐标系）：链轮 + 两根曲柄（角度 0 时右曲柄朝前）
    const CRK = full ? 'crank' : 'frame', cb = full ? new THREE.Matrix4() : TR(BB[0], BB[1], BB[2]);
    const ring = new THREE.TorusGeometry(0.1, 0.012, 6, 24); ring.rotateY(PI / 2);
    S.add(CRK, 'metal', ring, cb.clone().multiply(TR(0.065)));
    S.add(CRK, 'metal', tube([0.085, 0, 0], [0.09, 0, -BK.CRANK], 0.013), cb);
    S.add(CRK, 'metal', tube([-0.085, 0, 0], [-0.09, 0, BK.CRANK], 0.013), cb);
    if (!full) for (const s of [-1, 1]) S.add('frame', 'rubber', H.roundedBox(0.1, 0.024, 0.075, 0.01, 1), TR(s * 0.135, BB[1], BB[2] - s * BK.CRANK));
    return { seatTop, barY: by, barW: bw };
  }

  // ---------- 共享材质 ----------
  const SH = {};
  function sharedMats() {
    if (SH.glass) return SH;
    SH.glass = new THREE.MeshPhysicalMaterial({ color: '#1b252e', roughness: 0.04, metalness: 0.4, clearcoat: 1, envMapIntensity: 1.6 });
    SH.dark = new THREE.MeshStandardMaterial({ color: '#25282d', roughness: 0.6 });
    SH.chrome = new THREE.MeshStandardMaterial({ color: '#d9dde2', roughness: 0.18, metalness: 1 });
    SH.rubber = new THREE.MeshStandardMaterial({ color: '#1c1d20', roughness: 0.85 });
    SH.inner = new THREE.MeshStandardMaterial({ color: '#34373d', roughness: 0.75 });
    SH.innerLight = new THREE.MeshStandardMaterial({ color: '#b9b4ac', roughness: 0.9 });
    SH.pillar = new THREE.MeshStandardMaterial({ color: '#55585e', roughness: 0.85 });
    SH.seat = new THREE.MeshStandardMaterial({ color: '#4a4440', roughness: 0.9 });
    SH.plate = new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.4 });
    SH.headOff = new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.1, metalness: 0.2 });
    SH.tailOff = new THREE.MeshStandardMaterial({ color: '#8f1f18', roughness: 0.25 });
    SH.metal = new THREE.MeshStandardMaterial({ color: '#b9bec4', roughness: 0.3, metalness: 0.85 });
    SH.saddle = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.6 });
    // 铁丝网：网格线贴图 + alphaTest 镂空
    const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
    x.clearRect(0, 0, 32, 32); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 32, 5); x.fillRect(0, 0, 5, 32);
    const wt = new THREE.CanvasTexture(c); wt.wrapS = wt.wrapT = THREE.RepeatWrapping;
    SH.basket = new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.5, metalness: 0.4, alphaMap: wt, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
    return SH;
  }
  function mkMeshes(geos, mats, parent, cast) {
    for (const mat in geos || {}) {
      const m = new THREE.Mesh(geos[mat], mats[mat]);
      m.castShadow = cast; m.receiveShadow = true; parent.add(m);
    }
  }

  // ======================= 汽车 =======================
  const REST = 0.08, MAXA = 2.45;
  class Car {
    constructor(model, color, x, z, yaw) {
      this.type = 'car'; this.model = model;
      const M = this.M = MODELS[model], D = this.D = derive(M);
      this.color = color;
      this.paint = H.mat.patch(new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }));
      // 下车身是实心盒，顶面会挡住车舱：用 6 个裁剪平面（取交集）在车舱位置挖空。n·p + c < 0 一侧被裁掉
      const k = D.k;
      this.holeLocal = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -0.78 * k), new THREE.Plane(new THREE.Vector3(-1, 0, 0), -0.78 * k),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -(D.rwB - 0.175)), new THREE.Plane(new THREE.Vector3(0, 0, -1), D.wsB + 0.155),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -(D.top + 0.05)), new THREE.Plane(new THREE.Vector3(0, -1, 0), M.by + 0.17),
      ];
      this.hole = this.holeLocal.map((p) => p.clone());
      this.paintClip = this.paint.clone(); this.paintClip.onBeforeCompile = this.paint.onBeforeCompile;
      this.paintClip.clippingPlanes = this.hole; this.paintClip.clipIntersection = true; this.paintClip.clipShadows = true;
      this.head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dd', emissiveIntensity: 0.15, roughness: 0.1 });
      this.tail = new THREE.MeshStandardMaterial({ color: '#b3261e', emissive: '#ff2a1a', emissiveIntensity: 0.25, roughness: 0.2 });
      const mats = Object.assign({}, sharedMats(), { paint: this.paint, paintClip: this.paintClip, head: this.head, tail: this.tail });
      const S = new Sink(); carParts(M, D, S, true);
      const geos = S.merged();
      const g = this.group = new THREE.Group(); V.scene.add(g);
      mkMeshes(geos.body, mats, g, true);
      this.interior = new THREE.Group(); g.add(this.interior); mkMeshes(geos.cab, mats, this.interior, false);
      this.wheelRig = new THREE.Group(); D.rig.decompose(this.wheelRig.position, this.wheelRig.quaternion, this.wheelRig.scale); this.interior.add(this.wheelRig);
      this.steerWheel = new THREE.Group(); this.wheelRig.add(this.steerWheel); mkMeshes(geos.steer, mats, this.steerWheel, false);
      this.wheels = D.wheelPos.map(([wx, wy, wz, front], i) => {
        const pivot = new THREE.Group(); pivot.position.set(wx, wy, wz); g.add(pivot);
        const spin = new THREE.Group(); pivot.add(spin); mkMeshes(geos['w' + i], mats, spin, true);
        return { pivot, spin, front: !!front };
      });
      // 仪表
      this.dashC = document.createElement('canvas'); this.dashC.width = 512; this.dashC.height = 192;
      this.dashT = new THREE.CanvasTexture(this.dashC); this.dashT.encoding = THREE.sRGBEncoding;
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.165), new THREE.MeshBasicMaterial({ map: this.dashT, toneMapped: false }));
      dash.position.set(D.eye.x, D.top + 0.155, D.wsB + 0.345); dash.rotation.x = -0.3; this.interior.add(dash);
      // 挡风玻璃：雨滴层 + 雨刮
      const wf = this.wsFrame = new THREE.Group(); wf.position.set(0, D.top + 0.015, D.wsB + 0.005); wf.rotation.x = D.wsAng; g.add(wf);
      this.dropC = document.createElement('canvas'); this.dropC.width = Math.round(D.dropW * 200); this.dropC.height = Math.round(D.dropH * 200);
      this.dropX = this.dropC.getContext('2d');
      this.dropT = new THREE.CanvasTexture(this.dropC); this.dropT.encoding = THREE.sRGBEncoding;
      this.dropMat = new THREE.MeshBasicMaterial({ map: this.dropT, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const dp = new THREE.Mesh(new THREE.PlaneGeometry(D.dropW, D.dropH), this.dropMat);
      dp.position.set(0, D.dropH / 2, -0.032); dp.renderOrder = 6; wf.add(dp);
      this.wipers = D.wipers.map((w, i) => {
        const piv = new THREE.Group(); piv.position.set(w.px, 0.05, -0.045); wf.add(piv);
        mkMeshes(geos['wip' + i], mats, piv, false);
        return { piv, px: w.px, len: w.len, prev: REST };
      });
      this.state = { x, z, yaw, speed: 0, steer: 0, spin: 0, gear: 'P', throttle: 0, brake: 0, scrape: 0, latAcc: 0, bump: 0 };
      this.lights = 'auto'; this.wiperMode = 'auto'; this.wiperPhase = 0; this.wiperSweeping = false; this.wiperPause = 0; this.dashTimer = 0;
      this.occupied = false;
      this.sync();
    }
    sync() {
      const s = this.state;
      this.group.position.set(s.x, 0, s.z); this.group.rotation.y = s.yaw;
      this.group.updateMatrixWorld(true);
      for (let i = 0; i < 6; i++) this.hole[i].copy(this.holeLocal[i]).applyMatrix4(this.group.matrixWorld);
    }
    // 车顶 / 引擎盖高度（冰雹、水花落在车上）；不在车上返回 null
    surfaceY(x, z) {
      const s = this.state, M = this.M, D = this.D;
      const dx = x - s.x, dz = z - s.z, c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      const lx = c * dx - sn * dz, lz = sn * dx + c * dz;
      if (Math.abs(lx) > M.W / 2 - 0.02 || Math.abs(lz) > M.L / 2 - 0.05) return null;
      if (Math.abs(lz - M.cabZ) < M.cabL / 2 - 0.25 && Math.abs(lx) < D.cabW / 2 - 0.12) return D.cabTop;
      return D.top;
    }
    doorPos(out) {
      const s = this.state, lx = -(this.M.W / 2 + 0.55), lz = this.M.cabZ - 0.05, c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      return out.set(s.x + c * lx + sn * lz, 0, s.z - sn * lx + c * lz);
    }
    eyeWorld(out) { return out.copy(this.D.eye).applyMatrix4(this.group.matrixWorld); }
    pos(out) { return out.set(this.state.x, 0, this.state.z); }
    circles(fn) { const s = this.state, sn = Math.sin(s.yaw), c = Math.cos(s.yaw); for (const k of this.D.circ) fn(s.x + sn * k, s.z + c * k, this.D.cr); }

    drive(dt, input, env) {
      const s = this.state;
      const grip = 1 - env.wet * 0.25 - env.snow * 0.4 - env.hail * 0.2;
      const fwd = input.up ? 1 : 0, back = input.down ? 1 : 0;
      const steerIn = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      s.steer = H.damp(s.steer, steerIn, steerIn ? 3.2 : 6, dt);
      const maxF = this.model === 'suv' ? 31 : 34, maxR = 7;
      let acc = 0;
      if (fwd) acc = s.speed < -0.3 ? 10 * grip : 5.2 * (1 - Math.max(0, s.speed) / maxF * 0.75);
      if (back) acc = s.speed > 0.3 ? -10 * grip : -3.2;
      if (input.brake) acc = -Math.sign(s.speed) * 12 * grip;
      s.throttle = fwd ? 1 : back && s.speed <= 0.3 ? 0.6 : 0;
      s.brake = (back && s.speed > 0.3) || input.brake ? 1 : 0;
      const drag = 0.0009 * s.speed * Math.abs(s.speed) + Math.sign(s.speed) * 0.35;
      s.speed += (acc - drag) * dt;
      if (!fwd && !back && Math.abs(s.speed) < 0.3) s.speed = 0;
      s.speed = H.clamp(s.speed, -maxR, maxF);
      s.gear = s.speed < -0.2 ? 'R' : Math.abs(s.speed) < 0.2 && !fwd ? 'P' : 'D';
      // 车速越快方向越沉：横向加速度限制在约 0.65g（湿滑路面更低）
      const wheelA = s.steer * 0.55 / (1 + Math.abs(s.speed) * 0.16);
      let yawRate = s.speed * Math.tan(wheelA) / (this.M.wb * 2);
      const maxYaw = Math.min(2.2, (6.4 * grip) / Math.max(Math.abs(s.speed), 0.5));
      yawRate = H.clamp(yawRate, -maxYaw, maxYaw);
      s.yaw += yawRate * dt;
      s.x += -Math.sin(s.yaw) * s.speed * dt;
      s.z += -Math.cos(s.yaw) * s.speed * dt;
      s.latAcc = yawRate * s.speed;
      // 路缘：四个角不许越过路面（停车带也算路面）
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), hw = this.M.W / 2, hl = this.M.L / 2;
      let maxX = -1e9, minX = 1e9;
      for (const [lx, lz] of [[-hw, -hl], [hw, -hl], [-hw, hl], [hw, hl]]) { const xx = s.x + c * lx + sn * lz; maxX = Math.max(maxX, xx); minX = Math.min(minX, xx); }
      const lim = H.world.C.ROAD - 0.08;
      s.scrape = 0;
      if (maxX > lim) { s.x -= maxX - lim; s.scrape = Math.abs(s.speed); s.speed *= Math.pow(0.35, dt); }
      if (minX < -lim) { s.x += -lim - minX; s.scrape = Math.abs(s.speed); s.speed *= Math.pow(0.35, dt); }
      V.resolve(this);
      s.spin += s.speed * dt / this.M.wr;
      for (const w of this.wheels) { w.spin.rotation.x = -s.spin; if (w.front) w.pivot.rotation.y = wheelA; }
      this.steerWheel.rotation.z = s.steer * 2.2;
      this.sync();
    }
    idle(dt) {
      const s = this.state;
      if (s.speed !== 0) {
        s.speed = H.damp(s.speed, 0, 1.5, dt); if (Math.abs(s.speed) < 0.1) s.speed = 0;
        s.x += -Math.sin(s.yaw) * s.speed * dt; s.z += -Math.cos(s.yaw) * s.speed * dt;
        s.spin += s.speed * dt / this.M.wr;
        for (const w of this.wheels) w.spin.rotation.x = -s.spin;
        V.resolve(this);
        this.sync();
      }
      s.throttle = 0; s.gear = 'P'; s.brake = 0;
    }
    // ---------- 雨刮 & 挡风玻璃上的雨滴 ----------
    updateGlass(dt, env) {
      const x = this.dropX, W = this.dropC.width, Hh = this.dropC.height, PX = 200;
      x.globalCompositeOperation = 'destination-out';
      x.fillStyle = `rgba(0,0,0,${H.clamp(dt * (env.rain > 0.05 ? 0.18 : 0.3), 0, 1)})`;
      x.fillRect(0, 0, W, Hh);
      x.globalCompositeOperation = 'source-over';
      const sp = Math.abs(this.state.speed);
      let k = Math.floor((env.rain * 95 + env.hail * 18) * dt * (1 + sp * 0.03) + Math.random());
      while (k-- > 0) {
        const px = Math.random() * W, py = Math.random() * Hh, r = 0.9 + Math.random() * Math.random() * 2.8;
        const gr = x.createRadialGradient(px, py - r * 0.2, r * 0.2, px, py, r);
        gr.addColorStop(0, 'rgba(210,222,235,0.10)'); gr.addColorStop(0.75, 'rgba(160,175,190,0.16)'); gr.addColorStop(1, 'rgba(25,32,42,0.38)');
        x.fillStyle = gr; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.55)'; x.beginPath(); x.arc(px - r * 0.35, py - r * 0.35, Math.max(0.5, r * 0.28), 0, 7); x.fill();
        if (r > 2.6 && sp < 8 && Math.random() < 0.3) { x.fillStyle = 'rgba(200,215,230,0.22)'; x.fillRect(px - 0.6, py, 1.2, 6 + Math.random() * 14); }
      }
      let flakes = Math.floor(env.snow * 40 * dt + Math.random());
      while (flakes-- > 0) { x.fillStyle = 'rgba(255,255,255,0.85)'; x.beginPath(); x.arc(Math.random() * W, Math.random() * Hh, 1 + Math.random() * 2, 0, 7); x.fill(); }
      const wet = env.rain + env.snow + env.hail;
      const mode = this.wiperMode === 'auto' ? (wet > 0.55 ? 'fast' : wet > 0.08 ? 'slow' : 'off') : this.wiperMode;
      this.wiperActive = mode;
      const period = mode === 'fast' ? 1.05 : 1.6;
      if (this.wiperSweeping) {
        this.wiperPhase += dt / period;
        if (this.wiperPhase >= 1) { this.wiperPhase = 0; this.wiperSweeping = false; this.wiperPause = mode === 'slow' ? 1.4 : 0.05; if (V.onWiperEnd) V.onWiperEnd(); }
      } else if (mode !== 'off') { this.wiperPause -= dt; if (this.wiperPause <= 0) this.wiperSweeping = true; }
      const ang = REST + (MAXA - REST) * 0.5 * (1 - Math.cos(this.wiperPhase * PI * 2));
      x.globalCompositeOperation = 'destination-out'; x.fillStyle = 'rgba(0,0,0,1)';
      for (const w of this.wipers) {
        w.piv.rotation.z = ang;
        if (Math.abs(ang - w.prev) > 1e-4) {
          const a0 = Math.min(ang, w.prev) - 0.02, a1 = Math.max(ang, w.prev) + 0.02;
          const cx = (w.px + this.D.dropW / 2) * PX, cy = Hh - 0.05 * PX;
          x.beginPath();
          for (let i = 0; i <= 6; i++) { const a = a0 + (a1 - a0) * i / 6; x.lineTo(cx + Math.cos(a) * w.len * PX, cy - Math.sin(a) * w.len * PX); }
          for (let i = 6; i >= 0; i--) { const a = a0 + (a1 - a0) * i / 6; x.lineTo(cx + Math.cos(a) * 0.1 * PX, cy - Math.sin(a) * 0.1 * PX); }
          x.closePath(); x.fill();
        }
        w.prev = ang;
      }
      x.globalCompositeOperation = 'source-over';
      this.dropT.needsUpdate = true;
      const l = 0.35 + env.light * 0.65;
      this.dropMat.color.setRGB(l, l, l * 1.03);
    }
    updateDash(dt, info) {
      this.dashTimer -= dt;
      if (this.dashTimer > 0) return;
      this.dashTimer = 0.08;
      const x = this.dashC.getContext('2d'), W = 512, Hh = 192;
      x.fillStyle = '#0d1116'; x.fillRect(0, 0, W, Hh);
      const gr = x.createLinearGradient(0, 0, 0, Hh); gr.addColorStop(0, 'rgba(60,140,170,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gr; x.beginPath(); x.roundRect(6, 6, W - 12, Hh - 12, 24); x.fill();
      const kmh = Math.round(Math.abs(this.state.speed) * 3.6);
      x.lineWidth = 12; x.lineCap = 'round';
      x.strokeStyle = 'rgba(255,255,255,0.12)'; x.beginPath(); x.arc(128, 120, 78, PI * 0.8, PI * 2.2); x.stroke();
      x.strokeStyle = kmh > 100 ? '#ffb347' : '#5fe0d0';
      x.beginPath(); x.arc(128, 120, 78, PI * 0.8, PI * 0.8 + PI * 1.4 * Math.min(kmh / 140, 1)); x.stroke();
      x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = 'bold 64px "SF Pro Rounded","PingFang SC",sans-serif'; x.fillText(String(kmh), 128, 112);
      x.font = '22px "PingFang SC",sans-serif'; x.fillStyle = '#9fb3c0'; x.fillText('km/h', 128, 160);
      x.font = 'bold 40px "SF Pro Rounded",sans-serif';
      ['P', 'R', 'D'].forEach((gch, i) => { x.fillStyle = this.state.gear === gch ? '#ffffff' : 'rgba(255,255,255,0.25)'; x.fillText(gch, 268 + i * 36, 52); });
      x.textAlign = 'left';
      x.font = '24px "PingFang SC",sans-serif'; x.fillStyle = '#d7e3ea';
      x.fillText(info.km, 250, 100);
      x.fillText(`${info.icon} ${info.weather}  ${info.clock}`, 250, 136);
      x.font = '20px "PingFang SC",sans-serif'; x.fillStyle = '#8aa0ad';
      const wip = { off: '雨刮 停', slow: '雨刮 慢', fast: '雨刮 快' }[this.wiperActive || 'off'];
      x.fillText(`${this.lightsOn ? '车灯 开' : '车灯 关'} · ${wip}${this.wiperMode === 'auto' ? '(自动)' : ''}`, 250, 170);
      this.dashT.needsUpdate = true;
    }
    updateLights(lightsOn) {
      const on = this.occupied && (this.lights === 'on' || (this.lights === 'auto' && lightsOn > 0.35));
      this.lightsOn = on;
      this.head.emissiveIntensity = on ? 3.2 : 0.12;
      this.tail.emissiveIntensity = (on ? 1.4 : 0.2) + (this.state.brake ? 2 : 0);
    }
    dispose() {
      V.scene.remove(this.group);
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      [this.paint, this.paintClip, this.head, this.tail, this.dropMat].forEach((m) => m.dispose());
      this.dashT.dispose(); this.dropT.dispose();
    }
  }

  // ======================= 自行车 =======================
  const DOWN = new THREE.Vector3(0, -1, 0);
  function buildRider() {
    const G = H.people.G, sh = sharedMats();
    const pants = new THREE.MeshStandardMaterial({ color: '#34496b', roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: '#efc4a2', roughness: 0.55 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#c3c9d0', roughness: 0.85 });
    const shoe = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.45 });
    const group = new THREE.Group();
    const mesh = (g, m) => { const x = new THREE.Mesh(g, m); x.castShadow = true; x.matrixAutoUpdate = false; group.add(x); return x; };
    const legs = [0, 1].map(() => ({ th: mesh(G.thigh, pants), sh: mesh(G.shin, pants), shoe: mesh(G.shoe, shoe), sole: mesh(G.sole, sh.rubber) }));
    const arms = [0, 1].map(() => ({ fa: mesh(G.farm, sleeve), hand: mesh(G.hand, skin) }));
    return { group, legs, arms };
  }
  // 两骨 IK：已知髋和踝，求膝（膝盖朝 hint 方向弯）
  function ik(hip, end, l1, l2, hint, out) {
    _a.subVectors(end, hip); let d = _a.length();
    d = H.clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.005);
    _a.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    _b.copy(hint).addScaledVector(_a, -hint.dot(_a)).normalize();
    return out.copy(hip).addScaledVector(_a, a).addScaledVector(_b, h);
  }
  function placeLimb(mesh, from, to, len, extraQ) {
    _v.subVectors(to, from); const l = _v.length(); _v.divideScalar(l || 1);
    _q.setFromUnitVectors(DOWN, _v);
    if (extraQ) _q.multiply(extraQ);
    mesh.matrix.compose(from, _q, _s.set(1, l / len, 1));
  }
  const Q_TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), PI);
  const Q_GRIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PI / 2);
  const HINT_KNEE = new THREE.Vector3(0, 0.2, -1), HINT_ELBOW = new THREE.Vector3(0, -1, 0.3);

  class Bike {
    constructor(style, color, x, z, yaw, y) {
      this.type = 'bike'; this.style = style; this.color = color;
      this.frameMat = H.mat.patch(new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 }));
      const mats = Object.assign({}, sharedMats(), { frame: this.frameMat, head: SH.headOff, tail: SH.tailOff });
      const S = new Sink(); this.dim = bikeParts(style, S, true); const geos = S.merged();
      const g = this.group = new THREE.Group(); V.scene.add(g);
      this.lean = new THREE.Group(); g.add(this.lean);
      mkMeshes(geos.frame, mats, this.lean, true);
      this.front = new THREE.Group(); this.front.position.set(0, 0, BK.HZ); this.lean.add(this.front); mkMeshes(geos.front, mats, this.front, true);
      this.fw = new THREE.Group(); this.fw.position.set(0, BK.R, BK.FZ - BK.HZ); this.front.add(this.fw); mkMeshes(geos.fw, mats, this.fw, true);
      this.rw = new THREE.Group(); this.rw.position.set(0, BK.R, BK.RZ); this.lean.add(this.rw); mkMeshes(geos.rw, mats, this.rw, true);
      this.crank = new THREE.Group(); this.crank.position.copy(BK.BB); this.lean.add(this.crank); mkMeshes(geos.crank, mats, this.crank, true);
      const pg = H.roundedBox(0.1, 0.024, 0.075, 0.01, 1);
      this.pedals = [0, 1].map(() => { const p = new THREE.Mesh(pg, SH.rubber); p.castShadow = true; this.lean.add(p); return p; });
      this.rider = buildRider(); this.lean.add(this.rider.group); this.rider.group.visible = false;
      this.state = { x, z, y: y === undefined ? H.world.groundY(x) : y, yaw, speed: 0, steer: 0, lean: 0.1, crank: 0.6, spin: 0, ang: 0, pedaling: false, bump: 0 };
      this.occupied = false;
      this.sync(); this.anim();
    }
    pos(out) { return out.set(this.state.x, this.state.y, this.state.z); }
    circles(fn) { const s = this.state, sn = Math.sin(s.yaw), c = Math.cos(s.yaw); for (const k of [-0.45, 0.45]) fn(s.x + sn * k, s.z + c * k, 0.3); }
    surfaceY() { return null; }
    mountPos(out) {
      const s = this.state, lx = -0.75, lz = 0.05, c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      return out.set(s.x + c * lx + sn * lz, s.y, s.z - sn * lx + c * lz);
    }
    eyeWorld(out) {
      const s = this.state;
      const bob = s.pedaling ? Math.sin(s.crank * 2) * 0.012 : 0;
      return out.set(0, this.dim.seatTop + 0.66 + bob, 0.06).applyMatrix4(this.lean.matrixWorld);
    }
    sync() {
      const s = this.state;
      this.group.position.set(s.x, s.y, s.z); this.group.rotation.set(0, s.yaw, 0);
      this.lean.rotation.z = s.lean;
      this.group.updateMatrixWorld(true);
    }
    ride(dt, input, env) {
      const s = this.state, grip = 1 - env.wet * 0.2 - env.snow * 0.45 - env.hail * 0.2;
      const vmax = (input.sprint ? 8.6 : 6.4) * (1 - env.snow * 0.3);
      let acc = 0;
      if (input.up) acc = (input.sprint ? 3.0 : 2.2) * (1 - Math.max(0, s.speed) / vmax);
      if (input.down) acc = s.speed > 0.2 ? -6 * grip : 0;
      s.speed += (acc - Math.sign(s.speed) * (0.12 + 0.004 * s.speed * s.speed)) * dt;
      if (input.down && s.speed <= 0.2) s.speed = H.damp(s.speed, -0.9, 3, dt); // 慢慢往后推
      if (!input.up && !input.down && Math.abs(s.speed) < 0.15) s.speed = 0;
      s.speed = H.clamp(s.speed, -1, vmax);
      const st = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      s.steer = H.damp(s.steer, st, st ? 3.5 : 5, dt);
      s.ang = s.steer * 0.5 / (1 + Math.abs(s.speed) * 0.2);
      let yr = s.speed * Math.tan(s.ang) / 1.05;
      const lim = 3.5 * grip + 0.5; yr = H.clamp(yr, -lim, lim);
      s.yaw += yr * dt;
      s.x += -Math.sin(s.yaw) * s.speed * dt; s.z += -Math.cos(s.yaw) * s.speed * dt;
      // 撞墙、撞树、撞车、撞人
      _p.set(s.x, s.y, s.z);
      H.world.collide(_p, 0.42, true); H.people.collide(_p, 0.35);
      V.collideAgainst(_p, 0.42, this);
      const pushed = Math.hypot(_p.x - s.x, _p.z - s.z);
      if (pushed > 0.03 && Math.abs(s.speed) > 1.5) { s.bump = Math.abs(s.speed); s.speed *= 0.4; }
      s.x = _p.x; s.z = _p.z;
      // 地面（马路 / 路缘 / 人行道 / 桥面），过路缘颠一下
      const gy = H.world.surfaceY(s.x, s.z, s.y);
      s.y = H.damp(s.y, gy, 16, dt);
      const leanT = H.clamp(Math.atan(s.speed * yr / 9.8), -0.42, 0.42);
      s.lean = H.damp(s.lean, Math.abs(s.speed) < 0.3 ? 0 : leanT, 6, dt);
      s.pedaling = !!input.up && s.speed > 0.05;
      if (s.pedaling) s.crank += s.speed / BK.R / 2.6 * dt;
      s.spin += s.speed / BK.R * dt;
      this.sync(); this.anim();
    }
    idle(dt) {
      const s = this.state;
      if (s.speed !== 0) {
        s.speed = H.damp(s.speed, 0, 2, dt); if (Math.abs(s.speed) < 0.1) s.speed = 0;
        s.x += -Math.sin(s.yaw) * s.speed * dt; s.z += -Math.cos(s.yaw) * s.speed * dt;
        s.spin += s.speed / BK.R * dt;
      }
      // 停下来靠脚撑微微向左歪
      s.lean = H.damp(s.lean, s.speed === 0 ? 0.1 : 0, 3, dt); s.pedaling = false; s.ang = H.damp(s.ang, 0.25, 2, dt);
      this.sync(); this.anim();
    }
    anim() {
      const s = this.state;
      this.fw.rotation.x = -s.spin; this.rw.rotation.x = -s.spin;
      this.front.rotation.y = s.ang;
      this.crank.rotation.x = -s.crank;
      const ped = [];
      for (let i = 0; i < 2; i++) {
        const sd = i ? -1 : 1;
        const p = new THREE.Vector3(sd * 0.135, 0, -sd * BK.CRANK).applyAxisAngle(new THREE.Vector3(1, 0, 0), -s.crank).add(BK.BB);
        this.pedals[i].position.copy(p); ped.push(p);
      }
      const R = this.rider;
      R.group.visible = this.occupied;
      if (!this.occupied) return;
      // 腿：髋在车座上，脚踩踏板，膝盖朝前弯
      const seat = this.dim.seatTop;
      for (let i = 0; i < 2; i++) {
        const sd = i ? -1 : 1, L = R.legs[i];
        const hip = new THREE.Vector3(sd * 0.1, seat + 0.02, 0.2);
        const ankle = ped[i].clone().add(new THREE.Vector3(0, 0.075, 0.03));
        const knee = ik(hip, ankle, 0.42, 0.42, HINT_KNEE, new THREE.Vector3());
        placeLimb(L.th, hip, knee, 0.42);
        placeLimb(L.sh, knee, ankle, 0.4);
        L.shoe.matrix.compose(ankle, Q_TURN, _s.set(1, 1, 1)); L.sole.matrix.copy(L.shoe.matrix);
      }
      // 手握车把（跟着车把转），前臂伸向身体
      const bw = this.dim.barW, by = this.dim.barY;
      for (let i = 0; i < 2; i++) {
        const sd = i ? -1 : 1, A = R.arms[i];
        const grip = new THREE.Vector3(sd * (bw - 0.05), by + 0.01, -0.375 - BK.HZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.ang).add(new THREE.Vector3(0, 0, BK.HZ));
        const wrist = grip.clone().add(new THREE.Vector3(0, 0.03, 0.06));
        const elbow = wrist.clone().add(new THREE.Vector3(sd * 0.05, 0.13, 0.22));
        placeLimb(A.fa, elbow, wrist, 0.262);
        _q.copy(Q_GRIP); A.hand.matrix.compose(wrist, _q, _s.set(1, 1, 1));
      }
    }
    dispose() {
      V.scene.remove(this.group);
      this.group.traverse((o) => { if (o.geometry && o.geometry !== H.people.G.thigh && !Object.values(H.people.G).includes(o.geometry)) o.geometry.dispose(); });
      this.frameMat.dispose();
    }
  }

  // ======================= 路边停放（实例化） =======================
  const FL = V.fleet = { chunks: new Map(), taken: new Set(), dirty: true, center: new THREE.Vector3(1e9, 0, 1e9), types: {} };
  FL.init = function () {
    const sh = sharedMats();
    const paintI = H.mat.patch(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }));
    const frameI = H.mat.patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2 }));
    const MAT = Object.assign({}, sh, { paint: paintI, head: sh.headOff, tail: sh.tailOff, frame: frameI });
    const mk = (geos, cap, colored) => Object.keys(geos).map((mat) => {
      const m = new THREE.InstancedMesh(geos[mat], MAT[mat], cap);
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const col = mat === colored;
      if (col) m.setColorAt(0, new THREE.Color());
      V.scene.add(m);
      return { m, col };
    });
    for (const model in MODELS) { const S = new Sink(); carParts(MODELS[model], derive(MODELS[model]), S, false); FL.types['car:' + model] = { list: mk(S.merged().body, 120, 'paint'), cap: 120 }; }
    for (const st of ['shared', 'road']) {
      const S = new Sink(); bikeParts(st, S, false);
      const list = mk(S.merged().frame, 260, 'frame'); list.forEach((it) => { it.m.castShadow = false; });
      FL.types['bike:' + st] = { list, cap: 260 };
    }
  };
  FL.addChunk = (ch) => { if (ch.parked.length) { FL.chunks.set(ch.idx, ch); FL.dirty = true; } };
  FL.removeChunk = (ch) => { if (FL.chunks.delete(ch.idx)) FL.dirty = true; };
  const _col = new THREE.Color();
  FL.rebuild = function (cam) {
    const counts = {};
    for (const t in FL.types) counts[t] = 0;
    for (const [idx, ch] of FL.chunks) {
      const gz = ch.group.position.z;
      const dz = Math.abs(gz + 32 - cam.z);
      if (dz > 270) continue;
      ch.parked.forEach((p, i) => {
        if (FL.taken.has(idx + ':' + i)) return;
        if (p.kind === 'bike' && dz > 170) return;
        const key = p.kind === 'car' ? 'car:' + p.model : 'bike:' + p.style;
        const T = FL.types[key], n = counts[key];
        if (n >= T.cap) return;
        counts[key]++;
        _e.set(0, p.yaw, p.kind === 'bike' && !p.rack ? 0.1 : 0, 'YXZ'); _q.setFromEuler(_e);
        _m.compose(_v.set(p.x, p.kind === 'car' ? 0 : H.world.C.SY, p.z + gz), _q, _s.set(1, 1, 1));
        _col.set(p.color);
        for (const it of T.list) { it.m.setMatrixAt(n, _m); if (it.col) it.m.setColorAt(n, _col); }
      });
    }
    for (const t in FL.types) for (const it of FL.types[t].list) {
      it.m.count = counts[t]; it.m.instanceMatrix.needsUpdate = true; if (it.m.instanceColor) it.m.instanceColor.needsUpdate = true;
    }
    FL.center.copy(cam); FL.dirty = false;
  };
  // 遍历附近的停放载具（渲染坐标）
  FL.each = function (zc, range, fn) {
    for (const [idx, ch] of FL.chunks) {
      const gz = ch.group.position.z;
      if (Math.abs(gz + 32 - zc) > 32 + range) continue;
      ch.parked.forEach((p, i) => { if (!FL.taken.has(idx + ':' + i)) fn(p, p.x, p.z + gz, ch, i); });
    }
  };
  const parkedCircles = (p, x, z, fn) => {
    if (p.kind === 'car') { const D = DER[p.model]; const sn = Math.sin(p.yaw), c = Math.cos(p.yaw); for (const k of D.circ) fn(x + sn * k, z + c * k, D.cr); }
    else { const sn = Math.sin(p.yaw), c = Math.cos(p.yaw); for (const k of [-0.45, 0.45]) fn(x + sn * k, z + c * k, 0.3); }
  };
  const DER = {}; for (const m in MODELS) DER[m] = derive(MODELS[m]);

  // ======================= 公共接口 =======================
  V.init = function (scene) {
    V.scene = scene; FL.init();
    // 只给正在开的那辆车（或骑的单车）打一盏前灯，避免每辆车一盏灯导致所有材质重新编译
    V.beam = new THREE.SpotLight(0xfff1d6, 0, 75, 0.48, 0.55, 1.4); V.beamT = new THREE.Object3D();
    V.beam.target = V.beamT; scene.add(V.beam); scene.add(V.beamT);
  };
  V.addDyn = function (v) {
    V.list.push(v);
    if (V.list.length > V.MAX_DYN) {
      // 太多了：删掉离玩家最远、没人开的
      const ref = V.refPos || new THREE.Vector3();
      let worst = null, wd = -1;
      for (const o of V.list) { if (o.occupied || o === v) continue; const d = Math.hypot(o.state.x - ref.x, o.state.z - ref.z); if (d > wd) { wd = d; worst = o; } }
      if (worst) { worst.dispose(); V.list.splice(V.list.indexOf(worst), 1); }
    }
    return v;
  };
  V.spawnCar = (model, color, x, z, yaw) => V.addDyn(new Car(model, color, x, z, yaw));
  V.spawnBike = (style, color, x, z, yaw, y) => V.addDyn(new Bike(style, color, x, z, yaw, y));

  // 某处是否空着（不压到别的载具）
  V.spotFree = function (x, z, r) {
    let free = true;
    const test = (cx, cz, cr) => { if (Math.hypot(cx - x, cz - z) < cr + r) free = false; };
    for (const v of V.list) v.circles(test);
    FL.each(z, 8, (p, px, pz) => parkedCircles(p, px, pz, test));
    return free;
  };
  // 把 pos 从所有载具里推出来（except = 自己）
  V.collideAgainst = function (pos, r, except) {
    const push = (cx, cz, cr) => {
      const dx = pos.x - cx, dz = pos.z - cz, rr = r + cr, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d; pos.x += dx * k; pos.z += dz * k; }
    };
    for (const v of V.list) if (v !== except) { if (Math.abs((v.state.y || 0) - pos.y) < 2.5) v.circles(push); }
    if (pos.y < 2) FL.each(pos.z, 6, (p, px, pz) => parkedCircles(p, px, pz, push));
  };
  // 开着的车撞到别的车：整车推开、减速
  V.resolve = function (car) {
    const s = car.state;
    let hit = 0;
    const own = []; car.circles((x, z, r) => own.push([x, z, r]));
    const push = (cx, cz, cr) => {
      for (const [ox, oz, or] of own) {
        const dx = ox - cx, dz = oz - cz, rr = or + cr, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d * 0.5; s.x += dx * k; s.z += dz * k; hit = Math.max(hit, rr - d); }
      }
    };
    for (const v of V.list) if (v !== car) v.circles(push);
    FL.each(s.z, 10, (p, px, pz) => parkedCircles(p, px, pz, push));
    if (hit > 0.02 && Math.abs(s.speed) > 1) { s.bump = Math.abs(s.speed); s.speed *= 0.3; }
  };
  // 冰雹 / 水花：落在车顶上
  V.surfaceY = function (x, z) {
    let best = null;
    for (const v of V.list) { if (v.type !== 'car') continue; const y = v.surfaceY(x, z); if (y !== null && (best === null || y > best)) best = y; }
    FL.each(z, 3, (p, px, pz) => {
      if (p.kind !== 'car') return;
      const M = MODELS[p.model], D = DER[p.model];
      const dx = x - px, dz = z - pz, c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      const lx = c * dx - sn * dz, lz = sn * dx + c * dz;
      if (Math.abs(lx) > M.W / 2 - 0.02 || Math.abs(lz) > M.L / 2 - 0.05) return;
      const y = Math.abs(lz - M.cabZ) < M.cabL / 2 - 0.25 && Math.abs(lx) < D.cabW / 2 - 0.12 ? D.cabTop : D.top;
      if (best === null || y > best) best = y;
    });
    return best;
  };
  // 离玩家最近、能上的载具（动态的或停着的）
  V.nearest = function (pos) {
    let best = null, bd = 1e9;
    const consider = (kind, x, z, door, ref) => {
      const lim = kind === 'car' ? 2.7 : 1.7;
      let d = Math.hypot(x - pos.x, z - pos.z);
      if (door) d = Math.min(d, Math.hypot(door.x - pos.x, door.z - pos.z) + 0.2);
      if (d < lim && d < bd) { bd = d; best = ref; }
    };
    for (const v of V.list) {
      if (v.occupied || Math.abs((v.state.y || 0) - pos.y) > 1.5) continue;
      consider(v.type, v.state.x, v.state.z, v.type === 'car' ? v.doorPos(new THREE.Vector3()) : null, { v });
    }
    if (pos.y < 2) FL.each(pos.z, 6, (p, px, pz, ch, i) => consider(p.kind, px, pz, null, { p, ch, i, x: px, z: pz }));
    return best;
  };
  // 接管一辆停着的车 / 单车
  V.take = function (ref) {
    if (ref.v) return ref.v;
    const p = ref.p;
    FL.taken.add(ref.ch.idx + ':' + ref.i); FL.dirty = true;
    if (p.kind === 'car') return V.spawnCar(p.model, p.color, ref.x, ref.z, p.yaw);
    return V.spawnBike(p.style, p.color, ref.x, ref.z, p.yaw, H.world.C.SY);
  };
  // 召唤：汽车出现在玩家这一侧的停车带里，自行车出现在玩家身边
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  V.summonCar = function (player, model) {
    model = model || pick(['hatch', 'sedan', 'suv']);
    const C = H.world.C, side = player.pos.x >= 0 ? 1 : -1;
    const x = side * C.SHOX, yaw = side > 0 ? 0 : PI;
    for (const off of [0, -6, 6, -12, 12, -18, 18, -24, 24]) {
      const z = player.pos.z + off;
      if (V.spotFree(x, z, MODELS[model].L / 2)) return V.spawnCar(model, pick(H.world.CAR_COLORS), x, z, yaw);
    }
    return null;
  };
  V.summonBike = function (player, style) {
    style = style || 'shared';
    const c = Math.cos(player.yaw), sn = Math.sin(player.yaw);
    for (const [fx, fz] of [[0.95, -1.2], [-0.95, -1.2], [1.3, 0.2], [-1.3, 0.2], [0, -1.9], [0, 1.7], [1.6, -1.6], [-1.6, -1.6]]) {
      const x = player.pos.x + c * fx + sn * fz, z = player.pos.z - sn * fx + c * fz;
      _p.set(x, player.pos.y, z); H.world.collide(_p, 0.5, true);
      if (Math.hypot(_p.x - x, _p.z - z) > 0.02 || Math.abs(x) > H.world.WALL - 1) continue;
      if (!V.spotFree(x, z, 0.75)) continue;
      // 别放进打开的楼里、阳台上，也别放到比人高/低一截的地方（站在阳台上时下面的人行道）
      if (H.interior && H.interior.surfaceY(x, z, player.pos.y) > -Infinity) continue;
      const y = H.world.surfaceY(x, z, player.pos.y);
      if (Math.abs(y - player.pos.y) > 1) continue;
      const col = style === 'shared' ? pick(['#f5c518', '#ff7a1a', '#2f80ed', '#2ec4a5']) : pick(H.world.CAR_COLORS);
      return V.spawnBike(style, col, x, z, player.yaw, y);
    }
    return null;
  };

  V.update = function (dt, cam, occupied) {
    V.refPos = cam;
    for (const v of V.list) {
      if (v !== occupied) v.idle(dt);
      const d = Math.hypot(v.state.x - cam.x, v.state.z - cam.z);
      v.group.visible = d < H.world.drawDist;
      if (v.type === 'car') v.interior.visible = v === occupied || d < 30;
    }
    if (FL.dirty || Math.abs(FL.center.z - cam.z) > 40) FL.rebuild(cam);
    // 前灯
    let on = 0;
    if (occupied && occupied.type === 'car' && occupied.lightsOn) {
      const M = occupied.M;
      V.beam.position.set(0, M.by + 0.47, -(M.L / 2 - 0.1)).applyMatrix4(occupied.group.matrixWorld);
      V.beamT.position.set(0, 0, -22).applyMatrix4(occupied.group.matrixWorld);
      V.beam.angle = 0.48; on = 2.6;
    } else if (occupied && occupied.type === 'bike' && V.bikeLight) {
      V.beam.position.set(0, 0.95, -0.85).applyMatrix4(occupied.lean.matrixWorld);
      V.beamT.position.set(0, 0, -12).applyMatrix4(occupied.lean.matrixWorld);
      V.beam.angle = 0.42; on = 1.2;
    }
    V.beam.intensity = on;
  };
  V.rebase = function (dz) { for (const v of V.list) { v.state.z += dz; v.sync(); } FL.dirty = true; };
})();
