#!/usr/bin/env bash
# BNDS Host Competition Timer — 本地端到端自测
# 用法: bash test/selftest.sh [端口]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8099}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
SRV=""

cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — 实际=$2 期望=$3"; fi
}
near() { # near <描述> <实际> <期望> <容差>
  local d
  d=$(python3 -c "print(abs($2-$3)<=$4)" 2>/dev/null)
  if [ "$d" = "True" ]; then ok "$1 ($2 ≈ $3 ±$4)"; else bad "$1 — 实际=$2 期望=$3 ±$4"; fi
}
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }

post() { curl -sS -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d "$1"; }

start_server() { # start_server <额外环境变量>
  env $1 PORT="$PORT" HOST=127.0.0.1 STATE_FILE="$TMP/state.json" node "$ROOT/server.js" \
    >"$TMP/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do
    curl -sf "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "服务启动失败，日志："; cat "$TMP/server.log"; exit 1
}

echo "== 1. 语法检查 =="
for f in "$ROOT/server.js" "$ROOT"/public/*.js; do
  if node --check "$f" 2>/dev/null; then ok "node --check $(basename "$f")"; else bad "node --check $(basename "$f")"; fi
done
if node "$ROOT/test/clocktest.js" >"$TMP/clock.log" 2>&1; then
  ok "时钟显示格式与闪红阈值单测（$(grep -c 'PASS' "$TMP/clock.log") 项全过）"
else
  bad "clocktest.js 未通过："; cat "$TMP/clock.log"
fi

echo "== 2. 启动服务（端口 $PORT） =="
start_server ""
ok "服务已监听 $BASE"

echo "== 3. 静态资源与路由 =="
for path in / /set /v /portrait /style.css /shared.js /display.js /control.js /v.js /favicon.svg /logo.webp /logo.png; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  check "GET $path" "$code" "200"
done
check "GET /不存在" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope")" "404"
check "目录穿越 /../server.js" "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/../server.js")" "404"
check "GET /api/ctl (非 POST)" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/ctl")" "405"

echo "== 4. 初始状态 =="
s=$(curl -s "$BASE/api/state")
check "默认档位" "$(echo "$s" | jget durationMs)" "90000"
check "默认未运行" "$(echo "$s" | jget running)" "False"

echo "== 5. 档位切换 30/90/150 =="
for sec in 30 90 150; do
  post "{\"action\":\"set\",\"value\":$((sec * 1000))}" >/dev/null
  s=$(curl -s "$BASE/api/state")
  check "set ${sec}s → 剩余" "$(echo "$s" | jget remainingMs)" "$((sec * 1000))"
  check "set ${sec}s → 暂停态" "$(echo "$s" | jget running)" "False"
done

echo "== 6. 走时速率与漂移（基准 = 服务器自身时钟，延迟完全抵消） =="
srv_pair() { curl -s "$BASE/api/state" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['serverNow'],d['remainingMs'])"; }
post '{"action":"set","value":90000}' >/dev/null
post '{"action":"start"}' >/dev/null
read -r s0 r0 <<<"$(srv_pair)"
sleep 2
read -r s2 r2 <<<"$(srv_pair)"
near "2 秒样本速率误差" "$((r0 - r2))" "$((s2 - s0))" "20"
sleep 8
read -r s4 r4 <<<"$(srv_pair)"
near "10 秒累计漂移" "$((r0 - r4))" "$((s4 - s0))" "20"

echo "== 7. 暂停冻结 / 继续 =="
post '{"action":"pause"}' >/dev/null
p0=$(curl -s "$BASE/api/state" | jget remainingMs)
sleep 1.2
p1=$(curl -s "$BASE/api/state" | jget remainingMs)
check "暂停后数值冻结" "$p0" "$p1"
check "暂停态 running=false" "$(curl -s "$BASE/api/state" | jget running)" "False"
post '{"action":"resume"}' >/dev/null
sleep 0.6
p2=$(curl -s "$BASE/api/state" | jget remainingMs)
check "继续后重新走时" "$(python3 -c "print($p2 < $p1)")" "True"

echo "== 8. 重置 / 重新开始 =="
post '{"action":"reset"}' >/dev/null
check "重置回档位且暂停" "$(curl -s "$BASE/api/state" | jget remainingMs)" "90000"
check "重置后 running=false" "$(curl -s "$BASE/api/state" | jget running)" "False"
post '{"action":"restart"}' >/dev/null
s=$(curl -s "$BASE/api/state")
check "重新开始 → 运行中" "$(echo "$s" | jget running)" "True"
near "重新开始 → 回到满档" "$(echo "$s" | jget remainingMs)" "90000" "150"

echo "== 9. 微调（运行中） =="
d0=$(curl -s "$BASE/api/state" | jget deadline)
post '{"action":"adjust","value":10000}' >/dev/null
d1=$(curl -s "$BASE/api/state" | jget deadline)
near "+10s → 截止时刻后移 10s" "$d1" "$((d0 + 10000))" "150"
post '{"action":"adjust","value":-10000}' >/dev/null
d2=$(curl -s "$BASE/api/state" | jget deadline)
near "−10s → 截止时刻前移 10s" "$d2" "$d0" "150"

echo "== 10. 多端同步（两个 SSE 连接 + 一次控制） =="
curl -sN "$BASE/api/stream" >"$TMP/c1.txt" & C1=$!
curl -sN "$BASE/api/stream" >"$TMP/c2.txt" & C2=$!
sleep 0.8
post '{"action":"set","value":30000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 0.8
kill $C1 $C2 2>/dev/null
LASTC1=$(grep -o 'data: {.*}' "$TMP/c1.txt" | tail -1 | sed 's/^data: //')
LASTC2=$(grep -o 'data: {.*}' "$TMP/c2.txt" | tail -1 | sed 's/^data: //')
rev1=$(echo "$LASTC1" | jget rev); rev2=$(echo "$LASTC2" | jget rev)
check "两个客户端收到同一 rev" "$rev1" "$rev2"
v1=$(echo "$LASTC1" | jget remainingMs); v2=$(echo "$LASTC2" | jget remainingMs)
near "两端剩余时间一致" "$v1" "$v2" "50"
check "SSE 首帧即带完整快照" "$(grep -m1 '^data: ' "$TMP/c1.txt" | grep -c 'remainingMs')" "1"

echo "== 11. 归零自动停止 =="
post '{"action":"set","value":2000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 2.6
s=$(curl -s "$BASE/api/state")
check "到点后 remainingMs=0" "$(echo "$s" | jget remainingMs)" "0"
check "到点后 running=false" "$(echo "$s" | jget running)" "False"
post '{"action":"start"}' >/dev/null
near "归零后再启动 → 从满档重跑" "$(curl -s "$BASE/api/state" | jget remainingMs)" "2000" "150"
post '{"action":"reset"}' >/dev/null

echo "== 12. 非法输入 =="
check "未知 action → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d '{"action":"hack"}')" "400"
check "非法 JSON → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d 'not-json')" "400"
post '{"action":"set","value":999999999}' >/dev/null
check "超长时长被夹到 99:59" "$(curl -s "$BASE/api/state" | jget durationMs)" "5999000"
post '{"action":"set","value":90}' >/dev/null
check "1 秒以内被夹到 1 秒" "$(curl -s "$BASE/api/state" | jget durationMs)" "1000"

echo "== 12b. 休息模式（大屏改显示赛事标题） =="
post '{"action":"break","value":false}' >/dev/null
post '{"action":"set","value":30000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 1
b=$(post '{"action":"break","value":true}')
check "开启休息 → isBreak=true" "$(echo "$b" | jget isBreak)" "True"
check "开启休息 → 计时自动暂停" "$(echo "$b" | jget running)" "False"
r1=$(echo "$b" | jget remainingMs)
sleep 1.2
check "休息中剩余时间被冻住" "$(curl -s "$BASE/api/state" | jget remainingMs)" "$r1"
check "休息标志持续为 true" "$(curl -s "$BASE/api/state" | jget isBreak)" "True"
s=$(post '{"action":"start"}')
check "按开始 → 自动退出休息" "$(echo "$s" | jget isBreak)" "False"
check "按开始 → 计时已运行" "$(echo "$s" | jget running)" "True"
post '{"action":"pause"}' >/dev/null
b2=$(post '{"action":"break","value":true}')
check "再次开启休息" "$(echo "$b2" | jget isBreak)" "True"
b3=$(post '{"action":"break","value":false}')
check "关闭休息 → isBreak=false" "$(echo "$b3" | jget isBreak)" "False"
check "关闭休息不改动暂停态" "$(echo "$b3" | jget running)" "False"
check "竖屏页含竖排时钟结构" "$(curl -s "$BASE/v" | grep -c 'clock--column')" "1"
check "竖屏页含赛事标题元素" "$(curl -s "$BASE/v" | grep -c 'break-title')" "1"
check "主大屏也含赛事标题元素" "$(curl -s "$BASE/" | grep -c 'break-title')" "1"
check "控制台含休息开关" "$(curl -s "$BASE/set" | grep -c 'break-toggle')" "1"

echo "== 13. 崩溃/重启后状态恢复 =="
post '{"action":"set","value":120000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 1
post '{"action":"break","value":true}' >/dev/null
kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null; SRV=""
start_server ""
s=$(curl -s "$BASE/api/state")
check "重启后档位保留" "$(echo "$s" | jget durationMs)" "120000"
check "重启后保持暂停（不复活过期倒计时）" "$(echo "$s" | jget running)" "False"
check "重启后休息状态也保留" "$(echo "$s" | jget isBreak)" "True"
post '{"action":"break","value":false}' >/dev/null
near "重启后剩余 ≈ 119s" "$(echo "$s" | jget remainingMs)" "119000" "1200"

echo "== 14. 口令模式（CONTROL_KEY）仅作回归验证 =="
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; SRV=""
start_server "CONTROL_KEY=secret123"
check "无口令 POST → 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d '{"action":"reset"}')" "403"
check "错误口令 POST → 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl?k=wrong" -H 'Content-Type: application/json' -d '{"action":"reset"}')" "403"
check "正确口令 POST → 200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl?k=secret123" -H 'Content-Type: application/json' -d '{"action":"reset"}')" "200"
check "观看端 / 仍是只读页（无控制元素）" "$(curl -s "$BASE/" | grep -c 'api/ctl')" "0"

echo
echo "================ 结果：通过 $PASS / 失败 $FAIL ================"
[ "$FAIL" -eq 0 ] || exit 1
