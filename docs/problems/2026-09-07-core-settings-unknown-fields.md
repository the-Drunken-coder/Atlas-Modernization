1. **Time & Date:** 2026-09-07T20:51:16Z
2. **Name:** Core settings silently ignore misspelled keys
3. **Issue:** The general settings-file loader accepts unrecognized keys without an error or diagnostic. An operator can supply an intended limit that Core silently replaces with its default.
4. **Severity:** S4 (Minor)
5. **Location:** `services/core/internal/config/settings.go:12-40`, `services/core/internal/config/environment.go:53`, and `services/core/internal/config/config.go:60-81`.
6. **Expected:** Report an unrecognized settings key so the operator can correct it before treating the configuration as accepted. Preserve environment-variable precedence and the existing validation of recognized settings.
7. **Actual:** `loadSettingsFile` uses `json.Unmarshal` into `SettingsFile`, which discards unknown fields. In an isolated execution of `config.Load`, `{"max_view_size_mb":7}` applied 7 MB, while `{"max_view_size_mib":7}` returned no error and retained the default 10 MB. The recognized invalid value `{"max_view_size_mb":-1}` correctly returned a validation error.
8. **Reproduction:**
   1. Use a disposable `config_test` Go test with the existing `chdirToTemp(t)` and `isolateLoadEnv(t)` helpers. Keep `ATLAS_PLUGIN_CONFIG_DIR` unset. Run only configuration loading; do not start Core or connect to storage.
   2. Write `{"max_view_size_mib":7}` to `atlas_core.settings.json` in that temporary directory with mode `0600`, call `config.Load()`, and inspect its error and `MaxViewSizeMB`. The error is nil and the value is 10.
   3. Repeat with `{"max_view_size_mb":7}` and then `{"max_view_size_mb":-1}`. The first applies 7; the second fails validation.
   4. The executed probe used a disposable Go overlay test named `TestReviewF14aUnknownSettings` and `go test -overlay=<overlay.json> -count=1 -v -run '^TestReviewF14aUnknownSettings$' ./internal/config` from `services/core`.
9. **Notes:** Source finding F14a, review section 14, verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. All three probe cases and the existing config race tests passed, confirming the behavior above. Other configuration formats already reject unknown fields, including Plugin endpoint fragments. The general settings documentation does not currently promise strict decoding; this report records missing operator feedback, not a claimed violation of that promise or a demonstrated security failure. Correcting the key is a straightforward workaround. Delete this note when fixed or invalidated.
