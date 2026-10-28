// Realtime storage for one room. Two backends with the same interface:
//   - Firebase Realtime Database (when VITE_FIREBASE_* are set): syncs across devices.
//   - Local (no config): in-memory + localStorage, synced between tabs of one browser.
//
// Interface (all paths are relative to the room):
//   kind, now(), subscribe(cb, onError) -> unsubscribe, set(path, value), patch(nestedObject),
//   remove(path), push(path, value) -> key, claim(path, value) -> Promise<boolean>,
//   presence(uid), beat(uid)

import { flatten } from './lib.js';

const env = import.meta.env || {};
export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  databaseURL: env.VITE_FIREBASE_DATABASE_URL,
  appId: env.VITE_FIREBASE_APP_ID,
};
export const hasFirebase = !!firebaseConfig.databaseURL;

export async function createStore(room) {
  return hasFirebase ? firebaseStore(room) : localStore(room);
}

/* ---------------- Firebase ---------------- */
async function firebaseStore(room) {
  const { initializeApp } = await import('firebase/app');
  const m = await import('firebase/database');
  const app = initializeApp(firebaseConfig);
  const db = m.getDatabase(app);
  const base = `rooms/${room}`;
  const at = (p) => m.ref(db, p ? `${base}/${p}` : base);
  let offset = 0;
  m.onValue(m.ref(db, '.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });

  return {
    kind: 'firebase',
    now: () => Date.now() + offset,
    subscribe: (cb, onError) => m.onValue(at(''), (s) => cb(s.val() || {}), onError),
    set: (path, value) => m.set(at(path), value),
    patch: (obj) => m.update(at(''), flatten(obj)),
    remove: (path) => m.remove(at(path)),
    push: (path, value) => { const r = m.push(at(path)); m.set(r, value); return r.key; },
    async claim(path, value) {
      const res = await m.runTransaction(at(path), (cur) => (cur ? undefined : value));
      return res.committed || res.snapshot.val() === value;
    },
    presence(uid) {
      const pref = at(`presence/${uid}`);
      return m.onValue(m.ref(db, '.info/connected'), (s) => {
        if (s.val() !== true) return;
        m.onDisconnect(pref).set({ online: false, at: m.serverTimestamp() })
          .then(() => m.set(pref, { online: true, at: m.serverTimestamp() }));
      });
    },
    beat: (uid) => m.update(at(`presence/${uid}`), { online: true, at: m.serverTimestamp() }),
  };
}

/* ---------------- Local (tabs of one browser) ---------------- */
function setAt(tree, path, value) {
  const parts = path.split('/');
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') {
      if (value === null) return;
      node[parts[i]] = {};
    }
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
}

export function localStore(room, storage = globalThis.localStorage, channelFactory) {
  const KEY = 'duoclock.local.' + room;
  let tree = {};
  try { tree = JSON.parse(storage.getItem(KEY) || '{}'); } catch { tree = {}; }
  const subs = new Set();
  const makeChannel = channelFactory === undefined ? (typeof BroadcastChannel !== 'undefined' ? (n) => new BroadcastChannel(n) : null) : channelFactory;
  const bc = makeChannel ? makeChannel(KEY) : null;
  const emit = () => { const snap = JSON.parse(JSON.stringify(tree)); subs.forEach((cb) => cb(snap)); };
  const persist = () => { try { storage.setItem(KEY, JSON.stringify(tree)); } catch { /* ignore */ } };
  const apply = (ops) => { ops.forEach(([p, v]) => setAt(tree, p, v)); };
  if (bc) bc.onmessage = (e) => { apply(e.data); emit(); };
  const commit = (ops) => { apply(ops); persist(); if (bc) bc.postMessage(ops); emit(); return Promise.resolve(); };

  return {
    kind: 'local',
    now: () => Date.now(),
    subscribe(cb) { subs.add(cb); queueMicrotask(() => cb(JSON.parse(JSON.stringify(tree)))); return () => subs.delete(cb); },
    set: (path, value) => commit([[path, value]]),
    patch: (obj) => commit(Object.entries(flatten(obj))),
    remove: (path) => commit([[path, null]]),
    push(path, value) {
      const key = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      commit([[`${path}/${key}`, value]]);
      return key;
    },
    async claim(path, value) {
      const cur = path.split('/').reduce((n, k) => (n ? n[k] : undefined), tree);
      if (cur) return cur === value;
      await commit([[path, value]]);
      return true;
    },
    presence(uid) {
      commit([[`presence/${uid}`, { online: true, at: Date.now() }]]);
      const off = () => commit([[`presence/${uid}`, { online: false, at: Date.now() }]]);
      if (typeof window !== 'undefined') window.addEventListener('pagehide', off);
      return () => { if (typeof window !== 'undefined') window.removeEventListener('pagehide', off); };
    },
    beat: (uid) => commit([[`presence/${uid}`, { online: true, at: Date.now() }]]),
  };
}
