'use strict';
/*
  Masks Off: game server. No dependencies. Run with:  node server.js
  All secrets (roles, who chose whom at night) live here. Each phone only ever
  receives its own view of the game, so the host phone knows nothing extra.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const STATIC = { // only these files are served, nothing else from the folder
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icons/cloak.jpg': { file: 'icons/cloak.jpg', type: 'image/jpeg' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png' },
  '/icons/maskable-512.png': { file: 'icons/maskable-512.png', type: 'image/png' },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png' }
};
const FAST = !!process.env.MASKSOFF_FAST; // tests only: shorten the empty-night delay
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 30;
const CUR = '$'; // the money symbol. Change this one line to use a different one.

/* Death row: only in games that began with more than 15 players, only on a night when more than 12 are still in. */
const DEATH_ROW_MIN_START = 15;
const DEATH_ROW_MIN_ALIVE = 12;
const DEATH_ROW_SIZE = 4;
const ROW_CHANCE = process.env.MASKSOFF_ROWCHANCE != null ? Number(process.env.MASKSOFF_ROWCHANCE) : 0.5; // chance a night is the death row night

/* Chats */
const CHAT_KEEP = 300;       // messages kept per chat
const CHAT_SEND = 100;       // messages sent to a phone when it loads a chat
const CHAT_MAX_MEMBERS = 16; // people in one private chat, including the creator
const CHAT_MAX_OWN = 12;     // private chats one player can start

const games = new Map();

class Fail extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }
const need = (cond, msg, status) => { if (!cond) throw new Fail(msg, status); };

/* ---------- small helpers ---------- */
const rnd = n => crypto.randomInt(n);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
const uid = () => crypto.randomBytes(8).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[rnd(CODE_CHARS.length)]; if (!games.has(c)) return c; } }
const list = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const money = cents => CUR + (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
function moneyWords(cents) { // for the host's voice: "1,550 dollars and 50 cents"
  const d = Math.floor(cents / 100), c = cents % 100;
  const dw = d.toLocaleString('en-AU') + (d === 1 ? ' dollar' : ' dollars');
  if (!c) return dw;
  const cw = c + (c === 1 ? ' cent' : ' cents');
  return d ? dw + ' and ' + cw : cw;
}
const potTotal = g => g.pot.reduce((s, e) => s + e.cents, 0);
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ---------- rules ---------- */
const traitorCount = n => n <= 7 ? 1 : n <= 11 ? 2 : 3;
const alive = g => g.players.filter(p => p.alive);
const byId = (g, id) => g.players.find(p => p.id === id);
const nameOf = (g, id) => { const p = byId(g, id); return p ? p.name : 'Someone'; };

function tally(ballots, candidates) {
  const counts = {};
  for (const b of ballots) if (candidates.includes(b.t)) counts[b.t] = (counts[b.t] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  return { counts, top: max ? Object.keys(counts).filter(k => counts[k] === max) : [] };
}

/* What the host says out loud. Nothing here may leak a secret. */
const T = {
  deal: () => 'The game begins. Find a private spot where no one can see your screen. When you are ready, tap your phone to see who you are, then keep a straight face.',
  day: r => r === 1
    ? 'Welcome to the round table. Among you sit the Faithful, and among you sit Traitors. Talk, accuse and defend yourselves. When the table is ready, the host will call the banishment.'
    : 'Day ' + r + ' begins. Masks are off. Study the faces around you.',
  banish: shielded => 'The time has come to choose. Vote on your phone for the player you most suspect.' +
    (shielded.length ? ' ' + list(shielded) + (shielded.length > 1 ? ' hold shields and cannot be murdered tonight.' : ' holds a shield and cannot be murdered tonight.') : ''),
  pot: (add, total) => 'The group has earned ' + moneyWords(add) + '. The pot now stands at ' + moneyWords(total) + '.',
  tie: names => 'The table is split between ' + list(names) + '. Vote again. The tied players cannot vote. The others decide.',
  noVotes: () => 'No one cast a vote. No one is banished.',
  reveal: () => 'The votes are locked. When you are ready, tap your screen and show the table who you voted for.',
  tieAnnounce: names => 'We have a tie between ' + list(names) + '.',
  banished: n => n + ' has the most votes and is banished. ' + n + ', tap your screen and show us who you really were.',
  banishedQuiet: n => n + ' has the most votes and is banished. From here on, roles stay hidden.',
  banishedChance: n => 'Still split. Fate decides, and ' + n + ' is banished. ' + n + ', tap your screen and show us who you really were.',
  banishedChanceQuiet: n => 'Still split. Fate decides, and ' + n + ' is banished. From here on, roles stay hidden.',
  role: (n, r) => n + ' was ' + (r === 'traitor' ? 'a Traitor.' : 'Faithful.'),
  night: () => 'Night falls. Everyone, put on your masks and close your eyes.',
  nightChoose: () => 'Traitors, remove your masks and choose someone to murder.',
  maskBack: () => 'Traitors, put your masks back on.',
  morningMurder: () => 'Everyone, remove your masks. There has been a murder. The murdered player is...',
  morningKill: n => 'The murdered player is ' + n + '.',
  morningNone: () => 'Everyone, remove your masks. There has been no murder tonight. What that means, you will never know.',
  morningRow: () => 'Everyone, remove your masks. There has been no murder tonight. However, four players have been put on death row.',
  morningRowNames: names => 'The players put on death row are ' + list(names) + '. The next murder will be one of them, unless a shield protects them.',
  final3: () => 'Three remain. Together you decide: end the game here, or vote one last time and take it to a final two. If you all choose to end it and a Traitor is among you, the Traitors win. If any of you votes, one of you leaves, and the last two decide the winner.',
  finalVote: () => 'One of you must leave. Vote on your phone.',
  finalReveal: () => 'Everyone has chosen. Tap your screen and show the table your choice.',
  finalEndAll: () => 'You have all chosen to end the game.',
  finalVoteOn: () => 'At least one of you chose to vote. The vote goes ahead.',
  endReveal: () => 'The game is over. Tap your screen to reveal who you really are.',
  endT: () => 'A Traitor stands at the end. The Traitors win.',
  endF: () => 'No Traitor remains. The Faithful win.',
  endX: () => 'The host has called the game. Here is the truth.'
};
const say = (g, text) => { g.narration = { id: uid(), text }; };
const go = (g, phase) => { g.phase = phase; g.seq++; };

/* ---------- game objects ---------- */
const newChannel = (id, kind) => ({ id, kind, msgs: [] });
const blankChannels = () => ({ all: newChannel('all', 'all'), traitors: newChannel('traitors', 'traitors'), dead: newChannel('dead', 'dead') });
function blankGame(code) {
  return {
    code, created: Date.now(), updated: Date.now(), hostId: null, players: [],
    phase: 'lobby', seq: 0, round: 0, narration: null, ch: blankChannels(), cn: 0,
    shields: [], pot: [], deathRow: null, votes: {}, candidates: null, rev: 0, final: false, queue: null, ballots: null, revealed: null,
    tally: null, lastEvent: null, night: null, finalChoices: {}, banishCount: 0, startN: 0, recruitFlag: false,
    endsAt: null, winner: null, tieIds: null, autoAt: null, finalRevealed: null, finalOutcome: null, endReveal: null, clients: new Set(), pending: null
  };
}
function makeGame() {
  const g = blankGame(newCode());
  games.set(g.code, g);
  return g;
}
const PHOTO_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/;
function cleanPhoto(raw) { // a small JPEG sent as a data URL, or nothing
  if (typeof raw !== 'string' || raw.length > 90000) return null;
  const m = PHOTO_RE.exec(raw);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 8 && buf[0] === 0xff && buf[1] === 0xd8 ? m[1] : null; // must really be a JPEG
}
function addPlayer(g, rawName, rawPhoto) {
  const base = cleanText(rawName, 16);
  need(base, 'Enter a nickname.');
  let name = base, i = 2;
  while (g.players.some(p => p.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 13) + ' ' + (i++);
  const p = { id: uid(), token: crypto.randomBytes(16).toString('hex'), name, photo: cleanPhoto(rawPhoto), role: null, alive: true, deathHow: null, roleShown: false, ready: false, lastChat: 0 };
  g.players.push(p);
  return p;
}

/* ---------- chats ----------
   Three built-in chats plus any private chats (direct messages and groups) players start.
   all      everyone in the game reads it, living players post
   traitors only Traitors read it, living Traitors post (a recruit joins when they accept)
   dead     only banished and murdered players read and post
   private  only its members read it. It is a "living" chat or a "dead" chat, fixed when it is made:
            you can post in a living chat while you are alive, and in a dead chat while you are dead. */
function canRead(p, c) {
  if (c.kind === 'all') return true;
  if (c.kind === 'traitors') return p.role === 'traitor';
  if (c.kind === 'dead') return !p.alive;
  return c.members.includes(p.id);
}
function canPost(p, c) {
  if (!canRead(p, c)) return false;
  if (c.kind === 'all') return p.alive;
  if (c.kind === 'traitors') return p.alive && p.role === 'traitor';
  if (c.kind === 'dead') return !p.alive;
  return p.alive; // the dead only post in the dead chat
}
function addMsg(g, c, msg) {
  const m = Object.assign({ n: ++g.cn, ts: Date.now() }, msg);
  c.msgs.push(m);
  if (c.msgs.length > CHAT_KEEP) c.msgs.splice(0, c.msgs.length - CHAT_KEEP);
  for (const cl of Array.from(g.clients)) { // live delivery, only to people who may read this chat
    const p = byId(g, cl.pid);
    if (!p || !canRead(p, c)) continue;
    try { cl.res.write('event: msg\ndata: ' + JSON.stringify({ cid: c.id, m }) + '\n\n'); } catch (e) { g.clients.delete(cl); }
  }
  return m;
}
function chatShape(c) {
  const o = { id: c.id, kind: c.kind, msgs: c.msgs.slice(-CHAT_SEND) };
  if (c.kind === 'private') { o.name = c.name || null; o.side = c.side; o.members = c.members.slice(); o.creator = c.creator; }
  return o;
}
const chatsFor = (g, p) => Object.values(g.ch).filter(c => canRead(p, c)).map(chatShape);

function chatSend(g, p, b) {
  const text = cleanText(b.text, 300);
  need(text, 'Type a message first.');
  const c = g.ch[String(b.cid || b.channel || 'all')];
  need(c && canRead(p, c), 'That chat does not exist.');
  need(canPost(p, c), c.kind === 'all' ? 'Banished and murdered players can read this chat but not post.'
    : c.kind === 'traitors' ? 'Only living Traitors can post here.'
    : c.kind === 'dead' ? 'Only banished and murdered players can post here.'
    : 'You can read this chat but you can no longer post in it.');
  need(Date.now() - p.lastChat > 400, 'Slow down a little.');
  p.lastChat = Date.now();
  addMsg(g, c, { from: p.id, name: p.name, text });
}
/* A player who is banished or murdered is taken out of every direct and group chat. */
function leavePrivateChats(g, p) {
  for (const c of Object.values(g.ch)) {
    if (c.kind !== 'private' || !c.members.includes(p.id)) continue;
    c.members = c.members.filter(id => id !== p.id);
    if (c.members.length < 2) { delete g.ch[c.id]; continue; }
    addMsg(g, c, { sys: true, from: p.id, text: p.name + ' is out of the game and has left this chat.' });
  }
}
function newChat(g, p, b) {
  need(g.phase !== 'lobby', 'Private chats open once the game has started.');
  const ids = Array.from(new Set((Array.isArray(b.members) ? b.members : []).map(String))).filter(id => id !== p.id);
  need(ids.length >= 1, 'Pick at least one other player.');
  need(ids.length + 1 <= CHAT_MAX_MEMBERS, 'That is too many people for one chat.');
  const others = ids.map(id => byId(g, id));
  need(others.every(Boolean), 'One of those players is not in the game.');
  need(p.alive, 'Banished and murdered players can only use the dead chat.');
  need(others.every(o => o.alive), 'You can only start chats with players who are still in the game.');
  const side = 'living';
  const members = [p.id].concat(ids);
  const key = members.slice().sort().join(',');
  const name = cleanText(b.name, 24) || null;
  // the same group again just opens the chat you already have
  const same = Object.values(g.ch).find(c => c.kind === 'private' && c.side === side && c.members.slice().sort().join(',') === key && (c.name || null) === name);
  if (same) return { chat: same.id };
  need(Object.values(g.ch).filter(c => c.creator === p.id).length < CHAT_MAX_OWN, 'You have started as many chats as you can.');
  need(Date.now() - p.lastChat > 400, 'Slow down a little.');
  p.lastChat = Date.now();
  const c = { id: 'c' + uid().slice(0, 8), kind: 'private', name, side, members, creator: p.id, created: Date.now(), msgs: [] };
  g.ch[c.id] = c;
  addMsg(g, c, { sys: true, from: p.id, text: p.name + ' started this chat.' });
  return { chat: c.id };
}

/* ---------- flow ---------- */
function startGame(g) {
  const n = g.players.length, t = traitorCount(n);
  shuffle(g.players.map(p => p.id)).forEach((id, i) => { byId(g, id).role = i < t ? 'traitor' : 'faithful'; });
  g.startN = n; g.round = 0; g.banishCount = 0; g.recruitFlag = false; g.deathRow = null; g.rowDone = false;
  g.players.forEach(p => { p.ready = false; });
  go(g, 'roles'); say(g, T.deal());
}
function beginDay(g) {
  g.round += 1; g.endsAt = null; g.shields = []; g.lastEvent = null; g.tally = null; g.night = null;
  go(g, 'day'); say(g, T.day(g.round));
}
function voters(g) {
  const a = alive(g);
  if (!g.rev) return a.map(p => p.id);
  const others = a.filter(p => !g.candidates.includes(p.id));
  return (others.length ? others : a).map(p => p.id);
}
function callBanish(g) {
  g.candidates = alive(g).map(p => p.id); g.rev = 0; g.final = false; g.votes = {}; g.queue = null; g.ballots = null; g.revealed = null; g.endsAt = null;
  go(g, 'banish'); say(g, T.banish(g.shields.map(id => nameOf(g, id))));
}
function castVote(g, p, target) {
  need(g.phase === 'banish', 'Voting is not open.');
  need(p.alive && voters(g).includes(p.id), 'You cannot vote right now.');
  need(!g.votes[p.id], 'Your vote is already locked in.');
  need(g.candidates.includes(target) && target !== p.id, 'Pick another player from the list.');
  g.votes[p.id] = target;
  if (voters(g).every(id => g.votes[id])) closeVote(g);
}
function closeVote(g) {
  const bal = Object.keys(g.votes).map(v => ({ v, t: g.votes[v] }));
  if (!bal.length) { noBanishment(g, T.noVotes(), { counts: {}, ballots: [] }); return; }
  g.ballots = bal; g.queue = shuffle(bal.map(b => b.v)); g.revealed = [];
  go(g, 'reveal'); say(g, T.reveal());
}
function revealVote(g, id) { // everyone shows their vote when they like, in any order
  need(g.phase === 'reveal', 'Not now.');
  need(g.queue.includes(id), 'You did not vote.');
  if (g.revealed.some(b => b.v === id)) return;
  g.revealed.push(g.ballots.find(b => b.v === id));
  if (g.revealed.length === g.queue.length) resolveBanish(g);
}
function startRevote(g) {
  g.rev = 1; g.candidates = g.tieIds.slice(); g.votes = {}; g.queue = null; g.ballots = null; g.revealed = null; g.autoAt = null;
  go(g, 'banish'); say(g, T.tie(g.candidates.map(id => nameOf(g, id))));
}
function noBanishment(g, text, tallyDoc) {
  g.tally = tallyDoc; g.lastEvent = { type: 'none', done: true };
  go(g, 'banished'); say(g, text);
}
function resolveBanish(g) {
  const t = tally(g.revealed, g.candidates);
  const doc = { counts: t.counts, ballots: g.revealed.slice() };
  if (t.top.length > 1) {
    if (!g.rev) { // show the tie to everyone, then the re-vote starts by itself
      g.tally = doc; g.tieIds = t.top.slice(); g.autoAt = Date.now() + (FAST ? 300 : 7000);
      go(g, 'tie'); say(g, T.tieAnnounce(t.top.map(id => nameOf(g, id)))); return;
    }
    // tied again after the re-vote: one of the tied players is chosen at random
    g.tally = doc; banishPlayer(g, t.top[rnd(t.top.length)], true); return;
  }
  if (!t.top.length) { noBanishment(g, T.noVotes(), doc); return; }
  g.tally = doc;
  banishPlayer(g, t.top[0], false);
}
function banishPlayer(g, id, byChance) {
  const p = byId(g, id), before = alive(g).length;
  p.alive = false; p.deathHow = 'banished'; leavePrivateChats(g, p);
  const show = !g.final && before > 5; // roles stay hidden once five remain
  g.banishCount += 1;
  if (p.role === 'traitor' && !g.final && g.startN > 16 && g.banishCount <= 3) g.recruitFlag = true;
  g.lastEvent = { type: 'banished', id, show, role: null, done: !show, chance: !!byChance };
  go(g, 'banished');
  say(g, byChance ? (show ? T.banishedChance(p.name) : T.banishedChanceQuiet(p.name)) : (show ? T.banished(p.name) : T.banishedQuiet(p.name)));
}
function revealRole(g) {
  const ev = g.lastEvent;
  need(g.phase === 'banished' && ev && ev.type === 'banished' && ev.show && !ev.done, 'Nothing to reveal.');
  const p = byId(g, ev.id);
  p.roleShown = true; ev.role = p.role; ev.done = true;
  say(g, T.role(p.name, p.role));
}
function nextStep(g) {
  const a = alive(g).length;
  if (g.final && a <= 2) return 'end';
  if (a === 3) return 'final3';
  if (a >= 5) return 'night';
  return 'day';
}
function proceed(g) {
  need(g.phase === 'banished' && g.lastEvent && g.lastEvent.done, 'The result is not finished yet.');
  const s = nextStep(g);
  if (s === 'end') return endGame(g, 'final');
  if (s === 'final3') return startFinal3(g);
  if (s === 'night') return startNight(g);
  return beginDay(g);
}

/* ---------- night ---------- */
const MASK_WAIT = () => FAST ? 300 : 20000;   // everyone's masks go on, then the Traitors may look
const BACK_WAIT = () => FAST ? 300 : 15000;   // the Traitors' masks go back on before the table looks up
const rowAlive = g => g.deathRow ? g.deathRow.ids.filter(id => { const x = byId(g, id); return x && x.alive; }) : [];
function startNight(g) {
  const A = alive(g);
  const tr = A.filter(p => p.role === 'traitor').map(p => p.id);
  const recruitAllowed = tr.length > 0 && ((tr.length === 1 && A.length > 7) || g.recruitFlag);
  if (g.deathRow && rowAlive(g).length === 0) g.deathRow = null; // everyone on it has since been banished
  const usedRow = !!g.deathRow;
  const rowIds = usedRow ? rowAlive(g) : null; // when a death row is in force, murder can only come from it
  // on a random night (and never while a death row is waiting to be used) the Traitors pick the death row instead of murdering
  const kind = (!usedRow && !g.rowDone && tr.length > 0 && g.startN > DEATH_ROW_MIN_START && A.length > DEATH_ROW_MIN_ALIVE && rnd(100) < Math.round(ROW_CHANCE * 100)) ? 'row' : 'murder';
  // shields protect from murder only: shielded players cannot be chosen as a murder target
  const murderable = A.filter(p => p.role !== 'traitor' && !g.shields.includes(p.id) && (!rowIds || rowIds.includes(p.id)));
  const canMurder = kind === 'row' ? true : murderable.length > 0;
  const fake = tr.length === 0 || (kind === 'murder' && !canMurder && !recruitAllowed); // nothing the Traitors can do tonight
  g.night = {
    step: 'masks', kind, usedRow, rowIds, traitors: tr, picks: {}, locks: {}, decision: null,
    recruitAllowed, canMurder, fake, nextAt: Date.now() + MASK_WAIT() + (fake ? (FAST ? 0 : 5000 + rnd(10000)) : 0)
  };
  g.recruitFlag = false;
  go(g, 'night'); say(g, T.night());
}
/* timed steps of the night; called every second */
function tickNight(g) {
  const n = g.night;
  if (g.phase !== 'night' || !n || !n.nextAt || Date.now() < n.nextAt) return false;
  n.nextAt = null;
  if (n.fake) { finishNight(g); return true; }
  if (n.step === 'masks') { n.step = 'choose'; g.seq++; say(g, T.nightChoose()); return true; }
  if (n.step === 'maskBack') {
    if (n.decision.action === 'recruit') { n.step = 'recruit'; g.seq++; return true; }
    finishNight(g); return true;
  }
  return false;
}
const pickKey = x => JSON.stringify([x.action, x.target || null, x.targets || null]);
function nightPick(g, p, b) {
  const n = g.night;
  need(g.phase === 'night' && n && n.step === 'choose' && !n.fake, 'Not now.');
  need(n.traitors.includes(p.id), 'Only the Traitors choose.');
  need(b.action === 'murder' || b.action === 'recruit' || b.action === 'row', 'Choose what to do tonight.');
  if (b.action === 'row') {
    need(n.kind === 'row', 'There is no death row to set tonight.');
    const ids = Array.from(new Set((Array.isArray(b.targets) ? b.targets : []).map(String)));
    need(ids.length <= DEATH_ROW_SIZE, 'Choose exactly ' + DEATH_ROW_SIZE + ' players for death row.');
    need(ids.every(id => { const t = byId(g, id); return t && t.alive; }), 'Only living players can be put on death row.');
    n.picks[p.id] = { action: 'row', targets: ids.slice().sort() };
  } else {
    if (b.action === 'recruit') need(n.recruitAllowed, 'Recruiting is not available tonight.');
    if (b.action === 'murder') need(n.kind === 'murder', 'Tonight you choose the death row, not a murder.');
    const t = byId(g, b.target);
    need(t && t.alive && t.role !== 'traitor', 'Pick a player who is not a Traitor.');
    if (b.action === 'murder') {
      need(!g.shields.includes(t.id), 'That player holds a shield and cannot be murdered.');
      need(!n.rowIds || n.rowIds.includes(t.id), 'Only a player on death row can be murdered tonight.');
    }
    n.picks[p.id] = { action: b.action, target: t.id };
  }
  n.locks = {}; // any change means the Traitors must agree again
}
const agreed = n => {
  const all = n.traitors.map(id => n.picks[id]);
  if (!all.every(Boolean) || !all.every(x => pickKey(x) === pickKey(all[0]))) return null;
  if (all[0].action === 'row' && all[0].targets.length !== DEATH_ROW_SIZE) return null;
  return all[0];
};
function nightLock(g, p) {
  const n = g.night;
  need(g.phase === 'night' && n && n.step === 'choose' && !n.fake && n.traitors.includes(p.id), 'Not now.');
  const d = agreed(n);
  need(d, 'You can only lock in once every Traitor has picked the same thing.');
  n.locks[p.id] = true;
  if (n.traitors.every(id => n.locks[id])) {
    n.decision = Object.assign({}, d); n.step = 'maskBack'; n.nextAt = Date.now() + BACK_WAIT();
    g.seq++; say(g, T.maskBack());
  }
}
function recruitReply(g, p, accept) {
  const n = g.night;
  need(g.phase === 'night' && n && n.step === 'recruit' && n.decision.target === p.id, 'Not now.');
  if (accept) {
    p.role = 'traitor';
    addMsg(g, g.ch.traitors, { sys: true, text: p.name + ' has joined the Traitors.' });
  }
  n.decision = { action: 'recruit', target: p.id, done: true };
  finishNight(g);
}
function finishNight(g) {
  const n = g.night, d = n && n.decision;
  let murdered = null, row = null;
  if (d && d.action === 'murder') murdered = byId(g, d.target); // dies when the host reveals it
  if (n && n.usedRow) g.deathRow = null; // the death row is spent after the night it applies to
  if (d && d.action === 'row') { g.deathRow = { ids: d.targets.slice(), round: g.round }; g.rowDone = true; /* only once per game */ row = g.deathRow.ids; }
  g.lastEvent = murdered ? { type: 'murdered', id: murdered.id, revealed: false } : row ? { type: 'deathrow', ids: row.slice(), revealed: false } : { type: 'none' };
  g.night = null; g.shields = [];
  go(g, 'morning');
  say(g, murdered ? T.morningMurder() : row ? T.morningRow() : T.morningNone());
}
const pendingReveal = g => g.phase === 'morning' && g.lastEvent && (g.lastEvent.type === 'murdered' || g.lastEvent.type === 'deathrow') && !g.lastEvent.revealed;
function revealMurder(g) { // the host taps: the murder victim, or the death row, appears on every phone
  need(pendingReveal(g), 'Not now.');
  const ev = g.lastEvent;
  if (ev.type === 'deathrow') { ev.revealed = true; say(g, T.morningRowNames(ev.ids.map(id => nameOf(g, id)))); return; }
  const k = byId(g, ev.id);
  k.alive = false; k.deathHow = 'murdered'; leavePrivateChats(g, k);
  ev.revealed = true;
  say(g, T.morningKill(k.name));
}

/* ---------- final stages ---------- */
function startFinal3(g) {
  g.finalChoices = {};
  go(g, 'final3'); say(g, T.final3());
}
function finalChoice(g, p, choice) {
  need(g.phase === 'final3' && p.alive, 'Not now.');
  need(choice === 'end' || choice === 'vote', 'Choose to end the game or to vote.');
  need(!g.finalChoices[p.id], 'Your choice is already locked in.');
  g.finalChoices[p.id] = choice;
  const a = alive(g);
  if (!a.every(x => g.finalChoices[x.id])) return;
  g.finalRevealed = [];
  go(g, 'finalreveal'); say(g, T.finalReveal());
}
function revealFinal(g, id) { // each of the three shows their choice, in any order
  need(g.phase === 'finalreveal', 'Not now.');
  need(g.finalChoices[id], 'You did not choose.');
  if (g.finalRevealed.includes(id)) return;
  g.finalRevealed.push(id);
  const a = alive(g);
  if (!a.every(x => g.finalRevealed.includes(x.id))) return;
  g.finalOutcome = a.every(x => g.finalChoices[x.id] === 'end') ? 'end' : 'vote';
  g.autoAt = Date.now() + (FAST ? 300 : 6000);
  go(g, 'finalresult'); say(g, g.finalOutcome === 'end' ? T.finalEndAll() : T.finalVoteOn());
}
function afterFinalResult(g) {
  g.autoAt = null;
  if (g.finalOutcome === 'end') return endGame(g, 'agreed');
  const a = alive(g);
  g.final = true; g.rev = 0; g.candidates = a.map(x => x.id); g.votes = {}; g.shields = [];
  g.queue = null; g.ballots = null; g.revealed = null;
  go(g, 'banish'); say(g, T.finalVote());
}
function endGame(g, reason) {
  g.night = null; g.endsAt = null;
  if (reason === 'host') { g.winner = null; go(g, 'ended'); say(g, T.endX()); return; }
  // the players still standing show who they are, then the winner is announced
  const a = alive(g);
  g.endReveal = { ids: a.map(p => p.id), done: [], winner: a.some(p => p.role === 'traitor') ? 'traitors' : 'faithful' };
  go(g, 'endreveal'); say(g, T.endReveal());
}
function revealEnd(g, id) {
  need(g.phase === 'endreveal' && g.endReveal.ids.includes(id), 'Not now.');
  if (g.endReveal.done.includes(id)) return;
  g.endReveal.done.push(id); byId(g, id).roleShown = true;
  if (g.endReveal.done.length < g.endReveal.ids.length) return;
  g.winner = g.endReveal.winner;
  go(g, 'ended');
  say(g, g.winner === 'traitors' ? T.endT() : T.endF());
}

/* ---------- actions ---------- */
function act(g, p, b) {
  const hostOnly = () => need(p.id === g.hostId, 'Only the host can do that.', 403);
  switch (b.type) {
    case 'start':
      hostOnly(); need(g.phase === 'lobby', 'The game has already started.');
      need(g.players.length >= MIN_PLAYERS, 'You need at least ' + MIN_PLAYERS + ' players.');
      return startGame(g);
    case 'kick': {
      hostOnly(); need(g.phase === 'lobby', 'Only in the lobby.');
      const t = byId(g, b.id); need(t && t.id !== g.hostId, 'You cannot remove that player.');
      g.players = g.players.filter(x => x !== t); dropClients(g, t.id); return;
    }
    case 'ready': need(g.phase === 'roles', 'Not now.'); p.ready = true; return;
    case 'beginDay':
      hostOnly(); need(g.phase === 'roles' || g.phase === 'morning', 'Not now.');
      need(!pendingReveal(g), 'Reveal the murder first.'); return beginDay(g);
    case 'setShields': {
      hostOnly(); need(g.phase === 'day', 'Shields are set during the day, before the banishment.');
      const ids = Array.isArray(b.ids) ? Array.from(new Set(b.ids)) : [];
      need(ids.every(id => { const x = byId(g, id); return x && x.alive; }), 'Only living players can hold a shield.');
      g.shields = ids; return;
    }
    case 'addPot': {
      hostOnly(); need(g.phase === 'day', 'Enter earnings during the day, before the banishment.');
      const a = Number(b.amount);
      need(Number.isFinite(a) && a > 0 && a <= 1000000, 'Enter an amount above zero.');
      const cents = Math.round(a * 100);
      g.pot.push({ round: g.round, cents }); say(g, T.pot(cents, potTotal(g))); return;
    }
    case 'undoPot': hostOnly(); need(g.pot.length > 0, 'There is nothing to undo.'); g.pot.pop(); return;
    case 'callBanish': hostOnly(); need(g.phase === 'day', 'Not now.'); return callBanish(g);
    case 'vote': return castVote(g, p, b.target);
    case 'closeVote':
      hostOnly(); need(g.phase === 'banish', 'Not now.'); need(Object.keys(g.votes).length > 0, 'No votes have been cast yet.');
      return closeVote(g);
    case 'revealVote': return revealVote(g, p.id);
    case 'revealFor': {
      hostOnly(); need(g.phase === 'reveal', 'Not now.');
      const nx = b.id || g.queue.find(id => !g.revealed.some(x => x.v === id)); return nx && revealVote(g, nx);
    }
    case 'revealFinal': return revealFinal(g, p.id);
    case 'revealFinalFor': {
      hostOnly(); need(g.phase === 'finalreveal', 'Not now.');
      const nx = alive(g).map(x => x.id).find(id => !g.finalRevealed.includes(id)); return nx && revealFinal(g, nx);
    }
    case 'revealEnd': return revealEnd(g, p.id);
    case 'revealEndFor': {
      hostOnly(); need(g.phase === 'endreveal', 'Not now.');
      const nx = g.endReveal.ids.find(id => !g.endReveal.done.includes(id)); return nx && revealEnd(g, nx);
    }
    case 'revealRole':
      need(g.lastEvent && g.lastEvent.id === p.id, 'Only the banished player can do that.'); return revealRole(g);
    case 'revealRoleFor': hostOnly(); return revealRole(g);
    case 'next': hostOnly(); return proceed(g);
    case 'nightPick': return nightPick(g, p, b);
    case 'nightLock': return nightLock(g, p);
    case 'revealMurder': hostOnly(); return revealMurder(g);
    case 'recruitReply': return recruitReply(g, p, !!b.accept);
    case 'forceMorning': hostOnly(); need(g.phase === 'night', 'Not now.'); return finishNight(g);
    case 'finalChoice': return finalChoice(g, p, b.choice);
    case 'endEarly': hostOnly(); need(g.phase !== 'lobby' && g.phase !== 'ended', 'Not now.'); return endGame(g, 'host');
    case 'chat': return chatSend(g, p, b);
    case 'newChat': return newChat(g, p, b);
    default: throw new Fail('Unknown action.');
  }
}

/* ---------- what each phone is allowed to see ---------- */
function view(g, me) {
  const ended = g.phase === 'ended', isT = me.role === 'traitor';
  const row = pendingReveal(g) ? [] : rowAlive(g);
  const v = {
    code: g.code, phase: g.phase, pk: g.seq, round: g.round,
    you: { id: me.id, name: me.name, role: me.role, alive: me.alive, host: me.id === g.hostId, deathHow: me.deathHow },
    players: g.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, host: p.id === g.hostId, shield: g.shields.includes(p.id), row: row.includes(p.id),
      deathHow: p.deathHow, pic: p.photo ? 1 : 0, role: (ended || p.roleShown) ? p.role : null, ready: p.ready
    })),
    narration: g.narration, endsAt: null, winner: g.winner, startN: g.startN,
    traitorTotal: traitorCount(g.players.length),
    mates: isT ? g.players.filter(p => p.role === 'traitor').map(p => p.id) : null,
    deathRow: row,
    chatPost: {}, // the chats this phone may read, and whether it may post in each
    pot: { total: potTotal(g), entries: g.pot.slice(-30) },
    next: nextStep(g), event: null, tally: null
  };
  for (const c of Object.values(g.ch)) if (canRead(me, c)) v.chatPost[c.id] = canPost(me, c);
  if (g.phase === 'banish') {
    v.ban = { candidates: g.candidates, rev: g.rev, final: g.final, voters: voters(g), voted: Object.keys(g.votes), myVote: g.votes[me.id] || null };
    if (g.rev) v.tally = g.tally;
  }
  if (g.phase === 'reveal') {
    const mine = g.ballots.find(b => b.v === me.id);
    v.rv = { queue: g.queue, revealed: g.revealed.map(b => b.v), mine: mine ? mine.t : null };
  }
  if (g.phase === 'tie') v.tie = { ids: g.tieIds };
  if (g.phase === 'endreveal') v.er = { ids: g.endReveal.ids, done: g.endReveal.done };
  if (g.phase === 'banished') { v.event = g.lastEvent; v.tally = g.tally; }
  if (g.phase === 'morning') v.event = pendingReveal(g) ? { type: g.lastEvent.type, revealed: false } : g.lastEvent;
  if (g.phase === 'final3' || g.phase === 'finalreveal' || g.phase === 'finalresult') {
    v.fin = { mine: g.finalChoices[me.id] || null, count: Object.keys(g.finalChoices).length, ids: alive(g).map(x => x.id),
      revealed: g.finalRevealed || [], outcome: g.phase === 'finalresult' ? g.finalOutcome : null };
  }
  if (g.phase === 'night' && g.night) {
    const n = g.night;
    v.night = { step: n.step, traitor: null, recruit: false };
    if (n.traitors.includes(me.id) && !n.fake && (n.step === 'choose' || n.step === 'maskBack' || n.step === 'recruit')) {
      v.night.traitor = {
        step: n.step, kind: n.kind, rowSize: DEATH_ROW_SIZE, rowIds: n.rowIds,
        recruitAllowed: n.recruitAllowed, canMurder: n.canMurder, needed: n.traitors.length,
        picks: n.traitors.filter(id => n.picks[id]).map(id => Object.assign({ id }, n.picks[id])),
        locks: Object.keys(n.locks), agreed: !!agreed(n), traitors: n.traitors, decision: n.decision
      };
    } else if (n.step === 'recruit' && n.decision && n.decision.target === me.id && !n.decision.done) {
      v.night.recruit = true;
    }
  }
  return v;
}

/* ---------- realtime ---------- */
function send(c, g) {
  const me = byId(g, c.pid);
  if (!me) return;
  try { c.res.write('event: state\ndata: ' + JSON.stringify(view(g, me)) + '\n\n'); } catch (e) { g.clients.delete(c); }
}
/* Games are saved to a file so a server restart does not end a game in progress. */
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'games.json');
const SAVE = !process.env.MASKSOFF_NOSAVE;
let saveTimer = null;
function saveNow() {
  if (!SAVE) return;
  try {
    const out = [];
    for (const g of games.values()) { const c = Object.assign({}, g); delete c.clients; delete c.pending; out.push(c); }
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { /* read-only disk: games stay in memory only */ }
}
function saveSoon() {
  if (!SAVE || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300);
  saveTimer.unref();
}
function loadGames() {
  if (!SAVE) return;
  try {
    for (const raw of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) {
      const g = Object.assign(blankGame(raw.code), raw); // fills in anything a game saved by an older version lacks
      if (!raw.ch) { // older save: one table chat and one Traitors chat
        g.ch = blankChannels();
        g.ch.all.msgs = raw.chat || []; g.ch.traitors.msgs = raw.tchat || [];
      }
      delete g.chat; delete g.tchat;
      g.clients = new Set(); g.pending = null;
      games.set(g.code, g);
    }
    console.log('Restored ' + games.size + ' game(s) from ' + DATA_FILE);
  } catch (e) { /* nothing saved yet */ }
}
function touch(g, quiet) {
  g.updated = Date.now();
  saveSoon();
  if (quiet || g.pending) return; // quiet: chat messages are sent on their own, the game state did not change
  g.pending = setTimeout(() => { g.pending = null; for (const c of g.clients) send(c, g); }, 15);
}
function dropClients(g, pid) {
  for (const c of Array.from(g.clients)) {
    if (c.pid !== pid) continue;
    try { c.res.write('event: gone\ndata: {}\n\n'); c.res.end(); } catch (e) { /* closed */ }
    g.clients.delete(c);
  }
}
setInterval(() => {
  for (const g of games.values()) {
    if (g.phase === 'tie' && g.autoAt && Date.now() >= g.autoAt) { startRevote(g); touch(g); }
    if (g.phase === 'finalresult' && g.autoAt && Date.now() >= g.autoAt) { afterFinalResult(g); touch(g); }
    if (tickNight(g)) touch(g);
    for (const c of g.clients) { try { c.res.write(': keepalive\n\n'); } catch (e) { g.clients.delete(c); } }
  }
}, 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    const idle = now - g.updated;
    if (idle > 6 * 3600 * 1000 || (g.phase === 'ended' && idle > 30 * 60 * 1000)) { games.delete(code); saveSoon(); }
  }
}, 5 * 60 * 1000).unref();

/* ---------- http ---------- */
function auth(code, token) {
  const g = games.get(String(code || '').toUpperCase());
  need(g, 'No game has that code.', 404);
  const p = g.players.find(x => x.token === token);
  need(p, 'You are not in this game.', 401);
  return { g, p };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 130000) { reject(new Fail('Request too large.', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Fail('Bad request.')); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'GET' && STATIC[url.pathname]) { // home-screen icon files
      const f = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', f.file)));
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, games: games.size });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const { g, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      return json(res, 200, view(g, p));
    }
    if (req.method === 'GET' && url.pathname === '/api/photo') { // a player's face, only for people in the same game
      const { g, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      const o = byId(g, url.searchParams.get('id'));
      if (!o || !o.photo) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return res.end(Buffer.from(o.photo, 'base64'));
    }
    if (req.method === 'GET' && url.pathname === '/api/chats') { // every chat this player may read, with recent messages
      const { g, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      return json(res, 200, { chats: chatsFor(g, p) });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const { g, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, pid: p.id };
      g.clients.add(c);
      req.on('close', () => g.clients.delete(c));
      return send(c, g);
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/create') {
        need(games.size < 500, 'The server is busy. Try again later.', 503);
        const g = makeGame(); const p = addPlayer(g, b.name, b.photo); g.hostId = p.id; touch(g);
        return json(res, 200, { code: g.code, token: p.token });
      }
      if (url.pathname === '/api/join') {
        const g = games.get(String(b.code || '').toUpperCase());
        need(g, 'No game has that code.', 404);
        need(g.phase === 'lobby', 'That game has already started.');
        need(g.players.length < MAX_PLAYERS, 'That game is full.');
        const p = addPlayer(g, b.name, b.photo); touch(g);
        return json(res, 200, { code: g.code, token: p.token });
      }
      if (url.pathname === '/api/leave') {
        const { g, p } = auth(b.code, b.token);
        if (g.phase === 'lobby') {
          if (p.id === g.hostId) { for (const c of Array.from(g.clients)) dropClients(g, c.pid); games.delete(g.code); saveSoon(); }
          else { g.players = g.players.filter(x => x !== p); dropClients(g, p.id); touch(g); }
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/act') {
        const { g, p } = auth(b.code, b.token);
        const out = act(g, p, b);
        touch(g, b.type === 'chat'); // a chat message does not change the game, so no one needs a fresh game state for it
        return json(res, 200, { ok: true, chat: out && out.chat });
      }
    }
    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof Fail) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server.' });
  }
});

if (require.main === module) {
  loadGames();
  const bye = () => { saveNow(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  server.listen(PORT, () => console.log('Masks Off is running on port ' + PORT));
}
module.exports = { server, traitorCount, tally };
