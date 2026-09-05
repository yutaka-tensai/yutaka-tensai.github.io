// 睡眠段階の判定・スコア計算・統計集計

import { EPOCH_MS } from './tracker.js';
import { clamp, gauss, smooth, mean, median, minutesOfDay } from './utils.js';

export const AWAKE = 0;
export const LIGHT = 1;
export const DEEP = 2;
export const STAGE_LABEL = ['覚醒', '浅い睡眠', '深い睡眠'];
export const EPOCH_MIN = EPOCH_MS / 60000;

/**
 * エポック列から睡眠段階・深さカーブ・サマリーを計算する。
 * 活動量から睡眠/覚醒を分けるのは Cole-Kripke 法の考え方（前後のエポックに
 * 重みをつけた加重和）を単純化したもの。深さは「静けさ」と約90分の睡眠周期・
 * 前半に深睡眠が偏る性質を組み合わせた推定。
 */
export function analyze(session) {
  const eps = session.epochs || [];
  const n = eps.length;
  const act = eps.map((e) => e.activity);
  const depth = new Array(n).fill(0);
  const stage = new Array(n).fill(AWAKE);
  if (!n) return { depth, stage, summary: emptySummary(session) };

  const W = [0.12, 0.2, 0.4, 0.18, 0.1];
  const wake = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let s = 0, wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = W[k + 2];
      s += act[j] * w;
      wsum += w;
    }
    wake[i] = s / wsum > 0.3;
  }

  // 入眠時刻: 静かなエポックが 3 分続いた最初の地点
  let onset = -1;
  for (let i = 0; i + 5 < n; i++) {
    let ok = true;
    for (let k = 0; k < 6; k++) if (wake[i + k]) { ok = false; break; }
    if (ok) { onset = i; break; }
  }
  if (onset < 0) onset = n; // 一度も眠っていない

  const sm = smooth(act, 3);

  // 「静けさ」はその夜の中での相対値で見る（端末やマイク感度の違いを吸収するため）
  const quiet = [];
  for (let i = onset; i < n; i++) if (!wake[i]) quiet.push(sm[i]);
  quiet.sort((a, b) => a - b);
  const pct = (p) => (quiet.length ? quiet[clamp(Math.round(p * (quiet.length - 1)), 0, quiet.length - 1)] : 0);
  const q20 = pct(0.2);
  const span = Math.max(0.05, pct(0.85) - q20);

  for (let i = 0; i < n; i++) {
    if (i < onset || wake[i]) { depth[i] = 0; stage[i] = AWAKE; continue; }
    const m = (i - onset) * EPOCH_MIN;
    const rest = clamp(1 - (sm[i] - q20) / span, 0, 1);
    const pressure = 0.45 + 0.55 * Math.exp(-m / 230); // 深睡眠は夜の前半に偏る
    const phase = (m % 92) / 92; // 約90分の睡眠周期
    const win = gauss(phase, 0.42, 0.17); // 各周期の谷が深睡眠
    const ramp = clamp(m / 16, 0, 1); // 入眠直後は徐々に深くなる
    // 表示用に 0.16（＝浅い睡眠の上端）から始まるようにスケールし、
    // 眠っているのにグラフが「覚醒」の帯に入らないようにする
    const raw = rest * (0.25 + 0.75 * pressure * win) * ramp;
    depth[i] = clamp(0.16 + 0.84 * raw, 0, 1);
    stage[i] = depth[i] >= 0.66 ? DEEP : LIGHT;
  }

  const curve = smooth(depth, 3);
  return { depth: curve, stage, onset, summary: summarize(session, stage, curve, onset) };
}

function emptySummary(session) {
  const inBed = session.end && session.start ? (session.end - session.start) / 60000 : 0;
  return {
    inBedMin: inBed, asleepMin: 0, awakeMin: inBed, lightMin: 0, deepMin: 0,
    awakenings: 0, onsetMin: 0, efficiency: 0, snoreMin: 0, quality: 0,
  };
}

function summarize(session, stage, depth, onset) {
  const n = stage.length;
  let awake = 0, light = 0, deep = 0, awakenings = 0, run = 0;
  for (let i = 0; i < n; i++) {
    if (stage[i] === AWAKE) {
      awake++;
      if (i > onset) run++;
    } else {
      if (run >= 2) awakenings++; // 1 分以上の覚醒を「目覚め」として数える
      run = 0;
      if (stage[i] === DEEP) deep++;
      else light++;
    }
  }
  if (run >= 2) awakenings++;

  const inBedMin = session.end && session.start ? (session.end - session.start) / 60000 : n * EPOCH_MIN;
  const asleepMin = (light + deep) * EPOCH_MIN;
  const snoreMin = (session.epochs || []).reduce((a, e) => a + (e.snoreSec || 0), 0) / 60;
  const efficiency = inBedMin > 0 ? clamp(asleepMin / inBedMin, 0, 1) : 0;
  const goal = session.goalMin || 480;

  const durScore = asleepMin >= goal ? clamp(1 - (asleepMin - goal * 1.3) / (goal * 0.6), 0.75, 1) : asleepMin / goal;
  const deepRatio = asleepMin > 0 ? (deep * EPOCH_MIN) / asleepMin : 0;
  const deepScore = clamp(deepRatio / 0.22, 0, 1);
  const wakeScore = clamp(1 - awakenings / 9, 0, 1);
  const quality = Math.round(100 * clamp(0.3 * efficiency + 0.25 * clamp(durScore, 0, 1) + 0.25 * deepScore + 0.2 * wakeScore, 0, 1));

  return {
    inBedMin, asleepMin,
    awakeMin: awake * EPOCH_MIN,
    lightMin: light * EPOCH_MIN,
    deepMin: deep * EPOCH_MIN,
    awakenings, onsetMin: onset * EPOCH_MIN,
    efficiency, snoreMin, deepRatio, quality,
  };
}

/** セッションに summary を埋め込んで保存できる形にする */
export function finalize(session) {
  const { depth, stage, summary, onset } = analyze(session);
  session.summary = summary;
  session.onset = onset;
  session.depth = depth.map((d) => Math.round(d * 100) / 100);
  session.stage = stage;
  return session;
}

/* ------------------------------ 集計 ------------------------------ */

export function aggregate(sessions) {
  const list = sessions.filter((s) => s.summary);
  if (!list.length) return null;
  const dur = list.map((s) => s.summary.asleepMin);
  const q = list.map((s) => s.summary.quality);
  const bed = list.map((s) => wrapNight(minutesOfDay(s.start)));
  const wakeT = list.map((s) => minutesOfDay(s.end));
  const goal = list[0].goalMin || 480;
  const debt = list.slice(0, 7).reduce((a, s) => a + (goal - s.summary.asleepMin), 0);
  const moods = list.filter((s) => s.mood).map((s) => s.mood);
  return {
    count: list.length,
    avgDuration: mean(dur),
    avgQuality: mean(q),
    avgBedtime: unwrapNight(median(bed)),
    avgWake: median(wakeT),
    bedtimeSpread: spread(bed),
    wakeSpread: spread(wakeT),
    avgDeep: mean(list.map((s) => s.summary.deepMin)),
    avgSnore: mean(list.map((s) => s.summary.snoreMin)),
    avgAwakenings: mean(list.map((s) => s.summary.awakenings)),
    sleepDebt: debt,
    bestQuality: Math.max(...q),
    avgEfficiency: mean(list.map((s) => s.summary.efficiency)),
    avgMood: moods.length ? mean(moods) : 0,
    moodCount: moods.length,
  };
}

/** 18:00 以降の就寝時刻を負の値に折り返して平均できるようにする */
function wrapNight(min) {
  return min >= 18 * 60 ? min - 1440 : min;
}
function unwrapNight(min) {
  return min < 0 ? min + 1440 : min;
}
function spread(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

/** 睡眠メモ（タグ）ごとの平均品質を、それ以外の日と比較する */
export function noteStats(sessions) {
  const list = sessions.filter((s) => s.summary);
  const byTag = new Map();
  for (const s of list) {
    for (const tag of s.notes || []) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(s);
    }
  }
  const out = [];
  for (const [tag, tagged] of byTag) {
    if (tagged.length < 2) continue;
    const others = list.filter((s) => !(s.notes || []).includes(tag));
    if (others.length < 2) continue;
    const a = mean(tagged.map((s) => s.summary.quality));
    const b = mean(others.map((s) => s.summary.quality));
    out.push({
      tag,
      nights: tagged.length,
      quality: a,
      delta: a - b,
      duration: mean(tagged.map((s) => s.summary.asleepMin)),
    });
  }
  out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return out;
}

/** 曜日ごとの平均 */
export function byWeekday(sessions) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const s of sessions) if (s.summary) buckets[new Date(s.start).getDay()].push(s.summary);
  return buckets.map((b) => ({
    n: b.length,
    duration: mean(b.map((x) => x.asleepMin)),
    quality: mean(b.map((x) => x.quality)),
  }));
}

/* --------------------- サンプルデータ（お試し用） --------------------- */

export function makeSampleSession(daysAgo, notesPool) {
  const base = new Date();
  base.setDate(base.getDate() - daysAgo);
  base.setHours(23, 10 + Math.round((Math.random() - 0.5) * 70), 0, 0);
  const start = base.getTime();
  const inBedMin = 380 + Math.random() * 160;
  const end = start + inBedMin * 60000;
  const nEp = Math.round(inBedMin / EPOCH_MIN);
  const onsetEp = Math.round((6 + Math.random() * 24) / EPOCH_MIN);
  const restless = Math.random(); // その日の落ち着かなさ
  const snorer = Math.random() < 0.45;

  const epochs = [];
  let awakeRun = 0;
  for (let i = 0; i < nEp; i++) {
    const t = start + i * EPOCH_MS;
    let activity;
    if (i < onsetEp) {
      activity = 0.4 + Math.random() * 0.45; // 入眠前の寝返り
    } else {
      const m = (i - onsetEp) * EPOCH_MIN;
      const phase = (m % 92) / 92;
      const deepness = gauss(phase, 0.42, 0.2) * (0.35 + 0.65 * Math.exp(-m / 260));
      activity = 0.11 - deepness * 0.085 + Math.random() * 0.045 * (0.5 + restless);
      if (Math.random() < 0.045 + restless * 0.025) activity += 0.16 + Math.random() * 0.24; // 寝返り
      if (awakeRun > 0) {
        activity = 0.5 + Math.random() * 0.4; // 中途覚醒
        awakeRun--;
      } else if (Math.random() < 0.0012 + (m / 60) * 0.0008 * (0.5 + restless)) {
        awakeRun = 3 + Math.floor(Math.random() * 7);
      }
      if (i > nEp - 5) activity = 0.5 + Math.random() * 0.4; // 起床
    }
    const snoreSec = snorer && i > onsetEp && activity < 0.3 && Math.random() < 0.25 ? Math.random() * 20 : 0;
    epochs.push({
      t,
      activity: Math.round(clamp(activity, 0.01, 1) * 1000) / 1000,
      peakDb: Math.round(-62 + activity * 32),
      snoreSec: Math.round(snoreSec * 10) / 10,
    });
  }

  const notes = [];
  for (const tag of notesPool) if (Math.random() < 0.22) notes.push(tag);

  const s = {
    id: 'sample-' + daysAgo + '-' + start,
    sample: true,
    start,
    end,
    epochs,
    notes,
    goalMin: 480,
    alarmAt: end,
    mood: 1 + Math.floor(Math.random() * 5),
    sensor: 'both',
    clipCount: 0,
  };
  return finalize(s);
}
