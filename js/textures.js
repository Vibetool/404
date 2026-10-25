// 程序化贴图：全部用 canvas 现场画，不依赖外部素材
'use strict';
(function () {
  const T = H.tex = {};
  const R = H.rng(4040);

  function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // 可平铺的分形值噪声，返回 [0,1]
  function tileNoise(size, cells, octaves, seed, persistence = 0.5) {
    const out = new Float32Array(size * size);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
      const n = cells << o;
      const grid = new Float32Array(n * n);
      const r = H.rng(seed + o * 101);
      for (let i = 0; i < grid.length; i++) grid[i] = r();
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * n, iy = Math.floor(gy), fy = gy - iy, uy = fy * fy * (3 - 2 * fy);
        const y0 = iy % n, y1 = (iy + 1) % n;
        for (let x = 0; x < size; x++) {
          const gx = (x / size) * n, ix = Math.floor(gx), fx = gx - ix, ux = fx * fx * (3 - 2 * fx);
          const x0 = ix % n, x1 = (ix + 1) % n;
          const a = grid[y0 * n + x0], b = grid[y0 * n + x1], c = grid[y1 * n + x0], d = grid[y1 * n + x1];
          out[y * size + x] += amp * ((a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy);
        }
      }
      total += amp; amp *= persistence;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  }
  T.tileNoise = tileNoise;

  // 高度图 -> 法线贴图
  function normalFromHeight(hgt, size, strength) {
    const c = canvas(size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = hgt[y * size + ((x - 1 + size) % size)], r = hgt[y * size + ((x + 1) % size)];
      const u = hgt[((y - 1 + size) % size) * size + x], d = hgt[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function toTex(c, repeat = true, srgb = true) {
    const t = new THREE.CanvasTexture(c);
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    if (srgb) t.encoding = THREE.sRGBEncoding;
    t.anisotropy = H.maxAniso || 4;
    return t;
  }

  function grayCanvas(vals, size, fn) {
    const c = canvas(size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const rgb = fn(vals[i], i);
      img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  T.build = function () {
    const S = 512;
    // ---------- 沥青（一张 = 4m） ----------
    {
      const n1 = tileNoise(S, 8, 6, 11, 0.55);
      const n2 = tileNoise(S, 64, 2, 12, 0.5);
      const hgt = new Float32Array(S * S);
      const c = grayCanvas(n1, S, (v, i) => {
        const g = n2[i];
        let k = 0.24 + v * 0.1 + (g - 0.5) * 0.12;
        const r = H.hash(i, 7);
        if (r > 0.985) k += 0.12; else if (r < 0.02) k -= 0.06;
        hgt[i] = g + (r > 0.985 ? 0.6 : 0);
        k = H.clamp(k, 0, 1) * 255;
        return [k * 0.96, k * 0.97, k];
      });
      const ctx = c.getContext('2d');
      // 几块补丁和细裂缝（很淡，不恐怖）
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgba(${R() < 0.5 ? '20,20,24' : '90,90,92'},0.07)`;
        const x = R() * S, y = R() * S, w = 40 + R() * 120, h = 30 + R() * 90;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 16) : ctx.rect(x, y, w, h); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(15,15,18,0.25)'; ctx.lineWidth = 1.2;
      for (let i = 0; i < 4; i++) {
        let x = R() * S, y = R() * S; ctx.beginPath(); ctx.moveTo(x, y);
        for (let k = 0; k < 8; k++) { x += (R() - 0.5) * 40; y += (R() - 0.3) * 30; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      T.asphalt = toTex(c);
      T.asphaltN = toTex(normalFromHeight(hgt, S, 2.2), true, false);
    }
    // ---------- 积水遮罩 ----------
    {
      const n = tileNoise(256, 4, 4, 33, 0.5);
      T.puddle = toTex(grayCanvas(n, 256, (v) => { const k = v * 255; return [k, k, k]; }), true, false);
    }
    // ---------- 人行道地砖（一张 = 2m，砖 0.5m） ----------
    {
      const c = canvas(S), ctx = c.getContext('2d');
      const n = tileNoise(S, 16, 4, 44);
      const hgt = new Float32Array(S * S);
      const img = ctx.createImageData(S, S);
      const tile = S / 4, grout = 4;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
        const lx = x - tx * tile, ly = y - ty * tile;
        const edge = Math.min(lx, ly, tile - lx, tile - ly);
        const tint = H.hash(tx * 7 + ty, 5) * 0.08;
        const i = y * S + x;
        let k = 0.70 + tint + (n[i] - 0.5) * 0.12;
        let h = 1;
        if (edge < grout) { k = 0.45; h = 0; } else if (edge < grout + 3) { h = (edge - grout) / 3; k *= 0.94 + 0.06 * h; }
        hgt[i] = h + n[i] * 0.2;
        img.data[i * 4] = k * 240; img.data[i * 4 + 1] = k * 232; img.data[i * 4 + 2] = k * 222; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      T.tiles = toTex(c);
      T.tilesN = toTex(normalFromHeight(hgt, S, 3), true, false);
    }
    // ---------- 墙面灰泥（一张 = 3m，乘以顶点色） ----------
    {
      const n = tileNoise(256, 8, 5, 55, 0.6);
      T.plaster = toTex(grayCanvas(n, 256, (v, i) => { const k = (0.86 + v * 0.14 + (H.hash(i, 9) - 0.5) * 0.04) * 255; return [k, k, k]; }));
      // 法线：大起伏 + 细颗粒（抹灰的手感）
      const fine = tileNoise(256, 64, 2, 56, 0.5);
      const hgt = new Float32Array(256 * 256);
      for (let i = 0; i < hgt.length; i++) hgt[i] = n[i] * 0.6 + fine[i] * 0.5 + (H.hash(i, 19) > 0.985 ? -0.4 : 0);
      T.plasterN = toTex(normalFromHeight(hgt, 256, 1.6), true, false);
    }
    // ---------- 红砖（一张 = 2m） ----------
    {
      const c = canvas(256), ctx = c.getContext('2d');
      ctx.fillStyle = '#d8d2c8'; ctx.fillRect(0, 0, 256, 256);
      const bh = 256 / 30, bw = 256 / 8;
      for (let r = 0; r < 30; r++) for (let k = -1; k < 9; k++) {
        const x = k * bw + (r % 2) * bw / 2, y = r * bh;
        const t = 0.82 + H.hash(r * 13 + k, 2) * 0.18;
        ctx.fillStyle = `rgb(${255 * t | 0},${248 * t | 0},${240 * t | 0})`;
        ctx.beginPath(); ctx.roundRect(x + 1, y + 1, bw - 2, bh - 2, 1.5); ctx.fill();
      }
      T.brick = toTex(c);
      // 法线：灰缝凹进去，砖面有点不平
      const hb = new Float32Array(256 * 256), nz = tileNoise(256, 32, 2, 71, 0.5);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const r = Math.floor(y / bh), off = (r % 2) * bw / 2;
        const lx = ((x - off) % bw + bw) % bw, ly = y - r * bh;
        const edge = Math.min(lx, bw - lx, ly, bh - ly);
        hb[y * 256 + x] = (edge < 1.2 ? 0 : Math.min(1, (edge - 1.2) / 1.5)) + nz[y * 256 + x] * 0.25;
      }
      T.brickN = toTex(normalFromHeight(hb, 256, 2.5), true, false);
    }
    // ---------- 草地（一张 = 2m） ----------
    {
      const n = tileNoise(256, 8, 5, 66, 0.55);
      const c = grayCanvas(n, 256, (v, i) => { const s = H.hash(i, 3); const g = 0.75 + v * 0.35 + (s - 0.5) * 0.25; return [70 * g, 140 * g, 55 * g]; });
      T.grass = toTex(c);
    }
    // ---------- 屋瓦（一张 = 2m） ----------
    {
      const c = canvas(256), ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
      const rows = 10, cols = 8, rh = 256 / rows, cw = 256 / cols;
      for (let r = 0; r < rows; r++) for (let k = -1; k <= cols; k++) {
        const x = k * cw + (r % 2) * cw / 2, y = r * rh;
        const g = ctx.createLinearGradient(0, y, 0, y + rh);
        const t = 0.8 + H.hash(r * 31 + k, 4) * 0.2;
        g.addColorStop(0, `rgba(${255 * t | 0},${255 * t | 0},${255 * t | 0},1)`);
        g.addColorStop(1, `rgba(${170 * t | 0},${170 * t | 0},${170 * t | 0},1)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x + 1, y, cw - 2, rh - 1, [0, 0, 8, 8]); ctx.fill();
      }
      T.roof = toTex(c);
      // 法线：每排瓦从上往下鼓起来，排与排之间有台阶
      const hr = new Float32Array(256 * 256);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const r = Math.floor(y / rh), fy = (y - r * rh) / rh;
        const k = Math.floor((x - (r % 2) * cw / 2 + 256) / cw), fx = ((x - (r % 2) * cw / 2 + 256) % cw) / cw;
        hr[y * 256 + x] = fy * 0.8 + Math.sin(fx * Math.PI) * 0.35 + H.hash(k, r) * 0.1;
      }
      T.roofN = toTex(normalFromHeight(hr, 256, 2.2), true, false);
    }
    buildInteriorTextures();
    // ---------- 写字楼玻璃幕墙：一张 = 6 列 x 4 层，每格 1.5m x 3.8m ----------
    {
      const W = 512, Hh = 1024; // 9m x 15.2m
      const c = canvas(W, Hh), ctx = c.getContext('2d');
      const e = canvas(W, Hh), ex = e.getContext('2d');
      ex.fillStyle = '#000'; ex.fillRect(0, 0, W, Hh);
      const cw = W / 6, fh = Hh / 4;
      for (let f = 0; f < 4; f++) for (let k = 0; k < 6; k++) {
        const x = k * cw, y = f * fh;
        const g = ctx.createLinearGradient(x, y, x + cw * 0.6, y + fh);
        const t = H.hash(f * 9 + k, 21);
        g.addColorStop(0, `rgb(${150 + t * 30 | 0},${185 + t * 25 | 0},${210 + t * 20 | 0})`);
        g.addColorStop(0.55, `rgb(${90 + t * 20 | 0},${125 + t * 20 | 0},${155 + t * 20 | 0})`);
        g.addColorStop(1, `rgb(${120 + t * 30 | 0},${150 + t * 30 | 0},${180 + t * 20 | 0})`);
        ctx.fillStyle = g; ctx.fillRect(x, y, cw, fh);
        // 窗间墙（楼板处不透明带）
        ctx.fillStyle = 'rgb(70,82,96)'; ctx.fillRect(x, y + fh * 0.8, cw, fh * 0.2);
        // 夜里亮灯的格子
        if (H.hash(f * 17 + k * 3, 77) > 0.45) {
          const w = 0.6 + H.hash(f + k * 11, 8) * 0.4;
          ex.fillStyle = `rgb(${255 * w | 0},${222 * w | 0},${170 * w | 0})`;
          ex.fillRect(x + 3, y + 3, cw - 6, fh * 0.8 - 6);
        }
      }
      // 竖向 / 横向铝框
      ctx.fillStyle = 'rgb(200,206,212)';
      for (let k = 0; k <= 6; k++) ctx.fillRect(k * cw - 3, 0, 6, Hh);
      for (let f = 0; f <= 4; f++) { ctx.fillRect(0, f * fh - 3, W, 6); ctx.fillRect(0, f * fh + fh * 0.8 - 2, W, 4); }
      T.curtain = toTex(c); T.curtain.repeat.set(1 / 9, 1 / 15.2);
      T.curtainE = toTex(e); T.curtainE.repeat.set(1 / 9, 1 / 15.2);
      // 粗糙度：玻璃光滑、框和窗间墙粗糙
      const rr = canvas(W, Hh), rx = rr.getContext('2d');
      rx.fillStyle = 'rgb(0,30,0)'; rx.fillRect(0, 0, W, Hh);
      rx.fillStyle = 'rgb(0,150,0)';
      for (let k = 0; k <= 6; k++) rx.fillRect(k * cw - 3, 0, 6, Hh);
      for (let f = 0; f < 4; f++) rx.fillRect(0, f * fh + fh * 0.8 - 2, W, fh * 0.2 + 4);
      T.curtainR = toTex(rr, true, false); T.curtainR.repeat.set(1 / 9, 1 / 15.2);
    }
    buildWindowAtlas();
    buildSignAtlas();
    buildAwnings();
    // ---------- 柔和圆点（雪 / 水花 / 光斑） ----------
    {
      const c = canvas(64), ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      T.dot = toTex(c, false);
      const p = canvas(128), px = p.getContext('2d');
      const g2 = px.createRadialGradient(64, 64, 0, 64, 64, 64);
      g2.addColorStop(0, 'rgba(255,220,160,0.9)'); g2.addColorStop(0.5, 'rgba(255,200,130,0.35)'); g2.addColorStop(1, 'rgba(255,190,120,0)');
      px.fillStyle = g2; px.fillRect(0, 0, 128, 128);
      T.pool = toTex(p, false);
    }
  };

  // ---------- 室内：木地板、瓷砖、石材、拉丝钢板、木纹 ----------
  function buildInteriorTextures() {
    // 木地板：一张 = 2.4m，板宽 16cm、错缝
    {
      const S = 512, c = canvas(S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
      const hgt = new Float32Array(S * S), grain = tileNoise(S, 16, 4, 81, 0.55);
      const pw = S / 15;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const col = Math.floor(x / pw), lx = x - col * pw;
        const off = H.hash(col, 3) * S, ly = (y + off) % S, seg = Math.floor(ly / (S / 2)), py = ly - seg * S / 2;
        const tint = 0.86 + H.hash(col * 7 + seg, 11) * 0.22;
        const g = grain[y * S + ((x * 7) % S)];
        const streak = 0.5 + 0.5 * Math.sin((lx * 0.9 + g * 18 + H.hash(col, 5) * 40) * 0.8);
        let k = tint * (0.82 + streak * 0.1 + g * 0.12);
        let h = 1;
        if (lx < 1.5 || py < 1.5) { k *= 0.55; h = 0; }
        const i = y * S + x;
        hgt[i] = h + g * 0.15;
        img.data[i * 4] = 196 * k; img.data[i * 4 + 1] = 148 * k; img.data[i * 4 + 2] = 102 * k; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      T.floorWood = toTex(c); T.floorWoodN = toTex(normalFromHeight(hgt, S, 2), true, false);
    }
    // 瓷砖：一张 = 1.2m，60cm 方砖
    {
      const S = 256, c = canvas(S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
      const hgt = new Float32Array(S * S), n = tileNoise(S, 8, 3, 91, 0.5);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const lx = x % (S / 2), ly = y % (S / 2), edge = Math.min(lx, ly, S / 2 - lx, S / 2 - ly);
        const i = y * S + x;
        let k = 0.92 + (n[i] - 0.5) * 0.06 + H.hash(Math.floor(x / (S / 2)) + Math.floor(y / (S / 2)) * 3, 4) * 0.04;
        let h = 1;
        if (edge < 1.6) { k = 0.62; h = 0; }
        hgt[i] = h;
        img.data[i * 4] = 250 * k; img.data[i * 4 + 1] = 248 * k; img.data[i * 4 + 2] = 244 * k; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      T.floorTile = toTex(c); T.floorTileN = toTex(normalFromHeight(hgt, S, 2), true, false);
    }
    // 大堂石材：一张 = 2.4m，80cm 大板，带一点云纹
    {
      const S = 512, n = tileNoise(S, 4, 5, 93, 0.6), v2 = tileNoise(S, 16, 3, 94, 0.5);
      const c = grayCanvas(n, S, (v, i) => {
        const x = i % S, y = Math.floor(i / S), lx = x % (S / 3), ly = y % (S / 3);
        const vein = Math.pow(1 - Math.abs(Math.sin((v * 6 + v2[i] * 2) * 3.0)), 16) * 0.1;
        let k = 0.9 + v * 0.06 - vein;
        if (Math.min(lx, ly, S / 3 - lx, S / 3 - ly) < 1) k = 0.7;
        k *= 255; return [k * 0.99, k * 0.97, k * 0.94];
      });
      T.floorStone = toTex(c);
    }
    // 拉丝不锈钢：一张 = 1m
    {
      const S = 256, c = canvas(S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
      const rowN = new Float32Array(S); for (let y = 0; y < S; y++) rowN[y] = H.hash(y, 61);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const k = (0.84 + rowN[y] * 0.06 + H.hash(i, 62) * 0.04) * 255;
        img.data[i * 4] = k; img.data[i * 4 + 1] = k; img.data[i * 4 + 2] = k * 1.02; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      T.steel = toTex(c);
    }
    // 木纹（门、木栅栏、长椅）：一张 = 1.2m，纹理竖向
    {
      const S = 256, g = tileNoise(S, 4, 4, 97, 0.6);
      const c = grayCanvas(g, S, (v, i) => {
        const x = i % S;
        const ring = 0.5 + 0.5 * Math.sin((x * 0.35 + v * 9) * 1.1);
        const k = (0.86 + ring * 0.08 + (H.hash(i, 98) - 0.5) * 0.04) * 255;
        return [k, k * 0.97, k * 0.93];
      });
      T.woodGrain = toTex(c);
    }
    // 室内墙面的淡纹理（抹灰的深浅斑驳 + 一点滚筒刷痕）：灰度围绕 0.5，着色器里按"封面那间满强度、别处一半"叠到底色上
    {
      const S = 256, n1 = tileNoise(S, 4, 4, 131, 0.55), n2 = tileNoise(S, 32, 2, 137, 0.5);
      const c = grayCanvas(n1, S, (v, i) => {
        const x = i % S;
        const roll = Math.sin((x / S) * Math.PI * 2 * 9 + v * 6) * 0.012;
        const k = (0.5 + (v - 0.5) * 0.17 + (n2[i] - 0.5) * 0.05 + roll) * 255;
        return [k, k, k];
      });
      T.wallI = toTex(c, true, false);
    }
    // 布料（沙发、床品）：平纹经纬交织 + 粗细不匀的纱（亚麻感），一张 = 0.3m；同样围绕 0.5
    {
      const S = 256, N = 40, cs = S / N, slub = tileNoise(S, 8, 3, 141, 0.5);
      const c = grayCanvas(slub, S, (v, i) => {
        const x = i % S, y = (i / S) | 0, ix = Math.floor(x / cs), iy = Math.floor(y / cs);
        const fx = (x - ix * cs) / cs, fy = (y - iy * cs) / cs;
        const warp = (ix + iy) & 1, shade = warp ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI);
        const k = (0.5 + (shade - 0.62) * 0.3 + (v - 0.5) * 0.3 + (H.hash(i, 142) - 0.5) * 0.05) * 255;
        return [k, k, k];
      });
      T.fabric = toTex(c, true, false);
    }
    // 电视画面：四零三新闻
    {
      const Wd = 1024, Hd = 560, c = canvas(Wd, Hd), x = c.getContext('2d');
      const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
      const bg = x.createLinearGradient(0, 0, Wd, Hd);
      bg.addColorStop(0, '#0a1f47'); bg.addColorStop(0.55, '#16438c'); bg.addColorStop(1, '#0d2c63');
      x.fillStyle = bg; x.fillRect(0, 0, Wd, Hd);
      const glow = x.createRadialGradient(Wd * 0.62, Hd * 0.38, 10, Wd * 0.62, Hd * 0.38, Wd * 0.55);
      glow.addColorStop(0, 'rgba(120,180,255,.35)'); glow.addColorStop(1, 'rgba(120,180,255,0)');
      x.fillStyle = glow; x.fillRect(0, 0, Wd, Hd);
      x.strokeStyle = 'rgba(160,200,255,.12)'; x.lineWidth = 2;
      for (let k = 0; k < 9; k++) { x.beginPath(); x.ellipse(Wd * 0.62, Hd * 0.38, 60 + k * 46, 30 + k * 23, 0, 0, Math.PI * 2); x.stroke(); }
      // 台标
      x.fillStyle = '#d7322b'; x.beginPath(); x.roundRect(40, 34, 150, 66, 14); x.fill();
      x.fillStyle = '#fff'; x.font = `900 50px ${FONT}`; x.textBaseline = 'middle'; x.fillText('403', 62, 69);
      x.font = `700 22px ${FONT}`; x.fillStyle = '#dfe9ff'; x.fillText('NEWS', 204, 69);
      // 直播角标 + 时间
      x.fillStyle = '#e8402f'; x.beginPath(); x.roundRect(Wd - 214, 38, 76, 40, 10); x.fill();
      x.fillStyle = '#fff'; x.font = `800 24px ${FONT}`; x.fillText('直播', Wd - 200, 59);
      x.font = `700 28px ${FONT}`; x.fillText('22:00', Wd - 124, 59);
      // 主标题
      x.textAlign = 'center'; x.font = `900 128px ${FONT}`;
      x.fillStyle = 'rgba(0,0,0,.35)'; x.fillText('四零三新闻', Wd / 2 + 4, 236);
      x.fillStyle = '#ffffff'; x.fillText('四零三新闻', Wd / 2, 230);
      x.fillStyle = '#d7322b'; x.fillRect(Wd / 2 - 250, 312, 500, 8);
      // 下方字幕条
      x.textAlign = 'left';
      x.fillStyle = 'rgba(255,255,255,.95)'; x.fillRect(0, 392, Wd, 64);
      x.fillStyle = '#d7322b'; x.fillRect(0, 392, 132, 64);
      x.fillStyle = '#fff'; x.font = `900 32px ${FONT}`; x.fillText('快讯', 34, 425);
      x.fillStyle = '#1b2433'; x.font = `700 30px ${FONT}`; x.fillText('K403+997 今夜有小雨 · 路面湿滑请慢行', 156, 425);
      x.fillStyle = 'rgba(6,16,36,.9)'; x.fillRect(0, 466, Wd, 52);
      x.fillStyle = '#cfe0ff'; x.font = `500 24px ${FONT}`; x.fillText('页面没找到，路找到了 · 404 高速路全线畅通 · 共享单车随叫随到 · 天桥每九个街区一座', 30, 493);
      T.news = toTex(c, false, true);
    }
  }

  // ---------- 窗户图集：4x4 格 ----------
  // 行0 住宅窗(暗) 行1 同款亮灯 行2 门/店面 行3 别墅窗 + 亮灯店面
  T.WIN = { cols: 4, rows: 4 };
  T.cell = function (col, row) {
    const pad = 3 / 1024;
    return [col / 4 + pad, 1 - (row + 1) / 4 + pad, (col + 1) / 4 - pad, 1 - row / 4 - pad];
  };
  function drawGlass(ctx, x, y, w, h, tint = 0) {
    const g = ctx.createLinearGradient(x, y, x + w * 0.5, y + h);
    g.addColorStop(0, `rgb(${170 + tint},${195 + tint},${215})`);
    g.addColorStop(0.45, 'rgb(70,88,110)');
    g.addColorStop(1, 'rgb(45,58,75)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function buildWindowAtlas() {
    const S = 1024, C = 256;
    const c = canvas(S), ctx = c.getContext('2d');
    const e = canvas(S), ex = e.getContext('2d');
    const r = canvas(S), rx = r.getContext('2d');
    ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);
    rx.fillStyle = 'rgb(0,140,0)'; rx.fillRect(0, 0, S, S);
    const curtains = ['#e9d8b4', '#c9dbe8', '#efc6c6', '#d8e6c8'];
    // 住宅窗：外框圆角，中间一根竖梃
    function resWindow(col, row, lit, kind) {
      const x = col * C, y = row * C;
      ctx.fillStyle = '#f4f2ee'; rr(ctx, x + 8, y + 8, C - 16, C - 16, 22); ctx.fill();
      const ix = x + 26, iy = y + 26, iw = C - 52, ih = C - 52;
      if (lit) {
        const g = ctx.createRadialGradient(ix + iw / 2, iy + ih * 0.4, 10, ix + iw / 2, iy + ih / 2, iw * 0.8);
        g.addColorStop(0, '#fff1cf'); g.addColorStop(1, '#e7b979');
        ctx.fillStyle = g; ctx.fillRect(ix, iy, iw, ih);
      } else drawGlass(ctx, ix, iy, iw, ih, kind * 6);
      // 窗帘 / 百叶 / 绿植
      ctx.globalAlpha = lit ? 0.85 : 0.55;
      ctx.fillStyle = curtains[kind];
      if (kind === 0) { ctx.fillRect(ix, iy, iw * 0.28, ih); ctx.fillRect(ix + iw * 0.72, iy, iw * 0.28, ih); }
      else if (kind === 1) { for (let k = 0; k < 9; k++) ctx.fillRect(ix, iy + k * ih / 9, iw, ih / 20); }
      else if (kind === 2) { ctx.fillRect(ix, iy, iw, ih * 0.45); }
      else { ctx.fillStyle = '#5f9d55'; ctx.beginPath(); ctx.arc(ix + iw * 0.25, iy + ih * 0.8, 26, 0, 7); ctx.arc(ix + iw * 0.35, iy + ih * 0.7, 20, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1;
      // 玻璃高光
      if (!lit) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.moveTo(ix + iw * 0.1, iy); ctx.lineTo(ix + iw * 0.35, iy); ctx.lineTo(ix + iw * 0.05, iy + ih * 0.6); ctx.lineTo(ix, iy + ih * 0.6); ctx.fill(); }
      ctx.fillStyle = '#f4f2ee'; ctx.fillRect(x + C / 2 - 5, iy, 10, ih);
      // 粗糙度：玻璃 0.05
      rx.fillStyle = 'rgb(0,12,0)'; rx.fillRect(ix, iy, iw, ih);
      if (lit) {
        const g = ex.createRadialGradient(ix + iw / 2, iy + ih * 0.4, 10, ix + iw / 2, iy + ih / 2, iw * 0.8);
        g.addColorStop(0, '#ffe7b0'); g.addColorStop(1, '#c98d45');
        ex.fillStyle = g; ex.fillRect(ix, iy, iw, ih);
        ex.fillStyle = '#000'; ex.fillRect(x + C / 2 - 5, iy, 10, ih);
      }
    }
    for (let k = 0; k < 4; k++) { resWindow(k, 0, false, k); resWindow(k, 1, true, k); }
    // 行2：0 公寓玻璃门 1 木门 2 写字楼大堂 3 店面橱窗(暗)
    {
      let x = 0, y = 2 * C;
      ctx.fillStyle = '#5b5f66'; rr(ctx, x + 10, y + 6, C - 20, C - 6, 14); ctx.fill();
      drawGlass(ctx, x + 26, y + 22, C / 2 - 30, C - 22); drawGlass(ctx, x + C / 2 + 4, y + 22, C / 2 - 30, C - 22);
      ctx.fillStyle = '#cfd3d8'; ctx.fillRect(x + C / 2 - 14, y + C * 0.5, 6, 40); ctx.fillRect(x + C / 2 + 8, y + C * 0.5, 6, 40);
      rx.fillStyle = 'rgb(0,15,0)'; rx.fillRect(x + 26, y + 22, C - 52, C - 22);
      ex.fillStyle = 'rgb(120,100,70)'; ex.fillRect(x + 26, y + 22, C - 52, C - 22);
      x = C;
      const g = ctx.createLinearGradient(x, y, x + C, y);
      g.addColorStop(0, '#8a5a36'); g.addColorStop(1, '#a8714a');
      ctx.fillStyle = '#f2efe8'; rr(ctx, x + 14, y + 6, C - 28, C - 6, 16); ctx.fill();
      ctx.fillStyle = g; rr(ctx, x + 32, y + 22, C - 64, C - 22, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(60,35,20,0.5)'; ctx.lineWidth = 4;
      rr(ctx, x + 50, y + 40, C - 100, 70, 8); ctx.stroke(); rr(ctx, x + 50, y + 130, C - 100, 100, 8); ctx.stroke();
      ctx.fillStyle = '#e8c766'; ctx.beginPath(); ctx.arc(x + C - 58, y + C * 0.58, 8, 0, 7); ctx.fill();
      x = 2 * C;
      drawGlass(ctx, x, y, C, C, 20);
      ctx.fillStyle = 'rgba(255,240,215,0.35)'; ctx.fillRect(x, y + C * 0.55, C, C * 0.45);
      ctx.fillStyle = '#c4cad0'; for (let k = 0; k <= 4; k++) ctx.fillRect(x + k * C / 4 - 4, y, 8, C); ctx.fillRect(x, y, C, 8);
      rx.fillStyle = 'rgb(0,10,0)'; rx.fillRect(x + 4, y + 8, C - 8, C - 8);
      ex.fillStyle = 'rgb(200,175,130)'; ex.fillRect(x + 4, y + 8, C - 8, C - 8);
      ex.fillStyle = '#000'; for (let k = 0; k <= 4; k++) ex.fillRect(x + k * C / 4 - 4, y, 8, C);
      shopWindow(3 * C, y, false);
    }
    // 行3：0/1 别墅窗（带十字窗棂） 2 亮灯店面 3 车库门
    for (let k = 0; k < 2; k++) {
      const x = k * C, y = 3 * C;
      ctx.fillStyle = '#ffffff'; rr(ctx, x + 10, y + 10, C - 20, C - 20, 26); ctx.fill();
      const ix = x + 28, iy = y + 28, iw = C - 56, ih = C - 56;
      if (k) { const g = ctx.createRadialGradient(ix + iw / 2, iy + ih / 2, 10, ix + iw / 2, iy + ih / 2, iw); g.addColorStop(0, '#fff3d6'); g.addColorStop(1, '#e8b56f'); ctx.fillStyle = g; ctx.fillRect(ix, iy, iw, ih); }
      else drawGlass(ctx, ix, iy, iw, ih, 10);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x + C / 2 - 6, iy, 12, ih); ctx.fillRect(ix, y + C / 2 - 6, iw, 12);
      ctx.fillStyle = 'rgba(240,210,210,0.6)'; ctx.fillRect(ix, iy, iw, 26);
      rx.fillStyle = 'rgb(0,12,0)'; rx.fillRect(ix, iy, iw, ih);
      if (k) { ex.fillStyle = 'rgb(230,180,110)'; ex.fillRect(ix, iy, iw, ih); ex.fillStyle = '#000'; ex.fillRect(x + C / 2 - 6, iy, 12, ih); ex.fillRect(ix, y + C / 2 - 6, iw, 12); }
    }
    shopWindow(2 * C, 3 * C, true);
    {
      const x = 3 * C, y = 3 * C;
      ctx.fillStyle = '#e9e6e0'; rr(ctx, x + 6, y + 6, C - 12, C - 6, 14); ctx.fill();
      for (let k = 0; k < 8; k++) { ctx.fillStyle = k % 2 ? '#d6d2ca' : '#e2ded6'; ctx.fillRect(x + 20, y + 22 + k * 28, C - 40, 28); }
    }
    function shopWindow(x, y, lit) {
      if (lit) { const g = ctx.createLinearGradient(x, y, x, y + C); g.addColorStop(0, '#fff6dc'); g.addColorStop(1, '#f0c88a'); ctx.fillStyle = g; ctx.fillRect(x, y, C, C); }
      else drawGlass(ctx, x, y, C, C, 15);
      // 货架和商品
      for (let s = 0; s < 3; s++) {
        const sy = y + 70 + s * 60;
        ctx.fillStyle = lit ? '#b98a5a' : 'rgba(150,120,90,0.6)'; ctx.fillRect(x + 12, sy + 34, C - 24, 6);
        for (let k = 0; k < 7; k++) {
          const hue = Math.floor(H.hash(s * 7 + k, x) * 360);
          ctx.fillStyle = `hsla(${hue},60%,${lit ? 62 : 45}%,${lit ? 1 : 0.7})`;
          rr(ctx, x + 18 + k * 32, sy + 34 - 14 - H.hash(k, s) * 16, 22, 30, 5); ctx.fill();
        }
      }
      ctx.fillStyle = '#4a4f57'; ctx.fillRect(x, y, C, 10); ctx.fillRect(x, y + C - 10, C, 10); ctx.fillRect(x, y, 8, C); ctx.fillRect(x + C - 8, y, 8, C);
      rx.fillStyle = 'rgb(0,12,0)'; rx.fillRect(x + 8, y + 10, C - 16, C - 20);
      ex.fillStyle = lit ? 'rgb(190,160,115)' : 'rgb(110,92,70)'; ex.fillRect(x + 8, y + 10, C - 16, C - 20);
    }
    T.windows = toTex(c, false); T.windowsE = toTex(e, false); T.windowsR = toTex(r, false, false);
    [T.windows, T.windowsE, T.windowsR].forEach((t) => { t.minFilter = THREE.LinearMipmapLinearFilter; });
  }

  // ---------- 招牌图集：2 列 x 12 行，每块 512x85 ----------
  T.SHOPS = ['404 便利店', '转角咖啡', '未找到面馆', '页面书店', '回车理发', '缓存超市', '像素花店', '重定向药房',
    '超时奶茶', '刷新烘焙', '断点修车', '路由小馆', '跳转水果', '加载中照相馆', '空指针五金', '云端干洗',
    '404 科技', '重定向集团', '云端大厦', '缓存中心', '彩虹公寓', '晴天家园', '街角邮局', '404 路公交'];
  T.signCell = function (i) {
    const col = i % 2, row = Math.floor(i / 2), rows = 12;
    const pad = 2 / 1024;
    return [col / 2 + pad, 1 - (row + 1) / rows + pad, (col + 1) / 2 - pad, 1 - row / rows - pad];
  };
  function buildSignAtlas() {
    const S = 1024, rows = 12, cw = S / 2, ch = S / rows;
    const c = canvas(S), ctx = c.getContext('2d');
    const e = canvas(S), ex = e.getContext('2d');
    ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);
    const bgs = ['#e85d4a', '#2f8f83', '#f2a33a', '#3b6fb6', '#8a5cc2', '#3a9d5d', '#e0699a', '#2b7bb9', '#c96b3c', '#d9a21b', '#556270', '#1f9aa5'];
    T.SHOPS.forEach((name, i) => {
      const x = (i % 2) * cw, y = Math.floor(i / 2) * ch;
      const bg = bgs[i % bgs.length];
      ctx.fillStyle = bg; rr(ctx, x + 6, y + 6, cw - 12, ch - 12, 30); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; rr(ctx, x + 14, y + 12, cw - 28, (ch - 24) * 0.45, 20); ctx.fill();
      ctx.fillStyle = '#fffaf0';
      ctx.font = `bold ${Math.floor(ch * 0.52)}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, x + cw / 2, y + ch / 2 + 2, cw - 50);
      ex.fillStyle = bg; rr(ex, x + 6, y + 6, cw - 12, ch - 12, 30); ex.fill();
      ex.globalAlpha = 0.5; ex.fillStyle = '#000'; rr(ex, x + 6, y + 6, cw - 12, ch - 12, 30); ex.fill(); ex.globalAlpha = 1;
      ex.fillStyle = '#fff6e0'; ex.font = ctx.font; ex.textAlign = 'center'; ex.textBaseline = 'middle';
      ex.fillText(name, x + cw / 2, y + ch / 2 + 2, cw - 50);
    });
    T.signs = toTex(c, false); T.signsE = toTex(e, false);
  }

  // ---------- 遮阳棚条纹：4 行配色 ----------
  T.AWN = 4;
  function buildAwnings() {
    const c = canvas(256, 256), ctx = c.getContext('2d');
    const pal = [['#e04b3c', '#fdf6ec'], ['#2f9a6a', '#fdf6ec'], ['#2f6fb5', '#fdf6ec'], ['#f0a12c', '#fdf6ec']];
    pal.forEach((p, r) => {
      for (let k = 0; k < 8; k++) { ctx.fillStyle = p[k % 2]; ctx.fillRect(k * 32, r * 64, 32, 64); }
    });
    T.awning = toTex(c); T.awning.wrapT = THREE.ClampToEdgeWrapping;
  }
})();
