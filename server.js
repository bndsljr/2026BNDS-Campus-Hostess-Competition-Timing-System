#!/usr/bin/env node
'use strict';

/*
 * BNDS Host Competition Timer — 服务端
 *
 * 设计要点：
 *  1) 零依赖（只用 Node 内置模块），单进程，无构建步骤。
 *  2) 服务端是唯一真值源：只保存 durationMs / running / deadline(绝对时间戳)。
 *     不逐秒广播，客户端拿到 deadline 后本地按毫秒插值渲染 → 平滑、不跳秒。
 *  3) 实时同步用 SSE（Server-Sent Events）+ POST：
 *     EventSource 自带断线重连，穿透代理/防火墙最稳，且无需 WebSocket 依赖。
 *  4) 权限：/set 页面可控制，其他页面只读。/api/ctl 由服务端裁决，
 *     若设置了 CONTROL_KEY 环境变量则校验口令；留空 = 开放控制（当前部署模式）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------------------------- 配置 --------------------------------- */

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = toInt(process.env.PORT, 80);
const EXTRA_PORTS = (process.env.PORTS || '')
  .split(',')
  .map((s) => toInt(s.trim(), 0))
  .filter((p) => p > 0 && p !== PORT);
const CONTROL_KEY = process.env.CONTROL_KEY || '';
const STATE_FILE = process.env.STATE_FILE || '';
const HEARTBEAT_MS = 15000;
const DEFAULT_DURATION_MS = 90 * 1000;
const MAX_MS = 99 * 60 * 1000 + 59 * 1000; // 上限 99:59，永不出现小时
const MIN_MS = 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/* --------------------------------- 工具 ---------------------------------- */

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------- 状态机 ---------------------------------- */

const state = {
  durationMs: DEFAULT_DURATION_MS,
  running: false,
  deadline: 0, // running 时有效：服务端 epoch 毫秒
  remainingMs: DEFAULT_DURATION_MS,
  breakMode: false, // 休息模式：大屏不显示剩余时间，改显示赛事标题
  rev: 1,
};

let finishTimer = null;
const clients = new Set();

function remainingAt(now) {
  if (state.running && state.deadline) return Math.max(0, state.deadline - now);
  return Math.max(0, state.remainingMs);
}

function snapshot() {
  const now = Date.now();
  return {
    rev: state.rev,
    durationMs: state.durationMs,
    running: state.running,
    remainingMs: remainingAt(now),
    deadline: state.running ? state.deadline : 0,
    isBreak: state.breakMode,
    serverNow: now,
    viewers: clients.size,
  };
}

function armFinish() {
  clearTimeout(finishTimer);
  finishTimer = null;
  if (!state.running) return;
  const wait = Math.max(0, state.deadline - Date.now());
  finishTimer = setTimeout(onFinish, Math.min(wait, 2147483647));
}

function onFinish() {
  if (!state.running) return;
  if (Date.now() < state.deadline - 2) {
    armFinish(); // 定时器早醒，重新武装
    return;
  }
  state.running = false;
  state.deadline = 0;
  state.remainingMs = 0;
  state.rev += 1;
  log('finish → 00:00');
  broadcast();
  persist();
}

function broadcast(except) {
  if (clients.size === 0) return;
  const payload = 'event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) {
    if (res === except) continue; // 新连接已单独收到首帧快照
    try {
      res.write(payload);
    } catch (err) {
      clients.delete(res);
    }
  }
}

/* ---------------------------- 状态持久化（可选） --------------------------- */

function persist() {
  if (!STATE_FILE) return;
  const data = JSON.stringify({
    durationMs: state.durationMs,
    remainingMs: remainingAt(Date.now()),
    breakMode: state.breakMode,
    savedAt: Date.now(),
  });
  fs.writeFile(STATE_FILE + '.tmp', data, (err) => {
    if (err) return;
    fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {});
  });
}

function restore() {
  if (!STATE_FILE) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const d = clamp(toInt(raw.durationMs, DEFAULT_DURATION_MS), MIN_MS, MAX_MS);
    const r = clamp(toInt(raw.remainingMs, d), 0, MAX_MS);
    state.durationMs = d;
    state.remainingMs = r;
    state.running = false; // 重启后一律暂停，避免"复活"一个已经过期的 deadline
    state.breakMode = raw.breakMode === true; // 休息状态也一并恢复
    log('restored state', { durationMs: d, remainingMs: r, breakMode: state.breakMode });
  } catch (err) {
    if (err.code !== 'ENOENT') log('restore failed:', err.message);
  }
}

/* ------------------------------- 控制动作 -------------------------------- */

const ACTIONS = new Set([
  'set',
  'start',
  'resume',
  'pause',
  'toggle',
  'reset',
  'restart',
  'adjust',
  'break',
]);

/* 休息模式的语义：
 *  - 打开休息：大屏只显示赛事标题。若计时正在进行，先按下暂停（把剩余时间冻住），
 *    避免休息期间倒计时在看不见的地方跑完。
 *  - 开始/继续/重新开始 会自动结束休息 —— 要跑计时就必须让大屏显示计时，
 *    防止"以为在计时、其实大屏还挂着标题"这种现场事故。 */
function pauseIfRunning(now) {
  if (!state.running) return;
  state.remainingMs = remainingAt(now);
  state.running = false;
  state.deadline = 0;
}

function setBreakMode(on, now) {
  if (on) pauseIfRunning(now);
  state.breakMode = !!on;
}

function apply(action, value) {
  const now = Date.now();
  switch (action) {
    case 'set': {
      const d = clamp(toInt(value, 0), MIN_MS, MAX_MS);
      state.durationMs = d;
      state.remainingMs = d;
      state.running = false;
      state.deadline = 0;
      break;
    }
    case 'start':
    case 'resume': {
      if (state.remainingMs <= 0) state.remainingMs = state.durationMs;
      state.deadline = now + state.remainingMs;
      state.running = true;
      state.breakMode = false; // 要开始计时，就先退出休息
      break;
    }
    case 'pause': {
      pauseIfRunning(now);
      break;
    }
    case 'toggle': {
      if (state.running) {
        pauseIfRunning(now);
      } else {
        if (state.remainingMs <= 0) state.remainingMs = state.durationMs;
        state.deadline = now + state.remainingMs;
        state.running = true;
        state.breakMode = false;
      }
      break;
    }
    case 'break': {
      setBreakMode(value === true || value === 1 || value === '1' || value === 'true', now);
      break;
    }
    case 'reset': {
      state.running = false;
      state.deadline = 0;
      state.remainingMs = state.durationMs;
      break;
    }
    case 'restart': {
      state.remainingMs = state.durationMs;
      state.deadline = now + state.durationMs;
      state.running = true;
      state.breakMode = false; // 同上：重新开始意味着大屏回到计时
      break;
    }
    case 'adjust': {
      const delta = clamp(toInt(value, 0), -MAX_MS, MAX_MS);
      if (state.running) {
        const target = state.deadline + delta;
        if (target <= now) {
          state.running = false;
          state.deadline = 0;
          state.remainingMs = 0;
        } else {
          const maxDeadline = now + MAX_MS;
          state.deadline = Math.min(target, maxDeadline);
          state.durationMs = clamp(
            state.durationMs + delta,
            MIN_MS,
            MAX_MS
          );
        }
      } else {
        state.remainingMs = clamp(state.remainingMs + delta, 0, MAX_MS);
        state.durationMs = clamp(state.durationMs + delta, MIN_MS, MAX_MS);
      }
      break;
    }
    default:
      throw new Error('unknown action: ' + action);
  }
  state.rev += 1;
  armFinish();
  broadcast();
  persist();
  return snapshot();
}

/* ------------------------------- HTTP 处理 ------------------------------- */

function sendJSON(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendText(res, code, text, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function authorized(req, searchParams) {
  if (!CONTROL_KEY) return true;
  const given = searchParams.get('k') || req.headers['x-control-key'] || '';
  return safeEqual(given, CONTROL_KEY);
}

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/set' || rel === '/set/') rel = '/set.html';
  if (rel === '/v' || rel === '/v/' || rel === '/portrait' || rel === '/portrait/') {
    rel = '/v.html'; // 竖屏（256×736 竖条屏）大屏
  }

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not Found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS' });
    return res.end();
  }

  if (p === '/api/time') {
    return sendJSON(res, 200, { serverNow: Date.now() });
  }

  if (p === '/api/health') {
    return sendJSON(res, 200, { ok: true, rev: state.rev, viewers: clients.size });
  }

  if (p === '/api/state') {
    return sendJSON(res, 200, snapshot());
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    res.write('event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    broadcast(res); // 只是通知其他端"在线设备数变了"

    const hb = setInterval(() => {
      try {
        res.write(': ping ' + Date.now() + '\n\n');
      } catch (err) {
        /* ignored */
      }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(hb);
      if (clients.delete(res)) broadcast();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  if (p === '/api/ctl') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    if (!authorized(req, u.searchParams)) {
      log('ctl rejected (bad key)', p);
      return sendJSON(res, 403, { error: 'forbidden' });
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!ACTIONS.has(body.action)) return sendJSON(res, 400, { error: 'bad action' });
      const snap = apply(body.action, body.value);
      log('ctl', body.action, body.value === undefined ? '' : body.value, '→ rev', snap.rev);
      return sendJSON(res, 200, snap);
    } catch (err) {
      return sendJSON(res, 400, { error: String(err.message || err) });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  return serveStatic(req, res, p);
}

/* --------------------------------- 启动 ---------------------------------- */

restore();

/* 走时中每 5 秒落一次盘：万一进程被杀，最多只丢 5 秒进度 */
if (STATE_FILE) {
  setInterval(() => {
    if (state.running) persist();
  }, 5000).unref();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('handler error:', err && err.stack ? err.stack : err);
    try {
      sendJSON(res, 500, { error: 'internal error' });
    } catch (e) {
      /* ignored */
    }
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function listen(port) {
  return new Promise((resolve) => {
    const s = http.createServer(server.listeners('request')[0]);
    s.on('error', (err) => {
      log('listen failed on', port, err.code || err.message);
      resolve(null);
    });
    s.listen(port, HOST, () => {
      log('listening on http://' + HOST + ':' + port);
      resolve(s);
    });
  });
}

(async () => {
  const main = await listen(PORT);
  if (!main) {
    log('FATAL: primary port ' + PORT + ' unavailable');
    process.exit(1);
  }
  for (const extra of EXTRA_PORTS) await listen(extra);
  log('control key required:', CONTROL_KEY ? 'yes' : 'no (open /set)');
  log('state file:', STATE_FILE || '(disabled)');
})();

function shutdown(sig) {
  log('shutting down on', sig);
  clearTimeout(finishTimer);
  persist();
  for (const res of clients) {
    try {
      res.end();
    } catch (err) {
      /* ignored */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
