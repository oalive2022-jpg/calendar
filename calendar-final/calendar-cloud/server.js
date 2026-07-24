const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubhsdaahqrwohhygccpb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BBPXufJdi2gnNd-52QSrSsBmSeSnQu5rdwT1IhCD5ubFWvdcvPUNV_YZazyIlqyxu1UfsYpXFFxkn9GPut16zXg';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'L9tH4ZwQbp-yJjj-47K7s5RzgyOLHxtSIZGzbVoBmRE';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function sbRequest(method, table, body, query) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}${query || ''}`);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let chunk = '';
      res.on('data', d => chunk += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: chunk ? JSON.parse(chunk) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: chunk }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sbGet(table, query) { return sbRequest('GET', table, null, query); }
async function sbPost(table, body) { return sbRequest('POST', table, body); }
async function sbPatch(table, body, query) { return sbRequest('PATCH', table, body, query); }
async function sbDelete(table, query) { return sbRequest('DELETE', table, null, query); }
async function sbUpsert(table, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    const data = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let chunk = '';
      res.on('data', d => chunk += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: chunk ? JSON.parse(chunk) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: chunk }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getAdminPassword() {
  const r = await sbGet('config', '?key=eq.adminPassword&select=value');
  return r.data && r.data[0] ? r.data[0].value : 'admin1234';
}
async function setAdminPassword(pw) {
  await sbUpsert('config', { key: 'adminPassword', value: pw });
}

async function getUsers() {
  const r = await sbGet('users', '?select=*&order=created_at.asc');
  return r.data || [];
}
async function getUserByUsername(username) {
  const r = await sbGet('users', `?username=eq.${encodeURIComponent(username)}&select=*`);
  return r.data && r.data[0] ? r.data[0] : null;
}
async function getUserById(id) {
  const r = await sbGet('users', `?id=eq.${encodeURIComponent(id)}&select=*`);
  return r.data && r.data[0] ? r.data[0] : null;
}

async function getUserData(userId) {
  const r = await sbGet('user_data', `?user_id=eq.${encodeURIComponent(userId)}&select=*`);
  if (r.data && r.data[0]) {
    const d = r.data[0];
    return {
      events: d.events || [],
      fixedSchedules: d.fixed_schedules || {},
      fixedExceptions: d.fixed_exceptions || {},
      pushSubscriptions: d.push_subscriptions || []
    };
  }
  return { events: [], fixedSchedules: {}, fixedExceptions: {}, pushSubscriptions: [] };
}
async function saveUserData(userId, data) {
  await sbUpsert('user_data', {
    user_id: userId,
    events: data.events || [],
    fixed_schedules: data.fixedSchedules || {},
    fixed_exceptions: data.fixedExceptions || {},
    push_subscriptions: data.pushSubscriptions || [],
    updated_at: new Date().toISOString()
  });
}

const sessions = {};
function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, role, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions[token]) return null;
  if (Date.now() - sessions[token].createdAt > 24 * 60 * 60 * 1000) { delete sessions[token]; return null; }
  return sessions[token];
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'ログインが必要です' });
  req.session = s; next();
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  req.session = s; next();
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const adminPw = await getAdminPassword();
    if (username === 'admin' && password === adminPw) {
      return res.json({ ok: true, token: createSession('admin', 'admin'), role: 'admin', name: '管理者' });
    }
    const user = await getUserByUsername(username);
    if (user && user.password === password) {
      return res.json({ ok: true, token: createSession(user.id, 'user'), role: 'user', name: user.name });
    }
    res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未ログイン' });
  if (s.role === 'admin') return res.json({ ok: true, role: 'admin', name: '管理者' });
  const user = await getUserById(s.userId);
  res.json({ ok: true, role: 'user', name: user ? user.name : '不明' });
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await getUsers();
    res.json(users.map(u => ({ id: u.id, username: u.username, name: u.name, mottoTop: u.motto_top || '', mottoBottom: u.motto_bottom || '' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, name, mottoTop, mottoBottom } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: '全項目を入力してください' });
    const existing = await getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
    const id = Date.now().toString();
    await sbPost('users', { id, username, password, name, motto_top: mottoTop || '', motto_bottom: mottoBottom || '' });
    res.json({ ok: true, user: { id, username, name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const { password, name, mottoTop, mottoBottom } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (password) updates.password = password;
    if (mottoTop !== undefined) updates.motto_top = mottoTop;
    if (mottoBottom !== undefined) updates.motto_bottom = mottoBottom;
    await sbPatch('users', updates, `?id=eq.${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    await sbDelete('users', `?id=eq.${encodeURIComponent(req.params.id)}`);
    await sbDelete('user_data', `?user_id=eq.${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/motto', requireAuth, async (req, res) => {
  try {
    const s = req.session;
    if (s.role === 'admin') return res.json({ mottoTop: '', mottoBottom: '' });
    const user = await getUserById(s.userId);
    res.json({ mottoTop: user?.motto_top || '', mottoBottom: user?.motto_bottom || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data', requireAuth, async (req, res) => {
  try { res.json(await getUserData(req.session.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/event', requireAuth, async (req, res) => {
  try {
    const { day, endDay, ts, te, text, color, date, reminderMinutes } = req.body;
    if (!text || !date) return res.status(400).json({ error: '入力不足です' });
    const data = await getUserData(req.session.userId);
    data.events.push({
      id: Date.now(), date,
      day: parseInt(day), endDay: parseInt(endDay || day),
      ts: ts || '', te: te || '', text, color: color || 'blue',
      reminderMinutes: reminderMinutes !== undefined && reminderMinutes !== '' ? parseInt(reminderMinutes) : null,
      notified: false
    });
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/event/:id', requireAuth, async (req, res) => {
  try {
    const data = await getUserData(req.session.userId);
    data.events = data.events.filter(e => e.id !== parseInt(req.params.id));
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fixed', requireAuth, async (req, res) => {
  try {
    const { fixedSchedules } = req.body;
    const data = await getUserData(req.session.userId);
    data.fixedSchedules = fixedSchedules;
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fixed-exception', requireAuth, async (req, res) => {
  try {
    const { dateKey, dowIdxKey, exception } = req.body;
    if (!dateKey || !dowIdxKey) return res.status(400).json({ error: '入力不足です' });
    const data = await getUserData(req.session.userId);
    if (!data.fixedExceptions[dateKey]) data.fixedExceptions[dateKey] = {};
    if (exception === null) {
      delete data.fixedExceptions[dateKey][dowIdxKey];
      if (Object.keys(data.fixedExceptions[dateKey]).length === 0) delete data.fixedExceptions[dateKey];
    } else {
      data.fixedExceptions[dateKey][dowIdxKey] = exception;
    }
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: '購読情報がありません' });
    const data = await getUserData(req.session.userId);
    if (!data.pushSubscriptions.find(s => s.endpoint === subscription.endpoint)) {
      data.pushSubscriptions.push(subscription);
    }
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const data = await getUserData(req.session.userId);
    data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
    await saveUserData(req.session.userId, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config/password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
    await setAdminPassword(password);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function checkReminders() {
  try {
    const r = await sbGet('user_data', '?select=user_id,push_subscriptions,events');
    if (!r.data) return;
    const now = new Date();
    for (const row of r.data) {
      const subs = row.push_subscriptions || [];
      if (!subs.length) continue;
      const events = row.events || [];
      let changed = false;
      for (const ev of events) {
        if (ev.notified || ev.reminderMinutes == null || !ev.ts) continue;
        const [y, m] = ev.date.split('-').map(Number);
        const evTime = new Date(y, m - 1, ev.day, ...ev.ts.split(':').map(Number));
        const notifyAt = new Date(evTime.getTime() - ev.reminderMinutes * 60000);
        if (now >= notifyAt && now <= evTime) {
          const payload = JSON.stringify({ title: '📅 予定のお知らせ', body: `${ev.text}（${ev.ts}〜）` });
          for (const sub of subs) {
            try { await webpush.sendNotification(sub, payload); } catch (e) {}
          }
          ev.notified = true; changed = true;
        }
      }
      if (changed) {
        await sbPatch('user_data', { events, updated_at: new Date().toISOString() }, `?user_id=eq.${encodeURIComponent(row.user_id)}`);
      }
    }
  } catch (e) { console.error('Reminder check error:', e.message); }
}

setInterval(checkReminders, 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('📅 月間カレンダー（Supabase版）稼働中 - ポート ' + PORT);
  console.log('管理者ログイン: ユーザー名 admin');
  console.log('');
});
