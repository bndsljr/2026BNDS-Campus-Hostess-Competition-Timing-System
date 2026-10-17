#!/usr/bin/env bash
# 在云服务器上安装/更新 BNDS Host Competition Timer（需 root）
# 幂等：可重复执行，用于首次安装与后续更新。
set -euo pipefail

APP_DIR=/opt/bnds-timer
DATA_DIR=/var/lib/bnds-timer
APP_USER=bnds
NODE_DIR=/opt/node
NODE_MAJOR_URL="https://nodejs.org/dist/latest-v22.x"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "1/6 安装 Node（如已存在则跳过）"
if [ -x /usr/local/bin/node ] && /usr/local/bin/node -v >/dev/null 2>&1; then
  echo "已安装：$(/usr/local/bin/node -v)"
else
  TARBALL=$(curl -fsSL "$NODE_MAJOR_URL/SHASUMS256.txt" | grep -o 'node-v[0-9.]*-linux-x64\.tar\.gz' | head -1)
  [ -n "$TARBALL" ] || { echo "无法获取 Node 版本信息，请检查外网"; exit 1; }
  echo "下载 $TARBALL"
  curl -fsSL -o "/tmp/$TARBALL" "$NODE_MAJOR_URL/$TARBALL"
  echo "$(grep " $TARBALL\$" <(curl -fsSL "$NODE_MAJOR_URL/SHASUMS256.txt") | awk '{print $1}')  /tmp/$TARBALL" | sha256sum -c -
  mkdir -p "$NODE_DIR"
  tar -xzf "/tmp/$TARBALL" -C "$NODE_DIR" --strip-components=1
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
  rm -f "/tmp/$TARBALL"
  echo "已安装：$(/usr/local/bin/node -v)"
fi

say "2/6 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

say "3/6 安装 systemd 服务"
install -m 644 "$APP_DIR/deploy/bnds-timer.service" /etc/systemd/system/bnds-timer.service
systemctl daemon-reload
systemctl enable bnds-timer >/dev/null

say "4/6 启动服务"
systemctl restart bnds-timer
sleep 1.2
systemctl is-active bnds-timer

say "5/6 本机自检"
curl -fsS -m 5 http://127.0.0.1/api/health && echo
curl -fsS -m 5 -o /dev/null -w '首页 HTTP %{http_code}\n' http://127.0.0.1/
curl -fsS -m 5 -o /dev/null -w '控制台 HTTP %{http_code}\n' http://127.0.0.1/set

say "6/6 完事"
systemctl --no-pager --full status bnds-timer | head -12
