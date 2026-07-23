const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_DIR = process.env.DATA_DIR || __dirname;
const DATA_DIR  = path.join(BASE_DIR, 'data');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

// ── プッシュ通知（VAPID鍵） ─────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BBPXufJdi2gnNd-52QSrSsBmSeSnQu5rdwT1IhCD5ubFWvdcvPUNV_YZazyIlqyxu1UfsYpXFFxkn9GPut16zXg';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'L9tH4ZwQbp-yJjj-47K7s5RzgyOLHxtSIZGzbVoBmRE';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 設定（管理者パスワード） ──────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const d = { adminPassword: 'admin1234' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2));
    return d;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

// ── ユーザー管理 ──────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── ユーザーデータ ────────────────────────────
function getUserDataFile(userId) {
  return path.join(DATA_DIR, `user_${userId}.json`);
}
function loadUserData(userId) {
  const f = getUserDataFile(userId);
  if (!fs.existsSync(f)) {
    const init = { events: [], fixedSchedules: {}, fixedExceptions: {}, pushSubscriptions: [] };
    fs.writeFileSync(f, JSON.stringify(init, null, 2));
    return init;
  }
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (!data.fixedExceptions) data.fixedExceptions = {};
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  return data;
}
function saveUserData(userId, data) {
  fs.writeFileSync(getUserDataFile(userId), JSON.stringify(data, null, 2));
}

// ── セッション ────────────────────────────────
const sessions = {};
function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, role, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions[token]) return null;
  if (Date.now() - sessions[token].createdAt > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return null;
  }
  return sessions[token];
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'ログインが必要です' });
  req.session = s;
  next();
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  req.session = s;
  next();
}

// ── 認証API ──────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const config = loadConfig();
  if (username === 'admin' && password === config.adminPassword) {
    return res.json({ ok: true, token: createSession('admin', 'admin'), role: 'admin', name: '管理者' });
  }
  const users = loadUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    return res.json({ ok: true, token: createSession(user.id, 'user'), role: 'user', name: user.name });
  }
  res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未ログイン' });
  if (s.role === 'admin') return res.json({ ok: true, role: 'admin', name: '管理者' });
  const users = loadUsers();
  const user = users.find(u => u.id === s.userId);
  res.json({ ok: true, role: 'user', name: user ? user.name : '不明' });
});

// ── ユーザーCRUD（管理者のみ） ─────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = loadUsers();
  res.json(users.map(u => ({ id: u.id, username: u.username, name: u.name, mottoTop: u.mottoTop || '', mottoBottom: u.mottoBottom || '' })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, name, mottoTop, mottoBottom } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: '全項目を入力してください' });
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  const newUser = { id: Date.now().toString(), username, password, name, mottoTop: mottoTop || '', mottoBottom: mottoBottom || '' };
  users.push(newUser);
  saveUsers(users);
  res.json({ ok: true, user: { id: newUser.id, username, name } });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { password, name, mottoTop, mottoBottom } = req.body;
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (name) users[idx].name = name;
  if (password) users[idx].password = password;
  if (mottoTop !== undefined) users[idx].mottoTop = mottoTop;
  if (mottoBottom !== undefined) users[idx].mottoBottom = mottoBottom;
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/motto', requireAuth, (req, res) => {
  const s = req.session;
  if (s.role === 'admin') return res.json({ mottoTop: '', mottoBottom: '' });
  const users = loadUsers();
  const user = users.find(u => u.id === s.userId);
  res.json({ mottoTop: user?.mottoTop || '', mottoBottom: user?.mottoBottom || '' });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  let users = loadUsers();
  users = users.filter(u => u.id !== req.params.id);
  saveUsers(users);
  const f = getUserDataFile(req.params.id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

// ── カレンダーデータAPI ───────────────────────
app.get('/api/data', requireAuth, (req, res) => {
  res.json(loadUserData(req.session.userId));
});

app.post('/api/event', requireAuth, (req, res) => {
  const { day, endDay, ts, te, text, color, date, reminderMinutes } = req.body;
  if (!text || !date) return res.status(400).json({ error: '入力不足です' });
  const data = loadUserData(req.session.userId);
  data.events.push({
    id: Date.now(), date,
    day: parseInt(day), endDay: parseInt(endDay || day),
    ts: ts || '', te: te || '', text, color: color || 'blue',
    reminderMinutes: reminderMinutes !== undefined && reminderMinutes !== '' ? parseInt(reminderMinutes) : null,
    notified: false
  });
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.delete('/api/event/:id', requireAuth, (req, res) => {
  const data = loadUserData(req.session.userId);
  data.events = data.events.filter(e => e.id !== parseInt(req.params.id));
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.post('/api/fixed', requireAuth, (req, res) => {
  const { fixedSchedules } = req.body;
  const data = loadUserData(req.session.userId);
  data.fixedSchedules = fixedSchedules;
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.post('/api/fixed-exception', requireAuth, (req, res) => {
  const { dateKey, dowIdxKey, exception } = req.body;
  if (!dateKey || !dowIdxKey) return res.status(400).json({ error: '入力不足です' });
  const data = loadUserData(req.session.userId);
  if (!data.fixedExceptions[dateKey]) data.fixedExceptions[dateKey] = {};
  if (exception === null) {
    delete data.fixedExceptions[dateKey][dowIdxKey];
    if (Object.keys(data.fixedExceptions[dateKey]).length === 0) delete data.fixedExceptions[dateKey];
  } else {
    data.fixedExceptions[dateKey][dowIdxKey] = exception;
  }
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

// ── プッシュ通知 ──────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: '購読情報がありません' });
  const data = loadUserData(req.session.userId);
  const exists = data.pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) data.pushSubscriptions.push(subscription);
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  const data = loadUserData(req.session.userId);
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

// ── 管理者パスワード変更 ──────────────────────
app.post('/api/config/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
  const config = loadConfig();
  config.adminPassword = password;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

// ── リマインダー定期チェック（1分ごと） ───────────
function getAllUserIds() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('user_') && f.endsWith('.json'))
    .map(f => f.slice(5, -5));
}

async function checkReminders() {
  const now = new Date();
  const userIds = getAllUserIds();
  for (const userId of userIds) {
    const data = loadUserData(userId);
    if (!data.pushSubscriptions || !data.pushSubscriptions.length) continue;
    let changed = false;
    for (const ev of data.events) {
      if (ev.notified) continue;
      if (ev.reminderMinutes === null || ev.reminderMinutes === undefined) continue;
      if (!ev.ts) continue;
      const [y, m] = ev.date.split('-').map(Number);
      const eventDateTime = new Date(y, m - 1, ev.day, ...ev.ts.split(':').map(Number));
      const notifyAt = new Date(eventDateTime.getTime() - ev.reminderMinutes * 60000);
      if (now >= notifyAt && now <= eventDateTime) {
        const payload = JSON.stringify({ title: '📅 予定のお知らせ', body: `${ev.text}（${ev.ts}〜）` });
        for (const sub of data.pushSubscriptions) {
          try { await webpush.sendNotification(sub, payload); }
          catch (err) { data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint); }
        }
        ev.notified = true;
        changed = true;
      }
    }
    if (changed) saveUserData(userId, data);
  }
}

setInterval(checkReminders, 60 * 1000);

// ── 起動 ─────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('📅 月間カレンダー（マルチユーザー）稼働中 - ポート ' + PORT);
  console.log('管理者ログイン: ユーザー名 admin');
  console.log('');
});
