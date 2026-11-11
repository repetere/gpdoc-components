// Original memory-only lib0 configuration adapter. No browser persistence access.
const values = new Map();
export const varStorage = { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
export const onChange = () => {};
export const offChange = () => {};
