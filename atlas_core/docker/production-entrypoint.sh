#!/bin/sh
set -eu

trim() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

is_weak_api_auth_key() {
    candidate="$1"
    case "$candidate" in
        000000|111111|123456|abcd1234|changeme|admin|apikey|asdf|default|dummy|example|key|password|password123|placeholder|qwerty|secret|test|your-key-here|*admin*|*asdf*|*letmein*|*password*|*qwerty*|*welcome*|*123)
            return 0
            ;;
    esac

    byte_count="$(printf '%s' "$candidate" | wc -c | tr -d '[:space:]')"
    unique_count="$(printf '%s' "$candidate" | LC_ALL=C fold -w 1 | LC_ALL=C sort -u | wc -l | tr -d '[:space:]')"
    if [ "$byte_count" -lt 8 ] || [ "$unique_count" -lt 4 ]; then
        return 0
    fi

    if ! printf '%s\n' "$candidate" | LC_ALL=C awk '
        {
            value = $0
            digits = "0123456789"
            letters = "abcdefghijklmnopqrstuvwxyz"
            run_length = 1
            last_step = 0
            previous_class = ""
            previous_position = 0
            for (index_value = 1; index_value <= length(value); index_value++) {
                current = substr(value, index_value, 1)
                current_position = index(digits, current)
                current_class = current_position ? "digit" : ""
                if (!current_position) {
                    current_position = index(letters, current)
                    current_class = current_position ? "letter" : ""
                }
                step = current_class != "" && current_class == previous_class \
                    ? current_position - previous_position \
                    : 0
                if (step != 1 && step != -1) {
                    step = 0
                }
                if (step != 0 && step == last_step) {
                    run_length++
                } else if (step != 0) {
                    run_length = 2
                } else {
                    run_length = 1
                }
                last_step = step
                if (run_length >= 6) {
                    invalid = 1
                }
                previous_class = current_class
                previous_position = current_position
            }
        }
        END {
            if (invalid) {
                exit 1
            }
        }
    '; then
        return 0
    fi
    return 1
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

if ! printf '%s' "$api_auth_key" | od -An -tu1 | awk '{ for (index_value = 1; index_value <= NF; index_value++) if ($index_value > 127) exit 1 }'; then
    printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY must contain only ASCII characters." >&2
    exit 1
fi

case "$normalized_api_auth_key" in
    replace_with_secure_key|replace_with_strong_bootstrap_key|your-secure-api-key)
        printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is still the example placeholder." >&2
        exit 1
        ;;
esac

if is_weak_api_auth_key "$normalized_api_auth_key"; then
    printf '%s\n' "Refusing to start production Atlas Core image: API_AUTH_KEY is too weak." >&2
    exit 1
fi

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
    admin_password_length="$(printf '%s' "$admin_password" | LC_ALL=C.UTF-8 wc -m | tr -d '[:space:]')"
    if [ "$admin_password_length" -lt 12 ]; then
        printf '%s\n' "Refusing to start production Atlas Core image: ATLAS_ADMIN_PASSWORD must be at least 12 characters." >&2
        exit 1
    fi
fi

exec "$@"
