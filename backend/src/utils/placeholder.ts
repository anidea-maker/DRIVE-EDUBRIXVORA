/**
 * Credentials that are actually documentation text.
 *
 * The Google OAuth client in the live database was `<client id>` / `<client
 * secret>` with `https://<new-service>.onrender.com/...` as the redirect: values
 * copied out of a README. Every provider needs the same check, so it lives here.
 */
const PLACEHOLDER_TOKENS = [
  /<[^<>]*>/, // <client id>, <new-service>, <region>
  /\bclient[ _-]?id\b/i,
  /\bclient[ _-]?secret\b/i,
  /\byour[-_.]/i,
  /\bnew-service\b/i,
  /\bexample\.(com|org|net)\b/i,
  /\bchangeme\b/i,
  /\breplace[-_]?with\b/i,
  /\bxxxxxxxx/i,
  /^\s*$/,
]

export function looksLikePlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  return PLACEHOLDER_TOKENS.some((pattern) => pattern.test(value))
}
