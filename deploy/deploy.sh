#!/usr/bin/env bash
# 从本地上传到云服务器并安装/重启（首次部署与后续更新都用这个）
#
# 用法：
#   HOST=119.3.170.71 USER=root PASS='xxxx' bash deploy/deploy.sh
#
# 说明：服务器上不装 rsync，改用 tar over ssh，零依赖、也支持带空格/中文的目录名。
set -euo pipefail

HOST="${HOST:?需要 HOST}"
USER="${USER:-root}"
PASS="${PASS:?需要 PASS（或改用 SSH 密钥）}"
APP_DIR=/opt/bnds-timer
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSHOPTS=(-o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no)

run_remote() { sshpass -p "$PASS" ssh "${SSHOPTS[@]}" "$USER@$HOST" "$@"; }

echo "==> 上传到 $USER@$HOST:$APP_DIR"
run_remote "mkdir -p '$APP_DIR' && rm -rf '$APP_DIR/public' '$APP_DIR/deploy' '$APP_DIR/test'"
tar -czf - -C "$ROOT" --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' . \
  | run_remote "tar -xzf - -C '$APP_DIR'"
run_remote "find '$APP_DIR' -type d -exec chmod 755 {} + ; find '$APP_DIR' -type f -exec chmod 644 {} + ; chmod 755 '$APP_DIR/deploy/'*.sh '$APP_DIR/test/'*.sh"

echo "==> 安装/重启服务"
run_remote "bash '$APP_DIR/deploy/install-server.sh'"
