/*
 * 用「线上正在运行的那份 public/shared.js」验证：
 *   设备本机时钟不准时，大屏显示的剩余时间是否仍然正确。
 *
 * 做法：把 shared.js 放进 Node 里跑（Node 22 自带 fetch；Node 无 EventSource，
 * 于是顺带验证了"降级为轮询同步"这条兜底路径），然后把它算出来的剩余时间
 * 与服务器权威值对比。本机时钟若比服务器慢 N 秒，未做校时的实现会偏大 N 秒。
 *
 * 用法: node test/skewtest.js http://119.3.170.71
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = (process.argv[2] || 'http://119.3.170.71').replace(/\/$/, '');

// —— 最小 DOM/浏览器环境桩，够 shared.js 跑起来 ——
global.window = global;
function stubEl() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    textContent: '',
  };
}
global.document = { createElement: stubEl, querySelector: () => null };

const realFetch = global.fetch;
global.fetch = (input, init) =>
  realFetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'shared.js'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) 先让服务器跑起来一个 150 秒的计时，并把本机时钟误差记下来
  const post = (body) =>
    realFetch(BASE + '/api/ctl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  await post({ action: 'set', value: 150000 });
  await post({ action: 'start' });

  const t0 = Date.now();
  const srv = await realFetch(BASE + '/api/time').then((r) => r.json());
  const t1 = Date.now();
  const deviceError = srv.serverNow - (t0 + t1) / 2; // 本机时钟比服务器慢多少(ms)

  // 2) 用真实前端代码建立同步客户端
  let lastState = null;
  const timer = window.Timer.create({ onState: (s) => (lastState = s) });

  console.log(`本机时钟偏差: ${deviceError >= 0 ? '慢' : '快'} ${Math.abs(deviceError).toFixed(0)} ms`);
  console.log('等待客户端完成校时与首次同步…');
  await sleep(1500);

  console.log(`客户端判定自身偏移 skew = ${timer.skew().toFixed(1)} ms（应约等于 ±(往返的一半)）`);
  console.log(`同步方式: ${lastState ? '已拿到状态' : '尚无状态'}`);

  // 3) 关键对比：同一时刻，客户端算出的剩余时间 vs 服务器权威剩余时间
  let worst = 0;
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const authoritative = await realFetch(BASE + '/api/state').then((r) => r.json());
    const clientMs = timer.remaining();
    const diff = clientMs - authoritative.remainingMs;
    samples.push(diff);
    worst = Math.max(worst, Math.abs(diff));
    console.log(
      `  第 ${i + 1} 次：客户端 ${clientMs.toFixed(0)}ms  服务器 ${authoritative.remainingMs}ms  差 ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}ms`
    );
    await sleep(900);
  }

  const unmasked = Math.abs(deviceError); // 若不校时，误差就是这个量级
  console.log('');
  console.log(`最大偏差 = ${worst.toFixed(0)} ms`);
  console.log(`若不进行校时，本机时钟误差会直接变成显示偏差 ≈ ${unmasked.toFixed(0)} ms`);
  await post({ action: 'set', value: 90000 });
  await post({ action: 'reset' });

  if (worst <= 150 && unmasked > 500) {
    console.log(`\n✅ 通过：设备时钟误差 ${unmasked.toFixed(0)}ms 已被校正，显示偏差仅 ${worst.toFixed(0)}ms`);
    process.exit(0);
  }
  if (unmasked <= 500) {
    console.log('\n⚠️ 本机时钟与服务器足够接近，这个测试没有区分度（换一台时钟不准的设备再试）');
    process.exit(0);
  }
  console.log(`\n❌ 失败：显示偏差 ${worst.toFixed(0)}ms 过大，校时可能没生效`);
  process.exit(1);
})();
