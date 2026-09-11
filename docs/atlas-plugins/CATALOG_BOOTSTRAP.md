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

The bootstrap commit does not itself publish a signed catalog or a Plugin release. The first Building Scan publication
must create epoch 1, sequence 1 and verify the public catalog, signature, release document, and image before Core ships.
The release workflow records the immutable source commit and image digest. Existing bundled Plugins must be disabled
with their matching old CLI before updating Core, then installed from the independent catalog.
