/**
 * Focus scope (S-05): opening a drawer or modal moves focus to its first
 * focusable control; closing returns focus to the element that opened it; a
 * modal additionally traps Tab inside itself. View machinery only.
 */
export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Whether a closed surface may restore focus: only when nothing else took it.
 * Another surface that already focused itself (e.g. a ③ overlay's trap) owns
 * the focus now — stealing it back would strand the keyboard.
 */
export function shouldRestoreFocus(active: Element | null, body: Element | null): boolean {
  return !active || active === body;
}

/**
 * Whether a non-modal surface may take a key whose target is `target`: focus
 * is inside the surface, or on nothing in particular (the body / no target).
 */
export function keyOwnerFocus(target: Node | null, root: Pick<Node, 'contains'> | null, body: Node | null): boolean {
  if (target === null || target === body) return true;
  return root !== null && root.contains(target);
}

/** Call on mount; the returned cleanup restores focus (when the opener still exists). */
export function manageFocus(el: HTMLElement, opts: { trap?: boolean } = {}): () => void {
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  focusables(el)[0]?.focus();
  const onKey = (e: KeyboardEvent) => {
    if (!opts.trap || e.key !== 'Tab') return;
    const f = focusables(el);
    if (f.length === 0) return;
    const at = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && at <= 0) {
      e.preventDefault();
      f[f.length - 1]!.focus();
    } else if (!e.shiftKey && at === f.length - 1) {
      e.preventDefault();
      f[0]!.focus();
    }
  };
  el.addEventListener('keydown', onKey);
  return () => {
    el.removeEventListener('keydown', onKey);
    if (!prev) return;
    const tid = prev.getAttribute('data-testid');
    // Restore AFTER the surface's DOM is gone (removal order varies), and
    // survive a re-rendered opener by falling back to its testid successor.
    setTimeout(() => {
      if (!shouldRestoreFocus(document.activeElement, document.body)) return;
      if (prev.isConnected) prev.focus();
      else if (tid) document.querySelector<HTMLElement>(`[data-testid="${tid}"]`)?.focus();
    }, 0);
  };
}
