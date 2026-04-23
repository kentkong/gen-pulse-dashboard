#!/usr/bin/env bash
# ============================================================================
# export-ca-bundle.sh
# ----------------------------------------------------------------------------
# Export every trusted root cert on this Mac (system + login keychains,
# including corporate CAs like Zscaler and Gen Digital) into a single PEM
# bundle that Node/npm/node-gyp can trust via NODE_EXTRA_CA_CERTS.
#
# WHY
#   Inside Gen's corporate network, TLS to nodejs.org / npmjs.com / etc.
#   is intercepted by Zscaler. Node doesn't read macOS Keychain by
#   default, so `npm install` fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY
#   (especially for `better-sqlite3`, which downloads Node headers via
#   node-gyp).
#
# WHEN TO RE-RUN
#   - First time on a new machine
#   - After IT rotates the Zscaler / Gen Digital / NortonLifeLock root
#   - If `npm install` starts failing with cert errors again
#
# WHAT IT PRODUCES
#   ~/.certs/corporate-bundle.pem    (~280 KB, world-readable)
#
# USAGE
#   ./scripts/export-ca-bundle.sh
#
# Then make sure ~/.zshrc has:
#   export NODE_EXTRA_CA_CERTS="$HOME/.certs/corporate-bundle.pem"
# (this is added automatically on first setup; re-running this script
#  does NOT touch your shell profile.)
# ============================================================================

set -euo pipefail

DEST_DIR="$HOME/.certs"
DEST_FILE="$DEST_DIR/corporate-bundle.pem"

mkdir -p "$DEST_DIR"

echo "Exporting trusted roots from macOS keychains into $DEST_FILE ..."

# Order matters: system roots first, then admin-installed (incl. corporate).
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$DEST_FILE"
security find-certificate -a -p /Library/Keychains/System.keychain >> "$DEST_FILE"
# -login keychain is per-user; some corporate deploys drop CAs here.
if [ -f "$HOME/Library/Keychains/login.keychain-db" ]; then
  security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db" >> "$DEST_FILE" || true
fi

CERT_COUNT=$(grep -c 'BEGIN CERTIFICATE' "$DEST_FILE" || echo 0)
BYTES=$(stat -f%z "$DEST_FILE" 2>/dev/null || stat -c%s "$DEST_FILE")
echo "Done: $CERT_COUNT certificates, $BYTES bytes."
echo
echo "Verify by searching for Zscaler / Gen Digital / NortonLifeLock:"
echo "  openssl crl2pkcs7 -nocrl -certfile \"$DEST_FILE\" | openssl pkcs7 -print_certs -noout | grep -Ei 'zscaler|gen digital|nortonlifelock'"
echo
echo "Make sure your shell exports NODE_EXTRA_CA_CERTS:"
echo "  echo \$NODE_EXTRA_CA_CERTS"
echo "  # should print: $DEST_FILE"
