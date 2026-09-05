// 永続化レイヤ: セッションと録音クリップは IndexedDB、設定は localStorage

import { uid } from './utils.js';

const DB_NAME = 'sleepcycle-db';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('start', 'start');
      }
      if (!db.objectStoreNames.contains('clips')) {
        const c = db.createObjectStore('clips', { keyPath: 'id' });
        c.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const Store = {
  async saveSession(session) {
    if (!session.id) session.id = uid();
    await tx('sessions', 'readwrite', (os) => os.put(session));
    return session.id;
  },

  async getSession(id) {
    return tx('sessions', 'readonly', (os) => os.get(id));
  },

  /** 新しい順 */
  async listSessions(limit = 200) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('sessions', 'readonly');
      const idx = t.objectStore('sessions').index('start');
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  async deleteSession(id) {
    await this.deleteClipsFor(id);
    await tx('sessions', 'readwrite', (os) => os.delete(id));
  },

  async saveClip(clip) {
    if (!clip.id) clip.id = uid();
    await tx('clips', 'readwrite', (os) => os.put(clip));
    return clip.id;
  },

  async listClips(sessionId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('clips', 'readonly');
      const req = t.objectStore('clips').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          out.sort((a, b) => a.t - b.t);
          resolve(out);
          return;
        }
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  async deleteClip(id) {
    await tx('clips', 'readwrite', (os) => os.delete(id));
  },

  async deleteClipsFor(sessionId) {
    const clips = await this.listClips(sessionId);
    for (const c of clips) await this.deleteClip(c.id);
  },

  async clearAll() {
    await tx('sessions', 'readwrite', (os) => os.clear());
    await tx('clips', 'readwrite', (os) => os.clear());
  },

  /** 録音は容量が大きいので JSON エクスポートには含めない */
  async exportJSON() {
    const sessions = await this.listSessions(9999);
    return JSON.stringify(
      { app: 'sleepcycle-web', version: 1, exportedAt: Date.now(), settings: Settings.load(), sessions },
      null,
      2
    );
  },

  async importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.sessions)) throw new Error('形式が正しくありません');
    let n = 0;
    for (const s of data.sessions) {
      if (!s.start) continue;
      s.clipCount = 0;
      await this.saveSession(s);
      n++;
    }
    if (data.settings) Settings.save({ ...Settings.load(), ...data.settings });
    return n;
  },
};

const SETTINGS_KEY = 'sleepcycle-settings';

export const DEFAULT_SETTINGS = {
  alarmTime: '07:00',
  alarmEnabled: true,
  windowMin: 30, // スマートアラームの猶予（0 = 通常アラーム）
  melody: 'sunrise',
  gradual: true, // 徐々に音量を上げる
  vibrate: true,
  snoozeEnabled: true,
  snoozeSmart: true, // スヌーズのたびに間隔を半分に
  snoozeMin: 9,
  sensor: 'both', // 'mic' | 'motion' | 'both'
  recordSounds: true, // いびき・寝言の録音
  aidSound: 'none',
  aidFadeMin: 20,
  aidVolume: 0.5,
  goalMin: 480,
  dimScreen: true,
  showLiveGraph: true,
};

export const Settings = {
  load() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  save(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return s;
  },
  patch(partial) {
    return this.save({ ...this.load(), ...partial });
  },
};
