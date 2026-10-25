// 声音：全部用 WebAudio 现场合成（雨声、风声、冰雹、雷声、引擎、脚步、喇叭、雨刮、鸟叫）
'use strict';
(function () {
  const A = H.audio = {};
  let ctx = null, master, outside, noiseBuf;
  A.volume = 0.8; A.muted = false;

  function noiseBuffer(sec) {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 3.0; }
    return b;
  }
  function loopNoise() { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 2); return s; }
  function filt(type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function gain(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
  const set = (p, v, t = 0.25) => p.setTargetAtTime(v, ctx.currentTime, t);

  A.init = function () {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    master = gain(A.volume); master.connect(ctx.destination);
    // 车外的声音过一道低通：坐进车里就变闷
    outside = filt('lowpass', 18000); const outG = gain(1); outside.connect(outG); outG.connect(master);
    A.outG = outG;
    noiseBuf = noiseBuffer(3);
    // 雨：沙沙 + 低频滴答
    A.rainHi = gain(); loopNoise().connect(filt('highpass', 1100)).connect(A.rainHi).connect(outside);
    A.rainLo = gain(); loopNoise().connect(filt('bandpass', 420, 0.6)).connect(A.rainLo).connect(master);
    // 风
    A.windF = filt('lowpass', 420, 1.2); A.wind = gain(); loopNoise().connect(A.windF).connect(A.wind).connect(outside);
    // 城市底噪
    A.city = gain(0.015); loopNoise().connect(filt('bandpass', 180, 0.5)).connect(A.city).connect(outside);
    // 胎噪 / 风噪（车速）
    A.road = gain(); A.roadF = filt('lowpass', 300); loopNoise().connect(A.roadF).connect(A.road).connect(master);
    // 引擎
    A.engF = filt('lowpass', 700, 1.5); A.eng = gain();
    A.o1 = ctx.createOscillator(); A.o1.type = 'sawtooth'; A.o2 = ctx.createOscillator(); A.o2.type = 'square';
    A.o1.connect(A.engF); A.o2.connect(A.engF); A.engF.connect(A.eng).connect(master);
    A.o1.start(); A.o2.start();
    // 刮路沿
    A.scr = gain(); loopNoise().connect(filt('bandpass', 1400, 2)).connect(A.scr).connect(master);
    A.birdT = 3;
  };

  A.setVolume = function (v) { A.volume = v; if (master) set(master.gain, A.muted ? 0 : v, 0.05); };
  A.toggleMute = function () { A.muted = !A.muted; A.setVolume(A.volume); return A.muted; };

  // st: { rain, hail, snow, wind, inCar, speed, throttle, engineOn, scrape, day, clear }
  A.update = function (dt, st) {
    if (!ctx) return;
    const inCar = st.inCar;
    set(outside.frequency, inCar ? 1100 : 18000, 0.15);
    set(A.rainHi.gain, st.rain * (inCar ? 0.16 : 0.38), 0.4);
    set(A.rainLo.gain, st.rain * (inCar ? 0.5 : 0.1), 0.4);
    const gust = 0.6 + 0.4 * Math.sin(performance.now() * 0.0007) * Math.sin(performance.now() * 0.00031);
    set(A.wind.gain, (0.02 + st.wind * 0.13) * gust * (inCar ? 0.4 : 1), 0.5);
    set(A.windF.frequency, 300 + st.wind * 500 * gust, 0.5);
    const v = Math.abs(st.speed);
    const bk = st.bike || 0;
    set(A.road.gain, inCar ? Math.min(0.2, (v / 34) * (v / 34) * 0.22 + v * 0.002) : Math.min(0.07, bk * bk * 0.0016), 0.2);
    set(A.roadF.frequency, inCar ? 200 + v * 25 : 500 + bk * 120, 0.2);
    // 自行车滑行时飞轮"嗒嗒嗒"，越快越密
    if (bk > 0.8 && !st.pedaling) {
      A.tickT = (A.tickT || 0) - dt;
      if (A.tickT <= 0) { A.tickT = 1 / (5 + bk * 3); burst(0.012, 'bandpass', 4200, 6, 0.03, master, 2); }
    }
    // 假的换挡转速
    let rpm = 0;
    if (st.engineOn) {
      const gears = [0, 5, 11, 18, 25, 40];
      let gi = 0; while (gi < gears.length - 2 && v > gears[gi + 1]) gi++;
      const t = H.clamp((v - gears[gi]) / (gears[gi + 1] - gears[gi]), 0, 1);
      rpm = 900 + t * 3400 + st.throttle * 400;
    }
    const f = rpm / 30;
    set(A.o1.frequency, Math.max(20, f), 0.08); set(A.o2.frequency, Math.max(20, f * 0.5 + 1.5), 0.08);
    set(A.engF.frequency, 300 + rpm * 0.25 + st.throttle * 400, 0.1);
    set(A.eng.gain, st.engineOn ? 0.025 + st.throttle * 0.035 : 0, 0.15);
    set(A.scr.gain, Math.min(0.25, st.scrape * 0.03), 0.05);
    set(A.city.gain, inCar ? 0.008 : 0.016, 0.5);
    // 晴天白天的鸟叫
    A.birdT -= dt;
    if (A.birdT <= 0) { A.birdT = 2 + Math.random() * 6; if (st.clear && st.day && !inCar) A.chirp(); }
  };

  function burst(dur, type, f, q, g, dest, rate = 1, when = 0) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = rate;
    const bf = filt(type, f, q), gg = gain(0);
    const t = ctx.currentTime + when;
    gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(g, t + 0.003); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bf).connect(gg).connect(dest || outside);
    s.start(t, Math.random() * 2.5); s.stop(t + dur + 0.05);
  }

  A.hailTicks = function (n, onCar, inCar) {
    if (!ctx) return;
    n = Math.min(n, 10);
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 0.05;
      if (onCar) burst(0.05 + Math.random() * 0.05, 'bandpass', 1600 + Math.random() * 1800, 4, inCar ? 0.22 : 0.12, master, 1.4, w);
      else burst(0.03, 'bandpass', 2500 + Math.random() * 2500, 2, 0.05 + Math.random() * 0.05, outside, 1.6, w);
    }
  };

  A.thunder = function (dist, cloudOnly) {
    if (!ctx) return;
    const delay = Math.min(dist / 343, 4.5);
    const vol = H.clamp(1.1 - dist / 900, 0.15, 1) * (cloudOnly ? 0.5 : 1);
    const t = ctx.currentTime + delay;
    if (dist < 320 && !cloudOnly) {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1.3;
      const g = gain(0); const hp = filt('highpass', 900);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      s.connect(hp).connect(g).connect(master); s.start(t); s.stop(t + 0.6);
    }
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.playbackRate.value = 0.5 + Math.random() * 0.2;
    const lp = filt('lowpass', 160 + Math.random() * 80, 1.0), g = gain(0);
    const len = 3.5 + Math.random() * 3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * vol, t + 0.25);
    for (let k = 1; k < 6; k++) g.gain.linearRampToValueAtTime((0.35 + Math.random() * 0.6) * vol * (1 - k / 7), t + 0.25 + k * len / 7);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(lp).connect(g).connect(master); s.start(t); s.stop(t + len + 0.1);
  };

  A.step = function (wet, snow, run) {
    if (!ctx) return;
    burst(0.09, 'lowpass', snow > 0.3 ? 900 : 420, 1, run ? 0.2 : 0.14, outside, snow > 0.3 ? 0.6 : 1);
    if (wet > 0.3) burst(0.12, 'bandpass', 2400, 1.2, 0.05 * wet, outside, 1.2);
  };
  A.thunk = function (f = 90, v = 0.25) {
    if (!ctx) return;
    const o = ctx.createOscillator(); o.type = 'sine'; const g = gain(0); const t = ctx.currentTime;
    o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.2);
  };
  // 车铃：叮铃
  A.bell = function () {
    if (!ctx) return;
    for (let i = 0; i < 2; i++) {
      const t = ctx.currentTime + i * 0.13;
      for (const f of [2350, 3480]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = gain(0);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(f > 3000 ? 0.04 : 0.08, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.connect(g).connect(master); o.start(t); o.stop(t + 0.6);
      }
    }
  };
  A.door = function () { if (!ctx) return; A.thunk(70, 0.4); burst(0.12, 'lowpass', 600, 1, 0.2, master); };
  // 屋里的门：开门是门锁咔哒 + 一点摩擦声，关门多一下闷响
  A.doorCreak = function (opening) {
    if (!ctx) return;
    burst(0.05, 'bandpass', 2600, 4, 0.05, master, 1.3);
    burst(0.35, 'bandpass', opening ? 700 : 520, 6, 0.025, master, 0.5);
    if (!opening) setTimeout(() => A.thunk(85, 0.3), 520);
  };
  // 电梯到站：叮——
  A.ding = function () {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [f, v] of [[1318, 0.06], [2637, 0.015]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = gain(0);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g).connect(master); o.start(t); o.stop(t + 1.5);
    }
  };
  A.wiper = function () { if (!ctx) return; A.thunk(140, 0.05); burst(0.06, 'bandpass', 900, 3, 0.03, master, 0.8); };

  let horn = null;
  A.horn = function (on) {
    if (!ctx) return;
    if (on && !horn) {
      const g = gain(0); const lp = filt('lowpass', 2400);
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(); o1.type = o2.type = 'square';
      o1.frequency.value = 415; o2.frequency.value = 523;
      o1.connect(lp); o2.connect(lp); lp.connect(g).connect(master);
      set(g.gain, 0.06, 0.01); o1.start(); o2.start();
      horn = { g, o1, o2 };
    } else if (!on && horn) {
      const h = horn; horn = null; set(h.g.gain, 0, 0.02); setTimeout(() => { h.o1.stop(); h.o2.stop(); }, 150);
    }
  };
  A.chirp = function () {
    const n = 2 + Math.floor(Math.random() * 4), base = 2600 + Math.random() * 1600;
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator(); o.type = 'sine'; const g = gain(0);
      o.frequency.setValueAtTime(base, t); o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), t + 0.06);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.025, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(outside); o.start(t); o.stop(t + 0.1);
    }
  };
})();
