# Documented Curl Login Can Create a World-Readable Session File

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Curl cookie-jar examples do not set restrictive permissions
3. **Issue:** Documentation examples that save an authenticated Atlas session with `curl -c` do not first establish a restrictive umask or pre-create the cookie jar with owner-only permissions.
4. **Severity:** S4 (Minor)
5. **Location:** `Atlas_Core/docs/API_GUIDE.md` and any other documentation that writes an Atlas session cookie jar under `/tmp`
6. **Expected:** A bearer-equivalent browser session stored for command-line examples should be readable and writable only by its owner.
7. **Actual:** The field-trial cookie jar created under `/tmp` had mode `0644` until it was manually changed to `0600`.
8. **Reproduction:**
   1. Use the documented `curl -c "$COOKIE_JAR"` admin-login flow under a normal shell umask
   2. Inspect the cookie jar with `stat` or `ls -l`
   3. Observe group/other read permissions on the file
9. **Notes:** The trial immediately changed the file to `0600`, logged out, and removed it. Documentation can avoid the exposure by using `umask 077` or securely pre-creating the cookie jar.
