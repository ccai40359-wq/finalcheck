// generic checksum helpers, unrelated to credentials
export function shortHash(s) {
  return sha1(s).slice(0, 8);
}
