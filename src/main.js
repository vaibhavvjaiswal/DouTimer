import './style.css';
import * as L from './lib.js';
import { createStore, hasFirebase } from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const { p2, esc, DAYN } = L;

/* ---------- device identity, room, preferences ---------- */
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const validRoom = (r) => /^[a-z0-9]{16,40}$/.test(r || '');
let myId = LS.get('duoclock.uid');
if (!/^[a-z0-9]{12,40}$/.test(myId || '')) { myId = L.newId(16); LS.set('duoclock.uid', myId); }
let room = new URL(location.href).searchParams.get('r');
if (!validRoom(room)) {
  room = LS.get('duoclock.room');
  if (!validRoom(room)) room = L.newId(22);
  history.replaceState(null, '', '?r=' + room + location.hash);
}
LS.set('duoclock.room', room);
const inviteUrl = () => location.origin + location.pathname + '?r=' + room;

const DEFAULTS = { breakMin: 5, longMin: 15, longEvery: 4, autoBreak: false, presets: '25,50,90' };
const ACCENTS = { sky: '#5aa9ff', violet: '#9b87ff', rose: '#f2698f', amber: '#f0b04a', mint: '#5ad6a4' };
const FONTS = {
  sans: "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif",
  serif: "'Fraunces',Georgia,'Times New Roman',serif",
  mono: "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace",
};
const PREF_KEY = 'duoclock.prefs';
const prefs = { theme: 'dark', accent: 'ink', custom: '#7aa2ff', font: 'sans', style: 'ring', h24: true, chime: true, vol: 0.5, pick: 25 };
try { Object.assign(prefs, JSON.parse(LS.get(PREF_KEY) || '{}')); } catch { /* ignore */ }
const savePrefs = () => LS.set(PREF_KEY, JSON.stringify(prefs));

/* ---------- state ---------- */
let store = null;
let R = {};            // the whole room, as last delivered by the database
let dbError = false;
let gotFirst = false;
let current = 'focus';
const now = () => (store ? store.now() : Date.now());

const settings = () => {
  const s = Object.assign({}, DEFAULTS, R.settings || {});
  const presets = L.parsePresets(s.presets);
  return { breakMin: +s.breakMin || 5, longMin: +s.longMin || 15, longEvery: +s.longEvery || 4, autoBreak: !!s.autoBreak, presets: presets.length ? presets : [25, 50, 90] };
};
const session = () => R.session || {};
const people = () => R.people || {};
const me = () => people()[myId] || {};
const myTz = () => {
  if (me().tz) return me().tz;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
};
const lastSeen = (id) => ((R.presence || {})[id] || {}).at || 0;
function partnerId() {
  const ids = Object.keys(people()).filter((i) => i !== myId && (people()[i].name || people()[i].tz));
  ids.sort((a, b) => lastSeen(b) - lastSeen(a));
  return ids[0] || null;
}
const nameOf = (id) => (people()[id] && people()[id].name) || (id === myId ? 'You' : 'Your person');
function isOnline(id) {
  const p = (R.presence || {})[id];
  return !!(p && p.online && now() - (p.at || 0) < 60000);
}
const partnerHere = () => Object.keys(R.presence || {}).some((id) => id !== myId && isOnline(id));

/* ---------- writing ---------- */
let warned = false;
function fail() {
  if (warned) return;
  warned = true;
  toast('Could not save. Check your connection and the database rules (see README).');
}
const guard = (p) => { if (p && p.catch) p.catch(fail); return p; };
const patch = (obj) => guard(store.patch(obj));
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3600);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { location.hash = '#prefs'; setTimeout(() => { const i = $('#inviteLink'); i.focus(); i.select(); }, 50); toast('Copy the link from the box'); }
}

/* ---------- audio ---------- */
let actx;
const ac = () => { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ } } return actx; };
function tone(notes) {
  if (!prefs.chime) return;
  const c = ac();
  if (!c) return;
  try {
    if (c.resume) c.resume();
    const t = c.currentTime;
    notes.forEach(([f, d]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, prefs.vol * 0.4), t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.9);
      o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 1);
    });
  } catch { /* ignore */ }
}
const chime = () => tone([[659.25, 0], [880, 0.18], [1318.5, 0.36]]);
const pingTone = () => tone([[880, 0], [1174.7, 0.14]]);
window.addEventListener('pointerdown', () => ac(), { once: true });

/* ---------- timer ---------- */
function remaining(s) {
  const st = s.status || 'idle';
  if (st === 'running') return Math.max(0, (s.endsAt || 0) - now());
  if (st === 'paused') return s.remainingMs || 0;
  if (st === 'finished') return 0;
  return prefs.pick * 60000;
}
const totalOf = (s) => ((s.status || 'idle') === 'idle' ? prefs.pick * 60000 : s.durationMs || 1);

function startRun(phase, min, round) {
  const t = now();
  patch({ session: { status: 'running', phase, durationMs: min * 60000, endsAt: t + min * 60000, remainingMs: null, runId: t, round, startedBy: myId } });
}
function startFocus(min) {
  const s = session();
  startRun('focus', min, !s.status || s.status === 'idle' ? 1 : (s.round || 0) + 1);
}
const startBreak = () => { const s = session(); startRun('break', L.breakMinutes(s.round || 1, settings()), s.round || 1); };
const pauseRun = () => { const s = session(); patch({ session: { status: 'paused', remainingMs: Math.max(0, (s.endsAt || 0) - now()), endsAt: null } }); };
const resumeRun = () => { const s = session(); patch({ session: { status: 'running', endsAt: now() + (s.remainingMs || 0), remainingMs: null } }); };
const endSession = () => patch({ session: { status: 'idle', phase: 'focus', round: 0, endsAt: null, remainingMs: null } });

let finishedRun = null;
function onFinish(s) {
  chime();
  const c = settings();
  if (s.phase === 'focus') {
    const mins = Math.round((s.durationMs || 0) / 60000);
    if (mins >= 1) {
      const goals = Object.values(s.goals || {}).filter(Boolean).join(' · ');
      guard(store.set('history/h' + s.runId, { at: s.endsAt, minutes: mins, round: s.round || 1, goals }));
    }
    if (c.autoBreak) {
      const b = L.breakMinutes(s.round || 1, c);
      // Derived from the old end time, so both devices write the same values.
      patch({ session: { status: 'running', phase: 'break', durationMs: b * 60000, endsAt: s.endsAt + b * 60000, remainingMs: null, runId: s.endsAt } });
      return;
    }
  }
  patch({ session: { status: 'finished' } });
}

/* ---------- routing ---------- */
const VIEWS = ['focus', 'play', 'together', 'stats', 'prefs'];
function route() {
  let h = location.hash.replace('#', '');
  if (!VIEWS.includes(h)) h = 'focus';
  current = h;
  VIEWS.forEach((v) => { $('#v-' + v).hidden = v !== h; });
  $$('nav.tabs a').forEach((a) => (a.dataset.v === h ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (h === 'play') claimSeat();
  scheduleRender();
}
window.addEventListener('hashchange', route);

/* ---------- rendering ---------- */
let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setHTML = (el, h) => { if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; } };

function renderAll() {
  renderHeader(); renderNotice();
  if (current === 'focus') renderFocus();
  else if (current === 'play') renderPlay();
  else if (current === 'together') renderTogether();
  else if (current === 'stats') renderStats();
  else renderPrefs();
}
function renderHeader() {
  const here = partnerHere(), pid = partnerId();
  $('#hdrDot').className = 'dot' + (here ? ' on' : '');
  setText($('#hdrText'), here ? (pid ? nameOf(pid) + ' is here' : 'Someone is here') : (pid ? nameOf(pid) + ' is away' : 'Just you'));
}
function renderNotice() {
  let h = '';
  if (dbError) h = '<div class="banner warn">Cannot reach the database. Check the Firebase variables and rules (see the README).</div>';
  else if (!hasFirebase) h = '<div class="banner warn">Local mode. This syncs between tabs on this device only. Add your Firebase settings to sync with your person (see the README).</div>';
  setHTML($('#notice'), h);
}

let lastCtl = '';
function renderFocus() {
  const s = session(), st = s.status || 'idle', pid = partnerId(), here = partnerHere(), c = settings();
  $('#setup').hidden = !!me().name;
  setText($('#stRound'), s.round ? 'Round ' + s.round : 'No session yet');
  setText($('#stPres'), here ? 'You are both here' : (pid ? nameOf(pid) + ' is away' : 'Just you'));
  setText($('#meName'), me().name || 'You');
  setText($('#pName'), pid ? nameOf(pid) : 'Your person');
  $('#pDot').className = 'dot' + (here ? ' on' : '');
  renderPTime();
  const goals = s.goals || {}, pEl = $('#pGoal');
  if (pid) { const pg = goals[pid] || ''; pEl.className = 'text' + (pg ? '' : ' empty'); setText(pEl, pg || 'No goal set yet'); }
  else { pEl.className = 'text empty'; setText(pEl, 'Waiting for them. Send them your invite link.'); }
  $('#copyInvite').hidden = !!pid;
  const gi = $('#myGoal');
  if (document.activeElement !== gi && gi.value !== (goals[myId] || '')) gi.value = goals[myId] || '';
  const cm = $('#customMin');
  if (document.activeElement !== cm && String(cm.value) !== String(prefs.pick)) cm.value = prefs.pick;
  setHTML($('#chips'), c.presets.map((m) => `<button class="chip" data-m="${m}" aria-pressed="${prefs.pick === m}">${m} min</button>`).join(''));
  $('#pickRow').hidden = !(st === 'idle' || st === 'finished');
  const bm = L.breakMinutes(s.round || 1, c), sig = [st, s.phase, s.round, bm, prefs.pick].join('|');
  let h = '';
  if (st === 'idle') h = `<button class="btn primary" data-act="start">Start ${prefs.pick} min</button>`;
  else if (st === 'running') h = '<button class="btn primary" data-act="pause">Pause</button>' + (s.phase === 'break' ? '<button class="btn" data-act="next">Skip break</button>' : '') + '<button class="btn" data-act="end">End session</button>';
  else if (st === 'paused') h = '<button class="btn primary" data-act="resume">Resume</button><button class="btn" data-act="end">End session</button>';
  else if (st === 'finished') {
    if (s.phase === 'break') h = `<button class="btn primary" data-act="next">Start round ${(s.round || 0) + 1} (${prefs.pick} min)</button><button class="btn" data-act="end">End session</button>`;
    else h = `<button class="btn primary" data-act="break">Take a ${bm} min break</button><button class="btn" data-act="next">Start round ${(s.round || 0) + 1}</button><button class="btn" data-act="end">End session</button>`;
  }
  if (sig !== lastCtl) { lastCtl = sig; $('#controls').innerHTML = h; }
  const stt = L.computeStats(R.history, now());
  setHTML($('#streakLine'), `<span><b>${stt.streak}</b> day streak</span><span><b>${L.dur(stt.today)}</b> today</span>`);
  updateTimer();
}
function renderPTime() {
  const el = $('#pTime'), pid = partnerId(), tz = pid && people()[pid].tz;
  if (!tz || !L.validTz(tz)) { setText(el, ''); return; }
  setText(el, new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hour12: !prefs.h24, timeZone: tz }).format(new Date()) + ' there');
}
function updateTimer() {
  const s = session(), st = s.status || 'idle', rem = remaining(s), tot = totalOf(s);
  const p = st === 'finished' ? 0 : Math.max(0, Math.min(1, rem / tot));
  const txt = L.fmtTime(rem), d = $('#digits');
  if (d.textContent !== txt) { d.textContent = txt; d.className = 'digits' + (txt.length > 5 ? ' long' : ''); }
  const C = 2 * Math.PI * 90, ring = $('#ring');
  ring.style.strokeDasharray = C; ring.style.strokeDashoffset = C * (1 - p);
  $('#barFill').style.width = p * 100 + '%';
  const label = st === 'idle' ? 'Ready' : st === 'running' ? (s.phase === 'break' ? 'Break' : 'Focus') : st === 'paused' ? 'Paused' : (s.phase === 'break' ? 'Break over' : 'Round complete');
  setText($('#phase'), label);
  const t = st === 'running' || st === 'paused' ? `${txt} · ${label}` : st === 'finished' ? 'Done · Duo Clock' : 'Duo Clock';
  if (document.title !== t) document.title = t;
  syncLock(st === 'running');
}
let lock = null, lockTry = 0;
function syncLock(on) {
  if (!on) { if (lock) { try { lock.release(); } catch { /* ignore */ } lock = null; } return; }
  if (lock || !('wakeLock' in navigator) || Date.now() - lockTry < 15000 || document.hidden) return;
  lockTry = Date.now();
  navigator.wakeLock.request('screen').then((l) => { lock = l; l.addEventListener('release', () => { lock = null; }); }).catch(() => {});
}

/* ---------- four in a row ---------- */
function G() {
  const g = R.game || {};
  return {
    board: typeof g.board === 'string' && g.board.length === 42 ? g.board : L.EMPTY_BOARD,
    turn: g.turn || 1, winner: g.winner || 0, starter: g.starter || 1,
    line: g.line ? String(g.line).split(',').map(Number) : [],
    players: g.players || {}, scores: g.scores || {},
  };
}
const seatOf = (g) => (g.players.p1 === myId ? 1 : g.players.p2 === myId ? 2 : 0);
let claiming = false;
async function claimSeat() {
  if (!store || claiming || seatOf(G())) return;
  claiming = true;
  try { if (!(await store.claim('game/players/p1', myId))) await store.claim('game/players/p2', myId); } catch { fail(); }
  claiming = false;
}
function drop(col) {
  const g = G(), seat = seatOf(g);
  if (g.winner || !seat || seat !== g.turn || !g.players.p1 || !g.players.p2) return;
  const res = L.dropPiece(g.board, col, seat);
  if (!res) return;
  const upd = { board: res.board, lastMove: res.index, turn: seat === 1 ? 2 : 1 };
  const w = L.winCheck(res.board);
  if (w) {
    upd.winner = w.winner; upd.line = w.line.join(',');
    const uid = w.winner === 1 ? g.players.p1 : g.players.p2;
    upd.scores = { [uid]: (+g.scores[uid] || 0) + 1 };
  } else if (!res.board.includes('0')) upd.winner = 3;
  patch({ game: upd });
}
function renderPlay() {
  const g = G(), seat = seatOf(g), ready = g.players.p1 && g.players.p2;
  if (!seat && !ready) claimSeat(); // heals a lost seat race
  let h = '';
  for (let c = 0; c < 7; c++) {
    h += `<button class="col" data-c="${c}" aria-label="Drop in column ${c + 1}"${g.winner || !ready || seat !== g.turn ? ' disabled' : ''}>`;
    for (let r = 0; r < 6; r++) {
      const i = r * 7 + c, v = +g.board[i];
      h += `<span class="cell${v ? ' d' + v : ''}${g.line.includes(i) ? ' win' : ''}"></span>`;
    }
    h += '</button>';
  }
  setHTML($('#board'), h);
  let sc = '';
  [[1, g.players.p1], [2, g.players.p2]].forEach(([n, id]) => { if (id) sc += `<div><span class="disc d${n}"></span>${esc(nameOf(id))}${id === myId ? ' (you)' : ''} <b>${+g.scores[id] || 0}</b></div>`; });
  setHTML($('#score'), sc);
  let msg;
  if (!ready) msg = 'Waiting for your person to take a seat.';
  else if (!seat) msg = 'Watching. Both seats are taken.';
  else if (g.winner === 3) msg = 'Draw. Start a new game.';
  else if (g.winner) msg = g.winner === seat ? 'You won' : nameOf(g.winner === 1 ? g.players.p1 : g.players.p2) + ' won';
  else msg = g.turn === seat ? 'Your turn' : 'Waiting for ' + nameOf(g.turn === 1 ? g.players.p1 : g.players.p2);
  setText($('#gStatus'), msg);
}

/* ---------- together ---------- */
function clockCard(id, label) {
  const p = people()[id] || {}, tz = p.tz && L.validTz(p.tz) ? p.tz : null;
  if (!tz) return `<div class="card" style="display:grid;gap:8px"><h2>${esc(label)}</h2><div class="big">–</div><div class="muted small">Time zone not set yet.</div></div>`;
  const d = new Date();
  const t = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hour12: !prefs.h24, timeZone: tz }).format(d);
  const dd = new Intl.DateTimeFormat([], { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }).format(d);
  let diff = '';
  if (id !== myId) {
    const m = L.tzOffset(tz, d) - L.tzOffset(myTz(), d), a = Math.abs(m);
    diff = m === 0 ? 'Same time as you' : `${Math.floor(a / 60)}h${a % 60 ? ' ' + (a % 60) + 'm' : ''}${m > 0 ? ' ahead of you' : ' behind you'}`;
  }
  return `<div class="card" style="display:grid;gap:8px"><h2>${esc(label)}</h2><div class="big">${esc(t)}</div><div class="muted small">${esc(dd)} · ${esc(tz)}${diff ? '<br>' + diff : ''}</div></div>`;
}
function standingItems() {
  const m = (R.standing || {}).items || {};
  return Object.keys(m).map((id) => ({ id, days: String(m[id].days || '').split(',').filter((x) => x !== '').map(Number), time: m[id].time, minutes: m[id].minutes, tz: m[id].tz }));
}
function renderTogether() {
  const pid = partnerId();
  let h = clockCard(myId, me().name || 'You');
  h += pid ? clockCard(pid, nameOf(pid)) : '<div class="card" style="display:grid;gap:8px"><h2>Your person</h2><div class="big">–</div><div class="muted small">Their local time shows here after they join.</div></div>';
  setHTML($('#clocks'), h);
  const v = R.visit || {}, big = $('#visitBig'), sub = $('#visitSub');
  if (v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const n = Math.round((new Date(v.date + 'T00:00:00') - t0) / 864e5);
    setText(big, n === 0 ? 'Today' : n > 0 ? n + (n === 1 ? ' day' : ' days') : Math.abs(n) + (n === -1 ? ' day ago' : ' days ago'));
    setText(sub, (v.label ? v.label + ' · ' : '') + new Date(v.date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  } else { setText(big, '–'); setText(sub, 'Set the date you next see each other.'); }
  const vd = $('#visitDate'); if (document.activeElement !== vd && vd.value !== (v.date || '')) vd.value = v.date || '';
  const vl = $('#visitLabel'); if (document.activeElement !== vl && vl.value !== (v.label || '')) vl.value = v.label || '';
  const items = standingItems();
  let lh = items.length ? '' : '<div class="muted small" style="padding:4px 0">No standing sessions yet.</div>';
  items.forEach((it) => {
    lh += `<div class="item"><div><div>${esc(it.days.map((d) => DAYN[d]).join(', '))} at ${esc(it.time)}</div><div class="muted small">${esc(it.minutes)} min · ${esc(it.tz || '')}</div></div><button class="btn sm" data-rm="${esc(it.id)}">Remove</button></div>`;
  });
  setHTML($('#standList'), lh);
  setText($('#standTz'), 'Times use your time zone: ' + myTz());
}
let newDays = [1, 2, 3, 4, 5];
function renderDayButtons() {
  $('#standDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-d="${d}" aria-pressed="${newDays.includes(d)}">${DAYN[d]}</button>`).join('');
}
const dismissed = {};
function checkStanding() {
  const b = $('#standBanner'), st = session().status || 'idle';
  let hit = null;
  if (st === 'idle' || st === 'finished') {
    for (const it of standingItems()) {
      if (hit || !it.tz || !L.validTz(it.tz)) continue;
      const pp = L.partsIn(it.tz, new Date()), [hh, mm] = String(it.time).split(':'), tm = +hh * 60 + +mm;
      const key = it.id + '|' + L.dayKey(Date.now());
      if (it.days.includes(pp.wd) && pp.min >= tm && pp.min < tm + 15 && !dismissed[key]) hit = { it, key };
    }
  }
  if (hit) {
    setHTML(b, `<span>Standing session time: ${esc(hit.it.minutes)} min.</span><button class="btn primary sm" data-stand="${esc(hit.it.minutes)}">Start</button><button class="btn sm" data-dismiss="${esc(hit.key)}">Not now</button>`);
    b.hidden = false;
  } else { b.hidden = true; delete b.dataset.h; }
}

/* ---------- stats ---------- */
function renderStats() {
  const st = L.computeStats(R.history, now());
  let h = '<div class="card"><div class="stats">'
    + `<div class="stat"><b>${L.dur(st.today)}</b><span>Today</span></div>`
    + `<div class="stat"><b>${L.dur(st.week)}</b><span>Last 7 days</span></div>`
    + `<div class="stat"><b>${st.streak}</b><span>Day streak</span></div>`
    + `<div class="stat"><b>${st.best}</b><span>Best streak</span></div>`
    + `<div class="stat"><b>${Math.round(st.total / 6) / 10}h</b><span>All time</span></div>`
    + `<div class="stat"><b>${st.count}</b><span>Rounds finished</span></div></div></div>`;
  const days = []; let max = 0;
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const m = st.by[L.dayKey(d)] || 0; if (m > max) max = m; days.push({ d, m, t: i === 0 }); }
  h += '<div class="card"><h2 style="margin-bottom:6px">Last 14 days</h2><div class="bars">';
  days.forEach((x) => { h += `<div class="${x.t ? 'today' : ''}" title="${x.m} min"><i class="${x.m ? '' : 'zero'}" style="height:${x.m ? Math.max(4, Math.round((x.m / max) * 100)) : 3}%"></i><span>${DAYN[x.d.getDay()].charAt(0)}</span></div>`; });
  h += `</div><div class="muted small" style="margin-top:8px">Peak day: ${L.dur(max)}</div></div>`;
  const rec = st.list.slice().sort((a, b) => b.at - a.at).slice(0, 8);
  h += '<div class="card"><h2 style="margin-bottom:6px">Recent rounds</h2><div class="list">';
  if (!rec.length) h += '<div class="muted small" style="padding:6px 0">Finish a round together and it appears here.</div>';
  rec.forEach((r) => { h += `<div class="item"><div><div>${esc(new Date(r.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: !prefs.h24 }))}</div><div class="muted small">${esc(r.goals || '')}</div></div><div class="muted">${esc(r.minutes)} min</div></div>`; });
  h += '</div></div>';
  setHTML($('#statsBody'), h);
}

/* ---------- settings ---------- */
function applyPrefs() {
  const r = document.documentElement;
  if (prefs.theme === 'dark' || prefs.theme === 'light') r.setAttribute('data-theme', prefs.theme); else r.removeAttribute('data-theme');
  if (prefs.accent === 'ink') { r.style.setProperty('--accent', 'var(--fg)'); r.style.setProperty('--on-accent', 'var(--bg)'); }
  else {
    const c = prefs.accent === 'custom' ? prefs.custom : ACCENTS[prefs.accent] || ACCENTS.sky;
    r.style.setProperty('--accent', c); r.style.setProperty('--on-accent', readable(c));
  }
  r.style.setProperty('--font-ui', FONTS[prefs.font] || FONTS.sans);
  $('#clock').dataset.style = prefs.style;
}
function readable(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#0a0a0a';
  const n = parseInt(m[1], 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#0a0a0a' : '#ffffff';
}
function buildSwatches() {
  let h = '<button class="sw" data-acc="ink" aria-label="Ink" style="background:linear-gradient(135deg,var(--fg) 50%,var(--bg) 50%)"></button>';
  Object.keys(ACCENTS).forEach((k) => { h += `<button class="sw" data-acc="${k}" aria-label="${k}" style="background:${ACCENTS[k]}"></button>`; });
  h += `<input type="color" id="inCustom" aria-label="Custom accent" value="${prefs.custom}">`;
  $('#swatches').innerHTML = h;
}
function renderPrefs() {
  const c = settings(), a = document.activeElement;
  const setv = (id, v) => { const el = $('#' + id); if (a !== el && String(el.value) !== String(v)) el.value = v; };
  setv('inName', me().name || ''); setv('inTz', myTz());
  setv('inPresets', c.presets.join(', ')); setv('inBreak', c.breakMin); setv('inLong', c.longMin); setv('inEvery', c.longEvery);
  $('#inAuto').checked = c.autoBreak; $('#inChime').checked = !!prefs.chime; setv('inVol', prefs.vol);
  setv('inviteLink', inviteUrl());
  setText($('#roomInfo'), hasFirebase ? 'Anyone with this link can join your room, so send it only to your person.' : 'Local mode: this room only exists in this browser. Add your Firebase settings to share it.');
  $$('.seg[data-pref]').forEach((sg) => { const k = sg.dataset.pref; Array.from(sg.children).forEach((b) => b.setAttribute('aria-pressed', String(prefs[k]) === b.dataset.val)); });
  $$('.sw').forEach((b) => b.setAttribute('aria-pressed', String(prefs.accent === b.dataset.acc)));
}

/* ---------- chat and pings ---------- */
let lastRead = null, lastPingAt = 0;
function chatKeys() { return Object.keys(R.chat || {}).sort(); }
function renderChat() {
  const keys = chatKeys().slice(-60), box = $('#chatBox');
  let h = keys.length ? '' : '<div class="muted small" style="padding:4px 0">Nothing yet.</div>';
  keys.forEach((k) => { const m = R.chat[k]; h += `<div class="msg${m.uid === myId ? ' mine' : ''}"><small>${esc(m.uid === myId ? 'You' : m.name || nameOf(m.uid))}</small>${esc(String(m.t || '').slice(0, 300))}</div>`; });
  const el = $('#msgs');
  if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; el.scrollTop = el.scrollHeight; }
  const all = chatKeys();
  if (box.open) lastRead = all[all.length - 1] || null;
  const unread = all.filter((k) => (lastRead === null || k > lastRead) && R.chat[k].uid !== myId).length;
  const u = $('#unread'); u.hidden = !unread; u.textContent = unread;
}
function checkPing() {
  const p = R.ping;
  if (!p || !p.at) return;
  if (!gotFirst) { lastPingAt = p.at; return; }
  if (p.at > lastPingAt) {
    lastPingAt = p.at;
    if (p.uid !== myId) { pingTone(); toast((p.name || nameOf(p.uid)) + ' pinged you'); }
  }
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || !store) return;
  const act = t.dataset.act;
  if (act) {
    if (act === 'start' || act === 'next') startFocus(prefs.pick);
    else if (act === 'pause') pauseRun(); else if (act === 'resume') resumeRun();
    else if (act === 'break') startBreak(); else if (act === 'end') endSession();
    return;
  }
  if (t.dataset.m) { prefs.pick = +t.dataset.m; savePrefs(); scheduleRender(); return; }
  if (t.dataset.c !== undefined) { drop(+t.dataset.c); return; }
  if (t.dataset.stand) { startFocus(+t.dataset.stand); return; }
  if (t.dataset.dismiss) { dismissed[t.dataset.dismiss] = 1; checkStanding(); return; }
  if (t.dataset.rm) { guard(store.remove('standing/items/' + t.dataset.rm)); return; }
  if (t.dataset.d !== undefined && t.parentNode.id === 'standDays') { const d = +t.dataset.d, i = newDays.indexOf(d); if (i >= 0) newDays.splice(i, 1); else newDays.push(d); renderDayButtons(); return; }
  if (t.dataset.acc) { prefs.accent = t.dataset.acc; savePrefs(); applyPrefs(); renderPrefs(); return; }
  const sg = t.closest('.seg[data-pref]');
  if (sg) { const k = sg.dataset.pref, v = t.dataset.val; prefs[k] = k === 'h24' ? v === 'true' : v; savePrefs(); applyPrefs(); scheduleRender(); }
});
$('#customMin').addEventListener('input', (e) => {
  const v = Math.round(+e.target.value);
  if (v >= 1 && v <= 600) { prefs.pick = v; savePrefs(); lastCtl = ''; scheduleRender(); }
});
let goalT;
$('#myGoal').addEventListener('input', (e) => { const v = e.target.value; clearTimeout(goalT); goalT = setTimeout(() => patch({ session: { goals: { [myId]: v } } }), 600); });
$('#setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = $('#setupName').value.trim();
  if (!n || !store) return;
  patch({ people: { [myId]: { name: n, tz: myTz() } } }); toast('Saved');
});
$('#pingBtn').addEventListener('click', () => {
  if (!store) return;
  guard(store.set('ping', { uid: myId, name: me().name || '', at: now() }));
  setText($('#pingNote'), 'Sent'); setTimeout(() => setText($('#pingNote'), ''), 2500);
});
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chatIn'), t = inp.value.trim();
  if (!t || !store) return;
  store.push('chat', { uid: myId, name: me().name || '', t: t.slice(0, 300), at: now() });
  inp.value = '';
  const keys = chatKeys();
  if (keys.length > 80) keys.slice(0, keys.length - 60).forEach((k) => store.remove('chat/' + k));
});
$('#chatBox').addEventListener('toggle', renderChat);
$('#rematch').addEventListener('click', () => { const g = G(), st = g.starter === 1 ? 2 : 1; patch({ game: { board: L.EMPTY_BOARD, turn: st, starter: st, winner: 0, line: '' } }); });
let rsT = 0;
$('#resetGame').addEventListener('click', () => {
  const b = $('#resetGame');
  if (!rsT) { b.textContent = 'Tap again to confirm'; rsT = setTimeout(() => { rsT = 0; b.textContent = 'Reset seats and scores'; }, 3000); return; }
  clearTimeout(rsT); rsT = 0; b.textContent = 'Reset seats and scores';
  patch({ game: { board: L.EMPTY_BOARD, turn: 1, starter: 1, winner: 0, line: '', players: null, scores: null } }).then(() => claimSeat());
});
let visT;
const saveVisit = () => { clearTimeout(visT); visT = setTimeout(() => patch({ visit: { date: $('#visitDate').value, label: $('#visitLabel').value.trim() } }), 400); };
$('#visitDate').addEventListener('change', saveVisit);
$('#visitLabel').addEventListener('input', saveVisit);
$('#standAdd').addEventListener('click', () => {
  const time = $('#standTime').value, min = Math.round(+$('#standMin').value);
  if (!store) return;
  if (!time || !(min >= 1 && min <= 600)) { toast('Pick a time and a length between 1 and 600 minutes'); return; }
  if (!newDays.length) { toast('Pick at least one day'); return; }
  patch({ standing: { items: { ['s' + Date.now().toString(36)]: { days: newDays.slice().sort().join(','), time, minutes: min, tz: myTz() } } } });
  toast('Added');
});
let nameT;
$('#inName').addEventListener('input', (e) => { const v = e.target.value.trim().slice(0, 24); clearTimeout(nameT); nameT = setTimeout(() => store && patch({ people: { [myId]: { name: v, tz: myTz() } } }), 500); });
$('#inTz').addEventListener('change', (e) => { const v = e.target.value.trim(); if (!L.validTz(v)) { toast('Unknown time zone. Pick one from the list.'); return; } store && patch({ people: { [myId]: { tz: v } } }); });
function clampNum(id, min, max, key) {
  $('#' + id).addEventListener('change', (e) => {
    const v = Math.round(+e.target.value);
    if (!(v >= min && v <= max)) { renderPrefs(); return; }
    store && patch({ settings: { [key]: v } });
  });
}
clampNum('inBreak', 1, 120, 'breakMin'); clampNum('inLong', 1, 180, 'longMin'); clampNum('inEvery', 2, 12, 'longEvery');
$('#inPresets').addEventListener('change', (e) => { const arr = L.parsePresets(e.target.value); if (arr.length && store) patch({ settings: { presets: arr.join(',') } }); else renderPrefs(); });
$('#inAuto').addEventListener('change', (e) => store && patch({ settings: { autoBreak: e.target.checked } }));
$('#inChime').addEventListener('change', (e) => { prefs.chime = e.target.checked; savePrefs(); });
$('#inVol').addEventListener('input', (e) => { prefs.vol = +e.target.value; savePrefs(); });
$('#testChime').addEventListener('click', chime);
document.addEventListener('input', (e) => { if (e.target.id === 'inCustom') { prefs.custom = e.target.value; prefs.accent = 'custom'; savePrefs(); applyPrefs(); renderPrefs(); } });
$('#copyInvite').addEventListener('click', () => copyText(inviteUrl()));
$('#copyInvite2').addEventListener('click', () => copyText(inviteUrl()));
let nrT = 0;
$('#newRoom').addEventListener('click', () => {
  const b = $('#newRoom');
  if (!nrT) { b.textContent = 'Tap again to confirm'; nrT = setTimeout(() => { nrT = 0; b.textContent = 'Start a new room'; }, 3000); return; }
  const r = L.newId(22); LS.set('duoclock.room', r); location.href = location.pathname + '?r=' + r + '#focus';
});
let clrT = 0;
$('#clearHist').addEventListener('click', () => {
  const b = $('#clearHist');
  if (!store) return;
  if (!clrT) { b.textContent = 'Tap again to confirm'; clrT = setTimeout(() => { clrT = 0; b.textContent = 'Clear focus history'; }, 3000); return; }
  clearTimeout(clrT); clrT = 0; b.textContent = 'Clear focus history';
  guard(store.remove('history')); toast('History cleared');
});

/* ---------- loop ---------- */
let tickN = 0;
setInterval(() => {
  if (!store) return;
  const s = session();
  if (s.status === 'running' && now() >= (s.endsAt || 0) && finishedRun !== s.runId) { finishedRun = s.runId; onFinish(s); }
  if (current === 'focus') updateTimer();
  if (++tickN % 4 === 0) {
    if (current === 'focus') renderPTime();
    if (current === 'together') renderTogether();
    if (current === 'focus' || current === 'together') checkStanding();
    renderHeader();
  }
}, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });

/* ---------- boot ---------- */
async function boot() {
  try { const z = Intl.supportedValuesOf && Intl.supportedValuesOf('timeZone'); if (z) $('#tzs').innerHTML = z.map((t) => `<option value="${t}">`).join(''); } catch { /* ignore */ }
  buildSwatches(); renderDayButtons(); applyPrefs(); route();
  try { store = await createStore(room); } catch (err) { console.error(err); dbError = true; scheduleRender(); return; }
  store.subscribe((val) => {
    R = val || {};
    checkPing();
    if (!gotFirst) {
      gotFirst = true;
      const all = chatKeys(); lastRead = all[all.length - 1] || null;
      if (!me().tz) patch({ people: { [myId]: { tz: myTz() } } });
    }
    renderChat(); scheduleRender();
  }, () => { dbError = true; scheduleRender(); });
  store.presence(myId);
  setInterval(() => store.beat(myId), 20000);
  scheduleRender();
}
boot();
