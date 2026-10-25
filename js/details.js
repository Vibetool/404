// 窗户和门的"薄件"：有厚度的窗框、中梃、窗台、凹进去的玻璃、门板、门把手。
// 每个地块生成时只记录窗/门的位置和样式（ch.wins），离玩家近的块才按记录用实例化网格拼出来；远处仍用平面贴图。
// 近处的玻璃用"视差室内"着色器：在玻璃后面算一个假房间（墙、地板、天花板、沙发、窗帘），看起来是半透明能看到屋里的。
// 楼被"打开"（H.interior 生成了真室内）时，这栋楼的玻璃和门扇实例会被藏起来，换成真的透明玻璃和能开的门。
'use strict';
(function () {
  const D = H.detail = {};
  D.radius = 110; // 离相机多近的块换成立体窗（米，沿路方向）
  let G = null, MAT = null;

  // 沿 x 方向拉伸一个凸多边形截面（y, z），z 朝墙外；贴墙的背面省掉
  function profileBar(prof) {
    const pos = [], nor = [];
    let cy = 0, cz = 0; prof.forEach(([y, z]) => { cy += y; cz += z; }); cy /= prof.length; cz /= prof.length;
    const tri = (a, b, c, n) => {
      const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
      const g = new THREE.Vector3().crossVectors(ab, ac);
      if (g.dot(n) < 0) { const t = b; b = c; c = t; }
      for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z); }
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (let i = 0; i < prof.length; i++) {
      const [y0, z0] = prof[i], [y1, z1] = prof[(i + 1) % prof.length];
      let ny = z1 - z0, nz = -(y1 - y0);
      const l = Math.hypot(ny, nz); ny /= l; nz /= l;
      if ((y0 + y1) / 2 * ny - cy * ny + ((z0 + z1) / 2 - cz) * nz < 0) { ny = -ny; nz = -nz; }
      if (nz < -0.9) continue;
      const n = V(0, ny, nz);
      tri(V(-0.5, y0, z0), V(0.5, y0, z0), V(0.5, y1, z1), n);
      tri(V(-0.5, y0, z0), V(0.5, y1, z1), V(-0.5, y1, z1), n);
    }
    for (const sx of [-0.5, 0.5]) {
      const n = V(Math.sign(sx), 0, 0);
      for (let i = 1; i < prof.length - 1; i++) tri(V(sx, prof[0][0], prof[0][1]), V(sx, prof[i][0], prof[i][1]), V(sx, prof[i + 1][0], prof[i + 1][1]), n);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
    return g;
  }

  function init() {
    const fw = 0.065, d = 0.06;
    G = {
      // 窗框条：宽 6.5cm、厚 6cm，外沿 2cm 倒角、内沿 1cm 倒角
      fbar: profileBar([[-fw / 2, 0], [fw / 2, 0], [fw / 2, d - 0.02], [fw / 2 - 0.02, d], [-fw / 2 + 0.01, d], [-fw / 2, d - 0.01]]),
      // 窗台：高 4.4cm、伸出 14cm，前上角倒圆
      sill: profileBar([[-0.022, 0], [0.022, 0], [0.022, 0.118], [0.012, 0.136], [-0.008, 0.142], [-0.022, 0.14]]),
      pane: new THREE.PlaneGeometry(1, 1),
      slab: H.roundedBox(1, 1, 0.045, 0.012, 1),
      panel: H.roundedBox(1, 1, 0.022, 0.009, 1),
      knob: new THREE.SphereGeometry(1, 12, 9),
      pbar: (() => { const g = new THREE.CylinderGeometry(1, 1, 1, 10); g.rotateZ(Math.PI / 2); return g; })(),
    };
    const patch = H.mat.patch;
    const frame = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.06 }));
    const wood = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    const metal = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.9 });
    MAT = { fbar: frame, sill: frame, pane: paneMaterial(), slab: wood, panel: wood, knob: metal, pbar: metal };
    D.paneMat = MAT.pane;
  }

  // ---------- 视差室内玻璃 ----------
  // aRoom = (随机种子, 夜里亮不亮灯, 窗帘样式 0..3, 种类*4 + 玻璃中心到室内地面的距离)
  // 种类：0 住宅窗 1 别墅窗 2 阳台门 3 商铺 4 大堂
  const PU = { uDay: { value: 1 }, uNight: { value: 0 } };
  D.setLight = function (day, night) { PU.uDay.value = day; PU.uNight.value = night; };
  function paneMaterial() {
    const m = new THREE.MeshStandardMaterial({ color: 0x0b1016, roughness: 0.07, metalness: 0.0, envMapIntensity: 1.15 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, PU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aRoom;
          varying vec4 vRoom; varying vec3 vPW; varying vec3 vAx; varying vec3 vAy; varying vec3 vAz; varying vec2 vLp; varying vec2 vSz;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          {
            mat4 mI = modelMatrix * instanceMatrix;
            vSz = vec2(length(mI[0].xyz), length(mI[1].xyz));
            vAx = mI[0].xyz / vSz.x; vAy = mI[1].xyz / vSz.y; vAz = normalize(mI[2].xyz);
            vLp = position.xy * vSz;
            vPW = (mI * vec4(position, 1.0)).xyz;
            vRoom = aRoom;
          }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uDay; uniform float uNight;
          varying vec4 vRoom; varying vec3 vPW; varying vec3 vAx; varying vec3 vAy; varying vec3 vAz; varying vec2 vLp; varying vec2 vSz;
          float rh1(float n) { return fract(sin(n * 12.9898 + 4.1) * 43758.5453); }
          // 射线和轴对齐盒子求交，返回进入距离（没打中返回很大的数）
          float rayBox(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
            vec3 inv = 1.0 / d;
            vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
            vec3 tn = min(t0, t1), tf = max(t0, t1);
            float a = max(max(tn.x, tn.y), tn.z), b = min(min(tf.x, tf.y), tf.z);
            return (b > max(a, 0.0)) ? a : 1e5;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 V = normalize(vPW - cameraPosition);
            vec3 d = vec3(dot(V, vAx), dot(V, vAy), dot(V, vAz));
            d.z = min(d.z, -0.03);
            d.x = abs(d.x) < 1e-4 ? 1e-4 : d.x; d.y = abs(d.y) < 1e-4 ? 1e-4 : d.y;
            float kind = floor(vRoom.w / 4.0 + 0.001);
            float fo = vRoom.w - kind * 4.0;
            float seed = vRoom.x, lit = vRoom.y, vr = vRoom.z;
            float hw = vSz.x * 0.5, hh = vSz.y * 0.5;
            float fl = -fo;
            float rw = max(hw + 0.9, 1.5) + seed * 0.7, xo = (rh1(seed * 91.0) - 0.5) * 0.8, rhgt = 2.7, dep = 3.0 + seed * 1.8;
            if (kind > 2.5) { rhgt = 3.5; dep = 5.5; rw = max(hw + 1.6, 2.6); xo = 0.0; }
            if (kind > 3.5) { rhgt = 3.8; dep = 8.0; }
            float xl = xo - rw, xr = xo + rw, cl = fl + rhgt;
            vec2 p = vLp;
            float tx = ((d.x > 0.0 ? xr : xl) - p.x) / d.x;
            float ty = ((d.y > 0.0 ? cl : fl) - p.y) / d.y;
            float tz = -dep / d.z;
            float t = min(min(tx, ty), tz);
            vec3 hp = vec3(p + d.xy * t, d.z * t);
            float y = hp.y - fl; // 离室内地面的高度
            vec3 wall = mix(vec3(0.93, 0.91, 0.87), vec3(rh1(seed * 13.1), rh1(seed * 17.3), rh1(seed * 23.7)) * 0.5 + 0.45, 0.4);
            vec3 c;
            float u = 0.0;
            if (t == tz) { c = wall; u = hp.x; }
            else if (t == tx) { c = wall * 0.84; u = hp.z; }
            else if (d.y < 0.0) {
              if (kind > 2.5) c = mix(vec3(0.78, 0.76, 0.72), vec3(0.88, 0.87, 0.84), step(0.5, fract(floor(hp.x * 1.6) * 0.5 + floor(hp.z * 1.6) * 0.5)));
              else c = vec3(0.56, 0.39, 0.25) * (0.86 + 0.14 * step(0.07, fract(hp.x * 5.0 + floor(hp.z * 0.9) * 0.37)));
            } else {
              c = vec3(0.93);
              if (length(vec2(hp.x - xo, hp.z + dep * 0.45)) < 0.24) c = vec3(1.6, 1.5, 1.3) * mix(0.7, 1.0, lit);
            }
            if (kind < 2.5) {
              // 后墙一扇通往别的房间的门洞（更暗）、一幅画
              float dx0 = seed > 0.5 ? xr - 1.35 : xl + 0.45;
              if (t == tz && hp.x > dx0 && hp.x < dx0 + 0.9 && y < 2.05) c = wall * 0.42;
              if (t == tz && abs(hp.x - xo + 0.2) < 0.38 && abs(y - 1.55) < 0.24) c = vec3(rh1(seed * 5.0), rh1(seed * 7.0), rh1(seed * 9.0)) * 0.7 + 0.15;
              // 靠后墙一张沙发/柜子
              vec3 o3 = vec3(p, 0.0);
              float tb = rayBox(o3, d, vec3(xo - 0.95, fl, -dep), vec3(xo + 0.95, fl + 0.82, -dep + 0.85));
              if (tb < t) { vec3 bp = o3 + d * tb; c = vec3(rh1(seed * 3.3), rh1(seed * 4.4), rh1(seed * 5.5)) * 0.45 + 0.25; c *= (abs(bp.y - fl - 0.82) < 0.01 ? 1.0 : 0.8); t = tb; hp = bp; }
            } else if (kind < 3.5) {
              // 商铺：后墙和侧墙是货架
              if (t != ty && y > 0.25 && y < 2.15) {
                float row = floor((y - 0.25) / 0.47), fy = fract((y - 0.25) / 0.47);
                float cell = floor(u * 7.0);
                vec3 good = vec3(rh1(cell + row * 13.0 + seed * 7.0), rh1(cell * 1.7 + row * 5.0), rh1(cell * 2.3 + row * 3.0 + seed)) * 0.75 + 0.2;
                c = fy < 0.1 ? vec3(0.55, 0.42, 0.3) : (fy < 0.75 && fract(u * 7.0) > 0.12 ? good : c * 0.55);
              }
            }
            float far = clamp(-hp.z / dep, 0.0, 1.0);
            c *= mix(1.0, 0.62, far);
            vec3 warm = kind > 2.5 ? vec3(1.0, 0.93, 0.8) * 1.6 : vec3(1.0, 0.8, 0.56) * 1.3;
            vec3 L = mix(vec3(0.5 * uDay + 0.03), lit > 0.5 ? warm : vec3(0.02), uNight);
            vec3 rad = c * L;
            // 窗帘（贴着玻璃，被屋里的光从背后照着）
            if (kind < 1.5) {
              vec3 cc = mix(vec3(0.95, 0.9, 0.8), vec3(rh1(seed * 31.0), rh1(seed * 37.0), rh1(seed * 41.0)) * 0.5 + 0.45, 0.6);
              float cur = 0.0;
              if (vr < 0.5) cur = step(hw * 0.6, abs(p.x)) * 0.92;
              else if (vr < 1.5) cur = step(hh - vSz.y * 0.55, p.y) * step(0.45, fract(p.y / 0.07)) * 0.85;
              else if (vr < 2.5) cur = step(hh - vSz.y * 0.4, p.y) * 0.9;
              rad = mix(rad, cc * mix(vec3(0.55 * uDay + 0.04), lit > 0.5 ? warm * 0.8 : vec3(0.03), uNight), cur);
            }
            float fres = 0.04 + 0.96 * pow(1.0 + d.z, 5.0);
            totalEmissiveRadiance += rad * (1.0 - fres);
          }`);
    };
    return m;
  }

  const WHITE = new THREE.Color('#fbfaf6'), DARK = new THREE.Color('#41464d'), SILVER = new THREE.Color('#c9ced4');
  const GOLD = new THREE.Color('#d8b25a'), WOOD = new THREE.Color('#9a6640'), WOOD2 = new THREE.Color('#84552f');
  const PI = Math.PI;

  // put(部件, x, y, z, 绕z旋转, 缩放x, 缩放y, 缩放z, 颜色, 玻璃的房间参数, 进楼后要不要藏) —— 坐标是"立面局部"：x 沿墙，y 向上，z 朝外
  function frame(put, w, h, fw, col, noBottom) {
    const k = fw / 0.065;
    put('fbar', 0, h / 2 - fw / 2, 0, 0, w, k, 1, col);
    if (!noBottom) put('fbar', 0, -h / 2 + fw / 2, 0, PI, w, k, 1, col);
    put('fbar', -w / 2 + fw / 2, 0, 0, PI / 2, h, k, 1, col);
    put('fbar', w / 2 - fw / 2, 0, 0, -PI / 2, h, k, 1, col);
  }
  const mullV = (put, x, h, fw, col, hide) => put('fbar', x, 0, 0, PI / 2, h - 2 * fw, fw / 0.065 * 0.7, 0.8, col, null, hide);
  const mullH = (put, y, w, fw, col) => put('fbar', 0, y, 0, 0, w - 2 * fw, fw / 0.065 * 0.7, 0.8, col);
  // 房间参数：种子、亮灯、窗帘样式、种类*4 + 玻璃中心到地面的距离
  const room = (s, kind, lit, vr, fo) => [H.hash(Math.round(s.x * 10) + 7, Math.round(s.z * 10) + Math.round(s.y * 10) * 977), lit ? 1 : 0, vr, kind * 4 + Math.min(3.9, fo)];
  const pane = (put, w, h, fw, rm) => put('pane', 0, 0, 0.014, 0, w - 2 * fw + 0.02, h - 2 * fw + 0.02, 1, WHITE, rm, true);

  const KIND = {
    // 住宅窗：外框 + 中梃 + 窗台
    res(s, put, col) {
      frame(put, s.w, s.h, 0.065, col); mullV(put, 0, s.h, 0.065, col);
      pane(put, s.w, s.h, 0.065, room(s, 0, s.r === 1, s.c, s.h / 2 + 0.7));
      put('sill', 0, -s.h / 2 - 0.022, 0, 0, s.w + 0.16, 1, 1, col);
    },
    // 别墅窗：十字窗棂
    villa(s, put) {
      frame(put, s.w, s.h, 0.07, WHITE); mullV(put, 0, s.h, 0.07, WHITE); mullH(put, 0, s.w, 0.07, WHITE);
      pane(put, s.w, s.h, 0.07, room(s, 1, s.c === 1, Math.floor(H.hash(Math.round(s.x * 10), Math.round(s.y * 10)) * 4), s.h / 2 + 0.75));
      put('sill', 0, -s.h / 2 - 0.022, 0, 0, s.w + 0.18, 1, 1, WHITE);
    },
    // 阳台门
    bdoor(s, put, col) {
      frame(put, s.w, s.h, 0.065, col); mullV(put, 0, s.h, 0.065, col, true);
      const sd = room(s, 2, false, 3, s.h / 2 - 0.03); sd[1] = sd[0] < 0.35 ? 1 : 0;
      pane(put, s.w, s.h, 0.065, sd);
    },
    // 公寓大门：深色金属框双开玻璃门 + 上亮子 + 横推杆（门不画下框，进楼后换成能开的门扇）
    gdoor(s, put) {
      frame(put, s.w, s.h, 0.08, DARK, true); mullV(put, 0, s.h, 0.08, DARK, true); mullH(put, s.h / 2 - 0.5, s.w, 0.08, DARK);
      pane(put, s.w, s.h, 0.08, room(s, 4, true, 3, s.h / 2 - 0.13));
      for (const sx of [-1, 1]) put('pbar', sx * s.w * 0.24, -0.08, 0.085, 0, s.w * 0.3, 0.017, 0.017, SILVER, null, true);
    },
    // 店铺单开玻璃门 + 竖拉手
    sdoor(s, put) {
      frame(put, s.w, s.h, 0.07, DARK, true);
      pane(put, s.w, s.h, 0.07, room(s, 3, true, 3, s.h / 2 - 0.13));
      put('pbar', s.w / 2 - 0.17, -0.05, 0.08, PI / 2, 0.62, 0.017, 0.017, SILVER, null, true);
    },
    // 别墅木门：白色门套 + 木门板 + 两块凸起的门芯板 + 金色球形把手
    wdoor(s, put) {
      const fw = 0.09;
      frame(put, s.w, s.h, fw, WHITE, true);
      const iw = s.w - 2 * fw + 0.02, ih = s.h - fw + 0.01;
      put('slab', 0, -fw / 2 + 0.005, 0.027, 0, iw, ih, 1, WOOD);
      put('panel', 0, ih * 0.18, 0.054, 0, iw * 0.64, ih * 0.3, 1, WOOD2);
      put('panel', 0, -ih * 0.2, 0.054, 0, iw * 0.64, ih * 0.34, 1, WOOD2);
      put('knob', iw * 0.36, -0.06, 0.07, 0, 0.034, 0.034, 0.034, GOLD);
    },
    // 店铺橱窗：粗框 + 竖向分格 + 底部踢脚板
    shopwin(s, put) {
      frame(put, s.w, s.h, 0.08, DARK);
      const n = Math.max(1, Math.round(s.w / 1.4));
      for (let k = 1; k < n; k++) mullV(put, -s.w / 2 + s.w * k / n, s.h, 0.08, DARK);
      pane(put, s.w, s.h, 0.08, room(s, 3, true, 3, s.h / 2 + 0.33));
      put('sill', 0, -s.h / 2 - 0.16, 0, 0, s.w + 0.06, 7, 0.55, DARK);
    },
    // 写字楼大堂：银色铝框 + 三根竖梃 + 一道横梃
    lobby(s, put) {
      frame(put, s.w, s.h, 0.07, SILVER);
      for (const f of [-0.25, 0, 0.25]) mullV(put, f * s.w, s.h, 0.07, SILVER);
      mullH(put, s.h / 2 - 0.6, s.w, 0.07, SILVER);
      const sd = room(s, 4, false, 3, s.h / 2 + 0.3); sd[1] = sd[0] < 0.55 ? 1 : 0;
      pane(put, s.w, s.h, 0.07, sd);
    },
  };

  const _base = new THREE.Matrix4(), _lm = new THREE.Matrix4(), _out = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  const _col = new THREE.Color();

  D.build = function (ch) {
    if (!G) init();
    const acc = {}, hid = {};
    let bid = 0;
    const put = (part, px, py, pz, rz, sx, sy, sz, color, cell, hide) => {
      _e.set(0, 0, rz); _q.setFromEuler(_e);
      _lm.compose(_v.set(px, py, pz), _q, _s.set(sx, sy, sz));
      _out.multiplyMatrices(_base, _lm);
      let a = acc[part]; if (!a) a = acc[part] = { m: [], c: [], cell: [] };
      if (hide && bid) (hid[bid] || (hid[bid] = [])).push([part, a.c.length / 3]);
      _out.toArray(a.m, a.m.length);
      a.c.push(color.r, color.g, color.b);
      if (cell) a.cell.push(cell[0], cell[1], cell[2], cell[3]);
    };
    for (const s of ch.wins || []) {
      _base.makeRotationY(s.ry); _base.setPosition(s.x, s.y, s.z);
      _col.set(s.color || '#ffffff');
      bid = s.bid || 0;
      KIND[s.kind](s, put, _col);
    }
    const grp = new THREE.Group(); grp.name = 'detail';
    grp.userData = { hid, mesh: {}, saved: new Map() };
    const bound = new THREE.Sphere(new THREE.Vector3(0, 30, 32), 80);
    for (const part in acc) {
      const a = acc[part], n = a.c.length / 3;
      const geo = G[part].clone();
      if (part === 'pane') geo.setAttribute('aRoom', new THREE.InstancedBufferAttribute(new Float32Array(a.cell), 4));
      geo.boundingSphere = bound.clone();
      const mesh = new THREE.InstancedMesh(geo, MAT[part], n);
      mesh.instanceMatrix.array.set(a.m);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(a.c), 3);
      mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      grp.add(mesh);
      grp.userData.mesh[part] = mesh;
    }
    grp.matrixAutoUpdate = false;
    // 已经打开的楼：它的玻璃和门扇一生成就藏起来
    if (H.interior) for (const b in hid) if (H.interior.isOpen(+b)) D.setHidden(grp, +b, true);
    return grp;
  };
  // 藏起 / 恢复某栋楼的玻璃和门扇实例
  D.setHidden = function (grp, bid, on) {
    const ud = grp.userData, list = ud.hid && ud.hid[bid];
    if (!list) return;
    for (const [part, i] of list) {
      const m = ud.mesh[part], arr = m.instanceMatrix.array, key = part + ':' + i;
      if (on) { if (!ud.saved.has(key)) ud.saved.set(key, arr.slice(i * 16, i * 16 + 16)); arr.fill(0, i * 16, i * 16 + 16); }
      else { const sv = ud.saved.get(key); if (sv) { arr.set(sv, i * 16); ud.saved.delete(key); } }
      m.instanceMatrix.needsUpdate = true;
    }
  };
  D.dispose = function (grp) { grp.children.forEach((m) => { m.geometry.dispose(); if (m.isInstancedMesh) m.dispose(); }); };
})();
