// Minimal observable store around the pure reducer.

import { persistable, reducer } from './state.js';

export function createStore(initial, { onPersist } = {}) {
  let state = initial;
  const listeners = new Set();

  return {
    get: () => state,
    dispatch(action) {
      const prev = state;
      state = reducer(state, action);
      if (state === prev) return;
      const before = persistable(prev);
      const after = persistable(state);
      if (onPersist && JSON.stringify(before) !== JSON.stringify(after)) onPersist(after);
      listeners.forEach((fn) => fn(state, prev, action));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
