/* 控制台：设定档位 / 自定义时长 / 开始 · 暂停 · 继续 · 重置 · 微调
 * 所有改动都走 POST /api/ctl，由服务端裁决并广播给全部大屏。
 */
(function () {
  'use strict';

  var clockEl = document.getElementById('clock');
  var clock = Timer.bindClock(clockEl);
  clockEl.dataset.stateTarget = '#clock-card';

  var stateText = document.getElementById('state-text');
  var stateLabel = document.getElementById('state-label');
  var durationText = document.getElementById('duration-text');
  var toggleBtn = document.getElementById('toggle');
  var connPill = document.getElementById('conn');
  var connText = document.getElementById('conn-text');
  var viewersPill = document.getElementById('viewers');
  var viewersText = document.getElementById('viewers-text');
  var inMin = document.getElementById('in-min');
  var inSec = document.getElementById('in-sec');
  var presets = Array.prototype.slice.call(document.querySelectorAll('button.preset'));
  var tuneBtns = Array.prototype.slice.call(document.querySelectorAll('button[data-delta]'));
  var breakBtn = document.getElementById('break-toggle');

  var PRESETS = presets.map(function (b) {
    return Number(b.dataset.sec) * 1000;
  });

  var current = { running: false, remaining: 0, duration: 90 * 1000, known: false, isBreak: false };

  var timer = Timer.create({
    onState: function (s) {
      var prevRemaining = current.remaining;
      current.known = true;
      current.duration = s.durationMs;
      current.running = s.running;
      current.remaining = timer.remaining();
      syncUI(prevRemaining);
    },
    onStatus: function (st) {
      connPill.className = 'pill ' + (st.connected ? 'ok' : 'warn');
      connText.textContent = st.connected ? '同步正常' : st.polling ? '备用同步中' : '重连中…';
      viewersText.textContent = (st.viewers || 1) + ' 台设备在线';
    },
  });

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function durationLabel(ms) {
    var total = Math.round(ms / 1000);
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function syncUI(prevRemaining) {
    var s = timer.state();
    var left = timer.remaining();
    current.remaining = left;
    document.body.classList.toggle('is-break', !!s.isBreak);

    // 预设高亮
    presets.forEach(function (btn) {
      var ms = Number(btn.dataset.sec) * 1000;
      btn.classList.toggle('active', ms === s.durationMs);
    });

    // 自定义输入框不被用户正在编辑时覆盖
    if (document.activeElement !== inMin && document.activeElement !== inSec) {
      var total = Math.round(s.durationMs / 1000);
      inMin.value = String(Math.floor(total / 60));
      inSec.value = String(total % 60);
    }

    durationText.textContent = '设定时长 ' + durationLabel(s.durationMs);

    // 主按钮：运行中显示"暂停"，否则显示"继续/开始"
    if (s.running) {
      toggleBtn.textContent = '暂停';
      toggleBtn.classList.add('pause');
    } else {
      toggleBtn.classList.remove('pause');
      toggleBtn.textContent = left <= 0 ? '重新开始计时' : left < s.durationMs ? '继续' : '开始';
    }

    // 状态文字
    current.isBreak = !!s.isBreak;
    var label = '已暂停';
    var key = 'paused';
    if (s.isBreak) {
      label = '休息中 · 大屏显示标题';
      key = 'break';
    } else if (s.running) {
      label = '计时中';
      key = 'running';
    } else if (left <= 0) {
      label = '时间到 · 00:00';
      key = 'zero';
    }
    if (stateLabel.textContent !== label) stateLabel.textContent = label;
    stateText.dataset.state = key;

    // 休息开关
    breakBtn.textContent = s.isBreak ? '结束休息 · 回到计时' : '开启休息 · 大屏显示标题';
    breakBtn.classList.toggle('active', s.isBreak);
    breakBtn.setAttribute('aria-pressed', s.isBreak ? 'true' : 'false');
  }

  function paintClock() {
    if (!timer.state().known) return; // 同上：拿到真实状态前不显示默认数字
    clock.update(timer.remaining());
  }

  paintClock();
  setInterval(paintClock, 500); // rAF 被节流时的兜底，保证预览数字始终在走
  (function loop() {
    paintClock();
    requestAnimationFrame(loop);
  })();

  /* --------------------------------- 操作 -------------------------------- */

  function send(action, value) {
    return Timer.post(action, value)
      .catch(function (err) {
        connText.textContent = '操作失败：' + err.message;
        connPill.className = 'pill warn';
      })
      .then(function () {
        return timer.refresh();
      });
  }

  toggleBtn.addEventListener('click', function () {
    send(timer.state().running ? 'pause' : 'start');
  });

  document.getElementById('reset').addEventListener('click', function () {
    send('reset');
  });

  document.getElementById('restart').addEventListener('click', function () {
    send('restart');
  });

  breakBtn.addEventListener('click', function () {
    send('break', !timer.state().isBreak);
  });

  presets.forEach(function (btn) {
    btn.addEventListener('click', function () {
      send('set', Number(btn.dataset.sec) * 1000);
    });
  });

  tuneBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      send('adjust', Number(btn.dataset.delta));
    });
  });

  function applyCustom() {
    var m = Math.max(0, Math.min(99, parseInt(inMin.value, 10) || 0));
    var s = Math.max(0, Math.min(59, parseInt(inSec.value, 10) || 0));
    var ms = m * 60000 + s * 1000;
    if (ms < 1000) ms = 1000;
    if (ms > Timer.MAX_SECONDS * 1000) ms = Timer.MAX_SECONDS * 1000;
    inMin.value = String(Math.floor(ms / 60000));
    inSec.value = String(Math.round((ms % 60000) / 1000));
    send('set', ms);
  }

  document.getElementById('apply').addEventListener('click', applyCustom);
  [inMin, inSec].forEach(function (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCustom();
        input.blur();
      }
    });
  });

  /* 快捷键：输入框内不拦截，避免影响打字 */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      send(timer.state().running ? 'pause' : 'start');
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      send(e.shiftKey ? 'restart' : 'reset');
    }
  });
})();
