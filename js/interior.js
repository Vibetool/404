// 室内：玩家走近公寓 / 沿街商铺时把这栋楼"打开"——
// 藏起合批网格里的实心楼体，换成带窗洞的空心外墙；里面有楼板、隔墙、分好房间的户、楼梯、能用的电梯、能开的门。
// 公寓的标准层只拼一次，用实例化网格叠到每一层；门、电梯这些会动的东西单独做。
// 建筑局部坐标：x = 离楼正面外墙的进深（0 是正面），z = 沿街方向（楼中线为 0），y = 高出人行道（人行道在世界里是 SY）。
'use strict';
(function () {
  const IN = H.interior = {};
  const ACT_R = 34, DEACT_R = 52, MAX_OPEN = 4;
  const T = 0.25;                  // 外墙厚：内墙面在 x = T
  const PW = 0.12, IW = 0.1;       // 户墙 / 户内隔墙厚
  const CORW = 1.5;                // 走廊净宽
  const LAND = 1.3, RUN = 2.6, LAND2 = 1.3, NSTEP = 9; // 楼梯：楼层平台、梯段水平长、休息平台、每跑台阶数
  const PI = Math.PI;
  const SY = () => H.world.C.SY;
  const CC = {};
  const col = (h) => CC[h] || (CC[h] = new THREE.Color(h));
  const WHITE = col('#ffffff');
  const PUBC = '#ece6da', STEPC = '#d8d3ca', LAMPC = '#fff7e6';
  const UNITC = ['#f3efe6', '#eef3ee', '#f6eee8', '#edf0f6', '#f5f1e2', '#f1ece8'];
  const DOORC = ['#7a3b2e', '#5b5f66', '#8a6a4a', '#3f4a5a', '#6e2f2f', '#4a5a4e'];

  // ---------- 材质（室内不打天气补丁：屋里不会湿、不会积雪） ----------
  let M = null;
  // 屋里的环境光：天光（半球光）打个折，再加一点从地面墙面反弹上来的暖光（不然朝下的天花板发灰）
  // 天空的环境贴图漫反射同理（镜面反射保留，地板还能反光）
  // 夜里亮灯：每个顶点带 aUnit（属于哪一户，7 = 公共区，-1 = 不算），标准层每一层（实例）带一个 aLitMask，
  // 第 k 位为 1 表示这一层第 k 户开着灯 —— 开灯的户墙、地板、天花板泛暖光，从街上看就是一扇扇亮着的窗
  const IU = { uIndoorAmb: { value: 0.45 }, uIndoorIbl: { value: 0.25 }, uBounce: { value: new THREE.Color(0.3, 0.29, 0.27) }, uNightGlow: { value: 0 }, uNight: { value: 0 },
    // 封面那间客厅（K403+997）的世界坐标包围盒：盒子里的墙面、布料纹理满强度，别处一半
    uHeroMin: { value: new THREE.Vector3(1e6, 1e6, 1e6) }, uHeroMax: { value: new THREE.Vector3(-1e6, -1e6, -1e6) } };
  // 装饰灯：同一户的三款灯（aVar = 1 灯带 / 2 吸顶灯 / 3 吊灯）都建在标准层里，
  // 每层实例的 aLightSel 每户占 2 位，选中哪款就显示哪款，其余塌成一个点（不多一次绘制）
  const LIT_VERT = `
    #ifdef USE_INSTANCING
      vLit = aUnit < -0.5 ? 0.0 : mod(floor(aLitMask / exp2(aUnit) + 0.001), 2.0);
      if (aVar > 0.5) {
        float lsel = mod(floor(aLightSel / exp2(2.0 * max(aUnit, 0.0)) + 0.001), 4.0);
        if (abs(lsel - aVar) > 0.5) transformed = vec3(0.0);
      }
    #else
      vLit = LIT_DEFAULT;
    #endif`;
  const LIT_DECL = 'attribute float aUnit; attribute float aVar;\n#ifdef USE_INSTANCING\nattribute float aLitMask; attribute float aLightSel;\n#endif\nvarying float vLit;';
  const HEMI_LINE = 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometry.normal );';
  const IBL_LINE = 'iblIrradiance += getIBLIrradiance( geometry.normal );';
  // three 把投影的平行光排在前面；下标超出投影灯数的（闪电补光、关了阴影的日光月光）没有阴影挡，会直接穿墙照进屋，这里在屋里把它们去掉
  const DIR_LINE = 'getDirectionalLightInfo( directionalLight, geometry, directLight );';
  const DIR_CUT = DIR_LINE + '\n#if ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )\ndirectLight.color *= 0.0;\n#endif';
  // opts.hero = 纹理强度：map 是围绕 0.5 的灰度图，按强度叠到底色上；在封面那间里满强度，别处减半（HERO_TEX）
  const HERO_VERT = `
    #ifdef HERO_TEX
      #ifdef USE_INSTANCING
        vHeroP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vHeroP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
    #endif`;
  const HERO_MAP = `
    #ifdef HERO_TEX
      #ifdef USE_MAP
        vec4 heroTexel = texture2D(map, vUv);
        float heroK = (all(greaterThan(vHeroP, uHeroMin)) && all(lessThan(vHeroP, uHeroMax))) ? 1.0 : 0.5;
        diffuseColor.rgb *= 1.0 + (heroTexel.rgb - 0.5) * (MAP_AMT * heroK);
      #endif
    #else
      #include <map_fragment>
    #endif`;
  function indoorLit(m, opts = {}) {
    m.defines = { LIT_DEFAULT: '0.0' };
    if (opts.hero) { m.defines.HERO_TEX = ''; m.defines.MAP_AMT = opts.hero.toFixed(3); }
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, IU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + LIT_DECL + '\n#ifdef HERO_TEX\nvarying vec3 vHeroP;\n#endif')
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + LIT_VERT).replace('#include <project_vertex>', '#include <project_vertex>' + HERO_VERT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uIndoorAmb; uniform float uIndoorIbl; uniform vec3 uBounce; uniform float uNightGlow; varying float vLit;\n#ifdef HERO_TEX\nvarying vec3 vHeroP; uniform vec3 uHeroMin; uniform vec3 uHeroMax;\n#endif')
        .replace('#include <map_fragment>', HERO_MAP)
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(HEMI_LINE, HEMI_LINE.replace(';', ' * uIndoorAmb;')).replace(DIR_LINE, DIR_CUT) + '\nirradiance += uBounce;')
        .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace(IBL_LINE, IBL_LINE.replace(';', ' * uIndoorIbl;')))
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.58) * (vLit * uNightGlow);');
    };
    return m;
  }
  // 顶灯：白天是关着的灰白灯片，夜里开灯的户亮成暖白、没开的发暗
  function lampMat() {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true });
    m.defines = { LIT_DEFAULT: '1.0' };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, IU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + LIT_DECL).replace('#include <begin_vertex>', '#include <begin_vertex>' + LIT_VERT);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLit;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.85, mix(0.22, 1.7, vLit), uNight);');
    };
    return m;
  }
  const SHADOW = { iTV: 0, iTVH: 0, iWall: 3, iWallX: 3, iCeil: 3, iSlab: 3, iWood: 2, iTile: 2, iStone: 2, iConc: 3, iMetal: 3, iSteel: 3, iDoor: 3, iGlass: 0, iLamp: 0, iGoods: 3, iFabric: 3, iLeaf: 3, iDeco: 2, iBottle: 0, iFrost: 0 };
  function mats() {
    if (M) return M;
    const X = H.tex;
    const rep = (t, s) => { const c = t.clone(); c.needsUpdate = true; c.repeat.set(1 / s, 1 / s); return c; };
    // 屋里天光进不来多少：环境贴图（天空）贡献压低，不然整屋发白发蓝
    const std = (o, opts) => indoorLit(new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, envMapIntensity: 0.6 }, o)), opts);
    M = {
      iWall: std({ map: rep(X.wallI, 2), normalMap: rep(X.plasterN, 2), normalScale: new THREE.Vector2(0.12, 0.12), roughness: 0.9 }, { hero: 1.25 }),
      iCeil: std({ roughness: 0.95, envMapIntensity: 0.3 }),
      iSlab: std({ map: rep(X.plaster, 2), roughness: 0.9 }),
      iWood: std({ map: rep(X.floorWood, 2.4), normalMap: rep(X.floorWoodN, 2.4), normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.46, envMapIntensity: 0.6 }),
      iTile: std({ map: rep(X.floorTile, 1.2), normalMap: rep(X.floorTileN, 1.2), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.3, envMapIntensity: 0.6 }),
      iStone: std({ map: rep(X.floorStone, 2.4), roughness: 0.2, envMapIntensity: 0.7 }),
      iConc: std({ map: rep(X.plaster, 2), normalMap: rep(X.plasterN, 2), normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.88 }),
      iMetal: std({ roughness: 0.35, metalness: 0.6, envMapIntensity: 0.8 }),
      iSteel: std({ map: rep(X.steel, 1), roughness: 0.38, metalness: 0.55, envMapIntensity: 0.35 }),
      iDoor: std({ map: rep(X.woodGrain, 1.2), roughness: 0.42, metalness: 0.15, envMapIntensity: 0.6 }),
      iGlass: new THREE.MeshStandardMaterial({ color: 0xd2e6f0, transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0.05, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 0.55 }),
      iLamp: lampMat(),
      iGoods: std({ roughness: 0.6 }),
      iFabric: std({ map: rep(X.fabric, 0.3), roughness: 0.95 }, { hero: 1 }),
      iLeaf: std({ roughness: 0.8 }),
      iDeco: std({ roughness: 0.3, metalness: 0.7, envMapIntensity: 0.6 }),   // 灯具五金：不投影（没选中的款式塌掉了，影子也得没有）
      iBottle: new THREE.MeshStandardMaterial({ color: 0x8cc4ee, transparent: true, opacity: 0.62, roughness: 0.12, metalness: 0.0, envMapIntensity: 0.6 }),
      iFrost: new THREE.MeshStandardMaterial({ color: 0xf1f4f6, transparent: true, opacity: 0.86, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide, envMapIntensity: 0.4 }), // 卫生间磨砂玻璃
    };
    M.iWallX = M.iWall; // 外墙内皮：画面上和 iWall 一样，单独成网格只为了换阴影深度材质（见 PUSH）
    // 电视屏幕（自发光）：封面那间全亮，别的房间半亮
    M.iTVH = new THREE.MeshBasicMaterial({ map: X.news });
    M.iTV = new THREE.MeshBasicMaterial({ map: X.news, color: new THREE.Color().setScalar(0.5) });
    return M;
  }
  // 外墙在太阳阴影图里只剩内皮那一面（外皮朝着太阳，按背面投影被剔掉），离地板太近：
  // normalBias 和掠射角下的深度误差会在墙根吃出一条漏光带（用户看到走廊后墙根"透光"）。
  // 画阴影图时把内皮沿法线往墙里推 PUSH，挡光面离屋里的地板远了，画面本身不变。
  const PUSH = 0.17;
  let pushDepthMat = null;
  function pushDepth() {
    if (pushDepthMat) return pushDepthMat;
    pushDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    pushDepthMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed -= normal * ${PUSH.toFixed(2)};`);
    };
    return pushDepthMat;
  }
  const matFor = (k) => mats()[k] || H.mat.list[k];
  const shadowFor = (k) => (SHADOW[k] !== undefined ? SHADOW[k] : (H.mat.shadow[k] || 0));

  // ---------- 几何收集器：直接往数组里塞顶点（比 Builder 的克隆+合并快得多），UV 按米做盒投影 ----------
  class Sink {
    constructor() { this.B = new Map(); this.unit = -1; this.var = 0; }
    _b(k) { let b = this.B.get(k); if (!b) { b = { p: [], n: [], u: [], c: [], a: [], v: [] }; this.B.set(k, b); } return b; }
    _v(b, x, y, z, nx, ny, nz, c, uv) {
      b.p.push(x, y, z); b.n.push(nx, ny, nz); b.a.push(this.unit); b.v.push(this.var);
      if (uv) b.u.push(uv[0], uv[1]);
      else {
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        if (ax >= ay && ax >= az) b.u.push(z, y); else if (ay >= az) b.u.push(x, z); else b.u.push(x, y);
      }
      b.c.push(c.r, c.g, c.b);
    }
    // 四个角点 + 想要的法线；绕序自动调对。uvs（可选）= 四个角各自的 UV
    quad(k, p0, p1, p2, p3, n, c, uvs) {
      const b = this._b(k);
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      const flip = gx * n[0] + gy * n[1] + gz * n[2] < 0;
      const q = flip ? [p0, p3, p2, p1] : [p0, p1, p2, p3];
      const t = uvs ? (flip ? [uvs[0], uvs[3], uvs[2], uvs[1]] : uvs) : null;
      for (const i of [0, 1, 2, 0, 2, 3]) this._v(b, q[i][0], q[i][1], q[i][2], n[0], n[1], n[2], c, t && t[i]);
    }
    // 轴对齐盒子；skip 位：1 -x 2 +x 4 -y 8 +y 16 -z 32 +z
    box(k, x0, y0, z0, x1, y1, z1, c, skip = 0) {
      if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return;
      if (!(skip & 1)) this.quad(k, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], c);
      if (!(skip & 2)) this.quad(k, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], c);
      if (!(skip & 4)) this.quad(k, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], c);
      if (!(skip & 8)) this.quad(k, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], c);
      if (!(skip & 16)) this.quad(k, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], c);
      if (!(skip & 32)) this.quad(k, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], c);
    }
    // 倒角盒（家具的棱角稍微倒圆一点）：六个面各往里收 r，每条棱一条窄斜面、每个角一个小三角；
    // 斜面上的法线从这个面过渡到那个面，看上去是圆过去的。一共 44 个三角形（圆角盒要 108 / 300 个）
    cbox(k, x0, y0, z0, x1, y1, z1, c, r) {
      r = Math.min(r, (x1 - x0) / 2 - 1e-4, (y1 - y0) / 2 - 1e-4, (z1 - z0) / 2 - 1e-4);
      if (!(r > 5e-4)) { this.box(k, x0, y0, z0, x1, y1, z1, c); return; }
      const b = this._b(k), lo = [x0, y0, z0], hi = [x1, y1, z1];
      const inn = (ax, sd) => (sd ? hi[ax] - r : lo[ax] + r);
      // 落在 (ax, sd) 那个面上的顶点：这一轴取面所在的平面，法线就是这个面的法线
      const V = (ax, sd, t) => { const p = t.slice(), n = [0, 0, 0]; p[ax] = sd ? hi[ax] : lo[ax]; n[ax] = sd ? 1 : -1; return { p, n }; };
      // UV 按 uvAx 那个面的投影（米）：一条斜面整条用同一种投影，纹理不会被挤成一条
      const uvOf = (ax, p) => (ax === 0 ? [p[2], p[1]] : ax === 1 ? [p[0], p[2]] : [p[0], p[1]]);
      const tri = (A, B, C, uvAx) => {
        const e1 = [B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]], e2 = [C.p[0] - A.p[0], C.p[1] - A.p[1], C.p[2] - A.p[2]];
        const gx = e1[1] * e2[2] - e1[2] * e2[1], gy = e1[2] * e2[0] - e1[0] * e2[2], gz = e1[0] * e2[1] - e1[1] * e2[0];
        const flip = gx * (A.n[0] + B.n[0] + C.n[0]) + gy * (A.n[1] + B.n[1] + C.n[1]) + gz * (A.n[2] + B.n[2] + C.n[2]) < 0;
        for (const v of flip ? [A, C, B] : [A, B, C]) this._v(b, v.p[0], v.p[1], v.p[2], v.n[0], v.n[1], v.n[2], c, uvOf(uvAx, v.p));
      };
      const quad = (A, B, C, D, uvAx) => { tri(A, B, C, uvAx); tri(A, C, D, uvAx); };
      for (let ax = 0; ax < 3; ax++) for (const sd of [0, 1]) {
        const u = (ax + 1) % 3, w = (ax + 2) % 3;
        const q = (iu, iw) => { const t = [0, 0, 0]; t[u] = inn(u, iu); t[w] = inn(w, iw); return V(ax, sd, t); };
        quad(q(0, 0), q(1, 0), q(1, 1), q(0, 1), ax);
      }
      for (let a = 0; a < 3; a++) for (let a2 = a + 1; a2 < 3; a2++) {
        const c3 = 3 - a - a2;
        for (const sa of [0, 1]) for (const sb of [0, 1]) {
          const mk = (onA, ic) => { const t = [0, 0, 0]; t[c3] = inn(c3, ic); if (onA) { t[a2] = inn(a2, sb); return V(a, sa, t); } t[a] = inn(a, sa); return V(a2, sb, t); };
          quad(mk(1, 0), mk(1, 1), mk(0, 1), mk(0, 0), a);
        }
      }
      for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) {
        const ss = [sx, sy, sz], t = [inn(0, sx), inn(1, sy), inn(2, sz)];
        tri(V(0, ss[0], t), V(1, ss[1], t), V(2, ss[2], t), 0);
      }
    }
    // 任意几何（经矩阵变换后追加）
    geo(k, g, m, c, keepUV, uvAdd) {
      const b = this._b(k);
      const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, idx = g.index;
      const nm = new THREE.Matrix3().getNormalMatrix(m);
      const v = new THREE.Vector3(), n = new THREE.Vector3();
      const cnt = idx ? idx.count : pa.count;
      for (let j = 0; j < cnt; j++) {
        const i = idx ? idx.getX(j) : j;
        v.fromBufferAttribute(pa, i).applyMatrix4(m);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        b.p.push(v.x, v.y, v.z); b.n.push(n.x, n.y, n.z); b.a.push(this.unit); b.v.push(this.var);
        if (keepUV && ua) b.u.push(ua.getX(i) + (uvAdd ? uvAdd[0] : 0), ua.getY(i) + (uvAdd ? uvAdd[1] : 0));
        else {
          const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
          if (ax >= ay && ax >= az) b.u.push(v.z, v.y); else if (ay >= az) b.u.push(v.x, v.z); else b.u.push(v.x, v.y);
        }
        b.c.push(c.r, c.g, c.b);
      }
    }
    toGeo(k) {
      const b = this.B.get(k); if (!b) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
      g.setAttribute('aUnit', new THREE.Float32BufferAttribute(b.a, 1));
      g.setAttribute('aVar', new THREE.Float32BufferAttribute(b.v, 1));
      this.B.delete(k);
      return g;
    }
    // 每个材质一个网格；inst = 矩阵数组时做成实例化网格（标准层叠到每一层）
    build(parent, opts = {}) {
      const out = [];
      for (const k of [...this.B.keys()]) {
        const g = this.toGeo(k); if (!g) continue;
        let mesh;
        if (opts.inst) {
          mesh = new THREE.InstancedMesh(g, matFor(k), opts.inst.length);
          opts.inst.forEach((m, i) => mesh.setMatrixAt(i, m));
          mesh.instanceMatrix.needsUpdate = true;
          g.setAttribute('aLitMask', new THREE.InstancedBufferAttribute(new Float32Array(opts.mask || opts.inst.map(() => 255)), 1));
          g.setAttribute('aLightSel', new THREE.InstancedBufferAttribute(new Float32Array(opts.sel || opts.inst.map(() => 0)), 1));
          mesh.frustumCulled = !!opts.bound; // r147 的实例化网格默认不剔除；包围球已经框住整栋楼
        } else mesh = new THREE.Mesh(g, matFor(k));
        if (opts.bound) g.boundingSphere = opts.bound.clone(); else g.computeBoundingSphere();
        const sh = shadowFor(k);
        mesh.castShadow = !!(sh & 1); mesh.receiveShadow = !!(sh & 2);
        if (k === 'iWallX') mesh.customDepthMaterial = pushDepth();
        mesh.matrixAutoUpdate = false; mesh.updateMatrix();
        parent.add(mesh); out.push(mesh);
      }
      return out;
    }
  }
  IN.Sink = Sink;

  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  function m4(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
    _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
    return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  }
  const GEO = {};
  const geo = (k, mk) => GEO[k] || (GEO[k] = mk());
  const CYL = () => geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 12));
  const SPH = () => geo('sph', () => new THREE.SphereGeometry(1, 10, 7));
  const TOR = () => geo('tor', () => new THREE.TorusGeometry(1, 0.32, 8, 18));
  const QCYL = () => geo('qcyl', () => new THREE.CylinderGeometry(1, 1, 1, 6, 1, true, 0, PI / 2));
  function tube(S, k, a, b, r, c) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    S.geo(k, CYL(), new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(r, len, r)), c);
  }

  // 圆角盒（棱角不锋利）：r = 倒角半径；模板几何按毫米取整缓存
  const RBC = new Map();
  function rb(S, k, x0, y0, z0, x1, y1, z1, c, r, seg = 2) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    if (w < 1e-3 || h < 1e-3 || d < 1e-3) return;
    const key = [w, h, d, r].map((v) => Math.round(v * 1000)).join(',') + ',' + seg;
    let g = RBC.get(key);
    if (!g) { g = H.roundedBox(w, h, d, r, seg); RBC.set(key, g); }
    // 用模板自己按面算好的 UV（米）：Sink 按每个顶点的法线重新投影的话，倒角那一圈会跳投影方向，布纹被挤成一条纯色带
    S.geo(k, g, m4((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), c, true);
  }
  // 家具腿：还是方腿，只在棱上倒一点点圆角（半径 = 腿宽的 1/4，最多 1cm）
  function legBox(S, k, x0, y0, z0, x1, y1, z1, c) { S.cbox(k, x0, y0, z0, x1, y1, z1, c, Math.min(0.01, (x1 - x0) / 4, (z1 - z0) / 4)); }
  // 回转体（轮廓 [半径, 高] 从下往上）
  const LTH = new Map();
  function lathe(key, pts, seg) {
    let g = LTH.get(key);
    if (!g) { g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg); LTH.set(key, g); }
    return g;
  }
  const arc = (P, cx, cy, rx, ry, a0, a1, n) => { for (let i = 1; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; P.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } };
  // 饮水机上倒扣的水桶：瓶口插进机器顶，肩部圆滑过渡，桶身 5 道窄窄的凹槽（加强筋，depth = 槽深），顶上（桶底）圆角。
  // 只在凹槽处取点（直的桶壁不用点）；hi = 封面那间的精细版，别的房间段数减半
  function jugGeo(depth, hi) {
    const P = [[0, 0], [0.028, 0], [0.03, 0.04]], R = 0.14, yb = 0.12, yt = 0.44, rt = 0.05, per = 0.064, hw = 0.14 * per;
    const ns = hi ? 10 : 5, ng = hi ? 10 : 4, seg = hi ? 32 : 16;
    for (let i = 1; i <= ns; i++) { const a = i / ns * PI / 2; P.push([0.03 + (R - 0.03) * Math.sin(a), 0.04 + (yb - 0.04) * (1 - Math.cos(a))]); }
    for (let k = 0; k < 5; k++) {
      const yc = yb + per * (k + 0.5);
      for (let j = 0; j <= ng; j++) { const t = -1 + 2 * j / ng; P.push([R - depth * (0.5 + 0.5 * Math.cos(t * PI)), yc + t * hw]); }
    }
    P.push([R, yt]);
    arc(P, R - rt, yt, rt, rt, 0, PI / 2, hi ? 8 : 4);
    P.push([0, yt + rt]);
    return lathe(`jug${depth},${seg}`, P, seg);
  }
  // 水杯：杯底圆角、下半截 6 圈防滑纹（depth = 纹深）、往上略微张开；杯口被盖子盖住
  function cupGeo(depth, hi) {
    const P = [[0, 0], [0.024, 0]], n = hi ? 72 : 30, seg = hi ? 28 : 14, rOf = (y) => 0.03 + 0.006 * (y / 0.11);
    arc(P, 0.024, 0.006, 0.006, 0.006, -PI / 2, 0, hi ? 5 : 3);
    const y1 = hi ? 0.11 : 0.072;
    for (let i = 1; i <= n; i++) { const y = 0.006 + (y1 - 0.006) * i / n; P.push([rOf(y) - (y < 0.072 ? depth * 0.5 * (1 - Math.cos((y - 0.006) / 0.011 * PI * 2)) : 0), y]); }
    if (!hi) P.push([rOf(0.11), 0.11]);
    P.push([0.03, 0.11], [0, 0.11]);
    return lathe(`cup${depth},${seg}`, P, seg);
  }
  // 杯盖：圆柱 + 圆角顶 + 一个小嘴
  function lidGeo(hi) {
    const P = [[0, 0], [0.039, 0], [0.039, 0.012]];
    arc(P, 0.031, 0.012, 0.008, 0.008, 0, PI / 2, hi ? 6 : 3);
    P.push([0.012, 0.02], [0.012, 0.027]);
    arc(P, 0.008, 0.027, 0.004, 0.004, 0, PI / 2, hi ? 3 : 2);
    P.push([0, 0.031]);
    return lathe('lid' + (hi ? 28 : 14), P, hi ? 28 : 14);
  }

  // 矩形 [u0,u1]x[v0,v1] 扣掉若干矩形洞，切成不重叠的小矩形
  function rectsMinus(u0, u1, v0, v1, holes) {
    const hs = holes.filter((h) => h.u1 > u0 && h.u0 < u1 && h.v1 > v0 && h.v0 < v1);
    const vs = [v0, v1];
    for (const h of hs) vs.push(H.clamp(h.v0, v0, v1), H.clamp(h.v1, v0, v1));
    vs.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < vs.length - 1; i++) {
      const a = vs[i], b = vs[i + 1]; if (b - a < 1e-4) continue;
      const mid = (a + b) / 2;
      const cuts = hs.filter((h) => h.v0 < mid && h.v1 > mid).map((h) => [Math.max(u0, h.u0), Math.min(u1, h.u1)]).sort((p, q) => p[0] - q[0]);
      let u = u0;
      for (const [c0, c1] of cuts) { if (c0 > u + 1e-4) out.push({ u0: u, u1: c0, v0: a, v1: b }); u = Math.max(u, c1); }
      if (u1 > u + 1e-4) out.push({ u0: u, u1, v0: a, v1: b });
    }
    // 竖向相邻、左右边一样的合并
    out.sort((p, q) => p.u0 - q.u0 || p.u1 - q.u1 || p.v0 - q.v0);
    const m = [];
    for (const r of out) {
      const l = m[m.length - 1];
      if (l && Math.abs(l.u0 - r.u0) < 1e-4 && Math.abs(l.u1 - r.u1) < 1e-4 && Math.abs(l.v1 - r.v0) < 1e-4) l.v1 = r.v1; else m.push(Object.assign({}, r));
    }
    return m;
  }

  // ---------- 空心外墙 ----------
  // o = { x0,x1,z0,z1 外皮, R 竖向圆角, t 外皮到内墙面, y0,y1, holes:{front,back,left,right}, k/c 外皮, ki/ci 内墙面 }
  // 正面 / 背面的 u 是 z，左右侧面的 u 是 x；d = 从外皮往里的深度
  const FACES = {
    front: { P: (o, u, v, d) => [o.x0 + d, v, u], n: [-1, 0, 0], ua: [0, 0, 1], rg: (o) => [o.z0, o.z1] },
    back: { P: (o, u, v, d) => [o.x1 - d, v, u], n: [1, 0, 0], ua: [0, 0, 1], rg: (o) => [o.z0, o.z1] },
    left: { P: (o, u, v, d) => [u, v, o.z0 + d], n: [0, 0, -1], ua: [1, 0, 0], rg: (o) => [o.x0, o.x1] },
    right: { P: (o, u, v, d) => [u, v, o.z1 - d], n: [0, 0, 1], ua: [1, 0, 0], rg: (o) => [o.x0, o.x1] },
  };
  // 外皮 UV 和原来那个实心圆角盒子（H.roundedBox）的规则一致，楼打开的那一下纹理不跳：
  // 正面 u = z - z0，背面 u = z1 - z，左侧 u = x1 - x，右侧 u = x - x0，v = y（标准层的楼层偏移由着色器按实例补上）
  const SHELL_UV = {
    front: (o, p) => [p[2] - o.z0, p[1] + (o.vOff || 0)], back: (o, p) => [o.z1 - p[2], p[1] + (o.vOff || 0)],
    left: (o, p) => [o.x1 - p[0], p[1] + (o.vOff || 0)], right: (o, p) => [p[0] - o.x0, p[1] + (o.vOff || 0)],
  };
  // 窗洞侧面在玻璃（门扇）那个深度一分为二：外面一段用外墙材质（会淋湿、窗台积雪），里面一段用室内墙面
  const GLASS_D = { res: 0.07, villa: 0.07, shopwin: 0.09, lobby: 0.09, bdoor: 0.15, gdoor: 0.05, sdoor: 0.05 };
  function shell(S, o) {
    const c = col(o.c), ci = col(o.ci), keep = S.unit;
    // o.zones[name] = [[u0, u1, 户号], ...]：内墙面按户分段（夜里跟着各户的灯亮）
    const zonesOf = (name) => (o.zones && o.zones[name]) || [[-1e9, 1e9, keep]];
    const zoneAt = (name, u) => { for (const z of zonesOf(name)) if (u >= z[0] && u <= z[1]) return z[2]; return keep; };
    for (const name in FACES) {
      const F = FACES[name], [a, b] = F.rg(o), holes = o.holes[name] || [], UV = SHELL_UV[name];
      const neg = [-F.n[0], -F.n[1], -F.n[2]], ua = F.ua, nua = [-ua[0], -ua[1], -ua[2]];
      S.unit = keep;
      for (const r of rectsMinus(a + o.R, b - o.R, o.y0, o.y1, holes)) {
        const P = [F.P(o, r.u0, r.v0, 0), F.P(o, r.u1, r.v0, 0), F.P(o, r.u1, r.v1, 0), F.P(o, r.u0, r.v1, 0)];
        S.quad(o.k, P[0], P[1], P[2], P[3], F.n, c, P.map((p) => UV(o, p)));
      }
      // 内皮两头各多伸 PUSH 进相邻外墙里（看不见）：阴影图里往墙里推过之后，墙角两片还能接上，不漏一条缝
      const kx = o.ki === 'iWall' ? 'iWallX' : o.ki, ext = kx === 'iWallX' ? PUSH : 0;
      for (const [z0, z1, un] of zonesOf(name)) {
        S.unit = un;
        for (const r of rectsMinus(Math.max(a + o.t - ext, z0), Math.min(b - o.t + ext, z1), o.y0, o.y1, holes)) S.quad(kx, F.P(o, r.u0, r.v0, o.t), F.P(o, r.u1, r.v0, o.t), F.P(o, r.u1, r.v1, o.t), F.P(o, r.u0, r.v1, o.t), neg, ci);
      }
      for (const h of holes) {
        const v0 = Math.max(h.v0, o.y0), v1 = Math.min(h.v1, o.y1);
        if (v1 <= v0) continue;
        const kind = h.w && h.w.kind, dg = Math.min(o.t, GLASS_D[kind] || 0.07);
        const isDoor = kind === 'gdoor' || kind === 'sdoor';
        const rev = (d0, d1, k, cc) => {
          if (h.v0 >= o.y0 && !isDoor) S.quad(k, F.P(o, h.u0, v0, d0), F.P(o, h.u1, v0, d0), F.P(o, h.u1, v0, d1), F.P(o, h.u0, v0, d1), [0, 1, 0], cc); // 门洞的底由门槛盖着，不出（免得和门槛打架）
          if (h.v1 <= o.y1) S.quad(k, F.P(o, h.u0, v1, d0), F.P(o, h.u1, v1, d0), F.P(o, h.u1, v1, d1), F.P(o, h.u0, v1, d1), [0, -1, 0], cc);
          S.quad(k, F.P(o, h.u0, v0, d0), F.P(o, h.u0, v1, d0), F.P(o, h.u0, v1, d1), F.P(o, h.u0, v0, d1), ua, cc);
          S.quad(k, F.P(o, h.u1, v0, d0), F.P(o, h.u1, v1, d0), F.P(o, h.u1, v1, d1), F.P(o, h.u1, v0, d1), nua, cc);
        };
        S.unit = keep; rev(0, dg, o.k, c);
        S.unit = zoneAt(name, (h.u0 + h.u1) / 2); rev(dg, o.t, o.ki, ci);
      }
    }
    // 内墙面的踢脚线（o.bb = 地面高度；门洞、楼梯井旁边断开）
    if (o.bb !== undefined) {
      const bc = col('#a59e93');
      for (const name in FACES) {
        const F = FACES[name], [a, b] = F.rg(o), ua = F.ua;
        const cuts = (o.holes[name] || []).filter((h) => h.v0 < o.bb + 0.1).map((h) => ({ u0: h.u0, u1: h.u1, v0: 0, v1: 1 }));
        for (const z of o.bbHoles || []) {
          // 楼梯井贴着这面外墙时，那一段没有地面
          const inner = name === 'front' ? o.x0 + o.t : name === 'back' ? o.x1 - o.t : name === 'left' ? o.z0 + o.t : o.z1 - o.t;
          const along = ua[0] ? [z.x0, z.x1] : [z.z0, z.z1], perp = ua[0] ? [z.z0, z.z1] : [z.x0, z.x1];
          if (inner > perp[0] - 0.05 && inner < perp[1] + 0.05) cuts.push({ u0: along[0], u1: along[1], v0: 0, v1: 1 });
        }
        for (const [z0, z1, un] of zonesOf(name)) {
          S.unit = un;
          for (const r of rectsMinus(Math.max(a + o.t, z0), Math.min(b - o.t, z1), 0, 1, cuts)) {
            const p0 = F.P(o, r.u0, o.bb, o.t), p1 = F.P(o, r.u1, o.bb + 0.09, o.t + 0.014);
            S.box('iDoor', Math.min(p0[0], p1[0]), o.bb, Math.min(p0[2], p1[2]), Math.max(p0[0], p1[0]), o.bb + 0.09, Math.max(p0[2], p1[2]), bc);
          }
        }
      }
    }
    S.unit = keep;
    if (o.R > 0.02) {
      const hgt = o.y1 - o.y0, R = o.R, ym = (o.y0 + o.y1) / 2;
      // 基础四分之一圆柱面朝 +z..+x（后右角），转 90° 的倍数得到其他角
      S.geo(o.k, QCYL(), m4(o.x1 - R, ym, o.z1 - R, 0, R, hgt, R), c);
      S.geo(o.k, QCYL(), m4(o.x1 - R, ym, o.z0 + R, PI / 2, R, hgt, R), c);
      S.geo(o.k, QCYL(), m4(o.x0 + R, ym, o.z0 + R, PI, R, hgt, R), c);
      S.geo(o.k, QCYL(), m4(o.x0 + R, ym, o.z1 - R, PI * 1.5, R, hgt, R), c);
    }
  }
  // 两圈外轮廓之间的水平小台（一楼底座比楼身凸出的那一圈）：a 外圈，b 内圈（同圆心）
  function ledge(S, k, c, a, b, y) {
    const C = col(c), up = [0, 1, 0];
    S.quad(k, [a.x0, y, a.z0 + a.R], [b.x0, y, a.z0 + a.R], [b.x0, y, a.z1 - a.R], [a.x0, y, a.z1 - a.R], up, C);
    S.quad(k, [b.x1, y, a.z0 + a.R], [a.x1, y, a.z0 + a.R], [a.x1, y, a.z1 - a.R], [b.x1, y, a.z1 - a.R], up, C);
    S.quad(k, [a.x0 + a.R, y, a.z0], [a.x1 - a.R, y, a.z0], [a.x1 - a.R, y, b.z0], [a.x0 + a.R, y, b.z0], up, C);
    S.quad(k, [a.x0 + a.R, y, b.z1], [a.x1 - a.R, y, b.z1], [a.x1 - a.R, y, a.z1], [a.x0 + a.R, y, a.z1], up, C);
    const corners = [[a.x1 - a.R, a.z1 - a.R, 0], [a.x1 - a.R, a.z0 + a.R, PI / 2], [a.x0 + a.R, a.z0 + a.R, PI], [a.x0 + a.R, a.z1 - a.R, PI * 1.5]];
    for (const [cx, cz, s0] of corners) {
      for (let i = 0; i < 6; i++) {
        const t0 = s0 + i / 6 * PI / 2, t1 = s0 + (i + 1) / 6 * PI / 2;
        S.quad(k, [cx + Math.sin(t0) * b.R, y, cz + Math.cos(t0) * b.R], [cx + Math.sin(t0) * a.R, y, cz + Math.cos(t0) * a.R],
          [cx + Math.sin(t1) * a.R, y, cz + Math.cos(t1) * a.R], [cx + Math.sin(t1) * b.R, y, cz + Math.cos(t1) * b.R], up, C);
      }
    }
  }

  // ---------- 墙（带门洞）----------
  // axis 'x'：墙面垂直于 x（沿 z 走），位于 x = at；axis 'z'：墙面垂直于 z（沿 x 走）。from..to 是沿墙方向的范围
  function wallBox(axis, at, th, s0, s1, y0, y1) {
    return axis === 'x' ? { x0: at - th / 2, x1: at + th / 2, z0: s0, z1: s1, y0, y1 } : { x0: s0, x1: s1, z0: at - th / 2, z1: at + th / 2, y0, y1 };
  }
  function wallSegs(w) {
    const segs = []; let a = w.from;
    const ops = (w.ops || []).filter((o) => o.b > w.from && o.a < w.to).sort((p, q) => p.a - q.a);
    for (const o of ops) { if (o.a > a) segs.push([a, o.a]); a = Math.max(a, o.b); }
    if (w.to > a) segs.push([a, w.to]);
    return { segs, ops };
  }
  // 墙两面加踢脚线；门洞两面加门套 —— 白墙白顶的屋里，靠这些深色线条看出墙角和门在哪
  // holes：楼板开洞的地方（楼梯井），那里没有地面，贴着洞口的墙面不加踢脚线
  function emitWalls(S, walls, holes = []) {
    for (const w of walls) {
      const { segs, ops } = wallSegs(w), C = col(w.c);
      const un = w.unit === undefined ? 7 : w.unit, uNeg = w.uNeg === undefined ? un : w.uNeg, uPos = w.uPos === undefined ? un : w.uPos;
      // 两面同一户就出一个盒子；不同户就分两次出，各面带各自的户号（夜里各亮各的）
      const posBit = w.axis === 'x' ? 2 : 32;
      const put = (b) => {
        if (uNeg === uPos) { S.unit = uNeg; S.box(w.k, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, C); return; }
        S.unit = uNeg; S.box(w.k, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, C, posBit);
        S.unit = uPos; S.box(w.k, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, C, 63 & ~posBit);
      };
      for (const [s0, s1] of segs) put(wallBox(w.axis, w.at, w.th, s0, s1, w.y0, w.y1));
      for (const o of ops) if (o.top < w.y1) put(wallBox(w.axis, w.at, w.th, Math.max(o.a, w.from), Math.min(o.b, w.to), o.top, w.y1));
      if (w.k !== 'iWall' || w.y1 < 1.5) continue;
      const unit = w.c !== PUBC, bc = col(unit ? '#7d6a55' : '#a59e93'), fc = col(unit ? '#a8825c' : '#c9c2b6');
      const th = w.th / 2;
      for (const sd of [-1, 1]) {
        S.unit = sd < 0 ? uNeg : uPos;
        const d0 = sd > 0 ? th : -th - 0.014, d1 = sd > 0 ? th + 0.014 : -th;
        const face = w.at + (sd > 0 ? th : -th);
        const cut = holes.filter((h) => (w.axis === 'x' ? face > h.x0 - 0.03 && face < h.x1 + 0.03 : face > h.z0 - 0.03 && face < h.z1 + 0.03))
          .map((h) => (w.axis === 'x' ? { u0: h.z0, u1: h.z1, v0: 0, v1: 1 } : { u0: h.x0, u1: h.x1, v0: 0, v1: 1 }));
        for (const [s0, s1] of segs) for (const r of rectsMinus(s0, s1, 0, 1, cut)) {
          if (w.axis === 'x') S.box('iDoor', w.at + d0, 0, r.u0, w.at + d1, 0.09, r.u1, bc);
          else S.box('iDoor', r.u0, 0, w.at + d0, r.u1, 0.09, w.at + d1, bc);
        }
        for (const o of ops) {
          if (o.top >= w.y1 || o.top > 2.45) continue;
          const a = Math.max(o.a, w.from), b = Math.min(o.b, w.to), f = 0.06, e0 = sd > 0 ? th : -th - 0.018, e1 = sd > 0 ? th + 0.018 : -th;
          const jamb = (u0, u1, y0, y1) => (w.axis === 'x' ? S.box('iDoor', w.at + e0, y0, u0, w.at + e1, y1, u1, fc) : S.box('iDoor', u0, y0, w.at + e0, u1, y1, w.at + e1, fc));
          jamb(a - f, a, 0, o.top + f); jamb(b, b + f, 0, o.top + f); jamb(a, b, o.top, o.top + f);
        }
      }
    }
    S.unit = -1;
  }
  function wallColliders(out, walls, yOff) {
    for (const w of walls) for (const [s0, s1] of wallSegs(w).segs) out.push(wallBox(w.axis, w.at, w.th, s0, s1, w.y0 + yOff, w.y1 + yOff));
  }
  // 地面铺装（朝上的四边形）
  function floorQuad(S, k, c, x0, x1, z0, z1, y) { S.quad(k, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], col(c)); }
  function lampAt(S, x, z, y, w = 0.5) { S.box('iLamp', x - w / 2, y - 0.03, z - w / 2, x + w / 2, y, z + w / 2, col(LAMPC)); }

  // ---------- 标签图集：门牌号、楼层号 ----------
  let LB = null;
  function labelAtlas() {
    if (LB) return LB;
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const x = c.getContext('2d');
    const font = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    const rr = (a, b, w, h, r) => { x.beginPath(); x.roundRect(a, b, w, h, r); };
    x.fillStyle = '#e8e4dc'; x.fillRect(0, 0, 2048, 1024);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let f = 1; f <= 16; f++) for (let k = 0; k < 9; k++) {
      const X0 = k * 128, Y0 = (f - 1) * 64;
      if (k < 8) {
        x.fillStyle = '#2f3b48'; rr(X0 + 3, Y0 + 3, 122, 58, 12); x.fill();
        x.strokeStyle = '#d8b25a'; x.lineWidth = 3; rr(X0 + 9, Y0 + 9, 110, 46, 8); x.stroke();
        x.fillStyle = '#f6efe0'; x.font = `bold 34px ${font}`; x.fillText(String(f * 100 + k + 1), X0 + 64, Y0 + 34);
      } else {
        x.fillStyle = '#2f8f83'; rr(X0 + 3, Y0 + 3, 122, 58, 14); x.fill();
        x.fillStyle = '#ffffff'; x.font = `bold 40px ${font}`; x.fillText(f + 'F', X0 + 64, Y0 + 34);
      }
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = H.maxAniso || 4;
    const m = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.5 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aCell;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_UV\nvUv = aCell.xy + uv * aCell.zw;\n#endif');
    };
    LB = { mat: m, cell: (f, k) => [k * 128 / 2048 + 0.0005, 1 - f * 64 / 1024 + 0.0005, 128 / 2048 - 0.001, 64 / 1024 - 0.001] };
    return LB;
  }
  // 一组标签做成一个实例化网格：list = [{x,y,z,ry,w,h,cell}]
  function labelMesh(list) {
    const A = labelAtlas();
    const g = new THREE.PlaneGeometry(1, 1);
    const cells = new Float32Array(list.length * 4);
    list.forEach((l, i) => cells.set(l.cell, i * 4));
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 4));
    const m = new THREE.InstancedMesh(g, A.mat, list.length);
    list.forEach((l, i) => m.setMatrixAt(i, m4(l.x, l.y, l.z, l.ry, l.w, l.h, 1)));
    m.receiveShadow = true;
    return m;
  }

  // ======================================================================
  // 公寓
  // ======================================================================
  // 封面那间客厅：出生点后面 3m（世界 z = +3，里程 K403+997）、路左侧那栋公寓一楼，客厅占着这个位置的那一户
  const HERO_Z = 3;
  function heroLz(r) {
    if (r.type !== 'apt' || !r.ch || r.ch.idx !== 0 || r.ox > 0) return null;
    const lz = (HERO_Z - r.oz) * (Math.cos(r.ry) >= 0 ? 1 : -1); // ry 只有 0 / π：世界 z = oz ± 局部 z
    return Math.abs(lz) < r.W / 2 - 0.3 ? lz : null;
  }
  function layoutApt(r) {
    const D = r.D, W = r.W, F = r.F;
    const L = { r, D, W, F };
    L.Y = (f) => (f <= 0 ? 0.02 : r.gH + (f - 1) * r.fH + 0.12);
    L.rise = (f) => L.Y(f + 1) - L.Y(f);
    L.z0 = -W / 2 + T; L.z1 = W / 2 - T;
    L.xc = D - T - CORW - PW / 2;      // 走廊墙中线
    // 走廊墙一直通到两头山墙：最后一扇侧窗的边常常正好顶到它，碰上了就把墙往后让到窗边外 3cm（走廊窄几厘米）
    for (const w of r.wins) if ((w.face === 'left' || w.face === 'right') && Math.abs(w.x - L.xc) < w.w / 2 + PW / 2 + 0.03) L.xc = Math.max(L.xc, w.x + w.w / 2 + 0.03 + PW / 2);
    L.xu = L.xc - PW / 2;              // 户的后边界
    const bz = (k) => r.zb0 + k * r.bw;
    const e = r.entrance, nb = r.nb;
    // 楼梯放在门厅哪一侧：让两翼的开间数尽量一样
    const right = Math.abs(e - (nb - e - 2)) <= Math.abs((e - 1) - (nb - e - 1));
    const s = right ? e + 1 : e - 1;
    L.side = right ? 1 : -1;
    const pas = { z0: bz(e), z1: bz(e + 1) }, stz = { z0: bz(s), z1: bz(s + 1) };
    const lo = Math.min(e, s), hi = Math.max(e, s);
    const zoneAt = (k) => (k === e ? pas : stz);
    if (lo === 0) zoneAt(lo).z0 = L.z0;       // 翼太窄（只剩 0.7m 的端头）就并进核心区
    if (hi === nb - 1) zoneAt(hi).z1 = L.z1;
    const zin0 = (z) => z + (z > L.z0 + 0.01 ? PW / 2 : 0), zin1 = (z) => z - (z < L.z1 - 0.01 ? PW / 2 : 0);
    L.pas = { z0: pas.z0, z1: pas.z1, iz0: zin0(pas.z0), iz1: zin1(pas.z1) };
    L.psb = right ? pas.z1 : pas.z0; // 门厅和楼梯间的分界
    // 楼梯：两跑，梯段沿 x 走；第一跑贴着门厅那侧往里上，第二跑从休息平台折回来上到下一层的楼层平台
    let sz0 = zin0(stz.z0), sz1 = zin1(stz.z1);
    if (lo === 0 && zoneAt(lo) === stz) sz0 = zin0(bz(0));
    if (hi === nb - 1 && zoneAt(hi) === stz) sz1 = zin1(bz(nb));
    const zm = (sz0 + sz1) / 2;
    const xa = T + LAND, xb = xa + RUN, xm1 = xb + LAND2;
    L.st = { z0: stz.z0, z1: stz.z1, iz0: sz0, iz1: sz1, zm, xa, xb, xm1, xs: xm1 + 0.06 };
    // 楼梯和开间边界之间多出来的一条（楼梯间并进端头时才有）：[z0, z1] 这段要补地面、补一道墙
    L.st.strips = [];
    if (sz0 > zin0(stz.z0) + 0.05) L.st.strips.push({ z0: stz.z0, z1: sz0 - PW / 2, wall: sz0 - PW / 2 });
    if (sz1 < zin1(stz.z1) - 0.05) L.st.strips.push({ z0: sz1 + PW / 2, z1: stz.z1, wall: sz1 + PW / 2 });
    const A = [sz0, zm - 0.06], B = [zm + 0.06, sz1];
    L.st.laneA = right ? A : B; L.st.laneB = right ? B : A;
    // 电梯井：在楼梯间那个开间的最里面，门朝走廊
    const szc = (sz0 + sz1) / 2;
    L.sh = { x1: L.xu, x0: L.xu - 1.9, z0: szc - 0.95, z1: szc + 0.95, zc: szc };
    L.cab = { x0: L.sh.x0 + 0.08, x1: L.sh.x1 - 0.08, z0: L.sh.z0 + 0.08, z1: L.sh.z1 - 0.08, h: 2.45 };
    // 两翼分户：从外往里每户 1~2 个开间
    const ub = r.bw < 3.4 ? 2 : 1;
    L.units = [];
    const mkWing = (bays, core) => {
      const groups = [];
      for (let i = 0; i < bays.length; i += ub) groups.push(bays.slice(i, i + ub));
      if (groups.length > 1 && groups[groups.length - 1].length < ub) { const g = groups.pop(); groups[groups.length - 1].push(...g); }
      for (const g of groups) {
        const ks = g.slice().sort((p, q) => p - q);
        const z0 = ks[0] === 0 ? L.z0 : bz(ks[0]), z1 = ks[ks.length - 1] === nb - 1 ? L.z1 : bz(ks[ks.length - 1] + 1);
        const inner = []; for (let i = 1; i < ks.length; i++) inner.push(bz(ks[i]));
        L.units.push({ z0, z1, core, inner });
      }
    };
    const lw = []; for (let k = 0; k < lo; k++) lw.push(k);
    const rw = []; for (let k = nb - 1; k > hi; k--) rw.push(k);
    mkWing(lw, 1); mkWing(rw, -1);
    L.units.sort((p, q) => p.z0 - q.z0);
    L.units.forEach((u, i) => { u.no = i + 1; u.wallC = UNITC[(r.seed + i) % UNITC.length]; unitPlan(L, u, zin0(u.z0), zin1(u.z1)); });
    // 封面那间（只算一楼）：这次的细化在它里面满效果，别的房间减半
    const hz = heroLz(r);
    L.hero = hz === null ? null : L.units.find((u) => hz > u.living.z0 && hz < u.living.z1) || null;
    const zs = new Set();
    for (const z of [...L.units.flatMap((u) => [u.z0, u.z1]), pas.z0, pas.z1, stz.z0, stz.z1]) if (z > L.z0 + 0.01 && z < L.z1 - 0.01) zs.add(+z.toFixed(4));
    L.bounds = [...zs].sort((p, q) => p - q);
    return L;
  }

  // 户型：前面客厅（宽的户再隔出一间卧室），后面玄关 + 卧室 + 卫生间；入户门开在走廊上
  // 离入户门最近的是卫生间（小），旁边那间卧室把省下的进深拿走
  function unitPlan(L, u, z0, z1) {
    const xa = T, xb = L.xu;
    const FD = H.clamp(Math.round((xb - xa) * 0.52 * 10) / 10, 3.6, 5.6);
    let xf = xa + FD;
    // 这道墙一直通到山墙内皮，侧窗的位置是另算的：碰上了就挪到窗前那段墙垛上（客厅不能小于 3.3m，不行就往后挪）
    for (let it = 0; it < 4; it++) {
      const hit = L.r.wins.find((w) => (w.face === 'left' || w.face === 'right') && xf + IW / 2 > w.x - w.w / 2 - 0.1 && xf - IW / 2 < w.x + w.w / 2 + 0.1);
      if (!hit) break;
      const fwd = hit.x - hit.w / 2 - 0.1 - IW / 2, bwd = hit.x + hit.w / 2 + 0.1 + IW / 2;
      if (fwd - xa >= 3.3) xf = fwd; else if (xb - bwd >= 4.3) xf = bwd; else break;
    }
    // 卫生间进深最少 2m：马桶和洗手台面对面摆，中间还要留出能走进淋浴间的过道
    const xm = xb - H.clamp((xb - xf) * 0.36, 2.0, 2.4);
    const hw = 1.3;
    const h0 = u.core > 0 ? z1 - hw : z0, h1 = h0 + hw;
    const hz = u.core > 0 ? h0 : h1;   // 玄关和卧室、卫生间之间的墙
    const b0 = u.core > 0 ? z0 : h1, b1 = u.core > 0 ? h0 : z1;
    u.dz = (h0 + h1) / 2;
    let zs = null;
    if (u.inner.length) {
      zs = u.core > 0 ? u.inner[0] : u.inner[u.inner.length - 1];
      if (Math.abs(zs - (u.core > 0 ? z0 : z1)) < 2.4 || Math.abs(zs - (u.core > 0 ? z1 : z0)) < 2.6) zs = null;
    }
    const rooms = [];
    if (zs !== null) {
      rooms.push({ name: '卧室', x0: xa, x1: xf, z0: u.core > 0 ? z0 : zs, z1: u.core > 0 ? zs : z1, k: 'iWood' });
      rooms.push({ name: '客厅', x0: xa, x1: xf, z0: u.core > 0 ? zs : z0, z1: u.core > 0 ? z1 : zs, k: 'iWood' });
    } else rooms.push({ name: '客厅', x0: xa, x1: xf, z0, z1, k: 'iWood' });
    rooms.push({ name: '玄关', x0: xf, x1: L.xc, z0: u.core > 0 ? hz : z0, z1: u.core > 0 ? z1 : hz, k: 'iWood' });
    rooms.push({ name: '卧室', x0: xf, x1: xm, z0: b0, z1: b1, k: 'iWood' });
    rooms.push({ name: '卫生间', x0: xm, x1: xb, z0: b0, z1: b1, k: 'iTile', c: '#dfe8ec' });
    u.rooms = rooms;
    // 卫生间过道中线（离 xm 墙的距离）：马桶靠 xm 那面墙（深 0.68），洗手台靠走廊那面墙（深 0.45）
    const bathPc = (IW / 2 + 0.68 + (xb - xm) - 0.45) / 2;
    u.g = { xa, xb, xf, xm, hz, b0, b1, zs, z0, z1, bathPc }; // 摆家具用
    u.rec = L.r;
    u.living = rooms.find((r) => r.name === '客厅');
    u.livOuter = u.core > 0 ? -1 : 1; // 客厅远离核心筒的那一侧（-1 = 小 z）
    u.walls = (ceil) => {
      const out = [];
      const w = (axis, at, from, to, th, ops) => out.push({ axis, at, from, to, th, ops: ops || [], c: u.wallC, k: 'iWall', y0: -0.01, y1: ceil, unit: u.no - 1 });
      w('x', xf, z0, z1, IW, [{ a: h0, b: h1, top: 2.3 }]);
      // 后卧室的门挪到靠卫生间那头，另一头留给床
      w('z', hz, xf, xb, IW, [{ a: xm - 0.95, b: xm - 0.15, top: 2.1 }, { a: Math.max(xm + 0.1, xm + bathPc - 0.38), b: Math.min(xb - 0.04, xm + bathPc + 0.38), top: 2.1 }]);
      w('x', xm, b0, b1, IW);
      if (zs !== null) w('z', zs, xa, xf, IW, [{ a: xf - 1.2, b: xf - 0.35, top: 2.1 }]);
      return out;
    };
  }

  // 一层的墙（ceil = 这层天花板离地面的高度）
  function aptWalls(L, ceil, kind) {
    const out = [], st = L.st, sh = L.sh;
    const w = (axis, at, from, to, th, ops, c, k, y1, uNeg, uPos) => out.push({ axis, at, from, to, th, ops: ops || [], c: c || PUBC, k: k || 'iWall', y0: -0.01, y1: y1 === undefined ? ceil : y1, uNeg, uPos });
    const ops = [{ a: L.pas.iz0, b: L.pas.iz1, top: ceil + 1 }, { a: sh.zc - 0.5, b: sh.zc + 0.5, top: 2.15 }];
    for (const u of L.units) ops.push({ a: u.dz - 0.45, b: u.dz + 0.45, top: 2.1 });
    // 走廊墙按户分段：靠户那面属于这户，靠走廊那面是公共区
    const cuts = [L.z0, L.z1];
    for (const u of L.units) cuts.push(u.z0, u.z1);
    const zs = [...new Set(cuts.map((z) => +z.toFixed(4)))].sort((p, q) => p - q);
    for (let i = 0; i < zs.length - 1; i++) {
      const a = zs[i], b = zs[i + 1], u = L.units.find((v) => v.z0 < (a + b) / 2 && v.z1 > (a + b) / 2);
      w('x', L.xc, a, b, PW, ops, null, null, undefined, u ? u.no - 1 : 7, 7);
    }
    const unitAt = (z, side) => { const u = L.units.find((v) => Math.abs((side < 0 ? v.z1 : v.z0) - z) < 1e-3); return u ? u.no - 1 : 7; };
    for (const z of L.bounds) {
      if (Math.abs(z - L.psb) < 1e-3) w('z', z, st.xa, st.xs + 0.06, PW);
      else w('z', z, T, L.xu, PW, null, null, null, undefined, unitAt(z, -1), unitAt(z, 1));
    }
    for (const sp of st.strips) w('z', sp.wall, st.xa, st.xs + 0.06, PW);
    w('x', st.xs, st.iz0, st.iz1, 0.12);
    // 电梯井两侧和开间墙之间的缝比人窄（< 0.7m）就直接砌死，免得人挤进去卡墙
    for (const [g0, g1] of [[st.iz0, sh.z0 - 0.12], [sh.z1 + 0.12, st.iz1]]) if (g1 - g0 > 0.005 && g1 - g0 < 0.7) w('z', (g0 + g1) / 2, sh.x0 - 0.12, sh.x1, g1 - g0);
    w('x', sh.x0 - 0.06, sh.z0 - 0.12, sh.z1 + 0.12, 0.12);
    w('z', sh.z0 - 0.06, sh.x0 - 0.12, sh.x1, 0.12);
    w('z', sh.z1 + 0.06, sh.x0 - 0.12, sh.x1, 0.12);
    for (const u of L.units) out.push(...u.walls(ceil));
    if (kind === 'ground') w('x', st.xa, st.laneB[0], st.laneB[1], 0.1);  // 一楼第二跑下面封起来
    if (kind === 'top') {                                                 // 顶层：楼梯口加栏板，别掉下去
      w('x', st.xa + 0.04, st.laneA[0], st.laneA[1], 0.08, null, '#ffffff', 'iWall', 1.05);
      w('z', st.zm, st.xa, st.xb, 0.12, null, PUBC, 'iWall', 1.05);
    }
    return out;
  }

  // 按楼层取窗洞
  function holesFrom(r, pred, yOff, doorFloor) {
    const out = { front: [], back: [], left: [], right: [] };
    for (const w of r.wins) {
      if (!pred(w)) continue;
      const u = (w.face === 'front' || w.face === 'back') ? w.z : w.x;
      let v0 = w.y - w.h / 2 - yOff;
      const v1 = w.y + w.h / 2 - yOff;
      if (w.kind === 'gdoor' || w.kind === 'sdoor') v0 = doorFloor;
      out[w.face].push({ u0: u - w.w / 2, u1: u + w.w / 2, v0, v1, w });
    }
    return out;
  }
  function glassFor(S, o, holes, kinds, frost) {
    const keep = S.unit;
    for (const name in holes) for (const h of holes[name]) {
      if (!kinds.includes(h.w.kind)) continue;
      const F = FACES[name], k = frost && frost(name, h) ? 'iFrost' : 'iGlass';
      S.unit = -1;
      S.quad(k, F.P(o, h.u0, h.v0, 0.06), F.P(o, h.u1, h.v0, 0.06), F.P(o, h.u1, h.v1, 0.06), F.P(o, h.u0, h.v1, 0.06), F.n, WHITE);
    }
    S.unit = keep;
  }

  // ---------- 客厅：沙发、茶几、电视柜和电视、饮水机，外加三款装饰灯（每层每户随机显示一款） ----------
  const SOFA = ['#5d7a8c', '#8a6b5a', '#6f8a6a', '#b07a5a', '#7a6f96', '#c9a77a', '#4f5b66', '#a05a5a'];
  const WOODS = ['#8a5a3c', '#b98a5a', '#6b4a32', '#d9c3a0', '#f2efe8'];
  // 这个房间正面墙上阳台推拉门能推开的那半扇（z 范围）；没有就是 null。摆家具时要给它留出走道
  function balDoor(r, z0, z1) {
    const w = r.wins.find((w) => w.kind === 'bdoor' && w.face === 'front' && w.z > z0 && w.z < z1);
    return w ? [w.z, w.z + w.w / 2 - 0.065] : null;
  }
  // hero = 封面那间：倒角、筋纹、屏幕亮度满效果，按钮做成圆的；别的房间这些效果减半、按钮保持方块
  function livingRoom(S, L, u, ceil, out, hero = false) {
    const rm = u.living, rng = H.rng(L.r.seed * 131 + u.no * 17), q = hero ? 1 : 0.5;
    const rbL = (...a) => rb(...a, hero ? 2 : 1); // 别的房间倒角只分 1 段（每层楼都实例化一份，省面数）
    const zi0 = rm.z0 + 0.07, zi1 = rm.z1 - 0.07, xi0 = T + 0.02, xi1 = rm.x1 - 0.06;
    const W = zi1 - zi0;
    // 沙发靠远离核心筒那面侧墙，电视柜靠对面；都放在靠窗的前半间（后面有门洞）
    const zw = u.livOuter < 0 ? zi0 : zi1, zt = u.livOuter < 0 ? zi1 : zi0, sd = -u.livOuter;
    const zr = (base, dir, a, b) => [Math.min(base + dir * a, base + dir * b), Math.max(base + dir * a, base + dir * b)];
    const len = H.clamp(xi1 - xi0 - 1.9, 1.3, 2.1), xs0 = xi0 + 0.6, xs1 = xs0 + len, xm = (xs0 + xs1) / 2;
    const fab = col(rng.pick(SOFA)), fab2 = fab.clone().offsetHSL(0, -0.04, 0.07), wood = col(rng.pick(WOODS)), dark = col('#2a2d31');
    // 沙发：底座、靠背、扶手、坐垫、靠垫、小腿；布料纹理在材质里，块块都倒圆角（软垫圆一些）
    const rs = 0.05 * q, rp = 0.07 * q;
    let [a0, a1] = zr(zw, sd, 0.02, 0.86);
    rbL(S, 'iFabric', xs0, 0.07, a0, xs1, 0.4, a1, fab, rs);
    for (const [lx, lz] of [[xs0 + 0.06, a0 + 0.06], [xs1 - 0.1, a0 + 0.06], [xs0 + 0.06, a1 - 0.1], [xs1 - 0.1, a1 - 0.1]]) legBox(S, 'iDoor', lx, 0, lz, lx + 0.04, 0.08, lz + 0.04, dark);
    const [b0, b1] = zr(zw, sd, 0.02, 0.24);
    rbL(S, 'iFabric', xs0, 0.36, b0, xs1, 0.86, b1, fab, rp);
    rbL(S, 'iFabric', xs0, 0.36, a0, xs0 + 0.17, 0.64, a1, fab, rs); rbL(S, 'iFabric', xs1 - 0.17, 0.36, a0, xs1, 0.64, a1, fab, rs);
    const [c0, c1] = zr(zw, sd, 0.24, 0.84), [d0, d1] = zr(zw, sd, 0.2, 0.38), hm = (xs0 + xs1) / 2;
    rbL(S, 'iFabric', xs0 + 0.18, 0.37, c0, hm - 0.005, 0.52, c1, fab2, rs); rbL(S, 'iFabric', hm + 0.005, 0.37, c0, xs1 - 0.18, 0.52, c1, fab2, rs);
    rbL(S, 'iFabric', xs0 + 0.19, 0.5, d0, hm - 0.01, 0.82, d1, fab2, rp); rbL(S, 'iFabric', hm + 0.01, 0.5, d0, xs1 - 0.19, 0.82, d1, fab2, rp);
    // 坐面那一片能跳上去站（0.52），靠背那一条照样挡人；两块之间隔 1.2cm（layoutcheck 查重叠用整条记录）
    const [p0, p1] = zr(zw, sd, 0.02, 0.24), [q0, q1] = zr(zw, sd, 0.252, 0.86);
    out.push({ x0: xs0, x1: xs1, z0: a0, z1: a1, y0: 0, y1: 0.9, parts: [{ x0: xs0, x1: xs1, z0: p0, z1: p1 }, { x0: xs0, x1: xs1, z0: q0, z1: q1, top: 0.52 }] });
    // 电视柜 + 电视（挂在柜子上方的墙前）
    const tl = Math.min(1.7, len), tx0 = xm - tl / 2, tx1 = xm + tl / 2;
    const [e0, e1] = zr(zt, -sd, 0.02, 0.44);
    S.cbox('iDoor', tx0, 0.08, e0, tx1, 0.5, e1, wood, 0.012);
    for (const lx of [tx0 + 0.05, tx1 - 0.09]) legBox(S, 'iMetal', lx, 0, e0 + 0.05, lx + 0.04, 0.08, e1 - 0.05, dark);
    const front = sd < 0 ? e1 : e0, fdir = sd < 0 ? 1 : -1;  // 柜子朝沙发那一面
    for (const k of [1, 2]) S.box('iDoor', tx0 + (tx1 - tx0) * k / 3 - 0.006, 0.12, Math.min(front, front + fdir * 0.006), tx0 + (tx1 - tx0) * k / 3 + 0.006, 0.46, Math.max(front, front + fdir * 0.006), dark);
    // 电视：圆角机身 + 屏幕放着"四零三新闻"（UV 让字从沙发那边看是正的）
    const [g0, g1] = zr(zt, -sd, 0.04, 0.09);
    rbL(S, 'iMetal', xm - 0.62, 0.66, g0, xm + 0.62, 1.37, g1, col('#16191d'), 0.018 * q);
    const scr = sd < 0 ? g1 + 0.002 : g0 - 0.002;
    const tuv = fdir > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[1, 0], [0, 0], [0, 1], [1, 1]];
    S.quad(hero ? 'iTVH' : 'iTV', [xm - 0.58, 0.7, scr], [xm + 0.58, 0.7, scr], [xm + 0.58, 1.33, scr], [xm - 0.58, 1.33, scr], [0, 0, fdir], WHITE, tuv);
    rbL(S, 'iMetal', xm - 0.08, 0.5, Math.min(g0, g1) - 0.02, xm + 0.08, 0.68, Math.max(g0, g1) + 0.02, dark, 0.012 * q);
    out.push({ x0: tx0, x1: tx1, z0: e0, z1: e1, y0: 0, y1: 1.4 });
    // 茶几：在沙发和电视柜中间，贴着一边放（离家具 0.3m），另一边留至少 0.75m 的走道——
    // 窗前那条带被沙发挡着，从屋里去窗边、去阳台只能走这条道，所以走道放在阳台门能推开那半扇那边
    // t = 从沙发那面墙往电视那面墙量；A：茶几贴沙发，走道在电视那边；B：茶几贴电视，走道在沙发那边。
    // 走道和阳台门那半扇要重叠出一个人身宽（need）；茶几宽 0.35–0.6，取两种摆法里能放下的最宽的
    // 水杯：一圈圈防滑纹的杯身 + 红色杯盖
    const cup = (x, y, z) => { S.geo('iBottle', cupGeo(0.0024 * q, hero), m4(x, y, z), WHITE); S.geo('iGoods', lidGeo(hero), m4(x, y + 0.108, z), col('#d8322a')); };
    const gap = W - 0.86 - 0.44;
    const dr = balDoor(L.r, rm.z0, rm.z1), dt = dr && [(dr[0] - zw) * sd, (dr[1] - zw) * sd].sort((p, q) => p - q);
    const need = Math.min(0.68, dt ? dt[1] - dt[0] : 1);
    let tw = -1, tPos = 0;
    for (const side of [0, 1]) {
      let w = Math.min(0.6, gap - 1.05);
      if (dt && side === 0) w = Math.min(w, Math.min(W - 0.44, dt[1]) - Math.max(dt[0], 0) - need >= 0 ? Math.min(W - 0.44, dt[1]) - need - 1.16 : -1);
      if (dt && side === 1) w = Math.min(w, Math.min(dt[1], W) - Math.max(0.86, dt[0]) >= need ? W - 0.74 - Math.max(0.86, dt[0]) - need : -1);
      if (w > tw) { tw = w; tPos = side === 0 ? 1.16 : W - 0.74 - w; }
    }
    if (tw >= 0.35) {
      const zc = zw + sd * (tPos + tw / 2);
      S.cbox('iDoor', xm - 0.55, 0.38, zc - tw / 2, xm + 0.55, 0.42, zc + tw / 2, wood, 0.01);
      S.cbox('iDoor', xm - 0.5, 0.12, zc - tw / 2 + 0.04, xm + 0.5, 0.14, zc + tw / 2 - 0.04, wood, 0.006);
      for (const [lx, lz] of [[-0.5, -tw / 2 + 0.04], [0.46, -tw / 2 + 0.04], [-0.5, tw / 2 - 0.08], [0.46, tw / 2 - 0.08]]) legBox(S, 'iDoor', xm + lx, 0, zc + lz, xm + lx + 0.04, 0.38, zc + lz + 0.04, wood);
      cup(xm + 0.25, 0.42, zc);                                                               // 茶几上一个带红盖的水杯
      S.cbox('iGoods', xm - 0.3, 0.42, zc - 0.12, xm - 0.05, 0.45, zc + 0.08, col(rng.pick(['#e85d4a', '#3b6fb6', '#f2a33a'])), 0.005);
      out.push({ x0: xm - 0.55, x1: xm + 0.55, z0: zc - tw / 2, z1: zc + tw / 2, y0: 0, y1: 0.45, top: 0.42 });
    } else {
      // 客厅太窄放不下茶几：沙发靠里那头的墙角放一张小边几
      const [k0, k1] = zr(zw, sd, 0.06, 0.5), kx0 = xs1 + 0.06, kx1 = kx0 + 0.44;
      if (kx1 < xi1 - 1.0) {
        S.cbox('iDoor', kx0, 0.5, k0, kx1, 0.54, k1, wood, 0.01);
        S.geo('iDoor', CYL(), m4((kx0 + kx1) / 2, 0.25, (k0 + k1) / 2, 0, 0.03, 0.5, 0.03), wood);
        S.geo('iDoor', CYL(), m4((kx0 + kx1) / 2, 0.01, (k0 + k1) / 2, 0, 0.16, 0.02, 0.16), wood);
        cup((kx0 + kx1) / 2 + 0.08, 0.54, (k0 + k1) / 2);
        out.push({ x0: kx0, x1: kx1, z0: k0, z1: k1, y0: 0, y1: 0.55, top: 0.54 });
      }
    }
    // 饮水机：靠电视那面墙、窗边的角落。下柜 + 上机身（控制面板、两个按钮），按钮下面挖一个放水杯的凹槽（接水盘、两个出水嘴）；
    // 机身倒圆角，上面倒扣一桶带加强筋的水
    const [h0, h1] = zr(zt, -sd, 0.04, 0.38), wx0 = xi0 + 0.06, wx1 = wx0 + 0.34, wz = (h0 + h1) / 2;
    const bodyC = col('#f2f3f1'), rw = 0.03 * q, chrome = col('#d7dadd');
    rbL(S, 'iGoods', wx0, 0, h0, wx1, 0.38, h1, bodyC, rw);                                  // 下柜
    rbL(S, 'iGoods', wx0, 0.6, h0, wx1, 0.96, h1, bodyC, rw);                                // 上机身
    rbL(S, 'iGoods', wx0, 0.34, h0, wx1 - 0.13, 0.64, h1, bodyC, rw * 0.5);                  // 凹槽后壁
    rbL(S, 'iGoods', wx1 - 0.16, 0.34, h0, wx1, 0.64, h0 + 0.045, bodyC, rw * 0.5);          // 凹槽两侧
    rbL(S, 'iGoods', wx1 - 0.16, 0.34, h1 - 0.045, wx1, 0.64, h1, bodyC, rw * 0.5);
    S.box('iGoods', wx1 - 0.132, 0.38, h0 + 0.045, wx1 - 0.128, 0.6, h1 - 0.045, col('#c6cbd0')); // 凹槽里衬（深一点，看得出是个槽）
    rbL(S, 'iMetal', wx1 - 0.125, 0.38, h0 + 0.05, wx1 - 0.008, 0.396, h1 - 0.05, col('#9aa1a8'), 0.004); // 接水盘
    for (let k = -2; k <= 2; k++) S.box('iMetal', wx1 - 0.115, 0.396, wz + k * 0.04 - 0.004, wx1 - 0.018, 0.398, wz + k * 0.04 + 0.004, col('#5d646b'));
    for (const dzz of [-0.05, 0.05]) S.geo('iMetal', CYL(), m4(wx1 - 0.07, 0.58, wz + dzz, 0, 0.009, 0.04, 0.009), chrome); // 出水嘴
    rbL(S, 'iGoods', wx1 - 0.004, 0.61, wz - 0.1, wx1 + 0.008, 0.8, wz + 0.1, col('#c9ced3'), 0.005 * q); // 控制面板
    if (hero) {
      // 圆按钮：扁圆的钮头 + 一圈浅色底座
      for (const [dzz, c] of [[-0.05, '#d23b2e'], [0.05, '#2f6fb5']]) {
        S.geo('iMetal', CYL(), m4(wx1 + 0.009, 0.64, wz + dzz, 0, 0.026, 0.006, 0.026, 0, PI / 2), chrome);
        S.geo('iGoods', SPH(), m4(wx1 + 0.012, 0.64, wz + dzz, 0, 0.012, 0.02, 0.02), col(c));
      }
    } else {
      S.box('iGoods', wx1 - 0.02, 0.62, wz - 0.07, wx1 + 0.04, 0.66, wz - 0.03, col('#d23b2e'));
      S.box('iGoods', wx1 - 0.02, 0.62, wz + 0.03, wx1 + 0.04, 0.66, wz + 0.07, col('#2f6fb5'));
    }
    rbL(S, 'iGoods', wx0 + 0.07, 0.95, h0 + 0.07, wx1 - 0.07, 0.985, h1 - 0.07, bodyC, 0.012);  // 水桶座
    S.geo('iBottle', jugGeo(0.007 * q, hero), m4((wx0 + wx1) / 2, 0.95, wz), WHITE);
    out.push({ x0: wx0, x1: wx1 + 0.04, z0: h0, z1: h1, y0: 0, y1: 1.45 });
    // 三款装饰灯
    const cx = (rm.x0 + rm.x1) / 2, cz = (rm.z0 + rm.z1) / 2, gold = col(rng.pick(['#d8b25a', '#c9ced3', '#2a2d31'])), warm = col('#fff1d6');
    const cw = 0.32, cy0 = ceil - 0.14;
    S.var = 1; // 灯带：一圈吊顶灯槽，内沿一条暖光
    S.box('iCeil', xi0, cy0, zi0, xi1, ceil, zi0 + cw, WHITE); S.box('iCeil', xi0, cy0, zi1 - cw, xi1, ceil, zi1, WHITE);
    S.box('iCeil', xi0, cy0, zi0 + cw, xi0 + cw, ceil, zi1 - cw, WHITE); S.box('iCeil', xi1 - cw, cy0, zi0 + cw, xi1, ceil, zi1 - cw, WHITE);
    S.box('iLamp', xi0 + cw, cy0 + 0.02, zi0 + cw, xi1 - cw, cy0 + 0.05, zi0 + cw + 0.015, warm); S.box('iLamp', xi0 + cw, cy0 + 0.02, zi1 - cw - 0.015, xi1 - cw, cy0 + 0.05, zi1 - cw, warm);
    S.box('iLamp', xi0 + cw, cy0 + 0.02, zi0 + cw, xi0 + cw + 0.015, cy0 + 0.05, zi1 - cw, warm); S.box('iLamp', xi1 - cw - 0.015, cy0 + 0.02, zi0 + cw, xi1 - cw, cy0 + 0.05, zi1 - cw, warm);
    S.var = 2; // 吸顶灯：圆灯罩 + 一圈金属边
    S.geo('iLamp', CYL(), m4(cx, ceil - 0.06, cz, 0, 0.36, 0.08, 0.36), warm);
    S.geo('iDeco', CYL(), m4(cx, ceil - 0.012, cz, 0, 0.39, 0.024, 0.39), gold);
    S.var = 3; // 吊灯：吊杆 + 灯头 + 五个小灯罩
    const hy = ceil - 0.55;
    S.geo('iDeco', CYL(), m4(cx, ceil - 0.02, cz, 0, 0.08, 0.04, 0.08), gold);
    S.geo('iDeco', CYL(), m4(cx, (ceil + hy) / 2, cz, 0, 0.012, ceil - hy, 0.012), gold);
    S.geo('iDeco', SPH(), m4(cx, hy, cz, 0, 0.06, 0.06, 0.06), gold);
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * PI * 2, ax = cx + Math.cos(a) * 0.34, az = cz + Math.sin(a) * 0.34;
      tube(S, 'iDeco', [cx, hy, cz], [ax, hy + 0.08, az], 0.01, gold);
      S.geo('iLamp', CYL(), m4(ax, hy + 0.02, az, 0, 0.065, 0.13, 0.065), warm);
    }
    S.var = 0;
  }

  // ---------- 卧室和卫生间的家具 ----------
  // 家具局部框：a 沿着靠的那面墙（aAxis 轴，aS 方向），b 从墙往屋里（另一条轴，bS 方向）
  function frame(aAxis, aO, aS, bO, bS) {
    const P = (a, y, b) => (aAxis === 'x' ? [aO + aS * a, y, bO + bS * b] : [bO + bS * b, y, aO + aS * a]);
    const R = (a0, a1, b0, b1) => { const p = P(a0, 0, b0), q = P(a1, 0, b1); return { x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), z0: Math.min(p[2], q[2]), z1: Math.max(p[2], q[2]) }; };
    return {
      P, R,
      box(S, k, a0, a1, y0, y1, b0, b1, c) { const r = R(a0, a1, b0, b1); S.box(k, r.x0, y0, r.z0, r.x1, y1, r.z1, c); return r; },
      leg(S, k, a0, a1, y0, y1, b0, b1, c) { const r = R(a0, a1, b0, b1); legBox(S, k, r.x0, y0, r.z0, r.x1, y1, r.z1, c); return r; },
      cbox(S, k, a0, a1, y0, y1, b0, b1, c, rr) { const r = R(a0, a1, b0, b1); S.cbox(k, r.x0, y0, r.z0, r.x1, y1, r.z1, c, rr); return r; },
      // 椭球（马桶、台盆）：sa 沿 a、sb 沿 b
      blob(S, k, a, y, b, sa, sy, sb, c) { const p = P(a, y, b); S.geo(k, SPH(), aAxis === 'x' ? m4(p[0], y, p[2], 0, sa, sy, sb) : m4(p[0], y, p[2], 0, sb, sy, sa), c); },
      // 竖直的圆柱
      cyl(S, k, a, y, b, r, h, c) { const p = P(a, y, b); S.geo(k, CYL(), m4(p[0], y, p[2], 0, r, h, r), c); },
    };
  }
  const DUVET = ['#7fa7c9', '#e7b8a8', '#a9c7a0', '#d9c99c', '#b7a3d1', '#f0f0ea', '#8fb5b0'];
  // 床 + 床头柜。床长 2.05 沿 b（床头贴 b=0 的墙），宽 bw 沿 a；standFirst = 床头柜在床的 a 小那一侧
  function bedSet(S, out, rng, F, aMin, bw, standFirst, len = 2.05) {
    const sa0 = standFirst ? aMin + 0.04 : aMin + 0.08 + bw, ba0 = standFirst ? aMin + 0.54 : aMin + 0.04, ba1 = ba0 + bw;
    const wood = col(rng.pick(WOODS)), head = col(rng.pick(SOFA)), duv = col(rng.pick(DUVET)), white = col('#f6f4ef');
    F.cbox(S, 'iFabric', ba0 - 0.03, ba1 + 0.03, 0, 0.7, 0, 0.08, head, 0.025);       // 床头板（矮一点，别挡住侧墙上的窗）
    F.cbox(S, 'iDoor', ba0, ba1, 0.1, 0.3, 0.08, len, wood, 0.015);                    // 床架
    for (const [a, b] of [[ba0, 0.08], [ba1 - 0.05, 0.08], [ba0, len - 0.05], [ba1 - 0.05, len - 0.05]]) F.leg(S, 'iDoor', a, a + 0.05, 0, 0.1, b, b + 0.05, wood);
    F.cbox(S, 'iFabric', ba0 + 0.03, ba1 - 0.03, 0.3, 0.52, 0.1, len - 0.02, white, 0.03);   // 床垫
    F.cbox(S, 'iFabric', ba0 - 0.01, ba1 + 0.01, 0.4, 0.56, 0.78, len + 0.01, duv, 0.025);  // 被子
    F.cbox(S, 'iFabric', ba0 - 0.01, ba1 + 0.01, 0.56, 0.6, 0.78, 1.02, duv.clone().offsetHSL(0, 0, 0.08), 0.015); // 被子翻折
    const np = bw >= 1.2 ? 2 : 1, pw = (bw - 0.12) / np;
    for (let i = 0; i < np; i++) F.cbox(S, 'iFabric', ba0 + 0.06 + i * pw + 0.02, ba0 + 0.06 + (i + 1) * pw - 0.02, 0.52, 0.64, 0.14, 0.5, white, 0.03);
    // 床面能跳上去站（被子顶 0.56），床头板那一条照样挡人
    out.push(Object.assign(F.R(ba0 - 0.03, ba1 + 0.03, 0, len + 0.01), { y0: 0, y1: 0.7, parts: [F.R(ba0 - 0.03, ba1 + 0.03, 0, 0.08), Object.assign(F.R(ba0 - 0.03, ba1 + 0.03, 0.092, len + 0.01), { top: 0.56 })] }));
    // 床头柜 + 台灯
    F.cbox(S, 'iDoor', sa0, sa0 + 0.44, 0.04, 0.52, 0.03, 0.43, wood, 0.012);
    F.box(S, 'iDoor', sa0 + 0.04, sa0 + 0.4, 0.29, 0.305, 0.43, 0.436, col('#2a2d31'));
    F.cyl(S, 'iDeco', sa0 + 0.22, 0.62, 0.2, 0.05, 0.2, col('#d8b25a'));
    F.cyl(S, 'iLamp', sa0 + 0.22, 0.8, 0.2, 0.11, 0.17, col('#fff1d6'));
    out.push(Object.assign(F.R(sa0, sa0 + 0.44, 0.03, 0.43), { y0: 0, y1: 0.9 }));
  }

  // 卫生间：里头是淋浴间（底盘 + 挡水条 + 玻璃隔断，中间留门口 = 干湿分离），外头马桶和洗手台面对面
  // 框：a = v 从卧室那面墙（xm）往走廊那面墙（xb），b = u 从最里面的墙往玄关那面墙
  function bathroom(S, out, rng, u) {
    const g = u.g, dirH = u.core > 0 ? 1 : -1, far = u.core > 0 ? g.b0 : g.b1;
    const F = frame('x', g.xm, 1, far, dirH);
    const Dx = g.xb - g.xm, Wz = Math.abs(g.hz - far) - IW / 2, a0 = IW / 2, mid = g.bathPc;
    const white = col('#f7f7f4'), chrome = col('#d7dadd'), tile = col('#e9eef0');
    // 淋浴间（湿区）
    const sd = 0.95;
    F.cbox(S, 'iTile', a0, Dx, 0, 0.04, 0, sd, tile, 0.01);                               // 底盘
    F.box(S, 'iMetal', mid - 0.06, mid + 0.06, 0.04, 0.044, sd * 0.45, sd * 0.45 + 0.12, col('#8c949c')); // 地漏
    F.cbox(S, 'iStone', a0, Dx, 0, 0.06, sd - 0.02, sd + 0.03, col('#e6e1d8'), 0.01);     // 挡水条
    for (const [p0, p1] of [[a0, mid - 0.38], [mid + 0.38, Dx]]) {
      F.box(S, 'iGlass', p0, p1, 0.06, 1.95, sd - 0.006, sd + 0.006, WHITE);
      F.box(S, 'iMetal', p0, p1, 1.95, 1.98, sd - 0.015, sd + 0.015, chrome);
      F.box(S, 'iMetal', p0 === a0 ? p1 - 0.025 : p0, p0 === a0 ? p1 : p0 + 0.025, 0.06, 1.95, sd - 0.015, sd + 0.015, chrome);
      out.push(Object.assign(F.R(p0, p1, sd - 0.03, sd + 0.03), { y0: 0, y1: 2 }));
    }
    // 花洒：装在淋浴间靠走廊那面实墙上（最里面那面墙是山墙，常有侧窗）
    const hb = sd / 2;
    tube(S, 'iMetal', F.P(Dx - 0.04, 0.95, hb), F.P(Dx - 0.04, 2.02, hb), 0.013, chrome);
    tube(S, 'iMetal', F.P(Dx - 0.04, 2.02, hb), F.P(Dx - 0.32, 2.02, hb), 0.012, chrome);
    F.cyl(S, 'iMetal', Dx - 0.32, 1.99, hb, 0.11, 0.025, chrome);
    F.box(S, 'iMetal', Dx - 0.07, Dx - 0.02, 1.0, 1.1, hb - 0.09, hb + 0.09, chrome);
    F.cbox(S, 'iGoods', a0, a0 + 0.14, 1.1, 1.12, 0.22, 0.56, white, 0.005);            // 置物架（卧室那面隔墙上）+ 两瓶洗发水
    F.cyl(S, 'iGoods', a0 + 0.07, 1.19, 0.32, 0.035, 0.16, col(rng.pick(['#3b6fb6', '#e85d4a', '#3a9d5d'])));
    F.cyl(S, 'iGoods', a0 + 0.07, 1.17, 0.46, 0.03, 0.12, col(rng.pick(['#f2a33a', '#8a5cc2', '#ffffff'])));
    // 干区：马桶靠卧室那面墙，洗手台靠走廊那面墙，面对面
    const tu = H.clamp(sd + 0.45, sd + 0.35, Wz - 0.32);
    F.cbox(S, 'iGoods', a0, a0 + 0.18, 0.42, 0.8, tu - 0.2, tu + 0.2, white, 0.02);     // 水箱
    F.box(S, 'iMetal', a0 + 0.05, a0 + 0.13, 0.8, 0.81, tu - 0.04, tu + 0.04, chrome);  // 冲水按钮
    F.cbox(S, 'iGoods', a0 + 0.18, a0 + 0.46, 0, 0.36, tu - 0.13, tu + 0.13, white, 0.025); // 底座
    F.blob(S, 'iGoods', a0 + 0.42, 0.36, tu, 0.25, 0.07, 0.19, white);                  // 坐便圈
    F.blob(S, 'iGoods', a0 + 0.4, 0.44, tu, 0.23, 0.025, 0.18, col('#ffffff'));         // 盖子
    out.push(Object.assign(F.R(a0, a0 + 0.68, tu - 0.21, tu + 0.21), { y0: 0, y1: 0.85 }));
    const vu = tu;
    F.cbox(S, 'iDoor', Dx - 0.43, Dx, 0.1, 0.8, vu - 0.32, vu + 0.32, col(rng.pick(['#f2efe8', '#b98a5a', '#6b4a32'])), 0.012);
    F.cbox(S, 'iStone', Dx - 0.45, Dx, 0.8, 0.84, vu - 0.34, vu + 0.34, col('#efece6'), 0.008);
    F.blob(S, 'iGoods', Dx - 0.24, 0.86, vu, 0.16, 0.06, 0.2, white);                   // 台上盆
    tube(S, 'iMetal', F.P(Dx - 0.05, 0.84, vu), F.P(Dx - 0.05, 1.0, vu), 0.012, chrome);
    tube(S, 'iMetal', F.P(Dx - 0.05, 1.0, vu), F.P(Dx - 0.15, 0.98, vu), 0.01, chrome);
    // 镜子：挂在洗手台后面那面墙（a = Dx）上，朝 -a
    const ma = Dx - 0.004;
    S.quad('iSteel', F.P(ma, 1.05, vu - 0.3), F.P(ma, 1.05, vu + 0.3), F.P(ma, 1.82, vu + 0.3), F.P(ma, 1.82, vu - 0.3), [-1, 0, 0], col('#eef3f6'));
    F.box(S, 'iLamp', Dx - 0.06, Dx - 0.02, 1.88, 1.92, vu - 0.25, vu + 0.25, col('#fff1d6'));
    out.push(Object.assign(F.R(Dx - 0.45, Dx, vu - 0.34, vu + 0.34), { y0: 0, y1: 0.9 }));
    F.box(S, 'iFabric', mid - 0.28, mid + 0.28, 0, 0.012, sd + 0.08, sd + 0.48, col(rng.pick(['#7fa7c9', '#e7b8a8', '#a9c7a0']))); // 地垫
  }

  function bedrooms(S, out, rng, u) {
    const g = u.g, dirH = u.core > 0 ? 1 : -1, far = u.core > 0 ? g.b0 : g.b1;
    // 后卧室：门在靠卫生间那头（a 大的一端），床靠另一头
    const Dx = g.xm - g.xf - IW, Wz = Math.abs(g.hz - far) - IW / 2;
    if (Wz >= 2.9) {
      // 进深够：床头贴最里面的墙，床头柜在墙角
      const F = frame('x', g.xf + IW / 2, 1, far, dirH);
      bedSet(S, out, rng, F, 0, H.clamp(Dx - 0.54 - 0.12, 0.9, 1.5), true);
    } else {
      // 进深不够：床横过来，床头贴前面那面墙，长边贴最里面的墙，床头柜在床头靠玄关那边
      const F = frame('z', far, dirH, g.xf + IW / 2, 1);
      bedSet(S, out, rng, F, 0, H.clamp(Wz - 0.5 - 0.75, 0.9, 1.4), false, Math.min(2.05, Dx - 0.05));
    }
    // 前面隔出来的卧室：床头贴外侧那面墙；卧室门在靠后那头。
    // 有阳台门的话床离正面墙留 0.7m 走道、床头柜放床的另一边；没有就床头柜在窗边墙角
    if (g.zs !== null) {
      const outer = u.core > 0 ? g.z0 : g.z1, bS = u.core > 0 ? 1 : -1;
      const F = frame('x', T, 1, outer, bS);
      const aMax = (g.xf - 1.3) - T;
      if (balDoor(u.rec, Math.min(outer, g.zs), Math.max(outer, g.zs))) bedSet(S, out, rng, F, 0.72, H.clamp(aMax - 1.28, 0.9, 1.5), false);
      else bedSet(S, out, rng, F, 0.02, H.clamp(aMax - 0.56, 0.9, 1.5), true);
    }
  }

  // 公共区、户内的地面铺装和顶灯
  function aptFloors(S, L, ceil, ground) {
    const st = L.st, sh = L.sh;
    const pub = ground ? 'iStone' : 'iTile', pubC = ground ? '#efe9df' : '#dcd7ce';
    const lamps = [];
    S.unit = 7;
    const rCor = { x0: L.xc, x1: L.D - T, z0: L.z0, z1: L.z1 }, rPas = { x0: T, x1: L.xc, z0: L.pas.z0, z1: L.pas.z1 }, rSt = { x0: T, x1: L.xc, z0: st.z0, z1: st.z1 };
    floorQuad(S, 'iTile', '#d9d4cb', L.xc, L.D - T, L.z0, L.z1, 0);
    for (let z = L.z0 + 1.6; z < L.z1 - 0.5; z += 3.6) lamps.push([(L.xc + L.D - T) / 2, z, 0.4, 7, false, rCor]);
    floorQuad(S, pub, pubC, T, L.xc, L.pas.z0, L.pas.z1, 0);
    lamps.push([T + 1.6, (L.pas.z0 + L.pas.z1) / 2, 0.5, 7, false, rPas], [L.xc - 1.6, (L.pas.z0 + L.pas.z1) / 2, 0.5, 7, false, rPas]);
    floorQuad(S, pub, pubC, T, st.xa, st.z0, st.z1, 0);
    for (const sp of st.strips) floorQuad(S, pub, pubC, st.xa, st.xs, sp.z0, sp.z1, 0);
    for (const r of rectsMinus(st.xs, L.xc, st.z0, st.z1, [{ u0: sh.x0 - 0.12, u1: sh.x1 + 1, v0: sh.z0 - 0.12, v1: sh.z1 + 0.12 }])) floorQuad(S, pub, pubC, r.u0, r.u1, r.v0, r.v1, 0);
    lamps.push([T + 0.65, st.zm, 0.4, 7, false, rSt]);
    if (ground) floorQuad(S, 'iStone', '#d9d2c4', -0.07, T, L.pas.iz0, L.pas.iz1, 0); // 门槛
    for (const u of L.units) for (const rm of u.rooms) {
      S.unit = u.no - 1;
      floorQuad(S, rm.k, rm.c || '#ffffff', rm.x0, rm.x1, rm.z0, rm.z1, 0);
      if (rm === u.living) {
        u.furn = []; livingRoom(S, L, u, ceil, u.furn, ground && L.hero === u);
        const frng = H.rng(L.r.seed * 59 + u.no * 7);
        bedrooms(S, u.furn, frng, u); bathroom(S, u.furn, frng, u);
        lamps.push([(rm.x0 + rm.x1) / 2, (rm.z0 + rm.z1) / 2, 0, u.no - 1, true, rm]);
      }
      else lamps.push([(rm.x0 + rm.x1) / 2, (rm.z0 + rm.z1) / 2, rm.name === '卫生间' || rm.name === '玄关' ? 0.32 : 0.5, u.no - 1, false, rm]);
    }
    for (const [x, z, w, un, deco] of lamps) { if (deco) continue; S.unit = un; lampAt(S, x, z, ceil, w); }
    // 天花板：这一层自己的（亮不亮灯跟这一层走），楼梯井和电梯井上方留洞
    const bot = col('#f7f5f0'), y = ceil;
    const holes = [{ u0: st.xa, u1: st.xm1, v0: st.iz0, v1: st.iz1 }, { u0: sh.x0, u1: sh.x1, v0: sh.z0, v1: sh.z1 }];
    const unitRects = L.units.map((u) => ({ u0: T, u1: L.xu, v0: u.z0, v1: u.z1, un: u.no - 1 }));
    for (const r of unitRects) { S.unit = r.un; S.quad('iCeil', [r.u0, y, r.v0], [r.u1, y, r.v0], [r.u1, y, r.v1], [r.u0, y, r.v1], [0, -1, 0], bot); }
    S.unit = 7;
    for (const r of rectsMinus(T, L.D - T, L.z0, L.z1, holes.concat(unitRects))) S.quad('iCeil', [r.u0, y, r.v0], [r.u1, y, r.v0], [r.u1, y, r.v1], [r.u0, y, r.v1], [0, -1, 0], bot);
    S.unit = -1;
    return lamps.map(([x, z, , , , rect]) => [x, ceil - 0.25, z, rect]);
  }

  // 楼板（顶面 y=-0.01，底面 y=-0.26 就是下一层的天花板），楼梯和电梯井处开洞
  function aptSlab(S, L) {
    const st = L.st, sh = L.sh;
    const holes = [{ u0: st.xa, u1: st.xm1, v0: st.iz0, v1: st.iz1 }, { u0: sh.x0, u1: sh.x1, v0: sh.z0, v1: sh.z1 }];
    const top = col('#cfcac2'), bot = col('#f7f5f0');
    // 底面（下一层的天花板）由下一层自己出，见 aptFloors
    for (const r of rectsMinus(T, L.D - T, L.z0, L.z1, holes)) S.quad('iSlab', [r.u0, -0.01, r.v0], [r.u1, -0.01, r.v0], [r.u1, -0.01, r.v1], [r.u0, -0.01, r.v1], [0, 1, 0], top);
    for (const h of holes) { // 洞口四周的板边
      S.quad('iCeil', [h.u0, -0.26, h.v0], [h.u0, -0.01, h.v0], [h.u0, -0.01, h.v1], [h.u0, -0.26, h.v1], [1, 0, 0], bot);
      S.quad('iCeil', [h.u1, -0.26, h.v0], [h.u1, -0.01, h.v0], [h.u1, -0.01, h.v1], [h.u1, -0.26, h.v1], [-1, 0, 0], bot);
      S.quad('iCeil', [h.u0, -0.26, h.v0], [h.u1, -0.26, h.v0], [h.u1, -0.01, h.v0], [h.u0, -0.01, h.v0], [0, 0, 1], bot);
      S.quad('iCeil', [h.u0, -0.26, h.v1], [h.u1, -0.26, h.v1], [h.u1, -0.01, h.v1], [h.u0, -0.01, h.v1], [0, 0, -1], bot);
    }
  }

  // 一层（按 fH=3.0 建，一楼实例在 y 方向拉伸）的两跑楼梯 + 休息平台 + 中间的隔墙 + 扶手
  function aptFlights(S, L, rise) {
    const st = L.st, n = NSTEP, tread = RUN / n, rs = rise / 2 / n, half = rise / 2;
    const C = col(STEPC), SOF = col('#ecebe6');
    const [a0, a1] = st.laneA, [b0, b1] = st.laneB;
    for (let i = 0; i < n; i++) {
      const top = (i + 1) * rs;
      S.box('iConc', st.xa + i * tread, top - 0.2, a0, st.xa + (i + 1) * tread, top, a1, C, 4);
      const topB = half + (i + 1) * rs;
      S.box('iConc', st.xb - (i + 1) * tread, topB - 0.2, b0, st.xb - i * tread, topB, b1, C, 4);
    }
    const na = new THREE.Vector3(half, -RUN, 0).normalize(), nb = new THREE.Vector3(-half, -RUN, 0).normalize();
    S.quad('iCeil', [st.xa, -0.2, a0], [st.xb, half - 0.2, a0], [st.xb, half - 0.2, a1], [st.xa, -0.2, a1], [na.x, na.y, 0], SOF);
    S.quad('iCeil', [st.xb, half - 0.2, b0], [st.xa, rise - 0.2, b0], [st.xa, rise - 0.2, b1], [st.xb, half - 0.2, b1], [nb.x, nb.y, 0], SOF);
    S.box('iConc', st.xb, half - 0.2, st.iz0, st.xm1, half, st.iz1, C);
    S.box('iWall', st.xa, -0.01, st.zm - 0.06, st.xb, rise - 0.01, st.zm + 0.06, col(PUBC));
    const rc = col('#b98a5a');
    for (const zz of [st.zm - 0.1, st.zm + 0.1]) {
      const inA = (zz > a0 && zz < a1);
      if (inA) tube(S, 'iDoor', [st.xa + 0.2, 0.92, zz], [st.xb - 0.05, half + 0.9, zz], 0.025, rc);
      else tube(S, 'iDoor', [st.xb - 0.05, half + 0.9, zz], [st.xa + 0.35, rise + 0.75, zz], 0.025, rc);
    }
  }

  // ---------- 可开的门 ----------
  // 叶片几何：铰链在原点，沿 +z 展开 w，厚度居中在 x=0，高 h
  function leafGeo(w, h, base, kind) {
    const S = new Sink(), C = col(base), C2 = col(base).clone().offsetHSL(0, 0, 0.05), SIL = col('#d7dadd');
    S.box('k', -0.025, 0, 0.004, 0.025, h, w, C);
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? 0.025 : -0.038, x1 = sx > 0 ? 0.038 : -0.025;
      S.box('k', x0, h * 0.56, 0.12, x1, h * 0.92, w - 0.12, C2);
      S.box('k', x0, 0.12, 0.12, x1, h * 0.5, w - 0.12, C2);
      const hx0 = sx > 0 ? 0.04 : -0.1, hx1 = sx > 0 ? 0.1 : -0.04;
      S.box('k', hx0, 1.0, w - 0.24, hx1, 1.04, w - 0.08, SIL);                 // 把手
      S.box('k', sx > 0 ? 0.025 : -0.05, 0.93, w - 0.11, sx > 0 ? 0.05 : -0.025, 1.12, w - 0.06, SIL);
      if (kind === 'unit') S.geo('k', SPH(), m4(sx * 0.03, 1.55, w / 2, 0, 0.012, 0.012, 0.012), SIL); // 猫眼
    }
    return S.toGeo('k');
  }
  // 玻璃门扇（大堂 / 商铺）：深色细框 + 玻璃 + 拉手，做成一个 Group，铰链在原点
  function glassLeaf(w, h, frameC) {
    const g = new THREE.Group();
    const S = new Sink(), C = col(frameC), SIL = col('#cfd3d8'), f = 0.06;
    S.box('iMetal', -0.025, 0, 0, 0.025, f, w, C); S.box('iMetal', -0.025, h - f, 0, 0.025, h, w, C);
    S.box('iMetal', -0.025, 0, 0, 0.025, h, f, C); S.box('iMetal', -0.025, 0, w - f, 0.025, h, w, C);
    S.box('iMetal', -0.025, 0.85, 0, 0.025, 0.95, w, C);
    for (const sx of [-1, 1]) S.box('iMetal', sx > 0 ? 0.03 : -0.06, 0.8, w - 0.2, sx > 0 ? 0.06 : -0.03, 1.5, w - 0.16, SIL);
    S.quad('iGlass', [0, f, f], [0, f, w - f], [0, h - f, w - f], [0, h - f, f], [1, 0, 0], WHITE);
    S.build(g);
    g.children.forEach((m) => { m.matrixAutoUpdate = false; });
    return g;
  }
  // 推拉门扇（阳台）：铝框 + 玻璃；原点在门扇左下角，沿 +z 展开
  function slideGeo(w, h, frameC) {
    const S = new Sink(), C = col(frameC), f = 0.05;
    S.box('k', -0.02, 0, 0, 0.02, f, w, C); S.box('k', -0.02, h - f, 0, 0.02, h, w, C);
    S.box('k', -0.02, 0, 0, 0.02, h, f, C); S.box('k', -0.02, 0, w - f, 0.02, h, w, C);
    const fr = S.toGeo('k');
    S.quad('k', [0, f, f], [0, f, w - f], [0, h - f, w - f], [0, h - f, f], [1, 0, 0], WHITE);
    return [fr, S.toGeo('k')];
  }
  // 居中的盒子几何，带顶点色（室内材质都读顶点色，没有就是黑的）
  function colorBox(w, h, d, c) { const S = new Sink(); S.unit = 7; S.box('k', -w / 2, -h / 2, -d / 2, w / 2, h / 2, d / 2, col(c)); return S.toGeo('k'); }
  // 单独建的实例化网格补上"这一层哪几户开灯"的属性：一律当公共区（第 7 位），夜里和走廊一样亮
  function litAttrs(g, n) {
    g.setAttribute('aLitMask', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(255), 1));
    g.setAttribute('aLightSel', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  }
  const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // 铰链门：closed = 关着时门扇朝向（从铰链指向门扇另一头），opens = 开到底时朝向
  function hingeDoor(o) {
    const yc = Math.atan2(o.closed[0], o.closed[1]), yo = Math.atan2(o.opens[0], o.opens[1]);
    return Object.assign({ kind: 'hinge', yc, dy: wrapA(yo - yc), open: 0, target: 0, dur: 0.7 }, o);
  }

  // ---------- 电梯 ----------
  function elevTextures(el) {
    const pc = document.createElement('canvas'); pc.width = 256; pc.height = 512;
    el.pctx = pc.getContext('2d'); el.ptex = new THREE.CanvasTexture(pc); el.ptex.encoding = THREE.sRGBEncoding;
    const ic = document.createElement('canvas'); ic.width = 128; ic.height = 64;
    el.ictx = ic.getContext('2d'); el.itex = new THREE.CanvasTexture(ic); el.itex.encoding = THREE.sRGBEncoding;
    el.pmat = new THREE.MeshStandardMaterial({ map: el.ptex, emissiveMap: el.ptex, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.35, metalness: 0.3 });
    el.imat = new THREE.MeshBasicMaterial({ map: el.itex });
  }
  function panelLayout(F) { const rows = Math.ceil(F / 2) + 1; return { rows, ch: 512 / rows, rad: Math.min(512 / rows * 0.34, 40) }; }
  function drawPanel(el) {
    const x = el.pctx, F = el.F, { rows, ch, rad } = panelLayout(F);
    const g = x.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, '#8f969d'); g.addColorStop(0.5, '#c9ced3'); g.addColorStop(1, '#8f969d');
    x.fillStyle = g; x.fillRect(0, 0, 256, 512);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const btn = (c, r, label, on, hov) => {
      const cx = 64 + c * 128, cy = 512 - (r + 0.5) * ch;
      x.beginPath(); x.arc(cx, cy, rad + 6, 0, 7); x.fillStyle = on ? '#ffb547' : hov ? '#4f9be0' : '#6d747b'; x.fill();
      x.beginPath(); x.arc(cx, cy, rad, 0, 7); x.fillStyle = on ? '#fff3d6' : '#eef0f2'; x.fill();
      x.fillStyle = on ? '#b35a00' : '#2b3036'; x.font = `bold ${Math.round(rad * 0.95)}px "PingFang SC",sans-serif`;
      x.fillText(label, cx, cy + 2);
    };
    btn(0, 0, '开', false, el.hover === -2); btn(1, 0, '关', false, el.hover === -3);
    for (let i = 0; i < F; i++) btn(i % 2, 1 + Math.floor(i / 2), String(i + 1), el.queue.has(i), el.hover === i);
    el.ptex.needsUpdate = true;
  }
  function drawInd(el) {
    const x = el.ictx;
    x.fillStyle = '#121518'; x.fillRect(0, 0, 128, 64);
    x.fillStyle = '#ff9d2e'; x.font = 'bold 42px "Menlo",monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(el.floor + 1), 82, 35);
    if (el.dir) {
      x.beginPath();
      if (el.dir > 0) { x.moveTo(30, 18); x.lineTo(44, 40); x.lineTo(16, 40); } else { x.moveTo(30, 46); x.lineTo(44, 24); x.lineTo(16, 24); }
      x.fill();
    }
    el.itex.needsUpdate = true;
  }

  function* buildApt(st) {
    const r = st.rec, L = layoutApt(r); st.L = L;
    const F = r.F, D = r.D, W = r.W, gH = r.gH, fH = r.fH;
    const grp = st.group;
    const bound = new THREE.Sphere(new THREE.Vector3(D / 2, r.Hb / 2, 0), 0.5 * Math.hypot(D + 4, r.Hb + 4, W + 4));
    const boxes = st.boxes = [], doors = st.doors = [];
    // 外墙内皮按户分段（夜里跟着各户的灯亮）：正面按户的 z 范围；山墙那面归贴着它的端户（走廊那段除外）；背面是走廊
    const fill = (list) => {
      const out = []; let cur = -1e9;
      for (const [a, b, un] of list.sort((p, q) => p[0] - q[0])) { if (a > cur) out.push([cur, a, 7]); out.push([a, b, un]); cur = b; }
      out.push([cur, 1e9, 7]); return out;
    };
    const endUnit = (side) => L.units.find((u) => (side < 0 ? Math.abs(u.z0 - L.z0) < 1e-3 : Math.abs(u.z1 - L.z1) < 1e-3));
    const zones = {
      front: fill(L.units.map((u) => [u.z0, u.z1, u.no - 1])), back: [[-1e9, 1e9, 7]],
      left: endUnit(-1) ? [[-1e9, L.xc, endUnit(-1).no - 1], [L.xc, 1e9, 7]] : [[-1e9, 1e9, 7]],
      right: endUnit(1) ? [[-1e9, L.xc, endUnit(1).no - 1], [L.xc, 1e9, 7]] : [[-1e9, 1e9, 7]],
    };
    const body = { x0: 0, x1: D, z0: -W / 2, z1: W / 2, R: r.R, t: T, k: r.wallKey, c: r.wallCol, ki: 'iWall', ci: PUBC, zones };
    const Yb1 = gH;
    // 卫生间那段的侧窗换磨砂玻璃
    const bathX = L.units.length ? [L.units[0].g.xm, L.units[0].g.xb] : [1e9, 1e9];
    const frost = (name, h) => (name === 'left' || name === 'right') && h.u1 > bathX[0] && h.u0 < bathX[1];
    // ---- 标准层（2 楼以上）：外墙一圈、楼层腰线、楼板、墙、地面、顶灯、玻璃 ----
    const ceilU = fH - 0.26;
    const hU = holesFrom(r, (w) => w.y > Yb1 && w.y < Yb1 + fH, L.Y(1), 0);
    let S = new Sink();
    const stairHole = [{ x0: L.st.xa, x1: L.st.xm1, z0: L.st.iz0, z1: L.st.iz1 }];
    const shaftHole = { x0: L.sh.x0, x1: L.sh.x1, z0: L.sh.z0, z1: L.sh.z1 };
    shell(S, Object.assign({}, body, { y0: -0.12, y1: fH - 0.12, holes: hU, bb: 0, bbHoles: stairHole }));
    const tc = col(r.trimCol);
    // 楼层腰线：外墙一圈四条（只露在外墙外面那 8cm，里面藏在墙里）；顶面比阳台门洞底低 1cm，免得共面闪
    S.box('trim', -0.08, -0.22, -W / 2 - 0.08, T, -0.03, W / 2 + 0.08, tc, 2);
    S.box('trim', D - T, -0.22, -W / 2 - 0.08, D + 0.08, -0.03, W / 2 + 0.08, tc, 1);
    S.box('trim', -0.08, -0.22, -W / 2 - 0.08, D + 0.08, -0.03, -W / 2 + T, tc, 32);
    S.box('trim', -0.08, -0.22, W / 2 - T, D + 0.08, -0.03, W / 2 + 0.08, tc, 16);
    aptSlab(S, L);
    emitWalls(S, aptWalls(L, ceilU, 'typ'), stairHole.concat([shaftHole]));
    const lampsU = aptFloors(S, L, ceilU, false);
    glassFor(S, body, hU, ['res'], frost);
    // 入户门门套、电梯门套（比墙上自动加的门套往门洞里多收 2mm，整个盖住它，不共面）
    const frm = col('#f6f3ec'), stl = col('#b9bfc5');
    const cx1 = L.xc + PW / 2;
    S.unit = 7;
    for (const u of L.units) {
      S.box('iDoor', cx1, 0, u.dz - 0.52, cx1 + 0.02, 2.17, u.dz - 0.448, frm); S.box('iDoor', cx1, 0, u.dz + 0.448, cx1 + 0.02, 2.17, u.dz + 0.52, frm);
      S.box('iDoor', cx1, 2.098, u.dz - 0.52, cx1 + 0.02, 2.17, u.dz + 0.52, frm);
    }
    const ez = L.sh.zc;
    S.box('iSteel', cx1, 0, ez - 0.6, cx1 + 0.03, 2.25, ez - 0.498, stl); S.box('iSteel', cx1, 0, ez + 0.498, cx1 + 0.03, 2.25, ez + 0.6, stl);
    S.box('iSteel', cx1, 2.148, ez - 0.6, cx1 + 0.03, 2.25, ez + 0.6, stl);
    S.box('iSteel', cx1, 1.05, ez + 0.69, cx1 + 0.012, 1.25, ez + 0.81, stl);
    // 阳台推拉门：左半扇固定（静态），右半扇能推开（动态）
    const slides = [];
    for (const h of hU.front) {
      if (h.w.kind !== 'bdoor') continue;
      const i0 = h.u0 + 0.065, i1 = h.u1 - 0.065, mid = (h.u0 + h.u1) / 2, y0 = h.v0 + 0.065, y1 = h.v1 - 0.065;
      S.box('iMetal', 0.05, y0, i0, 0.09, y0 + 0.05, mid + 0.03, frm); S.box('iMetal', 0.05, y1 - 0.05, i0, 0.09, y1, mid + 0.03, frm);
      S.box('iMetal', 0.05, y0, mid - 0.02, 0.09, y1, mid + 0.03, frm);
      S.quad('iGlass', [0.07, y0, i0], [0.07, y0, mid], [0.07, y1, mid], [0.07, y1, i0], [-1, 0, 0], WHITE);
      slides.push({ i0, i1, mid, y0, y1 });
    }
    S.unit = -1;
    // 每层哪几户开着灯（第 7 位是公共区，一直亮）：跟楼没打开时窗户的亮灯一致——这户这层有一扇窗亮着就算开灯
    const floorOf = (w) => (w.y < gH ? 0 : 1 + Math.floor((w.y - gH) / fH));
    const unitOfWin = (w) => {
      if (w.face === 'front') return L.units.find((u) => w.z > u.z0 - 0.01 && w.z < u.z1 + 0.01);
      if ((w.face === 'left' || w.face === 'right') && w.x < L.xc) return endUnit(w.face === 'left' ? -1 : 1);
      return null;
    };
    const winLit = {};
    for (const w of r.wins) { const u = unitOfWin(w); if (!u) continue; const key = floorOf(w) + ':' + (u.no - 1); const e = winLit[key] || (winLit[key] = [0, 0]); e[0]++; if (w.lit) e[1]++; }
    const lrng = H.rng(r.seed * 977 + 13), masks = [], sels = [];
    for (let f = 0; f < F; f++) {
      let m = 128, v = 0;
      L.units.forEach((u, i) => {
        const roll = lrng(), e = winLit[f + ':' + i];
        if (e ? e[1] > 0 : roll < 0.4) m += 1 << i;
        v += (1 + Math.floor(lrng() * 3)) * Math.pow(4, i);
      });
      masks.push(m); sels.push(v);
    }
    st.masks = masks; st.sels = sels;
    const instU = []; for (let f = 1; f < F; f++) instU.push(new THREE.Matrix4().makeTranslation(0, L.Y(f), 0));
    S.build(grp, { inst: instU, mask: masks.slice(1), sel: sels.slice(1), bound });
    yield;

    // ---- 一楼：底座外墙、大堂 ----
    const ceilG = L.rise(0) - 0.26;
    const hG = holesFrom(r, (w) => w.y < gH, 0, 0.02);
    S = new Sink();
    const base = { x0: -0.07, x1: D + 0.07, z0: -W / 2 - 0.07, z1: W / 2 + 0.07, R: r.R + 0.07, t: T + 0.07, k: 'concrete', c: r.baseCol, ki: 'iWall', ci: PUBC, y0: 0, y1: gH, holes: hG, bb: 0.02, zones };
    shell(S, base);
    ledge(S, 'concrete', r.baseCol, base, body, gH);
    // 一楼室内全部按 y = 0.02 起算
    const S0 = new Sink();
    emitWalls(S0, aptWalls(L, ceilG, 'ground'), [shaftHole]);
    const lampsG = aptFloors(S0, L, ceilG, true);
    glassFor(S, base, hG, ['res'], frost);
    // 信报箱 + 一盆绿植
    const pz = L.side > 0 ? L.pas.iz0 : L.pas.iz1, ps = L.side > 0 ? 1 : -1;
    const mb0 = Math.min(pz, pz + ps * 0.34), mb1 = Math.max(pz, pz + ps * 0.34);
    S0.box('iMetal', T + 1.4, 0, mb0, T + 3.0, 1.55, mb1, col('#8c949c'));
    for (let i = 0; i < 4; i++) S0.box('iMetal', T + 1.45, 0.35 + i * 0.3, ps > 0 ? mb1 : mb0 - 0.005, T + 2.95, 0.37 + i * 0.3, ps > 0 ? mb1 + 0.005 : mb0, col('#5d646b'));
    boxes.push({ x0: T + 1.4, x1: T + 3.0, z0: mb0, z1: mb1, y0: 0, y1: 1.6 });
    const ppx = L.xc - 0.5, ppz = L.pas.iz0 + 0.45 + (L.side > 0 ? 0 : L.pas.iz1 - L.pas.iz0 - 0.9);
    S0.geo('iConc', CYL(), m4(ppx, 0.25, ppz, 0, 0.26, 0.5, 0.26), col('#b9785a'));
    S0.geo('iLeaf', H.bld.blob(3), m4(ppx, 0.95, ppz, 0, 0.45, 0.55, 0.45), col('#4f8a3f'));
    boxes.push({ x0: ppx - 0.3, x1: ppx + 0.3, z0: ppz - 0.3, z1: ppz + 0.3, y0: 0, y1: 1.4 });
    const gd = hG.front.find((h) => h.w.kind === 'gdoor');
    // 电梯井底：原来露出楼下的人行道地砖，盖成一个黑洞洞的底坑（井道里只留轿厢自己的地板）
    const pit = col('#151719'), sh0 = L.sh;
    S.quad('iConc', [sh0.x0, 0.004, sh0.z0], [sh0.x1, 0.004, sh0.z0], [sh0.x1, 0.004, sh0.z1], [sh0.x0, 0.004, sh0.z1], [0, 1, 0], pit);
    S.build(grp, { inst: [new THREE.Matrix4()], mask: [masks[0]], sel: [sels[0]], bound });
    const g0 = new THREE.Group(); g0.position.y = L.Y(0); g0.updateMatrix(); g0.matrixAutoUpdate = false; grp.add(g0);
    S0.build(g0, { inst: [new THREE.Matrix4()], mask: [masks[0]], sel: [sels[0]], bound });
    yield;

    // ---- 楼梯（每层一套，一楼的拉高）、顶层天花板、顶上一圈外墙 ----
    S = new Sink();
    aptFlights(S, L, fH);
    const instF = []; for (let f = 0; f < F - 1; f++) instF.push(new THREE.Matrix4().makeTranslation(0, L.Y(f), 0).multiply(new THREE.Matrix4().makeScale(1, L.rise(f) / fH, 1)));
    S.build(grp, { inst: instF, bound });
    S = new Sink();
    // 顶层天花板上楼梯井、电梯井那两个洞补上（再往上是屋顶）；算公共区，夜里和旁边的天花板一起亮
    const Sp = new Sink(); Sp.unit = 7;
    const yTop = L.Y(F) - 0.26;
    for (const hh of [{ u0: L.st.xa, u1: L.st.xm1, v0: L.st.iz0, v1: L.st.iz1 }, { u0: L.sh.x0, u1: L.sh.x1, v0: L.sh.z0, v1: L.sh.z1 }])
      Sp.quad('iCeil', [hh.u0, yTop, hh.v0], [hh.u1, yTop, hh.v0], [hh.u1, yTop, hh.v1], [hh.u0, yTop, hh.v1], [0, -1, 0], col('#f7f5f0'));
    Sp.build(grp, { inst: [new THREE.Matrix4()], mask: [masks[F - 1]], sel: [sels[F - 1]], bound });
    shell(S, Object.assign({}, body, { y0: gH + (F - 1) * fH, y1: r.Hb, holes: {}, zones: null }));
    // 顶层楼梯口栏板
    const Sx = new Sink();
    emitWalls(Sx, aptWalls(L, ceilU, 'top').slice(-2), stairHole);
    S.build(grp, { bound });
    const gt = new THREE.Group(); gt.position.y = L.Y(F - 1); gt.updateMatrix(); gt.matrixAutoUpdate = false; grp.add(gt);
    Sx.build(gt, { inst: [new THREE.Matrix4()], mask: [masks[F - 1]], sel: [sels[F - 1]], bound });
    yield;

    // ---- 会动的：入户门、阳台推拉门、大堂门 ----
    const nu = L.units.length;
    const dcol = DOORC[r.seed % DOORC.length];
    if (nu) {
      const dm = new THREE.InstancedMesh(leafGeo(0.86, 2.07, dcol, 'unit'), mats().iDoor, nu * F);
      dm.castShadow = true; dm.receiveShadow = true; dm.geometry.boundingSphere = bound.clone(); dm.frustumCulled = true;
      for (let f = 0; f < F; f++) L.units.forEach((u, i) => {
        const y = L.Y(f);
        const d = hingeDoor({ mesh: dm, i: f * nu + i, hx: L.xc, hy: y, hz: u.dz - 0.45 + 0.02, closed: [0, 1], opens: [-1, 0], cx: L.xc, cy: y + 1.1, cz: u.dz,
          blk: { x0: L.xc - PW / 2 - 0.02, x1: L.xc + PW / 2 + 0.02, z0: u.dz - 0.45, z1: u.dz + 0.45, y0: y, y1: y + 2.1 }, name: `${(f + 1) * 100 + u.no} 室` });
        doors.push(d); placeDoor(d);
      });
      dm.instanceMatrix.needsUpdate = true;
      grp.add(dm);
    }
    if (slides.length && F > 1) {
      const sw = slides[0].i1 - slides[0].mid + 0.02, shh = slides[0].y1 - slides[0].y0;
      const [fg, gg] = slideGeo(sw, shh, r.trimCol);
      const n = slides.length * (F - 1);
      const fm = new THREE.InstancedMesh(fg, mats().iMetal, n), gm = new THREE.InstancedMesh(gg, mats().iGlass, n);
      fm.geometry.boundingSphere = bound.clone(); gm.geometry.boundingSphere = bound.clone();
      fm.castShadow = true; fm.frustumCulled = true; gm.frustumCulled = true;
      let k = 0;
      for (let f = 1; f < F; f++) for (const s of slides) {
        const y = L.Y(f);
        const d = { kind: 'slide', meshes: [fm, gm], i: k++, x: 0.12, y: y + s.y0, z0: s.mid - 0.02, z1: s.i0 + 0.02, open: 0, target: 0, dur: 0.8,
          cx: 0.12, cy: y + 1.1, cz: (s.mid + s.i1) / 2, blk: { x0: -0.1, x1: T + 0.1, z0: s.mid, z1: s.i1, y0: y, y1: y + 2.2 }, name: '阳台门' };
        doors.push(d); placeDoor(d);
      }
      fm.instanceMatrix.needsUpdate = true; gm.instanceMatrix.needsUpdate = true;
      grp.add(fm); grp.add(gm);
    }
    if (gd) {
      const w = gd.u1 - gd.u0 - 0.16, lw = w / 2, hh = 2.2;
      const pair = { kind: 'pair', leaves: [], open: 0, target: 0, dur: 0.8, cx: 0.05, cy: 1.1, cz: (gd.u0 + gd.u1) / 2, name: '单元门',
        blk: { x0: -0.1, x1: T + 0.1, z0: gd.u0, z1: gd.u1, y0: 0, y1: 2.6 } };
      for (const sd of [-1, 1]) {
        const lg = glassLeaf(lw - 0.01, hh, '#41464d');
        lg.position.set(0.03, 0.03, sd < 0 ? gd.u0 + 0.08 : gd.u1 - 0.08);
        const yc = sd < 0 ? 0 : PI;
        pair.leaves.push({ obj: lg, yc, dy: sd < 0 ? PI / 2 : -PI / 2 });
        lg.rotation.y = yc;
        grp.add(lg);
      }
      // 门上的亮子玻璃
      const Sg = new Sink();
      Sg.quad('iGlass', [0.03, 2.27, gd.u0 + 0.08], [0.03, 2.27, gd.u1 - 0.08], [0.03, gd.v1 - 0.08, gd.u1 - 0.08], [0.03, gd.v1 - 0.08, gd.u0 + 0.08], [-1, 0, 0], WHITE);
      Sg.build(grp);
      doors.push(pair);
    }
    yield;

    // ---- 电梯：轿厢、轿厢门、各层厅门、呼叫按钮、楼层显示 ----
    const el = st.el = { F, y: L.Y(0), floor: 0, dir: 0, v: 0, target: -1, queue: new Set(), doors: 0, phase: 'idle', timer: 0, hover: null };
    elevTextures(el); drawPanel(el); drawInd(el);
    const cab = L.cab, cabG = new THREE.Group();
    S = new Sink(); S.unit = 7; // 轿厢算公共区：夜里一直亮着
    const steel = col('#c3c8cd'), dark = col('#7b8288');
    S.box('iStone', cab.x0 - 0.04, -0.12, cab.z0 - 0.04, cab.x1 + 0.04, 0, cab.z1 + 0.04, col('#cfc8bc'));
    S.box('iSteel', cab.x0 - 0.04, cab.h, cab.z0 - 0.04, cab.x1 + 0.04, cab.h + 0.06, cab.z1 + 0.04, steel);
    S.box('iLamp', cab.x0 + 0.35, cab.h - 0.02, cab.z0 + 0.35, cab.x1 - 0.35, cab.h, cab.z1 - 0.35, col(LAMPC));
    S.box('iSteel', cab.x0 - 0.04, 0, cab.z0, cab.x0, cab.h, cab.z1, steel);
    S.box('iSteel', cab.x0 - 0.04, 0, cab.z0 - 0.04, cab.x1 + 0.04, cab.h, cab.z0, steel);
    S.box('iSteel', cab.x0 - 0.04, 0, cab.z1, cab.x1 + 0.04, cab.h, cab.z1 + 0.04, steel);
    const dz0 = L.sh.zc - 0.45, dz1 = L.sh.zc + 0.45;
    S.box('iSteel', cab.x1, 0, cab.z0, cab.x1 + 0.04, cab.h, dz0, steel);
    S.box('iSteel', cab.x1, 0, dz1, cab.x1 + 0.04, cab.h, cab.z1, steel);
    S.box('iSteel', cab.x1, 2.1, dz0, cab.x1 + 0.04, cab.h, dz1, steel);
    tube(S, 'iSteel', [cab.x0 + 0.06, 0.92, cab.z0 + 0.15], [cab.x0 + 0.06, 0.92, cab.z1 - 0.15], 0.02, dark);
    S.build(cabG, { inst: [new THREE.Matrix4()], mask: [255] });
    // 按钮面板（侧墙靠门那头）、门上方的楼层显示
    const pw = 0.26, ph = 0.52;
    el.panel = { x: cab.x1 - 0.32, y: 1.25, z: cab.z1 - 0.006, w: pw, h: ph };
    const pmesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), el.pmat);
    pmesh.position.set(el.panel.x, el.panel.y, el.panel.z); pmesh.rotation.y = PI; cabG.add(pmesh);
    const imesh = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.14), el.imat);
    imesh.position.set(cab.x1 - 0.006, 2.27, L.sh.zc); imesh.rotation.y = -PI / 2; cabG.add(imesh);
    // 轿厢门两扇
    const lgeo = colorBox(0.03, 2.1, 0.47, '#c9ced3');
    litAttrs(lgeo, 1);
    el.cabDoors = [-1, 1].map((sd) => { const m = new THREE.InstancedMesh(lgeo, mats().iSteel, 1); m.setMatrixAt(0, new THREE.Matrix4()); m.castShadow = true; m.userData.sd = sd; cabG.add(m); return m; });
    cabG.position.y = el.y;
    cabG.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    grp.add(cabG); el.cab = cabG;
    // 厅门（每层两扇）
    const hgeo = colorBox(0.04, 2.15, 0.52, '#c9ced3');
    litAttrs(hgeo, F * 2);
    const hall = el.hall = new THREE.InstancedMesh(hgeo, mats().iSteel, F * 2);
    hall.geometry.boundingSphere = bound.clone(); hall.castShadow = true; hall.receiveShadow = true; hall.frustumCulled = true;
    grp.add(hall);
    // 呼叫按钮 + 楼层显示
    const bgeo = new THREE.BoxGeometry(0.02, 0.1, 0.07);
    const btn = el.btn = new THREE.InstancedMesh(bgeo, new THREE.MeshBasicMaterial(), F);
    btn.geometry.boundingSphere = bound.clone(); btn.frustumCulled = true;
    const ind = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.36, 0.18), el.imat, F);
    ind.geometry.boundingSphere = bound.clone(); ind.frustumCulled = true;
    for (let f = 0; f < F; f++) {
      const y = L.Y(f);
      btn.setMatrixAt(f, m4(cx1 + 0.015, y + 1.15, ez + 0.75));
      btn.setColorAt(f, col('#f2f2f2'));
      ind.setMatrixAt(f, m4(cx1 + 0.035, y + 2.42, ez, PI / 2));
    }
    grp.add(btn); grp.add(ind);
    el.btnFloor = (f) => [cx1 + 0.02, L.Y(f) + 1.15, ez + 0.75];
    placeElevator(st);
    // 门牌、楼层号
    const lab = [];
    for (let f = 0; f < F; f++) {
      const y = L.Y(f);
      for (const u of L.units) lab.push({ x: cx1 + 0.006, y: y + 1.62, z: u.dz + (u.core > 0 ? -0.75 : 0.75), ry: PI / 2, w: 0.26, h: 0.13, cell: labelAtlas().cell(f + 1, Math.min(7, u.no - 1)) });
      lab.push({ x: D - T - 0.006, y: y + 1.6, z: ez, ry: -PI / 2, w: 0.9, h: 0.45, cell: labelAtlas().cell(f + 1, 8) });
      lab.push({ x: cx1 + 0.006, y: y + 1.55, z: ez - 0.95, ry: PI / 2, w: 0.5, h: 0.25, cell: labelAtlas().cell(f + 1, 8) });
    }
    const lm = labelMesh(lab); lm.geometry.boundingSphere = bound.clone(); lm.frustumCulled = true; grp.add(lm);
    yield;

    // ---- 碰撞盒（局部坐标）和能站的面 ----
    const wG = aptWalls(L, ceilG, 'ground'), wU = aptWalls(L, ceilU, 'typ'), wT = aptWalls(L, ceilU, 'top').slice(-2);
    wallColliders(boxes, wG, L.Y(0));
    for (let f = 1; f < F; f++) wallColliders(boxes, wU, L.Y(f));
    wallColliders(boxes, wT, L.Y(F - 1));
    // 家具：能站的部分（床面、沙发坐面、茶几、边几）登记成"能站的顶"（脚低于 顶-STEP 时挡，高过去就踩上）；
    // 其余至少 1.3 高——从阳台、店门冲进来或站在床上再跳，脚最高到 1.2 左右，翻不进去（翻进去落在盒子里会被推到最近的边，可能推穿墙）
    for (let f = 0; f < F; f++) for (const u of L.units) for (const b of u.furn || []) for (const p of b.parts || [b]) {
      const y = L.Y(f);
      if (p.top !== undefined) boxes.push({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, y0: y + (b.y0 || 0), y1: y + p.top, top: y + p.top });
      else boxes.push({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, y0: y + (b.y0 || 0), y1: y + Math.max(b.y1, 1.3) });
    }
    const st2 = L.st;
    for (let f = 0; f < F - 1; f++) boxes.push({ x0: st2.xa, x1: st2.xb, z0: st2.zm - 0.06, z1: st2.zm + 0.06, y0: L.Y(f), y1: L.Y(f) + L.rise(f) - 0.01 });
    // 外墙：一楼正面在大门处断开；楼上正面在阳台推拉门能开的那半边断开
    const gz0 = gd ? gd.u0 + 0.08 : 0, gz1 = gd ? gd.u1 - 0.08 : 0;
    boxes.push({ x0: -0.07, x1: T, z0: -W / 2 - 0.07, z1: gd ? gz0 : W / 2 + 0.07, y0: 0, y1: gH });
    if (gd) boxes.push({ x0: -0.07, x1: T, z0: gz1, z1: W / 2 + 0.07, y0: 0, y1: gH });
    boxes.push({ x0: D - T, x1: D + 0.07, z0: -W / 2 - 0.07, z1: W / 2 + 0.07, y0: 0, y1: r.Hb });
    boxes.push({ x0: -0.07, x1: D + 0.07, z0: -W / 2 - 0.07, z1: -W / 2 + T, y0: 0, y1: r.Hb });
    boxes.push({ x0: -0.07, x1: D + 0.07, z0: W / 2 - T, z1: W / 2 + 0.07, y0: 0, y1: r.Hb });
    const gaps = slides.map((s) => [s.mid, s.i1]).sort((p, q) => p[0] - q[0]);
    for (let f = 1; f < F; f++) {
      const y0 = gH + (f - 1) * fH;
      let z = -W / 2;
      for (const [a, b] of gaps) { boxes.push({ x0: 0, x1: T, z0: z, z1: a, y0, y1: y0 + fH }); z = b; }
      boxes.push({ x0: 0, x1: T, z0: z, z1: W / 2, y0, y1: y0 + fH });
    }
    boxes.push({ x0: 0, x1: T, z0: -W / 2, z1: W / 2, y0: gH + (F - 1) * fH, y1: r.Hb });
    // 阳台：地面 + 三面栏杆
    st.balc = [];
    r.bal.forEach((bw2, b) => {
      if (!bw2) return;
      const bz = r.zb0 + r.bw * (b + 0.5);
      st.balc.push({ z0: bz - bw2 / 2, z1: bz + bw2 / 2 });
      for (let f = 1; f < F; f++) {
        const y = L.Y(f);
        boxes.push({ x0: -1.36, x1: -1.12, z0: bz - bw2 / 2 - 0.05, z1: bz + bw2 / 2 + 0.05, y0: y, y1: y + 1.6 });
        boxes.push({ x0: -1.3, x1: 0, z0: bz - bw2 / 2 - 0.05, z1: bz - bw2 / 2 + 0.12, y0: y, y1: y + 1.6 });
        boxes.push({ x0: -1.3, x1: 0, z0: bz + bw2 / 2 - 0.12, z1: bz + bw2 / 2 + 0.05, y0: y, y1: y + 1.6 });
      }
    });
    st.tops = boxes.filter((b) => b.top !== undefined);
    // 头顶限位：各道门的门楣、阳台推拉门和一楼大门的门洞上沿（跳着穿门时头顶不能钻进去）；楼板和阳台板在 ceilApt 里算
    st.heads = [];
    // 每个门楣同时是一块碰撞（门洞上方那段墙）：站着时它在头顶上（头顶限位管），头已经高过它（助跑跳过来）就当墙挡住
    const addHeads = (walls, yOff) => {
      for (const w of walls) for (const o of wallSegs(w).ops) if (o.top < w.y1) {
        const b = wallBox(w.axis, w.at, w.th, Math.max(o.a, w.from), Math.min(o.b, w.to), yOff + o.top, yOff + w.y1);
        boxes.push(b);
        st.heads.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y: yOff + o.top });
      }
    };
    addHeads(wG, L.Y(0)); for (let f = 1; f < F; f++) addHeads(wU, L.Y(f)); addHeads(wT, L.Y(F - 1));
    for (let f = 1; f < F; f++) for (const h of hU.front) if (h.w.kind === 'bdoor') {
      st.heads.push({ x0: -0.12, x1: T + 0.05, z0: h.u0, z1: h.u1, y: L.Y(f) + h.v1 });
      boxes.push({ x0: 0, x1: T, z0: h.u0, z1: h.u1, y0: L.Y(f) + h.v1, y1: L.Y(f + 1) }); // 阳台门洞上方的外墙
    }
    // 一楼大门：开着的双扇门上沿 2.23、横梁 2.22 起，头顶按 2.2 算；上面的横梁和亮子当墙
    if (gd) { st.heads.push({ x0: -0.12, x1: T + 0.05, z0: gd.u0, z1: gd.u1, y: 2.2 }); boxes.push({ x0: -0.07, x1: T, z0: gd.u0, z1: gd.u1, y0: 2.2, y1: gH }); }
    // 吊灯（客厅正中，灯头最低在天花下 0.61）：在它下面跳，头顶到这为止；站高了（沙发坐面、茶几上）它就是一小块墙
    for (let f = 0; f < F; f++) for (const u of L.units) {
      if (Math.floor(sels[f] / Math.pow(4, u.no - 1)) % 4 !== 3) continue;
      const rm = u.living, cx = (rm.x0 + rm.x1) / 2, cz = (rm.z0 + rm.z1) / 2, yl = L.Y(f) + (f === 0 ? ceilG : ceilU) - 0.61;
      const rc = { x0: cx - 0.15, x1: cx + 0.15, z0: cz - 0.15, z1: cz + 0.15 };
      st.heads.push(Object.assign({ y: yl }, rc));
      boxes.push(Object.assign({ y0: yl, y1: yl + 0.6 }, rc));
    }
    st.ceil = ceilApt;
    st.lamps = { g: lampsG, u: lampsU };
    // 封面那间客厅的范围（局部坐标，一楼）：IN.update 每帧换算成世界坐标交给着色器
    if (L.hero) { const rm = L.hero.living; st.heroRect = { x0: rm.x0 - 0.03, x1: rm.x1 + 0.03, z0: rm.z0 - 0.03, z1: rm.z1 + 0.03, y0: -0.3, y1: L.Y(1) - 0.05 }; }
    st.surf = surfApt;
    st.ready = true;
  }

  // 公寓里某点头顶的楼板底（扣掉客厅灯带的 0.16）/ 阳台上一层阳台板底；楼梯井、电梯井里不限（轿厢另有限位）
  function ceilApt(st, lx, lz, ly, r) {
    const L = st.L, s = L.st, sh = L.sh;
    let best = Infinity;
    if (lx < 0.02 && lx > -1.45) {
      for (const b of st.balc || []) if (lz > b.z0 - r && lz < b.z1 + r) for (let f = 1; f < L.F; f++) if (Math.abs(ly - L.Y(f)) < 1.5) best = Math.min(best, L.Y(f + 1) - 0.14);
    }
    if (lx > -0.08 && lx < L.D && lz > -L.W / 2 && lz < L.W / 2) {
      const inStair = lx > s.xa - r && lx < s.xm1 + r && lz > s.iz0 - r && lz < s.iz1 + r;
      const inShaft = lx > sh.x0 - r && lx < sh.x1 + r && lz > sh.z0 - r && lz < sh.z1 + r;
      if (inShaft) { /* 电梯井：轿厢顶另有限位 */ }
      else if (inStair) best = Math.min(best, stairCeil(L, lx, lz, ly, r));
      else { let f = 0; for (let k = 0; k < L.F; k++) if (L.Y(k) <= ly + 0.05) f = k; best = Math.min(best, L.Y(f + 1) - 0.26 - 0.16); }
    }
    return best;
  }
  // 楼梯井里的头顶：按所在梯段（z 选 A/B 跑，脚下梯面选第几层）取正上方那一跑的底板 / 休息平台底 / 楼板边，取 [x-r, x+r] 里最低的
  function stairCeil(L, x, z, ly, r) {
    const s = L.st, F = L.F;
    const isA = Math.abs(z - (s.laneA[0] + s.laneA[1]) / 2) <= Math.abs(z - (s.laneB[0] + s.laneB[1]) / 2);
    const hf = (k) => L.rise(k) / 2, rsf = (k) => hf(k) / NSTEP, tread = RUN / NSTEP;
    const surf = (k) => (x <= s.xa ? (isA ? L.Y(k) : L.Y(k + 1)) : x >= s.xb ? L.Y(k) + hf(k)
      : isA ? L.Y(k) + Math.min(hf(k), ((x - s.xa) / tread + 0.5) * rsf(k)) : L.Y(k) + hf(k) + Math.min(hf(k), ((s.xb - x) / tread + 0.5) * rsf(k)));
    let k = 0; for (let q = 0; q < F - 1; q++) if (surf(q) <= ly + 0.05) k = q;
    const u = k + 1;
    if (u >= F - 1) return L.Y(F) - 0.42; // 最后一跑上面是屋顶楼板
    const h = hf(u), x0 = x - r, x1 = x + r;
    let c = Infinity;
    if (isA) {
      if (x0 < s.xa) c = Math.min(c, L.Y(u) - 0.42);
      if (x1 > s.xa && x0 < s.xb) c = Math.min(c, L.Y(u) + (Math.max(x0, s.xa) - s.xa) / RUN * h - 0.2);
    } else {
      if (x0 < s.xa) c = Math.min(c, L.Y(u + 1) - 0.42);
      if (x1 > s.xa && x0 < s.xb) c = Math.min(c, L.Y(u) + h + (s.xb - Math.min(x1, s.xb)) / RUN * h - 0.2);
    }
    if (x1 > s.xb) c = Math.min(c, L.Y(u) + h - 0.2);
    return c;
  }
  // 公寓里某点能站的最高面（不高于 yNow+0.5）
  function surfApt(st, x, z, yNow) {
    const L = st.L, s = L.st, sh = L.sh, el = st.el;
    let best = -Infinity;
    const ok = (h) => { if (h <= yNow + 0.5 && h > best) best = h; };
    if (x >= -0.08 && x <= L.D + 0.02 && z >= -L.W / 2 - 0.02 && z <= L.W / 2 + 0.02) {
      const inStair = x > s.xa && x < s.xm1 && z > s.iz0 && z < s.iz1;
      const inShaft = x > sh.x0 && x < sh.x1 && z > sh.z0 && z < sh.z1;
      if (inShaft) { ok(el.y); return best === -Infinity ? L.Y(0) - 1.2 : best; }
      for (let f = 0; f < L.F; f++) {
        const y = L.Y(f);
        if (y > yNow + 0.6) break;
        if (!inStair || f === 0) ok(y);
        if (inStair && f < L.F - 1) {
          const rr = L.rise(f), rs = rr / 2 / NSTEP, tread = RUN / NSTEP;
          if (x < s.xb) {
            if (z >= s.laneA[0] - 0.05 && z <= s.laneA[1] + 0.05) ok(y + Math.min(rr / 2, ((x - s.xa) / tread + 0.5) * rs));
            if (z >= s.laneB[0] - 0.05 && z <= s.laneB[1] + 0.05) ok(y + rr / 2 + Math.min(rr / 2, ((s.xb - x) / tread + 0.5) * rs));
          } else ok(y + rr / 2);
        }
      }
    }
    if (x < 0.02 && x > -1.32) {
      for (const b of st.balc) if (z > b.z0 && z < b.z1) for (let f = 1; f < L.F; f++) ok(L.Y(f) + 0.02);
    }
    return best;
  }

  function placeDoor(d) {
    if (d.kind === 'hinge') {
      d.mesh.setMatrixAt(d.i, m4(d.hx, d.hy, d.hz, d.yc + d.dy * ease(d.open)));
      d.mesh.instanceMatrix.needsUpdate = true;
    } else if (d.kind === 'slide') {
      const z = d.z0 + (d.z1 - d.z0) * ease(d.open);
      for (const m of d.meshes) { m.setMatrixAt(d.i, m4(d.x, d.y, z)); m.instanceMatrix.needsUpdate = true; }
    } else if (d.kind === 'pair') {
      for (const l of d.leaves) l.obj.rotation.y = l.yc + l.dy * ease(d.open);
    } else if (d.kind === 'glass') {
      d.obj.rotation.y = d.yc + d.dy * ease(d.open);
    }
  }
  const ease = (t) => t * t * (3 - 2 * t);

  function placeElevator(st) {
    const L = st.L, el = st.el, cab = L.cab, zc = L.sh.zc;
    el.cab.position.y = el.y; el.cab.updateMatrixWorld(true);
    const o = ease(el.doors) * 0.45;
    for (const m of el.cabDoors) { m.position.set(cab.x1 + 0.06, 1.05, zc + m.userData.sd * (0.235 + o)); }
    const near = Math.abs(el.y - L.Y(el.floor)) < 0.01;
    for (let f = 0; f < L.F; f++) {
      const of = near && f === el.floor ? o * 1.05 : 0, y = L.Y(f) + 1.075;
      el.hall.setMatrixAt(f * 2, m4(L.xc, y, zc - 0.26 - of));
      el.hall.setMatrixAt(f * 2 + 1, m4(L.xc, y, zc + 0.26 + of));
    }
    el.hall.instanceMatrix.needsUpdate = true;
  }

  // 电梯：排队、开关门、上下运行
  function updateElevator(st, dt, pl) {
    const L = st.L, el = st.el;
    const cab = L.cab, zc = L.sh.zc;
    const before = el.floor, dirB = el.dir;
    // 门口有人就不关门
    const inDoor = pl && pl.x > cab.x1 - 0.12 && pl.x < L.xc + 0.4 && Math.abs(pl.z - zc) < 0.5 && Math.abs(pl.y - el.y) < 1.0;
    // 人在轿厢里贴着门站、电梯又闲着：门自动打开（省得找"开"按钮）
    const atDoorIn = pl && pl.x > cab.x1 - 0.55 && pl.x < cab.x1 + 0.02 && Math.abs(pl.z - zc) < 0.5 && Math.abs(pl.y - el.y) < 0.6;
    switch (el.phase) {
      case 'idle':
        if (!el.queue.size && atDoorIn && Math.abs(el.y - L.Y(el.floor)) < 0.01) { el.phase = 'opening'; break; }
        if (el.queue.size) {
          // 顺路：先停上一趟运行方向上最近的楼层，那边没有了再掉头
          let best = -1, bd = 1e9;
          for (const pass of [true, false]) {
            for (const f of el.queue) {
              const d = L.Y(f) - el.y;
              if (pass && el.lastDir && Math.sign(d) !== el.lastDir && Math.abs(d) > 0.01) continue;
              if (Math.abs(d) < bd) { bd = Math.abs(d); best = f; }
            }
            if (best >= 0) break;
          }
          el.target = best;
          if (best === el.floor && Math.abs(el.y - L.Y(best)) < 0.01) { el.queue.delete(best); el.phase = 'opening'; refreshButtons(el); }
          else el.phase = 'moving';
        }
        break;
      case 'moving': {
        let d = L.Y(el.target) - el.y;
        el.dir = Math.sign(d); el.lastDir = el.dir;
        // 运行途中又按了沿途的楼层：同方向、还刹得住车，就先停那层
        const brake = el.v * el.v / (2 * 1.3) + 0.02;
        for (const f of el.queue) {
          const df = L.Y(f) - el.y;
          if (f !== el.target && Math.sign(df) === el.dir && Math.abs(df) < Math.abs(d) - 0.01 && Math.abs(df) > brake) { el.target = f; d = df; }
        }
        const ty = L.Y(el.target), ad = Math.abs(d);
        el.v = Math.min(el.v + 1.3 * dt, 2.2, Math.sqrt(2 * 1.3 * ad) + 0.05);
        const step = Math.min(ad, el.v * dt);
        el.y += el.dir * step;
        let nf = 0, nd = 1e9;
        for (let f = 0; f < L.F; f++) { const dd = Math.abs(L.Y(f) - el.y); if (dd < nd) { nd = dd; nf = f; } }
        el.floor = nf;
        if (ad - step < 0.002) {
          el.y = ty; el.floor = el.target; el.queue.delete(el.target); el.v = 0; el.dir = 0; el.phase = 'opening';
          refreshButtons(el);
          if (H.audio && H.audio.ding) H.audio.ding();
        }
        break;
      }
      case 'opening':
        el.doors = Math.min(1, el.doors + dt / 1.1);
        if (el.doors >= 1) { el.phase = 'open'; el.timer = 5; }
        break;
      case 'open':
        el.timer -= dt;
        if (el.timer <= 0 && !inDoor) el.phase = 'closing';
        break;
      case 'closing':
        if (inDoor) { el.phase = 'opening'; break; }
        el.doors = Math.max(0, el.doors - dt / 1.3);
        if (el.doors <= 0) el.phase = 'idle';
        break;
    }
    if (el.phase !== 'idle' || el.doors > 0) placeElevator(st);
    if (before !== el.floor || dirB !== el.dir) drawInd(el);
  }
  function callElevator(st, f) {
    const el = st.el;
    if (f === el.floor && el.phase !== 'moving' && Math.abs(el.y - st.L.Y(f)) < 0.01) {
      if (el.phase === 'open') el.timer = 5; else if (el.phase !== 'opening') el.phase = 'opening';
      return;
    }
    el.queue.add(f);
    refreshButtons(el);
  }
  // 面板和各层呼叫按钮：排着队的楼层亮橙色
  function refreshButtons(el) {
    for (let f = 0; f < el.F; f++) el.btn.setColorAt(f, col(el.queue.has(f) ? '#ffb547' : '#f2f2f2'));
    el.btn.instanceColor.needsUpdate = true;
    drawPanel(el);
  }

  // ======================================================================
  // 沿街商铺（一楼）
  // ======================================================================
  const SHOP = [
    { cat: 'mart', wall: '#f4f1ea', fl: 'iTile', flc: '#eceae4', acc: '#e85d4a' },      // 404 便利店
    { cat: 'cafe', wall: '#efe2cf', fl: 'iWood', flc: '#ffffff', acc: '#2f8f83' },       // 转角咖啡
    { cat: 'dine', wall: '#f3e6d3', fl: 'iTile', flc: '#e6dccb', acc: '#c96b3c' },       // 未找到面馆
    { cat: 'books', wall: '#f1ebe0', fl: 'iWood', flc: '#ffffff', acc: '#3b6fb6' },      // 页面书店
    { cat: 'salon', wall: '#eef0f3', fl: 'iTile', flc: '#f2f2f2', acc: '#8a5cc2' },      // 回车理发
    { cat: 'mart', wall: '#f2f3ee', fl: 'iTile', flc: '#e6e6e0', acc: '#3a9d5d' },       // 缓存超市
    { cat: 'flower', wall: '#f6efe9', fl: 'iWood', flc: '#ffffff', acc: '#e0699a' },     // 像素花店
    { cat: 'mart', wall: '#f5f8f6', fl: 'iTile', flc: '#f0f2f0', acc: '#2b7bb9' },       // 重定向药房
    { cat: 'cafe', wall: '#f7ebe0', fl: 'iTile', flc: '#f1e7dc', acc: '#d9a21b' },       // 超时奶茶
    { cat: 'bakery', wall: '#f6ead8', fl: 'iWood', flc: '#ffffff', acc: '#c96b3c' },     // 刷新烘焙
    { cat: 'garage', wall: '#e3e5e6', fl: 'iConc', flc: '#bdbab3', acc: '#556270' },     // 断点修车
    { cat: 'dine', wall: '#f0e3d0', fl: 'iWood', flc: '#ffffff', acc: '#1f9aa5' },       // 路由小馆
    { cat: 'fruit', wall: '#f3f1e6', fl: 'iTile', flc: '#e9e6dc', acc: '#3a9d5d' },      // 跳转水果
    { cat: 'studio', wall: '#f2f0ee', fl: 'iWood', flc: '#ffffff', acc: '#556270' },     // 加载中照相馆
    { cat: 'mart', wall: '#eceae6', fl: 'iConc', flc: '#d4d0c8', acc: '#556270' },       // 空指针五金
    { cat: 'laundry', wall: '#eef3f6', fl: 'iTile', flc: '#eef0f2', acc: '#1f9aa5' },    // 云端干洗
  ];
  const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);

  // 货架：沿 axis 方向的一排（axis 'x' 表示货架沿 x 走），levels 层，带一排排商品
  function shelf(S, boxes, x0, x1, z0, z1, h, levels, rng, opts = {}) {
    const C = col(opts.c || '#e9e6df'), alongX = (x1 - x0) >= (z1 - z0);
    S.cbox('iMetal', x0, 0, z0, x1, 0.12, z1, col(opts.base || '#9aa1a8'), 0.01);
    if (opts.back !== false) {
      if (alongX) S.box('iMetal', x0, 0.12, (z0 + z1) / 2 - 0.02, x1, h, (z0 + z1) / 2 + 0.02, C);
      else S.box('iMetal', (x0 + x1) / 2 - 0.02, 0.12, z0, (x0 + x1) / 2 + 0.02, h, z1, C);
    }
    for (let i = 1; i <= levels; i++) {
      const y = 0.12 + (h - 0.2) * i / levels - 0.03;
      S.box('iMetal', x0, y, z0, x1, y + 0.025, z1, C);
      if (i === levels) continue;
      // 商品：一格格的小盒子（书是一本本竖着的薄片，靠里放）
      const len = alongX ? x1 - x0 : z1 - z0, n = Math.floor(len / (opts.books ? 0.045 : 0.16));
      const gh = (h - 0.2) / levels * (opts.books ? 0.8 : 0.7);
      // 深度方向：书只占靠墙的 24cm（opts.wall = 'lo' 墙在小坐标那侧，'hi' 在大坐标那侧）
      const p0 = alongX ? z0 : x0, p1 = alongX ? z1 : x1;
      let q0 = p0 + 0.04, q1 = p1 - 0.04;
      if (opts.books) { if (opts.wall === 'hi') q0 = p1 - 0.28; else q1 = p0 + 0.28; }
      for (let k = 0; k < n; k++) {
        if (rng() < (opts.books ? 0.05 : 0.12)) continue;
        const a = (alongX ? x0 : z0) + (k + 0.08) * len / n, b = a + len / n * (opts.books ? 0.9 : 0.75);
        const hh = gh * (opts.books ? 0.7 + rng() * 0.3 : 0.55 + rng() * 0.45);
        const cc = opts.goods ? opts.goods(rng) : hsl(rng(), 0.55, 0.55);
        if (alongX) S.box('iGoods', a, y + 0.025, q0, b, y + 0.025 + hh, q1, cc);
        else S.box('iGoods', q0, y + 0.025, a, q1, y + 0.025 + hh, b, cc);
      }
    }
    boxes.push({ x0, x1, z0, z1, y0: 0, y1: h });
  }
  function counter(S, boxes, x0, x1, z0, z1, c, top) {
    S.cbox('iDoor', x0, 0, z0, x1, 0.98, z1, col(c), 0.015);
    S.cbox('iStone', x0 - 0.03, 0.98, z0 - 0.03, x1 + 0.03, 1.04, z1 + 0.03, col(top || '#e9e4da'), 0.012);
    boxes.push({ x0, x1, z0, z1, y0: 0, y1: 1.1 });
  }
  function tableSet(S, boxes, x, z, rng, c) {
    S.geo('iDoor', CYL(), m4(x, 0.74, z, 0, 0.42, 0.04, 0.42), col(c || '#f4efe6'));
    S.geo('iMetal', CYL(), m4(x, 0.37, z, 0, 0.04, 0.72, 0.04), col('#3d4248'));
    S.geo('iMetal', CYL(), m4(x, 0.02, z, 0, 0.22, 0.04, 0.22), col('#3d4248'));
    const cc = col(rng.pick(['#c98b5a', '#5f8f86', '#d9a441', '#8a6bb3']));
    for (const [dx, dz] of [[0.62, 0], [-0.62, 0], [0, 0.62], [0, -0.62]]) {
      if (rng() < 0.25) continue;
      S.cbox('iDoor', x + dx - 0.2, 0.44, z + dz - 0.2, x + dx + 0.2, 0.49, z + dz + 0.2, cc, 0.012);
      for (const [lx, lz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) legBox(S, 'iMetal', x + dx + lx - 0.015, 0, z + dz + lz - 0.015, x + dx + lx + 0.015, 0.44, z + dz + lz + 0.015, col('#3d4248'));
      if (Math.abs(dx) > 0) S.cbox('iDoor', x + dx + Math.sign(dx) * 0.18 - 0.02, 0.49, z + dz - 0.2, x + dx + Math.sign(dx) * 0.18 + 0.02, 0.92, z + dz + 0.2, cc, 0.01);
      else S.cbox('iDoor', x + dx - 0.2, 0.49, z + dz + Math.sign(dz) * 0.18 - 0.02, x + dx + 0.2, 0.92, z + dz + Math.sign(dz) * 0.18 + 0.02, cc, 0.01);
    }
    boxes.push({ x0: x - 0.55, x1: x + 0.55, z0: z - 0.55, z1: z + 0.55, y0: 0, y1: 0.95 });
  }

  // 一间店铺的陈设。xF..xB 是前厅进深范围，zL..zR 是店宽，门在 zR 那头（dz0..dz1）
  function shopProps(S, boxes, th, xF, xB, zL, zR, dz0, rng) {
    const cat = th.cat, acc = th.acc, mid = (zL + zR) / 2, wid = zR - zL;
    const zSafe = Math.min(zR, dz0 - 0.2);  // 门前留出通道
    if (cat === 'mart') {
      shelf(S, boxes, xF + 0.7, xB - 1.3, zL + 0.02, zL + 0.5, 1.9, 5, rng);
      if (wid > 4.6) shelf(S, boxes, xF + 2.0, xB - 1.9, mid - 0.4, mid + 0.4, 1.45, 4, rng, { back: true });
      shelf(S, boxes, xF + 2.2, xB - 1.3, zR - 0.5, zR - 0.02, 1.9, 5, rng);
      // 冷柜：后墙一排，玻璃门里亮着
      const fz0 = zL + 1.9, fz1 = Math.min(zR - 1.4, fz0 + 2.6); // 别挡住后屋门洞（zR-1.25 起）
      if (fz1 - fz0 > 1) {
        S.cbox('iMetal', xB - 0.7, 0, fz0, xB - 0.04, 2.0, fz1, col('#f2f4f5'), 0.02);
        S.box('iLamp', xB - 0.71, 0.25, fz0 + 0.06, xB - 0.7, 1.8, fz1 - 0.06, col('#dff2ff'));
        for (let z = fz0 + 0.6; z < fz1 - 0.1; z += 0.6) S.box('iMetal', xB - 0.73, 0.2, z - 0.02, xB - 0.7, 1.85, z + 0.02, col('#c9ced3'));
        boxes.push({ x0: xB - 0.72, x1: xB, z0: fz0, z1: fz1, y0: 0, y1: 2 });
      }
      counter(S, boxes, xF + 0.7, xF + 1.3, zL + 0.7, zL + 2.0, acc);
    } else if (cat === 'cafe' || cat === 'dine' || cat === 'bakery') {
      counter(S, boxes, xB - 1.1, xB - 0.5, zL + 0.3, Math.min(zR - 1.0, zL + 3.6), acc);
      if (cat === 'bakery') {
        S.quad('iGlass', [xB - 1.12, 1.04, zL + 0.3], [xB - 1.12, 1.04, Math.min(zR - 1.0, zL + 3.6)], [xB - 1.12, 1.5, Math.min(zR - 1.0, zL + 3.6)], [xB - 1.12, 1.5, zL + 0.3], [-1, 0, 0], WHITE);
        for (let z = zL + 0.5; z < Math.min(zR - 1.1, zL + 3.4); z += 0.3) S.geo('iGoods', SPH(), m4(xB - 0.8, 1.1, z, rng() * 3, 0.13, 0.07, 0.09), hsl(0.07 + rng() * 0.04, 0.6, 0.45 + rng() * 0.15));
        shelf(S, boxes, xF + 0.8, xB - 2.0, zL + 0.02, zL + 0.45, 1.6, 4, rng, { c: '#c99a6a', base: '#8a5a3c', goods: (r) => hsl(0.07 + r() * 0.05, 0.6, 0.45 + r() * 0.15) });
      } else {
        S.cbox('iMetal', xB - 0.95, 1.04, zL + 0.6, xB - 0.6, 1.5, zL + 1.0, col('#3d4248'), 0.015);   // 咖啡机 / 收银机
        S.cbox('iGoods', xB - 0.09, 1.7, zL + 0.4, xB - 0.065, 2.5, Math.min(zR - 1.3, zL + 3.2), col(acc), 0.006);  // 菜单板（贴在后墙前店那面）
      }
      // 桌子间距 1.8：两套桌椅之间留 0.7m，人能从中间走过去；烘焙店靠墙有货架，第一排往里让
      const zT0 = zL + (cat === 'bakery' ? 1.35 : 1.0);
      const cols = Math.max(1, Math.floor((xB - xF - 2.4) / 1.8)), rowsN = Math.max(1, Math.floor((zSafe - zT0 + 0.5) / 1.8));
      for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
        const x = xF + 1.0 + i * 1.8, z = zT0 + j * 1.8;
        if (x > xB - 1.9) continue;
        tableSet(S, boxes, x, z, rng, cat === 'dine' ? '#b98a5a' : null);
      }
    } else if (cat === 'books') {
      const bk = (r) => hsl(r(), 0.45, 0.35 + r() * 0.3);
      shelf(S, boxes, xF + 0.6, xB - 0.6, zL + 0.02, zL + 0.42, 2.2, 6, rng, { c: '#8a5a3c', base: '#6b4a32', goods: bk, books: true, wall: 'lo', back: false });
      shelf(S, boxes, xF + 2.2, xB - 0.6, zR - 0.42, zR - 0.02, 2.2, 6, rng, { c: '#8a5a3c', base: '#6b4a32', goods: bk, books: true, wall: 'hi', back: false });
      S.cbox('iDoor', xF + 2.0, 0, mid - 0.6, xF + 3.4, 0.8, mid + 0.6, col('#b98a5a'), 0.015);
      for (let k = 0; k < 8; k++) S.box('iGoods', xF + 2.1 + rng() * 1.1, 0.8, mid - 0.5 + rng() * 0.9, xF + 2.1 + rng() * 1.1 + 0.2, 0.84 + rng() * 0.06, mid - 0.5 + rng() * 0.9 + 0.15, bk(rng));
      boxes.push({ x0: xF + 2.0, x1: xF + 3.4, z0: mid - 0.6, z1: mid + 0.6, y0: 0, y1: 0.9 });
      counter(S, boxes, xB - 1.2, xB - 0.6, mid - 0.8, mid + 0.8, '#6b4a32');
    } else if (cat === 'salon') {
      const n = Math.max(1, Math.min(3, Math.floor((xB - xF - 1.5) / 1.5)));
      for (let i = 0; i < n; i++) {
        const x = xF + 1.4 + i * 1.5;
        S.quad('iSteel', [x - 0.45, 0.9, zL + 0.01], [x + 0.45, 0.9, zL + 0.01], [x + 0.45, 2.0, zL + 0.01], [x - 0.45, 2.0, zL + 0.01], [0, 0, 1], col('#eef2f5'));
        S.cbox('iDoor', x - 0.5, 0.75, zL + 0.02, x + 0.5, 0.8, zL + 0.35, col('#f4f1ea'), 0.008);
        S.geo('iMetal', CYL(), m4(x, 0.25, zL + 0.95, 0, 0.25, 0.5, 0.25), col('#3d4248'));
        S.cbox('iFabric', x - 0.3, 0.5, zL + 0.7, x + 0.3, 0.62, zL + 1.25, col(acc), 0.025);
        S.cbox('iFabric', x - 0.3, 0.62, zL + 1.15, x + 0.3, 1.25, zL + 1.27, col(acc), 0.025);
        boxes.push({ x0: x - 0.32, x1: x + 0.32, z0: zL + 0.65, z1: zL + 1.3, y0: 0, y1: 1.2 });
      }
      S.cbox('iFabric', xF + 0.4, 0, zSafe - 0.5, xF + 2.2, 0.45, zSafe - 0.05, col('#4a5a6a'), 0.025);
      boxes.push({ x0: xF + 0.4, x1: xF + 2.2, z0: zSafe - 0.5, z1: zSafe - 0.05, y0: 0, y1: 0.45, top: 0.45 }); // 等候长凳：能跳上去站
      counter(S, boxes, xB - 1.0, xB - 0.4, mid - 0.6, mid + 0.6, '#f4f1ea');
    } else if (cat === 'flower' || cat === 'fruit') {
      const pal = cat === 'flower' ? ['#ff6f91', '#ffd166', '#ef476f', '#c77dff', '#ff9f1c', '#ffffff', '#5fa8ff'] : ['#e8462e', '#f5a524', '#ffd23f', '#7bc043', '#9b3d8f', '#ff8c42'];
      for (const [zz0, zz1] of [[zL + 0.02, zL + 0.75], [zR - 0.75, zR - 0.02]]) {
        if (zz0 > zSafe - 0.5 && zz1 > dz0 - 0.2) continue;
        const xs0 = xF + (zz0 > mid ? 2.2 : 0.6);
        let xe = xs0;
        for (let x = xs0; x < xB - 1.0; x += 0.7) {
          xe = x + 0.62;
          S.cbox('iDoor', x, 0, zz0, x + 0.62, 0.55, zz1, col('#a8754a'), 0.015);
          for (let k = 0; k < 9; k++) S.geo('iGoods', SPH(), m4(x + 0.1 + rng() * 0.42, 0.62 + rng() * 0.1, zz0 + 0.1 + rng() * (zz1 - zz0 - 0.2), 0, 0.07, 0.07, 0.07), col(rng.pick(pal)));
          if (cat === 'flower') for (let k = 0; k < 4; k++) S.geo('iLeaf', SPH(), m4(x + 0.12 + rng() * 0.38, 0.75 + rng() * 0.25, zz0 + 0.15 + rng() * (zz1 - zz0 - 0.3), 0, 0.09, 0.12, 0.09), col('#4f8a3f'));
        }
        if (xe > xs0) boxes.push({ x0: xs0, x1: xe, z0: zz0, z1: zz1, y0: 0, y1: 0.8 });
      }
      counter(S, boxes, xB - 1.0, xB - 0.4, mid - 0.7, mid + 0.7, th.acc);
    } else if (cat === 'garage') {
      for (let k = 0; k < 4; k++) for (let j = 0; j < 3; j++) S.geo('iFabric', TOR(), m4(xB - 0.6 - k * 0.75, 0.12 + j * 0.24, zL + 0.45, 0, 0.3, 0.3, 0.3, PI / 2), col('#2a2d31'));
      boxes.push({ x0: xB - 3.25, x1: xB - 0.2, z0: zL + 0.05, z1: zL + 0.85, y0: 0, y1: 0.8 });
      S.cbox('iDoor', xF + 0.8, 0, zL + 0.02, xF + 2.8, 0.9, zL + 0.75, col('#8a6a4a'), 0.015);
      S.box('iMetal', xF + 0.8, 1.1, zL + 0.01, xF + 2.8, 2.2, zL + 0.03, col('#d0d4d8'));
      for (let k = 0; k < 10; k++) S.box('iGoods', xF + 0.9 + k * 0.19, 1.3 + rng() * 0.6, zL + 0.03, xF + 0.96 + k * 0.19, 1.5 + rng() * 0.6, zL + 0.06, hsl(rng(), 0.4, 0.4));
      boxes.push({ x0: xF + 0.8, x1: xF + 2.8, z0: zL, z1: zL + 0.78, y0: 0, y1: 1 });
      counter(S, boxes, xB - 1.0, xB - 0.4, mid, mid + 1.4, '#556270');
    } else if (cat === 'studio') {
      S.quad('iFabric', [xB - 0.1, 0, zL + 0.5], [xB - 0.1, 0, zR - 1.2], [xB - 0.1, 2.9, zR - 1.2], [xB - 0.1, 2.9, zL + 0.5], [-1, 0, 0], col('#dfe6ee'));
      S.cbox('iDoor', xB - 1.6, 0, mid - 0.25, xB - 1.1, 0.45, mid + 0.25, col('#c98b5a'), 0.02);   // 拍照凳
      boxes.push({ x0: xB - 1.6, x1: xB - 1.1, z0: mid - 0.25, z1: mid + 0.25, y0: 0, y1: 0.45, top: 0.45 }); // 能跳上去站
      for (const zz of [mid - 1.2, mid + 1.0]) {
        tube(S, 'iMetal', [xF + 2.0, 0, zz], [xF + 2.0, 1.8, zz], 0.02, col('#2b2f33'));
        S.cbox('iFabric', xF + 1.75, 1.7, zz - 0.3, xF + 2.25, 2.2, zz + 0.3, col('#f8f8f8'), 0.02);
        boxes.push({ x0: xF + 1.8, x1: xF + 2.2, z0: zz - 0.2, z1: zz + 0.2, y0: 0, y1: 2 });
      }
      counter(S, boxes, xF + 0.6, xF + 1.2, zL + 0.4, zL + 1.6, '#556270');
    } else { // laundry
      for (const zz of [zL + 0.45, mid]) {
        tube(S, 'iSteel', [xF + 1.0, 1.75, zz], [xB - 1.4, 1.75, zz], 0.018, col('#c3c8cd'));
        for (let x = xF + 1.1; x < xB - 1.5; x += 0.16) S.box('iFabric', x, 0.85 + rng() * 0.2, zz - 0.22, x + 0.05, 1.72, zz + 0.22, hsl(rng(), 0.35, 0.4 + rng() * 0.35));
        boxes.push({ x0: xF + 1.0, x1: xB - 1.4, z0: zz - 0.25, z1: zz + 0.25, y0: 0, y1: 1.8 });
      }
      counter(S, boxes, xB - 1.0, xB - 0.4, zR - 2.9, zR - 1.45, th.acc); // 收银台让开后屋门洞
    }
  }

  function* buildShop(st) {
    const r = st.rec, D = r.D, W = r.W, gH = r.gH;
    const grp = st.group, boxes = st.boxes = [], doors = st.doors = [];
    const bound = new THREE.Sphere(new THREE.Vector3(D / 2, r.Hb / 2, 0), 0.5 * Math.hypot(D + 4, r.Hb + 4, W + 4));
    const CEIL = 3.6;
    const holes = holesFrom(r, (w) => w.y < gH, 0, 0.02);
    const S = new Sink();
    S.unit = 0; // 店里夜里都亮着灯
    const front = { x0: -0.05, x1: D + 0.05, z0: -W / 2 - 0.05, z1: W / 2 + 0.05, R: r.R, t: T + 0.05, k: 'trim', c: r.frontCol, ki: 'iWall', ci: '#f2efe8', y0: 0, y1: gH, holes, bb: 0.02 };
    shell(S, front);
    ledge(S, 'trim', r.frontCol, front, { x0: 0, x1: D, z0: -W / 2, z1: W / 2, R: r.R }, gH);
    // 楼上（不能进）：实心楼身，下沿藏在吊顶上面
    S.geo(r.wallKey, H.bld.rbox(D, r.Hb - gH + 0.45, W, r.R, 2), m4(D / 2, gH - 0.45 + (r.Hb - gH + 0.45) / 2, 0), col(r.wallCol), true);
    S.quad('iCeil', [T, CEIL, -W / 2 + T], [D - T, CEIL, -W / 2 + T], [D - T, CEIL, W / 2 - T], [T, CEIL, W / 2 - T], [0, -1, 0], col('#f6f4ef'));
    glassFor(S, front, holes, ['shopwin']);
    const walls = [];
    const xb = D - T - 2.2;
    st.lampsAll = [];
    r.units.forEach((u, i) => {
      const th = SHOP[u.idx % SHOP.length];
      const z0 = u.z - u.w / 2, z1 = u.z + u.w / 2;
      const zi0 = z0 + (i === 0 ? T : PW / 2), zi1 = z1 - (i === r.units.length - 1 ? T : PW / 2);
      if (i > 0) walls.push({ axis: 'z', at: z0, from: T, to: D - T, th: PW, ops: [], c: '#f2efe8', k: 'iWall', y0: 0, y1: CEIL });
      walls.push({ axis: 'x', at: xb, from: zi0, to: zi1, th: 0.12, ops: [{ a: zi1 - 1.25, b: zi1 - 0.35, top: 2.1 }], c: th.wall, k: 'iWall', y0: 0, y1: CEIL });
      // 墙面刷店铺自己的颜色（贴在内墙面上的一层）
      for (const q of rectsMinus(zi0, zi1, 0, 0.4, holes.front)) S.quad('iWall', [T + 0.002, q.v0, q.u0], [T + 0.002, q.v0, q.u1], [T + 0.002, q.v1, q.u1], [T + 0.002, q.v1, q.u0], [1, 0, 0], col(th.acc));
      S.quad('iWall', [T, 0.02, zi0 + 0.002], [xb, 0.02, zi0 + 0.002], [xb, CEIL, zi0 + 0.002], [T, CEIL, zi0 + 0.002], [0, 0, 1], col(th.wall));
      S.quad('iWall', [T, 0.02, zi1 - 0.002], [xb, 0.02, zi1 - 0.002], [xb, CEIL, zi1 - 0.002], [T, CEIL, zi1 - 0.002], [0, 0, -1], col(th.wall));
      floorQuad(S, th.fl, th.flc, T, xb, z0 + (i === 0 ? T : 0), z1 - (i === r.units.length - 1 ? T : 0), 0.02);
      floorQuad(S, 'iConc', '#c8c3ba', xb, D - T, z0 + (i === 0 ? T : 0), z1 - (i === r.units.length - 1 ? T : 0), 0.02);
      floorQuad(S, 'iStone', '#d9d2c4', -0.05, T, u.z + u.dz - 0.6, u.z + u.dz + 0.6, 0.02);
      const rF = { x0: T, x1: xb, z0: zi0, z1: zi1 }, rB = { x0: xb, x1: D - T, z0: zi0, z1: zi1 };
      for (let x = T + 1.4; x < xb - 0.5; x += 2.4) for (let z = zi0 + 1.2; z < zi1 - 0.6; z += 2.4) { lampAt(S, x, z, CEIL, 0.6); st.lampsAll.push([x, CEIL - 0.25, z, rF]); }
      lampAt(S, (xb + D - T) / 2, (zi0 + zi1) / 2, CEIL, 0.4); st.lampsAll.push([(xb + D - T) / 2, CEIL - 0.25, (zi0 + zi1) / 2, rB]);
      shopProps(S, boxes, th, T, xb, zi0, zi1, u.z + u.dz - 0.6, H.rng(r.seed * 31 + i * 7));
      // 店门：单扇玻璃门，铰链在离橱窗远的那边，往里开
      const dz = u.z + u.dz, lw = 1.2 - 0.14;
      const lg = glassLeaf(lw, 2.55, '#2f3338'); // 顶到门框上横条（2.58），不留缝
      lg.position.set(0.0, 0.03, dz + 0.6 - 0.07);
      const d = { kind: 'glass', obj: lg, yc: PI, dy: -PI / 2, open: 0, target: 0, dur: 0.7, cx: 0.05, cy: 1.1, cz: dz, name: H.tex.SHOPS[u.idx] || '店门',
        blk: { x0: -0.12, x1: T + 0.1, z0: dz - 0.6, z1: dz + 0.6, y0: 0, y1: 2.6 } };
      lg.rotation.y = PI;
      grp.add(lg); doors.push(d);
      boxes.push({ x0: -0.05, x1: T, z0: zi0, z1: dz - 0.53, y0: 0, y1: gH }, { x0: -0.05, x1: T, z0: dz + 0.53, z1: zi1, y0: 0, y1: gH });
    });
    walls.forEach((w) => { w.unit = 0; });
    emitWalls(S, walls);
    S.unit = 0;
    wallColliders(boxes, walls, 0);
    // 不能站的矮陈设碰撞至少 1.3 高：跳不进去（从人行道冲进店门、站在长凳上再跳，脚最高到 1.2 左右）
    for (const b of boxes) if (b.top === undefined) b.y1 = Math.max(b.y1, 1.3);
    st.tops = boxes.filter((b) => b.top !== undefined);
    // 头顶限位：后屋门的门楣、店门门框上沿；店里吊顶在 ceilShop
    st.heads = [];
    for (const w of walls) for (const o of wallSegs(w).ops) if (o.top < w.y1) {
      const b = wallBox(w.axis, w.at, w.th, Math.max(o.a, w.from), Math.min(o.b, w.to), o.top, w.y1);
      boxes.push(b); st.heads.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y: o.top });
    }
    r.units.forEach((u) => {
      const dz = u.z + u.dz;
      st.heads.push({ x0: -0.12, x1: T + 0.05, z0: dz - 0.6, z1: dz + 0.6, y: 2.58 });
      boxes.push({ x0: -0.05, x1: T, z0: dz - 0.53, z1: dz + 0.53, y0: 2.58, y1: gH }); // 店门上方的门框和墙
    });
    st.ceil = (s2, lx, lz) => (lx > -0.05 && lx < D && lz > -W / 2 && lz < W / 2 ? CEIL - 0.02 : Infinity);
    // 外墙其余三面 + 分户处正面的墙垛
    boxes.push({ x0: D - T, x1: D + 0.05, z0: -W / 2, z1: W / 2, y0: 0, y1: r.Hb });
    boxes.push({ x0: -0.05, x1: D + 0.05, z0: -W / 2 - 0.05, z1: -W / 2 + T, y0: 0, y1: r.Hb });
    boxes.push({ x0: -0.05, x1: D + 0.05, z0: W / 2 - T, z1: W / 2 + 0.05, y0: 0, y1: r.Hb });
    r.units.forEach((u, i) => { if (i > 0) { const z0 = u.z - u.w / 2; boxes.push({ x0: -0.05, x1: T, z0: z0 - PW, z1: z0 + PW, y0: 0, y1: gH }); } });
    S.build(grp, { bound, inst: [new THREE.Matrix4()], mask: [255] });
    st.surf = (s2, x, z, yNow) => (x >= -0.08 && x <= D && z >= -W / 2 && z <= W / 2 && 0.02 <= yNow + 0.5 ? 0.02 : -Infinity);
    st.lamps = { g: st.lampsAll, u: [] };
    yield;
    st.ready = true;
  }

  // ======================================================================
  // 打开 / 关闭、每帧更新
  // ======================================================================
  const open = new Map();   // 建筑 id -> 状态
  IN.open = open;
  IN.boxes = [];            // 打开的楼的包围盒（渲染坐标）：屋里不下雨
  IN.indoor = null;         // 玩家在哪栋楼里
  let scanT = 0, lights = [];

  IN.init = function (scene) {
    for (let i = 0; i < 2; i++) { const l = new THREE.PointLight(0xfff0d8, 0, 9, 2); scene.add(l); lights.push(l); }
  };
  IN.isOpen = (id) => { const s = open.get(id); return !!(s && s.ready && s.shown); };
  // 调试用：只算户型、墙和家具碰撞盒（标准层，楼层局部坐标），不建网格
  IN._plan = function (rec) {
    if (rec.type !== 'apt') return null;
    const L = layoutApt(rec), S = new Sink();
    const ceil = rec.fH - 0.26;
    for (const u of L.units) { u.furn = []; livingRoom(S, L, u, ceil, u.furn); const fr = H.rng(rec.seed * 59 + u.no * 7); bedrooms(S, u.furn, fr, u); bathroom(S, u.furn, fr, u); }
    const walls = aptWalls(L, ceil, 'typ'), boxes = [];
    wallColliders(boxes, walls, 0);
    return { L, walls, boxes };
  };

  // 封面：K403+997 那间公寓客厅。开局前把这栋楼同步生成好，返回镜头脚底位置（渲染坐标）、朝向和里程
  IN.cover = function () {
    const ch = H.world.chunks.get(0);
    const rec = ch && ch.blds.find((r) => heroLz(r) !== null);
    if (!rec) return null;
    const st = open.get(rec.id) || openBuilding(rec);
    while (!st.ready) st.gen.next();
    if (!st.shown) show(st);
    const L = st.L, u = L.hero;
    if (!u) return null;
    // 站在沙发那面墙边、客厅靠里，斜着朝窗户和电视墙的墙角看：左边一片空墙放标题，中间是窗外的街和饮水机，右边电视在放新闻
    const rm = u.living, zi0 = rm.z0 + 0.07, zi1 = rm.z1 - 0.07, zt = u.livOuter < 0 ? zi1 : zi0, td = zt === zi0 ? 1 : -1;
    const lx = rm.x0 + 2.7, lz = (td > 0 ? zi1 : zi0) - td * 0.39, dx = -1, dz = -0.5 * td;
    const wx = st.c * dx + st.s * dz, wz = -st.s * dx + st.c * dz;
    const pos = new THREE.Vector3(st.ox + st.c * lx + st.s * lz, SY() + L.Y(0), st.oz - st.s * lx + st.c * lz + st.ch.group.position.z);
    // 里程按这间房的位置算（K403+997），不按镜头站的地方
    return { pos, yaw: Math.atan2(-wx, -wz), pitch: 0.02, km: H.world.km(HERO_Z - H.world.originZ), id: rec.id };
  };
  // 调试用：把商铺整个生成一遍（不挂到场景里），返回碰撞盒、门和每间店的范围，然后丢掉网格
  IN._planShop = function (rec) {
    if (rec.type !== 'shop') return null;
    const st = { rec, group: new THREE.Group(), boxes: [], doors: [] };
    const g = buildShop(st);
    while (!st.ready) g.next();
    st.group.traverse((o) => { if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    const xb = rec.D - T - 2.2;
    const units = rec.units.map((u, i) => ({ zi0: u.z - u.w / 2 + (i === 0 ? T : PW / 2), zi1: u.z + u.w / 2 - (i === rec.units.length - 1 ? T : PW / 2), dz: u.z + u.dz, cat: SHOP[u.idx % SHOP.length].cat }));
    return { boxes: st.boxes, doors: st.doors, xb, units };
  };
  function recAABB(rec) {
    if (rec.aabb) return rec.aabb;
    const c = Math.cos(rec.ry), s = Math.sin(rec.ry);
    const xs = [], zs = [];
    for (const [bx, bz] of [[-1.4, -rec.W / 2], [rec.D, -rec.W / 2], [-1.4, rec.W / 2], [rec.D, rec.W / 2]]) { xs.push(rec.ox + c * bx + s * bz); zs.push(rec.oz - s * bx + c * bz); }
    rec.aabb = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    return rec.aabb;
  }
  function distTo(rec, gz, p) {
    const a = recAABB(rec);
    const dx = Math.max(a.x0 - p.x, 0, p.x - a.x1), dz = Math.max(a.z0 + gz - p.z, 0, p.z - (a.z1 + gz));
    return Math.hypot(dx, dz);
  }
  function openBuilding(rec) {
    const st = { rec, ch: rec.ch, ready: false, shown: false, boxes: [], doors: [], c: Math.cos(rec.ry), s: Math.sin(rec.ry), ox: rec.ox, oz: rec.oz };
    st.group = new THREE.Group();
    st.group.position.set(rec.ox, SY(), rec.oz); st.group.rotation.y = rec.ry;
    st.group.updateMatrix();
    st.gen = rec.type === 'apt' ? buildApt(st) : buildShop(st);
    open.set(rec.id, st);
    return st;
  }
  function show(st) {
    st.shown = true;
    H.hideRanges(st.ch.hide['h' + st.rec.id], true);
    if (st.ch.detail) H.detail.setHidden(st.ch.detail, st.rec.id, true);
    st.ch.group.add(st.group);
  }
  function closeBuilding(st) {
    if (st.shown) {
      H.hideRanges(st.ch.hide['h' + st.rec.id], false);
      if (st.ch.detail) H.detail.setHidden(st.ch.detail, st.rec.id, false);
      st.ch.group.remove(st.group);
    }
    st.group.traverse((o) => { if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    if (st.el) { st.el.ptex.dispose(); st.el.itex.dispose(); st.el.pmat.dispose(); st.el.imat.dispose(); st.el.btn.material.dispose(); }
    open.delete(st.rec.id);
  }
  IN.dropChunk = function (ch) { for (const st of [...open.values()]) if (st.ch === ch) closeBuilding(st); };

  // 渲染坐标 <-> 建筑局部坐标
  function toLocal(st, x, z) {
    const dx = x - st.ox, dz = z - st.ch.group.position.z - st.oz;
    return [st.c * dx - st.s * dz, st.s * dx + st.c * dz];
  }
  function inFoot(st, lx, lz, ly) {
    const r = st.rec;
    return lx > 0.05 && lx < r.D - 0.05 && lz > -r.W / 2 + 0.05 && lz < r.W / 2 - 0.05 && ly > -0.4 && ly < r.Hb;
  }

  IN.update = function (dt, camPos, playerPos, walking) {
    // 1) 每 0.25 秒挑一次要打开的楼：离镜头最近的几栋（开车、骑车、标题画面时不新开，只关远的）
    scanT -= dt;
    if (scanT <= 0) {
      scanT = 0.25;
      const cand = [];
      for (const ch of H.world.chunks.values()) {
        if (!ch.ready || !ch.blds.length) continue;
        const gz = ch.group.position.z;
        if (gz > camPos.z + ACT_R + 2 || gz + 64 < camPos.z - ACT_R - 2) continue;
        for (const rec of ch.blds) { if (rec.noInterior) continue; const d = distTo(rec, gz, camPos); if (d < ACT_R) cand.push([d, rec]); }
      }
      cand.sort((a, b) => a[0] - b[0]);
      const want = new Set(cand.slice(0, MAX_OPEN).map((c) => c[1].id));
      if (IN.indoor) want.add(IN.indoor.rec.id);
      if (walking) for (const [, rec] of cand.slice(0, MAX_OPEN)) if (!open.has(rec.id)) openBuilding(rec);
      // 不再需要的：没生成完的直接丢；生成好的离远了、或者开着的楼太多了才关
      const extra = [...open.values()].filter((st) => !want.has(st.rec.id))
        .map((st) => [distTo(st.rec, st.ch.group.position.z, camPos), st]).sort((a, b) => b[0] - a[0]);
      let n = open.size;
      for (const [d, st] of extra) if (!st.ready || d > DEACT_R || n > MAX_OPEN + 1) { closeBuilding(st); n--; }
    }
    // 2) 分帧生成，生成好了再换上（换之前一直是原来的实心楼）
    // 生成出错的楼（某种没料到的尺寸）：记下来以后不再开，一直保持原来的实心楼，别让整个游戏卡死
    const t0 = performance.now();
    for (const st of [...open.values()]) {
      if (st.ready) { if (!st.shown) show(st); continue; }
      try { while (!st.ready && performance.now() - t0 < 4) st.gen.next(); }
      catch (e) { console.warn('interior: 楼', st.rec.id, st.rec.type, '生成失败', e); st.rec.noInterior = true; closeBuilding(st); continue; }
      if (st.ready) show(st);
      if (performance.now() - t0 >= 4) break;
    }
    // 3) 门、电梯动画；玩家在哪栋楼里
    IN.indoor = null; IN.balcony = false;
    IN.boxes.length = 0;
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown) continue;
      const [lx, lz] = toLocal(st, playerPos.x, playerPos.z), ly = playerPos.y - sy;
      const here = walking && inFoot(st, lx, lz, ly);
      if (here) IN.indoor = st;
      if (walking && st.balc && lx > -1.4 && lx <= 0.05 && ly > 1 && st.balc.some((b) => lz > b.z0 && lz < b.z1)) IN.balcony = true;
      for (const d of st.doors) {
        if (d.open === d.target) continue;
        d.open = d.target > d.open ? Math.min(d.target, d.open + dt / d.dur) : Math.max(d.target, d.open - dt / d.dur);
        placeDoor(d);
      }
      if (st.el) updateElevator(st, dt, walking ? { x: lx, z: lz, y: ly } : null);
      // 包围盒只框楼身（不含阳台），阳台上照样淋雨
      const gz = st.ch.group.position.z, r = st.rec, xs = [], zs = [];
      for (const [bx, bz] of [[0, -r.W / 2], [r.D, -r.W / 2], [0, r.W / 2], [r.D, r.W / 2]]) { xs.push(st.ox + st.c * bx + st.s * bz); zs.push(st.oz - st.s * bx + st.c * bz + gz); }
      const bx = { x0: Math.min(...xs), x1: Math.max(...xs), y0: sy - 0.6, y1: sy + r.Hb + 0.4, z0: Math.min(...zs), z1: Math.max(...zs) };
      // 雨雪着色器只收前几个：玩家所在的那栋排第一个
      if (here) IN.boxes.unshift(bx); else IN.boxes.push(bx);
    }
    // 封面那间的世界包围盒（没打开就给一个空盒子）
    let hst = null;
    for (const st of open.values()) if (st.shown && st.heroRect) hst = st;
    if (hst) {
      const r = hst.heroRect, gz = hst.ch.group.position.z, xs = [], zs = [];
      for (const [bx, bz] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) { xs.push(hst.ox + hst.c * bx + hst.s * bz); zs.push(hst.oz - hst.s * bx + hst.c * bz + gz); }
      IU.uHeroMin.value.set(Math.min(...xs), sy + r.y0, Math.min(...zs)); IU.uHeroMax.value.set(Math.max(...xs), sy + r.y1, Math.max(...zs));
    } else { IU.uHeroMin.value.set(1e6, 1e6, 1e6); IU.uHeroMax.value.set(-1e6, -1e6, -1e6); }
    // 4) 屋里的环境光跟着天色走；两盏补光灯跟着玩家所在楼层最近的顶灯走
    const night = H.sky.lightsOn || 0;
    const day = H.clamp(H.sky.hemi.intensity * 0.6 + H.sky.sun.intensity * 0.18, 0.08, 1);
    IU.uNight.value = night; IU.uNightGlow.value = night * 0.55;
    IU.uBounce.value.setRGB(1.0, 0.96, 0.9).multiplyScalar(0.05 + day * 0.3 + night * 0.08);
    if (IN.indoor) {
      const st = IN.indoor, [lx, lz] = toLocal(st, playerPos.x, playerPos.z), ly = playerPos.y - sy;
      let list = st.lamps.g, yb = st.L ? st.L.Y(0) : 0, inCab = false;
      if (st.L) { let f = 0; for (let k = 0; k < st.L.F; k++) if (st.L.Y(k) <= ly + 0.6) f = k; if (f > 0) { list = st.lamps.u; yb = st.L.Y(f); } }
      // 人在电梯轿厢里：补光灯挂到轿厢顶灯下面（不然夜里轿厢里黑的）
      if (st.el) {
        const cab = st.L.cab, el = st.el;
        if (lx > cab.x0 && lx < cab.x1 + 0.05 && lz > cab.z0 && lz < cab.z1 && ly > el.y - 0.3 && ly < el.y + cab.h) { list = [[(cab.x0 + cab.x1) / 2, cab.h - 0.2, (cab.z0 + cab.z1) / 2, null]]; yb = el.y; inCab = true; }
      }
      // 先挑玩家所在房间里的灯（隔着墙的灯照不过来），房间里没有就用最近的
      const inRm = list.filter((p) => !p[3] || (lx > p[3].x0 - 0.2 && lx < p[3].x1 + 0.2 && lz > p[3].z0 - 0.2 && lz < p[3].z1 + 0.2));
      const near = (inRm.length ? inRm : list).map((p) => [p, (p[0] - lx) ** 2 + (p[2] - lz) ** 2]).sort((a, b) => a[1] - b[1]);
      lights.forEach((l, i) => {
        const p = near[i];
        if (!p || (i > 0 && inRm.length === 1)) { l.intensity = 0; return; }
        const x = st.ox + st.c * p[0][0] + st.s * p[0][2], z = st.oz - st.s * p[0][0] + st.c * p[0][2] + st.ch.group.position.z;
        l.position.set(x, sy + yb + p[0][1], z);
        l.intensity = inCab ? 0.45 + night * 0.35 : 0.9 + night * 0.9; // 轿厢小、四壁是拉丝钢板，灯太亮会照出一块刺眼的高光
      });
    } else lights.forEach((l) => { l.intensity = 0; });
  };
  IN.inside = function (x, y, z) {
    for (const b of IN.boxes) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.y1) return true;
    return false;
  };

  // ---------- 碰撞（只给步行的玩家用） ----------
  function pushOut(o, y, r, b) {
    if (y + 1.7 < b.y0 || y > b.y1) return;
    if (b.top !== undefined && y >= b.top - H.world.STEP) return; // 能站的顶：脚够高了就踩上去，不挡
    const cx = H.clamp(o.x, b.x0, b.x1), cz = H.clamp(o.z, b.z0, b.z1);
    const dx = o.x - cx, dz = o.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    if (d2 > 1e-8) { const d = Math.sqrt(d2), k = (r - d) / d; o.x += dx * k; o.z += dz * k; return; }
    const opts = [[o.x - b.x0 + r, -1, 0], [b.x1 - o.x + r, 1, 0], [o.z - b.z0 + r, 0, -1], [b.z1 - o.z + r, 0, 1]];
    opts.sort((p, q) => p[0] - q[0]);
    o.x += opts[0][1] * opts[0][0]; o.z += opts[0][2] * opts[0][0];
  }
  IN.collide = function (pos, r) {
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown) continue;
      const [lx, lz] = toLocal(st, pos.x, pos.z);
      const R = st.rec;
      if (lx < -3 || lx > R.D + 3 || lz < -R.W / 2 - 3 || lz > R.W / 2 + 3) continue;
      const y = pos.y - sy, o = { x: lx, z: lz };
      for (const b of st.boxes) pushOut(o, y, r, b);
      for (const d of st.doors) if (d.open < 0.8) pushOut(o, y, r, d.blk);
      if (st.el) {
        const L = st.L, el = st.el, cab = L.cab, zc = L.sh.zc;
        // 各层厅门：轿厢不在这层、或门没开够，就是一堵墙
        for (let f = 0; f < L.F; f++) {
          const here = Math.abs(el.y - L.Y(f)) < 0.05 && el.doors > 0.8;
          if (!here) pushOut(o, y, r, { x0: L.xc - PW / 2, x1: L.xc + PW / 2, z0: zc - 0.52, z1: zc + 0.52, y0: L.Y(f), y1: L.Y(f) + 2.1 });
        }
        // 轿厢的三面墙 + 门
        const cy0 = el.y, cy1 = el.y + 2.4;
        pushOut(o, y, r, { x0: cab.x0 - 0.2, x1: cab.x0, z0: cab.z0 - 0.1, z1: cab.z1 + 0.1, y0: cy0, y1: cy1 });
        pushOut(o, y, r, { x0: cab.x0 - 0.1, x1: cab.x1 + 0.05, z0: cab.z0 - 0.2, z1: cab.z0, y0: cy0, y1: cy1 });
        pushOut(o, y, r, { x0: cab.x0 - 0.1, x1: cab.x1 + 0.05, z0: cab.z1, z1: cab.z1 + 0.2, y0: cy0, y1: cy1 });
        pushOut(o, y, r, { x0: cab.x1, x1: cab.x1 + 0.08, z0: cab.z0, z1: zc - 0.45, y0: cy0, y1: cy1 });
        pushOut(o, y, r, { x0: cab.x1, x1: cab.x1 + 0.08, z0: zc + 0.45, z1: cab.z1, y0: cy0, y1: cy1 });
        if (el.doors < 0.8) pushOut(o, y, r, { x0: cab.x1, x1: cab.x1 + 0.08, z0: zc - 0.45, z1: zc + 0.45, y0: cy0, y1: cy1 });
      }
      const ddx = o.x - lx, ddz = o.z - lz;
      pos.x += st.c * ddx + st.s * ddz; pos.z += -st.s * ddx + st.c * ddz;
    }
  };
  // 玩家脚下是不是电梯轿厢：返回轿厢的竖直速度和轿厢顶（渲染坐标），起跳时继承速度、跳起来不穿顶
  IN.platform = function (x, z, y) {
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown || !st.el) continue;
      const [lx, lz] = toLocal(st, x, z), cab = st.L.cab, el = st.el, ly = y - sy;
      if (lx > cab.x0 && lx < cab.x1 + 0.05 && lz > cab.z0 && lz < cab.z1 && ly > el.y - 0.3 && ly < el.y + cab.h)
        return { vy: el.phase === 'moving' ? el.dir * el.v : 0, top: sy + el.y + cab.h };
    }
    return null;
  };
  // walker = 步行的玩家：只有他能踩"能站的顶"（床、沙发坐面、茶几……），规则和 pushOut 共用 STEP / LEDGE
  IN.surfaceY = function (x, z, yNow, walker) {
    let best = -Infinity;
    const sy = SY(), STEP = H.world.STEP, LG = H.world.LEDGE;
    for (const st of open.values()) {
      if (!st.shown) continue;
      const [lx, lz] = toLocal(st, x, z);
      const R = st.rec;
      if (lx < -1.5 || lx > R.D + 0.2 || lz < -R.W / 2 - 0.2 || lz > R.W / 2 + 0.2) continue;
      const ly = yNow - sy;
      const h = st.surf(st, lx, lz, ly);
      if (h > -Infinity && h + sy > best) best = h + sy;
      if (walker && st.tops) for (const t of st.tops) {
        if (ly < t.top - STEP || t.top + sy <= best) continue;
        const dx = Math.max(t.x0 - lx, 0, lx - t.x1), dz = Math.max(t.z0 - lz, 0, lz - t.z1);
        if (dx * dx + dz * dz <= LG * LG) best = t.top + sy;
      }
    }
    return best;
  };
  // 头顶限位（渲染坐标）：楼板底、阳台板底、门楣、店里吊顶；只算比站直时头顶还高的（矮的算墙）
  IN.ceilingY = function (x, z, feet, r = 0.32) {
    let best = Infinity;
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown || !st.ceil) continue;
      const [lx, lz] = toLocal(st, x, z);
      const R = st.rec;
      if (lx < -2 || lx > R.D + 1 || lz < -R.W / 2 - 1 || lz > R.W / 2 + 1) continue;
      const ly = feet - sy, need = ly + 1.7;
      const c = st.ceil(st, lx, lz, ly, r);
      // 楼板、梯段底板这类整片的顶不会像墙：门槛放宽到脚上 1.4（斜着往下的梯段底板一帧能降好几厘米，1.7 会一帧漏掉）
      if (c >= ly + 1.4 && c + sy < best) best = c + sy;
      for (const hd of st.heads || []) {
        if (hd.y < need || hd.y + sy >= best) continue;
        const dx = Math.max(hd.x0 - lx, 0, lx - hd.x1), dz = Math.max(hd.z0 - lz, 0, lz - hd.z1);
        if (dx * dx + dz * dz < r * r) best = hd.y + sy;
      }
    }
    return best;
  };
  // 起跳时人在不在楼里（含阳台）：现算当前位置，不用上一帧的 IN.indoor —— 在屋里、阳台上都按室内跳
  IN.indoorAt = function (p) {
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown) continue;
      const [lx, lz] = toLocal(st, p.x, p.z), ly = p.y - sy;
      if (inFoot(st, lx, lz, ly)) return true;
      if (st.balc && lx > -1.4 && lx <= 0.05 && ly > 1 && st.balc.some((b) => lz > b.z0 && lz < b.z1)) return true;
    }
    return false;
  };

  // ---------- 瞄准互动：门、电梯按钮 ----------
  let aimed = null;
  IN.aim = function (cam) {
    aimed = null;
    let best = 9;
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const sy = SY();
    for (const st of open.values()) {
      if (!st.shown) continue;
      const [ox, oz] = toLocal(st, cam.position.x, cam.position.z), oy = cam.position.y - sy;
      const R = st.rec;
      if (ox < -4 || ox > R.D + 4 || oz < -R.W / 2 - 4 || oz > R.W / 2 + 4) continue;
      const dx = st.c * dir.x - st.s * dir.z, dz = st.s * dir.x + st.c * dir.z, dy = dir.y;
      const test = (px, py, pz, rad, maxD) => {
        const vx = px - ox, vy = py - oy, vz = pz - oz;
        const al = vx * dx + vy * dy + vz * dz;
        if (al < 0.15 || al > maxD) return -1;
        const p2 = vx * vx + vy * vy + vz * vz - al * al;
        return p2 < rad * rad ? al : -1;
      };
      for (const d of st.doors) {
        if (Math.abs(d.cy - oy) > 1.6) continue; // 别隔着楼板瞄到楼上楼下的门
        const a = test(d.cx, d.cy, d.cz, 0.62, 2.6);
        if (a > 0 && a < best) { best = a; aimed = { st, door: d, label: `按 E ${d.target ? '关门' : '开门'}${d.name ? ' · ' + d.name : ''}` }; }
      }
      const el = st.el;
      if (el) {
        const L = st.L;
        // 轿厢里的按钮面板
        const p = el.panel, py = el.y + p.y, cab = L.cab;
        const inCab = ox > cab.x0 && ox < cab.x1 + 0.05 && oz > cab.z0 && oz < cab.z1 && oy > el.y && oy < el.y + cab.h;
        if (inCab && Math.abs(dz) > 1e-4) {
          const t = (p.z - oz) / dz;
          if (t > 0.1 && t < 1.6) {
            const hx = ox + dx * t, hy = oy + dy * t;
            const u = 0.5 - (hx - p.x) / p.w, v = 0.5 + (hy - py) / p.h;
            if (u > 0 && u < 1 && v > 0 && v < 1 && t < best) {
              const { rows } = panelLayout(el.F);
              const rr = Math.floor(v * rows), cc = Math.floor(u * 2);
              let b = null;
              if (rr === 0) b = cc === 0 ? -2 : -3; else { const i = (rr - 1) * 2 + cc; if (i < el.F) b = i; }
              if (b !== null) { best = t; aimed = { st, btn: b, label: b === -2 ? '按 E 开门' : b === -3 ? '按 E 关门' : `按 E 去 ${b + 1} 楼` }; }
            }
          }
        }
        for (let f = 0; f < L.F; f++) {
          const bp = el.btnFloor(f);
          if (Math.abs(bp[1] - oy) > 2) continue;
          const a = test(bp[0], bp[1], bp[2], 0.3, 2.2);
          if (a > 0 && a < best) { best = a; aimed = { st, call: f, label: el.floor === f && el.phase !== 'moving' ? '按 E 开电梯门' : '按 E 呼叫电梯' }; }
        }
      }
    }
    // 面板上高亮瞄着的按钮
    for (const st of open.values()) if (st.el) {
      const h = aimed && aimed.st === st && aimed.btn !== undefined ? aimed.btn : null;
      if (st.el.hover !== h) { st.el.hover = h; drawPanel(st.el); }
    }
    return aimed ? aimed.label : null;
  };
  IN.interact = function () {
    if (!aimed) return false;
    const a = aimed;
    if (a.door) {
      a.door.target = a.door.target ? 0 : 1;
      if (H.audio) { if (a.door.kind === 'slide') H.audio.thunk(260, 0.08); else H.audio.doorCreak ? H.audio.doorCreak(!!a.door.target) : H.audio.thunk(150, 0.12); }
    } else if (a.btn !== undefined) {
      const el = a.st.el;
      if (a.btn === -2) { if (el.phase !== 'moving') { el.phase = el.phase === 'open' ? 'open' : 'opening'; el.timer = 5; } }
      else if (a.btn === -3) { if (el.phase === 'open') el.timer = 0; }
      else callElevator(a.st, a.btn);
      if (H.audio) H.audio.thunk(900, 0.04);
    } else if (a.call !== undefined) {
      callElevator(a.st, a.call);
      if (H.audio) H.audio.thunk(900, 0.04);
    }
    return true;
  };
})();
