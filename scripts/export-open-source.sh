#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(awk -F'"' '/"version"/{print $4; exit}' "$ROOT/app/package.json")"
OUT="${1:-$ROOT/wolcom-open-source-${VERSION}.tar.gz}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DST="$TMP/wolcom-${VERSION}"
mkdir -p "$DST"
for n in app updater scripts livekit docs docker-compose.yml README.md LICENSE; do
  [ -e "$ROOT/$n" ] && cp -a "$ROOT/$n" "$DST/$n"
done
# Commercial Wolcom Hosted billing/signup implementation is intentionally not part of the AGPL self-host export.
rm -rf "$DST/app/cloud"
# The core dynamically loads cloud/billing.mjs, so it runs normally when the module is absent.
cat > "$DST/OPEN_SOURCE.md" <<DOC
# Wolcom Open Source ${VERSION}

This is the self-hostable Wolcom Core release licensed under AGPL-3.0-or-later.
The separate Wolcom Hosted commercial control/billing module is not included.
Core intercom, events, organizations, users, customer control, BackupHub, updater,
branding and realtime functionality remain available without payment to Wolcom.
DOC
# Hosted installation defaults cloud on; self-host export defaults it off.
sed -i 's/WOLCOM_CLOUD_ENABLED: ${WOLCOM_CLOUD_ENABLED:-1}/WOLCOM_CLOUD_ENABLED: ${WOLCOM_CLOUD_ENABLED:-0}/' "$DST/docker-compose.yml"
# Do not ship release-update manifest/update.sh as the canonical self-host source package.
rm -f "$DST/manifest.json" "$DST/checksums.sha256" "$DST/update.sh"
tar -C "$TMP" -czf "$OUT" "wolcom-${VERSION}"
echo "$OUT"
sha256sum "$OUT"
