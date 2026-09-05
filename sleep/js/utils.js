// 汎用ユーティリティ

export const MIN = 60_000;
export const HOUR = 3_600_000;

export const pad2 = (n) => String(n).padStart(2, '0');
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** 0..1 に正規化されたガウス窓 */
export function gauss(x, mu, sigma) {
  const d = (x - mu) / sigma;
  return Math.exp(-0.5 * d * d);
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtClockSec(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 分 → 「7時間32分」 */
export function fmtDur(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}分`;
  return `${h}時間${r}分`;
}

/** 分 → 「7:32」 */
export function fmtDurShort(min) {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

export function fmtDateShort(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function weekday(ts) {
  return WEEK[new Date(ts).getDay()];
}

/** 「23:15」形式の時刻文字列を、baseTs 以降で最初に来るその時刻の epoch ms に変換 */
export function nextTimeAfter(hhmm, baseTs = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(baseTs);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  let t = d.getTime();
  if (t <= baseTs) t += 24 * HOUR;
  return t;
}

/** 時刻を 0..1440 の「分」に。夜型の比較用に 18:00 を境に前日側へ折り返す */
export function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function el(sel, root = document) {
  return root.querySelector(sel);
}
export function els(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function on(node, ev, fn, opts) {
  node.addEventListener(ev, fn, opts);
  return () => node.removeEventListener(ev, fn, opts);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 移動平均（対称窓） */
export function smooth(arr, radius) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= arr.length) continue;
      s += arr[j];
      n++;
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 軽いトースト表示 */
export function toast(msg, ms = 2600) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = make('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const t = make('div', 'toast', msg);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
}
