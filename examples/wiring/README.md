# examples/wiring/

Example wiring configs for specific backends. Nothing here is loaded by default — Gunnflow
ships no backend vocabulary; without wiring files it shows every emitted term undistorted
(neutral glyph + raw text, default edges, raw-label buttons, ambient attention).

| File | Backend |
| --- | --- |
| `rhizome.example.json` | Vocabulary mapping for a Rhizome direct-wire backend (states, relations, attention causes and groups, node assemblies, lenses, action labels, detail presentation). |

## Using an example

Either copy it into your wiring directory (the file name sets the merge order):

```sh
cp examples/wiring/rhizome.example.json wiring/10-rhizome.json
```

or point the wiring directory at a folder of your choice — `"wiringDir": "<dir>"` in
`gunnflow.config.json`, or the `GUNNFLOW_WIRING_DIR` environment variable. Every `*.json` in that
directory is read and merged in file-name order; see [`wiring/README.md`](../../wiring/README.md)
for the merge rules. Edit your copy freely — the wiring config is yours, the example is a draft.

`pnpm render-sweep --url <backend base URL> --wiring <dir>` reports any term the live backend
emits that your wiring does not cover.
