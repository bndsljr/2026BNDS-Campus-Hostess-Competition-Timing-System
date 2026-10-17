/*
 * 时钟显示格式与"倒数 10 秒变红闪动"阈值的边界测试。
 * 跑的是线上同一份 public/shared.js，只把它接到最小 DOM 桩上。
 *
 * 用法: node test/clocktest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* —— 最小 DOM 桩：只实现 shared.js 用到的部分 —— */
function makeEl() {
  const classes = new Set();
  const el = {
    dataset: {},
    children: [],
    _text: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    get classes() {
      return [...classes].sort();
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return this._text;
    },
    set(v) {
      this._text = v;
      if (v === '') this.children.length = 0;
    },
  });
  return el;
}

const target = makeEl();
global.window = global;
global.document = {
  createElement: () => makeEl(),
  querySelector: (sel) => (sel === '#state-target' ? target : null),
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'shared.js'), 'utf8'));
const Timer = global.Timer;

/* —— 断言工具 —— */
let pass = 0;
let fail = 0;
function ok(msg) {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
}
function bad(msg) {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
}
function eq(msg, actual, expected) {
  if (String(actual) === String(expected)) ok(`${msg} (${actual})`);
  else bad(`${msg} — 实际=${actual} 期望=${expected}`);
}

const clockEl = makeEl();
clockEl.dataset.stateTarget = '#state-target';
const clock = Timer.bindClock(clockEl);

function shown(ms) {
  return clockEl.children.map((c) => c.textContent).join('');
}

console.log('== 1. 显示格式（只到分秒，永不出现小时） ==');
const cases = [
  [90000, '01:30'],
  [30000, '00:30'],
  [150000, '02:30'],
  [1000, '00:01'],
  [0, '00:00'],
  [5999000, '99:59'],
  [5999999, '99:59'], // 超上限被夹住，不会变成 100:00
  [10001, '00:11'],
  [10000, '00:10'],
  [9999, '00:10'],
];
for (const [ms, want] of cases) {
  clock.update(ms);
  eq(`${ms}ms 显示为`, shown(ms), want);
}
eq('超过 100 分钟仍夹在 99:59', Timer.clockText(999999999), '99:59');

console.log('\n== 2. 倒数 10 秒阈值（以屏幕显示的数字为准） ==');
function stateAt(ms) {
  clock.update(ms);
  return { text: shown(ms), final: clockEl.classList.contains('is-final'), zero: clockEl.classList.contains('is-zero') };
}
const boundaries = [
  [60000, false, false, '01:00 不闪'],
  [11000, false, false, '00:11 不闪（阈值外）'],
  [10001, false, false, '00:11（剩余 10.001s）不闪'],
  [10000, true, false, '00:10 开始闪红（阈值内）'],
  [9999, true, false, '00:10（剩余 9.999s）闪红'],
  [9500, true, false, '00:10 闪红'],
  [9000, true, false, '00:09 闪红'],
  [2000, true, false, '00:02 闪红'],
  [1000, true, false, '00:01 闪红'],
  [999, true, false, '00:01（剩余 0.999s）闪红'],
  [1, true, false, '00:01（剩余 1ms）闪红'],
  [0, false, true, '00:00 归零（转为更强的归零闪动）'],
];
for (const [ms, wantFinal, wantZero, label] of boundaries) {
  const s = stateAt(ms);
  eq(`${label} [最终类=${s.final} 归零类=${s.zero}]`, `${s.final}/${s.zero}`, `${wantFinal}/${wantZero}`);
}

console.log('\n== 3. 状态类同时作用到联动元素（大屏底色 / 控制台预览卡） ==');
stateAt(0);
eq('归零时联动元素也带 is-zero', target.classList.contains('is-zero'), 'true');
stateAt(5000);
eq('倒数 10 秒时联动元素带 is-final', target.classList.contains('is-final'), 'true');
eq('此时联动元素已摘掉 is-zero', target.classList.contains('is-zero'), 'false');
stateAt(60000);
eq('60 秒时两者都不带', `${target.classList.contains('is-final')}/${target.classList.contains('is-zero')}`, 'false/false');

console.log('\n== 4. 重复更新不抖动（同一秒内反复调用不改变状态） ==');
stateAt(8500);
const before = clockEl.classes.join(',');
for (let i = 0; i < 500; i++) clock.update(8000 + (i % 400)); // 8000~8399 都显示 00:09
eq('500 次刷新后状态稳定', clockEl.classes.join(','), before);
eq('刷新后显示仍正确', shown(8399), '00:09');

/* ============ 5. 客户端同步：服务端字段是否完整透传 ============
 * 曾出过 bug：shared.js 的 applySnapshot 漏拷 isBreak，
 * 于是服务端已进入休息、大屏却还在显示时间。此处做回归测试。 */
(async function () {
  console.log('\n== 5. 客户端同步：快照字段完整透传（含 isBreak 休息标记） ==');
  const snapshot = {
    rev: 42,
    durationMs: 90000,
    running: false,
    remainingMs: 12345,
    deadline: 0,
    isBreak: true,
    serverNow: Date.now(),
    viewers: 3,
  };
  global.fetch = (input) => {
    const url = String(input);
    if (url.indexOf('/api/time') >= 0) {
      return Promise.resolve({ json: () => Promise.resolve({ serverNow: Date.now() }) });
    }
    return Promise.resolve({ json: () => Promise.resolve(snapshot) });
  };
  const client = Timer.create({});
  await new Promise((r) => setTimeout(r, 150));

  eq('isBreak 透传到客户端', client.state().isBreak, 'true');
  eq('remainingMs 透传', client.state().remainingMs, 12345);
  eq('viewers 透传', client.state().viewers, 3);
  eq('rev 透传', client.state().rev, 42);

  snapshot.isBreak = false;
  await client.refresh();
  eq('结束休息后 isBreak 同步为 false', client.state().isBreak, 'false');
  client.stop();

  /* ============ 6. 断线提示的宽限期 ============
   * 刚打开页面时 TCP/SSE 还在建立，不该闪出"连接中断"；
   * 但真的断线超过宽限期必须能提示出来。 */
  console.log('\n== 6. 断线提示宽限期（避免开场闪提示，又不能漏报真断线） ==');
  const noticeEl = makeEl();
  const notice = Timer.noticeBinder(noticeEl, 120);

  notice(true, '连接中断，正在重连…');
  await new Promise((r) => setTimeout(r, 60));
  eq('宽限期内不显示提示', noticeEl.classList.contains('show'), 'false');

  await new Promise((r) => setTimeout(r, 120));
  eq('超过宽限期后显示提示', noticeEl.classList.contains('show'), 'true');
  eq('提示文案正确', noticeEl.textContent, '连接中断，正在重连…');

  notice(false, '');
  eq('恢复连接后立即撤下提示', noticeEl.classList.contains('show'), 'false');

  // 反复抖动（还没到宽限期就恢复）不应留下提示
  notice(true, '连接中断，正在重连…');
  await new Promise((r) => setTimeout(r, 40));
  notice(false, '');
  await new Promise((r) => setTimeout(r, 200));
  eq('短暂抖动不留残留提示', noticeEl.classList.contains('show'), 'false');

  console.log(`\n================ 时钟逻辑测试：通过 ${pass} / 失败 ${fail} ================`);
  process.exit(fail === 0 ? 0 : 1);
})();
