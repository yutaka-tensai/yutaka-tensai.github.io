// Web Audio によるアラーム音と入眠サウンドの合成（音声ファイル不要）

let ctx = null;

export function getCtx() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** ユーザー操作のたびに呼んで、再生が許可された状態を維持する */
export function unlockAudio() {
  try {
    const c = getCtx();
    if (c.state === 'suspended') c.resume();
  } catch {}
}

function noiseBuffer(c, seconds, type = 'white') {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/* ------------------------------ アラーム ------------------------------ */

export const MELODIES = {
  sunrise: { name: 'サンライズ', notes: [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25], step: 0.6, type: 'sine', decay: 1.8 },
  chimes: { name: 'チャイム', notes: [1046.5, 1318.5, 1567.98, 2093.0], step: 0.9, type: 'sine', decay: 3.2, fm: true },
  dew: { name: 'モーニングデュー', notes: [587.33, 880.0, 1174.66, 880.0, 698.46, 1046.5], step: 0.45, type: 'triangle', decay: 1.2 },
  piano: { name: 'ピアノ', notes: [440.0, 523.25, 659.25, 880.0, 659.25, 523.25], step: 0.5, type: 'triangle', decay: 2.4, harm: true },
  classic: { name: 'クラシックベル', notes: [880, 880, 0, 880, 880, 0], step: 0.28, type: 'square', decay: 0.22 },
};

export class Alarm {
  constructor({ melody = 'sunrise', gradual = true, vibrate = true } = {}) {
    this.melodyKey = MELODIES[melody] ? melody : 'sunrise';
    this.gradual = gradual;
    this.vibrate = vibrate;
    this.playing = false;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    const c = getCtx();
    this.master = c.createGain();
    const target = 0.85;
    this.master.gain.setValueAtTime(this.gradual ? 0.04 : target, c.currentTime);
    if (this.gradual) this.master.gain.linearRampToValueAtTime(target, c.currentTime + 45);

    this.reverb = c.createDelay(0.6);
    this.reverb.delayTime.value = 0.28;
    const fb = c.createGain();
    fb.gain.value = 0.28;
    const wet = c.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(fb).connect(this.reverb);
    this.reverb.connect(wet).connect(this.master);
    this.master.connect(c.destination);

    this._i = 0;
    this._next = c.currentTime + 0.05;
    this._loop = setInterval(() => this._schedule(), 120);
    this._schedule();

    if (this.vibrate && navigator.vibrate) {
      const buzz = () => navigator.vibrate([600, 400, 600, 1200]);
      buzz();
      this._vib = setInterval(buzz, 2800);
    }
  }

  _schedule() {
    const c = getCtx();
    const m = MELODIES[this.melodyKey];
    while (this._next < c.currentTime + 0.5) {
      const f = m.notes[this._i % m.notes.length];
      if (f > 0) this._note(c, f, this._next, m);
      this._i++;
      this._next += m.step;
      // 1 フレーズごとに少し休符を入れる
      if (this._i % m.notes.length === 0) this._next += m.step * 1.5;
    }
  }

  _note(c, freq, at, m) {
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.35, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + m.decay);
    const o = c.createOscillator();
    o.type = m.type;
    o.frequency.value = freq;
    o.connect(g);
    if (m.harm) {
      const o2 = c.createOscillator();
      const g2 = c.createGain();
      g2.gain.value = 0.18;
      o2.type = 'sine';
      o2.frequency.value = freq * 2;
      o2.connect(g2).connect(g);
      o2.start(at);
      o2.stop(at + m.decay + 0.1);
    }
    if (m.fm) {
      const mod = c.createOscillator();
      const modGain = c.createGain();
      mod.frequency.value = freq * 1.41;
      modGain.gain.value = freq * 0.6;
      mod.connect(modGain).connect(o.frequency);
      mod.start(at);
      mod.stop(at + m.decay + 0.1);
    }
    g.connect(this.master);
    g.connect(this.reverb);
    o.start(at);
    o.stop(at + m.decay + 0.1);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._loop);
    clearInterval(this._vib);
    if (navigator.vibrate) navigator.vibrate(0);
    const c = getCtx();
    try {
      this.master.gain.cancelScheduledValues(c.currentTime);
      this.master.gain.setValueAtTime(this.master.gain.value, c.currentTime);
      this.master.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
      setTimeout(() => this.master.disconnect(), 600);
    } catch {}
  }
}

/* --------------------------- 入眠サウンド --------------------------- */

export const AID_SOUNDS = {
  none: { name: 'なし' },
  rain: { name: '雨' },
  waves: { name: '波' },
  fire: { name: '焚き火' },
  fan: { name: '扇風機' },
  night: { name: '夏の夜' },
  white: { name: 'ホワイトノイズ' },
  pink: { name: 'ピンクノイズ' },
  brown: { name: 'ブラウンノイズ' },
  drone: { name: 'ディープドローン' },
};

export class AidPlayer {
  constructor() {
    this.current = null;
    this.nodes = [];
  }

  get isPlaying() {
    return !!this.current;
  }

  /** @param {number} fadeMin 0 なら停止しない */
  play(type, { volume = 0.5, fadeMin = 0 } = {}) {
    this.stop();
    if (!type || type === 'none') return;
    const c = getCtx();
    const out = c.createGain();
    out.gain.setValueAtTime(0, c.currentTime);
    out.gain.linearRampToValueAtTime(volume, c.currentTime + 2);
    out.connect(c.destination);
    this.master = out;
    this.current = type;
    this.nodes = [];

    const src = (kind) => {
      const s = c.createBufferSource();
      s.buffer = noiseBuffer(c, 4, kind);
      s.loop = true;
      s.start();
      this.nodes.push(s);
      return s;
    };
    const lfo = (freq, depth, target, base) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = freq;
      g.gain.value = depth;
      o.connect(g).connect(target);
      target.value = base;
      o.start();
      this.nodes.push(o);
    };

    switch (type) {
      case 'rain': {
        const n = src('pink');
        const hp = c.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 500;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 6500;
        const g = c.createGain();
        g.gain.value = 0.9;
        n.connect(hp).connect(lp).connect(g).connect(out);
        // 遠くの雨音のゆらぎ
        const g2 = c.createGain();
        g2.gain.value = 0.35;
        const lp2 = c.createBiquadFilter();
        lp2.type = 'lowpass';
        lp2.frequency.value = 700;
        src('brown').connect(lp2).connect(g2).connect(out);
        lfo(0.07, 0.12, g.gain, 0.9);
        break;
      }
      case 'waves': {
        const n = src('brown');
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        const g = c.createGain();
        n.connect(lp).connect(g).connect(out);
        lfo(0.09, 900, lp.frequency, 1100);
        lfo(0.09, 0.5, g.gain, 0.6);
        break;
      }
      case 'fire': {
        const n = src('brown');
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const g = c.createGain();
        g.gain.value = 0.6;
        n.connect(lp).connect(g).connect(out);
        // パチパチという爆ぜ音
        const crackle = () => {
          if (this.current !== 'fire') return;
          const b = c.createBufferSource();
          b.buffer = noiseBuffer(c, 0.05, 'white');
          const bp = c.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 1200 + Math.random() * 2500;
          const cg = c.createGain();
          const t = c.currentTime;
          cg.gain.setValueAtTime(0.25 + Math.random() * 0.3, t);
          cg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
          b.connect(bp).connect(cg).connect(out);
          b.start(t);
          this._crackleTimer = setTimeout(crackle, 60 + Math.random() * 700);
        };
        crackle();
        break;
      }
      case 'fan': {
        const n = src('brown');
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 620;
        const g = c.createGain();
        n.connect(lp).connect(g).connect(out);
        lfo(7.5, 0.06, g.gain, 0.85);
        break;
      }
      case 'night': {
        const n = src('pink');
        const hp = c.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2000;
        const g = c.createGain();
        g.gain.value = 0.12;
        n.connect(hp).connect(g).connect(out);
        // 虫の音
        const chirp = () => {
          if (this.current !== 'night') return;
          const o = c.createOscillator();
          const cg = c.createGain();
          o.type = 'triangle';
          o.frequency.value = 3800 + Math.random() * 900;
          const t = c.currentTime;
          cg.gain.setValueAtTime(0, t);
          for (let k = 0; k < 6; k++) {
            cg.gain.linearRampToValueAtTime(0.05, t + k * 0.09 + 0.02);
            cg.gain.linearRampToValueAtTime(0, t + k * 0.09 + 0.06);
          }
          o.connect(cg).connect(out);
          o.start(t);
          o.stop(t + 0.7);
          this._chirpTimer = setTimeout(chirp, 400 + Math.random() * 1800);
        };
        chirp();
        break;
      }
      case 'drone': {
        [55, 82.5, 110].forEach((f, i) => {
          const o = c.createOscillator();
          const g = c.createGain();
          o.type = 'sine';
          o.frequency.value = f + i * 0.15; // わずかにずらしてうねりを出す
          g.gain.value = 0.22 / (i + 1);
          o.connect(g).connect(out);
          o.start();
          this.nodes.push(o);
        });
        const n = src('brown');
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 300;
        const g = c.createGain();
        g.gain.value = 0.25;
        n.connect(lp).connect(g).connect(out);
        break;
      }
      default: {
        const n = src(type === 'white' ? 'white' : type === 'pink' ? 'pink' : 'brown');
        const g = c.createGain();
        g.gain.value = type === 'white' ? 0.35 : 0.7;
        n.connect(g).connect(out);
      }
    }

    if (fadeMin > 0) {
      const end = c.currentTime + fadeMin * 60;
      out.gain.setValueAtTime(volume, Math.max(c.currentTime + 2, end - 120));
      out.gain.linearRampToValueAtTime(0.0001, end);
      this._fadeTimer = setTimeout(() => this.stop(), fadeMin * 60_000 + 500);
    }
  }

  stop() {
    clearTimeout(this._fadeTimer);
    clearTimeout(this._crackleTimer);
    clearTimeout(this._chirpTimer);
    this.current = null;
    const nodes = this.nodes;
    this.nodes = [];
    const m = this.master;
    this.master = null;
    if (!m) return;
    try {
      const c = getCtx();
      m.gain.cancelScheduledValues(c.currentTime);
      m.gain.setValueAtTime(m.gain.value, c.currentTime);
      m.gain.linearRampToValueAtTime(0, c.currentTime + 0.6);
    } catch {}
    setTimeout(() => {
      nodes.forEach((n) => {
        try { n.stop(); } catch {}
      });
      try { m.disconnect(); } catch {}
    }, 800);
  }
}
