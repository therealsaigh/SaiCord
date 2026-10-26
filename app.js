const $ = (s) => document.querySelector(s);

/* ---------- Themes ---------- */
const mkTheme = (bg, side, accent, text) => ({
  bgMode: bg.length > 1 ? 'gradient' : 'solid', bg1: bg[0], bg2: bg[1] || bg[0], bgAngle: bg[2] ?? 160,
  sideMode: side.length > 1 ? 'gradient' : 'solid', side1: side[0], side2: side[1] || side[0], sideAngle: side[2] ?? 180,
  accent, text,
});
const PRESETS = {
  Midnight: mkTheme(['#1e2433'], ['#161b27'], '#7aa2ff', '#e8ecf5'),
  Daylight: mkTheme(['#fbfaf7'], ['#ece8df'], '#2b6cb0', '#222222'),
  Aurora: mkTheme(['#0b1f3a', '#1d6b6b', 150], ['#081528', '#0f3a44', 180], '#5eead4', '#eafaf7'),
  Sunset: mkTheme(['#3a1c4a', '#a63a50', 135], ['#230f2e', '#5a1f3a', 180], '#ffb86b', '#fff1ea'),
  Forest: mkTheme(['#14281f', '#2f5d46', 160], ['#0e1b15'], '#9be7a1', '#e6f1e8'),
};
const DEFAULT_THEME = PRESETS.Midnight;

const fillOf = (t, p) => (t[p + 'Mode'] === 'gradient' ? `linear-gradient(${t[p + 'Angle']}deg, ${t[p + '1']}, ${t[p + '2']})` : t[p + '1']);
function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111111' : '#ffffff';
}
function applyTheme(t) {
  const th = { ...DEFAULT_THEME, ...(t || {}) };
  const root = document.documentElement.style;
  root.setProperty('--bg-fill', fillOf(th, 'bg'));
  root.setProperty('--side-fill', fillOf(th, 'side'));
  root.setProperty('--accent', th.accent);
  root.setProperty('--text', th.text);
  root.setProperty('--on-accent', readableOn(th.accent));
}

/* ---------- State & helpers ---------- */
let token = localStorage.getItem('saicord_token');
let me = null;
let socket = null;
let channels = [];
let friends = { friends: [], incoming: [], outgoing: [] };
let current = 'friends';
const unread = new Set();
const onlineIds = new Set();
const mentions = new Map(); // channelId -> unread @mentions
let ownerName = '';
let replyTo = null;
let historyMode = false; // true while viewing messages around a search result

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) logout();
  if (!res.ok) throw new Error(data.error || `Something went wrong (status ${res.status})`);
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const colorFor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
};

const nameOf = (u) => u.displayName || u.username;

function avatarEl(u, size = '') {
  const d = el('div', { className: 'avatar ' + size, textContent: Array.from(nameOf(u))[0].toUpperCase() });
  d.style.background = colorFor(u.username);
  d.dataset.uid = u.id;
  d.classList.toggle('online', onlineIds.has(Number(u.id)));
  if (u.avatarV) {
    const img = el('img', { src: `/api/avatar/${u.id}?v=${u.avatarV}`, alt: '' });
    img.onerror = () => img.remove();
    d.append(img);
  }
  return d;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- Auth ---------- */
async function submitAuth(mode) {
  $('#auth-error').textContent = '';
  try {
    const d = await api('/' + mode, 'POST', { username: $('#username').value.trim(), password: $('#password').value });
    token = d.token;
    localStorage.setItem('saicord_token', token);
    await start(d.user);
  } catch (e) {
    $('#auth-error').textContent = e.message;
    toast(e.message);
    console.error(e);
  }
}
$('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); submitAuth('login'); });
$('#btn-register').addEventListener('click', () => { if ($('#auth-form').reportValidity()) submitAuth('register'); });

function logout() {
  localStorage.removeItem('saicord_token');
  token = null;
  if (socket) socket.disconnect();
  location.reload();
}
$('#btn-logout').addEventListener('click', logout);

/* ---------- Start ---------- */
function renderMe() {
  $('#me-name').textContent = nameOf(me);
  $('#me-avatar').replaceChildren(avatarEl(me, 'sm'));
}

async function start(user) {
  me = user;
  ownerName = user.ownerUsername || '';
  applyTheme(me.theme);
  $('#auth').hidden = true;
  $('#app').hidden = false;
  renderMe();

  renderStaffUI();
  socket = io({ auth: { token } });
  socket.on('message', onMessage);
  socket.on('message:edited', onEdited);
  socket.on('message:deleted', onDeleted);
  socket.on('typing', onTyping);
  socket.on('notice', toast);
  socket.on('reactions', onReactions);
  socket.on('presence', onPresence);
  socket.on('presence:list', onPresenceList);
  socket.on('members:update', loadMembers);
  socket.on('mention', onMention);
  socket.on('message:pinned', onPinned);
  socket.on('me:update', (patch) => { // role or mute changed
    Object.assign(me, patch);
    renderMe();
    renderStaffUI();
    if (typeof current === 'number') openChannel(current); else updateComposer();
  });
  socket.on('connect_error', (err) => { if (err.message === 'auth') logout(); }); // banned or logged out
  socket.on('friends:update', loadFriends);
  socket.on('channels:update', loadChannels);

  await Promise.all([loadChannels(), loadFriends()]);
  showFriends();
}

(async () => {
  if (!token) return;
  try { await start(await api('/me')); } catch (e) { console.error(e); }
})();

/* ---------- Sidebar & channels ---------- */
async function loadChannels() {
  channels = await api('/channels');
  if (typeof current === 'number') {
    const ch = channels.find((c) => c.id === current);
    if (ch) { setTitle(ch); loadMembers(); }
    else showFriends(); // you left this group
  }
  renderSidebar();
}

function renderSidebar() {
  const icons = { general: '# ', announcements: '📢 ', dm: '@ ', group: '' };
  ['general', 'dm', 'group'].forEach((type) => {
    const buttons = channels
      .filter((c) => (type === 'general' ? c.type === 'general' || c.type === 'announcements' : c.type === type))
      .sort((a, b) => (b.type === 'announcements') - (a.type === 'announcements'))
      .map((c) => {
      const b = el('button', {
        className: 'nav' + (current === c.id ? ' active' : '') + (unread.has(c.id) ? ' unread' : '') + (c.type === 'dm' && onlineIds.has(c.otherId) ? ' online' : ''),
        textContent: icons[c.type] + c.name,
      });
      if (mentions.has(c.id)) { b.classList.add('mentioned'); b.dataset.mentions = '@' + mentions.get(c.id); }
      b.onclick = () => openChannel(c.id);
      return b;
    });
    $('#list-' + type).replaceChildren(...buttons);
  });
  $('#btn-friends').classList.toggle('active', current === 'friends');
}

async function openChannel(id, around) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return;
  current = id;
  unread.delete(id);
  mentions.delete(id);
  updateTabTitle();
  $('#friends-panel').hidden = true;
  $('#chat').hidden = false;
  setTitle(ch);
  cancelReply();
  updateComposer();
  $('#messages').replaceChildren();
  renderSidebar();
  renderTyping();
  members = [];
  renderMembers();
  $('#members').classList.remove('show');
  await loadMembers();
  if (current !== id) return;
  historyMode = Boolean(around);
  try {
    const msgs = await api(`/channels/${id}/messages${around ? '?around=' + around : ''}`);
    if (current !== id) return;
    msgs.forEach(addMessage);
    const target = around && rowFor(around);
    if (target) flash(target);
    else $('#messages').scrollTop = $('#messages').scrollHeight;
  } catch { /* ignored */ }
  $('#input').focus();
}

function showFriends() {
  current = 'friends';
  $('#chat').hidden = true;
  $('#friends-panel').hidden = false;
  renderSidebar();
}
$('#btn-friends').addEventListener('click', showFriends);

/* ---------- Messages ---------- */
const rowFor = (id) => document.querySelector(`.msg[data-id="${id}"]`);

function addMessage(m) {
  const when = new Date(m.createdAt.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const head = el('div', { className: 'meta' },
    el('b', { textContent: nameOf(m), className: 'link', onclick: () => openProfile(m.userId) }),
    badgeEl(m),
    el('span', { className: 'pin-mark', textContent: '📌' }),
    el('span', { textContent: when }),
    el('span', { className: 'edited', textContent: '(edited)', hidden: !m.edited }));
  // textContent (never innerHTML) keeps messages safe from HTML injection
  const bar = el('div', { className: 'reactions' });
  const evAllowed = isOwnerUser(m) || chatType() === 'group';
  // a message row has its own id, so build the avatar from the sender's id
  const avatar = avatarEl({ id: m.userId, username: m.username, displayName: m.displayName, avatarV: m.avatarV });
  avatar.classList.add('link');
  avatar.onclick = () => openProfile(m.userId);
  const row = el('div', { className: 'msg' }, avatar,
    el('div', { className: 'body' }, head,
      quoteEl(m),
      textDiv(m.content, evAllowed),
      m.imageId ? imageEl(m.imageId) : '',
      bar));
  row.dataset.id = m.id;
  if (m.pinned) row.classList.add('pinned');
  if (wantsMe(m.content, evAllowed)) row.classList.add('mentioned');
  renderReactions(bar, m.id, m.reactions || []);

  const tools = el('div', { className: 'tools' });
  const reactBtn = el('button', { className: 'icon', textContent: 'React' });
  reactBtn.onclick = (e) => { e.stopPropagation(); openPicker(reactBtn, m.id); };
  if (canPostHere()) {
    const replyBtn = el('button', { className: 'icon', textContent: 'Reply' });
    replyBtn.onclick = () => setReply(m);
    tools.append(replyBtn);
  }
  tools.append(reactBtn);
  if (canPinHere()) {
    const pinBtn = el('button', { className: 'icon pin-btn', textContent: m.pinned ? 'Unpin' : 'Pin' });
    pinBtn.onclick = async () => {
      try { await api(`/messages/${m.id}/pin`, 'POST', { pinned: !row.classList.contains('pinned') }); } catch (e) { toast(e.message); }
    };
    tools.append(pinBtn);
  }
  if (m.userId === me.id) {
    const editBtn = el('button', { className: 'icon', textContent: 'Edit' });
    editBtn.onclick = () => startEdit(row, m.id);
    tools.append(editBtn);
  }
  if (canDeleteMessage(m)) {
    const delBtn = el('button', { className: 'icon', textContent: 'Delete' });
    delBtn.onclick = () => {
      const question = m.userId === me.id ? 'Delete this message?' : `Delete ${nameOf(m)}'s message as a moderator?`;
      if (confirm(question)) socket.emit('message:delete', { id: m.id });
    };
    tools.append(delBtn);
  }
  row.append(tools);

  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(row);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function startEdit(row, id) {
  const textEl = row.querySelector('.text');
  if (row.querySelector('.edit-input')) return;
  const input = el('input', { className: 'edit-input', value: textEl.textContent, maxLength: 2000 });
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    input.remove();
    textEl.hidden = false;
    if (save && v && v !== textEl.textContent) socket.emit('message:edit', { id, content: v });
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(false);
  textEl.hidden = true;
  textEl.after(input);
  input.focus();
}

function onMessage(m) {
  clearTyper(m.channelId, m.userId);
  if (m.channelId === current) {
    if (historyMode) { openChannel(current); return; } // jump back to the latest messages
    addMessage(m);
  } else {
    unread.add(m.channelId);
    renderSidebar();
  }
}

function onEdited({ id, content }) {
  const row = rowFor(id);
  if (!row) return;
  renderText(row.querySelector('.text'), content);
  row.querySelector('.text').hidden = false;
  row.classList.toggle('mentioned', wantsMe(content, row.querySelector('.text').dataset.ev === '1'));
  row.querySelector('.edited').hidden = false;
}

function onDeleted({ id }) {
  const row = rowFor(id);
  if (row) row.remove();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const content = $('#input').value.trim();
  if (!content || typeof current !== 'number') return;
  socket.emit('message', { channelId: current, content, replyTo: replyTo && replyTo.id });
  $('#input').value = '';
  cancelReply();
});

/* ---------- Moderation and pins ---------- */
const myRank = () => (me.isOwner ? 3 : me.isMod ? 2 : 1);
const rankOf = (u) => (isOwnerUser(u) ? 3 : u.isMod ? 2 : 1);
const isStaff = () => myRank() >= 2;
const isPublicChat = () => ['general', 'announcements'].includes(chatType());
const canDeleteMessage = (m) => m.userId === me.id || (isPublicChat() && myRank() >= 2 && myRank() > rankOf(m));
const canPinHere = () => !isPublicChat() || isStaff(); // pins in public chats are for staff

function badgeEl(u) {
  if (isOwnerUser(u)) return el('span', { className: 'badge', textContent: 'Owner' });
  return u.isMod ? el('span', { className: 'badge mod', textContent: 'Mod' }) : '';
}

function renderStaffUI() { $('#btn-mod').hidden = !isStaff(); }

function onPinned({ id, pinned }) {
  const row = rowFor(id);
  if (!row) return;
  row.classList.toggle('pinned', pinned);
  const b = row.querySelector('.pin-btn');
  if (b) b.textContent = pinned ? 'Unpin' : 'Pin';
}

$('#btn-pins').addEventListener('click', async () => {
  if (typeof current !== 'number') return;
  const box = $('#pins-list');
  box.replaceChildren(el('div', { className: 'hint', textContent: 'Loading…' }));
  $('#pins-dialog').showModal();
  try {
    const rows = await api(`/channels/${current}/pins`);
    box.replaceChildren(...(rows.length ? rows.map((m) => {
      const when = new Date(m.createdAt.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
      const r = el('div', { className: 'result' },
        el('div', { className: 'meta' }, el('b', { textContent: nameOf(m) }), el('span', { textContent: when })),
        el('div', { className: 'snippet', textContent: m.content || 'Image' }));
      r.onclick = () => { $('#pins-dialog').close(); jumpTo(m.id); };
      return r;
    }) : [el('div', { className: 'hint', textContent: 'Nothing is pinned in this chat yet.' })]));
  } catch (e) {
    box.replaceChildren(el('div', { className: 'hint', textContent: e.message }));
  }
});
$('#pins-close').addEventListener('click', () => $('#pins-dialog').close());

// Moderation panel: muted and banned people, moderators, recent actions
const LOG_TEXT = {
  delete_message: 'deleted a message by', mute: 'muted', unmute: 'unmuted', ban: 'banned', unban: 'unbanned',
  mod_add: 'made a moderator:', mod_remove: 'removed as moderator:',
};
$('#btn-mod').addEventListener('click', () => { $('#mod-dialog').showModal(); loadModPanel(); });
$('#mod-close').addEventListener('click', () => $('#mod-dialog').close());

async function loadModPanel() {
  const body = $('#mod-body');
  try {
    const d = await api('/mod/overview');
    const person = (u, detail, label, path, extra) => {
      const row = el('div', { className: 'row' },
        el('span', { className: 'who' }, el('b', { textContent: nameOf(u) }), el('small', { textContent: '@' + u.username + (detail ? ' · ' + detail : '') })));
      if (label) {
        row.append(el('button', {
          textContent: label,
          onclick: async () => {
            try { await api(path, 'POST', { userId: u.id, ...extra }); await loadModPanel(); } catch (e) { toast(e.message); }
          },
        }));
      }
      return row;
    };
    const section = (title, rows, empty) => el('div', { className: 'mod-section' }, el('h3', { textContent: title }),
      ...(rows.length ? rows : [el('div', { className: 'hint', textContent: empty })]));
    const until = (ms) => (ms >= 8e15 ? 'until unmuted' : 'until ' + new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
    body.replaceChildren(
      section('Muted', d.muted.map((u) => person(u, until(u.mutedUntil), 'Unmute', '/mod/unmute')), 'Nobody is muted.'),
      section('Banned', d.banned.map((u) => person(u, '', me.isOwner ? 'Unban' : '', '/mod/unban')), 'Nobody is banned.'),
      section('Moderators', d.mods.map((u) => person(u, '', me.isOwner ? 'Remove' : '', '/mod/role', { mod: false })), 'No moderators yet. Open someone\'s profile to add one.'),
      section('Recent actions', d.log.map((l) => {
        const when = new Date(l.createdAt.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const detail = l.detail ? ` (${l.detail})` : '';
        return el('div', { className: 'log-line', textContent: `${when} · ${l.actorName || l.actor} ${LOG_TEXT[l.action] || l.action} ${l.targetName || l.target || ''}${detail}` });
      }), 'Nothing yet.'));
  } catch (e) {
    body.replaceChildren(el('div', { className: 'hint', textContent: e.message }));
  }
}

/* ---------- Announcements, replies and search ---------- */
const chatType = () => (channels.find((c) => c.id === current) || {}).type;
const isOwnerUser = (u) => !!ownerName && u.username.toLowerCase() === ownerName.toLowerCase();
const canPostHere = () => !(chatType() === 'announcements' && !me.isOwner);
const canUseEveryone = () => me.isOwner || chatType() === 'group';

// In #announcements only the owner can write; everyone else reacts
function updateComposer() {
  const muted = (me.mutedUntil || 0) > Date.now();
  const ok = canPostHere() && !muted;
  $('#input').disabled = !ok;
  $('#composer .primary').disabled = !ok;
  $('#btn-attach').hidden = !ok;
  $('#input').placeholder = muted ? 'You are muted and cannot post right now.'
    : ok ? 'Write a message' : `Only @${ownerName} can post here. Use reactions to respond.`;
  clearTimeout(updateComposer.timer); // re-enable automatically when a mute runs out
  const left = (me.mutedUntil || 0) - Date.now();
  if (left > 0 && left < 2 ** 31 - 1) updateComposer.timer = setTimeout(updateComposer, left + 500);
}

function setReply(m) {
  replyTo = { id: m.id, name: nameOf(m), snippet: m.content ? m.content.slice(0, 60) : 'Image' };
  $('#reply-text').textContent = `Replying to ${replyTo.name}: ${replyTo.snippet}`;
  $('#reply-bar').hidden = false;
  $('#input').focus();
}
function cancelReply() {
  replyTo = null;
  $('#reply-bar').hidden = true;
}
$('#reply-cancel').addEventListener('click', cancelReply);

// The small quote shown above a reply
function quoteEl(m) {
  if (!m.replyTo) return '';
  if (!m.replyUsername) return el('div', { className: 'quote gone', textContent: 'The original message was deleted' });
  const who = nameOf({ username: m.replyUsername, displayName: m.replyDisplayName });
  const q = el('div', { className: 'quote', textContent: `↩ ${who}: ${m.replyContent ? m.replyContent.slice(0, 80) : 'Image'}` });
  q.onclick = () => jumpTo(m.replyTo);
  return q;
}

function flash(row) {
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1800);
}
function jumpTo(id) {
  const row = rowFor(id);
  if (row) flash(row);
  else openChannel(current, id); // older than what is loaded
}

const searchDialog = $('#search-dialog');
let searchTimer;

$('#btn-search').addEventListener('click', () => {
  $('#search-input').value = '';
  $('#search-results').replaceChildren();
  searchDialog.showModal();
  $('#search-input').focus();
});
$('#search-close').addEventListener('click', () => searchDialog.close());
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
$('#search-scope').addEventListener('change', runSearch);

async function runSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  const note = (text) => box.replaceChildren(el('div', { className: 'hint', textContent: text }));
  if (q.length < 2) return note('Type at least 2 letters.');
  try {
    const scope = $('#search-scope').checked && typeof current === 'number' ? `&channelId=${current}` : '';
    const rows = await api('/search?q=' + encodeURIComponent(q) + scope);
    if ($('#search-input').value.trim() !== q) return; // you kept typing
    if (!rows.length) return note('No messages found.');
    box.replaceChildren(...rows.map((r) => resultRow(r, q)));
  } catch (e) {
    note(e.message);
  }
}

function resultRow(r, q) {
  const icons = { general: '# ', announcements: '📢 ', dm: '@ ', group: '' };
  const when = new Date(r.createdAt.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const snippet = el('div', { className: 'snippet' });
  const lower = r.content.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (let k = lower.indexOf(ql); k !== -1; k = lower.indexOf(ql, i)) {
    snippet.append(r.content.slice(i, k), el('mark', { textContent: r.content.slice(k, k + q.length) }));
    i = k + q.length;
  }
  snippet.append(r.content.slice(i));
  const row = el('div', { className: 'result' },
    el('div', { className: 'meta' }, el('b', { textContent: nameOf(r) }),
      el('span', { textContent: `${icons[r.channelType] || ''}${r.channelName} · ${when}` })),
    snippet);
  row.onclick = () => { searchDialog.close(); openChannel(r.channelId, r.id); };
  return row;
}

/* ---------- Mentions and notifications ---------- */
const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,20})/g;
const mentionsMe = (content) => [...String(content).matchAll(MENTION_RE)].some((m) => m[2].toLowerCase() === me.username.toLowerCase());
const EVERYONE_RE = /(^|[^A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/i;
const wantsMe = (content, everyoneAllowed) => mentionsMe(content) || (everyoneAllowed && EVERYONE_RE.test(content));

// Fills a message's text, turning @names of people in this chat into highlighted links
function renderText(div, content) {
  div.dataset.raw = content;
  div.replaceChildren();
  let last = 0;
  for (const m of content.matchAll(MENTION_RE)) {
    const isEveryone = m[2].toLowerCase() === 'everyone';
    const user = isEveryone ? null : members.find((u) => u.username.toLowerCase() === m[2].toLowerCase());
    if (isEveryone ? div.dataset.ev !== '1' : !user) continue; // only highlight what really notifies
    const start = m.index + m[1].length;
    div.append(content.slice(last, start));
    div.append(isEveryone
      ? el('span', { className: 'mention everyone', textContent: '@everyone' })
      : el('span', {
        className: 'mention link' + (user.id === me.id ? ' me' : ''),
        textContent: '@' + m[2],
        onclick: () => openProfile(user.id),
      }));
    last = start + 1 + m[2].length;
  }
  div.append(content.slice(last));
}

function textDiv(content, everyoneAllowed) {
  const div = el('div', { className: 'text', hidden: !content });
  div.dataset.ev = everyoneAllowed ? '1' : '0';
  renderText(div, content);
  return div;
}

// When the member list arrives, re-highlight messages that were drawn before it
function rerenderTexts() {
  document.querySelectorAll('#messages .text').forEach((d) => {
    if (d.dataset.raw !== undefined && !d.parentElement.querySelector('.edit-input')) renderText(d, d.dataset.raw);
  });
}

function updateTabTitle() {
  const total = [...mentions.values()].reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) SaiCord` : 'SaiCord';
}

function onMention({ channelId, from, preview, everyone }) {
  if (channelId === current && !document.hidden) return; // you are already looking at it
  mentions.set(channelId, (mentions.get(channelId) || 0) + 1);
  renderSidebar();
  updateTabTitle();
  const ch = channels.find((c) => c.id === channelId);
  const where = !ch ? 'a chat' : ch.type === 'dm' ? 'a direct message' : ch.type === 'general' ? '# ' + ch.name : ch.name;
  toast(everyone ? `${from} mentioned everyone in ${where}` : `${from} mentioned you in ${where}`);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`${from} mentioned you`, { body: preview });
    n.onclick = () => { window.focus(); openChannel(channelId); n.close(); };
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && typeof current === 'number' && mentions.delete(current)) {
    renderSidebar();
    updateTabTitle();
  }
});

function updateNotifBtn() {
  const b = $('#notif-btn');
  if (!('Notification' in window)) { b.hidden = true; return; }
  const p = Notification.permission;
  b.textContent = p === 'granted' ? 'Desktop notifications are on' : p === 'denied' ? 'Notifications are blocked in your browser' : 'Turn on desktop notifications';
  b.disabled = p !== 'default';
}
$('#notif-btn').addEventListener('click', async () => { await Notification.requestPermission(); updateNotifBtn(); });

// Typing "@" in the message box suggests people from this chat
const pop = $('#mention-pop');
let popItems = [];
let popIndex = 0;

function hidePop() { pop.hidden = true; popItems = []; }

function renderPop() {
  pop.replaceChildren(...popItems.map((u, i) => {
    const row = el('div', { className: 'pop-item' + (i === popIndex ? ' active' : '') },
      avatarEl(u, 'sm'), el('span', { textContent: nameOf(u) }), el('small', { textContent: '@' + u.username }));
    row.onmousedown = (e) => { e.preventDefault(); pickMention(u); };
    return row;
  }));
  pop.hidden = false;
}

function updateMentionPop() {
  const input = $('#input');
  const m = /(^|\s)@([A-Za-z0-9_]*)$/.exec(input.value.slice(0, input.selectionStart));
  if (!m) return hidePop();
  const q = m[2].toLowerCase();
  popItems = members
    .filter((u) => u.id !== me.id && (u.username.toLowerCase().startsWith(q) || nameOf(u).toLowerCase().startsWith(q)))
    .slice(0, 6);
  if (canUseEveryone() && 'everyone'.startsWith(q)) popItems.unshift({ id: -1, username: 'everyone', displayName: 'Everyone (notify all)' });
  if (!popItems.length) return hidePop();
  popIndex = 0;
  renderPop();
}

function pickMention(u) {
  const input = $('#input');
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos).replace(/@[A-Za-z0-9_]*$/, '@' + u.username + ' ');
  input.value = before + input.value.slice(pos);
  input.setSelectionRange(before.length, before.length);
  hidePop();
  input.focus();
}

$('#input').addEventListener('input', updateMentionPop);
$('#input').addEventListener('blur', hidePop);
$('#input').addEventListener('keydown', (e) => {
  if (pop.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); popIndex = (popIndex + 1) % popItems.length; renderPop(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); popIndex = (popIndex - 1 + popItems.length) % popItems.length; renderPop(); }
  else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pickMention(popItems[popIndex]); }
  else if (e.key === 'Escape') hidePop();
});

/* ---------- Images ---------- */
function imageEl(id) {
  const img = el('img', { className: 'pic', alt: 'Shared image' });
  // Images are private to the chat, so fetch them with the login token
  fetch('/api/images/' + id, { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('missing'))))
    .then((blob) => { img.src = URL.createObjectURL(blob); })
    .catch(() => img.replaceWith(el('div', { className: 'hint', textContent: 'Image unavailable' })));
  img.onload = () => {
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 500) box.scrollTop = box.scrollHeight;
  };
  img.onclick = () => { $('#lightbox-img').src = img.src; $('#lightbox').showModal(); };
  return img;
}
$('#lightbox').addEventListener('click', () => $('#lightbox').close());

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That file could not be read as a picture'); });
  for (const [max, quality] of [[1280, 0.82], [1024, 0.7], [800, 0.6]]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = el('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length < 1_000_000) return url;
  }
  throw new Error('That image is too large to share');
}

$('#btn-attach').addEventListener('click', () => $('#image-file').click());
$('#image-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || typeof current !== 'number') return;
  try {
    const image = await shrinkImage(file);
    await api(`/channels/${current}/images`, 'POST', { image, caption: $('#input').value });
    $('#input').value = ''; // whatever you had typed went along as the caption
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Profiles ---------- */
async function openProfile(id) {
  try {
    renderProfile(await api('/users/' + id));
    if (!$('#profile-dialog').open) $('#profile-dialog').showModal();
  } catch (e) {
    toast(e.message);
  }
}

function renderProfile(u) {
  const actions = [];
  const btn = (label, fn, cls) => {
    const b = el('button', { textContent: label, className: cls || '' });
    b.onclick = fn;
    actions.push(b);
  };
  // run an action, then refresh friends and this profile
  const act = async (fn) => {
    try { await fn(); await loadFriends(); renderProfile(await api('/users/' + u.id)); } catch (e) { toast(e.message); }
  };
  if (u.relation === 'self') btn('Edit profile', () => { $('#profile-dialog').close(); openSettings(); }, 'primary');
  if (u.relation === 'none') btn('Add friend', () => act(() => api('/friends/request', 'POST', { username: u.username })), 'primary');
  if (u.relation === 'outgoing') btn('Cancel request', () => act(() => api('/friends/remove', 'POST', { id: u.id })));
  if (u.relation === 'incoming') {
    btn('Accept request', () => act(() => api('/friends/accept', 'POST', { id: u.id })), 'primary');
    btn('Decline', () => act(() => api('/friends/remove', 'POST', { id: u.id })));
  }
  if (u.relation === 'friends') {
    btn('Message', async () => {
      try {
        const { id } = await api('/dm', 'POST', { userId: u.id });
        $('#profile-dialog').close();
        await loadChannels();
        openChannel(id);
      } catch (e) { toast(e.message); }
    }, 'primary');
    btn('Remove friend', () => act(() => api('/friends/remove', 'POST', { id: u.id })));
  }
  btn('Close', () => $('#profile-dialog').close());

  // Moderation controls: only for staff, and only for people ranked below them
  let modTools = '';
  if (isStaff() && u.relation !== 'self' && myRank() > rankOf(u)) {
    modTools = el('div', { className: 'modtools' }, el('div', { className: 'hint', textContent: 'Moderation' }));
    const run = (fn, done) => async () => {
      try { await fn(); toast(done); renderProfile(await api('/users/' + u.id)); } catch (e) { toast(e.message); }
    };
    if (u.mutedUntil > Date.now()) {
      modTools.append(el('button', { textContent: 'Unmute', onclick: run(() => api('/mod/unmute', 'POST', { userId: u.id }), 'Unmuted') }));
    } else {
      const length = el('select', {}, ...[['10 minutes', 10], ['1 hour', 60], ['1 day', 1440], ['1 week', 10080], ['Until unmuted', 0]]
        .map(([text, value]) => el('option', { value, textContent: text })));
      modTools.append(length, el('button', {
        textContent: 'Mute',
        onclick: run(() => api('/mod/mute', 'POST', { userId: u.id, minutes: Number(length.value) }), 'Muted'),
      }));
    }
    if (me.isOwner) {
      modTools.append(el('button', {
        textContent: u.banned ? 'Unban' : 'Ban',
        onclick: () => {
          if (!u.banned && !confirm(`Ban ${nameOf(u)}? They will be signed out and unable to log in.`)) return;
          run(() => api(u.banned ? '/mod/unban' : '/mod/ban', 'POST', { userId: u.id }), u.banned ? 'Unbanned' : 'Banned')();
        },
      }));
      modTools.append(el('button', {
        textContent: u.isMod ? 'Remove moderator' : 'Make moderator',
        onclick: run(() => api('/mod/role', 'POST', { userId: u.id, mod: !u.isMod }), u.isMod ? 'Moderator removed' : 'Moderator added'),
      }));
    }
  }

  $('#profile-body').replaceChildren(
    avatarEl(u, 'big'),
    el('h2', { textContent: nameOf(u) }),
    el('div', { className: 'handle', textContent: '@' + u.username }),
    badgeEl(u),
    el('div', { className: 'status', textContent: onlineIds.has(u.id) ? 'Online' : 'Offline' }),
    el('p', { className: 'bio', textContent: u.bio || 'No bio yet.' }),
    modTools,
    el('div', { className: 'actions' }, ...actions));
}

/* ---------- Member list (online / offline) ---------- */
let members = [];

async function loadMembers() {
  if (typeof current !== 'number') return;
  const id = current;
  try {
    const list = await api(`/channels/${id}/members`);
    if (current !== id) return;
    members = list;
    renderMembers();
    rerenderTexts();
  } catch { /* ignored */ }
}

function renderMembers() {
  const on = members.filter((u) => onlineIds.has(u.id));
  const off = members.filter((u) => !onlineIds.has(u.id));
  const row = (u, isOn) => el('div', { className: 'member' + (isOn ? '' : ' offline'), onclick: () => openProfile(u.id) },
    avatarEl(u, 'sm'), el('span', { textContent: nameOf(u) }));
  $('#member-list').replaceChildren(
    el('div', { className: 'member-group', textContent: `Online (${on.length})` }), ...on.map((u) => row(u, true)),
    el('div', { className: 'member-group', textContent: `Offline (${off.length})` }), ...off.map((u) => row(u, false)));
}
$('#btn-members').addEventListener('click', () => $('#members').classList.toggle('show'));

/* ---------- Reactions ---------- */
const REACTIONS = ['👍', '💜', '😂', '😮', '😢', '🎉'];

function renderReactions(bar, id, list) {
  bar.replaceChildren(...list.map((r) => {
    const b = el('button', {
      className: 'react' + (r.users.includes(me.id) ? ' mine' : ''),
      textContent: `${r.emoji} ${r.users.length}`,
    });
    b.onclick = () => socket.emit('reaction:toggle', { id, emoji: r.emoji });
    return b;
  }));
}

function onReactions({ id, reactions }) {
  const row = rowFor(id);
  if (row) renderReactions(row.querySelector('.reactions'), id, reactions);
}

// One shared emoji picker that opens next to the React button
const picker = el('div', { id: 'picker', hidden: true });
REACTIONS.forEach((emoji) => picker.append(el('button', {
  className: 'icon',
  textContent: emoji,
  onclick: () => socket.emit('reaction:toggle', { id: picker.messageId, emoji }),
})));
document.body.append(picker);
document.addEventListener('click', () => { picker.hidden = true; });

function openPicker(anchor, id) {
  picker.messageId = id;
  picker.hidden = false;
  const r = anchor.getBoundingClientRect();
  picker.style.top = Math.max(8, r.top - picker.offsetHeight - 6) + 'px';
  picker.style.left = Math.min(window.innerWidth - picker.offsetWidth - 8, Math.max(8, r.left - 40)) + 'px';
}

/* ---------- Header title and online status ---------- */
function setTitle(ch) {
  const prefix = ch.type === 'general' ? '# ' : ch.type === 'announcements' ? '📢 ' : ch.type === 'dm' ? '@ ' : '';
  let extra = '';
  if (ch.type === 'group') extra = ' (' + (ch.memberNames || ch.members).join(', ') + ')';
  if (ch.type === 'general') extra = ` (${onlineIds.size} online)`;
  if (ch.type === 'dm' && onlineIds.has(ch.otherId)) extra = ' (online)';
  $('#chat-title').textContent = prefix + ch.name + extra;
  $('#group-tools').hidden = ch.type !== 'group';
}

function refreshPresence() {
  document.querySelectorAll('.avatar[data-uid]').forEach((a) => {
    a.classList.toggle('online', onlineIds.has(Number(a.dataset.uid)));
  });
  const ch = typeof current === 'number' && channels.find((c) => c.id === current);
  if (ch) setTitle(ch);
  renderSidebar();
  renderFriends();
  renderMembers();
}

function onPresenceList(ids) {
  onlineIds.clear();
  ids.forEach((i) => onlineIds.add(i));
  refreshPresence();
}

function onPresence({ userId, online: isOn }) {
  if (isOn) onlineIds.add(userId); else onlineIds.delete(userId);
  refreshPresence();
}

/* ---------- Typing indicator ---------- */
const typers = {}; // channelId -> { userId: { name, timer } }
let lastTypingPing = 0;

$('#input').addEventListener('input', () => {
  const now = Date.now();
  if (typeof current === 'number' && now - lastTypingPing > 2000) {
    lastTypingPing = now;
    socket.emit('typing', { channelId: current });
  }
});

function onTyping({ channelId, userId, username }) {
  const t = typers[channelId] || (typers[channelId] = {});
  if (t[userId]) clearTimeout(t[userId].timer);
  t[userId] = { name: username, timer: setTimeout(() => clearTyper(channelId, userId), 3500) };
  renderTyping();
}

function clearTyper(channelId, userId) {
  const t = typers[channelId];
  if (t && t[userId]) {
    clearTimeout(t[userId].timer);
    delete t[userId];
    renderTyping();
  }
}

function renderTyping() {
  const names = Object.values(typers[current] || {}).map((x) => x.name);
  $('#typing').textContent =
    names.length === 0 ? '' :
    names.length === 1 ? `${names[0]} is typing…` :
    names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
    'Several people are typing…';
}

/* ---------- Friends ---------- */
async function loadFriends() {
  friends = await api('/friends');
  renderFriends();
}

function renderFriends() {
  const row = (u, actions) => el('div', { className: 'row', onclick: (e) => { if (e.target.tagName !== 'BUTTON') openProfile(u.id); } }, avatarEl(u, 'sm'), el('span', { className: 'who' }, el('b', { textContent: nameOf(u) }), el('small', { textContent: '@' + u.username + ' · ' + (onlineIds.has(u.id) ? 'Online' : 'Offline') })),
    ...actions.map(([label, action, cls]) => {
      const b = el('button', { textContent: label, className: cls || '' });
      b.onclick = () => friendAction(action, u);
      return b;
    }));
  const fill = (sel, items, empty) =>
    $(sel).replaceChildren(...(items.length ? items : [el('div', { className: 'empty', textContent: empty })]));

  fill('#fr-incoming', friends.incoming.map((u) => row(u, [['Accept', 'accept', 'primary'], ['Decline', 'remove']])), 'No requests right now.');
  fill('#fr-outgoing', friends.outgoing.map((u) => row(u, [['Cancel', 'remove']])), 'You have no pending requests.');
  fill('#fr-friends', friends.friends.map((u) => row(u, [['Message', 'dm', 'primary'], ['Remove', 'remove']])), 'No friends yet. Add someone by username above.');
}

async function friendAction(action, u) {
  try {
    if (action === 'accept') await api('/friends/accept', 'POST', { id: u.id });
    if (action === 'remove') await api('/friends/remove', 'POST', { id: u.id });
    if (action === 'dm') {
      const { id } = await api('/dm', 'POST', { userId: u.id });
      await loadChannels();
      return openChannel(id);
    }
    await loadFriends();
  } catch (e) {
    $('#friend-msg').textContent = e.message;
  }
}

$('#add-friend').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/friends/request', 'POST', { username: $('#friend-name').value });
    $('#friend-msg').textContent = r.message;
    $('#friend-name').value = '';
  } catch (err) {
    $('#friend-msg').textContent = err.message;
  }
});

/* ---------- Group chats ---------- */
let groupMode = 'create'; // 'create' or 'add'

function openGroupDialog(mode) {
  groupMode = mode;
  const ch = channels.find((c) => c.id === current);
  const pool = mode === 'add' ? friends.friends.filter((u) => !ch.members.includes(u.username)) : friends.friends;
  $('#group-dialog-title').textContent = mode === 'add' ? 'Add people' : 'New group chat';
  $('#group-name-wrap').hidden = mode === 'add';
  $('#group-create').textContent = mode === 'add' ? 'Add to group' : 'Create group';
  $('#group-name').value = '';
  $('#group-error').textContent = '';
  const empty = mode === 'add' ? 'All your friends are already in this group.' : 'Add some friends first, then you can group them here.';
  $('#group-friends').replaceChildren(...(pool.length
    ? pool.map((u) => el('label', {}, el('input', { type: 'checkbox', value: u.id }), nameOf(u)))
    : [el('div', { className: 'hint', textContent: empty })]));
  $('#group-dialog').showModal();
}

$('#btn-newgroup').addEventListener('click', () => openGroupDialog('create'));
$('#group-cancel').addEventListener('click', () => $('#group-dialog').close());
$('#group-create').addEventListener('click', async () => {
  const memberIds = [...document.querySelectorAll('#group-friends input:checked')].map((i) => Number(i.value));
  try {
    if (groupMode === 'add') {
      await api(`/groups/${current}/members`, 'POST', { memberIds });
      $('#group-dialog').close();
      await loadChannels();
    } else {
      const { id } = await api('/groups', 'POST', { name: $('#group-name').value, memberIds });
      $('#group-dialog').close();
      await loadChannels();
      openChannel(id);
    }
  } catch (e) {
    $('#group-error').textContent = e.message;
  }
});

$('#btn-add-people').addEventListener('click', () => openGroupDialog('add'));

$('#btn-rename-group').addEventListener('click', async () => {
  const ch = channels.find((c) => c.id === current);
  const name = prompt('New group name', ch.name);
  if (!name || !name.trim() || name.trim() === ch.name) return;
  try {
    await api(`/groups/${current}/rename`, 'POST', { name });
    await loadChannels();
  } catch (e) { toast(e.message); }
});

$('#btn-leave-group').addEventListener('click', async () => {
  const ch = channels.find((c) => c.id === current);
  if (!confirm(`Leave "${ch.name}"? You can only rejoin if someone adds you back.`)) return;
  try {
    await api(`/groups/${current}/leave`, 'POST');
    await loadChannels();
  } catch (e) { toast(e.message); }
});

/* ---------- Settings: profile picture ---------- */
function renderAvatarPreview() {
  $('#avatar-preview').replaceChildren(avatarEl(me, 'big'));
}

$('#avatar-upload').addEventListener('click', () => $('#avatar-file').click());

$('#avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#avatar-msg').textContent = '';
  try {
    // Crop to a centered square and shrink to 160px so uploads stay tiny
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const canvas = el('canvas', { width: 160, height: 160 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 160, 160);
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 160, 160);
    const r = await api('/avatar', 'PUT', { image: canvas.toDataURL('image/jpeg', 0.85) });
    me.avatarV = r.avatarV;
    renderAvatarPreview();
    renderMe();
    $('#avatar-msg').textContent = 'Picture updated.';
  } catch (err) {
    const fromServer = err instanceof Error && !/image|decode|source/i.test(err.message);
    $('#avatar-msg').textContent = fromServer ? err.message : 'That file could not be used as a picture.';
  }
});

$('#avatar-remove').addEventListener('click', async () => {
  try {
    const r = await api('/avatar', 'DELETE');
    me.avatarV = r.avatarV;
    renderAvatarPreview();
    renderMe();
    $('#avatar-msg').textContent = 'Picture removed.';
  } catch (err) {
    $('#avatar-msg').textContent = err.message;
  }
});

/* ---------- Settings: colors and gradients ---------- */
const g = (id) => $('#' + id).value;
const readInputs = () => ({
  bgMode: g('t-bgMode'), bg1: g('t-bg1'), bg2: g('t-bg2'), bgAngle: Number(g('t-bgAngle')),
  sideMode: g('t-sideMode'), side1: g('t-side1'), side2: g('t-side2'), sideAngle: Number(g('t-sideAngle')),
  accent: g('t-accent'), text: g('t-text'),
});
function writeInputs(t) {
  Object.entries(t).forEach(([k, v]) => { $('#t-' + k).value = v; });
  syncVisibility(t);
}
function syncVisibility(t) {
  $('#t-bgGrad').hidden = t.bgMode !== 'gradient';
  $('#t-sideGrad').hidden = t.sideMode !== 'gradient';
}

(function buildThemeControls() {
  const box = $('#theme-controls');
  [['bg', 'Background'], ['side', 'Sidebar']].forEach(([p, label]) => {
    const mode = el('select', { id: `t-${p}Mode` },
      el('option', { value: 'solid', textContent: 'Solid color' }),
      el('option', { value: 'gradient', textContent: 'Gradient' }));
    const angle = el('input', { type: 'range', min: 0, max: 360, id: `t-${p}Angle` });
    box.append(el('fieldset', {},
      el('legend', { textContent: label }),
      el('label', {}, 'Style', mode),
      el('label', {}, 'Color', el('input', { type: 'color', id: `t-${p}1` })),
      el('div', { className: 'grad-row', id: `t-${p}Grad` },
        el('label', {}, 'Second color', el('input', { type: 'color', id: `t-${p}2` })),
        el('label', {}, 'Angle', angle))));
  });
  box.append(el('div', { className: 'two' },
    el('label', {}, 'Accent', el('input', { type: 'color', id: 't-accent' })),
    el('label', {}, 'Text', el('input', { type: 'color', id: 't-text' }))));
  box.addEventListener('input', () => { const t = readInputs(); syncVisibility(t); applyTheme(t); });

  $('#presets').replaceChildren(...Object.entries(PRESETS).map(([name, t]) => {
    const b = el('button', { type: 'button', textContent: name });
    b.style.background = fillOf(t, 'bg');
    b.style.color = t.text;
    b.style.borderColor = t.accent;
    b.onclick = () => { writeInputs(t); applyTheme(t); };
    return b;
  }));
})();

function openSettings() {
  writeInputs({ ...DEFAULT_THEME, ...(me.theme || {}) });
  renderAvatarPreview();
  $('#name-input').value = me.displayName || '';
  $('#bio-input').value = me.bio || '';
  $('#my-handle').textContent = '@' + me.username;
  updateNotifBtn();
  $('#avatar-msg').textContent = '';
  $('#settings-dialog').showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#bio-save').addEventListener('click', async () => {
  try {
    const r = await api('/profile', 'PUT', { displayName: $('#name-input').value, bio: $('#bio-input').value });
    me.bio = r.bio;
    me.displayName = r.displayName;
    renderMe();
    $('#avatar-msg').textContent = 'Profile saved.';
  } catch (err) {
    $('#avatar-msg').textContent = err.message;
  }
});
$('#settings-reset').addEventListener('click', () => { writeInputs(DEFAULT_THEME); applyTheme(DEFAULT_THEME); });
$('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-save').addEventListener('click', async () => {
  try {
    const { theme } = await api('/settings', 'PUT', { theme: readInputs() });
    me.theme = theme;
    $('#settings-dialog').close();
  } catch (e) {
    toast(e.message);
  }
});
// However the dialog closes (Save, Cancel, Esc), settle on the saved theme
$('#settings-dialog').addEventListener('close', () => applyTheme(me.theme));
