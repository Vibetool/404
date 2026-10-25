// 共享材质 + 天气着色补丁（湿润、积水、积雪、冰雹颗粒、树叶随风摆）
'use strict';
(function () {
  const M = H.mat = {};
  // 所有打过补丁的材质共用这一组 uniform，天气系统每帧改值即可
  const U = M.uniforms = {
    uWet: { value: 0 }, uSnow: { value: 0 }, uHail: { value: 0 },
    uPuddleMap: { value: null }, uTime: { value: 0 }, uWind: { value: 0.2 },
  };

  function patch(mat, flags = {}) {
    mat.defines = mat.defines || {};
    if (flags.puddles) mat.defines.WEATHER_PUDDLES = '';
    if (flags.sway) mat.defines.WEATHER_SWAY = '';
    if (flags.noSnow) mat.defines.WEATHER_NOSNOW = '';
    if (flags.instUV) mat.defines.INST_UV_Y = '';
    mat.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos; varying vec3 vWNrm;
          uniform float uTime; uniform float uWind;`)
        // 楼里的标准层是同一份几何按层实例化的：贴图 v 加上这一层的高度，外墙纹理才和整栋实心楼体对得上
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          #if defined(USE_INSTANCING) && defined(USE_UV) && defined(INST_UV_Y)
            vUv = (uvTransform * vec3(uv + vec2(0.0, instanceMatrix[3][1]), 1.0)).xy;
          #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef WEATHER_SWAY
            float swH = max(transformed.y - 1.6, 0.0);
            float swP = transformed.x * 0.31 + transformed.z * 0.23;
            transformed.x += sin(uTime * 1.9 + swP) * (0.02 + uWind * 0.07) * swH;
            transformed.z += cos(uTime * 1.5 + swP * 1.3) * (0.01 + uWind * 0.04) * swH;
          #endif`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          #ifdef USE_INSTANCING
            vec4 wpW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
            vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
          #else
            vec4 wpW = modelMatrix * vec4(transformed, 1.0);
            vWNrm = normalize(mat3(modelMatrix) * objectNormal);
          #endif
          vWPos = wpW.xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos; varying vec3 vWNrm;
          uniform float uWet; uniform float uSnow; uniform float uHail; uniform sampler2D uPuddleMap;`)
        .replace('#include <lights_physical_fragment>', `
          {
            float up = clamp(vWNrm.y, 0.0, 1.0);
            float nz = texture2D(uPuddleMap, vWPos.xz * 0.03125).r;
            float wetAmt = uWet * mix(0.3, 1.0, up);
            diffuseColor.rgb *= mix(1.0, 0.58, wetAmt);
            roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.62, wetAmt);
            #ifdef WEATHER_PUDDLES
              float pud = smoothstep(0.5, 0.62, nz + (uWet - 0.5) * 0.25) * smoothstep(0.25, 0.9, uWet);
              diffuseColor.rgb *= mix(1.0, 0.5, pud);
              roughnessFactor = mix(roughnessFactor, 0.07, pud);
              normal = normalize(mix(normal, normalize(vNormal), pud));
            #endif
            #ifndef WEATHER_NOSNOW
              float cover = uSnow * smoothstep(0.45, 0.8, up) * smoothstep(0.15, 0.55, nz + uSnow * 0.6);
              vec2 hc = vWPos.xz * 11.0;
              vec2 hci = floor(hc);
              float hr = fract(sin(dot(hci, vec2(12.9898, 78.233))) * 43758.5453);
              vec2 ho = vec2(fract(hr * 13.7), fract(hr * 71.3)) * 0.5 + 0.25;
              float hailDot = step(0.9 - uHail * 0.12, hr) * (1.0 - smoothstep(0.1, 0.16, length(fract(hc) - ho)));
              cover = max(cover, hailDot * uHail * smoothstep(0.6, 0.9, up));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), cover);
              roughnessFactor = mix(roughnessFactor, 0.75, cover);
            #endif
          }
          #include <lights_physical_fragment>`);
    };
    return mat;
  }
  M.patch = patch;

  M.build = function () {
    const T = H.tex;
    U.uPuddleMap.value = T.puddle;
    const rep = (t, s) => { const c = t.clone(); c.needsUpdate = true; c.repeat.set(1 / s, 1 / s); return c; };
    const std = (o, flags) => patch(new THREE.MeshStandardMaterial(o), flags);

    M.list = {
      wall: std({ map: rep(T.plaster, 3), normalMap: rep(T.plasterN, 3), normalScale: new THREE.Vector2(0.45, 0.45), vertexColors: true, roughness: 0.92 }, { instUV: true }),
      brick: std({ map: rep(T.brick, 2), normalMap: rep(T.brickN, 2), normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, roughness: 0.9 }, { instUV: true }),
      trim: std({ vertexColors: true, roughness: 0.7 }),
      curtain: std({ map: T.curtain, roughnessMap: T.curtainR, emissiveMap: T.curtainE, emissive: 0xffffff, emissiveIntensity: 0,
        vertexColors: true, metalness: 0.45, roughness: 1, envMapIntensity: 1.3 }),
      win: std({ map: T.windows, roughnessMap: T.windowsR, emissiveMap: T.windowsE, emissive: 0xffffff, emissiveIntensity: 0,
        roughness: 1, metalness: 0.1, envMapIntensity: 1.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, { noSnow: true }),
      roof: std({ map: rep(T.roof, 2), normalMap: rep(T.roofN, 2), normalScale: new THREE.Vector2(0.9, 0.9), vertexColors: true, roughness: 0.72 }),
      metal: std({ vertexColors: true, roughness: 0.38, metalness: 0.65 }),
      glass: new THREE.MeshStandardMaterial({ color: 0xbfd8e6, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide }),
      grass: std({ map: rep(T.grass, 2), vertexColors: true, roughness: 0.95 }),
      leaf: std({ vertexColors: true, roughness: 0.85, map: rep(T.plaster, 1.2) }, { sway: true }),
      leafPot: std({ vertexColors: true, roughness: 0.85, map: rep(T.plaster, 1.2) }),
      wood: std({ vertexColors: true, roughness: 0.74, map: rep(T.woodGrain, 1.2) }),
      tiles: std({ map: rep(T.tiles, 2), normalMap: rep(T.tilesN, 2), normalScale: new THREE.Vector2(0.6, 0.6), vertexColors: true, roughness: 0.85 }, { puddles: true }),
      asphalt: std({ map: rep(T.asphalt, 4), normalMap: rep(T.asphaltN, 4), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.9 }, { puddles: true }),
      paint: std({ color: 0xf2f2ee, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, vertexColors: true }, { puddles: true }),
      concrete: std({ map: rep(T.plaster, 2), normalMap: rep(T.plasterN, 2), normalScale: new THREE.Vector2(0.35, 0.35), vertexColors: true, roughness: 0.88 }, { instUV: true }),
      awning: std({ map: T.awning, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
      sign: std({ map: T.signs, emissiveMap: T.signsE, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.5,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, { noSnow: true }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xfff4dc, emissive: 0xffd9a0, emissiveIntensity: 0.2, roughness: 0.3 }),
      pool: new THREE.MeshBasicMaterial({ map: T.pool, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false }),
      red: new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2010, emissiveIntensity: 0.4 }),
    };
    M.list.winflat = M.list.win; // 远处的平面窗（近处会被立体窗替换）
    // 阴影位：1 投射 2 接收
    M.shadow = {
      wall: 3, brick: 3, trim: 3, curtain: 3, win: 2, roof: 3, metal: 3, glass: 0, grass: 2, leaf: 3, leafPot: 3, wood: 3,
      tiles: 2, asphalt: 2, paint: 2, concrete: 3, awning: 3, sign: 2, lamp: 1, pool: 0, red: 0, winflat: 2,
    };
    M.ground = std({ map: rep(T.grass, 3), color: 0xc8d4b8, roughness: 0.95 });
  };
})();
