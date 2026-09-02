import "@testing-library/jest-dom/vitest";

// Node 22+ defines its own global `localStorage` accessor (inert unless
// --localstorage-file is passed), and Vitest's jsdom environment skips
// overriding any global key that already exists on globalThis — so
// `localStorage` never gets wired up to jsdom's working implementation.
// Install a minimal in-memory Storage so any test (e.g. Zustand's persist
// middleware) can rely on a real, working localStorage.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

Object.defineProperty(globalThis, "localStorage", {
  value: createMemoryStorage(),
  configurable: true,
  writable: true,
});
