import express from "express";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const { BOT_TOKEN, MERCHANT, ALLOW_ORIGIN = "*", CHANNEL = "@KCPMINER", BOT_USERNAME = "KCPMINER_BOT", MINIAPP_URL = "https://mnoobgamerff07-source.github.io/KCPMINER/", ADMIN_ID = "", WEBHOOK_SECRET = "", TONCENTER_KEY = "", PORT = 3000 } = process.env;
if (!BOT_TOKEN || !MERCHANT) { console.error("Set BOT_TOKEN and MERCHANT in .env"); process.exit(1); }

const LEVELS = [0, 10, 50, 116, 500, 2000, 5000, 10000, 25000];
const BASE = 8, RATE = 0.0038, FEE = 1.05, MAX_ACCRUAL = 24 * 3600e3;

const db = new Database(process.env.DB_PATH || "kcp.db"); // on Render set DB_PATH=/data/kcp.db (persistent disk)
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, bal REAL DEFAULT 0, hold REAL DEFAULT 0, ver INTEGER DEFAULT 0, wallet TEXT, last_claim INTEGER);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id INTEGER, nano INTEGER, kcp INTEGER, status TEXT DEFAULT 'pending', expires INTEGER, tx_hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS task_done(user_id INTEGER, task TEXT, PRIMARY KEY(user_id,task));
CREATE TABLE IF NOT EXISTS checkin(user_id INTEGER PRIMARY KEY, day TEXT, streak INTEGER);
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, fee REAL, net REAL, address TEXT, status TEXT DEFAULT 'pending', created INTEGER);
`);

for (const c of ["ref_by INTEGER", "gen REAL DEFAULT 0", "name TEXT", "last_wd INTEGER DEFAULT 0", "withdrawn REAL DEFAULT 0"]) {
  try { db.exec("ALTER TABLE users ADD COLUMN " + c); } catch {}
}
const COMMISSION = 0.05, ACTIVE_HOLD = 116;

const level = h => LEVELS.reduce((l, v, i) => (h >= v ? i + 1 : l), 1);
const hourly = h => BASE * (1 + (level(h) - 1) * 0.55);
const pending = u => hourly(u.hold + u.bal) * Math.min(Date.now() - u.last_claim, MAX_ACCRUAL) / 3600e3;
const view = u => ({ bal: u.bal, hold: u.hold, ver: !!u.ver, wallet: u.wallet, level: level(u.hold + u.bal), hourly: hourly(u.hold + u.bal), pending: pending(u) });
function getUser(id, ref) {
  db.prepare("INSERT OR IGNORE INTO users(id,last_claim,ref_by) VALUES(?,?,?)").run(id, Date.now(), ref && ref !== id ? ref : null);
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

// Verify Telegram Mini App initData (signed by your bot token)
function auth(req, res, next) {
  const p = new URLSearchParams(req.get("x-init-data") || "");
  const hash = p.get("hash"); p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  const ok = hash && hash.length === calc.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc));
  if (!ok || Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return res.status(401).json({ error: "bad auth" });
  try { req.uid = JSON.parse(p.get("user")).id; req.ref = Number((p.get("start_param") || "").replace("ref_", "")) || null; } catch { return res.status(401).json({ error: "bad user" }); }
  getUser(req.uid, req.ref);
  db.prepare("UPDATE users SET name=? WHERE id=?").run(String(JSON.parse(p.get("user")).first_name || "").slice(0, 40), req.uid);
  next();
}

const app = express();
app.use(express.json());
app.use((q, s, n) => {
  s.set({ "Access-Control-Allow-Origin": ALLOW_ORIGIN, "Access-Control-Allow-Headers": "content-type,x-init-data" });
  q.method === "OPTIONS" ? s.sendStatus(204) : n();
});

app.get("/health", (q, s) => s.json({ ok: true }));
app.get("/api/me", auth, (q, s) => s.json(view(getUser(q.uid))));

app.post("/api/claim", auth, (q, s) => {
  const u = getUser(q.uid), p = pending(u);
  db.transaction(() => {
    db.prepare("UPDATE users SET bal=bal+?,last_claim=? WHERE id=?").run(p, Date.now(), u.id);
    // 5% commission to whoever invited this user, only while this user is "active" (holds 116+ KCP)
    if (u.ref_by && u.hold >= ACTIVE_HOLD) {
      const c = p * COMMISSION;
      db.prepare("UPDATE users SET bal=bal+? WHERE id=?").run(c, u.ref_by);
      db.prepare("UPDATE users SET gen=gen+? WHERE id=?").run(c, u.id);
    }
  })();
  s.json(view(getUser(u.id)));
});

// Friends tab data: totals plus ranking by commission each friend generated
app.get("/api/friends", auth, (q, s) => {
  const rows = db.prepare("SELECT name,ver,hold,gen FROM users WHERE ref_by=? ORDER BY gen DESC").all(q.uid);
  s.json({
    invited: rows.length,
    verified: rows.filter(r => r.ver).length,
    commission: rows.reduce((a, r) => a + r.gen, 0),
    friends: rows.map(r => ({ name: r.name || "Friend", verified: !!r.ver, hold: r.hold, earned: r.gen / COMMISSION, commission: r.gen })),
  });
});

// Step 1: create an order. The server decides amount and KCP, never the client.
app.post("/api/order", auth, (q, s) => {
  const verify = q.body.type === "verify"; // wallet verification: fixed 0.05 TON, no KCP
  const a = Number(q.body.amount);
  if (!verify && !(a >= 0.1 && a <= 1000)) return s.status(400).json({ error: "amount must be 0.1 to 1000 TON" });
  getUser(q.uid);
  const id = "KCP" + crypto.randomBytes(4).toString("hex");
  const nano = verify ? 50_000_000 : Math.round(a * FEE * 1e9), kcp = verify ? 0 : Math.floor(a / RATE);
  db.prepare("INSERT INTO orders(id,user_id,nano,kcp,expires) VALUES(?,?,?,?,?)").run(id, q.uid, nano, kcp, Date.now() + 15 * 60e3);
  s.json({ id, kcp, link: `https://app.tonkeeper.com/transfer/${MERCHANT}?amount=${nano}&text=${id}` });
});

// Step 3: the app polls this until status is "paid"
app.get("/api/order/:id", auth, (q, s) => {
  const o = db.prepare("SELECT status,kcp,expires FROM orders WHERE id=? AND user_id=?").get(q.params.id, q.uid);
  if (!o) return s.sendStatus(404);
  s.json({ status: o.status === "pending" && o.expires < Date.now() ? "expired" : o.status, kcp: o.kcp });
});

// One-time +25 KCP for joining the Telegram channel (the bot must be an admin of the channel)
app.post("/api/task/join", auth, async (q, s) => {
  const u = getUser(q.uid);
  if (db.prepare("SELECT 1 FROM task_done WHERE user_id=? AND task='join'").get(u.id))
    return s.status(409).json({ error: "already claimed" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL)}&user_id=${u.id}`);
    const j = await r.json();
    const st = j.ok && j.result.status;
    const member = ["member", "administrator", "creator"].includes(st) || (st === "restricted" && j.result.is_member);
    if (!member) return s.status(403).json({ error: "join the channel first" });
  } catch { return s.status(502).json({ error: "telegram check failed" }); }
  const r = db.prepare("INSERT OR IGNORE INTO task_done(user_id,task) VALUES(?,'join')").run(u.id);
  if (r.changes) db.prepare("UPDATE users SET bal=bal+25 WHERE id=?").run(u.id);
  s.json(view(getUser(u.id)));
});

// Daily check-in: +10 KCP once per UTC day, streak continues if yesterday was claimed
app.post("/api/task/daily", auth, (q, s) => {
  const u = getUser(q.uid);
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const c = db.prepare("SELECT * FROM checkin WHERE user_id=?").get(u.id);
  if (c && c.day === today) return s.status(409).json({ error: "already checked in today" });
  const streak = c && c.day === y ? c.streak + 1 : 1;
  db.transaction(() => {
    db.prepare("INSERT INTO checkin(user_id,day,streak) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET day=excluded.day,streak=excluded.streak").run(u.id, today, streak);
    db.prepare("UPDATE users SET bal=bal+10 WHERE id=?").run(u.id);
  })();
  s.json({ ...view(getUser(u.id)), streak });
});

// Invite task: +50 KCP once, when a friend you invited (via ref_<yourId> start param) has a verified wallet.
// ver is only set server-side after that friend's TON payment is confirmed on-chain.
app.post("/api/task/friend", auth, (q, s) => {
  const u = getUser(q.uid);
  const n = db.prepare("SELECT COUNT(*) c FROM users WHERE ref_by=? AND ver=1").get(u.id).c;
  if (n < 1) return s.status(403).json({ error: "no verified friend yet" });
  const r = db.prepare("INSERT OR IGNORE INTO task_done(user_id,task) VALUES(?,'friend')").run(u.id);
  if (!r.changes) return s.status(409).json({ error: "already claimed" });
  db.prepare("UPDATE users SET bal=bal+50 WHERE id=?").run(u.id);
  s.json(view(getUser(u.id)));
});

// ---- Withdrawals: user requests -> admin gets a Telegram message with Approve / Reject buttons ----
const WD_FEE = 0.09, WD_MIN = 5000; // 5,000 KCP -> 450 KCP fee
const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(r => r.json()).catch(() => ({}));

app.post("/api/withdraw", auth, async (q, s) => {
  const u = getUser(q.uid), a = Math.floor(Number(q.body.amount)), addr = String(q.body.address || "").trim();
  if (!u.ver) return s.status(403).json({ error: "verify your wallet first" });
  if (!(a >= WD_MIN)) return s.status(400).json({ error: "minimum is 5,000 KCP" });
  if (!/^(UQ|EQ)[\w-]{46}$/.test(addr)) return s.status(400).json({ error: "invalid TON address" });
  if (a > u.bal) return s.status(400).json({ error: "not enough balance" });
  if (u.hold < a * 0.5) return s.status(400).json({ error: "hold at least 50% of the amount" });
  if (Date.now() - u.last_wd < 864e5) return s.status(429).json({ error: "1 withdrawal per 24 hours" });
  const fee = Math.round(a * WD_FEE * 100) / 100, net = a - fee;
  // Balance is deducted now (held in escrow) so it cannot be spent twice while pending.
  const id = db.transaction(() => {
    db.prepare("UPDATE users SET bal=bal-?,last_wd=? WHERE id=?").run(a, Date.now(), u.id);
    return db.prepare("INSERT INTO withdrawals(user_id,amount,fee,net,address,created) VALUES(?,?,?,?,?,?)").run(u.id, a, fee, net, addr, Date.now()).lastInsertRowid;
  })();
  if (ADMIN_ID) await tg("sendMessage", {
    chat_id: ADMIN_ID,
    text: `New withdrawal #${id}\nUser: ${u.name || "?"} (${u.id})\nAmount: ${a} KCP\nFee: ${fee} KCP\nNet: ${net} KCP\nTON address:\n${addr}`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `wd:ok:${id}` }, { text: "❌ Reject", callback_data: `wd:no:${id}` }]] },
  });
  s.json({ id, status: "pending", ...view(getUser(u.id)) });
});

app.get("/api/withdrawals", auth, (q, s) => {
  s.json(db.prepare("SELECT id,amount,fee,net,address,status,created FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20").all(q.uid));
});

// ---- Bot chat: /start welcome message with buttons ----
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "⛏ Start Mining", web_app: { url: MINIAPP_URL } }],
    [{ text: "👥 Invite & Earn", callback_data: "invite" }, { text: "📖 How it works", callback_data: "how" }],
    [{ text: "📢 Community", url: "https://t.me/" + CHANNEL.replace("@", "") }],
  ],
};
const esc = x => String(x || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

function onMessage(m) {
  if (m.chat.type !== "private" || !/^\/start\b/.test(m.text || "")) return;
  const ref = Number((m.text.split(" ")[1] || "").replace("ref_", "")) || null; // t.me/<bot>?start=ref_<id>
  getUser(m.from.id, ref);
  tg("sendMessage", {
    chat_id: m.chat.id, parse_mode: "HTML", reply_markup: MAIN_MENU,
    text: `⛏ <b>Welcome to KCP Miner, ${esc(m.from.first_name)}!</b>\n\n` +
      `Mine KCP right inside Telegram, powered by the TON blockchain.\n\n` +
      `⛏ <b>Mine</b> — your miner keeps running, even while you're offline (up to 24h). Slide to extract.\n` +
      `📈 <b>Level up</b> — your level and speed grow with the KCP you hold.\n` +
      `🎯 <b>Tasks</b> — daily check-in and community tasks for bonus KCP.\n` +
      `👥 <b>Invite</b> — earn commission on your friends' mining.\n` +
      `💸 <b>Withdraw</b> — send KCP to your own TON wallet after wallet verification.\n\n` +
      `Tap <b>Start Mining</b> to begin.`,
  });
}

function onUserButton(cb) {
  tg("answerCallbackQuery", { callback_query_id: cb.id });
  const chat_id = cb.message.chat.id;
  if (cb.data === "invite") {
    const link = `https://t.me/${BOT_USERNAME}?startapp=ref_${cb.from.id}`;
    tg("sendMessage", {
      chat_id, parse_mode: "HTML",
      text: `👥 <b>Invite & Earn</b>\n\nShare your link. You earn 5% commission on your friends' mining, and the invite task unlocks when a friend verifies their wallet.\n\nYour link:\n${link}`,
      reply_markup: { inline_keyboard: [[{ text: "📤 Share link", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Mine KCP with me!")}` }]] },
    });
  } else {
    tg("sendMessage", {
      chat_id, parse_mode: "HTML",
      text: `📖 <b>How it works</b>\n\n` +
        `1. Open the app and your miner starts. It keeps mining offline for up to 24 hours.\n` +
        `2. Slide to extract your mined KCP into your app balance.\n` +
        `3. Your level and mining speed depend on your total KCP.\n` +
        `4. Do the daily check-in and join the community for bonus KCP.\n` +
        `5. Verify your wallet, then request a withdrawal. Requests are reviewed manually.`,
      reply_markup: { inline_keyboard: [[{ text: "⛏ Start Mining", web_app: { url: MINIAPP_URL } }]] },
    });
  }
}

// Telegram webhook: only the admin's button presses with the correct secret are accepted
app.post("/telegram/webhook", async (q, s) => {
  s.sendStatus(200);
  if (!WEBHOOK_SECRET || q.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return;
  if (q.body.message) return void onMessage(q.body.message);
  const cb = q.body.callback_query;
  if (!cb) return;
  if (cb.data === "invite" || cb.data === "how") return void onUserButton(cb);
  if (String(cb.from.id) !== String(ADMIN_ID)) return;
  const [, act, idS] = (cb.data || "").split(":");
  const w = db.prepare("SELECT * FROM withdrawals WHERE id=?").get(Number(idS));
  if (!w || w.status !== "pending") return void tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Already handled" });
  if (act === "ok") {
    db.transaction(() => {
      db.prepare("UPDATE withdrawals SET status='approved' WHERE id=?").run(w.id);
      db.prepare("UPDATE users SET hold=hold+?,withdrawn=withdrawn+? WHERE id=?").run(w.net, w.amount, w.user_id);
    })();
  } else {
    db.transaction(() => {
      db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").run(w.id);
      db.prepare("UPDATE users SET bal=bal+?,last_wd=0 WHERE id=?").run(w.amount, w.user_id); // refund
    })();
  }
  const ok = act === "ok";
  tg("answerCallbackQuery", { callback_query_id: cb.id, text: ok ? "Approved" : "Rejected" });
  tg("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id,
    text: `Withdrawal #${w.id} ${ok ? "✅ APPROVED" : "❌ REJECTED"}\n${w.amount} KCP (net ${w.net}) to\n${w.address}` });
  tg("sendMessage", { chat_id: w.user_id, text: ok
    ? `Your withdrawal of ${w.amount} KCP was approved. You receive ${w.net} KCP.`
    : `Your withdrawal of ${w.amount} KCP was rejected. The KCP was returned to your balance.` });
});

// Step 2: watch the merchant address for payments carrying the order ID as comment
const credit = db.transaction((o, hash, src) => {
  const r = db.prepare("UPDATE orders SET status='paid',tx_hash=? WHERE id=? AND status='pending'").run(hash, o.id);
  if (r.changes) db.prepare("UPDATE users SET hold=hold+?,ver=1,wallet=? WHERE id=?").run(o.kcp, src, o.user_id);
});

async function poll() {
  const open = db.prepare("SELECT * FROM orders WHERE status='pending' AND expires>?").all(Date.now());
  if (!open.length) return;
  const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${MERCHANT}&limit=50`,
    { headers: TONCENTER_KEY ? { "X-API-Key": TONCENTER_KEY } : {} });
  const j = await r.json();
  if (!j.ok) return;
  for (const t of j.result) {
    const m = t.in_msg;
    if (!m || !m.source) continue;
    const o = open.find(x => x.id === (m.message || "").trim());
    if (!o || Number(m.value) < o.nano) continue;
    try { credit(o, t.transaction_id.hash, m.source); } catch (e) { console.error("credit:", e.message); }
  }
}
setInterval(() => poll().catch(e => console.error("poll:", e.message)), 15000);

app.listen(PORT, () => console.log("KCP backend on :" + PORT));
