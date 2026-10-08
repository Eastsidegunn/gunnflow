# Releasing @gunnflow/upstream-port

Published from a built tarball, like `@gunnflow/contract`. Never run a bare `npm publish` in this
directory: `package.json` points at the TypeScript sources for the monorepo, and only `pnpm pack`
applies `publishConfig` (the built `dist/` entry points).

1. **Version.** Bump `version` in `package.json` (semver; in 0.x a minor bump may change the
   interface). If the port starts using contract types from a newer contract line, raise the
   `@gunnflow/contract` peer range in `package.json` too.
2. **Document.** Update [README.md](./README.md) and the repository CHANGELOG. Merge through a pull
   request with green CI.
3. **Pack and check** (on the merged `main`, from the repository root):

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @gunnflow/contract --filter @gunnflow/upstream-port build
   node scripts/pack-check.mjs packages/upstream-port --keep
   ```

   The last command prints the tarball path, e.g.
   `packages/upstream-port/gunnflow-upstream-port-0.1.0.tgz`, and refuses a tarball whose manifest
   is private, points at sources, lacks `dist/`, `README.md` or `LICENSE`, or has no
   `@gunnflow/contract` peer range that admits both 0.3.1 and the current contract version.
4. **Publish.** When the contract changes in the same release, publish the contract tarball first
   (see [../contract/RELEASING.md](../contract/RELEASING.md)), then:

   ```sh
   npm publish packages/upstream-port/gunnflow-upstream-port-<version>.tgz --access public
   ```

5. **Tag:** `git tag upstream-port-v<version> && git push origin upstream-port-v<version>`.
6. **Verify:** `npm view @gunnflow/upstream-port version` shows the new version.
