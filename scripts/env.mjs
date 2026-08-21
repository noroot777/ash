const LEGACY_PREFIX = "HARNESS_";
const CURRENT_PREFIX = "ASH_";

for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith(LEGACY_PREFIX) || value === undefined) continue;
  const currentKey = `${CURRENT_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
  process.env[currentKey] ??= value;
}
