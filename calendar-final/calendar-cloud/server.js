const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const webpush = require('web-push');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── データベース接続（Supabase / Postgres） ─────────
// Render の Environment に DATABASE_URL を設定してください
if (!process.env.DATABASE_URL) {
  console.error('⚠ DATABASE_URL が設定されていません。RenderのEnvironmentタブで設定してください。');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      id INT PRIMARY KEY DEFAULT 1,
      admin_password TEXT NOT NULL DEFAULT 'admin1234'
    );
  `);
  await pool.query(`INSERT INTO app_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      motto_top TEXT DEFAULT '',
      motto_bottom TEXT DEFAULT ''
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{"events":[],"fixedSchedules":{},"fixedExceptions":{},"pushSubscriptions":[]}'
    );
  `);
  console.log('✅ データベースの初期化を確認しました');
}

// ── プッシュ通知（VAPID鍵） ─────────────────────
// 本番では環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY を設定推奨
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BBPXufJdi2gnNd-52QSrSsBmSeSnQu5rdwT1IhCD5ubFWvdcvPUNV_YZazyIlqyxu1UfsYpXFFxkn9GPut16zXg';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'L9tH4ZwQbp-yJjj-47K7s5RzgyOLHxtSIZGzbVoBmRE';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 設定（管理者パスワード） ──────────────────
async function loadConfig() {
  const r = await pool.query('SELECT admin_password FROM app_config WHERE id = 1');
  return { adminPassword: r.rows[0]?.admin_password || 'admin1234' };
}
async function saveAdminPassword(pw) {
  await pool.query('UPDATE app_config SET admin_password = $1 WHERE id = 1', [pw]);
}

// ── ユーザー管理 ──────────────────────────────
async function loadUsers() {
  const r = await pool.query(
    'SELECT id, username, password, name, motto_top AS "mottoTop", motto_bottom AS "mottoBottom" FROM users ORDER BY name'
  );
  return r.rows;
}
async function findUserByLogin(username, password) {
  const r = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
  return r.rows[0] || null;
}
async function findUserById(id) {
  const r = await pool.query(
    'SELECT id, username, name, motto_top AS "mottoTop", motto_bottom AS "mottoBottom" FROM users WHERE id = $1',
    [id]
  );
  return r.rows[0] || null;
}
async function insertUser(u) {
  await pool.query(
    'INSERT INTO users (id, username, password, name, motto_top, motto_bottom) VALUES ($1,$2,$3,$4,$5,$6)',
    [u.id, u.username, u.password, u.name, u.mottoTop || '', u.mottoBottom || '']
  );
  await pool.query(
    `INSERT INTO user_data (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [u.id, JSON.stringify({ events: [], fixedSchedules: {}, fixedExceptions: {}, pushSubscriptions: [] })]
  );
}
async function updateUserFields(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); vals.push(fields.name); }
  if (fields.password !== undefined) { sets.push(`password = $${i++}`); vals.push(fields.password); }
  if (fields.mottoTop !== undefined) { sets.push(`motto_top = $${i++}`); vals.push(fields.mottoTop); }
  if (fields.mottoBottom !== undefined) { sets.push(`motto_bottom = $${i++}`); vals.push(fields.mottoBottom); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}
async function deleteUserById(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]); // user_data も CASCADE で自動削除
}

// ── ユーザーデータ（予定・固定予定・例外・通知購読） ──
async function loadUserData(userId) {
  const r = await pool.query('SELECT data FROM user_data WHERE user_id = $1', [userId]);
  if (!r.rows[0]) {
    const init = { events: [], fixedSchedules: {}, fixedExceptions: {}, pushSubscriptions: [] };
    await pool.query(
      'INSERT INTO user_data (user_id, data) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING',
      [userId, JSON.stringify(init)]
    );
    return init;
  }
  const data = r.rows[0].data;
  if (!data.fixedExceptions) data.fixedExceptions = {};
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  if (!data.fixedSchedules) data.fixedSchedules = {};
  if (!data.events) data.events = [];
  return data;
}
async function saveUserData(userId, data) {
  await pool.query(
    `INSERT INTO user_data (user_id, data) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET data = $2`,
    [userId, JSON.stringify(data)]
  );
}
async function getAllUserIds() {
  const r = await pool.query('SELECT user_id FROM user_data');
  return r.rows.map(row => row.user_id);
}

// ── セッション（メモリ上・サーバー再起動でログアウトされる点は変更なし） ──
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
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const config = await loadConfig();

    // 管理者ログイン
    if (username === 'admin' && password === config.adminPassword) {
      return res.json({ ok: true, token: createSession('admin', 'admin'), role: 'admin', name: '管理者' });
    }

    // ユーザーログイン
    const user = await findUserByLogin(username, password);
    if (user) {
      return res.json({ ok: true, token: createSession(user.id, 'user'), role: 'user', name: user.name });
    }

    res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
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
  const user = await findUserById(s.userId);
  res.json({ ok: true, role: 'user', name: user ? user.name : '不明' });
});

// ── ユーザーCRUD（管理者のみ） ─────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
  const users = await loadUsers();
  res.json(users.map(u => ({ id: u.id, username: u.username, name: u.name, mottoTop: u.mottoTop || '', mottoBottom: u.mottoBottom || '' })));
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, name, mottoTop, mottoBottom } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: '全項目を入力してください' });
    const users = await loadUsers();
    if (users.find(u => u.username === username)) return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
    const newUser = { id: Date.now().toString(), username, password, name, mottoTop: mottoTop || '', mottoBottom: mottoBottom || '' };
    await insertUser(newUser);
    res.json({ ok: true, user: { id: newUser.id, username, name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { password, name, mottoTop, mottoBottom } = req.body;
  await updateUserFields(req.params.id, { password, name, mottoTop, mottoBottom });
  res.json({ ok: true });
});

// ユーザー自身が自分の標語を取得
app.get('/api/motto', requireAuth, async (req, res) => {
  const s = req.session;
  if (s.role === 'admin') return res.json({ mottoTop: '', mottoBottom: '' });
  const user = await findUserById(s.userId);
  res.json({ mottoTop: user?.mottoTop || '', mottoBottom: user?.mottoBottom || '' });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  await deleteUserById(req.params.id);
  res.json({ ok: true });
});

// ── カレンダーデータAPI ───────────────────────
app.get('/api/data', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  res.json(await loadUserData(userId));
});

app.post('/api/event', requireAuth, async (req, res) => {
  const { day, endDay, ts, te, text, color, date, reminderMinutes } = req.body;
  if (!text || !date) return res.status(400).json({ error: '入力不足です' });
  const data = await loadUserData(req.session.userId);
  data.events.push({
    id: Date.now(), date,
    day: parseInt(day), endDay: parseInt(endDay || day),
    ts: ts || '', te: te || '', text, color: color || 'blue',
    reminderMinutes: reminderMinutes !== undefined && reminderMinutes !== '' ? parseInt(reminderMinutes) : null,
    notified: false
  });
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.delete('/api/event/:id', requireAuth, async (req, res) => {
  const data = await loadUserData(req.session.userId);
  data.events = data.events.filter(e => e.id !== parseInt(req.params.id));
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.post('/api/fixed', requireAuth, async (req, res) => {
  const { fixedSchedules } = req.body;
  const data = await loadUserData(req.session.userId);
  data.fixedSchedules = fixedSchedules;
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

// ── 固定予定の「その日だけ」例外 ─────────────────
// 例外データ構造: fixedExceptions["2026-06-30"]["1-0"] = { type: "modify", ts, text, color } | { type: "skip" }
// キーは "YYYY-MM-DD" → "曜日-インデックス" → 内容
app.post('/api/fixed-exception', requireAuth, async (req, res) => {
  const { dateKey, dowIdxKey, exception } = req.body; // exception: null で削除（元に戻す）
  if (!dateKey || !dowIdxKey) return res.status(400).json({ error: '入力不足です' });
  const data = await loadUserData(req.session.userId);
  if (!data.fixedExceptions[dateKey]) data.fixedExceptions[dateKey] = {};
  if (exception === null) {
    delete data.fixedExceptions[dateKey][dowIdxKey];
    if (Object.keys(data.fixedExceptions[dateKey]).length === 0) delete data.fixedExceptions[dateKey];
  } else {
    data.fixedExceptions[dateKey][dowIdxKey] = exception;
  }
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

// ── プッシュ通知 ──────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: '購読情報がありません' });
  const data = await loadUserData(req.session.userId);
  const exists = data.pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) data.pushSubscriptions.push(subscription);
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  const data = await loadUserData(req.session.userId);
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  await saveUserData(req.session.userId, data);
  res.json({ ok: true });
});

// ── 管理者パスワード変更 ──────────────────────
app.post('/api/config/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
  await saveAdminPassword(password);
  res.json({ ok: true });
});

// ── ngrok URL取得（ローカル実行時のみ使用） ────────
function getNgrokUrl(retries = 10, delay = 2000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const tryFetch = () => {
      attempts++;
      const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const tunnel = json.tunnels.find(t => t.proto === 'https');
            if (tunnel) return resolve(tunnel.public_url);
          } catch {}
          if (attempts < retries) setTimeout(tryFetch, delay);
          else resolve(null);
        });
      });
      req.on('error', () => { if (attempts < retries) setTimeout(tryFetch, delay); else resolve(null); });
      req.setTimeout(1500, () => { req.destroy(); });
    };
    tryFetch();
  });
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

function printBanner(ngrokUrl) {
  const ip = getLanIP();
  const line = '='.repeat(56);
  console.log('\n  ' + line);
  console.log('  ==   📅  月間カレンダー（マルチユーザー）稼働中   ==');
  console.log('  ' + line);
  console.log('\n  【PC・自宅Wi-Fiから】');
  console.log('  http://localhost:' + PORT + '/login.html');
  console.log('  http://' + ip + ':' + PORT + '/login.html');
  console.log('\n  【管理者ログイン】  ユーザー名: admin');
  if (ngrokUrl) {
    console.log('\n  ' + line);
    console.log('\n  【外出先・スマホから】\n');
    console.log('  ★★★★★★★★★★★★★★★★★★★★★★★★★★★★\n');
    console.log('    ' + ngrokUrl + '/login.html');
    console.log('\n  ★★★★★★★★★★★★★★★★★★★★★★★★★★★★');
    console.log('\n  ⚠  このURLはPC再起動ごとに変わります');
  }
  console.log('\n  ' + line);
  console.log('  Ctrl+C でサーバー停止\n');
}

// ── リマインダー定期チェック（1分ごと） ───────────
async function checkReminders() {
  const now = new Date();
  let userIds;
  try {
    userIds = await getAllUserIds();
  } catch (err) {
    console.error('リマインダーチェック中のDB取得エラー:', err.message);
    return;
  }

  for (const userId of userIds) {
    const data = await loadUserData(userId);
    if (!data.pushSubscriptions || !data.pushSubscriptions.length) continue;
    let changed = false;

    for (const ev of data.events) {
      if (ev.notified) continue;
      if (ev.reminderMinutes === null || ev.reminderMinutes === undefined) continue;
      if (!ev.ts) continue; // 時刻未設定はリマインド対象外

      const [y, m] = ev.date.split('-').map(Number);
      const eventDateTime = new Date(y, m - 1, ev.day, ...ev.ts.split(':').map(Number));
      const notifyAt = new Date(eventDateTime.getTime() - ev.reminderMinutes * 60000);

      // 通知時刻を過ぎていて、かつイベント開始時刻もまだ過ぎていない（古いイベントへの誤通知防止）
      if (now >= notifyAt && now <= eventDateTime) {
        const payload = JSON.stringify({
          title: '📅 予定のお知らせ',
          body: `${ev.text}（${ev.ts}〜）`,
        });
        for (const sub of data.pushSubscriptions) {
          try {
            await webpush.sendNotification(sub, payload);
          } catch (err) {
            // 購読が失効している場合は削除
            data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
          }
        }
        ev.notified = true;
        changed = true;
      }
    }

    if (changed) await saveUserData(userId, data);
  }
}

setInterval(checkReminders, 60 * 1000);

// ── サーバー起動 ──────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', async () => {
      const isCloud = !!process.env.RENDER || !!process.env.DATA_DIR;
      if (isCloud) {
        console.log('');
        console.log('📅 月間カレンダー（マルチユーザー）稼働中 - ポート ' + PORT);
        console.log('管理者ログイン: ユーザー名 admin');
        console.log('');
        return;
      }
      const ngrokUrl = await getNgrokUrl();
      printBanner(ngrokUrl);
    });
  })
  .catch(err => {
    console.error('❌ データベース初期化に失敗しました:', err.message);
    process.exit(1);
  });
