/** Keep a terminal paste as one text edit; embedded newlines never become commands. */
const start = Buffer.from('\x1b[200~'),
  end = Buffer.from('\x1b[201~');
export function createPasteDecoder(onData, onPaste) {
  let pending = Buffer.alloc(0),
    pasting = false,
    timer;
  function flush() {
    clearTimeout(timer);
    if (!pasting && pending.length) {
      const bytes = pending;
      pending = Buffer.alloc(0);
      onData(bytes);
    }
  }
  function input(bytes) {
    clearTimeout(timer);
    pending = Buffer.concat([pending, bytes]);
    while (pending.length) {
      const marker = pasting ? end : start,
        at = pending.indexOf(marker);
      if (at >= 0) {
        const value = pending.subarray(0, at);
        pending = pending.subarray(at + marker.length);
        if (pasting) onPaste(value.toString('utf8'));
        else if (value.length) onData(value);
        pasting = !pasting;
        continue;
      }
      if (pasting) return;
      let keep = Math.min(pending.length, start.length - 1);
      while (keep && !pending.subarray(pending.length - keep).equals(start.subarray(0, keep)))
        keep--;
      const value = pending.subarray(0, pending.length - keep);
      pending = pending.subarray(pending.length - keep);
      if (value.length) onData(value);
      if (keep) timer = setTimeout(flush, 20);
      return;
    }
  }
  return {
    input,
    dispose() {
      clearTimeout(timer);
      pending = Buffer.alloc(0);
    },
  };
}
export function installPaste(term, onPaste) {
  if (!term.onStdin) return () => {};
  const original = term.onStdin,
    decoder = createPasteDecoder(original, onPaste);
  term.onStdin = decoder.input;
  return () => {
    decoder.dispose();
    term.onStdin = original;
  };
}
