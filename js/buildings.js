// 建筑生成：公寓 / 写字楼 / 带小院的别墅 / 沿街商铺 / 口袋公园
// 坐标：每块地用"地块局部坐标"写，x' = 离路的进深（0 是地块前沿），z' = 沿街方向，y = 高出人行道
'use strict';
(function () {
  const BD = H.bld = {};
  const T = () => H.tex;

  // ---------- 几何缓存 ----------
  const cache = new Map();
  function cached(key, make) {
    let g = cache.get(key);
    if (!g) { g = make(); cache.set(key, g); }
    return g;
  }
  const f2 = (v) => Math.round(v * 50) / 50;
  function rbox(sx, sy, sz, r, seg) {
    sx = f2(sx); sy = f2(sy); sz = f2(sz);
    return cached(`b${sx},${sy},${sz},${r},${seg}`, () => H.roundedBox(sx, sy, sz, r, seg));
  }
  BD.rbox = rbox;
  function quad(w, h, cell) { w = f2(w); h = f2(h); return cached(`q${w},${h},${cell.join()}`, () => H.quad(w, h, cell[0], cell[1], cell[2], cell[3])); }
  BD.quad = quad;
  function cyl(r, h, bev, seg = 14) { return cached(`c${f2(r)},${f2(h)},${bev},${seg}`, () => H.roundedCylinder(f2(r), f2(h), bev, seg)); }
  BD.cyl = cyl;
  let blobs = null;
  function blob(i) {
    if (!blobs) { const r = H.rng(99); blobs = []; for (let k = 0; k < 8; k++) blobs.push(H.blob(1, r, 3, 0.14)); }
    return blobs[i % blobs.length];
  }
  BD.blob = blob;
  const trunkGeo = () => cached('trunk', () => new THREE.CylinderGeometry(0.075, 0.13, 1, 9));
  const sphereGeo = () => cached('sph', () => new THREE.SphereGeometry(1, 12, 8));

  // ---------- 放置器：局部 -> 块坐标，并登记碰撞 ----------
  const FACE = { front: -Math.PI / 2, back: Math.PI / 2, left: Math.PI, right: 0 };
  class Placer {
    constructor(B, ch, ox, oy, oz, ry) {
      this.B = B; this.ch = ch; this.ox = ox; this.oy = oy; this.oz = oz; this.ry = ry;
      this.c = Math.cos(ry); this.s = Math.sin(ry);
      this.bld = null; // 正在生成的可进入建筑（窗洞会记到它身上）
    }
    tx(lx, lz) { return this.ox + this.c * lx + this.s * lz; }
    tz(lx, lz) { return this.oz - this.s * lx + this.c * lz; }
    add(key, geo, lx, ly, lz, lry, color, opts) {
      this.B.add(key, geo, this.tx(lx, lz), this.oy + ly, this.tz(lx, lz), this.ry + (lry || 0), color, opts);
    }
    // ly 为底面高度
    box(key, sx, sy, sz, lx, ly, lz, color, r = 0.05, seg = 1, lry = 0, opts) {
      this.add(key, rbox(sx, sy, sz, r, seg), lx, ly + sy / 2, lz, lry, color, opts);
    }
    win(cell, w, h, lx, ly, lz, face) { this.add('win', quad(w, h, cell), lx, ly, lz, FACE[face], 0xffffff); }
    // 有厚度的窗/门。wall = 墙面在法线方向上的局部坐标（front/back 面是 x'，left/right 面是 z'），along = 沿墙方向坐标。
    // 远处：贴在墙外 2cm 的平面贴图（winflat，离近了会被隐藏）；近处：H.detail 按这里记下的参数拼出窗框、窗台、门把手。
    wnd(kind, cr, w, h, wall, y, along, face, color) {
      const out = (face === 'front' || face === 'left') ? -1 : 1;
      let lx, lz, fx, fz;
      if (face === 'front' || face === 'back') { lx = wall; lz = along; fx = wall + out * 0.02; fz = along; }
      else { lx = along; lz = wall; fx = along; fz = wall + out * 0.02; }
      const b = this.bld, t0 = this.B.tag;
      if (b) this.B.tag = 'h' + b.id; // 进楼后平面窗要和实心楼体一起藏起来
      this.add('winflat', quad(w, h, T().cell(cr[0], cr[1])), fx, y, fz, FACE[face], 0xffffff);
      this.B.tag = t0;
      const wins = this.ch.wins || (this.ch.wins = []);
      const X = this.tx(lx, lz), Y = this.oy + y, Z = this.tz(lx, lz);
      wins.push({ kind, c: cr[0], r: cr[1], w, h, x: X, y: Y, z: Z, ry: this.ry + FACE[face], color, bid: b ? b.id : 0 });
      // 建筑局部坐标：x = 离楼正面的进深，z = 沿街方向（以楼中线为 0），y = 高出人行道；
      // lit = 夜里这扇窗亮不亮（和 H.detail 里窗格的算法一致，进楼后各户亮灯跟着它走）
      const lit = kind === 'res' ? cr[1] === 1 : kind === 'bdoor' ? H.hash(Math.round(X * 10) + 7, Math.round(Z * 10) + Math.round(Y * 10) * 977) < 0.35 : true;
      if (b) b.wins.push({ kind, face, x: lx - b.lx0, z: lz - b.lz0, y, w, h, lit });
    }
    solid(x0, x1, z0, z1, bid) {
      const xs = [this.tx(x0, z0), this.tx(x1, z0), this.tx(x0, z1), this.tx(x1, z1)];
      const zs = [this.tz(x0, z0), this.tz(x1, z0), this.tz(x0, z1), this.tz(x1, z1)];
      const bx = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
      if (bid) bx.bid = bid; // 楼"打开"后，玩家改由室内墙体挡
      this.ch.boxes.push(bx);
    }
    circle(lx, lz, r) { this.ch.circles.push({ x: this.tx(lx, lz), z: this.tz(lx, lz), r }); }
    _aabb(x0, x1, z0, z1) {
      const xs = [this.tx(x0, z0), this.tx(x1, z0), this.tx(x0, z1), this.tx(x1, z1)];
      const zs = [this.tz(x0, z0), this.tz(x1, z0), this.tz(x0, z1), this.tz(x1, z1)];
      return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    }
    // 能跳上去站的顶（长椅座面、矮墙）：h = 顶面离地高。步行的人脚低于"顶 - STEP"时它是墙，脚高过去就踩在上面（H.world.collide / surfaceY）；
    // 单车等非步行的一律当实心挡
    solidTop(x0, x1, z0, z1, h) { const b = this._aabb(x0, x1, z0, z1); b.top = this.oy + h; this.ch.boxes.push(b); this.ch.tops.push(b); }
    // 头顶限位（顶棚、雨棚、门廊顶的底面）：跳起来头顶不能穿过去
    ceil(x0, x1, z0, z1, h) { const b = this._aabb(x0, x1, z0, z1); b.y = this.oy + h; this.ch.ceils.push(b); }
    // 能直接走上去的台阶面（不超过 0.5 自动迈上）
    step(x0, x1, z0, z1, h) { const b = this._aabb(x0, x1, z0, z1); b.k = 'deck'; b.y = this.oy + h; this.ch.surf.push(b); }
  }
  BD.Placer = Placer;
  BD.FACE = FACE;

  // 可进入的建筑（公寓、商铺）：登记到块上，室内由 H.interior 在玩家走近时现场生成
  let NEXT_ID = 1;
  // id 只是本次运行里的编号（按生成先后递增）；seed 只取决于块号和它在块里排第几，走远再回来还是同一套配色和家具
  function enterable(P, type, lx0, lz0, props) {
    const seed = (Math.imul(P.ch.idx, 0x9E3779B1) ^ Math.imul((P.ch.blds ? P.ch.blds.length : 0) + 1, 0x85EBCA6B)) >>> 0;
    const rec = Object.assign({ id: NEXT_ID++, seed, type, ch: P.ch, ox: P.tx(lx0, lz0), oz: P.tz(lx0, lz0), ry: P.ry, lx0, lz0, wins: [] }, props);
    (P.ch.blds || (P.ch.blds = [])).push(rec);
    P.bld = rec;
    return rec;
  }

  // ---------- 调色板（明快，不阴森） ----------
  const APT = ['#efe3cc', '#f3cfb0', '#cfdeea', '#d5e8d4', '#ecebe6', '#f1d4d6', '#e8cfae', '#dcd6ec', '#f6e7b4', '#c9e3e0'];
  const BRICK = ['#c9785e', '#b86b55', '#d08a6a', '#a8705c'];
  const BASE = ['#a9a196', '#8f8a84', '#b9ae9d', '#9aa3a8', '#c2b8a8'];
  const TRIM = ['#ffffff', '#f6f1e7', '#ece6dc'];
  const VILLA = ['#ffffff', '#fbf3e3', '#dbe9f2', '#e5efdf', '#f7e1dc', '#efe6d2', '#fdf0c8'];
  const ROOF = ['#b4553f', '#5e646e', '#3f6f74', '#8a5a3c', '#6b4f74', '#a2493c', '#47586b'];
  const ACCENT = ['#3f6f9a', '#6c9a5a', '#c0574a', '#2f7f7a', '#8a6bb3', '#d39a3a'];
  const OFFICE = ['#ffffff', '#dceeff', '#e3fff3', '#ececff', '#fff2e2', '#d8f0f8'];
  const LEAF = ['#5f9b4a', '#4f8a3f', '#77ab52', '#3f7a45', '#89b55a', '#6aa84f'];
  const LEAF_FALL = ['#d9a23b', '#d36a3a', '#e3c04a'];
  const FLOWERS = ['#ff6f91', '#ffd166', '#ef476f', '#c77dff', '#ff9f1c', '#ffffff', '#5fa8ff'];
  BD.LEAF = LEAF;

  function resCell(rng, kind) {
    const lit = rng() < 0.32;
    const col = rng() < 0.7 ? kind : rng.int(0, 3);
    return [col, lit ? 1 : 0];
  }

  // ---------- 树 ----------
  BD.tree = function (P, lx, lz, s, rng, collide = true) {
    const th = 2.3 * s;
    P.add('wood', trunkGeo(), lx, th / 2, lz, 0, '#7a5a40', { s: [s, th, s] });
    const fall = rng() < 0.12;
    const base = fall ? rng.pick(LEAF_FALL) : rng.pick(LEAF);
    const n = 2 + rng.int(0, 2);
    for (let k = 0; k < n; k++) {
      const r = (1.15 + rng() * 0.6) * s;
      const c = new THREE.Color(base).offsetHSL((rng() - 0.5) * 0.03, 0, (rng() - 0.5) * 0.08);
      P.add('leaf', blob(rng.int(0, 7)), lx + (rng() - 0.5) * 1.3 * s, th + 0.7 * s + rng() * 1.1 * s, lz + (rng() - 0.5) * 1.3 * s,
        rng() * 6, c, { s: [r, r * 0.86, r] });
    }
    if (collide) P.circle(lx, lz, 0.22 * s);
  };
  BD.bush = function (P, lx, ly, lz, r, rng, color) {
    // 摆在楼上（阳台、窗台）的盆栽用不摇的材质：树叶摇摆幅度是按离地高度算的，放在高处会被当成树冠甩飞
    P.add(ly > 1 ? 'leafPot' : 'leaf', blob(rng.int(0, 7)), lx, ly + r * 0.55, lz, rng() * 6, color || rng.pick(LEAF), { s: [r, r * 0.75, r] });
  };
  function flowers(P, lx, ly, lz, len, rng, n) {
    for (let k = 0; k < n; k++) {
      const r = 0.09 + rng() * 0.06;
      P.add(ly > 1 ? 'leafPot' : 'leaf', sphereGeo(), lx + (rng() - 0.5) * 0.3, ly + r, lz + (rng() - 0.5) * len, 0, rng.pick(FLOWERS), { s: [r, r, r] });
    }
  }

  // ---------- 公寓 ----------
  BD.apartment = function (P, w, rng, opt) {
    const sb = rng.range(1.0, 2.2), D = rng.range(11, 15), Wb = w - rng.range(0.6, 1.4);
    const zc = w / 2, xc = sb + D / 2;
    const F = rng.int(opt.minF, opt.maxF);
    const gH = 3.6, fH = 3.0, Hb = gH + (F - 1) * fH + 0.3;
    const col = rng.pick(APT), trim = rng.pick(TRIM), base = rng.pick(BASE);
    const brick = rng.chance(0.22);
    const R = 0.5;
    const bodyCol = brick ? rng.pick(BRICK) : col;
    const rec = enterable(P, 'apt', sb, zc, { D, W: Wb, F, gH, fH, Hb, R, wallKey: brick ? 'brick' : 'wall', wallCol: bodyCol, baseCol: base, trimCol: trim });
    P.B.tag = 'h' + rec.id;
    P.box(brick ? 'brick' : 'wall', D, Hb, Wb, xc, 0, zc, bodyCol, R, 2);
    P.box('concrete', D + 0.14, gH, Wb + 0.14, xc, 0, zc, base, R + 0.07, 2);
    for (let f = 1; f < F; f++) P.box('trim', D + 0.16, 0.2, Wb + 0.16, xc, gH + (f - 1) * fH - 0.1, zc, trim, 0.1, 1);
    P.B.tag = null;
    P.box('trim', D + 0.3, 0.55, Wb + 0.3, xc, Hb - 0.1, zc, trim, R + 0.12, 2);
    // 屋顶：楼梯间、水箱
    P.box('concrete', 3.2, 2.6, 3.4, xc + D * 0.18, Hb, zc - Wb * 0.22, base, 0.3, 1);
    if (rng.chance(0.75)) {
      P.box('metal', 1.8, 0.5, 1.8, xc - D * 0.2, Hb, zc + Wb * 0.2, '#8d949a', 0.08, 1);
      P.add('metal', cyl(0.9, 1.6, 0.3), xc - D * 0.2, Hb + 1.3, zc + Wb * 0.2, 0, '#cfd4d8');
    }
    // 正面：开间
    const usable = Wb - 1.9;
    const nb = Math.max(2, Math.floor(usable / 2.7)), bw = usable / nb;
    const z0 = zc - usable / 2;
    const gw = sb - 0.07; // 一楼外墙面（底座比楼身凸出 7cm）
    const bal = rng.pick(['none', 'alt', 'all', 'center', 'all']);
    const kind = rng.int(0, 3);
    const entrance = Math.floor(nb / 2);
    Object.assign(rec, { nb, bw, zb0: z0 - zc, entrance, bal: [] });
    for (let b = 0; b < nb; b++) {
      const bz = z0 + bw * (b + 0.5);
      const hasBal = bal === 'all' || (bal === 'alt' && b % 2 === 0) || (bal === 'center' && Math.abs(b - (nb - 1) / 2) < 1);
      rec.bal.push(hasBal ? bw - 0.3 : 0);
      if (b === entrance) {
        P.wnd('gdoor', [0, 2], Math.min(2.1, bw - 0.4), 2.6, gw, 1.45, bz, 'front');
        P.box('trim', 1.7, 0.2, Math.min(3.2, bw + 0.4), sb - 0.8, 3.0, bz, trim, 0.09, 1);
        P.box('concrete', 1.1, 0.12, Math.min(2.8, bw), sb - 0.55, 0, bz, base, 0.04, 1);
        P.step(sb - 1.1, sb, bz - Math.min(2.8, bw) / 2, bz + Math.min(2.8, bw) / 2, 0.12);
        P.ceil(sb - 1.65, sb + 0.05, bz - Math.min(3.2, bw + 0.4) / 2, bz + Math.min(3.2, bw + 0.4) / 2, 3.0);
        if (rng.chance(0.6)) P.add('sign', quad(1.9, 0.3, T().signCell(rng.chance(0.5) ? 20 : 21)), gw - 0.02, 3.4, bz, FACE.front, 0xffffff);
      } else {
        P.wnd('res', resCell(rng, kind), Math.min(1.9, bw - 0.6), 1.9, gw, 1.75, bz, 'front', trim);
      }
      for (let f = 1; f < F; f++) {
        const y0 = gH + (f - 1) * fH;
        if (hasBal) {
          const bwid = bw - 0.3;
          P.wnd('bdoor', [0, 2], Math.min(1.7, bw - 0.8), 2.3, sb, y0 + 1.25, bz, 'front', trim);
          P.box('trim', 1.3, 0.16, bwid, sb - 0.62, y0 - 0.02, bz, trim, 0.06, 1);
          P.box('glass', 0.05, 0.92, bwid - 0.12, sb - 1.18, y0 + 0.14, bz, 0xffffff, 0, 0);
          // 栏杆细条用普通方条（几厘米粗，看不出棱角，省大量三角形）
          P.box('metal', 0.09, 0.07, bwid - 0.04, sb - 1.2, y0 + 1.05, bz, '#e3e6e8', 0, 0);
          P.box('metal', 1.15, 0.06, 0.06, sb - 0.62, y0 + 1.05, bz - bwid / 2 + 0.05, '#e3e6e8', 0, 0);
          P.box('metal', 1.15, 0.06, 0.06, sb - 0.62, y0 + 1.05, bz + bwid / 2 - 0.05, '#e3e6e8', 0, 0);
          if (rng.chance(0.25)) BD.bush(P, sb - 0.9, y0 + 0.14, bz + bwid * 0.3, 0.32, rng);
        } else {
          const ww = Math.min(1.5, bw - 0.8);
          P.wnd('res', resCell(rng, kind), ww, 1.65, sb, y0 + 1.6, bz, 'front', trim);
          if (rng.chance(0.16)) P.box('trim', 0.42, 0.55, 0.8, sb - 0.22, y0 + 0.12, bz + Math.min(bw * 0.3, 0.9), '#eeeeee', 0.06, 1);
        }
      }
    }
    // 侧面窗
    const su = D - 1.9, ns = Math.max(1, Math.floor(su / 3.0)), sw = su / ns;
    for (const [face, zz] of [['left', zc - Wb / 2], ['right', zc + Wb / 2]]) {
      for (let k = 0; k < ns; k++) {
        const lx = sb + 0.95 + sw * (k + 0.5);
        for (let f = 1; f < F; f++) P.wnd('res', resCell(rng, kind), 1.3, 1.5, zz, gH + (f - 1) * fH + 1.6, lx, face, trim);
      }
    }
    P.bld = null;
    P.solid(sb - 0.1, sb + D + 0.1, zc - Wb / 2 - 0.1, zc + Wb / 2 + 0.1, rec.id);
  };

  // ---------- 写字楼 ----------
  BD.office = function (P, w, rng, opt) {
    const sb = rng.range(3.2, 5.0), Wb = w - rng.range(1.6, 2.6), D = rng.range(15, 21);
    const zc = w / 2, xc = sb + D / 2;
    const F = rng.int(opt.minF, opt.maxF), fH = 3.8;
    const podium = rng.chance(0.55);
    const R = rng.range(1.2, 2.6);
    const tint = rng.pick(OFFICE);
    let yb = 0, front = sb;
    if (podium) {
      const pH = 8.4, pc = rng.pick(['#e6e2da', '#d8d4cc', '#cfd3d6', '#e9e0d0']);
      P.box('wall', D + 1.0, pH, Wb + 0.8, xc - 0.5, 0, zc, pc, 0.7, 2);
      P.box('trim', D + 1.2, 0.5, Wb + 1.0, xc - 0.5, pH - 0.25, zc, '#f4f4f2', 0.3, 1);
      front = sb - 1.0;
      const n = Math.max(2, Math.floor((Wb - 2) / 3.6));
      for (let k = 0; k < n; k++) {
        const z = zc - (Wb - 2) / 2 + (Wb - 2) / n * (k + 0.5);
        P.wnd('lobby', [2, 2], (Wb - 2) / n - 0.4, 3.4, front, 2.0, z, 'front');
        P.wnd('lobby', [2, 2], (Wb - 2) / n - 0.4, 2.6, front, 5.9, z, 'front');
      }
      yb = pH;
    } else {
      const n = Math.max(2, Math.floor((Wb - 2 * R) / 3.6));
      for (let k = 0; k < n; k++) {
        const z = zc - (Wb - 2 * R) / 2 + (Wb - 2 * R) / n * (k + 0.5);
        P.wnd('lobby', [2, 2], (Wb - 2 * R) / n - 0.3, 3.4, sb, 1.85, z, 'front');
      }
    }
    const Ht = F * fH;
    P.box('curtain', D, Ht, Wb, xc, yb, zc, tint, R, 3);
    P.box('trim', D + 0.35, 1.0, Wb + 0.35, xc, yb + Ht - 0.2, zc, '#f2f2f2', R + 0.17, 3);
    P.box('concrete', D - 0.4, 0.5, Wb - 0.4, xc, yb + Ht + 0.6, zc, '#b9bcbf', Math.max(R - 0.25, 0.2), 2);
    const top = yb + Ht + 1.1;
    P.box('metal', 4, 2.2, 5, xc + D * 0.15, top, zc - Wb * 0.15, '#9aa1a8', 0.25, 1);
    P.box('metal', 3, 1.4, 3, xc - D * 0.2, top, zc + Wb * 0.2, '#8a9096', 0.2, 1);
    if (rng.chance(0.5)) {
      P.add('metal', cyl(0.12, 9, 0.05, 8), xc, top + 4.5, zc, 0, '#c7ccd1');
      P.add('red', sphereGeo(), xc, top + 9.1, zc, 0, 0xffffff, { s: [0.25, 0.25, 0.25] });
    }
    // 竖向装饰肋
    if (rng.chance(0.5)) {
      const fc = rng.pick(['#f5f5f5', '#d9dde2', '#e9dcc8']);
      const n = Math.floor((Wb - 2 * R - 1) / 3);
      for (let k = 0; k <= n; k++) P.box('trim', 0.45, Ht - 1.2, 0.24, sb - 0.2, yb, zc - (n * 3) / 2 + k * 3, fc, 0.1, 1);
    }
    // 入口雨棚
    const cz = zc + rng.range(-2, 2);
    P.box('trim', 3.2, 0.32, 6, front - 1.6, 4.4, cz, '#eeeeee', 0.14, 2);
    P.add('trim', cyl(0.12, 4.4, 0.05), front - 2.9, 2.2, cz - 2.4, 0, '#dddddd');
    P.add('trim', cyl(0.12, 4.4, 0.05), front - 2.9, 2.2, cz + 2.4, 0, '#dddddd');
    P.circle(front - 2.9, cz - 2.4, 0.18); P.circle(front - 2.9, cz + 2.4, 0.18);
    // 门前广场：花坛 + 名字石碑
    if (front > 2.2) {
      const pz = zc - Wb * 0.32;
      P.box('concrete', 1.2, 0.55, 3.4, 1.1, 0, pz, '#cfcac0', 0.25, 2);
      BD.bush(P, 1.1, 0.5, pz - 0.8, 0.55, rng); BD.bush(P, 1.1, 0.5, pz + 0.8, 0.6, rng);
      P.solid(0.5, 1.7, pz - 1.7, pz + 1.7);
      const mz = zc + Wb * 0.32;
      P.box('concrete', 0.5, 1.3, 3.0, 1.1, 0, mz, '#585d64', 0.15, 2);
      P.add('sign', quad(2.7, 0.5, T().signCell(16 + rng.int(0, 3))), 0.84, 0.85, mz, FACE.front, 0xffffff);
      P.solid(0.85, 1.35, mz - 1.5, mz + 1.5);
    }
    P.solid(front - 0.1, sb + D + 0.1, zc - Wb / 2 - 0.5, zc + Wb / 2 + 0.5);
  };

  // ---------- 别墅 + 小院 ----------
  BD.villa = function (P, w, rng) {
    const sb = rng.range(5.2, 6.4), Wb = Math.min(w - 3.2, rng.range(8, 10.5)), D = rng.range(7.5, 9.5);
    const zc = w / 2 + rng.range(-0.5, 0.5), xc = sb + D / 2;
    const F = rng.chance(0.75) ? 2 : 3, fH = 3.0, Hb = F * fH;
    const col = rng.pick(VILLA), roofC = rng.pick(ROOF), accent = rng.pick(ACCENT);
    const back = sb + D + 1.6;
    // 院子草坪（铺满地块，房子压在上面）
    P.box('grass', back - 0.3, 0.08, w - 0.5, (back + 0.3) / 2, -0.03, w / 2, '#ffffff', 0.04, 1);
    // 房子
    P.box('wall', D, Hb, Wb, xc, 0, zc, col, 0.22, 2);
    P.box('concrete', D + 0.14, 0.45, Wb + 0.14, xc, 0, zc, '#b5ab9c', 0.1, 1);
    P.box('trim', D + 0.12, 0.16, Wb + 0.12, xc, fH - 0.08, zc, '#ffffff', 0.06, 1);
    // 坡屋顶：山墙三角体 + 两片圆边屋面
    const along = rng.chance(0.6);
    const span = along ? D : Wb, len = along ? Wb : D;
    const rh = span * rng.range(0.28, 0.36);
    const lry = along ? 0 : Math.PI / 2;
    const prism = cached(`gable${f2(span)},${f2(len)},${f2(rh)}`, () => H.gableRoof(span, len, rh, 0.03));
    P.add('wall', prism, xc, Hb, zc, lry, col);
    const ang = Math.atan2(rh, span / 2);
    const L = (span / 2 + 0.5) / Math.cos(ang);
    const slab = cached(`slab${f2(len)},${f2(L)}`, () => { const g = H.roundedBox(len + 0.8, 0.16, L, 0.07, 1); g.rotateY(Math.PI / 2); return g; });
    for (const sgn of [1, -1]) {
      const rx = sgn * (L / 2 * Math.cos(ang) - 0.04) + sgn * Math.sin(ang) * 0.08;
      const ry = rh - L / 2 * Math.sin(ang) + Math.cos(ang) * 0.08;
      const lx = along ? xc + rx : xc, lz = along ? zc : zc - rx;
      P.add('roof', slab, lx, Hb + ry, lz, lry, roofC, { rz: -sgn * ang });
    }
    P.box('roof', along ? 0.3 : len + 0.8, 0.22, along ? len + 0.8 : 0.3, xc, Hb + rh - 0.02, zc, roofC, 0.1, 1);
    P.box('brick', 0.7, rh + 1.0, 0.7, xc + (along ? span * 0.2 : D * 0.25), Hb + rh * 0.35, zc + (along ? Wb * 0.28 : span * 0.2), '#b07a62', 0.1, 1);
    // 正面：门 + 门廊 + 窗（带百叶）
    const dz = zc + (rng.chance(0.5) ? -1 : 1) * Wb * rng.range(0.1, 0.22);
    P.wnd('wdoor', [1, 2], 1.15, 2.25, sb, 0.45 + 1.13, dz, 'front');
    P.box('trim', 1.15, 0.14, 2.0, sb - 0.57, 2.72, dz, '#ffffff', 0.06, 1);
    P.add('trim', cyl(0.07, 2.3, 0.03, 10), sb - 1.02, 1.6, dz - 0.82, 0, '#ffffff');
    P.add('trim', cyl(0.07, 2.3, 0.03, 10), sb - 1.02, 1.6, dz + 0.82, 0, '#ffffff');
    P.box('concrete', 1.1, 0.3, 1.8, sb - 0.55, 0, dz, '#c8c2b8', 0.05, 1);
    P.step(sb - 1.1, sb, dz - 0.9, dz + 0.9, 0.3);                       // 门廊台阶：走过去就迈上
    P.ceil(sb - 1.145, sb, dz - 1.0, dz + 1.0, 2.72);                   // 门廊顶
    P.circle(sb - 1.02, dz - 0.82, 0.08); P.circle(sb - 1.02, dz + 0.82, 0.08);
    const shutters = rng.chance(0.4);
    // 正面：wall=sb, along=z；侧面：wall=侧墙 z', along=x'
    const winAt = (wall, y, along, face, lit) => {
      P.wnd('villa', [lit ? 1 : 0, 3], 1.25, 1.45, wall, y, along, face);
      const z = along;
      if (shutters && face === 'front') {
        P.box('wood', 0.07, 1.45, 0.45, sb - 0.06, y - 0.72, z - 0.88, accent, 0.03, 1);
        P.box('wood', 0.07, 1.45, 0.45, sb - 0.06, y - 0.72, z + 0.88, accent, 0.03, 1);
      }
    };
    const gz = [];
    for (const z of [zc - Wb / 2 + 1.5, zc + Wb / 2 - 1.5]) if (Math.abs(z - dz) > 1.7) gz.push(z);
    gz.forEach((z) => winAt(sb, 1.85, z, 'front', rng() < 0.3));
    const nu = Math.max(2, Math.floor((Wb - 1.6) / 2.4));
    for (let f = 1; f < F; f++) {
      for (let k = 0; k < nu; k++) {
        const z = zc - (Wb - 2.6) / 2 + (Wb - 2.6) / Math.max(1, nu - 1) * k;
        const y = f * fH + 1.6;
        winAt(sb, y, z, 'front', rng() < 0.3);
        if (rng.chance(0.4)) { P.box('wood', 0.3, 0.22, 1.2, sb - 0.17, y - 0.95, z, '#8a5a3c', 0.04, 1); flowers(P, sb - 0.17, y - 0.73, z, 1.0, rng, 5); }
      }
    }
    for (const [face, zz] of [['left', zc - Wb / 2], ['right', zc + Wb / 2]]) {
      for (let f = 0; f < F; f++) winAt(zz, f * fH + (f ? 1.6 : 1.85), xc, face, rng() < 0.25);
    }
    P.solid(sb - 0.1, sb + D + 0.1, zc - Wb / 2 - 0.1, zc + Wb / 2 + 0.1);
    // 小路
    const ns = Math.max(2, Math.floor((sb - 1.3) / 0.85));
    for (let k = 0; k < ns; k++) P.box('concrete', 0.55, 0.06, 0.85, 0.55 + k * 0.85, 0.02, dz + (rng() - 0.5) * 0.15, '#ddd6ca', 0.12, 1, (rng() - 0.5) * 0.15);
    // 前围栏（开门口）
    const ftype = rng.pick(['picket', 'picket', 'hedge', 'wall']);
    const fenceSeg = (z0, z1) => {
      const len = z1 - z0; if (len < 0.3) return;
      const zm = (z0 + z1) / 2;
      if (ftype === 'picket') {
        const n = Math.floor(len / 0.34);
        for (let k = 0; k <= n; k++) P.box('wood', 0.06, 0.95, 0.09, 0.2, 0, z0 + (len / n) * k, '#fbfaf6', 0.028, 1);
        P.box('wood', 0.04, 0.07, len, 0.16, 0.3, zm, '#fbfaf6', 0.02, 1);
        P.box('wood', 0.04, 0.07, len, 0.16, 0.7, zm, '#fbfaf6', 0.02, 1);
      } else if (ftype === 'hedge') {
        P.box('leaf', 0.7, 1.0, len, 0.45, 0, zm, rng.pick(LEAF), 0.3, 2);
      } else {
        P.box('concrete', 0.32, 0.65, len, 0.25, 0, zm, '#e7e0d4', 0.08, 1);
        P.box('trim', 0.42, 0.1, len + 0.08, 0.25, 0.65, zm, '#ffffff', 0.05, 1);
      }
      if (ftype === 'wall') P.solidTop(0.04, 0.46, z0, z1, 0.75); // 矮墙压顶能跳上去走
      else P.solid(0.05, ftype === 'hedge' ? 0.8 : 0.4, z0, z1);
    };
    fenceSeg(0.3, dz - 0.65); fenceSeg(dz + 0.65, w - 0.3);
    for (const z of [dz - 0.68, dz + 0.68]) { P.box('trim', 0.2, 1.15, 0.2, 0.2, 0, z, '#ffffff', 0.07, 1); P.solid(0.1, 0.3, z - 0.1, z + 0.1); }
    // 侧面和后面：木板围栏（大块，省面数）
    const side = (zz) => {
      P.box('wood', back - 0.3, 1.1, 0.06, (back + 0.3) / 2, 0, zz, '#d8c3a5', 0.03, 1);
      P.solid(0.3, back, zz - 0.1, zz + 0.1);
    };
    side(0.25); side(w - 0.25);
    P.box('wood', 0.06, 1.1, w - 0.5, back, 0, w / 2, '#d8c3a5', 0.03, 1);
    // 信箱
    P.box('metal', 0.08, 1.0, 0.08, 0.45, 0, dz + 1.05, '#555a60', 0.03, 1);
    P.box('metal', 0.32, 0.3, 0.45, 0.45, 1.0, dz + 1.05, accent, 0.1, 1);
    P.solid(0.29, 0.61, dz + 0.825, dz + 1.275);
    // 院子里的小树、花坛、长椅
    const tz = dz < w / 2 ? w - 1.6 : 1.6;
    BD.tree(P, rng.range(1.6, Math.max(1.7, sb - 1.6)), tz, rng.range(0.65, 0.9), rng);
    const fz = dz < w / 2 ? dz + 2.6 : dz - 2.6;
    if (Math.abs(fz - tz) > 1.5 && fz > 1 && fz < w - 1) {
      P.box('wood', 0.55, 0.22, 2.2, sb - 0.75, 0, fz, '#7a5236', 0.05, 1);
      flowers(P, sb - 0.75, 0.2, fz, 1.9, rng, 10);
    }
    if (rng.chance(0.4)) bench(P, 1.6, (dz + tz) / 2, Math.PI / 2, rng);
  };

  function bench(P, lx, lz, lry, rng) {
    const c = Math.cos(lry), s = Math.sin(lry);
    const at = (ox, oz) => [lx + c * ox + s * oz, lz - s * ox + c * oz];
    let p = at(0, 0); P.box('wood', 0.45, 0.07, 1.6, p[0], 0.42, p[1], '#a8754a', 0.03, 1, lry);
    p = at(0.2, 0); P.box('wood', 0.07, 0.4, 1.6, p[0], 0.55, p[1], '#a8754a', 0.03, 1, lry);
    for (const k of [-0.65, 0.65]) { p = at(0, k); P.box('metal', 0.4, 0.42, 0.06, p[0], 0, p[1], '#3d4248', 0.02, 1, lry); }
    // 座面能跳上去站（靠背不单独挡）；碰撞框跟着长椅转（以前两个圆总按 z 摆，转了 90° 的长椅两头能穿过去）
    const cs = [at(-0.225, -0.8), at(0.235, -0.8), at(-0.225, 0.8), at(0.235, 0.8)];
    P.solidTop(Math.min(...cs.map((q) => q[0])), Math.max(...cs.map((q) => q[0])), Math.min(...cs.map((q) => q[1])), Math.max(...cs.map((q) => q[1])), 0.49);
  }
  BD.bench = bench;

  // ---------- 沿街商铺 ----------
  BD.shops = function (P, w, rng, opt) {
    const cafe = rng.chance(0.35);
    const sb = cafe ? 2.4 : rng.range(0.25, 0.6);
    const D = rng.range(9, 12), Wb = w - 0.4, zc = w / 2, xc = sb + D / 2;
    const F = rng.int(2, 4), gH = 4.2, fH = 3.0, Hb = gH + (F - 1) * fH + 0.3;
    const brick = rng.chance(0.3);
    const col = brick ? rng.pick(BRICK) : rng.pick(APT), trim = rng.pick(TRIM);
    const front = rng.pick(['#4d535a', '#6b5a4a', '#f2eee6', '#37474f']);
    const rec = enterable(P, 'shop', sb, zc, { D, W: Wb, F, gH, fH, Hb, R: 0.3, wallKey: brick ? 'brick' : 'wall', wallCol: col, frontCol: front, trimCol: trim, units: [] });
    P.B.tag = 'h' + rec.id;
    P.box(brick ? 'brick' : 'wall', D, Hb, Wb, xc, 0, zc, col, 0.3, 2);
    P.box('trim', D + 0.1, gH, Wb + 0.1, xc, 0, zc, front, 0.3, 2);
    P.B.tag = null;
    P.box('trim', D + 0.3, 0.45, Wb + 0.3, xc, Hb - 0.1, zc, trim, 0.35, 1);
    const n = Wb >= 17 ? 3 : Wb >= 11 ? 2 : 1, uw = Wb / n;
    const used = new Set();
    for (let u = 0; u < n; u++) {
      const uz = zc - Wb / 2 + uw * (u + 0.5);
      let idx = rng.int(0, 15); while (used.has(idx)) idx = (idx + 1) % 16; used.add(idx);
      rec.units.push({ z: uz - zc, w: uw, idx, dz: uw / 2 - 0.4 - 0.6 });
      const dw = 1.2;
      P.wnd('shopwin', [2, 3], uw - dw - 1.0, 2.7, sb - 0.05, 1.75, uz - dw / 2, 'front');
      P.wnd('sdoor', [0, 2], dw, 2.5, sb - 0.05, 1.4, uz + uw / 2 - 0.4 - dw / 2, 'front');
      P.box('trim', 0.22, 0.85, uw - 0.6, sb - 0.12, 3.15, uz, '#2f3338', 0.08, 1);
      P.add('sign', quad(uw - 0.95, 0.7, T().signCell(idx)), sb - 0.24, 3.575, uz, FACE.front, 0xffffff);
      const row = rng.int(0, 3);
      const vr = 1 - (row + 0.5) / 4;
      P.box('awning', 1.5, 0.05, uw - 0.5, sb - 0.72, 2.72, uz, 0xffffff, 0.02, 1, 0,
        { rz: 0.32, uvf: (u2, v2) => [v2 / 3.2, vr] });
      // 遮阳篷往街那边斜下去：分三段登记头顶限位，每段取这一段最低的高度
      for (let k = 0; k < 3; k++) { const xa = sb - 1.44 + k * 0.48; P.ceil(xa, xa + 0.48, uz - (uw - 0.5) / 2, uz + (uw - 0.5) / 2, 2.72 + (xa - (sb - 0.72)) * Math.tan(0.32)); }
      const prop = rng.int(0, 3);
      if (cafe && prop < 3) {
        for (const tzz of [uz - uw * 0.22, uz + uw * 0.18]) {
          P.add('wood', cyl(0.42, 0.05, 0.02, 16), 1.2, 0.74, tzz, 0, '#f4efe6');
          P.add('metal', cyl(0.04, 0.72, 0.01, 8), 1.2, 0.36, tzz, 0, '#3d4248');
          for (const cz of [-0.62, 0.62]) {
            P.box('wood', 0.42, 0.06, 0.42, 1.2, 0.45, tzz + cz, '#c98b5a', 0.04, 1);
            P.box('wood', 0.42, 0.5, 0.06, 1.2, 0.48, tzz + cz + Math.sign(cz) * 0.2, '#c98b5a', 0.03, 1);
          }
          P.circle(1.2, tzz, 0.95);
        }
      } else if (prop === 1) {
        // 自动售货机
        const vz = uz - uw / 2 + 0.75;
        P.box('metal', 0.8, 1.85, 0.95, sb - 0.42, 0, vz, rng.pick(['#d83b3b', '#2f6fb5', '#2f9a6a']), 0.1, 1);
        P.win(T().cell(2, 3), 0.7, 1.1, sb - 0.83, 1.15, vz, 'front');
        P.solid(sb - 0.85, sb, vz - 0.5, vz + 0.5);
      } else if (prop === 2 && sb > 0.4) {
        P.box('wood', 0.6, 0.65, 1.4, sb - 0.3, 0, uz - uw * 0.25, '#8a5a3c', 0.06, 1);
        flowers(P, sb - 0.3, 0.62, uz - uw * 0.25, 1.2, rng, 9);
      }
    }
    // 楼上住户（不能进，只有一楼商铺能进）
    P.bld = null;
    const usable = Wb - 1.6, nb = Math.max(2, Math.floor(usable / 2.6)), bw = usable / nb, kind = rng.int(0, 3);
    for (let f = 1; f < F; f++) {
      P.box('trim', D + 0.12, 0.16, Wb + 0.12, xc, gH + (f - 1) * fH - 0.08, zc, trim, 0.08, 1);
      for (let b = 0; b < nb; b++) {
        const bz = zc - usable / 2 + bw * (b + 0.5);
        P.wnd('res', resCell(rng, kind), Math.min(1.5, bw - 0.8), 1.65, sb, gH + (f - 1) * fH + 1.6, bz, 'front', trim);
      }
    }
    P.solid(sb - 0.1, sb + D + 0.1, zc - Wb / 2 - 0.1, zc + Wb / 2 + 0.1, rec.id);
  };

  // ---------- 天桥台阶落地的小广场：前面 4m 留给台阶和人走，后面是草地、树和长椅 ----------
  BD.plaza = function (P, w, rng) {
    P.box('grass', 9, 0.08, w - 0.6, 9.0, -0.03, w / 2, '#ffffff', 0.04, 1);
    P.box('concrete', 0.35, 0.42, w - 0.6, 4.35, 0, w / 2, '#d9d2c4', 0.12, 1);
    P.solidTop(4.15, 4.55, 0.3, w - 0.3, 0.42);
    const n = Math.max(2, Math.floor(w / 5));
    for (let k = 0; k < n; k++) BD.tree(P, rng.range(7, 12), (w / n) * (k + 0.5) + (rng() - 0.5) * 1.5, rng.range(0.85, 1.2), rng);
    for (let k = 0; k < 2; k++) bench(P, 5.4, w * (0.3 + 0.4 * k), 0, rng);
    for (let k = 0; k < 4; k++) BD.bush(P, rng.range(5, 12.5), 0.05, rng.range(1, w - 1), rng.range(0.4, 0.65), rng);
  };

  // ---------- 口袋公园（填缝用） ----------
  BD.park = function (P, w, rng) {
    if (w < 3) return;
    P.box('grass', 13, 0.08, w - 0.3, 6.8, -0.03, w / 2, '#ffffff', 0.04, 1);
    const n = Math.max(1, Math.floor(w / 5));
    for (let k = 0; k < n; k++) BD.tree(P, rng.range(4, 11), (w / n) * (k + 0.5) + (rng() - 0.5), rng.range(0.8, 1.2), rng);
    if (w > 5) bench(P, 1.2, w / 2, Math.PI / 2, rng);
    if (w > 6 && rng.chance(0.6)) {
      P.box('concrete', 1.4, 0.4, 3.6, 3.2, 0, w / 2 + (rng() - 0.5) * (w - 5), '#d9d2c4', 0.3, 2);
      flowers(P, 3.2, 0.4, w / 2, 3.2, rng, 14);
    }
  };
})();
