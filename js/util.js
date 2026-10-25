// 通用工具：随机数、噪声、圆角几何、按材质合批
'use strict';
// 十六进制颜色按 sRGB 解释并自动转线性（配合 sRGB 输出）
THREE.ColorManagement.legacyMode = false;
const H = window.H = {};
// 老一点的 Safari / Firefox 没有 ctx.roundRect：补一个（只支持数字或 [tl, tr, br, bl] 圆角）
if (window.CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r = 0) {
    const a = Array.isArray(r) ? r : [r], R = [a[0] || 0, a[1] !== undefined ? a[1] : a[0] || 0, a[2] !== undefined ? a[2] : a[0] || 0, a[3] !== undefined ? a[3] : (a[1] !== undefined ? a[1] : a[0] || 0)];
    const m = Math.min(Math.abs(w), Math.abs(h)) / 2, [tl, tr, br, bl] = R.map((v) => Math.min(v, m));
    this.moveTo(x + tl, y); this.lineTo(x + w - tr, y); this.arcTo(x + w, y, x + w, y + tr, tr);
    this.lineTo(x + w, y + h - br); this.arcTo(x + w, y + h, x + w - br, y + h, br);
    this.lineTo(x + bl, y + h); this.arcTo(x, y + h, x, y + h - bl, bl);
    this.lineTo(x, y + tl); this.arcTo(x, y, x + tl, y, tl); this.closePath();
    return this;
  };
}

// ---------- 随机 ----------
H.rng = function (seed) {
  let s = (seed >>> 0) || 1;
  const r = function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  return r;
};
H.hash = function (a, b = 0) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// 一维平滑值噪声（街区分布用）
H.noise1 = function (x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return H.hash(i, seed) * (1 - u) + H.hash(i + 1, seed) * u;
};
H.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
H.lerp = (a, b, t) => a + (b - a) * t;
H.smooth = (a, b, v) => { const t = H.clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
H.damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);
H.col = (hex) => new THREE.Color(hex);

// ---------- 圆角盒（UV 按米计，方便贴图密度统一） ----------
const _rbCache = new Map();
H.roundedBox = function (w, h, d, r = 0.1, seg = 2) {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  if (r <= 0.001) seg = 0;
  const n = seg * 2 + 1;
  const key = n;
  let base = _rbCache.get(key);
  if (!base) { base = new THREE.BoxGeometry(1, 1, 1, n, n, n).toNonIndexed(); _rbCache.set(key, base); }
  const g = new THREE.BufferGeometry();
  const src = base.attributes.position.array;
  const pos = new Float32Array(src.length), nor = new Float32Array(src.length);
  const uv = new Float32Array(src.length / 3 * 2);
  const hb = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  const half = 0.5 / n;
  const p = new THREE.Vector3(), nn = new THREE.Vector3();
  const srcN = base.attributes.normal.array;
  for (let i = 0, j = 0; i < src.length; i += 3, j += 2) {
    p.set(src[i], src[i + 1], src[i + 2]);
    if (seg === 0) {
      pos[i] = p.x * w; pos[i + 1] = p.y * h; pos[i + 2] = p.z * d;
      nn.set(srcN[i], srcN[i + 1], srcN[i + 2]);
    } else {
      nn.copy(p);
      nn.x -= Math.sign(nn.x) * half; nn.y -= Math.sign(nn.y) * half; nn.z -= Math.sign(nn.z) * half;
      nn.normalize();
      pos[i] = hb.x * Math.sign(p.x) + nn.x * r;
      pos[i + 1] = hb.y * Math.sign(p.y) + nn.y * r;
      pos[i + 2] = hb.z * Math.sign(p.z) + nn.z * r;
    }
    nor[i] = nn.x; nor[i + 1] = nn.y; nor[i + 2] = nn.z;
    // 盒投影 UV（以原始面法线决定投影面）
    const fx = Math.abs(srcN[i]), fy = Math.abs(srcN[i + 1]);
    // 侧面 u 从左边角起算、v 从底面起算，楼层/幕墙格子才能和楼体对齐
    if (fx > 0.5) { uv[j] = pos[i + 2] * -Math.sign(srcN[i]) + d / 2; uv[j + 1] = pos[i + 1] + h / 2; }
    else if (fy > 0.5) { uv[j] = pos[i]; uv[j + 1] = pos[i + 2]; }
    else { uv[j] = pos[i] * Math.sign(srcN[i + 2]) + w / 2; uv[j + 1] = pos[i + 1] + h / 2; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
};

// 圆柱（两端带圆角倒边）：用 Lathe 做轮廓
H.roundedCylinder = function (rad, h, bevel = 0.05, radial = 16) {
  bevel = Math.min(bevel, rad * 0.9, h / 2 - 1e-3);
  const pts = [];
  pts.push(new THREE.Vector2(0, -h / 2));
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rad - bevel + Math.cos(a) * bevel, -h / 2 + bevel + Math.sin(a) * bevel));
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rad - bevel + Math.cos(a) * bevel, h / 2 - bevel + Math.sin(a) * bevel));
  }
  pts.push(new THREE.Vector2(0, h / 2));
  const g = new THREE.LatheGeometry(pts, radial);
  return g;
};

// 柔和的树冠：位移过的二十面体
H.blob = function (rad, rng, detail = 2, amp = 0.18) {
  let g = new THREE.IcosahedronGeometry(rad, detail);
  // 二十面体默认是非索引的，先合并重复顶点，法线才能算成平滑的
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = THREE.BufferGeometryUtils.mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const k1 = rng() * 10, k2 = rng() * 10;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const f = 1 + amp * (Math.sin(n.x * 3.1 + k1) * Math.cos(n.z * 2.7 + k2) + 0.5 * Math.sin(n.y * 4.3 + k1));
    v.copy(n).multiplyScalar(rad * f);
    if (v.y < -rad * 0.4) v.y = -rad * 0.4 + (v.y + rad * 0.4) * 0.35; // 底部压扁
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
};

// 斜屋顶（三角柱 + 倒角 => 圆润边）
H.gableRoof = function (w, d, h, bevel = 0.12) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 1,
  });
  g.translate(0, 0, -d / 2);
  // 重新计算按米 UV
  const p = g.attributes.position, uv = g.attributes.uv, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), az = Math.abs(n.getZ(i));
    if (az > 0.7) uv.setXY(i, p.getX(i), p.getY(i));
    else uv.setXY(i, p.getZ(i), p.getY(i) * 1.3 + ax * p.getX(i) * 0.4);
  }
  return g;
};

// ---------- 合批构建器 ----------
// 每个块(chunk)把所有几何按材质归桶，最后每桶合成一个 Mesh。顶点色负责同材质不同颜色。
// tag：设了以后 add 进来的几何会被登记，build 后 ranges[tag] 给出它们在合并网格里的顶点区段（可进楼的建筑靠这个把实心楼体藏起来）
H.Builder = class {
  constructor() { this.buckets = new Map(); this.tag = null; this.tagged = []; this.ranges = {}; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); }
  add(matKey, geo, x, y, z, ry = 0, color = 0xffffff, opts) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const rx = opts && opts.rx || 0, rz = opts && opts.rz || 0;
    if (opts && opts.uvx) { // [su, ou, sv, ov]：把 UV 映射到图集的某一格
      const a = g.attributes.uv, t = opts.uvx;
      for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * t[0] + t[1], a.getY(i) * t[2] + t[3]);
    }
    if (opts && opts.uvf) { // 自定义 UV 函数 (u, v) => [u', v']
      const a = g.attributes.uv;
      for (let i = 0; i < a.count; i++) { const r = opts.uvf(a.getX(i), a.getY(i)); a.setXY(i, r[0], r[1]); }
    }
    const sc = opts && opts.s;
    this._e.set(rx, ry, rz, 'YXZ');
    this._q.setFromEuler(this._e);
    if (sc) this._s.set(sc[0], sc[1], sc[2]); else this._s.set(1, 1, 1);
    this._m.compose(this._p.set(x, y, z), this._q, this._s);
    g.applyMatrix4(this._m);
    const c = color instanceof THREE.Color ? color : H.col(color);
    const cnt = g.attributes.position.count;
    const ca = new Float32Array(cnt * 3);
    const lc = c; // legacyMode=false 时 Color 内部已是线性值
    for (let i = 0; i < cnt; i++) { ca[i * 3] = lc.r; ca[i * 3 + 1] = lc.g; ca[i * 3 + 2] = lc.b; }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    let b = this.buckets.get(matKey);
    if (!b) { b = []; this.buckets.set(matKey, b); }
    b.push(g);
    if (this.tag) this.tagged.push([this.tag, matKey, b.length - 1]);
    return g;
  }
  build(materials, group, shadowKeys) {
    const meshes = {}, starts = {};
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const st = starts[key] = []; let acc = 0;
      for (const g of list) { st.push([acc, g.attributes.position.count]); acc += g.attributes.position.count; }
      const merged = THREE.BufferGeometryUtils.mergeBufferGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      const sh = shadowKeys[key] || 0;
      mesh.castShadow = !!(sh & 1); mesh.receiveShadow = !!(sh & 2);
      mesh.name = key;
      group.add(mesh);
      meshes[key] = mesh;
    }
    // 同一个 tag 在同一个网格里相邻的区段合并成一段
    for (const [tag, key, i] of this.tagged) {
      const mesh = meshes[key]; if (!mesh) continue;
      const [s, n] = starts[key][i];
      const list = this.ranges[tag] || (this.ranges[tag] = []);
      const last = list[list.length - 1];
      if (last && last.mesh === mesh && last.start + last.count === s) last.count += n;
      else list.push({ mesh, start: s, count: n });
    }
    this.tagged.length = 0;
    this.buckets.clear();
  }
};
// 把一组区段的顶点压成一个点（藏起来）或恢复原样
H.hideRanges = function (ranges, hide) {
  const touched = new Set();
  for (const r of ranges || []) {
    const pa = r.mesh.geometry.attributes.position;
    const a = r.start * 3, b = (r.start + r.count) * 3;
    if (hide) { if (!r.saved) r.saved = pa.array.slice(a, b); pa.array.fill(0, a, b); }
    else if (r.saved) { pa.array.set(r.saved, a); r.saved = null; }
    touched.add(pa);
  }
  touched.forEach((pa) => { pa.needsUpdate = true; });
};

// 一个四边形（面朝 +Z），可指定图集 UV 区域
H.quad = function (w, h, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? u1 : u0, uv.getY(i) ? v1 : v0);
  return g;
};
