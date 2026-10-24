/** A 53-bit string hash (cyrb53), and two of them, with different seeds, as a
 * 106-bit content name. Streamed, so a name of many texts needs none of them
 * kept: updating with texts one after another names their concatenation.
 * AMR modules cannot reach node:crypto; within a run's caches 106 bits keep
 * distinct contents apart as surely as the artifact store's digests do. */
export function hasher(seed = 0) {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  return {
    update(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      return this;
    },
    digest() {
      const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
      return 4294967296 * (2097151 & b) + (a >>> 0);
    },
  };
}
export const hash53 = (text, seed = 0) => hasher(seed).update(text).digest();

/** A 106-bit name for a sequence of texts, as two base-36 halves. */
export function contentName(texts) {
  const first = hasher(0),
    second = hasher(1);
  let length = 0;
  for (const text of texts) {
    first.update(text).update('\u0000');
    second.update(text).update('\u0000');
    length += text.length + 1;
  }
  return `${first.digest().toString(36)}${second.digest().toString(36)}.${length.toString(36)}`;
}
