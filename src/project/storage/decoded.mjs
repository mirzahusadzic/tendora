/** Stored data is decoded within a bound: a damaged or hostile store cannot
 * make a read allocate without limit before its hash is checked, and what
 * could not be read back is never written. The largest real block, run,
 * fragment or artifact is a few MB; the bound is 256 MiB. */
import { brotliDecompressSync } from 'node:zlib';

export const decodedLimit = 256 * 1024 * 1024;

const tooLarge = (what) =>
  Object.assign(
    new Error(`${what} decodes to more than 256 MiB: the store is damaged or not Tendora's.`),
    { code: 'STORE_LIMIT' },
  );

export function decompress(payload, what) {
  try {
    return brotliDecompressSync(payload, { maxOutputLength: decodedLimit });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(what);
    throw error;
  }
}

/** A running total for a value read from many stored parts. */
export function decodedBudget(what) {
  let used = 0;
  return (bytes) => {
    used += bytes;
    if (used > decodedLimit) throw tooLarge(what);
  };
}

export function writable(bytes, what) {
  if (bytes > decodedLimit) throw new Error(`${what} is over 256 MiB and cannot be stored.`);
}
