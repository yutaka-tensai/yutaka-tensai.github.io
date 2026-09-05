// 睡眠センシング: マイク音量解析 + 加速度センサーで 30 秒エポックごとの活動量を算出する。
// 生データ（活動量・音圧・いびき秒数）だけをここで作り、睡眠段階の判定は stats.js が行う。

import { clamp, gauss, uid } from './utils.js';

export const EPOCH_MS = 30_000;
const TICK_MS = 100;

/** いびき判定のパラメータ */
const SNORE = {
  minDur: 0.4, // 秒
  maxDur: 3.6,
  lowRatio: 0.55, // 低域(60-500Hz)が占める割合
  minGapSec: 1.2, // 呼吸周期として妥当な間隔
  maxGapSec: 9.0,
};

export class Tracker {
  /**
   * @param {object} opts
   * @param {'mic'|'motion'|'both'} opts.sensor
   * @param {boolean} opts.recordSounds いびき・物音の録音
   * @param {(epoch:object, tracker:Tracker)=>void} opts.onEpoch
   * @param {(level:object)=>void} opts.onLevel 100ms ごとのライブ値
   * @param {(clip:object)=>void} opts.onClip
   */
  constructor(opts = {}) {
    this.opts = { sensor: 'both', recordSounds: true, ...opts };
    this.sessionId = uid();
    this.epochs = [];
    this.running = false;
    this.startedAt = 0;
    this.liveDepth = 0;
    this.liveActivity = 0;
    this.hasMic = false;
    this.hasMotion = false;

    // 音声解析の状態
    this._floorDb = null;
    this._hist = new Float32Array(600); // 直近 60 秒の音圧（ノイズフロア推定用）
    this._histN = 0;
    this._histI = 0;
    this._event = null;
    this._lastSnoreAt = 0;
    this._snoreRun = 0;

    // エポック集計バッファ
    this._buf = this._newBuf();
    this._epochIndex = 0;
    this._activityEma = 0.5;
    this._onsetIdx = -1;

    // 録音
    this._recorder = null;
    this._recording = false;
    this._lastClipAt = 0;
    this._clipCount = 0;
  }

  _newBuf() {
    return {
      samples: 0,
      loudSamples: 0,
      excessSum: 0,
      peakDb: -120,
      snoreSec: 0,
      motionSum: 0,
      motionCount: 0,
      motionPeak: 0,
    };
  }

  async start() {
    if (this.running) return;
    this.startedAt = Date.now();
    this.running = true;

    const wantMic = this.opts.sensor === 'mic' || this.opts.sensor === 'both';
    const wantMotion = this.opts.sensor === 'motion' || this.opts.sensor === 'both';

    // iOS はユーザー操作の直後でないと許可を求められないため、モーションを先に要求する
    if (wantMotion) {
      try {
        await this._startMotion();
        this.hasMotion = true;
      } catch (e) {
        console.warn('モーションセンサーを開始できません', e);
      }
    }
    if (wantMic) {
      try {
        await this._startMic();
        this.hasMic = true;
      } catch (e) {
        console.warn('マイクを開始できません', e);
      }
    }

    this._timer = setInterval(() => this._tick(), TICK_MS);
    return { mic: this.hasMic, motion: this.hasMotion };
  }

  async _startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new Ctx();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    src.connect(this.analyser);
    this._time = new Float32Array(this.analyser.fftSize);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
    this._binHz = this.audioCtx.sampleRate / this.analyser.fftSize;

    // タブが裏に回ったときのタイマー間引きを緩和するための無音再生
    this._keepAlive();

    if (this.opts.recordSounds && window.MediaRecorder) {
      this._mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
        (m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)
      );
    }
  }

  _keepAlive() {
    try {
      const ctx = this.audioCtx;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 1e-4;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0.0005;
      s.connect(g).connect(ctx.destination);
      s.start();
      this._keepAliveNode = s;
    } catch {
      /* 無視 */
    }
  }

  async _startMotion() {
    if (typeof DeviceMotionEvent === 'undefined') throw new Error('非対応');
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') throw new Error('拒否されました');
    }
    this._prevMag = null;
    this._motionHandler = (e) => {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a || a.x == null) return;
      const mag = Math.hypot(a.x, a.y, a.z);
      if (this._prevMag != null) {
        const d = Math.abs(mag - this._prevMag);
        this._buf.motionSum += d;
        this._buf.motionCount++;
        if (d > this._buf.motionPeak) this._buf.motionPeak = d;
      }
      this._prevMag = mag;
    };
    window.addEventListener('devicemotion', this._motionHandler);
  }

  _tick() {
    if (!this.running) return;
    const now = Date.now();

    if (this.analyser) this._analyzeAudio(now);

    // 30 秒境界でエポックを確定
    const idx = Math.floor((now - this.startedAt) / EPOCH_MS);
    while (idx > this._epochIndex) {
      this._commitEpoch(this.startedAt + this._epochIndex * EPOCH_MS);
      this._epochIndex++;
    }

    if (this.opts.onLevel) {
      this.opts.onLevel({
        db: this._lastDb ?? -100,
        floor: this._floorDb ?? -100,
        activity: this.liveActivity,
        depth: this.liveDepth,
        snoring: now - this._lastSnoreAt < 8000,
      });
    }
  }

  _analyzeAudio(now) {
    const a = this.analyser;
    a.getFloatTimeDomainData(this._time);
    let sum = 0;
    for (let i = 0; i < this._time.length; i++) sum += this._time[i] * this._time[i];
    const rms = Math.sqrt(sum / this._time.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this._lastDb = db;

    const floor = this._updateFloor(db);

    const b = this._buf;
    b.samples++;
    if (db > b.peakDb) b.peakDb = db;
    const excess = db - floor;
    if (excess > 6) {
      b.loudSamples++;
      b.excessSum += Math.min(excess, 40);
    }

    // 低域比率（いびきは 60-500Hz が支配的）
    a.getByteFrequencyData(this._freq);
    let low = 0, total = 0;
    for (let i = 1; i < this._freq.length; i++) {
      const hz = i * this._binHz;
      if (hz > 6000) break;
      const v = this._freq[i];
      total += v;
      if (hz >= 60 && hz <= 500) low += v;
    }
    const lowRatio = total > 0 ? low / total : 0;

    // 音イベントのヒステリシス検出
    if (!this._event && excess > 8) {
      this._event = { start: now, peak: db, lowSum: lowRatio, n: 1 };
    } else if (this._event) {
      const ev = this._event;
      ev.n++;
      ev.lowSum += lowRatio;
      if (db > ev.peak) ev.peak = db;
      if (excess < 4) {
        ev.end = now;
        this._finishEvent(ev, floor);
        this._event = null;
      } else if (now - ev.start > 12000) {
        ev.end = now;
        this._finishEvent(ev, floor);
        this._event = null;
      }
    }
  }

  /**
   * ノイズフロア = 直近 60 秒の音圧の 20 パーセンタイル。
   * エアコンなどの定常音は「静けさ」として扱い、そこからの超過だけを物音として拾う。
   */
  _updateFloor(db) {
    this._hist[this._histI] = db;
    this._histI = (this._histI + 1) % this._hist.length;
    if (this._histN < this._hist.length) this._histN++;
    if (this._floorDb == null || this._histI % 10 === 0) {
      const a = Array.from(this._hist.subarray(0, this._histN)).sort((x, y) => x - y);
      this._floorDb = a[Math.floor(a.length * 0.2)];
    }
    return this._floorDb;
  }

  _finishEvent(ev, floor) {
    const dur = (ev.end - ev.start) / 1000;
    const lowRatio = ev.lowSum / ev.n;
    const loudness = ev.peak - floor;
    let kind = 'sound';

    const shaped = dur >= SNORE.minDur && dur <= SNORE.maxDur && lowRatio >= SNORE.lowRatio && loudness >= 10;
    if (shaped) {
      const gap = (ev.start - this._lastSnoreCandidate) / 1000;
      if (this._lastSnoreCandidate && gap >= SNORE.minGapSec && gap <= SNORE.maxGapSec) {
        this._snoreRun++;
      } else {
        this._snoreRun = 1;
      }
      this._lastSnoreCandidate = ev.start;
      // 呼吸周期で 3 回以上続いたらいびきと判定
      if (this._snoreRun >= 3) {
        this._buf.snoreSec += dur;
        this._lastSnoreAt = ev.end;
        kind = 'snore';
      }
    }

    const worthRecording = kind === 'snore' ? loudness >= 12 : loudness >= 18 && dur >= 0.3;
    if (this.opts.recordSounds && worthRecording) this._maybeRecord(kind, ev.peak, dur);
  }

  /** 大きな音を検出したら 6 秒だけ録音する（クールダウンと上限つき） */
  _maybeRecord(kind, peakDb, dur) {
    const now = Date.now();
    if (!this._mime || this._recording || !this.stream) return;
    if (this._clipCount >= 14) return;
    if (now - this._lastClipAt < 3 * 60_000) return;
    this._lastClipAt = now;
    this._recording = true;
    try {
      const rec = new MediaRecorder(this.stream, { mimeType: this._mime, audioBitsPerSecond: 32_000 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        this._recording = false;
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: this._mime });
        this._clipCount++;
        this.opts.onClip?.({
          id: uid(),
          sessionId: this.sessionId,
          t: now,
          kind,
          peakDb: Math.round(peakDb),
          dur: Math.round(dur * 10) / 10,
          blob,
        });
      };
      rec.start();
      this._recorder = rec;
      setTimeout(() => {
        try {
          if (rec.state !== 'inactive') rec.stop();
        } catch {
          this._recording = false;
        }
      }, 6000);
    } catch (e) {
      this._recording = false;
    }
  }

  _commitEpoch(t) {
    const b = this._buf;
    this._buf = this._newBuf();

    // 音由来の活動量: 「うるさかった時間の割合」と「超過音圧」の合成
    let audioScore = 0;
    if (b.samples > 0 && this.hasMic) {
      const ratio = b.loudSamples / b.samples;
      const inten = b.excessSum / b.samples / 18;
      audioScore = clamp(ratio * 1.8 + inten, 0, 1);
    }
    // 加速度由来の活動量
    let motionScore = 0;
    if (b.motionCount > 0 && this.hasMotion) {
      const avg = b.motionSum / b.motionCount;
      motionScore = clamp(avg / 0.22 + b.motionPeak / 6, 0, 1);
    }

    let activity;
    if (this.hasMic && this.hasMotion) activity = clamp(Math.max(motionScore, audioScore * 0.85) + Math.min(motionScore, audioScore) * 0.3, 0, 1);
    else activity = this.hasMotion ? motionScore : audioScore;

    const epoch = {
      t,
      activity: Math.round(activity * 1000) / 1000,
      peakDb: Math.round(b.peakDb),
      snoreSec: Math.round(b.snoreSec * 10) / 10,
    };
    this.epochs.push(epoch);

    // ライブ推定（因果的な近似。最終判定は stats.js が前後を見て行う）
    this._activityEma = this._activityEma * 0.6 + activity * 0.4;
    this.liveActivity = activity;
    if (this._onsetIdx < 0 && this.epochs.length >= 4) {
      const last4 = this.epochs.slice(-4);
      if (last4.every((e) => e.activity < 0.28)) this._onsetIdx = this.epochs.length - 4;
    }
    const minutes = this._onsetIdx >= 0 ? ((this.epochs.length - this._onsetIdx) * EPOCH_MS) / 60000 : 0;
    this.liveDepth = this._onsetIdx < 0 ? 0 : liveDepthEstimate(this._activityEma, minutes);

    this.opts.onEpoch?.(epoch, this);
  }

  stop() {
    if (!this.running) return this.epochs;
    this.running = false;
    clearInterval(this._timer);
    // 途中のエポックも端数として確定させる
    if (this._buf.samples > 0 || this._buf.motionCount > 0) {
      this._commitEpoch(this.startedAt + this._epochIndex * EPOCH_MS);
    }
    try {
      if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop();
    } catch {}
    if (this._motionHandler) window.removeEventListener('devicemotion', this._motionHandler);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    try {
      this._keepAliveNode?.stop();
      this.audioCtx?.close();
    } catch {}
    return this.epochs;
  }
}

/** 因果的な深さ推定（0=覚醒 〜 1=深い睡眠） */
export function liveDepthEstimate(activityEma, minutesSinceOnset) {
  const rest = clamp(1 - activityEma * 1.7, 0, 1);
  const pressure = 0.35 + 0.65 * Math.exp(-minutesSinceOnset / 260);
  const phase = (minutesSinceOnset % 92) / 92;
  const win = 0.5 + 0.5 * gauss(phase, 0.42, 0.22);
  const ramp = clamp(minutesSinceOnset / 18, 0, 1);
  return clamp(rest * (0.5 + 0.5 * pressure * win) * ramp, 0, 1);
}
