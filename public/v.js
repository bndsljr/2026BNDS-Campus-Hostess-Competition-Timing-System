/* 侧屏（256×736 竖条屏）版：
 * 侧屏 LED 接在 16:9 输出（1920×1080 / 1600×900 等）的左上角，占 256×736 个物理像素。
 * 所以页面铺满整张 16:9 画布，所有画面只渲染在左上角的 .v-screen 区域里。
 * 布局逻辑与主大屏同源（shared.js 的同一个 Timer），只是排版不同。
 */
(function () {
  'use strict';

  /* 把「LED 的物理像素尺寸」换算成 CSS 像素：CSS 像素 = 物理像素 / devicePixelRatio。
   *  - 播放器 1080p、dpr=1 → 256×736 CSS px（最常见的情况）
   *  - 播放器 dpr=2        → 128×368 CSS px（内部仍是同一套 cqh 相对布局，等比缩放）
   * 也可用 ?w=256&h=736 直接覆盖，?debug=1 会画出屏幕区边框（便于现场对准）。 */
  (function sizeScreen() {
    var box = document.getElementById('v-screen');
    if (!box) return;
    var q = new URLSearchParams(location.search);
    var dpr = window.devicePixelRatio || 1;
    var scale = dpr > 1.05 ? dpr : 1;
    var w = parseFloat(q.get('w')) || 256 / scale;
    var h = parseFloat(q.get('h')) || 736 / scale;
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    var dbg = q.get('debug');
    if (dbg === '1' || dbg === 'true') box.dataset.debug = '1';
  })();

  var clock = Timer.bindClock(document.getElementById('clock'));
  var notice = Timer.noticeBinder(document.getElementById('notice'), 2000);
  var body = document.body;
  var titleEl = document.getElementById('break-title');
  var inBreak = false;

  /* 竖排标题：把「2026BNDS主持人大赛」拆成"每字一行"。
   * 为什么不用 writing-mode 竖排？因为竖排的每字进距由字体决定（实测约 1.12em，
   * 不是 1em），高度没法用 CSS 精确预算，会出现"太长顶到 logo"或"最后一个字被切掉"。
   * 改成一字一行、行高精确 1em 后，总高 = 13em + 组间间距，纯 cqh 就能算准。 */
  function buildVerticalTitle() {
    var spans = titleEl.querySelectorAll('span');
    if (!spans.length) return; // 已经拆过了
    var frag = document.createDocumentFragment();
    var first = true;
    for (var s = 0; s < spans.length; s++) {
      var text = spans[s].textContent.trim();
      for (var i = 0; i < text.length; i++) {
        var row = document.createElement('i');
        row.className = spans[s].className + (!first && i === 0 ? ' group-start' : '');
        row.textContent = text.charAt(i);
        frag.appendChild(row);
        first = false;
      }
    }
    titleEl.textContent = '';
    titleEl.appendChild(frag);
  }

  buildVerticalTitle();

  var timer = Timer.create({
    onState: function (s) {
      var nextBreak = !!s.isBreak;
      if (nextBreak !== inBreak) {
        inBreak = nextBreak;
        body.classList.toggle('is-break', inBreak);
        if (inBreak) clock.clear(); // 摘掉变红/归零状态，别让休息画面底色在闪
      }
      paint();
    },
    onStatus: function (s) {
      notice(!s.connected, s.polling ? '同步不稳定，正在使用备用同步…' : '连接中断，正在重连…');
    },
  });

  function paint() {
    // 首帧快照到达前什么都不显示：否则会先闪出一个"默认 01:30"的错误数字
    if (!timer.state().known) return;
    if (inBreak) {
      clock.clear();
      titleEl.setAttribute('aria-hidden', 'false');
      return;
    }
    titleEl.setAttribute('aria-hidden', 'true');
    clock.update(timer.remaining());
  }

  /* 立即画一帧 + 定时兜底 + rAF（与主大屏同样三重保障） */
  paint();
  setInterval(paint, 500);
  (function loop() {
    paint();
    requestAnimationFrame(loop);
  })();

  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock
      .request('screen')
      .then(function (lock) {
        wakeLock = lock;
      })
      .catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();
})();
