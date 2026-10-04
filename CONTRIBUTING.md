# Contribute a plugin or catalog update

Use a pull request. PR checks have read-only repository permissions and run local fixtures or mocked HTTP, never user credentials, OAuth flows, or paid generation.

## Change a first-party package

1. Run `npm ci --ignore-scripts`.
2. Edit the package under `plugins/official/<id>/`, preserving its license and notices.
3. If published runtime bytes change, increase that package's `kimi.plugin.json` version. Changing a description only in `plugins/marketplace.json` does not require repackaging.
4. Run `npm run check -- <id>` and `npm test`.

For shared media changes, edit `media-runtime/`, run `node plugins/official/media-runtime/distribute.mjs`, and increase every provider version whose published bytes changed. CI maps shared source changes to all ten providers. Do not edit their generated `runtime.mjs`, `entry.mjs`, `LICENSE`, or `NOTICE` copies directly.

The runtime ZIP whitelist includes the manifest, runtime entry/adapters, panel, icon, README, license/notices, `lib/`, `skills/`, and `vendor/`. It excludes tests, scripts, development dependency manifests, caches, and node_modules. Adding a new runtime location requires updating and testing `scripts/package-files.mjs`.

Extract vendor changes must preserve the fixed runtime lock and notices. Run `npm ci --ignore-scripts --prefix plugins/official/kiki-extract/runtime`, then `node plugins/official/kiki-extract/scripts/build-vendor.mjs`, and inspect the vendor diff before proposing a new Extract version.

## Propose a third-party entry

Keep source with its author. Add a catalog entry with a unique ID, display name, purpose, real author, license, homepage, version, and compatible source locator. Use either an author-hosted ZIP plus SHA-256 or a GitHub URL ending in `/commit/<40-character-sha>`. Do not use a monorepo subdirectory URL as an install package.

Include `compatibility.status`, `compatibility.format`, and `compatibility.notes`. Record what was checked and what still needs authorization or dependencies; do not label an untested import compatible. Kiki's preview exposes imported contributions and unsupported diagnostics. Catalog validation does not execute third-party installer scripts.

Do not mirror proprietary code or replace an upstream notice with this repository's MIT license. An upstream mutable ZIP must retain the inspected digest: if the author changes it, the old entry fails closed until a catalog update verifies and records the new bytes/version.

## Update the SDK

The SDK's only source is `X-T-E-R/kiki/packages/plugin-sdk`. Select an exact public Kiki ref, build and pack only that package with the locked compiler, include its original license, and update the artifact, `sdk.lock.json`, and npm lock together. Update the CI sparse-checkout ref and checksum-pinned Host runner when the contract changes. `scripts/verify-sdk.mjs` compares the installed SDK's exports and compiled files with the fixed upstream build.

Keep SDK package versions, plugin engine ranges, and Kiki product versions separate. New Host capabilities must be available before a plugin requiring them is published.
