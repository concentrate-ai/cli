# Publishing a release

Releases are built and published by GitHub Actions. The installer
(`install.sh`) downloads them from GitHub Releases and verifies a SHA-256
checksum before installing, so no website hosting is needed.

## Cut a release

1. Set `version` in `package.json` (and `package-lock.json`) and merge to `main`.
2. Check locally:

   ```sh
   npm ci
   npm run check
   npm run release:pack
   ```

   `release:pack` creates `release/concentrate-cli.tar.gz`, `release/SHA256SUMS`,
   and `release/install.sh`. Customers need Node.js 18.18+, but not npm or a
   source checkout.

3. Tag and push. The tag must match the version:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

   The `Release CLI` workflow runs the checks, builds the package, and publishes
   `concentrate-cli.tar.gz`, `SHA256SUMS`, and `install.sh` as release assets.

## How users install

```sh
curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | CN_INSTALL_VERSION=0.1.0 bash
```

The first form installs the latest release (`releases/latest/download`). The
second installs a pinned version (`releases/download/v0.1.0`). The installer
verifies the archive before unpacking it, preserves user configuration, and
rolls back the runtime if replacing the launcher fails.

Do not change a published version's assets. Publish a new version instead.
