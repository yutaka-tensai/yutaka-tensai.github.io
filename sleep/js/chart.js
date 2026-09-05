// Canvas による睡眠グラフ・統計チャート描画

import { clamp, fmtClock, pad2 } from './utils.js';

const C = {
  bg: 'rgba(255,255,255,0.03)',
  grid: 'rgba(255,255,255,0.08)',
  text: 'rgba(226,232,255,0.55)',
  deep: '#6d5cff',
  light: '#4aa8ff',
  awake: '#ff8bb0',
  snore: '#ffb547',
  accent: '#8b7bff',
};

export function setup(canvas, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const height = h || canvas.clientHeight || 180;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

/**
 * 睡眠グラフ（ヒプノグラム）。深さ 0=覚醒 → 1=深い睡眠 を上下反転した曲線で描く。
 */
export function drawHypnogram(canvas, session, opts = {}) {
  const depth = session.depth || [];
  const { ctx, w, h } = setup(canvas, opts.height || 200);
  const padL = 34, padR = 8, padT = 14, padB = 22;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  if (!depth.length) {
    ctx.fillStyle = C.text;
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('データがありません', w / 2, h / 2);
    return;
  }

  const start = session.start;
  const end = session.end || start + depth.length * 30000;
  const span = Math.max(1, end - start);
  const xAt = (t) => padL + ((t - start) / span) * gw;
  const yAt = (d) => padT + clamp(d, 0, 1) * gh;

  // 段階の帯
  const bands = [
    ['覚醒', 0, 0.16],
    ['浅い', 0.16, 0.66],
    ['深い', 0.66, 1],
  ];
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  bands.forEach(([label, a, b], i) => {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(padL, yAt(a), gw, yAt(b) - yAt(a));
    ctx.fillStyle = C.text;
    ctx.fillText(label, padL - 6, (yAt(a) + yAt(b)) / 2);
  });

  // 1 時間ごとの目盛り
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime(); t <= end; t += 3600_000) {
    if (t < start) continue;
    const x = xAt(t);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + gh);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(pad2(new Date(t).getHours()), x, padT + gh + 5);
  }

  // 深さの曲線（滑らかに）
  const pts = depth.map((d, i) => [xAt(start + i * 30000), yAt(d)]);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], padT);
  ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  ctx.save();
  ctx.lineTo(pts[pts.length - 1][0], padT);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + gh);
  grad.addColorStop(0, 'rgba(255,139,176,0.35)');
  grad.addColorStop(0.35, 'rgba(74,168,255,0.35)');
  grad.addColorStop(1, 'rgba(109,92,255,0.55)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  ctx.strokeStyle = 'rgba(200,214,255,0.9)';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // いびきのマーカー
  const eps = session.epochs || [];
  ctx.fillStyle = C.snore;
  for (let i = 0; i < eps.length; i++) {
    if ((eps[i].snoreSec || 0) > 3) {
      const x = xAt(start + i * 30000);
      ctx.fillRect(x - 0.8, padT + gh - 3, 1.6, 3);
    }
  }

  // アラームの位置
  if (session.alarmAt && session.alarmAt >= start && session.alarmAt <= end) {
    const x = xAt(session.alarmAt);
    ctx.strokeStyle = 'rgba(255,181,71,0.8)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + gh);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** 品質のリング */
export function drawRing(canvas, pct, opts = {}) {
  const size = opts.size || 132;
  const { ctx, w, h } = setup(canvas, size);
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 10;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#4aa8ff');
  g.addColorStop(1, '#a78bfa');
  ctx.strokeStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * clamp(pct, 0, 100)) / 100);
  ctx.stroke();
  ctx.fillStyle = '#eef2ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 30px system-ui';
  ctx.fillText(Math.round(pct) + '%', cx, cy - 4);
  ctx.font = '11px system-ui';
  ctx.fillStyle = C.text;
  ctx.fillText(opts.label || '睡眠の質', cx, cy + 20);
}

/**
 * 棒グラフ。items: [{label, value, value2?, quality?}]
 */
export function drawBars(canvas, items, opts = {}) {
  const { ctx, w, h } = setup(canvas, opts.height || 160);
  const padL = 30, padR = 6, padT = 10, padB = 20;
  const gw = w - padL - padR, gh = h - padT - padB;
  if (!items.length) {
    ctx.fillStyle = C.text;
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('データがありません', w / 2, h / 2);
    return;
  }
  const max = opts.max || Math.max(...items.map((i) => i.value)) * 1.15 || 1;
  const bw = Math.min(26, (gw / items.length) * 0.62);
  const step = gw / items.length;

  // 目標ライン
  if (opts.goal) {
    const y = padT + gh - (opts.goal / max) * gh;
    ctx.strokeStyle = 'rgba(255,181,71,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + gw, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 縦軸
  ctx.font = '10px system-ui';
  ctx.fillStyle = C.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 2; k++) {
    const v = (max / 2) * k;
    const y = padT + gh - (v / max) * gh;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + gw, y);
    ctx.stroke();
    ctx.fillText(opts.fmtY ? opts.fmtY(v) : String(Math.round(v)), padL - 5, y);
  }

  items.forEach((it, i) => {
    const x = padL + step * i + (step - bw) / 2;
    const bh = (clamp(it.value, 0, max) / max) * gh;
    const y = padT + gh - bh;
    const g = ctx.createLinearGradient(0, y, 0, padT + gh);
    const hue = it.quality != null ? it.quality : 60;
    g.addColorStop(0, hue >= 70 ? '#7c6cff' : hue >= 45 ? '#4aa8ff' : '#ff8bb0');
    g.addColorStop(1, 'rgba(124,108,255,0.18)');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, bw, Math.max(2, bh), 4);
    ctx.fill();
    if (opts.labels !== false) {
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '9px system-ui';
      ctx.fillText(it.label, x + bw / 2, padT + gh + 5);
    }
  });
}

/** 就寝〜起床の時間帯を横棒で並べ、生活リズムの安定度を見る */
export function drawRegularity(canvas, sessions, opts = {}) {
  const rows = sessions.slice(0, 14).reverse();
  const { ctx, w, h } = setup(canvas, opts.height || Math.max(120, rows.length * 16 + 30));
  const padL = 40, padR = 8, padT = 16, padB = 16;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  if (!rows.length) return;
  // 18:00 → 翌 12:00 の 18 時間軸
  const AXIS_START = 18 * 60, AXIS_LEN = 18 * 60;
  const xAt = (min) => {
    let m = min - AXIS_START;
    if (m < 0) m += 1440;
    return padL + (clamp(m, 0, AXIS_LEN) / AXIS_LEN) * gw;
  };
  ctx.font = '10px system-ui';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let hh = 18; hh <= 36; hh += 3) {
    const x = xAt((hh % 24) * 60);
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + gh);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(pad2(hh % 24), x, 2);
  }
  const rowH = gh / rows.length;
  rows.forEach((s, i) => {
    const d = new Date(s.start);
    const bed = d.getHours() * 60 + d.getMinutes();
    const w2 = new Date(s.end);
    const wake = w2.getHours() * 60 + w2.getMinutes();
    const y = padT + i * rowH + rowH * 0.2;
    const x1 = xAt(bed), x2 = xAt(wake);
    const g = ctx.createLinearGradient(x1, 0, x2, 0);
    g.addColorStop(0, '#4aa8ff');
    g.addColorStop(1, '#8b7bff');
    ctx.fillStyle = g;
    roundRect(ctx, x1, y, Math.max(3, x2 - x1), rowH * 0.6, rowH * 0.3);
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right';
    ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, padL - 6, y);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 夜間ビュー用のライブ波形（右端が最新。左へ流れていく） */
export function drawLive(canvas, values, opts = {}) {
  const { ctx, w, h } = setup(canvas, opts.height || 70);
  const slots = opts.slots || 120;
  const step = w / slots;
  const xAt = (i) => w - (values.length - 1 - i) * step;

  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  ctx.moveTo(0, h - 3);
  ctx.lineTo(w, h - 3);
  ctx.stroke();
  if (!values.length) return;

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = xAt(i);
    const y = h - clamp(v, 0, 1) * (h - 8) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xAt(values.length - 1), h - 3);
  ctx.lineTo(xAt(0), h - 3);
  ctx.closePath();
  ctx.fillStyle = 'rgba(120,140,255,0.15)';
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = xAt(i);
    const y = h - clamp(v, 0, 1) * (h - 8) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(160,180,255,0.65)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
