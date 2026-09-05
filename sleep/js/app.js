// アプリ本体: 画面遷移、記録の開始/終了、スマートアラーム、統計表示

import {
  el, els, make, on, fmtClock, fmtDur, fmtDurShort, fmtDate, fmtDateShort,
  nextTimeAfter, clamp, pad2, toast, mean, minutesOfDay, MIN,
} from './utils.js';
import { Store, Settings } from './store.js';
import { Tracker, EPOCH_MS } from './tracker.js';
import { finalize, analyze, aggregate, noteStats, byWeekday, makeSampleSession, EPOCH_MIN } from './stats.js';
import { Alarm, AidPlayer, MELODIES, AID_SOUNDS, unlockAudio } from './audio.js';
import * as Chart from './chart.js';

const NOTE_TAGS = [
  'コーヒー', 'お酒', '運動した', 'ストレス', '夜食', '寝る前にスマホ',
  '昼寝した', '仕事が遅かった', '風邪気味', '外泊', '薬を飲んだ', 'カフェイン(夕方)',
];

const state = {
  settings: Settings.load(),
  view: 'home',
  notes: new Set(),
  tracker: null,
  session: null,
  alarm: null,
  alarmAt: 0,
  windowMin: 30,
  ringing: false,
  snoozeCount: 0,
  snoozeUntil: 0,
  wakeLock: null,
  liveValues: [],
  sessions: [],
  range: 7,
  aid: new AidPlayer(),
  dimTimer: null,
  hiddenWarned: false,
};

/* ============================ 初期化 ============================ */

function init() {
  buildSelects();
  bindHome();
  bindSettings();
  bindNight();
  bindTabs();
  applySettingsToUI();
  renderHome();
  refreshSessions();

  document.addEventListener('pointerdown', unlockAudio, { once: false, passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  el('#about-text').textContent =
    'Sleep Cycle のような睡眠追跡アプリを Web だけで再現したものです。' +
    'マイクの音量変化と加速度センサーの振動から寝返りの量を推定し、' +
    'Cole-Kripke 法の考え方（前後のエポックに重み付けした活動量）で睡眠と覚醒を判定、' +
    '約90分の睡眠周期と「深い睡眠は夜の前半に多い」性質を組み合わせて眠りの深さを推定しています。';
}

function buildSelects() {
  const m = el('#melody');
  for (const [k, v] of Object.entries(MELODIES)) m.appendChild(new Option(v.name, k));
  const a = el('#aid-sound');
  for (const [k, v] of Object.entries(AID_SOUNDS)) a.appendChild(new Option(v.name, k));
  const chips = el('#note-chips');
  for (const tag of NOTE_TAGS) {
    const b = make('button', 'chip', tag);
    b.dataset.v = tag;
    on(b, 'click', () => {
      if (state.notes.has(tag)) state.notes.delete(tag);
      else state.notes.add(tag);
      b.classList.toggle('on');
    });
    chips.appendChild(b);
  }
}

function applySettingsToUI() {
  const s = state.settings;
  el('#alarm-time').value = s.alarmTime;
  el('#alarm-enabled').checked = s.alarmEnabled;
  el('#melody').value = s.melody;
  el('#aid-sound').value = s.aidSound;
  el('#aid-fade').value = String(s.aidFadeMin);
  el('#sensor').value = s.sensor;
  el('#goal-min').value = String(s.goalMin);
  el('#set-gradual').checked = s.gradual;
  el('#set-vibrate').checked = s.vibrate;
  el('#set-snooze').checked = s.snoozeEnabled;
  el('#set-snooze-smart').checked = s.snoozeSmart;
  el('#set-record').checked = s.recordSounds;
  el('#set-dim').checked = s.dimScreen;
  els('#window-chips .chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.v) === s.windowMin));
  el('.alarm-card').classList.toggle('off', !s.alarmEnabled);
  updateAlarmHint();
}

function save(patch) {
  state.settings = Settings.patch(patch);
}

/* ============================ ホーム ============================ */

function bindHome() {
  on(el('#alarm-time'), 'change', (e) => {
    save({ alarmTime: e.target.value });
    updateAlarmHint();
  });
  on(el('#alarm-enabled'), 'change', (e) => {
    save({ alarmEnabled: e.target.checked });
    el('.alarm-card').classList.toggle('off', !e.target.checked);
    updateAlarmHint();
  });
  els('#window-chips .chip').forEach((c) =>
    on(c, 'click', () => {
      save({ windowMin: Number(c.dataset.v) });
      els('#window-chips .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      updateAlarmHint();
    })
  );
  on(el('#melody'), 'change', (e) => save({ melody: e.target.value }));
  on(el('#sensor'), 'change', (e) => save({ sensor: e.target.value }));
  on(el('#aid-sound'), 'change', (e) => save({ aidSound: e.target.value }));
  on(el('#aid-fade'), 'change', (e) => save({ aidFadeMin: Number(e.target.value) }));

  let preview = null;
  on(el('#btn-preview-melody'), 'click', () => {
    unlockAudio();
    if (preview) {
      preview.stop();
      preview = null;
      el('#btn-preview-melody').textContent = '試聴';
      return;
    }
    preview = new Alarm({ melody: state.settings.melody, gradual: false, vibrate: false });
    preview.start();
    el('#btn-preview-melody').textContent = '停止';
    setTimeout(() => {
      if (preview) {
        preview.stop();
        preview = null;
        el('#btn-preview-melody').textContent = '試聴';
      }
    }, 12000);
  });

  on(el('#btn-aid-toggle'), 'click', () => {
    unlockAudio();
    if (state.aid.isPlaying) {
      state.aid.stop();
      el('#btn-aid-toggle').textContent = '再生';
    } else {
      const t = el('#aid-sound').value;
      if (t === 'none') return toast('サウンドを選んでください');
      state.aid.play(t, { volume: state.settings.aidVolume, fadeMin: 0 });
      el('#btn-aid-toggle').textContent = '停止';
    }
  });

  on(el('#btn-start'), 'click', startTracking);
  on(el('#btn-help'), 'click', () => (el('#help').hidden = false));
  on(el('#btn-help-close'), 'click', () => (el('#help').hidden = true));
  el('#home-date').textContent = fmtDate(Date.now());
}

function updateAlarmHint() {
  const s = state.settings;
  const box = el('#alarm-hint');
  if (!s.alarmEnabled) {
    box.textContent = 'アラームなしで記録だけを行います。';
    return;
  }
  const at = nextTimeAfter(s.alarmTime);
  const from = at - s.windowMin * MIN;
  const inMin = Math.round((at - Date.now()) / MIN);
  const until = `${Math.floor(inMin / 60)}時間${inMin % 60}分後`;
  box.textContent = s.windowMin > 0
    ? `${fmtClock(from)} 〜 ${fmtClock(at)} の間の浅い眠りで起こします（${until}）`
    : `${fmtClock(at)} ちょうどに鳴ります（${until}）`;
}

async function renderHome() {
  const list = await Store.listSessions(1);
  const box = el('#home-last');
  box.innerHTML = '';
  if (!list.length) return;
  const s = list[0];
  const card = make('div', 'card');
  card.innerHTML = `<div class="row between"><span class="label">前回の睡眠</span><span class="hint">${fmtDate(s.start)}</span></div>`;
  const cv = make('canvas');
  card.appendChild(cv);
  const grid = make('div', 'stat-grid three');
  grid.style.marginTop = '10px';
  grid.innerHTML = `
    <div class="stat"><b>${s.summary.quality}%</b><span>睡眠の質</span></div>
    <div class="stat"><b>${fmtDurShort(s.summary.asleepMin)}</b><span>睡眠時間</span></div>
    <div class="stat"><b>${fmtDurShort(s.summary.deepMin)}</b><span>深い睡眠</span></div>`;
  card.appendChild(grid);
  on(card, 'click', () => openDetail(s.id));
  card.style.cursor = 'pointer';
  box.appendChild(card);
  requestAnimationFrame(() => Chart.drawHypnogram(cv, s, { height: 140 }));
}

/* ============================ 記録開始 ============================ */

async function startTracking() {
  unlockAudio();
  const s = state.settings;

  const tracker = new Tracker({
    sensor: s.sensor,
    recordSounds: s.recordSounds,
    onEpoch: onEpoch,
    onLevel: onLevel,
    onClip: async (clip) => {
      try {
        await Store.saveClip(clip);
        if (state.session) state.session.clipCount = (state.session.clipCount || 0) + 1;
      } catch (e) {
        console.warn(e);
      }
    },
  });

  let sensors;
  try {
    sensors = await tracker.start();
  } catch (e) {
    toast('センサーを開始できませんでした');
    return;
  }
  if (!sensors.mic && !sensors.motion) {
    toast('マイクも加速度センサーも使えません。ブラウザの権限を確認してください。');
    tracker.stop();
    return;
  }

  state.tracker = tracker;
  state.snoozeCount = 0;
  state.liveValues = [];
  state.hiddenWarned = false;
  state.windowMin = s.windowMin;
  state.alarmAt = s.alarmEnabled ? nextTimeAfter(s.alarmTime) : 0;
  state.session = {
    id: tracker.sessionId,
    start: tracker.startedAt,
    end: 0,
    epochs: tracker.epochs,
    notes: [...state.notes],
    goalMin: s.goalMin,
    alarmAt: state.alarmAt,
    windowMin: s.windowMin,
    sensor: `${sensors.mic ? 'mic' : ''}${sensors.motion ? '+motion' : ''}`,
    clipCount: 0,
  };

  el('#night-sensors').textContent =
    [sensors.mic ? 'マイク' : null, sensors.motion ? '加速度' : null].filter(Boolean).join(' + ');
  el('#night-alarm').textContent = s.alarmEnabled
    ? (s.windowMin > 0
        ? `⏰ ${fmtClock(state.alarmAt - s.windowMin * MIN)}〜${fmtClock(state.alarmAt)} に起こします`
        : `⏰ ${fmtClock(state.alarmAt)}`)
    : 'アラームなし';

  el('#night').hidden = false;
  el('#night').classList.remove('dim', 'dim2');
  scheduleDim();
  await requestWakeLock();

  if (s.aidSound !== 'none') {
    state.aid.play(s.aidSound, { volume: s.aidVolume, fadeMin: s.aidFadeMin });
  }

  state.clockTimer = setInterval(tickNight, 1000);
  tickNight();
  toast('記録を開始しました。画面はこのままにしてください');
}

function bindNight() {
  on(el('#btn-night-sound'), 'click', (e) => {
    e.stopPropagation();
    wakeScreen();
    if (state.aid.isPlaying) {
      state.aid.stop();
      toast('サウンドを停止しました');
    } else {
      const t = state.settings.aidSound === 'none' ? 'rain' : state.settings.aidSound;
      state.aid.play(t, { volume: state.settings.aidVolume, fadeMin: state.settings.aidFadeMin });
      toast(`${AID_SOUNDS[t].name} を再生中`);
    }
  });
  on(el('#btn-night-dim'), 'click', (e) => {
    e.stopPropagation();
    const n = el('#night');
    if (n.classList.contains('dim2')) n.classList.remove('dim', 'dim2');
    else if (n.classList.contains('dim')) n.classList.add('dim2');
    else n.classList.add('dim');
  });

  // 誤操作防止のため長押しで停止
  const stopBtn = el('#btn-night-stop');
  let holdTimer = null;
  const begin = (e) => {
    e.stopPropagation();
    stopBtn.textContent = '離さないで…';
    holdTimer = setTimeout(() => {
      stopBtn.textContent = '長押しで停止';
      finishSession(true);
    }, 1200);
  };
  const cancel = () => {
    clearTimeout(holdTimer);
    stopBtn.textContent = '長押しで停止';
  };
  on(stopBtn, 'pointerdown', begin);
  on(stopBtn, 'pointerup', cancel);
  on(stopBtn, 'pointerleave', cancel);
  on(stopBtn, 'pointercancel', cancel);

  on(el('#night'), 'click', wakeScreen);

  on(el('#btn-ring-stop'), 'click', () => {
    stopAlarmSound();
    finishSession(false);
  });
  on(el('#btn-ring-snooze'), 'click', snooze);
  on(el('#btn-morning-done'), 'click', () => {
    el('#morning').hidden = true;
    refreshSessions();
    renderHome();
  });
}

function scheduleDim() {
  clearTimeout(state.dimTimer);
  if (!state.settings.dimScreen) return;
  state.dimTimer = setTimeout(() => {
    el('#night').classList.add('dim');
    state.dimTimer = setTimeout(() => el('#night').classList.add('dim2'), 25000);
  }, 25000);
}

function wakeScreen() {
  el('#night').classList.remove('dim', 'dim2');
  scheduleDim();
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
    }
  } catch {
    /* 非対応 */
  }
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    if (state.tracker?.running && !state.wakeLock) requestWakeLock();
  } else if (state.tracker?.running && !state.hiddenWarned) {
    state.hiddenWarned = true;
  }
}

/* ---------------------- 記録中の更新とアラーム ---------------------- */

function onEpoch() {
  if (state.settings.showLiveGraph) {
    state.liveValues.push(state.tracker.liveActivity);
    if (state.liveValues.length > 120) state.liveValues.shift(); // 直近 60 分ぶん
    Chart.drawLive(el('#night-canvas'), state.liveValues, { height: 70 });
  }
}

function onLevel(l) {
  state._level = l;
}

function tickNight() {
  const now = Date.now();
  el('#night-clock').textContent = fmtClock(now);
  if (!state.tracker) return;
  const elapsed = (now - state.tracker.startedAt) / MIN;
  el('#night-elapsed').textContent = fmtDur(elapsed);

  const depth = state.tracker.liveDepth;
  const label = elapsed < 3 ? '計測開始' : depth > 0.66 ? '深い睡眠' : depth > 0.2 ? '浅い睡眠' : '覚醒';
  el('#night-depth').textContent = label;

  const snoreMin = state.tracker.epochs.reduce((a, e) => a + (e.snoreSec || 0), 0) / 60;
  el('#night-snore').textContent = fmtDur(snoreMin);
  el('#night-status').textContent = state._level?.snoring ? '記録中 · いびき検出' : '記録中';

  if (state.snoozeUntil && now >= state.snoozeUntil) {
    state.snoozeUntil = 0;
    ring();
    return;
  }
  if (!state.ringing && !state.snoozeUntil && shouldWakeNow(now)) ring();
}

/**
 * スマートアラームの判定。
 * 設定時刻までの猶予の中で、眠りが浅くなったタイミングを狙う。
 * 時刻が近づくほど判定のしきい値を緩め、最終的には設定時刻ちょうどに必ず鳴らす。
 */
function shouldWakeNow(now) {
  const at = state.alarmAt;
  if (!at) return false;
  if (now >= at) return true;
  const win = state.windowMin * MIN;
  if (win <= 0) return false;
  const from = at - win;
  if (now < from) return false;

  const eps = state.tracker.epochs;
  const asleepMin = eps.filter((e) => e.activity < 0.3).length * EPOCH_MIN;
  if (asleepMin < 20) return false; // ほとんど眠れていないうちは起こさない

  const p = (now - from) / win; // 0 → 1
  const threshold = 0.3 + 0.42 * p;
  const depth = state.tracker.liveDepth;
  const recent = mean(eps.slice(-3).map((e) => e.activity));
  return depth <= threshold && (recent > 0.12 || depth < 0.1);
}

function ring() {
  state.ringing = true;
  el('#ring-clock').textContent = fmtClock(Date.now());
  const early = state.alarmAt - Date.now();
  state.alarmAt = 0; // 消費済みにして、鳴り止んだあとの再発火を防ぐ（次はスヌーズ経由）
  el('#ring-msg').textContent =
    early > 60000 ? `おはようございます（${Math.round(early / MIN)}分早い、浅い眠りで起こしました）` : 'おはようございます';
  el('#btn-ring-snooze').hidden = !state.settings.snoozeEnabled;
  el('#ringing').hidden = false;
  state.alarm = new Alarm({
    melody: state.settings.melody,
    gradual: state.settings.gradual,
    vibrate: state.settings.vibrate,
  });
  state.aid.stop();
  state.alarm.start();
  // 鳴らしっぱなし防止（15分で自動停止）
  state.ringTimeout = setTimeout(() => stopAlarmSound(), 15 * MIN);
}

function stopAlarmSound() {
  clearTimeout(state.ringTimeout);
  state.ringing = false;
  state.alarm?.stop();
  state.alarm = null;
  el('#ringing').hidden = true;
}

function snooze() {
  stopAlarmSound();
  state.snoozeCount++;
  let min = state.settings.snoozeMin;
  if (state.settings.snoozeSmart) min = Math.max(1, Math.round(min / Math.pow(2, state.snoozeCount - 1)));
  state.snoozeUntil = Date.now() + min * MIN;
  toast(`${min}分後にもう一度鳴ります`);
  wakeScreen();
}

/* ---------------------- 記録の終了と保存 ---------------------- */

async function finishSession(manual) {
  const tracker = state.tracker;
  if (!tracker) return;
  clearInterval(state.clockTimer);
  clearTimeout(state.dimTimer);
  stopAlarmSound();
  state.aid.stop();
  state.snoozeUntil = 0;
  tracker.stop();
  state.tracker = null;
  try {
    await state.wakeLock?.release();
  } catch {}
  state.wakeLock = null;

  el('#night').hidden = true;
  el('#night').classList.remove('dim', 'dim2');

  const session = state.session;
  session.end = Date.now();
  session.epochs = tracker.epochs;
  session.manualStop = !!manual;
  state.session = null;

  const minutes = (session.end - session.start) / MIN;
  if (minutes < 5) {
    toast('5分未満だったので保存しませんでした');
    await Store.deleteClipsFor(session.id);
    return;
  }

  finalize(session);
  await Store.saveSession(session);
  showMorning(session);
}

async function showMorning(session) {
  const body = el('#morning-body');
  body.innerHTML = '';
  await renderSession(session, body, { compact: false });

  els('#mood-picker button').forEach((b) => {
    b.classList.toggle('on', session.mood === Number(b.dataset.v));
    b.onclick = async () => {
      session.mood = Number(b.dataset.v);
      els('#mood-picker button').forEach((x) => x.classList.toggle('on', x === b));
      await Store.saveSession(session);
    };
  });
  el('#morning').hidden = false;
  el('#morning').scrollTop = 0;
}

/* ============================ セッション表示 ============================ */

async function renderSession(session, container, opts = {}) {
  const s = session.summary || analyze(session).summary;
  const wrap = make('div');

  const top = make('div', 'card');
  const ring = make('canvas');
  top.appendChild(ring);
  const times = make('div', 'row between');
  times.style.marginTop = '6px';
  times.innerHTML = `<span class="hint">🛏 ${fmtClock(session.start)} 就寝</span><span class="hint">☀️ ${fmtClock(session.end)} 起床</span>`;
  top.appendChild(times);
  wrap.appendChild(top);

  const graph = make('div', 'card');
  graph.innerHTML = '<span class="label">睡眠グラフ</span>';
  const cv = make('canvas');
  graph.appendChild(cv);
  const legend = make('div', 'legend');
  legend.innerHTML = `
    <span><i style="background:#ff8bb0"></i>覚醒 ${fmtDurShort(s.awakeMin)}</span>
    <span><i style="background:#4aa8ff"></i>浅い睡眠 ${fmtDurShort(s.lightMin)}</span>
    <span><i style="background:#6d5cff"></i>深い睡眠 ${fmtDurShort(s.deepMin)}</span>
    <span><i style="background:#ffb547"></i>いびき ${fmtDurShort(s.snoreMin)}</span>`;
  graph.appendChild(legend);
  wrap.appendChild(graph);

  const grid = make('div', 'stat-grid three');
  grid.innerHTML = `
    <div class="stat"><b>${fmtDurShort(s.asleepMin)}</b><span>睡眠時間</span></div>
    <div class="stat"><b>${fmtDurShort(s.inBedMin)}</b><span>ベッドの中</span></div>
    <div class="stat"><b>${Math.round(s.efficiency * 100)}%</b><span>睡眠効率</span></div>
    <div class="stat"><b>${Math.round(s.onsetMin)}分</b><span>寝つき</span></div>
    <div class="stat"><b>${s.awakenings}回</b><span>目が覚めた</span></div>
    <div class="stat"><b>${Math.round(s.deepRatio * 100 || 0)}%</b><span>深い睡眠の割合</span></div>`;
  grid.style.marginBottom = '14px';
  wrap.appendChild(grid);

  if (session.notes?.length) {
    const n = make('div', 'card');
    n.innerHTML = '<span class="label">睡眠メモ</span><div>' +
      session.notes.map((t) => `<span class="note-tag">${escapeHtml(t)}</span>`).join('') + '</div>';
    wrap.appendChild(n);
  }

  container.appendChild(wrap);
  requestAnimationFrame(() => {
    Chart.drawRing(ring, s.quality);
    Chart.drawHypnogram(cv, session, { height: opts.compact ? 150 : 210 });
  });

  // 録音クリップ
  const clips = await Store.listClips(session.id);
  if (clips.length) {
    const c = make('div', 'card');
    c.innerHTML = `<span class="label">録音（いびき・物音）</span><p class="hint">${clips.length}件</p>`;
    for (const clip of clips) {
      const row = make('div', 'clip');
      row.innerHTML = `<span class="t">${fmtClock(clip.t)}</span><span class="kind">${clip.kind === 'snore' ? 'いびき' : '物音'} · ${clip.dur}秒</span>`;
      const audio = make('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = URL.createObjectURL(clip.blob);
      row.appendChild(audio);
      c.appendChild(row);
    }
    container.appendChild(c);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ============================ 履歴・統計 ============================ */

async function refreshSessions() {
  state.sessions = await Store.listSessions(400);
  renderHistory();
  renderStats();
}

function renderHistory() {
  const box = el('#history-list');
  box.innerHTML = '';
  if (!state.sessions.length) {
    box.innerHTML = '<p class="empty">まだ記録がありません。<br>ホームから「眠りを記録する」を押してみてください。</p>';
    return;
  }
  for (const s of state.sessions) {
    const row = make('button', 'session-row');
    const q = s.summary?.quality ?? 0;
    row.innerHTML = `
      <span class="q" style="--p:${q}%"><i>${q}</i></span>
      <span class="meta">
        <b>${fmtDate(s.start)}${s.sample ? ' <span class="hint">(サンプル)</span>' : ''}</b>
        <span>${fmtClock(s.start)} → ${fmtClock(s.end)} · 深い ${fmtDurShort(s.summary?.deepMin || 0)}${
          s.summary?.snoreMin > 1 ? ' · いびき ' + fmtDurShort(s.summary.snoreMin) : ''
        }${s.mood ? ' · ' + ['😫', '😕', '😐', '🙂', '😄'][s.mood - 1] : ''}</span>
      </span>
      <span class="dur">${fmtDurShort(s.summary?.asleepMin || 0)}</span>`;
    on(row, 'click', () => openDetail(s.id));
    box.appendChild(row);
  }
}

function renderStats() {
  const box = el('#stats-body');
  box.innerHTML = '';
  els('.range-tab').forEach((t) => t.classList.toggle('on', Number(t.dataset.v) === state.range));

  const since = Date.now() - state.range * 24 * 3600_000;
  const list = state.sessions.filter((s) => s.start >= since && s.summary);
  if (!list.length) {
    box.innerHTML = '<p class="empty">この期間の記録がありません。<br>設定からサンプルデータを追加すると表示を試せます。</p>';
    return;
  }
  const agg = aggregate(list);

  const grid = make('div', 'stat-grid');
  grid.style.marginBottom = '14px';
  grid.innerHTML = `
    <div class="stat"><b>${fmtDurShort(agg.avgDuration)}</b><span>平均睡眠時間</span></div>
    <div class="stat"><b>${Math.round(agg.avgQuality)}%</b><span>平均の質</span></div>
    <div class="stat"><b>${minToClock(agg.avgBedtime)}</b><span>平均就寝</span></div>
    <div class="stat"><b>${minToClock(agg.avgWake)}</b><span>平均起床</span></div>
    <div class="stat"><b>${fmtDurShort(agg.avgDeep)}</b><span>平均の深い睡眠</span></div>
    <div class="stat"><b>${agg.avgAwakenings.toFixed(1)}回</b><span>平均の中途覚醒</span></div>
    <div class="stat"><b>${Math.round(agg.avgEfficiency * 100)}%</b><span>平均の睡眠効率</span></div>
    <div class="stat"><b>${agg.moodCount ? ['😫', '😕', '😐', '🙂', '😄'][Math.round(agg.avgMood) - 1] : '—'}</b><span>平均の目覚め</span></div>`;
  box.appendChild(grid);

  const debt = make('div', 'card');
  const d = agg.sleepDebt;
  debt.innerHTML = `<div class="row between"><span class="label">睡眠負債（直近7日）</span>
    <b style="font-size:18px;color:${d > 0 ? '#ff8bb0' : '#7ee787'}">${d > 0 ? '-' : '+'}${fmtDurShort(Math.abs(d))}</b></div>
    <p class="hint">目標 ${fmtDur(state.settings.goalMin)} との差の合計です。</p>`;
  box.appendChild(debt);

  const c1 = make('div', 'card');
  c1.innerHTML = '<span class="label">睡眠時間の推移</span>';
  const cv1 = make('canvas');
  c1.appendChild(cv1);
  box.appendChild(c1);

  const c2 = make('div', 'card');
  c2.innerHTML = '<span class="label">睡眠の質</span>';
  const cv2 = make('canvas');
  c2.appendChild(cv2);
  box.appendChild(c2);

  const c3 = make('div', 'card');
  c3.innerHTML = `<span class="label">生活リズム</span><p class="hint">就寝のばらつき ±${Math.round(agg.bedtimeSpread)}分 / 起床のばらつき ±${Math.round(agg.wakeSpread)}分</p>`;
  const cv3 = make('canvas');
  c3.appendChild(cv3);
  box.appendChild(c3);

  const wd = byWeekday(list);
  const c4 = make('div', 'card');
  c4.innerHTML = '<span class="label">曜日ごとの睡眠時間</span>';
  const cv4 = make('canvas');
  c4.appendChild(cv4);
  box.appendChild(c4);

  const notes = noteStats(list);
  if (notes.length) {
    const c5 = make('div', 'card');
    c5.innerHTML = '<span class="label">睡眠メモとの関係</span><p class="hint">そのメモがある日と、ない日の睡眠の質の差</p>';
    for (const n of notes.slice(0, 8)) {
      const row = make('div', 'row between');
      row.style.padding = '6px 0';
      const sign = n.delta >= 0 ? '+' : '';
      row.innerHTML = `<span style="font-size:13px">${escapeHtml(n.tag)} <span class="hint">${n.nights}日</span></span>
        <b style="font-size:14px;color:${n.delta >= 0 ? '#7ee787' : '#ff8bb0'}">${sign}${n.delta.toFixed(1)}%</b>`;
      c5.appendChild(row);
    }
    box.appendChild(c5);
  }

  const ordered = [...list].sort((a, b) => a.start - b.start);
  requestAnimationFrame(() => {
    Chart.drawBars(
      cv1,
      ordered.map((s) => ({ label: fmtDateShort(s.start), value: s.summary.asleepMin, quality: s.summary.quality })),
      { goal: state.settings.goalMin, fmtY: (v) => Math.round(v / 60) + 'h', labels: ordered.length <= 14 }
    );
    Chart.drawBars(
      cv2,
      ordered.map((s) => ({ label: fmtDateShort(s.start), value: s.summary.quality, quality: s.summary.quality })),
      { max: 100, fmtY: (v) => Math.round(v) + '%', labels: ordered.length <= 14 }
    );
    Chart.drawRegularity(cv3, list);
    Chart.drawBars(
      cv4,
      ['日', '月', '火', '水', '木', '金', '土'].map((lb, i) => ({ label: lb, value: wd[i].duration || 0, quality: wd[i].quality })),
      { fmtY: (v) => Math.round(v / 60) + 'h' }
    );
  });
}

function minToClock(min) {
  const m = Math.round(min);
  return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
}

async function openDetail(id) {
  const s = await Store.getSession(id);
  if (!s) return;
  el('#detail-title').textContent = fmtDate(s.start);
  const body = el('#detail-body');
  body.innerHTML = '';
  await renderSession(s, body, { compact: false });
  el('#btn-detail-delete').onclick = async () => {
    if (!confirm('この記録を削除しますか？')) return;
    await Store.deleteSession(id);
    await refreshSessions();
    renderHome();
    showView(state.prevView || 'history');
  };
  showView('detail');
}

/* ============================ ナビ・設定 ============================ */

function bindTabs() {
  els('#tabbar .tab').forEach((t) => on(t, 'click', () => showView(t.dataset.view)));
  els('.range-tab').forEach((t) =>
    on(t, 'click', () => {
      state.range = Number(t.dataset.v);
      renderStats();
    })
  );
  on(el('#btn-detail-back'), 'click', () => showView(state.prevView || 'history'));
}

function showView(name) {
  if (name !== 'detail') state.prevView = name;
  state.view = name;
  ['home', 'stats', 'history', 'settings', 'detail'].forEach((v) => {
    const node = el('#view-' + v);
    if (node) node.hidden = v !== name;
  });
  els('#tabbar .tab').forEach((t) => t.classList.toggle('on', t.dataset.view === name));
  el('#tabbar').hidden = false;
  window.scrollTo(0, 0);
  if (name === 'home') {
    updateAlarmHint();
    renderHome();
  }
  if (name === 'stats') renderStats();
  if (name === 'history') renderHistory();
}

function bindSettings() {
  const map = {
    '#goal-min': (v) => ({ goalMin: Number(v) }),
    '#set-gradual': (v) => ({ gradual: v }),
    '#set-vibrate': (v) => ({ vibrate: v }),
    '#set-snooze': (v) => ({ snoozeEnabled: v }),
    '#set-snooze-smart': (v) => ({ snoozeSmart: v }),
    '#set-record': (v) => ({ recordSounds: v }),
    '#set-dim': (v) => ({ dimScreen: v }),
  };
  for (const [sel, fn] of Object.entries(map)) {
    const node = el(sel);
    on(node, 'change', () => save(fn(node.type === 'checkbox' ? node.checked : node.value)));
  }

  on(el('#btn-export'), 'click', async () => {
    const json = await Store.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const a = make('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sleep-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  on(el('#btn-import'), 'click', () => el('#import-file').click());
  on(el('#import-file'), 'change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const n = await Store.importJSON(await f.text());
      toast(`${n}件を読み込みました`);
      applySettingsToUI();
      await refreshSessions();
    } catch (err) {
      toast('読み込めませんでした: ' + err.message);
    }
    e.target.value = '';
  });

  on(el('#btn-sample'), 'click', async () => {
    for (let i = 1; i <= 21; i++) await Store.saveSession(makeSampleSession(i, NOTE_TAGS));
    toast('21日分のサンプルを追加しました');
    await refreshSessions();
    renderHome();
    showView('stats');
  });

  on(el('#btn-clear'), 'click', async () => {
    if (!confirm('保存されている睡眠データと録音をすべて削除します。よろしいですか？')) return;
    await Store.clearAll();
    await refreshSessions();
    renderHome();
    toast('削除しました');
  });
}

/* 記録中に閉じられそうになったら警告 */
window.addEventListener('beforeunload', (e) => {
  if (state.tracker?.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('resize', () => {
  if (state.view === 'stats') renderStats();
});

init();
showView('home');
