# Source connectors own access mechanics, not domain data

1. **Time & Date:** 2026-08-24 22:57 EDT
2. **Name:** Source connectors centralize external access without normalizing vendor data
3. **Context:** Plugins need consistent access to external APIs, including secrets, outbound restrictions, timeouts, caching, rate limits, retries, and status. A universal external-data model would have to reproduce the different semantics of every source inside Core.
4. **Decision:** Atlas Source connectors own shared access mechanics. Plugins own source-specific requests, parsing, normalization, and result types. An external API is never exposed directly as an Atlas Datastream. A Plugin must interpret it first.
5. **Alternatives considered:** Letting every Plugin manage credentials and network policy was rejected because it duplicates security and operational behavior. Normalizing every external API into one Atlas data model was rejected because the shared interface would grow with every vendor and hide little complexity.
6. **Consequences:** The Source Gateway needs a source-configuration and secret model, but Core does not need schemas for every vendor payload. Connector policy must support provider replacement, and Plugin results must carry enough provenance and freshness information for callers to judge them.
7. **Location:** `docs/atlas-plugins/`, future Source connector and Plugin contracts
