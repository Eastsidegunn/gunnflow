// Peer-range checks for scripts/pack-check.mjs: the only range form a published package uses is
// caret ranges, optionally joined by `||` (e.g. `^0.3.1 || ^0.4.0`). Anything else is refused.

/**
 * `^M.m.p` admits `v`, as semver's caret: `^0.0.p` only `0.0.p` itself; `^0.m.p` (m > 0) the same
 * minor with patch >= p; `^M.m.p` (M > 0) the same major at or above m.p.
 */
export function caretAdmits(range, v) {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const x = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!r || !x) return false;
  const [rM, rm, rp] = r.slice(1).map(Number);
  const [xM, xm, xp] = x.slice(1).map(Number);
  if (rM !== xM) return false;
  if (rM === 0 && rm === 0) return xm === 0 && xp === rp;
  if (rM === 0) return rm === xm && xp >= rp;
  return xm > rm || (xm === rm && xp >= rp);
}

/** `^a || ^b || …` admits `v` when any caret part does; a range with any other part admits nothing. */
export function rangeAdmits(range, v) {
  const parts = range.split('||').map((s) => s.trim());
  if (parts.some((p) => !/^\^\d+\.\d+\.\d+$/.test(p))) return false;
  return parts.some((p) => caretAdmits(p, v));
}
