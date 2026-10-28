import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/lib.js';
import { localStore } from '../src/store.js';

test('fmtTime counts down like a timer', () => {
  assert.equal(L.fmtTime(25 * 60000), '25:00');
  assert.equal(L.fmtTime(59001), '01:00');
  assert.equal(L.fmtTime(90 * 60000), '1:30:00');
  assert.equal(L.fmtTime(-5), '00:00');
});

test('winCheck finds horizontal, vertical and both diagonals', () => {
  const mk = (cells, v) => { const b = Array(42).fill('0'); cells.forEach((i) => (b[i] = v)); return b.join(''); };
  assert.deepEqual(L.winCheck(mk([35, 36, 37, 38], '1')).line, [35, 36, 37, 38]);
  assert.equal(L.winCheck(mk([35, 28, 21, 14], '2')).winner, 2);
  assert.equal(L.winCheck(mk([35, 29, 23, 17], '1')).winner, 1);
  assert.equal(L.winCheck(mk([38, 30, 22, 14], '2')).winner, 2);
  assert.equal(L.winCheck(mk([35, 36, 37], '1')), null);
  assert.equal(L.winCheck(L.EMPTY_BOARD), null);
});

test('dropPiece stacks and rejects a full column', () => {
  let b = L.EMPTY_BOARD;
  for (let i = 0; i < 6; i++) { const r = L.dropPiece(b, 3, i % 2 ? '2' : '1'); assert.ok(r); b = r.board; }
  assert.equal(L.dropPiece(b, 3, '1'), null);
  assert.equal(b[38], '1');
  assert.equal(b[3], '2');
});

test('computeStats: streak counts back from today, or from yesterday', () => {
  const noon = (daysAgo) => { const d = new Date(2026, 9, 29, 12); d.setDate(d.getDate() - daysAgo); return d.getTime(); };
  const now = noon(0);
  const h = { a: { at: noon(0), minutes: 25 }, b: { at: noon(1), minutes: 50 }, c: { at: noon(2), minutes: 25 }, d: { at: noon(5), minutes: 90 } };
  const s = L.computeStats(h, now);
  assert.equal(s.streak, 3);
  assert.equal(s.best, 3);
  assert.equal(s.today, 25);
  assert.equal(s.total, 190);
  assert.equal(s.count, 4);
  const y = L.computeStats({ b: h.b, c: h.c }, now);
  assert.equal(y.streak, 2);
  assert.equal(L.computeStats({}, now).streak, 0);
});

test('flatten turns nested patches into paths and keeps nulls', () => {
  assert.deepEqual(L.flatten({ session: { goals: { u1: 'a' }, endsAt: null }, x: 1 }), { 'session/goals/u1': 'a', 'session/endsAt': null, x: 1 });
});

test('parsePresets cleans user input', () => {
  assert.deepEqual(L.parsePresets('25, 50  90, 25, 0, 700, 1.5, abc'), [25, 50, 90]);
  assert.deepEqual(L.parsePresets('nonsense'), []);
});

test('breakMinutes gives a long break every Nth round', () => {
  const s = { breakMin: 5, longMin: 15, longEvery: 4 };
  assert.equal(L.breakMinutes(1, s), 5);
  assert.equal(L.breakMinutes(4, s), 15);
  assert.equal(L.breakMinutes(8, s), 15);
});

test('time zone offset difference', () => {
  const d = new Date('2026-10-29T12:00:00Z');
  assert.equal(L.tzOffset('Asia/Kolkata', d) - L.tzOffset('UTC', d), 330);
  assert.ok(L.validTz('Europe/London'));
  assert.ok(!L.validTz('Not/AZone'));
});

function fakeStorage() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; }

test('localStore: patch merges, remove deletes, claim is first come first served', async () => {
  const st = fakeStorage();
  const s = localStore('room1234567890abcd', st, null);
  let latest;
  s.subscribe((v) => { latest = v; });
  await s.patch({ session: { status: 'running', goals: { a: 'x' } } });
  await s.patch({ session: { goals: { b: 'y' } } });
  assert.deepEqual(latest.session.goals, { a: 'x', b: 'y' });
  assert.equal(latest.session.status, 'running');
  await s.patch({ session: { status: null } });
  assert.equal(latest.session.status, undefined);
  assert.equal(await s.claim('game/players/p1', 'u1'), true);
  assert.equal(await s.claim('game/players/p1', 'u2'), false);
  assert.equal(await s.claim('game/players/p1', 'u1'), true);
  const key = s.push('chat', { t: 'hi' });
  assert.equal(latest.chat[key].t, 'hi');
  await s.remove('chat');
  assert.equal(latest.chat, undefined);
  // persisted
  const again = localStore('room1234567890abcd', st, null);
  let v2; again.subscribe((v) => { v2 = v; });
  await Promise.resolve();
  assert.equal(v2.game.players.p1, 'u1');
});

test('localStore: two tabs stay in sync through the channel', async () => {
  const bus = new Set();
  const factory = () => { const ch = { postMessage(d) { bus.forEach((o) => o !== ch && o.onmessage && o.onmessage({ data: d })); }, onmessage: null }; bus.add(ch); return ch; };
  const a = localStore('roomabcdefghijklmn', fakeStorage(), factory);
  const b = localStore('roomabcdefghijklmn', fakeStorage(), factory);
  let seen;
  b.subscribe((v) => { seen = v; });
  await a.patch({ session: { status: 'running', round: 2 } });
  assert.equal(seen.session.round, 2);
});
