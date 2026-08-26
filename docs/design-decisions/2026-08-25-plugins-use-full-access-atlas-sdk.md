# Plugins use the full-access Atlas SDK

1. **Time & Date:** 2026-08-25 11:35 EDT
2. **Name:** Plugin code owns its safety and calls Core through the ordinary full-access Atlas SDK
3. **Context:** Plugins need Atlas reads and mutations. Core could add Plugin-specific identities and capability enforcement, provide a separate narrow Plugin client, or treat trusted Plugins like existing machine clients.
4. **Decision:** Plugin code uses the ordinary Atlas SDK. All Plugins share one full-access Plugin API key supplied through deployment configuration. Core applies its normal authentication, request validation, idempotency, persistence, and Task rules, but adds no Plugin-specific capability system. Plugin code owns which SDK methods it calls and the safety of its actions. Plugins never access Atlas storage directly.
5. **Alternatives considered:** Scoped Plugin capabilities were rejected because the trusted, single-developer deployment does not justify another authorization model. A separate Plugin client was rejected because it would duplicate SDK transport and resource behavior. Direct database access was rejected because it bypasses Core's resource and Task rules.
6. **Consequences:** The existing full-access managed API key model can support Plugins without Core auth changes. A faulty Plugin can mutate unrelated Atlas data, and that risk is accepted. Compromise of one Plugin exposes the shared Plugin key and therefore the same access as every Plugin. Atlas does not add Plugin provenance or audit records.
7. **Location:** `docs/atlas-plugins/`, `atlas_sdk/`, existing Core managed API key configuration
