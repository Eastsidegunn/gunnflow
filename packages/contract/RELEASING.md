# Releasing @gunnflow/contract

The package is published to npm from a built tarball. Never run a bare `npm publish` in this
directory: `package.json` points `main`/`exports` at the TypeScript sources for the monorepo, and
only `pnpm pack` applies `publishConfig` (the built `dist/` entry points). The tarball is what
consumers get, so it is what gets published.

1. **Version.** Bump `version` in `package.json` and `CONTRACT_VERSION` in `src/version.ts` (keep
   them equal; the version test checks it). 0.x is minor-strict: a new surface or a breaking change
   is a minor bump, and consumers must claim the new `major.minor.x`.
2. **Document.** Update [WIRE.md](./WIRE.md) if HTTP behaviour changed, the Versioning list in
   [README.md](./README.md), and the repository CHANGELOG. Merge through a pull request with green CI.
3. **Pack and check** (on the merged `main`, from the repository root):

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @gunnflow/contract build
   node scripts/contract-pack-check.mjs --keep
   ```

   The last command prints the tarball path, e.g. `packages/contract/gunnflow-contract-0.3.1.tgz`,
   and refuses a tarball whose manifest is private, points at sources, lacks `dist/`, `WIRE.md`,
   `README.md` or `LICENSE`, or whose `CONTRACT_VERSION` differs from the package version.
4. **Publish** the checked tarball (npm asks for the one-time password when 2FA is on):

   ```sh
   npm publish packages/contract/gunnflow-contract-<version>.tgz --access public
   ```

5. **Tag** the release commit: `git tag contract-v<version> && git push origin contract-v<version>`.
6. **Verify:** `npm view @gunnflow/contract version` shows the new version, and a fresh
   `npm install @gunnflow/contract` resolves `main` to `dist/index.js`.

The `@gunnflow` scope is an npm organization; publishing needs an account with publish rights on it.
