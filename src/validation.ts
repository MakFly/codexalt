const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const RESERVED_ALIASES = new Set([
  "account", "use", "run", "default", "doctor", "shell", "completion", "help", "version",
]);

export function validateAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error("Alias must match [a-z0-9][a-z0-9_-]{0,31}.");
  }
  if (RESERVED_ALIASES.has(alias)) throw new Error(`Alias '${alias}' is reserved.`);
  return alias;
}

export function validateLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) throw new Error("Account label cannot be empty.");
  if (Array.from(normalized).length > 80) throw new Error("Account label must be 80 characters or fewer.");
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("Account label cannot contain control or invisible formatting characters.");
  }
  return normalized;
}
