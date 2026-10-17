#!/usr/bin/env bash
# 针对「已部署实例」的公网端到端验收（不启动本地服务）
# 用法: bash test/smoke.sh http://119.3.170.71
set -uo pipefail

BASE="${1:?用法: bash test/smoke.sh <base-url>}"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

ok()    { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — 实际=$2 期望=$3"; fi; }
near()  { if [ "$(python3 -c "print(abs($2-$3)<=$4)")" = "True" ]; then ok "$1 ($2 ≈ $3 ±$4)"; else bad "$1 — 实际=$2 期望=$3 ±$4"; fi; }
jget()  { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
post()  { curl -sS -m 10 -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d "$1"; }
st()    { curl -sS -m 10 "$BASE/api/state"; }

echo "== 目标：$BASE =="

echo "== 1. 静态资源与响应头 =="
for path in / /set /v /portrait /style.css /shared.js /display.js /control.js /v.js /favicon.svg /logo.webp /logo.png; do
  check "GET $path" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE$path")" "200"
done
check "CSS Content-Type" "$(curl -s -m 10 -o /dev/null -w '%{content_type}' "$BASE/style.css")" "text/css; charset=utf-8"
check "HTML 不被缓存（便于更新即时生效）" "$(curl -s -m 10 -D - -o /dev/null "$BASE/" | grep -i '^cache-control' | tr -d '\r' | awk '{print $2}')" "no-cache"
check "未知路径 404" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/nothing-here")" "404"

echo "== 2. 大屏页确为只读（不含任何控制调用） =="
check "首页无 /api/ctl 调用" "$(curl -s -m 10 "$BASE/" | grep -c 'api/ctl')" "0"
check "首页无按钮元素" "$(curl -s -m 10 "$BASE/" | grep -ci '<button')" "0"
check "首页只引用 shared.js + display.js" "$(curl -s -m 10 "$BASE/" | grep -c '<script')" "2"
check "控制台页引用 control.js" "$(curl -s -m 10 "$BASE/set" | grep -c 'control.js')" "1"

echo "== 3. 三档位 + 自定义 =="
for sec in 30 90 150; do
  post "{\"action\":\"set\",\"value\":$((sec*1000))}" >/dev/null
  check "set ${sec}s" "$(st | jget durationMs)" "$((sec*1000))"
  check "set ${sec}s 后处于暂停待发" "$(st | jget running)" "False"
done
post '{"action":"set","value":175000}' >/dev/null
check "自定义 02:55" "$(st | jget durationMs)" "175000"
post '{"action":"set","value":5999000}' >/dev/null
check "上限 99:59（不出现小时）" "$(st | jget durationMs)" "5999000"

echo "== 4. 开始 / 走时速率 / 漂移 / 暂停 / 继续 =="
# 基准必须用服务器自己的时钟：/api/state 同一条响应里同时带 serverNow 与 remainingMs，
# 网络延迟因此完全抵消，测的才是"倒计时是否严格跟着时钟走"。
srv_pair() { st | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['serverNow'],d['remainingMs'])"; }
post '{"action":"set","value":90000}' >/dev/null
S=$(post '{"action":"start"}')
near "开始接口返回满档（服务端即时值）" "$(echo "$S" | jget remainingMs)" "$(echo "$S" | jget durationMs)" "50"
read -r s0 r0 <<<"$(srv_pair)"

# 走时速率：剩余时间的减少量必须等于真实经过时间（这才是"准不准"的本质）
sleep 2
read -r s2 r2 <<<"$(srv_pair)"
near "走时速率误差（2 秒样本）" "$((r0 - r2))" "$((s2 - s0))" "20"

# 漂移：连走 15 秒，累计误差仍须在 20ms 内
sleep 13
read -r s4 r4 <<<"$(srv_pair)"
near "15 秒累计漂移（服务器时钟基准）" "$((r0 - r4))" "$((s4 - s0))" "20"

post '{"action":"pause"}' >/dev/null
p1=$(st | jget remainingMs); sleep 1.2
check "暂停后数值冻结" "$(st | jget remainingMs)" "$p1"
post '{"action":"resume"}' >/dev/null
sleep 0.6
check "继续后重新走时" "$(python3 -c "print($(st | jget remainingMs) < $p1)")" "True"

echo "== 5. 重置 / 重新开始 / 微调 =="
post '{"action":"reset"}' >/dev/null
check "重置回满档" "$(st | jget remainingMs)" "90000"
check "重置后暂停" "$(st | jget running)" "False"
post '{"action":"restart"}' >/dev/null
check "重新开始 → 运行中" "$(st | jget running)" "True"
d0=$(st | jget deadline)
post '{"action":"adjust","value":30000}' >/dev/null
near "+30 秒 → 截止时刻后移" "$(st | jget deadline)" "$((d0+30000))" "200"
post '{"action":"adjust","value":-30000}' >/dev/null
near "-30 秒 → 截止时刻前移" "$(st | jget deadline)" "$d0" "200"

echo "== 6. 多端同步（公网两条 SSE + 一次控制） =="
curl -sN -m 8 "$BASE/api/stream" >"$TMP/a.txt" & A=$!
curl -sN -m 8 "$BASE/api/stream" >"$TMP/b.txt" & B=$!
sleep 1.5
post '{"action":"set","value":150000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 1.5
kill $A $B 2>/dev/null; wait $A $B 2>/dev/null
LA=$(grep -o 'data: {.*}' "$TMP/a.txt" | tail -1 | sed 's/^data: //')
LB=$(grep -o 'data: {.*}' "$TMP/b.txt" | tail -1 | sed 's/^data: //')
check "两端 rev 一致" "$(echo "$LA" | jget rev)" "$(echo "$LB" | jget rev)"
near "两端剩余时间一致" "$(echo "$LA" | jget remainingMs)" "$(echo "$LB" | jget remainingMs)" "60"
check "在线设备数已统计" "$(python3 -c "print($(echo "$LA" | jget viewers) >= 2)")" "True"

echo "== 7. 归零自动停止 =="
post '{"action":"set","value":2000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 2.7
check "到点 remainingMs=0" "$(st | jget remainingMs)" "0"
check "到点 running=false" "$(st | jget running)" "False"
S2=$(post '{"action":"start"}')
# 用服务端返回的即时值断言，避免被公网请求延迟带偏（本地 sleep 计时在公网下会抖）
near "归零后再按开始 → 重跑满档（服务端即时值）" "$(echo "$S2" | jget remainingMs)" "$(echo "$S2" | jget durationMs)" "50"

echo "== 7b. 休息模式（公网） =="
post '{"action":"break","value":false}' >/dev/null
post '{"action":"set","value":30000}' >/dev/null
post '{"action":"start"}' >/dev/null
sleep 1
b=$(post '{"action":"break","value":true}')
check "开启休息 → isBreak=true" "$(echo "$b" | jget isBreak)" "True"
check "开启休息 → 自动暂停" "$(echo "$b" | jget running)" "False"
r1=$(echo "$b" | jget remainingMs)
sleep 1.5
check "休息中时间冻结" "$(st | jget remainingMs)" "$r1"
s=$(post '{"action":"start"}')
check "按开始自动退出休息" "$(echo "$s" | jget isBreak)" "False"
check "退出后计时在跑" "$(echo "$s" | jget running)" "True"
post '{"action":"pause"}' >/dev/null
post '{"action":"break","value":true}' >/dev/null
check "大屏页含休息标题元素" "$(curl -s -m 10 "$BASE/" | grep -c 'break-title')" "1"
check "竖屏页含竖排时钟结构" "$(curl -s -m 10 "$BASE/v" | grep -c 'clock--column')" "1"
check "竖屏页含休息标题元素" "$(curl -s -m 10 "$BASE/v" | grep -c 'break-title')" "1"
check "控制台含休息开关" "$(curl -s -m 10 "$BASE/set" | grep -c 'break-toggle')" "1"
check "竖屏页仍是只读（无控制调用）" "$(curl -s -m 10 "$BASE/v" | grep -c 'api/ctl')" "0"
post '{"action":"break","value":false}' >/dev/null
check "关闭休息" "$(st | jget isBreak)" "False"

echo "== 8. 异常输入 =="
check "未知 action → 400" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ctl" -H 'Content-Type: application/json' -d '{"action":"rm -rf /"}')" "400"
check "GET /api/ctl → 405" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/ctl")" "405"

echo "== 9. 收尾：退出休息 + 回到 90s 暂停 =="
post '{"action":"break","value":false}' >/dev/null
post '{"action":"set","value":90000}' >/dev/null
post '{"action":"reset"}' >/dev/null
check "收尾已退出休息" "$(st | jget isBreak)" "False"
check "收尾状态" "$(st | jget remainingMs)" "90000"
check "收尾未运行" "$(st | jget running)" "False"

echo
echo "================ 公网验收：通过 $PASS / 失败 $FAIL ================"
[ "$FAIL" -eq 0 ] || exit 1
