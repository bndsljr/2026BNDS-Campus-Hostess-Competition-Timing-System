/* 大屏页：只渲染剩余时间。
 * 值来自服务端 deadline 的本地插值 → 平滑且不依赖每秒推送。
 */
(function () {
  'use strict';

  var clock = Timer.bindClock(document.getElementById('clock'));
  var notice = Timer.noticeBinder(document.getElementById('notice'), 2000);
  var body = document.body;
  var titleEl = document.getElementById('break-title');
  var inBreak = false;

  var timer = Timer.create({
    onState: function (s) {
      var nextBreak = !!s.isBreak;
      if (nextBreak !== inBreak) {
        inBreak = nextBreak;
        // 休息中：只显示赛事标题，且不保留变红/归零的底色闪烁
        body.classList.toggle('is-break', inBreak);
        if (inBreak) clock.clear();
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

  /* 三重保障，确保"屏幕上一定有数字"：
   *  1) 脚本一执行就立刻画一帧（不依赖任何异步回调）；
   *  2) rAF 提供平滑刷新（可见时）；
   *  3) 500ms 定时兜底 —— rAF 在隐藏/被节流的标签页里会挂起，
   *     此时靠定时器继续走时，且每次都是从 deadline 现算，不会累积误差。 */
  paint();
  setInterval(paint, 500);
  (function loop() {
    paint();
    requestAnimationFrame(loop);
  })();

  /* 大屏常亮：支持 Wake Lock 的浏览器下阻止息屏 */
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

  /* 隐藏快捷键：F 全屏（不显示任何按钮，避免干扰画面） */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(function () {});
    }
  });
})();
