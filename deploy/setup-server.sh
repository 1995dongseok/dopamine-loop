#!/usr/bin/env bash
# Ubuntu(Lightsail) 인스턴스에서 최초 1회 실행. deploy.ps1 로 /opt/dopamine-loop 에 파일을 올린 뒤 실행한다.
#   sudo bash deploy/setup-server.sh dopamine-1-2-3-4.sslip.io
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/dopamine-loop
APP_USER=ubuntu

if [[ -z "$DOMAIN" ]]; then
  echo "사용법: sudo bash deploy/setup-server.sh <도메인 또는 dopamine-1-2-3-4.sslip.io>"; exit 1
fi

# Node.js 24 LTS (NodeSource)
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund"

install -m 644 "$APP_DIR/deploy/dopamine-loop.service" /etc/systemd/system/dopamine-loop.service
systemctl daemon-reload
systemctl enable --now dopamine-loop

# 기존 Caddyfile 에 블록이 없을 때만 추가 (다른 사이트 설정은 건드리지 않는다)
if ! grep -q "^$DOMAIN " /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
  { echo; sed -e '/^#/d' -e "s/dopamine.example.com/$DOMAIN/" "$APP_DIR/deploy/Caddyfile"; } >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy

echo "완료. https://$DOMAIN 으로 접속하세요. 상태: systemctl status dopamine-loop caddy"
