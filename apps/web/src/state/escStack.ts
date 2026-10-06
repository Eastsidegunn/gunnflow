/**
 * Esc ownership: one Esc always means one level. Surfaces that handle Esc
 * themselves (the decision inbox, the notification panel) register on this
 * stack; only the TOP owner acts, and the App's depth ladder is the base
 * owner that acts when the stack is empty. Pure LIFO bookkeeping — relying
 * on listener registration order would be fragile.
 */
export interface EscStack {
  /** Registers an owner on top; the returned release removes it (any order). */
  push(owner: object): () => void;
  isTop(owner: object): boolean;
  isEmpty(): boolean;
  size(): number;
}

export function createEscStack(): EscStack {
  const stack: object[] = [];
  return {
    push(owner) {
      stack.push(owner);
      return () => {
        const at = stack.lastIndexOf(owner);
        if (at >= 0) stack.splice(at, 1);
      };
    },
    isTop: (owner) => stack.length > 0 && stack[stack.length - 1] === owner,
    isEmpty: () => stack.length === 0,
    size: () => stack.length,
  };
}

/** The cockpit's one stack (surfaces and the App ladder share it). */
export const escStack = createEscStack();
