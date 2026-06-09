#!/bin/sh
# Generate HTTP Basic Auth for the static site from environment variables.
# Runs before nginx starts (the nginx image executes /docker-entrypoint.d/*.sh).
#
#   SITE_PASSWORD  - if set & non-empty, the site requires a login. If unset, the
#                    site stays open (no change in behaviour).
#   SITE_USER      - username (default: admin).
#
# The password itself is NEVER baked into the image — it's provided at runtime,
# so it stays out of the repo and the published image.
set -eu

AUTH_CONF="/etc/nginx/appscreen-auth.conf"
HTPASSWD="/etc/nginx/.htpasswd"

if [ -n "${SITE_PASSWORD:-}" ]; then
    user="${SITE_USER:-admin}"
    # -n print to stdout, -b take password from CLI, -m apr1/MD5 (always supported
    # by nginx's own Basic Auth, unlike platform-dependent bcrypt on musl).
    htpasswd -nbm "$user" "$SITE_PASSWORD" > "$HTPASSWD"
    chmod 600 "$HTPASSWD"
    {
        echo 'auth_basic "appscreen - acces protege";'
        echo "auth_basic_user_file $HTPASSWD;"
    } > "$AUTH_CONF"
    echo "[appscreen-auth] Basic auth ENABLED (user: $user)"
else
    echo 'auth_basic off;' > "$AUTH_CONF"
    echo "[appscreen-auth] SITE_PASSWORD not set - site is OPEN"
fi
