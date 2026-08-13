#!/bin/sh
set -eu

trim() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

recreate_on_startup="$(trim "${DATABASE_RECREATE_ON_STARTUP:-false}")"
recreate_on_startup="$(printf '%s' "$recreate_on_startup" | tr '[:upper:]' '[:lower:]')"

case "$recreate_on_startup" in
    true|1|yes|on)
        printf '%s\n' "Refusing to start production Atlas Core image: DATABASE_RECREATE_ON_STARTUP must be false so PostgreSQL and MinIO remain durable." >&2
        exit 1
        ;;
esac

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
normalized_api_auth_key="$(printf '%s' "$api_auth_key" | tr '[:upper:]' '[:lower:]')"

if [ -z "$api_auth_key" ]; then
    printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is empty." >&2
    exit 1
fi

case "$normalized_api_auth_key" in
    replace_with_secure_key|replace_with_strong_bootstrap_key|your-secure-api-key)
        printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is still the example placeholder." >&2
        exit 1
        ;;
esac

admin_password="$(trim "${ATLAS_ADMIN_PASSWORD:-}")"
admin_password_file="$(trim "${ATLAS_ADMIN_PASSWORD_FILE:-}")"

if [ -z "$admin_password" ] && [ -z "$admin_password_file" ]; then
    printf '%s\n' "Refusing to start production Atlas Core image: set ATLAS_ADMIN_PASSWORD or ATLAS_ADMIN_PASSWORD_FILE to replace the development admin/password seed." >&2
    exit 1
fi

if [ -z "$admin_password_file" ]; then
    normalized_admin_password="$(printf '%s' "$admin_password" | tr '[:upper:]' '[:lower:]')"
    case "$normalized_admin_password" in
        password|replace_with_secure_admin_password|replace-with-secure-admin-password|your-secure-admin-password)
            printf '%s\n' "Refusing to start production Atlas Core image: ATLAS_ADMIN_PASSWORD is a development default or example placeholder." >&2
            exit 1
            ;;
    esac
    if [ "${#admin_password}" -lt 12 ]; then
        printf '%s\n' "Refusing to start production Atlas Core image: ATLAS_ADMIN_PASSWORD must be at least 12 characters." >&2
        exit 1
    fi
fi

exec "$@"
