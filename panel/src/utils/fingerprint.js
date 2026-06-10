// Log line "fingerprint": a normalized template where variable parts (numbers,
// IPs, UUIDs, hex, timestamps, quoted values, paths) are replaced by tokens.
// Two lines that differ only in their variables share a fingerprint, which lets
// us cluster millions of lines into a handful of patterns — no ML needed.

const RULES = [
  [/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TIME>'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<TIME>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<IP>'],
  [/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, '<IPV6>'],
  [/\b0x[0-9a-fA-F]+\b/g, '<HEX>'],
  [/\b[0-9a-fA-F]{16,}\b/g, '<HEX>'],
  [/"[^"]*"/g, '<STR>'],
  [/'[^']*'/g, '<STR>'],
  [/\/[\w./-]+/g, '<PATH>'],
  // No word boundaries — also normalizes numbers glued to units, e.g. "23ms".
  [/\d+(?:\.\d+)?/g, '<NUM>'],
];

export function fingerprint(message) {
  if (!message) return '';
  let s = String(message);
  for (const [re, token] of RULES) s = s.replace(re, token);
  // Collapse whitespace and cap length so the template is a stable key.
  s = s.replace(/\s+/g, ' ').trim().slice(0, 300);
  return s;
}
