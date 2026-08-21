const CURRENT_PREFIX = "ash:";
const LEGACY_PREFIX = "harness-next:";

export function readRenamedStorage(key: string): string | null {
  const current = window.localStorage.getItem(key);
  if (current !== null || !key.startsWith(CURRENT_PREFIX)) return current;
  const legacyKey = `${LEGACY_PREFIX}${key.slice(CURRENT_PREFIX.length)}`;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy === null) return null;
  window.localStorage.setItem(key, legacy);
  window.localStorage.removeItem(legacyKey);
  return legacy;
}
