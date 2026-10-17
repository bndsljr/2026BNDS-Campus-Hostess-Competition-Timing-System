/* BNDS Host Competition Timer — 前端核心（大屏页与控制台共用）
 *
 * 同步模型：
 *   - 服务端为唯一真值源，SSE 推送 {running, deadline, remainingMs, serverNow}。
 *   - 客户端测一次往返延时算出与服务器的时钟偏移，然后用 deadline 本地插值，
 *     每秒只重绘一次数字 → 显示平滑，且即使推送短暂中断也照常准确走时。
 */
(function (global) {
  'use strict';

  var MAX_SECONDS = 99 * 60 + 59; // 99:59

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* 归一化到 "MM:SS" 的五个字符格子。
   * 上取整（ceil）：开跑瞬间就是满格 01:30，只有真正归零才显示 00:00。
   * 因此"显示 00:10"对应剩余 (9, 10] 秒，"显示 00:00"只对应真正归零。 */
  function clockChars(ms) {
    var total = clockSeconds(ms);
    var m = Math.floor(total / 60);
    var s = total % 60;
    var text = pad2(m) + ':' + pad2(s);
    return text.split('');
  }

  function clockSeconds(ms) {
    var total = Math.ceil(Math.max(0, ms) / 1000);
    return total > MAX_SECONDS ? MAX_SECONDS : total;
  }

  function clockText(ms) {
    return clockChars(ms).join('');
  }

  var FINAL_SECONDS = 10; // 倒数 10 秒开始变红闪动

  /* 把某个元素绑定成时钟：字宽固定，切数字零位移。
   * 两个状态类：
   *   is-final —— 显示 00:01 ~ 00:10，数字变红闪动
   *   is-zero  —— 真正归零（00:00），闪得更强，并联动 data-state-target 指定的元素
   * 阈值一律以"屏幕上显示的数字"为准，避免出现"数字是 00:10 却还没开始闪"的不一致。 */
  function bindClock(el) {
    var nodes = [];
    el.textContent = '';
    for (var i = 0; i < 5; i++) {
      var span = document.createElement('i');
      if (i === 2) span.className = 'colon';
      el.appendChild(span);
      nodes.push(span);
    }
    var last = '';
    var target = null;
    var targetSought = false;
    var applied = { final: null, zero: null };

    function stateTarget() {
      if (!targetSought) {
        targetSought = true;
        if (el.dataset && el.dataset.stateTarget) {
          target = document.querySelector(el.dataset.stateTarget);
        }
      }
      return target;
    }

    function setState(cls, on, key) {
      if (applied[key] === on) return;
      applied[key] = on;
      el.classList.toggle(cls, on);
      var t = stateTarget();
      if (t) t.classList.toggle(cls, on);
    }

    return {
      el: el,
      update: function (ms) {
        var chars = clockChars(ms);
        var text = chars.join('');
        if (text !== last) {
          for (var j = 0; j < 5; j++) {
            if (nodes[j].textContent !== chars[j]) nodes[j].textContent = chars[j];
          }
          last = text;
        }
        var secs = clockSeconds(ms);
        setState('is-zero', secs === 0, 'zero');
        setState('is-final', secs > 0 && secs <= FINAL_SECONDS, 'final');
      },
      /* 休息模式等"不显示时间"的场合调用：摘掉两个状态类并同步内部缓存，
       * 这样重新显示时不会因为缓存认为"类还在"而漏掉变红。 */
      clear: function () {
        setState('is-zero', false, 'zero');
        setState('is-final', false, 'final');
      },
    };
  }

  /* ------------------------------ 同步客户端 ----------------------------- */

  function create(opts) {
    opts = opts || {};
    var onState = opts.onState || function () {};
    var onStatus = opts.onStatus || function () {};

    var state = {
      rev: 0,
      durationMs: 90 * 1000,
      running: false,
      deadline: 0,
      remainingMs: 90 * 1000,
      viewers: 0,
      isBreak: false,
      known: false,
    };
    var skew = 0; // serverNow - clientNow
    var connected = false;
    var polling = false;
    var es = null;
    var fails = 0;
    var lastMsgAt = 0;
    var pollTimer = null;
    var watchdog = null;

    function serverNow() {
      return Date.now() + skew;
    }

    function remaining() {
      if (state.running && state.deadline) {
        return Math.max(0, state.deadline - serverNow());
      }
      return Math.max(0, state.remainingMs);
    }

    function emitStatus() {
      onStatus({
        connected: connected,
        polling: polling,
        viewers: state.viewers,
        rev: state.rev,
        skew: skew,
      });
    }

    function applySnapshot(s) {
      if (!s || typeof s !== 'object') return;
      state.durationMs = Number(s.durationMs) || state.durationMs;
      state.running = !!s.running;
      state.deadline = Number(s.deadline) || 0;
      state.remainingMs = Number(s.remainingMs) || 0;
      state.viewers = Number(s.viewers) || 0;
      state.isBreak = !!s.isBreak;
      state.rev = Number(s.rev) || state.rev;
      state.known = true;
      lastMsgAt = Date.now();
      refineSkew(s.serverNow);
      onState(state);
      emitStatus();
    }

    /* 初次用一次往返测量时钟偏移（最准）；之后只用大幅修正兜底，
     * 避免被单向网络抖动带偏，也避免数字出现可见跳动。 */
    function measureSkew() {
      var t0 = Date.now();
      return fetch('/api/time', { cache: 'no-store' })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          var t1 = Date.now();
          skew = Number(j.serverNow) - (t0 + t1) / 2;
          emitStatus();
        })
        .catch(function () {});
    }

    function refineSkew(serverTs) {
      if (!serverTs) return;
      var diff = Number(serverTs) - Date.now() - skew;
      if (Math.abs(diff) < 80) return;
      var step = Math.max(-40, Math.min(40, diff * 0.25));
      skew += step;
    }

    function setConnected(v) {
      if (connected === v) return;
      connected = v;
      emitStatus();
    }

    function startPoll() {
      if (polling) return;
      polling = true;
      emitStatus();
      pollTimer = setInterval(function () {
        fetch('/api/state', { cache: 'no-store' })
          .then(function (r) {
            return r.json();
          })
          .then(applySnapshot)
          .catch(function () {});
      }, 1000);
    }

    function stopPoll() {
      if (!polling) return;
      polling = false;
      clearInterval(pollTimer);
      pollTimer = null;
      emitStatus();
    }

    function connect() {
      if (es) {
        try {
          es.close();
        } catch (e) {
          /* ignored */
        }
        es = null;
      }
      try {
        es = new EventSource('/api/stream');
      } catch (e) {
        startPoll();
        return;
      }
      es.addEventListener('open', function () {
        fails = 0;
        setConnected(true);
        stopPoll();
      });
      es.addEventListener('state', function (ev) {
        fails = 0;
        setConnected(true);
        stopPoll();
        try {
          applySnapshot(JSON.parse(ev.data));
        } catch (e) {
          /* ignored */
        }
      });
      es.addEventListener('error', function () {
        setConnected(false);
        fails += 1;
        if (fails >= 3) startPoll(); // SSE 长时间不可用时退化为轮询
      });
    }

    function boot() {
      measureSkew().then(function () {
        return fetch('/api/state', { cache: 'no-store' })
          .then(function (r) {
            return r.json();
          })
          .then(applySnapshot)
          .catch(function () {});
      });
      connect();
      watchdog = setInterval(function () {
        if (lastMsgAt && Date.now() - lastMsgAt > 45000) {
          setConnected(false);
          connect();
        }
      }, 15000);
    }

    boot();

    return {
      state: function () {
        return state;
      },
      remaining: remaining,
      serverNow: serverNow,
      skew: function () {
        return skew;
      },
      refresh: function () {
        return fetch('/api/state', { cache: 'no-store' })
          .then(function (r) {
            return r.json();
          })
          .then(applySnapshot)
          .catch(function () {});
      },
      stop: function () {
        clearInterval(watchdog);
        stopPoll();
        if (es) es.close();
      },
    };
  }

  /* --------------------------------- 控制 -------------------------------- */

  /* 断线提示绑定器：断线持续超过 graceMs 才显示提示。
   * 页面刚打开的瞬间 TCP/SSE 还在建立，不该闪出"连接中断"（大屏上尤其难看）。 */
  function noticeBinder(el, graceMs) {
    var timer = null;
    return function (disconnected, text) {
      if (!disconnected) {
        clearTimeout(timer);
        timer = null;
        el.classList.remove('show');
        return;
      }
      if (el.classList.contains('show')) {
        el.textContent = text; // 已显示则只更新文案
        return;
      }
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        el.textContent = text;
        el.classList.add('show');
      }, graceMs || 2000);
    };
  }

  function post(action, value) {
    return fetch('/api/ctl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, value: value }),
    }).then(function (r) {
      if (!r.ok) throw new Error('ctl failed: ' + r.status);
      return r.json();
    });
  }

  global.Timer = {
    create: create,
    bindClock: bindClock,
    noticeBinder: noticeBinder,
    clockText: clockText,
    clockSeconds: clockSeconds,
    post: post,
    MAX_SECONDS: MAX_SECONDS,
    FINAL_SECONDS: FINAL_SECONDS,
  };
})(window);
