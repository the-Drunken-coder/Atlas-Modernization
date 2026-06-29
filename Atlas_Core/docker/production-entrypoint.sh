#!/bin/sh
set -eu

trim() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

enable_api_auth="$(trim "${ENABLE_API_AUTH:-}")"
enable_api_auth="$(printf '%s' "$enable_api_auth" | tr '[:upper:]' '[:lower:]')"

case "$enable_api_auth" in
    true|1|yes|on)
        ;;
    *)
        printf '%s\n' "Refusing to start production Atlas Core image: set ENABLE_API_AUTH=true and API_AUTH_KEY to a real secret." >&2
        exit 1
        ;;
esac

api_auth_key="$(trim "${API_AUTH_KEY:-}")"

if [ -z "$api_auth_key" ]; then
    printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is empty." >&2
    exit 1
fi

if [ "$api_auth_key" = "REPLACE_WITH_SECURE_KEY" ]; then
    printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is still the example placeholder." >&2
    exit 1
fi

admin_password="$(trim "${ATLAS_ADMIN_PASSWORD:-}")"
admin_password_file="$(trim "${ATLAS_ADMIN_PASSWORD_FILE:-}")"

if [ -z "$admin_password" ] && [ -z "$admin_password_file" ]; then
    printf '%s\n' "Refusing to start production Atlas Core image: set ATLAS_ADMIN_PASSWORD or ATLAS_ADMIN_PASSWORD_FILE to replace the development admin/password seed." >&2
    exit 1
fi

exec "$@"
