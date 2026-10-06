## What and why

## Checklist

- [ ] `pnpm verify` passes
- [ ] `pnpm e2e` passes, or this change does not touch UI behaviour
- [ ] If the wire or contract changed: `@gunnflow/contract` version bumped (`package.json` + `src/version.ts`), `WIRE.md` updated, conformance covers it, CHANGELOG notes the change
- [ ] No backend proper nouns in core (`apps/`, `packages/`, `testing/`), and no semantic inference added to the UI
- [ ] Screenshots or a recording attached for UI changes
