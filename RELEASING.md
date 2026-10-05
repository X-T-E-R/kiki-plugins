# Publish plugin packages and the catalog

Use the **Publish plugins** workflow on a tested `main` commit. The repository's own GitHub Releases store ZIPs; its own GitHub Pages site stores the catalog and icons. No Kiki main-site artifact is deployed by this workflow.

## Publish a batch

1. Ensure Plugin CI passed and every changed published package has a higher manifest version.
2. Enable this repository's Pages source as **GitHub Actions** in repository settings.
3. Run **Publish plugins** on `main`, choosing a new batch tag or leaving it blank for `plugins-<run-number>`.
4. Check both Release and Pages jobs, then read the public catalog and install a checksum-pinned package in a temporary Kiki home.

Batch tags do not set plugin versions. The release tool loads the **latest successful public Release catalog**, compares runtime input digests, and reuses unchanged packages' old URL and checksum. Thus a metadata-only release creates no new ZIP. A changed `id@version` is refused, including changes introduced by shared runtime distribution. Previous versions and tags are never overwritten or deleted by the tooling.

The tool creates a draft, uploads missing assets without clobbering, downloads the uploaded bytes for checksum comparison, then publishes. It anonymously downloads and verifies every referenced first-party ZIP before producing the Pages artifact. Before publication, it restores previous versioned icons from checksum-verified historical ZIPs, including packages no longer listed, and refuses to overwrite different icon bytes. Pages switches the catalog and new icons together, after the packages exist, while retaining the old icon URLs. Ordinary PR jobs have only `contents: read`; only the release job gets `contents: write`, and only the Pages job gets `pages: write` and `id-token: write`.

Publication is serialized. The candidate must descend from the latest public catalog revision, and the Pages job refuses a stale revision before deployment. A rerun of an already public batch must match its catalog exactly; otherwise publish a new tag.

## Recover a failed publication

- **Draft upload failure:** rerun the same workflow. Existing draft assets must match the candidate checksums; missing ones are uploaded without replacing others. If the source or version changes, use a new tag.
- **Published Release, failed Pages:** the ZIPs remain available and the previous Pages catalog continues to work. Rerun the failed Pages job while that Release is still latest, or publish a new batch. The next batch loads the published Release snapshot rather than losing its version history.
- **Bad package:** stop recommending it through a catalog PR, publish a corrected higher version, and retain the old asset for installed-user rollback. Catalog removal does not uninstall user plugins.

Do not replace a public ZIP, force-move a tag, publish npm packages as part of this flow, or deploy this plugin-only site to the Kiki main repository's Pages target.
