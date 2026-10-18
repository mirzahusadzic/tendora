/** Terminal-independent pane geometry. Rows are already styled and wrapped. */
const blank = () => ({ text: '', tone: 'plain', indent: 0 });

/** Page by visible items, retaining one item of overlap even when labels wrap. */
export const pageStep = (hits = [], identity = 'id') =>
  Math.max(1, new Set(hits.map((hit) => hit[identity])).size - 1);

/** A one-column thumb over the scrollable rows, with clamped end positions. */
export function scrollThumb(total, visible, offset) {
  if (visible <= 0 || total <= visible) return null;
  const size = Math.max(1, Math.floor((visible * visible) / total));
  const start = Math.round(
    (Math.max(0, Math.min(total - visible, offset)) / (total - visible)) * (visible - size),
  );
  return { start, size };
}

export function sidebarSize(width, preferred = null) {
  if (width < 76) return 0;
  return Math.min(width - 42, Math.max(24, preferred ?? Math.min(34, Math.floor(width * 0.348))));
}

/** Fit columns to their contents. Width hints are reading minima, never fixed caps. */
export function tableWidths(table, width, measure) {
  const { headers } = table;
  // Related groups can share measured columns without repeating their rows.
  const entries = table.sizingEntries ?? table.entries;
  const lineWidth = (value) =>
    Math.max(
      0,
      ...String(value ?? '')
        .split('\n')
        .map(measure),
    );
  const natural = headers.map((header, column) =>
    Math.max(1, lineWidth(header), ...entries.map((entry) => lineWidth(entry.cells[column]))),
  );
  const available = width - 3 * (headers.length - 1);
  const sizes = natural.map((size, column) =>
    Math.min(size, table.widths?.[column] ?? Math.max(8, Math.min(20, lineWidth(headers[column])))),
  );
  let remaining = available - sizes.reduce((sum, size) => sum + size, 0);
  if (remaining < 0) return null;
  // Give the next column to the content facing the most wrapping. Stop when all
  // content fits, leaving surplus space outside the table instead of in empty cells.
  while (remaining > 0) {
    let target = -1,
      pressure = 0;
    for (let i = 0; i < sizes.length; i++) {
      const next = natural[i] / sizes[i];
      if (sizes[i] < natural[i] && next > pressure) {
        target = i;
        pressure = next;
      }
    }
    if (target < 0) break;
    sizes[target]++;
    remaining--;
  }
  return sizes;
}

/** Editable visual lines retain character offsets, including spaces and newlines. */
export function editorLines(value, width, measure) {
  const chars = Array.from(value),
    lines = [];
  let start = 0,
    columns = 0,
    wordBreak = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') {
      lines.push({ start, end: i, text: chars.slice(start, i).join('') });
      start = i + 1;
      columns = 0;
      wordBreak = start;
    } else {
      const size = measure(chars[i]);
      if (columns + size > width && i > start) {
        const end = wordBreak > start ? wordBreak : i;
        lines.push({ start, end, text: chars.slice(start, end).join('') });
        start = end;
        columns = 0;
        wordBreak = start;
        i = start - 1;
        continue;
      }
      columns += size;
      if (/\s/u.test(chars[i])) wordBreak = i + 1;
    }
  }
  lines.push({ start, end: chars.length, text: chars.slice(start).join('') });
  return lines;
}

export function editorCursor(field, key, width, measure) {
  const lines = editorLines(field.value, width, measure);
  const at = lines.findLastIndex((line) => line.start <= field.cursor);
  const current = lines[at];
  if (key === 'HOME') return current.start;
  // A soft-wrap endpoint belongs to the next visual line.
  const end = (line, index) =>
    lines[index + 1]?.start === line.end ? Math.max(line.start, line.end - 1) : line.end;
  if (key === 'END') return end(current, at);
  const targetIndex = at + (key === 'UP' ? -1 : 1);
  const target = lines[targetIndex];
  if (!target) return field.cursor;
  const chars = Array.from(field.value);
  field.column ??= measure(chars.slice(current.start, field.cursor).join(''));
  let cursor = target.start,
    columns = 0;
  while (cursor < end(target, targetIndex) && columns + measure(chars[cursor]) <= field.column)
    columns += measure(chars[cursor++]);
  return cursor;
}

export function layoutPane({
  height,
  header = [],
  content = [],
  pinned = [],
  offset = 0,
  selectedIndex = null,
  selectedEndIndex = selectedIndex,
  selectedContextIndex = null,
  minimumContentRows = 4,
  overflow = null,
  groupStarts = [],
}) {
  const innerHeight = Math.max(0, height - 2);
  const headings = header.slice(0, Math.max(0, innerHeight - 1));
  // Metadata must not squeeze the reading area down to a single line.
  const minimumContent = Math.min(minimumContentRows, Math.max(1, innerHeight - headings.length));
  const pinLimit = Math.max(0, innerHeight - headings.length - minimumContent - 1);
  const bottom = pinned.slice(0, pinLimit);
  if (pinned.length > bottom.length && bottom.length) {
    const last = bottom.at(-1);
    bottom[bottom.length - 1] = overflow ?? { ...last, text: last.text + '…' };
  }
  const visibleRows = Math.max(
    0,
    innerHeight - headings.length - bottom.length - (bottom.length ? 1 : 0),
  );
  const maxOffset = Math.max(0, content.length - visibleRows);
  let start = Math.max(0, Math.min(offset, maxOffset));
  if (
    selectedContextIndex !== null &&
    selectedContextIndex >= 0 &&
    selectedContextIndex < selectedIndex &&
    selectedEndIndex - selectedContextIndex < visibleRows
  )
    selectedIndex = selectedContextIndex;
  if (selectedIndex !== null && visibleRows) {
    if (selectedIndex < start) start = selectedIndex;
    const end = selectedEndIndex - selectedIndex < visibleRows ? selectedEndIndex : selectedIndex;
    if (end >= start + visibleRows) start = end - visibleRows + 1;
    start = Math.max(0, Math.min(start, maxOffset));
  }
  // Avoid beginning a list with the previous item's detached scope or wrapped tail.
  const nextGroup = groupStarts.find((index) => index >= start);
  if (nextGroup !== undefined && selectedIndex !== null && nextGroup <= selectedIndex)
    start = nextGroup;
  const visible = content.slice(start, start + visibleRows);
  let tail = visible.findLastIndex((row) => row.text?.trim());
  if (visible[tail]?.keepWithNext) {
    while (tail > 0 && (visible[tail - 1].keepWithNext || !visible[tail - 1].text?.trim())) tail--;
    if (tail > 0) visible.splice(tail);
  }
  const rows = [...headings, ...visible];
  while (rows.length < innerHeight - bottom.length) rows.push(blank());
  rows.push(...bottom);
  return { rows, visibleRows, offset: start, maxOffset: Math.max(start, maxOffset) };
}

export function layoutFooter({ width, actions, reserve, pack, statusWidth = 16 }) {
  const actionWidth = Math.max(1, width - statusWidth);
  const rows = pack(actions.filter(Boolean), Math.max(1, actionWidth - 2));
  const capacity = Math.max(rows.length, pack(reserve, Math.max(1, actionWidth - 2)).length);
  // Empty slots stay above the controls, keeping shortcuts and status at the bottom.
  return { rows: [...Array(capacity - rows.length).fill(''), ...rows], actionWidth, statusWidth };
}
