/** Mints a display token once a pinned base is attached with its exact text (retries a few frames). */
import { markRendered, type DisplayToken, type PinnedBase } from '../state/editorLogic.js';

export function onRendered(el: HTMLElement, pinnedBase: PinnedBase, done: (t: DisplayToken | undefined) => void) {
  let tries = 0;
  const attempt = () => {
    const token = markRendered(pinnedBase, el);
    if (token || ++tries > 5) done(token);
    else requestAnimationFrame(attempt);
  };
  queueMicrotask(attempt);
}
