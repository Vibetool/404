// 天空穹顶（渐变 + 太阳/月亮 + 程序云 + 星星）、光照、雾、时间、环境贴图
'use strict';
(function () {
  const S = H.sky = {};

  const vert = `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const frag = `
    varying vec3 vDir;
    uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor, uMoonDir;
    uniform vec3 uCloudLit, uCloudShadow;
    uniform float uCover, uNight, uFlash, uSunVis, uFogMix;
    uniform vec2 uWind;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
      return v;
    }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
      if (h < 0.0) col = mix(uHorizon, uGround, clamp(-h * 5.0, 0.0, 1.0));
      // 星星和月亮
      if (uNight > 0.01 && h > 0.0) {
        vec3 sp = floor(d * 380.0);
        float s = fract(sin(dot(sp, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        col += step(0.9982, s) * uNight * (1.0 - uCover) * vec3(0.9, 0.95, 1.0) * 1.4;
        float md = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.95, 0.97, 1.0) * (smoothstep(0.99965, 0.9998, md) * 2.5 + pow(md, 60.0) * 0.12) * uNight * (1.0 - uCover * 0.9);
      }
      // 太阳
      float sd = max(dot(d, uSunDir), 0.0);
      col += uSunColor * (smoothstep(0.99955, 0.9997, sd) * 8.0 + pow(sd, 10.0) * 0.28 + pow(sd, 3.0) * 0.06) * uSunVis;
      // 云
      if (h > -0.02) {
        float hh = max(h, 0.0);
        vec2 uv = d.xz / (hh + 0.12) * 0.55 + uWind;
        float n = fbm(uv);
        float n2 = fbm(uv + uSunDir.xz * 0.12);
        float th = 1.0 - uCover;
        float cov = smoothstep(th - 0.08, th + 0.32, n + uCover * 0.25);
        float shade = clamp((n - n2) * 4.0 + 0.55, 0.0, 1.0);
        vec3 cc = mix(uCloudShadow, uCloudLit, shade);
        cc += uSunColor * pow(sd, 6.0) * 0.25 * uSunVis;
        float fade = smoothstep(-0.02, 0.18, h);
        col = mix(col, cc, cov * fade * 0.97);
        col = mix(col, cc * 0.9 + uFlash * vec3(0.6, 0.65, 0.8), uFlash * 0.6 * cov);
      }
      col = mix(col, uHorizon, uFogMix * (1.0 - clamp(h, 0.0, 1.0) * 0.45));
      col += uFlash * vec3(0.25, 0.27, 0.35);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;

  S.u = {
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3() },
    uCloudLit: { value: new THREE.Color() }, uCloudShadow: { value: new THREE.Color() },
    uCover: { value: 0.3 }, uFogMix: { value: 0 }, uNight: { value: 0 }, uFlash: { value: 0 }, uSunVis: { value: 1 }, uWind: { value: new THREE.Vector2() },
  };

  // 太阳高度角关键帧（度）：天空颜色、太阳色和强度、半球光
  const KEYS = [
    { el: -14, zen: '#060a18', hor: '#141c33', sun: '#9fb4ff', sunI: 0.18, hemiS: '#3a4a78', hemiG: '#1a1a22', hemiI: 0.24, cloudL: '#2a3350', cloudS: '#10141f' },
    { el: -5, zen: '#1f2d5c', hor: '#6a5a86', sun: '#ff9a6a', sunI: 0.25, hemiS: '#6d6fa0', hemiG: '#2a2630', hemiI: 0.5, cloudL: '#8a6a8a', cloudS: '#3a3550' },
    { el: 2, zen: '#3b5a9a', hor: '#f0a070', sun: '#ff9f5a', sunI: 1.3, hemiS: '#b8a8c8', hemiG: '#5a4a40', hemiI: 0.7, cloudL: '#ffc29a', cloudS: '#7a6680' },
    { el: 10, zen: '#4278c4', hor: '#f3cfa3', sun: '#ffd2a0', sunI: 2.4, hemiS: '#c8d8f0', hemiG: '#7a6a58', hemiI: 0.85, cloudL: '#fff0dc', cloudS: '#a7a8b8' },
    { el: 30, zen: '#3a7bd5', hor: '#b9d6ee', sun: '#fff4e2', sunI: 3.1, hemiS: '#d4e6ff', hemiG: '#8a8274', hemiI: 0.95, cloudL: '#ffffff', cloudS: '#b6c0cc' },
  ];
  const tmpA = new THREE.Color(), tmpB = new THREE.Color();
  function lerpKey(el, f) {
    let a = KEYS[0], b = KEYS[0];
    if (el <= KEYS[0].el) { a = b = KEYS[0]; }
    else if (el >= KEYS[KEYS.length - 1].el) { a = b = KEYS[KEYS.length - 1]; }
    else for (let i = 0; i < KEYS.length - 1; i++) if (el >= KEYS[i].el && el <= KEYS[i + 1].el) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    const t = a === b ? 0 : (el - a.el) / (b.el - a.el);
    const out = {};
    for (const k of ['zen', 'hor', 'sun', 'hemiS', 'hemiG', 'cloudL', 'cloudS']) {
      out[k] = tmpA.set(a[k]).clone().lerp(tmpB.set(b[k]), t);
    }
    out.sunI = H.lerp(a.sunI, b.sunI, t); out.hemiI = H.lerp(a.hemiI, b.hemiI, t);
    return out;
  }

  S.init = function (scene, renderer) {
    S.scene = scene; S.renderer = renderer;
    S.mat = new THREE.ShaderMaterial({ uniforms: S.u, vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false, fog: false });
    const geo = new THREE.SphereGeometry(1, 48, 24);
    S.dome = new THREE.Mesh(geo, S.mat);
    S.dome.scale.setScalar(1500); S.dome.frustumCulled = false; S.dome.renderOrder = -10;
    scene.add(S.dome);
    // 环境贴图用的独立小场景
    S.envScene = new THREE.Scene();
    const d2 = new THREE.Mesh(geo, S.mat); d2.scale.setScalar(100); S.envScene.add(d2);
    S.pmrem = new THREE.PMREMGenerator(renderer);
    S.envRT = null; S.envTimer = 0; S.envSig = '';

    S.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
    scene.add(S.hemi);
    S.sun = new THREE.DirectionalLight(0xffffff, 2);
    S.sun.castShadow = true;
    const sc = S.sun.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 500;
    S.sun.shadow.bias = -0.0004; S.sun.shadow.normalBias = 0.04;
    S.setShadowSize(2048);
    scene.add(S.sun); scene.add(S.sun.target);
    scene.fog = new THREE.Fog(0xbcd8ef, 40, 600);
    S.hours = 14; S.flowTime = false;
  };
  S.setShadowSize = function (n) {
    S.sun.shadow.mapSize.set(n, n);
    if (S.sun.shadow.map) { S.sun.shadow.map.dispose(); S.sun.shadow.map = null; }
  };

  // 由小时算太阳方向（路沿 z 轴，太阳从侧面照过来，楼影落在街上更好看）
  S.sunDirFor = function (hours, out) {
    const t = (hours - 6) / 12 * Math.PI; // 6点日出 18点日落
    const el = Math.sin(t) * 62 * Math.PI / 180;
    const az = Math.PI * 0.15 + (hours - 12) / 12 * Math.PI * 0.95;
    out.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el) * 0.6 - 0.25).normalize();
    return out;
  };

  const sunDir = new THREE.Vector3();
  const gray = new THREE.Color();
  // w：天气系统给出的当前参数 {cover, overcast, fog, flash, windX, windZ}
  S.update = function (dt, w, focus) {
    if (S.flowTime) { S.hours = (S.hours + dt / 60) % 24; } // 一分钟 = 一小时
    S.sunDirFor(S.hours, sunDir);
    const elDeg = Math.asin(sunDir.y) * 180 / Math.PI;
    const k = lerpKey(elDeg);
    const oc = w.overcast; // 0 晴 .. 1 暴雨乌云
    const u = S.u;
    // 阴天：天空去饱和并压暗
    const dim = 1 - oc * 0.55;
    gray.setRGB(0.42, 0.45, 0.5).multiplyScalar(Math.max(k.hemiI, 0.25) * 0.95);
    u.uZenith.value.copy(k.zen).lerp(gray, oc * 0.85).multiplyScalar(dim);
    u.uHorizon.value.copy(k.hor).lerp(gray.clone().multiplyScalar(1.25), oc * 0.8).multiplyScalar(1 - oc * 0.35);
    if (w.fogTint > 0) u.uHorizon.value.lerp(gray.clone().multiplyScalar(1.6), w.fogTint * 0.6);
    u.uGround.value.copy(u.uHorizon.value).multiplyScalar(0.6);
    u.uSunDir.value.copy(sunDir);
    u.uMoonDir.value.set(-sunDir.x, Math.abs(sunDir.y) * 0.8 + 0.25, -sunDir.z).normalize();
    u.uSunColor.value.copy(k.sun);
    u.uSunVis.value = Math.max(0, 1 - oc * 1.1) * H.smooth(-4, 1, elDeg);
    u.uCloudLit.value.copy(k.cloudL).lerp(gray.clone().multiplyScalar(1.35), oc * 0.75);
    u.uCloudShadow.value.copy(k.cloudS).lerp(gray.clone().multiplyScalar(0.6), oc * 0.85);
    u.uCover.value = w.cover;
    u.uNight.value = H.smooth(-2, -10, elDeg);
    u.uFlash.value = w.flash;
    u.uWind.value.x += w.windX * dt * 0.004; u.uWind.value.y += w.windZ * dt * 0.004;

    // 灯光
    const night = elDeg < -2;
    if (night) S.sun.position.copy(u.uMoonDir.value); else S.sun.position.copy(sunDir);
    S.sun.position.multiplyScalar(200).add(focus);
    S.sun.target.position.copy(focus);
    // 让阴影贴图按像素对齐，走动时阴影边缘不闪
    S.sun.color.copy(night ? tmpA.set('#9fb4ff') : k.sun);
    const sunI = night ? 0.22 * (1 - oc * 0.8) : k.sunI * (1 - oc * 0.82) * H.smooth(-3, 2, elDeg);
    S.sun.intensity = sunI;
    S.sun.castShadow = sunI > 0.12;
    S.hemi.color.copy(k.hemiS).lerp(gray.clone().multiplyScalar(2.0), oc * 0.7);
    S.hemi.groundColor.copy(k.hemiG);
    S.hemi.intensity = k.hemiI * (1 + oc * 0.15) + w.flash * 2.6;
    // 雾
    S.scene.fog.color.copy(u.uHorizon.value);
    // w.fog 是能见度（米），已被画面距离截断
    S.scene.fog.near = w.fog * 0.06; S.scene.fog.far = w.fog;
    u.uFogMix.value = H.smooth(300, 40, w.fog) * 0.95;
    // 夜灯：天黑或乌云压顶都会亮
    S.night = H.smooth(4, -6, elDeg);
    S.lightsOn = Math.max(S.night, H.smooth(0.55, 0.95, oc) * 0.7);
    S.elDeg = elDeg;

    // 环境贴图：参数变化明显时才重算
    S.envTimer -= dt;
    const sig = [u.uZenith.value.getHexString(), u.uHorizon.value.getHexString(), (w.cover * 10) | 0].join();
    if ((sig !== S.envSig && S.envTimer <= 0 && w.flash < 0.05) || !S.envRT) {
      S.envSig = sig; S.envTimer = 1.5;
      const old = S.envRT;
      S.envRT = S.pmrem.fromScene(S.envScene, 0, 0.1, 500);
      S.scene.environment = S.envRT.texture;
      if (old) old.dispose();
    }
  };
  S.follow = function (cam) { S.dome.position.copy(cam.position); };
})();
