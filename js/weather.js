// 天气：状态机 + 平滑过渡 + 雨丝/水花/冰雹/雪花/闪电
'use strict';
(function () {
  const W = H.weather = {};
  const ROOM_N = 6; // 雨雪着色器最多屏蔽几栋打开的楼（室内 MAX_OPEN=4，关楼前还会多开一两栋）

  W.TYPES = {
    clear:   { name: '晴天', icon: '☀️', cover: 0.12, overcast: 0.0, rain: 0, hail: 0, snow: 0, fog: 720, fogTint: 0, lightning: 0, wind: 0.15, wetMax: 0 },
    cloudy:  { name: '多云', icon: '⛅', cover: 0.58, overcast: 0.35, rain: 0, hail: 0, snow: 0, fog: 600, fogTint: 0, lightning: 0, wind: 0.35, wetMax: 0 },
    drizzle: { name: '小雨', icon: '🌦️', cover: 0.82, overcast: 0.6, rain: 0.28, hail: 0, snow: 0, fog: 330, fogTint: 0, lightning: 0, wind: 0.3, wetMax: 0.65 },
    rain:    { name: '大雨', icon: '🌧️', cover: 0.96, overcast: 0.85, rain: 1.0, hail: 0, snow: 0, fog: 210, fogTint: 0, lightning: 0, wind: 0.65, wetMax: 1 },
    storm:   { name: '雷暴', icon: '⛈️', cover: 1.0, overcast: 1.0, rain: 1.0, hail: 0, snow: 0, fog: 175, fogTint: 0, lightning: 1, wind: 0.95, wetMax: 1 },
    hail:    { name: '冰雹', icon: '🧊', cover: 0.97, overcast: 0.88, rain: 0.3, hail: 1, snow: 0, fog: 250, fogTint: 0, lightning: 0.4, wind: 0.7, wetMax: 0.8 },
    snow:    { name: '下雪', icon: '❄️', cover: 0.9, overcast: 0.62, rain: 0, hail: 0, snow: 1, fog: 190, fogTint: 0.4, lightning: 0, wind: 0.3, wetMax: 0.15 },
    fog:     { name: '大雾', icon: '🌫️', cover: 0.75, overcast: 0.5, rain: 0, hail: 0, snow: 0, fog: 60, fogTint: 1, lightning: 0, wind: 0.05, wetMax: 0.3 },
  };
  W.ORDER = ['clear', 'cloudy', 'drizzle', 'rain', 'storm', 'hail', 'snow', 'fog'];
  const NEXT = {
    clear: ['cloudy', 'cloudy', 'fog'], cloudy: ['clear', 'drizzle', 'drizzle', 'snow', 'fog'], drizzle: ['rain', 'cloudy', 'rain'],
    rain: ['storm', 'drizzle', 'hail', 'storm'], storm: ['rain', 'hail', 'drizzle'], hail: ['rain', 'cloudy', 'storm'],
    snow: ['cloudy', 'snow', 'fog'], fog: ['cloudy', 'clear', 'drizzle'],
  };
  const KEYS = ['cover', 'overcast', 'rain', 'hail', 'snow', 'fog', 'fogTint', 'lightning', 'wind', 'wetMax'];

  W.cur = Object.assign({}, W.TYPES.clear);
  W.target = 'clear'; W.auto = false; W.autoTimer = 120;
  W.wet = 0; W.snowCover = 0; W.hailCover = 0; W.flash = 0; W.time = 0;
  W.windVec = new THREE.Vector2(1, 0.3);
  W.out = { cover: 0, overcast: 0, fog: 0, fogTint: 0, flash: 0, windX: 0, windZ: 0 };
  W.onChange = null; W.impacts = 0; W.strikes = [];

  W.set = function (key, instant) {
    if (!W.TYPES[key]) return;
    W.target = key;
    if (instant) { Object.assign(W.cur, W.TYPES[key]); W.wet = W.TYPES[key].wetMax; W.snowCover = key === 'snow' ? 0.8 : 0; }
    W.autoTimer = 70 + Math.random() * 90;
    if (W.onChange) W.onChange(key);
  };

  // ---------- 雨丝（GPU 动画） ----------
  const RAIN_N = 20000;
  function makeRain() {
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    const off = new Float32Array(RAIN_N * 3), rnd = new Float32Array(RAIN_N);
    for (let i = 0; i < RAIN_N; i++) { off[i * 3] = Math.random(); off[i * 3 + 1] = Math.random(); off[i * 3 + 2] = Math.random(); rnd[i] = Math.random(); }
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 1));
    g.instanceCount = RAIN_N;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: {
        uFall: { value: 0 }, uDrift: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(56, 26, 56) },
        uSpeed: { value: 11 }, uWind: { value: new THREE.Vector2() }, uLen: { value: 0.75 }, uWidth: { value: 0.016 },
        uAmount: { value: 0 }, uColor: { value: new THREE.Color(0.75, 0.8, 0.88) }, uOpacity: { value: 0.5 },
        uShelter: { value: new THREE.Vector4(0, 0, 0, 0) }, uPx: { value: 600 },
        uRoomMin: { value: roomArr() }, uRoomMax: { value: roomArr() },
      },
      vertexShader: `
        attribute vec3 aOff; attribute float aRnd;
        uniform float uFall, uSpeed, uLen, uWidth, uAmount, uPx; uniform vec3 uCam, uBox; uniform vec2 uWind, uDrift; uniform vec4 uShelter;
        uniform vec3 uRoomMin[${ROOM_N}]; uniform vec3 uRoomMax[${ROOM_N}];
        varying vec2 vUv; varying float vA;
        void main() {
          vUv = uv;
          float sp = uSpeed * (0.8 + aRnd * 0.4);
          vec3 vel = vec3(uWind.x, -sp, uWind.y);
          vec3 origin = uCam - uBox * 0.5;
          // 位移由 CPU 每帧累加（uFall 只增不减），雨量/风速再怎么变，雨也只会往下落
          vec3 p = mod(aOff * uBox + vec3(uDrift.x, -uFall * (0.8 + aRnd * 0.4), uDrift.y) - origin, uBox) + origin;
          vec3 dir = vel / length(vel);
          float dist = length(p - uCam);
          // 雨丝基本竖直，横向用"水平且垂直于视线"的方向即可。
          // 这里必须写成内联的 cross(..., uCam - p)：把 uCam - p 先存进变量再用，ANGLE/Metal 下会得到 0（实测）
          vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), uCam - p));
          float along = position.y + 0.5;
          float w0 = uWidth * (0.7 + aRnd);
          float w = max(w0, 1.6 * dist / uPx);
          vec3 wp = p - dir * uLen * along * (0.7 + aRnd * 0.6) + sd * position.x * w;
          float hide = step(uAmount, aRnd);
          if (uShelter.w > 0.0 && length(p.xz - uShelter.xz) < uShelter.w && p.y < uShelter.y) hide = 1.0;
          for (int k = 0; k < ${ROOM_N}; k++) { if (all(greaterThan(p, uRoomMin[k])) && all(lessThan(p, uRoomMax[k]))) hide = 1.0; } // 打开的楼里不下雨
          vA = smoothstep(0.6, 2.5, dist) * (1.0 - smoothstep(18.0, 28.0, dist)) * clamp(w0 / w * 1.6, 0.3, 1.0) * (1.0 - hide);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          if (hide > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vUv; varying float vA;
        void main() {
          float a = (1.0 - abs(vUv.x * 2.0 - 1.0)) * sin(vUv.y * 3.14159);
          gl_FragColor = vec4(uColor, a * vA * uOpacity);
        }`,
    });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 5;
    return m;
  }

  // 打开的楼的包围盒（最多 4 个），空位放一个够不着的盒子
  function roomArr() { const a = []; for (let i = 0; i < ROOM_N; i++) a.push(new THREE.Vector3(1e6, 1e6, 1e6)); return a; }
  function setRooms(u, rooms) {
    for (let i = 0; i < ROOM_N; i++) {
      const b = rooms && rooms[i];
      if (b) { u.uRoomMin.value[i].set(b.x0, b.y0, b.z0); u.uRoomMax.value[i].set(b.x1, b.y1, b.z1); }
      else { u.uRoomMin.value[i].set(1e6, 1e6, 1e6); u.uRoomMax.value[i].set(1e6 + 1, 1e6 + 1, 1e6 + 1); }
    }
  }

  // ---------- 雪花（GPU 动画点精灵） ----------
  const SNOW_N = 14000;
  function makeSnow() {
    const g = new THREE.BufferGeometry();
    const off = new Float32Array(SNOW_N * 3), rnd = new Float32Array(SNOW_N);
    for (let i = 0; i < SNOW_N; i++) { off[i * 3] = Math.random(); off[i * 3 + 1] = Math.random(); off[i * 3 + 2] = Math.random(); rnd[i] = Math.random(); }
    g.setAttribute('position', new THREE.BufferAttribute(off, 3));
    g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(50, 24, 50) }, uDrift: { value: new THREE.Vector2() },
        uAmount: { value: 0 }, uMap: { value: H.tex.dot }, uScale: { value: 600 }, uBright: { value: 1 }, uShelter: { value: new THREE.Vector4() },
        uRoomMin: { value: roomArr() }, uRoomMax: { value: roomArr() },
      },
      vertexShader: `
        attribute float aRnd;
        uniform float uTime, uAmount, uScale; uniform vec3 uCam, uBox; uniform vec2 uDrift; uniform vec4 uShelter;
        uniform vec3 uRoomMin[${ROOM_N}]; uniform vec3 uRoomMax[${ROOM_N}];
        varying float vA;
        void main() {
          vec3 origin = uCam - uBox * 0.5;
          vec3 p = position * uBox + vec3(uDrift.x, -(1.1 + aRnd * 0.7) * uTime, uDrift.y);
          p.x += sin(uTime * (0.6 + aRnd) + aRnd * 40.0) * 0.6;
          p.z += cos(uTime * (0.5 + aRnd * 0.8) + aRnd * 17.0) * 0.6;
          p = mod(p - origin, uBox) + origin;
          float hide = step(uAmount, aRnd);
          if (uShelter.w > 0.0 && length(p.xz - uShelter.xz) < uShelter.w && p.y < uShelter.y) hide = 1.0;
          for (int k = 0; k < ${ROOM_N}; k++) { if (all(greaterThan(p, uRoomMin[k])) && all(lessThan(p, uRoomMax[k]))) hide = 1.0; }
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(0.3, 1.5, d) * (1.0 - smoothstep(16.0, 24.0, d)) * (1.0 - hide);
          gl_PointSize = uScale * (0.05 + aRnd * 0.06) / max(d, 0.1) * (1.0 - hide);
          gl_Position = projectionMatrix * mv;
          if (hide > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uBright; varying float vA;
        void main() { vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vec3(uBright), t.a * vA * 0.95); }`,
    });
    const m = new THREE.Points(g, mat); m.frustumCulled = false; m.renderOrder = 5;
    return m;
  }

  // ---------- 落地水花 ----------
  const SPL_N = 700;
  function makeSplash() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(SPL_N * 3), birth = new Float32Array(SPL_N).fill(-10);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uMap: { value: H.tex.dot }, uScale: { value: 600 }, uBright: { value: 0.8 } },
      vertexShader: `
        attribute float aBirth; uniform float uTime, uScale; varying float vA;
        void main() {
          float age = uTime - aBirth;
          float hide = 1.0 - step(0.0, age) * step(age, 0.28);
          vec3 p = position; p.y += age * 0.6 - age * age * 4.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = (1.0 - age / 0.28) * (1.0 - hide);
          gl_PointSize = uScale * (0.03 + age * 0.22) / max(-mv.z, 0.1) * (1.0 - hide);
          gl_Position = projectionMatrix * mv;
          if (hide > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uBright; varying float vA;
        void main() { vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vec3(uBright), t.a * vA * 0.55); }`,
    });
    const m = new THREE.Points(g, mat); m.frustumCulled = false; m.renderOrder = 4;
    return m;
  }

  // ---------- 冰雹（CPU 物理，会弹跳） ----------
  const HAIL_N = 900;
  function makeHail() {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef6ff, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.92, envMapIntensity: 1.5 });
    const m = new THREE.InstancedMesh(geo, mat, HAIL_N);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0;
    const st = [];
    for (let i = 0; i < HAIL_N; i++) st.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: 0.01, s: 0, life: 0, bounces: 0, alive: false });
    m.userData.st = st;
    return m;
  }

  // ---------- 闪电 ----------
  function boltPath(a, b, disp, depth, out) {
    if (depth === 0) { out.push(a.clone(), b.clone()); return; }
    const m = a.clone().add(b).multiplyScalar(0.5);
    m.x += (Math.random() - 0.5) * disp; m.z += (Math.random() - 0.5) * disp; m.y += (Math.random() - 0.5) * disp * 0.3;
    boltPath(a, m, disp * 0.55, depth - 1, out); boltPath(m, b, disp * 0.55, depth - 1, out);
  }
  function makeBoltMesh(segs, cam) {
    // segs: 每两个点一段 + 宽度。做成朝向相机的条带
    const pos = [], col = [];
    const dir = new THREE.Vector3(), toC = new THREE.Vector3(), side = new THREE.Vector3();
    for (const s of segs) {
      for (let i = 0; i < s.pts.length; i += 2) {
        const a = s.pts[i], b = s.pts[i + 1];
        dir.subVectors(b, a).normalize(); toC.subVectors(cam, a).normalize();
        side.crossVectors(dir, toC).normalize().multiplyScalar(s.w);
        const a1 = a.clone().add(side), a2 = a.clone().sub(side), b1 = b.clone().add(side), b2 = b.clone().sub(side);
        pos.push(a1.x, a1.y, a1.z, a2.x, a2.y, a2.z, b1.x, b1.y, b1.z, b1.x, b1.y, b1.z, a2.x, a2.y, a2.z, b2.x, b2.y, b2.z);
        for (let k = 0; k < 6; k++) col.push(s.c, s.c, s.c * 1.1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xdfe8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    return m;
  }

  W.init = function (scene) {
    W.scene = scene;
    W.rain = makeRain(); scene.add(W.rain);
    W.snow = makeSnow(); scene.add(W.snow);
    W.splash = makeSplash(); scene.add(W.splash);
    W.hail = makeHail(); scene.add(W.hail);
    W.splIdx = 0; W.splAcc = 0; W.hailAcc = 0;
    W.flashLight = new THREE.DirectionalLight(0xdfe6ff, 0); scene.add(W.flashLight); scene.add(W.flashLight.target);
    W.nextStrike = 6; W.flicker = null;
  };

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tmpV = new THREE.Vector3();

  W.strike = function (cam, forced) {
    const ang = Math.random() * Math.PI * 2;
    const dist = forced ? 160 + Math.random() * 120 : 160 + Math.random() * 520;
    const gx = cam.x + Math.cos(ang) * dist, gz = cam.z + Math.sin(ang) * dist;
    const cloudOnly = !forced && Math.random() < 0.35;
    const segs = [];
    if (!cloudOnly) {
      const top = new THREE.Vector3(gx + (Math.random() - 0.5) * 80, 420, gz + (Math.random() - 0.5) * 80);
      const bot = new THREE.Vector3(gx, 0, gz);
      const main = []; boltPath(top, bot, 90, 7, main);
      segs.push({ pts: main, w: 1.1, c: 1.6 });
      const nb = 2 + Math.floor(Math.random() * 4);
      for (let b = 0; b < nb; b++) {
        const k = 2 * Math.floor(Math.random() * main.length * 0.35);
        const s = main[k];
        const e = s.clone().add(new THREE.Vector3((Math.random() - 0.5) * 140, -40 - Math.random() * 120, (Math.random() - 0.5) * 140));
        const br = []; boltPath(s, e, 45, 5, br);
        segs.push({ pts: br, w: 0.5, c: 0.9 });
      }
    }
    if (W.bolt) { W.scene.remove(W.bolt); W.bolt.geometry.dispose(); W.bolt.material.dispose(); W.bolt = null; }
    if (segs.length) { W.bolt = makeBoltMesh(segs, cam); W.scene.add(W.bolt); }
    // 闪烁节奏：亮-暗-亮-余辉
    const strength = cloudOnly ? 0.45 : H.clamp(1.25 - dist / 900, 0.55, 1.2);
    W.flicker = { t: 0, seq: [[0.07, strength], [0.06, 0.1], [0.11, strength * 0.9], [0.05, 0.25], [0.22, strength * 0.5]], strength };
    W.flashLight.position.set(gx - cam.x, 300, gz - cam.z).normalize().multiplyScalar(100).add(cam);
    W.flashLight.target.position.copy(cam);
    W.strikes.push({ dist, cloudOnly });
  };

  W.update = function (dt, cam, ctx) {
    W.time += dt;
    const tgt = W.TYPES[W.target];
    const c = W.cur;
    const k = 1 - Math.exp(-dt * 0.28);
    for (const key of KEYS) c[key] += (tgt[key] - c[key]) * k;
    // 雨量的阵性起伏
    const gust = 0.82 + 0.18 * Math.sin(W.time * 0.21) * Math.sin(W.time * 0.13 + 1.3);
    const rainAmt = H.clamp(c.rain * gust, 0, 1);
    const hailAmt = c.hail, snowAmt = c.snow;

    if (W.auto) { W.autoTimer -= dt; if (W.autoTimer <= 0) W.set(H.rng((Math.random() * 1e9) | 0).pick(NEXT[W.target])); }

    // 地面湿度 / 积雪 / 冰雹覆盖
    if (rainAmt > 0.02) W.wet = Math.min(c.wetMax + 0.02, W.wet + rainAmt * 0.06 * dt);
    else W.wet = Math.max(0, W.wet - 0.006 * dt);
    if (W.wet > c.wetMax + 0.05) W.wet -= 0.01 * dt;
    W.snowCover = H.clamp(W.snowCover + (snowAmt > 0.05 ? snowAmt * 0.012 : -0.01 - rainAmt * 0.03) * dt, 0, 0.9);
    W.hailCover = H.clamp(W.hailCover + (hailAmt > 0.05 ? hailAmt * 0.05 : -0.012) * dt, 0, 1);
    const MU = H.mat.uniforms;
    MU.uWet.value = W.wet; MU.uSnow.value = W.snowCover; MU.uHail.value = W.hailCover;
    MU.uTime.value = W.time; MU.uWind.value = c.wind;

    // 风向缓慢旋转
    const wa = 0.4 + Math.sin(W.time * 0.02) * 0.6;
    W.windVec.set(Math.cos(wa), Math.sin(wa)).multiplyScalar(c.wind * 5);

    // 雨
    const t = W.time % 3000;
    const ru = W.rain.material.uniforms;
    ru.uCam.value.copy(cam); ru.uAmount.value = rainAmt;
    ru.uWind.value.copy(W.windVec).multiplyScalar(0.9);
    ru.uSpeed.value = 9 + rainAmt * 4; ru.uLen.value = 0.55 + rainAmt * 0.65; ru.uPx.value = ctx.pxScale;
    ru.uFall.value += ru.uSpeed.value * dt;
    ru.uDrift.value.addScaledVector(ru.uWind.value, dt);
    ru.uDrift.value.x %= 56; ru.uDrift.value.y %= 56; // 和盒子尺寸同周期，取模不会跳
    if (ru.uFall.value > 2e5) ru.uFall.value -= 2e5; // 几小时才触发一次，避免浮点精度变差
    const light = ctx.light; // 环境亮度 0..1
    ru.uColor.value.setRGB(0.62 + light * 0.3, 0.66 + light * 0.29, 0.74 + light * 0.25);
    ru.uOpacity.value = 0.32 + rainAmt * 0.45 + W.flash * 0.4;
    ru.uShelter.value.copy(ctx.shelter);
    setRooms(ru, ctx.rooms);
    W.rain.visible = rainAmt > 0.005;
    // 雪
    const su = W.snow.material.uniforms;
    su.uTime.value = t; su.uCam.value.copy(cam); su.uAmount.value = snowAmt;
    su.uDrift.value.addScaledVector(W.windVec, 0.6 * dt);
    su.uDrift.value.x %= 50; su.uDrift.value.y %= 50;
    su.uScale.value = ctx.pxScale; su.uBright.value = 0.55 + light * 0.45; su.uShelter.value.copy(ctx.shelter);
    setRooms(su, ctx.rooms);
    W.snow.visible = snowAmt > 0.005;
    // 水花
    const sp = W.splash.material.uniforms; sp.uTime.value = t; sp.uScale.value = ctx.pxScale; sp.uBright.value = 0.5 + light * 0.4;
    W.splAcc += rainAmt * 1100 * dt;
    const pa = W.splash.geometry.attributes.position, ba = W.splash.geometry.attributes.aBirth;
    let touched = false;
    while (W.splAcc >= 1) {
      W.splAcc -= 1;
      const r = 1.2 + Math.random() * 20, a = Math.random() * Math.PI * 2;
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      let y = ctx.groundY(x, z);
      const top = ctx.surfaceY ? ctx.surfaceY(x, z) : null;
      if (top !== null) y = top;
      if (y === null) continue;
      if (ctx.inside && ctx.inside(x, y + 0.1, z)) continue; // 屋里没有水花
      pa.setXYZ(W.splIdx, x, y + 0.01, z); ba.setX(W.splIdx, t - Math.random() * 0.02);
      W.splIdx = (W.splIdx + 1) % SPL_N; touched = true;
    }
    if (touched) { pa.needsUpdate = true; ba.needsUpdate = true; }
    W.splash.visible = rainAmt > 0.01;

    // 冰雹
    updateHail(dt, cam, hailAmt, ctx);

    // 闪电
    if (c.lightning > 0.3 && W.TYPES[W.target].lightning > 0) {
      W.nextStrike -= dt * c.lightning;
      if (W.nextStrike <= 0) { W.strike(cam); W.nextStrike = 5 + Math.random() * 12; }
    }
    let flash = 0;
    if (W.flicker) {
      const f = W.flicker; f.t += dt;
      let acc = 0, on = false;
      for (const [dur, val] of f.seq) { if (f.t < acc + dur) { flash = val; on = true; break; } acc += dur; }
      if (!on) { W.flicker = null; if (W.bolt) { W.scene.remove(W.bolt); W.bolt.geometry.dispose(); W.bolt.material.dispose(); W.bolt = null; } }
      if (W.bolt) W.bolt.material.opacity = H.clamp(flash * 1.2, 0, 1);
    }
    W.flash = flash;
    W.flashLight.intensity = flash * 3.2;

    const o = W.out;
    o.cover = c.cover; o.overcast = c.overcast; o.fog = c.fog; o.fogTint = c.fogTint; o.flash = flash;
    o.windX = W.windVec.x; o.windZ = W.windVec.y;
    W.rainAmt = rainAmt; W.hailAmt = hailAmt; W.snowAmt = snowAmt;
  };

  function updateHail(dt, cam, amt, ctx) {
    const m = W.hail, st = m.userData.st;
    W.impacts = 0; W.carImpacts = 0;
    W.hailAcc += amt * 260 * dt;
    let maxIdx = 0;
    for (let i = 0; i < HAIL_N; i++) {
      const h = st[i];
      if (!h.alive && W.hailAcc >= 1) {
        W.hailAcc -= 1;
        const r = Math.sqrt(Math.random()) * 26, a = Math.random() * Math.PI * 2;
        h.p.set(cam.x + Math.cos(a) * r, cam.y + 12 + Math.random() * 10, cam.z + Math.sin(a) * r);
        h.v.set(W.windVec.x * 0.6, -14 - Math.random() * 5, W.windVec.y * 0.6);
        h.r = 0.008 + Math.random() * Math.random() * 0.022; h.life = 3 + Math.random() * 3; h.bounces = 0; h.alive = true; h.s = 1; h.rest = false;
      }
      if (!h.alive) continue;
      maxIdx = i + 1;
      if (!h.rest) {
        h.v.y -= 9.8 * dt;
        h.p.addScaledVector(h.v, dt);
        if (ctx.inside && ctx.inside(h.p.x, h.p.y, h.p.z)) { h.alive = false; tmpM.makeScale(0, 0, 0); m.setMatrixAt(i, tmpM); continue; } // 打到打开的楼上就没了
        let floor = ctx.groundY(h.p.x, h.p.z);
        let onCar = false;
        const top = ctx.surfaceY ? ctx.surfaceY(h.p.x, h.p.z) : null;
        if (top !== null && h.p.y > top - 0.3) { floor = top; onCar = true; }
        if (floor === null) floor = 0;
        if (h.p.y - h.r <= floor) {
          h.p.y = floor + h.r;
          if (h.bounces === 0) { W.impacts++; if (onCar) W.carImpacts++; }
          h.bounces++;
          if (h.bounces > 3 || Math.abs(h.v.y) < 0.6) { h.rest = true; h.v.set(0, 0, 0); }
          else {
            h.v.y = -h.v.y * (0.32 + Math.random() * 0.12);
            h.v.x = h.v.x * 0.5 + (Math.random() - 0.5) * 1.6; h.v.z = h.v.z * 0.5 + (Math.random() - 0.5) * 1.6;
          }
        }
      } else {
        h.life -= dt;
        if (h.life < 0.8) h.s = Math.max(0, h.life / 0.8);
        if (h.life <= 0) h.alive = false;
      }
      const dx = h.p.x - cam.x, dz = h.p.z - cam.z;
      if (dx * dx + dz * dz > 34 * 34) h.alive = false;
      // 下落时沿速度方向拉长一点，看起来像在飞
      const sp = h.v.length();
      if (sp > 2) { tmpV.copy(h.v).divideScalar(sp); tmpQ.setFromUnitVectors(up, tmpV); tmpS.set(h.r, h.r * (1 + sp * 0.06), h.r); }
      else { tmpQ.identity(); tmpS.setScalar(h.r * h.s); }
      tmpM.compose(h.p, tmpQ, tmpS);
      m.setMatrixAt(i, tmpM);
      if (!h.alive) { tmpM.makeScale(0, 0, 0); m.setMatrixAt(i, tmpM); }
    }
    if (W.hailAcc > 5) W.hailAcc = 5;
    m.count = maxIdx;
    m.instanceMatrix.needsUpdate = true;
    m.visible = maxIdx > 0;
  }

  // 浮动原点：世界整体平移时冰雹/水花跟着挪
  W.rebase = function (dz) {
    for (const h of W.hail.userData.st) h.p.z += dz;
    const pa = W.splash.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) pa.setZ(i, pa.getZ(i) + dz);
    pa.needsUpdate = true;
  };
})();
