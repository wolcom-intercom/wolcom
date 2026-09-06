#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
env_get(){ awk -v key="$1" 'index($0,key"=")==1{v=substr($0,length(key)+2);sub(/\r$/, "", v);print v}' .env | tail -n1; }
WEB_PORT="$(env_get WOLCOM_WEB_PORT)"
fail=0
printf '\n=== Wolcom doctor ===\n'
docker compose version >/dev/null 2>&1 && echo "OK Docker Compose" || { echo "FAIL Docker Compose"; fail=1; }
docker compose ps
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" && printf '\nOK Wolcom health\n' || { echo "FAIL Wolcom health"; fail=1; }
ss -lntup 2>/dev/null | grep -E ':(7880|7881|7882|'"$WEB_PORT"')\b' || true
exit "$fail"
