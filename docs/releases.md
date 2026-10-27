# Publishing a CLI release

The public install command uses a CLI-specific website path:

```sh
curl -fsSL https://concentrate.ai/cli/install.sh | bash
```

It downloads built releases from `https://concentrate.ai/downloads/cli/`.
The source repository can remain private. Only the installer, built JavaScript,
documentation, and checksums are distributed publicly.

## Prepare locally

```sh
npm ci
npm run check
npm run release:pack
```

This creates `release/concentrate-cli.tar.gz`, `release/SHA256SUMS`, and
`release/install.sh`. Customers need Node.js 18.18+, but not npm or a source
checkout. The installer verifies the archive before unpacking it, preserves user
configuration, and rolls back the runtime if launcher replacement fails.

## Stage website downloads

Pass the absolute path of the website's existing public directory:

```sh
npm run release:stage -- /absolute/path/to/website/public
```

The script checks the local release checksum and stages:

- `/cli/install.sh`
- `/downloads/cli/latest/concentrate-cli.tar.gz` and `SHA256SUMS`
- `/downloads/cli/v<version>/concentrate-cli.tar.gz` and `SHA256SUMS`

The website must serve these paths without authentication. Once a version has
been published, do not replace its files; increment the package version and
publish a new version instead. Update `latest` with the corresponding archive and
checksum in the same website deployment. Keep older versioned downloads available
for pinned installs. GitHub release assets can also be retained as a mirror.

## Publish and verify

Staging does not deploy the website or push either repository. Publication
requires explicit authorization. After deployment, check the installer, archive,
and checksum URLs without authentication, then run the curl installer in a clean
home. Verify installation, update, pinned-version installation, and preservation
of existing credentials. Do not describe the public installer as live until these
checks pass. Linux validation remains separate and deferred.
