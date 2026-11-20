/* 拍照导演 · 端侧取景分析
 * 纯 JS、无模型、无网络：边缘密度 + 与画面平均色的差异 当显著性代理，
 * 行梯度找地平线，HSV 判天空比例，规则挑「人该站的框」。
 * 与 pose-demo/analyze.py 同一套规则，Python 版用 FFT 谱残差，浏览器版用边缘密度，
 * 两者对「往哪站」的结论一致，边框坐标会有几个百分点差异。
 */
(function (global) {
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function gray(d, W, H) {
    var g = new Float32Array(W * H);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
    }
    return g;
  }

  function edgeMap(g, W, H) {
    var m = new Float32Array(W * H), i, x, y, p;
    for (y = 1; y < H - 1; y++) {
      for (x = 1; x < W - 1; x++) {
        p = y * W + x;
        var gx = (g[p - W + 1] + 2 * g[p + 1] + g[p + W + 1]) - (g[p - W - 1] + 2 * g[p - 1] + g[p + W - 1]);
        var gy = (g[p + W - 1] + 2 * g[p + W] + g[p + W + 1]) - (g[p - W - 1] + 2 * g[p - W] + g[p - W + 1]);
        m[p] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return m;
  }

  function colorDev(d, W, H) {
    var n = W * H, r = 0, g = 0, b = 0, i, p;
    for (i = 0, p = 0; i < n; i++, p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; }
    r /= n; g /= n; b /= n;
    var out = new Float32Array(n);
    for (i = 0, p = 0; i < n; i++, p += 4) {
      var dr = d[p] - r, dg = d[p + 1] - g, db = d[p + 2] - b;
      out[i] = Math.sqrt(dr * dr + dg * dg + db * db) / 441;
    }
    return out;
  }

  function blur(a, W, H, k) {
    var out = new Float32Array(W * H), y, x, dy, dx, s, c;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        s = 0; c = 0;
        for (dy = -k; dy <= k; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (dx = -k; dx <= k; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= W) continue;
            s += a[yy * W + xx]; c++;
          }
        }
        out[y * W + x] = s / c;
      }
    }
    return out;
  }

  function norm(a) {
    var mx = 0, i;
    for (i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
    if (mx <= 1e-6) return new Float32Array(a.length);
    var out = new Float32Array(a.length);
    for (i = 0; i < a.length; i++) out[i] = a[i] / mx;
    return out;
  }

  function boxBlurMean(a, W, H) {
    var out = new Float32Array(W * H), r = 2, x, y, dx, dy, s, c;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        s = 0; c = 0;
        for (dy = -r; dy <= r; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (dx = -r; dx <= r; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= W) continue;
            s += a[yy * W + xx]; c++;
          }
        }
        out[y * W + x] = s / c;
      }
    }
    return out;
  }

  function horizonRow(g, W, H) {
    var row = new Float32Array(H), y, x, s;
    for (y = 1; y < H; y++) {
      s = 0;
      for (x = 0; x < W; x++) s += Math.abs(g[y * W + x] - g[(y - 1) * W + x]);
      row[y] = s / W;
    }
    var lo = Math.round(0.35 * H), hi = Math.round(0.78 * H), best = lo;
    for (y = lo; y < hi; y++) if (row[y] > row[best]) best = y;
    return best / H;
  }

  function skyRatio(d, W, H) {
    var rows = Math.max(1, Math.round(0.32 * H)), hit = 0, n = 0, x, y, p;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < W; x++) {
        p = (y * W + x) * 4;
        var r = d[p] / 255, gg = d[p + 1] / 255, b = d[p + 2] / 255;
        var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        var v = mx, sat = mx <= 1e-6 ? 0 : (mx - mn) / mx;
        if (v > 0.55 && sat < 0.38) hit++;
        n++;
      }
    }
    return hit / n;
  }

  function brightness(d, W, H) {
    return gray(d, W, H);
  }

  function bestBox(sal, W, H) {
    var best = null;
    [0.42, 0.50, 0.60].forEach(function (h) {
      var w = h * 0.44 * (H / W);
      for (var x = 0.06; x <= 0.86 - w; x += 0.04) {
        [0.94, 0.90].forEach(function (bottom) {
          var y = bottom - h;
          var ys = Math.round(y * H), xs = Math.round(x * W);
          var ye = Math.round(bottom * H), xe = Math.round((x + w) * W);
          if (xe <= xs || ye <= ys) return;
          var s = 0, c = 0, yy, xx;
          for (yy = Math.max(0, ys); yy < Math.min(H, ye); yy++) {
            for (xx = Math.max(0, xs); xx < Math.min(W, xe); xx++) { s += sal[yy * W + xx]; c++; }
          }
          if (!c) return;
          var score = s / c;
          [1 / 3, 2 / 3].forEach(function (third) {
            score += 0.06 * Math.max(0, 1 - Math.abs((x + w / 2) - third) * 4);
          });
          if (!best || score > best[0]) best = [score, x, y, w, h];
        });
      }
    });
    if (!best) return [0.15, 0.34, 0.22, 0.56];
    return [best[1], best[2], best[3], best[4]].map(function (v) { return Math.round(v * 1000) / 1000; });
  }

  function runPixels(d, W, H) {
    var g = gray(d, W, H);
    var sal = norm(boxBlurMean(norm(edgeMap(g, W, H)), W, H));
    var dev = norm(boxBlurMean(colorDev(d, W, H), W, H));
    var i, mix = new Float32Array(W * H);
    for (i = 0; i < mix.length; i++) mix[i] = 0.62 * sal[i] + 0.38 * dev[i];
    mix = boxBlurMean(mix, W, H);

    var hor = horizonRow(g, W, H);
    var sky = skyRatio(d, W, H);
    var topB = 0, botB = 0, nt = 0, nb = 0, y;
    for (y = 0; y < Math.round(0.25 * H); y++) { for (var x = 0; x < W; x++) { topB += g[y * W + x]; nt++; } }
    for (y = Math.round(0.55 * H); y < H; y++) { for (x = 0; x < W; x++) { botB += g[y * W + x]; nb++; } }
    topB /= Math.max(1, nt); botB /= Math.max(1, nb);
    var backlit = sky > 0.25 && topB > botB * 1.15;
    var scene = sky > 0.30 ? 'field' : 'street';
    var box = bestBox(mix, W, H);

    return {
      W: W, H: H, box: box, horizon: Math.round(hor * 1000) / 1000,
      sky: Math.round(sky * 1000) / 1000, backlit: backlit, scene: scene,
      top: Math.round(topB * 1000) / 1000, bottom: Math.round(botB * 1000) / 1000,
      center: Math.round((box[0] + box[2] / 2) * 1000) / 1000
    };
  }

  global.Analyze = { runPixels: runPixels };
})(typeof window !== 'undefined' ? window : globalThis);
