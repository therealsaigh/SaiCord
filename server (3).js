const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// Set a real secret before sharing the site: export JWT_SECRET="something-long-and-random"
const SECRET = process.env.JWT_SECRET || 'onlYthErEAlsAIknOwsTHISSSSSSSSSSsS98127623654';
// The owner can post in #announcements and use @everyone anywhere. Register this username first!
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'Sai';

/* ---------- Database ---------- */
const db = new Database(path.join(__dirname, 'saicord.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  password_hash TEXT NOT NULL,
  theme TEXT,
  avatar BLOB,
  avatar_v INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friendships (
  requester INTEGER NOT NULL,
  addressee INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (requester, addressee)
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,            -- 'general' | 'dm' | 'group'
  name TEXT
);
CREATE TABLE IF NOT EXISTS members (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);

// Upgrade older databases and add the images table
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasCol('messages', 'image_id')) db.exec('ALTER TABLE messages ADD COLUMN image_id INTEGER');
if (!hasCol('users', 'bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!hasCol('messages', 'reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!hasCol('users', 'is_mod')) db.exec('ALTER TABLE users ADD COLUMN is_mod INTEGER NOT NULL DEFAULT 0');
if (!hasCol('users', 'muted_until')) db.exec('ALTER TABLE users ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0');
if (!hasCol('users', 'banned')) db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE TABLE IF NOT EXISTS pins (channel_id INTEGER NOT NULL, message_id INTEGER NOT NULL, pinned_by INTEGER NOT NULL, PRIMARY KEY (channel_id, message_id))');
db.exec('CREATE TABLE IF NOT EXISTS modlog (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, action TEXT NOT NULL, target_id INTEGER, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
if (!hasCol('users', 'display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
db.exec('CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, data BLOB NOT NULL)');

let general = db.prepare("SELECT id FROM channels WHERE type='general'").get();
if (!general) {
  general = { id: db.prepare("INSERT INTO channels (type, name) VALUES ('general', 'general')").run().lastInsertRowid };
}
const GENERAL_ID = Number(general.id);

let announcements = db.prepare("SELECT id FROM channels WHERE type='announcements'").get();
if (!announcements) {
  announcements = { id: db.prepare("INSERT INTO channels (type, name) VALUES ('announcements', 'announcements')").run().lastInsertRowid };
}
const ANNOUNCE_ID = Number(announcements.id);
db.prepare('INSERT OR IGNORE INTO members (channel_id, user_id) SELECT ?, id FROM users').run(ANNOUNCE_ID);

/* ---------- Spam protection: simple sliding-window rate limiter ---------- */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.every((t) => now - t > windowMs)) hits.delete(k);
  }, 60_000).unref();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
const authLimit = makeLimiter(10, 60_000);     // log in / sign up attempts per IP
const friendLimit = makeLimiter(10, 60_000);   // friend requests per user
const avatarLimit = makeLimiter(5, 60_000);    // profile picture changes per user
const chatLimit = makeLimiter(8, 10_000);      // sends + edits + deletes per user
const modLimit = makeLimiter(30, 60_000);       // moderation actions per user
const searchLimit = makeLimiter(20, 60_000);    // searches per user
const imageLimit = makeLimiter(6, 60_000);     // image uploads per user
const reactLimit = makeLimiter(15, 10_000);    // reaction toggles per user
const groupLimit = makeLimiter(10, 60_000);    // group renames / adds / leaves per user
const typingLimit = makeLimiter(6, 5_000);     // typing pings per user

const limit = (limiter, keyOf) => (req, res, next) =>
  limiter(keyOf(req)) ? next() : res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });

/* ---------- App + helpers ---------- */
const app = express();
app.set('trust proxy', 1); // Codespaces and most hosts sit behind a proxy
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '1.2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sign = (u) => jwt.sign({ id: Number(u.id), username: u.username }, SECRET, { expiresIn: '30d' });
const parseTheme = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const publicUser = (u) => ({ id: Number(u.id), username: u.username, theme: parseTheme(u.theme), avatarV: u.avatar_v || 0, bio: u.bio || '', displayName: u.display_name || '', isOwner: isOwner(u), ownerUsername: OWNER_USERNAME, isMod: u.is_mod === 1, mutedUntil: u.muted_until || 0 });

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const row = db.prepare('SELECT banned FROM users WHERE id = ?').get(req.user.id);
    if (!row || row.banned) throw new Error('gone');
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

const isMember = (cid, uid) => !!db.prepare('SELECT 1 FROM members WHERE channel_id = ? AND user_id = ?').get(cid, uid);
const areFriends = (a, b) => !!db.prepare(
  "SELECT 1 FROM friendships WHERE status='accepted' AND ((requester=? AND addressee=?) OR (requester=? AND addressee=?))"
).get(a, b, b, a);

const isOwner = (user) => String(user.username).toLowerCase() === OWNER_USERNAME.toLowerCase();
const channelType = (cid) => (db.prepare('SELECT type FROM channels WHERE id = ?').get(cid) || {}).type;
// In #announcements only the owner can post; everyone else can react
const canPost = (cid, user) => channelType(cid) !== 'announcements' || isOwner(user);

// Roles: 3 = owner, 2 = moderator, 1 = everyone else. Staff can only act on people ranked below them.
const userRow = (id) => db.prepare('SELECT id, username, is_mod, muted_until, banned FROM users WHERE id = ?').get(id);
const rank = (id) => { const r = userRow(id); return !r ? 0 : isOwner(r) ? 3 : r.is_mod === 1 ? 2 : 1; };
const isStaff = (id) => rank(id) >= 2;
const canModerate = (actor, target) => actor !== target && rank(actor) >= 2 && rank(actor) > rank(target);
const logAction = (actor, action, target, detail) =>
  db.prepare('INSERT INTO modlog (actor_id, action, target_id, detail) VALUES (?, ?, ?, ?)').run(actor, action, target || null, detail || null);

const FOREVER = 8.64e15; // "muted until a moderator unmutes you"
const MUTE_LABELS = { 0: 'until unmuted', 10: '10 minutes', 60: '1 hour', 1440: '1 day', 10080: '1 week' };
function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.ceil(m / 60);
  if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
  return Math.ceil(h / 24) + ' days';
}
// Empty string if the person may post, otherwise the reason to show them
function muteMessage(id) {
  const r = userRow(id);
  if (!r || r.muted_until <= Date.now()) return '';
  return r.muted_until >= FOREVER ? 'You are muted until a moderator unmutes you.' : `You are muted for another ${fmtLeft(r.muted_until - Date.now())}.`;
}

const ALLOWED_REACTIONS = ['👍', '💜', '😂', '😮', '😢', '🎉'];

// Returns Map(messageId -> [{ emoji, users: [userId, ...] }]) in the order reactions were added
function reactionsFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids);
  for (const r of rows) {
    const list = out.get(r.message_id) || [];
    let group = list.find((x) => x.emoji === r.emoji);
    if (!group) { group = { emoji: r.emoji, users: [] }; list.push(group); }
    group.users.push(r.user_id);
    out.set(r.message_id, list);
  }
  return out;
}

const notifyFriends = (...ids) => ids.forEach((i) => io.to('user:' + i).emit('friends:update'));
function joinAll(userIds, cid) {
  userIds.forEach((u) => {
    io.in('user:' + u).socketsJoin('ch:' + cid);
    io.to('user:' + u).emit('channels:update');
  });
}

/* ---------- Accounts ---------- */
app.post('/api/register', limit(authLimit, (r) => r.ip), (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  if (username.toLowerCase() === 'everyone') return res.status(400).json({ error: 'That username is reserved' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'That username is taken' });
  const id = Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, bcrypt.hashSync(password, 10)).lastInsertRowid);
  db.prepare('INSERT INTO members (channel_id, user_id) VALUES (?, ?)').run(GENERAL_ID, id);
  db.prepare('INSERT INTO members (channel_id, user_id) VALUES (?, ?)').run(ANNOUNCE_ID, id);
  io.emit('members:update');
  res.json({ token: sign({ id, username }), user: { id, username, theme: null, avatarV: 0, bio: '', displayName: '', isOwner: isOwner({ username }), ownerUsername: OWNER_USERNAME, isMod: false, mutedUntil: 0 } });
});

app.post('/api/login', limit(authLimit, (r) => r.ip), (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(400).json({ error: 'Wrong username or password' });
  if (u.banned) return res.status(403).json({ error: 'This account has been banned' });
  res.json({ token: sign(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => {
  res.json(publicUser(db.prepare('SELECT id, username, theme, avatar_v, bio, display_name, is_mod, muted_until FROM users WHERE id = ?').get(req.user.id)));
});

/* ---------- Profile picture ---------- */
// The browser crops and shrinks the image to a small JPEG before uploading.
app.put('/api/avatar', auth, limit(avatarLimit, (r) => r.user.id), (req, res) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.image) || ''));
  if (!m) return res.status(400).json({ error: 'That image could not be used' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 100 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Image is too large or not valid' });
  const v = Date.now(); // unique version so browsers fetch the new picture
  db.prepare('UPDATE users SET avatar = ?, avatar_v = ? WHERE id = ?').run(buf, v, req.user.id);
  res.json({ avatarV: v });
});

app.delete('/api/avatar', auth, (req, res) => {
  db.prepare('UPDATE users SET avatar = NULL, avatar_v = 0 WHERE id = ?').run(req.user.id);
  res.json({ avatarV: 0 });
});

app.get('/api/avatar/:id', (req, res) => {
  const r = db.prepare('SELECT avatar FROM users WHERE id = ?').get(Number(req.params.id));
  if (!r || !r.avatar) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(r.avatar);
});

/* ---------- Settings: colors and gradients ---------- */
const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of ['bg1', 'bg2', 'side1', 'side2', 'accent', 'text']) {
    if (!HEX.test(t[k] || '')) return null;
    out[k] = t[k];
  }
  for (const k of ['bgMode', 'sideMode']) {
    if (!['solid', 'gradient'].includes(t[k])) return null;
    out[k] = t[k];
  }
  for (const k of ['bgAngle', 'sideAngle']) {
    const n = Number(t[k]);
    if (!Number.isFinite(n) || n < 0 || n > 360) return null;
    out[k] = Math.round(n);
  }
  return out;
}

app.put('/api/settings', auth, (req, res) => {
  const theme = cleanTheme(req.body && req.body.theme);
  if (!theme) return res.status(400).json({ error: 'Those colors are not valid' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(theme), req.user.id);
  res.json({ theme });
});

/* ---------- Friends ---------- */
app.get('/api/friends', auth, (req, res) => {
  const me = req.user.id;
  const friends = db.prepare(`
    SELECT u.id, u.username, u.avatar_v AS avatarV, u.display_name AS displayName, u.is_mod AS isMod FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester = ? THEN f.addressee ELSE f.requester END
    WHERE f.status = 'accepted' AND (f.requester = ? OR f.addressee = ?) ORDER BY u.username`).all(me, me, me);
  const incoming = db.prepare(`SELECT u.id, u.username, u.avatar_v AS avatarV, u.display_name AS displayName, u.is_mod AS isMod FROM friendships f JOIN users u ON u.id = f.requester WHERE f.addressee = ? AND f.status = 'pending'`).all(me);
  const outgoing = db.prepare(`SELECT u.id, u.username, u.avatar_v AS avatarV, u.display_name AS displayName, u.is_mod AS isMod FROM friendships f JOIN users u ON u.id = f.addressee WHERE f.requester = ? AND f.status = 'pending'`).all(me);
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', auth, limit(friendLimit, (r) => r.user.id), (req, res) => {
  const me = req.user.id;
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  if (!target) return res.status(404).json({ error: 'No user with that name' });
  if (target.id === me) return res.status(400).json({ error: "You can't add yourself" });
  const existing = db.prepare('SELECT * FROM friendships WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)').get(me, target.id, target.id, me);
  if (existing) {
    if (existing.status === 'pending' && existing.requester === target.id) {
      db.prepare("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=?").run(target.id, me);
      notifyFriends(me, target.id);
      return res.json({ message: 'You are now friends!' });
    }
    return res.status(400).json({ error: existing.status === 'accepted' ? 'You are already friends' : 'Request already sent' });
  }
  db.prepare('INSERT INTO friendships (requester, addressee) VALUES (?, ?)').run(me, target.id);
  notifyFriends(me, target.id);
  res.json({ message: 'Friend request sent' });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const other = Number(req.body.id);
  const r = db.prepare("UPDATE friendships SET status='accepted' WHERE requester=? AND addressee=? AND status='pending'").run(other, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'No such request' });
  notifyFriends(req.user.id, other);
  res.json({ ok: true });
});

// Removes a friend, declines a request, or cancels a request you sent
app.post('/api/friends/remove', auth, (req, res) => {
  const me = req.user.id, other = Number(req.body.id);
  db.prepare('DELETE FROM friendships WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)').run(me, other, other, me);
  notifyFriends(me, other);
  res.json({ ok: true });
});

/* ---------- Channels: general, DMs, groups ---------- */
function listChannels(uid) {
  const rows = db.prepare('SELECT c.id, c.type, c.name FROM channels c JOIN members m ON m.channel_id = c.id WHERE m.user_id = ? ORDER BY c.id').all(uid);
  return rows.map((c) => {
    if (c.type === 'dm') {
      const o = db.prepare('SELECT u.id, u.username, u.display_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND u.id != ?').get(c.id, uid);
      return { ...c, name: o ? (o.display_name || o.username) : 'Unknown user', otherId: o ? o.id : null };
    }
    if (c.type === 'group') {
      const mem = db.prepare('SELECT u.username, u.display_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY u.username').all(c.id);
      c.members = mem.map((x) => x.username);
      c.memberNames = mem.map((x) => x.display_name || x.username);
    }
    return c;
  });
}
app.get('/api/channels', auth, (req, res) => res.json(listChannels(req.user.id)));

app.post('/api/dm', auth, (req, res) => {
  const me = req.user.id, other = Number(req.body.userId);
  if (!areFriends(me, other)) return res.status(403).json({ error: 'You can only message friends' });
  let ch = db.prepare(`
    SELECT c.id FROM channels c
    JOIN members a ON a.channel_id = c.id AND a.user_id = ?
    JOIN members b ON b.channel_id = c.id AND b.user_id = ?
    WHERE c.type = 'dm'`).get(me, other);
  if (!ch) {
    const id = Number(db.prepare("INSERT INTO channels (type) VALUES ('dm')").run().lastInsertRowid);
    const ins = db.prepare('INSERT INTO members (channel_id, user_id) VALUES (?, ?)');
    ins.run(id, me); ins.run(id, other);
    joinAll([me, other], id);
    ch = { id };
  }
  res.json({ id: ch.id });
});

app.post('/api/groups', auth, (req, res) => {
  const me = req.user.id;
  const name = String(req.body.name || '').trim().slice(0, 40);
  const ids = [...new Set((req.body.memberIds || []).map(Number))].filter((i) => i !== me && areFriends(me, i));
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one friend' });
  const id = Number(db.prepare("INSERT INTO channels (type, name) VALUES ('group', ?)").run(name).lastInsertRowid);
  const ins = db.prepare('INSERT INTO members (channel_id, user_id) VALUES (?, ?)');
  [me, ...ids].forEach((u) => ins.run(id, u));
  joinAll([me, ...ids], id);
  res.json({ id });
});

/* ---------- Group management: rename, add people, leave ---------- */
const isGroup = (cid) => !!db.prepare("SELECT 1 FROM channels WHERE id = ? AND type = 'group'").get(cid);
const memberIdsOf = (cid) => db.prepare('SELECT user_id FROM members WHERE channel_id = ?').all(cid).map((r) => r.user_id);
const refreshChannels = (ids) => ids.forEach((i) => io.to('user:' + i).emit('channels:update'));
const groupLimiter = limit(groupLimit, (r) => r.user.id);

app.post('/api/groups/:id/rename', auth, groupLimiter, (req, res) => {
  const cid = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  if (!isGroup(cid) || !isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, cid);
  refreshChannels(memberIdsOf(cid));
  res.json({ ok: true });
});

app.post('/api/groups/:id/members', auth, groupLimiter, (req, res) => {
  const me = req.user.id, cid = Number(req.params.id);
  if (!isGroup(cid) || !isMember(cid, me)) return res.status(403).json({ error: 'Not allowed' });
  const wanted = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(Number) : [];
  const ids = [...new Set(wanted)].filter((i) => areFriends(me, i) && !isMember(cid, i));
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one friend who is not in the group yet' });
  const existing = memberIdsOf(cid);
  const ins = db.prepare('INSERT INTO members (channel_id, user_id) VALUES (?, ?)');
  ids.forEach((u) => ins.run(cid, u));
  joinAll(ids, cid);
  refreshChannels(existing);
  res.json({ ok: true });
});

app.post('/api/groups/:id/leave', auth, groupLimiter, (req, res) => {
  const me = req.user.id, cid = Number(req.params.id);
  if (!isGroup(cid) || !isMember(cid, me)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM members WHERE channel_id = ? AND user_id = ?').run(cid, me);
  io.in('user:' + me).socketsLeave('ch:' + cid);
  const rest = memberIdsOf(cid);
  if (!rest.length) { // last person left: remove the group and its history
    db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(cid);
    db.prepare('DELETE FROM pins WHERE channel_id = ?').run(cid);
    db.prepare('DELETE FROM images WHERE channel_id = ?').run(cid);
    db.prepare('DELETE FROM messages WHERE channel_id = ?').run(cid);
    db.prepare('DELETE FROM channels WHERE id = ?').run(cid);
  }
  refreshChannels([me, ...rest]);
  res.json({ ok: true });
});

const MSG_SQL = `SELECT m.id, m.channel_id AS channelId, m.content, m.edited, m.image_id AS imageId, m.created_at AS createdAt,
                        m.reply_to AS replyTo, EXISTS(SELECT 1 FROM pins pp WHERE pp.message_id = m.id) AS pinned, r.content AS replyContent, r.image_id AS replyImageId,
                        ru.username AS replyUsername, ru.display_name AS replyDisplayName,
                        u.username, u.id AS userId, u.avatar_v AS avatarV, u.display_name AS displayName, u.is_mod AS isMod
                 FROM messages m JOIN users u ON u.id = m.user_id
                 LEFT JOIN messages r ON r.id = m.reply_to
                 LEFT JOIN users ru ON ru.id = r.user_id`;

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const cid = Number(req.params.id);
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  const around = Number(req.query.around) || 0;
  let rows;
  if (around) { // the messages surrounding one message (search results and reply jumps)
    const before = db.prepare(MSG_SQL + ' WHERE m.channel_id = ? AND m.id <= ? ORDER BY m.id DESC LIMIT 60').all(cid, around).reverse();
    const after = db.prepare(MSG_SQL + ' WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 40').all(cid, around);
    rows = [...before, ...after];
  } else {
    rows = db.prepare(MSG_SQL + ' WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 100').all(cid).reverse();
  }
  const rx = reactionsFor(rows.map((r) => r.id));
  res.json(rows.map((r) => ({ ...r, reactions: rx.get(r.id) || [] })));
});

/* ---------- Profiles, member lists and image sharing ---------- */
app.put('/api/profile', auth, limit(avatarLimit, (r) => r.user.id), (req, res) => {
  const body = req.body || {};
  const bio = String(body.bio || '').trim().slice(0, 190);
  const displayName = Array.from(String(body.displayName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 32).join('');
  db.prepare('UPDATE users SET bio = ?, display_name = ? WHERE id = ?').run(bio, displayName, req.user.id);
  // everyone refreshes their lists so the new name shows up
  io.emit('members:update');
  io.emit('friends:update');
  io.emit('channels:update');
  res.json({ bio, displayName });
});

app.get('/api/users/:id', auth, (req, res) => {
  const me = req.user.id, id = Number(req.params.id);
  const u = db.prepare('SELECT id, username, bio, display_name AS displayName, avatar_v AS avatarV, is_mod AS isMod, muted_until AS mutedUntil, banned FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (!isStaff(me)) { delete u.mutedUntil; delete u.banned; } // only staff see moderation state
  let relation = 'none';
  if (id === me) {
    relation = 'self';
  } else {
    const f = db.prepare('SELECT requester, status FROM friendships WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)').get(me, id, id, me);
    if (f) relation = f.status === 'accepted' ? 'friends' : f.requester === me ? 'outgoing' : 'incoming';
  }
  res.json({ ...u, relation });
});

app.get('/api/channels/:id/members', auth, (req, res) => {
  const cid = Number(req.params.id);
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  res.json(db.prepare('SELECT u.id, u.username, u.avatar_v AS avatarV, u.display_name AS displayName, u.is_mod AS isMod FROM members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY u.username').all(cid));
});

// The browser shrinks pictures to a JPEG before uploading. Sent as a message, with an optional caption.
app.post('/api/channels/:id/images', auth, limit(imageLimit, (r) => r.user.id), (req, res) => {
  const me = req.user.id, cid = Number(req.params.id);
  if (!isMember(cid, me)) return res.status(403).json({ error: 'Not allowed' });
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.image) || ''));
  if (!m) return res.status(400).json({ error: 'That image could not be used' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 800 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'That image is too large to share' });
  if (!canPost(cid, req.user)) return res.status(403).json({ error: `Only ${OWNER_USERNAME} can post in announcements` });
  const mutedMsg = muteMessage(me);
  if (mutedMsg) return res.status(403).json({ error: mutedMsg });
  if (!chatLimit(me)) return res.status(429).json({ error: "You're going too fast. Wait a few seconds and try again." });
  const imageId = Number(db.prepare('INSERT INTO images (channel_id, data) VALUES (?, ?)').run(cid, buf).lastInsertRowid);
  const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, image_id) VALUES (?, ?, ?, ?)').run(cid, me, cleanText(req.body.caption), imageId);
  io.to('ch:' + cid).emit('message', { ...db.prepare(MSG_SQL + ' WHERE m.id = ?').get(info.lastInsertRowid), reactions: [] });
  notifyMentions(cid, req.user, cleanText(req.body.caption), Number(info.lastInsertRowid));
  res.json({ ok: true });
});

app.get('/api/images/:id', auth, (req, res) => {
  const img = db.prepare('SELECT channel_id, data FROM images WHERE id = ?').get(Number(req.params.id));
  if (!img || !isMember(img.channel_id, req.user.id)) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(img.data);
});

app.get('/api/search', auth, limit(searchLimit, (r) => r.user.id), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' });
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const only = Number(req.query.channelId) || 0;
  const chans = new Map(listChannels(req.user.id).map((c) => [c.id, c]));
  const args = only ? [req.user.id, like, only] : [req.user.id, like];
  const rows = db.prepare(`
    SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, u.username, u.display_name AS displayName
    FROM messages m
    JOIN members mem ON mem.channel_id = m.channel_id AND mem.user_id = ?
    JOIN users u ON u.id = m.user_id
    WHERE m.content LIKE ? ESCAPE '\\' ${only ? 'AND m.channel_id = ?' : ''}
    ORDER BY m.id DESC LIMIT 30`).all(...args);
  res.json(rows.map((r) => {
    const c = chans.get(r.channelId) || {};
    return { ...r, channelName: c.name || '', channelType: c.type || '' };
  }));
});

/* ---------- Pinned messages ---------- */
// Pins in public chats are for staff; in DMs and groups any member can pin.
app.post('/api/messages/:id/pin', auth, limit(groupLimit, (r) => r.user.id), (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(id);
  if (!m || !isMember(m.channel_id, req.user.id)) return res.status(404).json({ error: 'Message not found' });
  if (['general', 'announcements'].includes(channelType(m.channel_id)) && !isStaff(req.user.id)) {
    return res.status(403).json({ error: 'Only moderators can pin messages here' });
  }
  const pinned = !!(req.body && req.body.pinned);
  if (pinned) db.prepare('INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?)').run(m.channel_id, id, req.user.id);
  else db.prepare('DELETE FROM pins WHERE message_id = ?').run(id);
  io.to('ch:' + m.channel_id).emit('message:pinned', { id, channelId: m.channel_id, pinned });
  res.json({ ok: true });
});

app.get('/api/channels/:id/pins', auth, (req, res) => {
  const cid = Number(req.params.id);
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  res.json(db.prepare(MSG_SQL + ' JOIN pins pn ON pn.message_id = m.id WHERE m.channel_id = ? ORDER BY pn.rowid DESC').all(cid));
});

/* ---------- Moderation: mute, ban, moderators, activity log ---------- */
const staffOnly = (req, res, next) => (isStaff(req.user.id) ? next() : res.status(403).json({ error: 'Moderators only' }));
const ownerOnly = (req, res, next) => (isOwner(req.user) ? next() : res.status(403).json({ error: 'Only the owner can do that' }));
const modLimiter = limit(modLimit, (r) => r.user.id);

// Picks the target person and checks the actor outranks them
function target(req, res) {
  const id = Number((req.body && req.body.userId) || 0);
  if (!userRow(id)) { res.status(404).json({ error: 'User not found' }); return 0; }
  if (!canModerate(req.user.id, id)) { res.status(403).json({ error: "You can't moderate that person" }); return 0; }
  return id;
}

app.post('/api/mod/mute', auth, staffOnly, modLimiter, (req, res) => {
  const id = target(req, res);
  if (!id) return;
  const minutes = Number(req.body.minutes);
  if (!(minutes in MUTE_LABELS)) return res.status(400).json({ error: 'Pick a mute length' });
  const until = minutes === 0 ? FOREVER : Date.now() + minutes * 60_000;
  db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(until, id);
  logAction(req.user.id, 'mute', id, MUTE_LABELS[minutes]);
  io.to('user:' + id).emit('me:update', { mutedUntil: until });
  io.to('user:' + id).emit('notice', `A moderator muted you (${MUTE_LABELS[minutes]}). You can read chats but not post.`);
  res.json({ ok: true });
});

app.post('/api/mod/unmute', auth, staffOnly, modLimiter, (req, res) => {
  const id = target(req, res);
  if (!id) return;
  db.prepare('UPDATE users SET muted_until = 0 WHERE id = ?').run(id);
  logAction(req.user.id, 'unmute', id);
  io.to('user:' + id).emit('me:update', { mutedUntil: 0 });
  res.json({ ok: true });
});

app.post('/api/mod/ban', auth, ownerOnly, modLimiter, (req, res) => {
  const id = target(req, res);
  if (!id) return;
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(id);
  logAction(req.user.id, 'ban', id);
  io.in('user:' + id).disconnectSockets(true);
  res.json({ ok: true });
});

app.post('/api/mod/unban', auth, ownerOnly, modLimiter, (req, res) => {
  const id = Number(req.body.userId || 0);
  if (!userRow(id)) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(id);
  logAction(req.user.id, 'unban', id);
  res.json({ ok: true });
});

app.post('/api/mod/role', auth, ownerOnly, modLimiter, (req, res) => {
  const id = target(req, res);
  if (!id) return;
  const mod = !!req.body.mod;
  db.prepare('UPDATE users SET is_mod = ? WHERE id = ?').run(mod ? 1 : 0, id);
  logAction(req.user.id, mod ? 'mod_add' : 'mod_remove', id);
  io.to('user:' + id).emit('me:update', { isMod: mod });
  io.emit('members:update');
  res.json({ ok: true });
});

app.get('/api/mod/overview', auth, staffOnly, (req, res) => {
  const people = (where, ...args) => db.prepare(`SELECT id, username, display_name AS displayName, muted_until AS mutedUntil FROM users WHERE ${where} ORDER BY username`).all(...args);
  const log = db.prepare(`
    SELECT l.id, l.action, l.detail, l.created_at AS createdAt,
           a.username AS actor, a.display_name AS actorName, t.username AS target, t.display_name AS targetName
    FROM modlog l JOIN users a ON a.id = l.actor_id LEFT JOIN users t ON t.id = l.target_id
    ORDER BY l.id DESC LIMIT 50`).all();
  res.json({ muted: people('muted_until > ?', Date.now()), banned: people('banned = 1'), mods: people('is_mod = 1'), log });
});

/* ---------- Realtime ---------- */
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, SECRET);
    const row = db.prepare('SELECT banned FROM users WHERE id = ?').get(socket.user.id);
    if (!row || row.banned) throw new Error('banned');
    next();
  }
  catch { next(new Error('auth')); }
});

const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,20})/g;

const EVERYONE_RE = /(^|[^A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/i;

// Tells anyone @mentioned in a message (if they are in that chat).
// @everyone notifies the whole chat, but only the owner may use it (or anyone, inside group chats).
function notifyMentions(cid, sender, content, messageId) {
  const text = String(content);
  const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(sender.id);
  const base = { channelId: cid, messageId, from: (row && row.display_name) || sender.username, preview: text.slice(0, 100) };
  const notified = new Set([sender.id]);
  if (EVERYONE_RE.test(text) && (isOwner(sender) || channelType(cid) === 'group')) {
    db.prepare('SELECT user_id FROM members WHERE channel_id = ?').all(cid).forEach((r) => {
      if (notified.has(r.user_id)) return;
      notified.add(r.user_id);
      io.to('user:' + r.user_id).emit('mention', { ...base, everyone: true });
    });
  }
  const names = [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[2].toLowerCase()))].filter((n) => n !== 'everyone').slice(0, 10);
  for (const name of names) {
    const t = db.prepare('SELECT id FROM users WHERE username = ?').get(name); // username column ignores case
    if (t && !notified.has(t.id) && isMember(cid, t.id)) {
      notified.add(t.id);
      io.to('user:' + t.id).emit('mention', base);
    }
  }
}

const online = new Map(); // userId -> number of open tabs/devices

const cleanText = (s) => String(s || '').trim().slice(0, 2000);

io.on('connection', (socket) => {
  const u = socket.user;
  socket.join('user:' + u.id);
  db.prepare('SELECT channel_id FROM members WHERE user_id = ?').all(u.id).forEach((r) => socket.join('ch:' + r.channel_id));

  // Online / offline status
  const tabs = (online.get(u.id) || 0) + 1;
  online.set(u.id, tabs);
  if (tabs === 1) io.emit('presence', { userId: u.id, online: true });
  socket.emit('presence:list', [...online.keys()]);
  socket.on('disconnect', () => {
    const left = (online.get(u.id) || 1) - 1;
    if (left <= 0) { online.delete(u.id); io.emit('presence', { userId: u.id, online: false }); }
    else online.set(u.id, left);
  });

  // Returns true (and warns the sender) if they are sending too fast
  const tooFast = () => {
    if (chatLimit(u.id)) return false;
    socket.emit('notice', "You're going too fast. Wait a few seconds and try again.");
    return true;
  };

  socket.on('message', ({ channelId, content, replyTo } = {}) => {
    const cid = Number(channelId);
    content = cleanText(content);
    if (!content || !isMember(cid, u.id)) return;
    const muted = muteMessage(u.id);
    if (muted) { socket.emit('notice', muted); return; }
    if (!canPost(cid, u)) {
      socket.emit('notice', `Only ${OWNER_USERNAME} can post in announcements. You can react to messages instead.`);
      return;
    }
    if (tooFast()) return;
    let reply = null;
    if (replyTo) {
      const target = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(Number(replyTo));
      if (target && target.channel_id === cid) reply = Number(replyTo);
    }
    const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)').run(cid, u.id, content, reply);
    io.to('ch:' + cid).emit('message', { ...db.prepare(MSG_SQL + ' WHERE m.id = ?').get(info.lastInsertRowid), reactions: [] });
    notifyMentions(cid, u, content, Number(info.lastInsertRowid));
  });

  socket.on('message:edit', ({ id, content } = {}) => {
    id = Number(id);
    content = cleanText(content);
    const m = db.prepare('SELECT channel_id, user_id FROM messages WHERE id = ?').get(id);
    if (!content || !m || m.user_id !== u.id || !isMember(m.channel_id, u.id)) return;
    const muted = muteMessage(u.id);
    if (muted) { socket.emit('notice', muted); return; }
    if (tooFast()) return;
    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content, id);
    io.to('ch:' + m.channel_id).emit('message:edited', { id, channelId: m.channel_id, content });
  });

  socket.on('message:delete', ({ id } = {}) => {
    id = Number(id);
    const m = db.prepare('SELECT channel_id, user_id, content FROM messages WHERE id = ?').get(id);
    if (!m || !isMember(m.channel_id, u.id)) return;
    const own = m.user_id === u.id;
    // Owner and moderators can delete other people's messages in public chats (never someone of equal or higher rank)
    const byStaff = !own && ['general', 'announcements'].includes(channelType(m.channel_id)) && canModerate(u.id, m.user_id);
    if ((!own && !byStaff) || tooFast()) return;
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM images WHERE id = (SELECT image_id FROM messages WHERE id = ?)').run(id);
    db.prepare('DELETE FROM pins WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    io.to('ch:' + m.channel_id).emit('message:deleted', { id, channelId: m.channel_id });
    if (byStaff) logAction(u.id, 'delete_message', m.user_id, m.content.slice(0, 80));
  });

  socket.on('reaction:toggle', ({ id, emoji } = {}) => {
    id = Number(id);
    const m = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(id);
    if (!ALLOWED_REACTIONS.includes(emoji) || !m || !isMember(m.channel_id, u.id) || !reactLimit(u.id)) return;
    const muted = muteMessage(u.id);
    if (muted) { socket.emit('notice', muted); return; }
    const has = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, u.id, emoji);
    if (has) db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(id, u.id, emoji);
    else db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(id, u.id, emoji);
    io.to('ch:' + m.channel_id).emit('reactions', { id, channelId: m.channel_id, reactions: reactionsFor([id]).get(id) || [] });
  });

  socket.on('typing', ({ channelId } = {}) => {
    const cid = Number(channelId);
    if (!typingLimit(u.id) || !isMember(cid, u.id)) return;
    const who = db.prepare('SELECT display_name FROM users WHERE id = ?').get(u.id);
    socket.to('ch:' + cid).emit('typing', { channelId: cid, userId: u.id, username: (who && who.display_name) || u.username });
  });
});

// Unexpected errors (including too-large uploads) come back as JSON so the page can show what went wrong
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 413 ? 'That upload is too large' : 'Server error: ' + err.message });
});

server.listen(PORT, () => console.log(`SaiCord running on http://localhost:${PORT}`));
