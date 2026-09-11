# Production catalog bootstrap

On 2026-09-11, the operator authorized preparation and publication of Building Scan 0.1.0 and Atlas Core 0.2.0.

- Generated a fresh Ed25519 key with the repository key generator in a local subprocess. Private material was held in
  memory outside repository files and passed directly to GitHub secret storage through stdin; it was not printed or saved
  to disk. No test key was reused.
- Stored the private PEM as `ATLAS_PLUGIN_CATALOG_PRIVATE_KEY` in the dedicated `plugin-catalog` environment.
- Set environment variables `ATLAS_PLUGIN_CATALOG_KEY_ID=atlas-plugin-catalog-2026-09` and
  `ATLAS_PLUGIN_CATALOG_KEY_EPOCH=1`. The CLI trust file records the matching public key, epoch 1, and sequence floor 1.
- Restricted that environment to branch `main` and tags `atlas-plugin-*-v*`, without a required reviewer so weekly renewal
  can run. The release, renewal, and revocation workflows use this environment for signing.
- Initialized an orphan `plugin-catalog` ledger branch. Active rulesets forbid ledger deletion and non-fast-forward
  updates, and forbid deletion or updates of published `atlas-plugin-*-v*` tags.
- Enabled GitHub Pages with Actions deployment at `https://the-drunken-coder.github.io/Atlas-Modernization/`.
- Verified locally that the private key matches the committed public trust entry using the publisher preflight.

## Publication verification

- [Building Scan 0.1.0](https://github.com/the-Drunken-coder/Atlas-Modernization/releases/tag/atlas-plugin-building_scan-v0.1.0)
  was published from `dbf9f46db4fb841103dd90146a9beab41a4589a2`. Both candidate platforms passed. The stable catalog
  published epoch 1, sequence 1, and its signature and release-document hash were independently verified.
- [Atlas Core 0.2.0](https://github.com/the-Drunken-coder/Atlas-Modernization/releases/tag/atlas-core-v0.2.0)
  was published from `511aa2ec565cfeb5baa5911818effcb9b48ca490`. The exact packaged CLI passed disposable-host acceptance.
  npm accepted the package but registry processing exceeded the original one-minute verification window. Recovery from
  the unchanged tag verified the matching package integrity, signatures, and provenance and completed GitHub publication.
- [The successful recovery run](https://github.com/the-Drunken-coder/Atlas-Modernization/actions/runs/34627237562)
  records final publication evidence. npm's `latest` tag was verified as `0.2.0`.

Existing bundled Plugins must be disabled with their matching old CLI before updating Core, then installed from the
independent catalog. Weekly catalog renewal is enabled through `publish-plugin-catalog.yml`.
