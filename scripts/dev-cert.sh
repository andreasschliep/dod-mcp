#!/bin/sh
# Creates a self-signed certificate for localhost and a random bearer token in
# local/secrets/ (git-ignored) for compose.yaml. Prints where they are, not the token.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/local/secrets"
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" \
  -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
openssl rand -hex 32 > "$dir/tokens"
# Readable by the container user (uid 1000); the folder stays private to you.
chmod 700 "$dir"
chmod 644 "$dir/cert.pem" "$dir/key.pem" "$dir/tokens"
echo "Certificate, key and token written to local/secrets/ (valid 30 days)."
echo "Start:   docker compose up -d --build"
echo "Connect: claude mcp add --transport http dod https://localhost:8443/mcp --header \"Authorization: Bearer \$(cat local/secrets/tokens)\""
echo "         and start Claude Code with NODE_EXTRA_CA_CERTS=$dir/cert.pem, so it trusts the certificate."
