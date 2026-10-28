// Pure helpers. No DOM, no network, so they can be unit tested in Node.

export const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const p2 = (n) => (n < 10 ? '0' : '') + n;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function newId(len = 22) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  (globalThis.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** Turn a nested object into { 'a/b/c': leaf } so Firebase update() merges instead of replacing. */
export function flatten(obj, prefix = '', out = {}) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? prefix + '/' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v === undefined ? null : v;
  }
  return out;
}

/** mm:ss, or h:mm:ss from milliseconds (rounds up, like a countdown should). */
export function fmtTime(ms) {
  const sec = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return h ? `${h}:${p2(m)}:${p2(r)}` : `${p2(m)}:${p2(r)}`;
}

export function dur(minutes) {
  if (minutes >= 60) {
    const m = minutes % 60;
    return `${Math.floor(minutes / 60)}h${m ? ' ' + p2(m) + 'm' : ''}`;
  }
  return `${minutes}m`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** history: { id: { at, minutes, round, goals } } */
export function computeStats(history, nowTs = Date.now()) {
  const by = {};
  let total = 0, count = 0;
  const list = Object.keys(history || {}).map((k) => history[k]).filter((h) => h && h.at);
  for (const h of list) {
    const k = dayKey(h.at);
    by[k] = (by[k] || 0) + (h.minutes || 0);
    total += h.minutes || 0;
    count++;
  }
  let streak = 0;
  const d = new Date(nowTs);
  if (!by[dayKey(d)]) d.setDate(d.getDate() - 1);
  while (by[dayKey(d)]) { streak++; d.setDate(d.getDate() - 1); }
  let best = 0, run = 0, prev = null;
  for (const k of Object.keys(by).sort()) {
    const cur = new Date(k + 'T12:00:00');
    run = prev && Math.round((cur - prev) / 864e5) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = cur;
  }
  let week = 0;
  for (let i = 0; i < 7; i++) {
    const dd = new Date(nowTs);
    dd.setDate(dd.getDate() - i);
    week += by[dayKey(dd)] || 0;
  }
  return { by, total, count, streak, best, week, today: by[dayKey(new Date(nowTs))] || 0, list };
}

/* ---------- Four in a Row. Board is a 42 character string of 0/1/2, row 0 on top. ---------- */
export const EMPTY_BOARD = '0'.repeat(42);

export function winCheck(board) {
  const b = typeof board === 'string' ? board.split('').map(Number) : board;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    const v = b[r * 7 + c];
    if (!v) continue;
    for (const d of dirs) {
      const cells = [r * 7 + c];
      let ok = true;
      for (let k = 1; k < 4; k++) {
        const rr = r + d[1] * k, cc = c + d[0] * k;
        if (rr < 0 || rr >= 6 || cc < 0 || cc >= 7 || b[rr * 7 + cc] !== v) { ok = false; break; }
        cells.push(rr * 7 + cc);
      }
      if (ok) return { winner: v, line: cells };
    }
  }
  return null;
}

/** Returns the new board string and the landing index, or null if the column is full. */
export function dropPiece(board, col, seat) {
  for (let r = 5; r >= 0; r--) {
    const i = r * 7 + col;
    if (board[i] === '0') return { board: board.slice(0, i) + seat + board.slice(i + 1), index: i };
  }
  return null;
}

/* ---------- time zones ---------- */
export function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

export function tzOffset(tz, d) {
  const a = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const b = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((a - b) / 60000);
}

export function partsIn(tz, d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(d).forEach((p) => { o[p.type] = p.value; });
  return { wd: DAYN.indexOf(o.weekday), min: +o.hour * 60 + +o.minute };
}

export function parsePresets(text) {
  const seen = {};
  return String(text).split(/[\s,]+/).map(Number)
    .filter((n) => n >= 1 && n <= 600 && n % 1 === 0 && !seen[n] && (seen[n] = 1)).slice(0, 6);
}

/** Break length after a finished focus round. */
export function breakMinutes(round, settings) {
  return round % settings.longEvery === 0 ? settings.longMin : settings.breakMin;
}
