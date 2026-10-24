/** Text measurement, wrapping and ANSI styling; no terminal lifecycle or application state. */
import terminalKit from 'terminal-kit';
import { editorLines, tableWidths } from './layout.mjs';
import { sliceHighlights } from '../recordings/view.mjs';

export function createText({ noColor = false } = {}) {
  // Explicit RGB colors keep contrast consistent with either Ghostty theme.
  const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
  const background = '\x1b[48;2;16;20;28m';
  const sidebar = '\x1b[48;2;26;33;45m';
  // A row under the pointer: lighter than the sidebar, darker than a selection.
  const hoverBand = '\x1b[48;2;36;46;62m';
  const sourceBand = sidebar;
  const inquiryBand = '\x1b[48;2;31;39;53m';
  const historyBand = inquiryBand;
  const headerBand = '\x1b[48;2;28;39;57m';
  function progressHeader(text, width, now = performance.now(), spans = []) {
    // A continuous eased sweep with a soft falloff, rather than a block stepping
    // one cell at a time. Only the background changes; text stays stationary.
    const radius = Math.max(10, width * 0.12);
    const center = -radius + ((width + radius * 2) * (1 - Math.cos((now * Math.PI) / 2800))) / 2;
    let column = 0;
    let offset = 0;
    return Array.from(text)
      .map((char) => {
        const distance = Math.abs(column - center) / radius;
        const glow = distance < 1 ? (1 + Math.cos(distance * Math.PI)) / 2 : 0;
        const shade = [28, 39, 57].map((base, i) => Math.round(base + [19, 29, 39][i] * glow));
        column += terminalKit.stringWidth(char);
        const tone =
          spans.find((span) => span.start <= offset && span.end > offset)?.tone ?? 'plain';
        offset += char.length;
        return paint(char, tone, `\x1b[48;2;${shade.join(';')}m`);
      })
      .join('');
  }
  const titleRgb = [139, 180, 255];
  const scrollbarRgb = [215, 167, 242];
  const colors = {
    border: rgb(76, 89, 112),
    focusBorder: rgb(138, 157, 184),
    inactiveBorder: rgb(40, 48, 64),
    plain: rgb(218, 226, 239),
    muted: rgb(174, 188, 208),
    title: rgb(...titleRgb) + '\x1b[1m',
    scrollbar: rgb(...scrollbarRgb) + '\x1b[1m',
    scrollbarTrack: rgb(...scrollbarRgb),
    section: rgb(...titleRgb) + '\x1b[1m',
    subheading: rgb(218, 226, 239) + '\x1b[1m',
    located: rgb(239, 200, 126),
    input: rgb(230, 236, 246) + '\x1b[1m',
    open: rgb(184, 196, 214),
    warning: rgb(215, 167, 242),
    error: rgb(255, 175, 160),
    selected: '\x1b[48;2;44;65;96m' + rgb(215, 225, 241) + '\x1b[1m',
    heading: rgb(214, 222, 233) + '\x1b[1m',
    binding: rgb(168, 220, 183) + '\x1b[4m',
  };
  const clean = (value) =>
    String(value ?? '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
      .replace(/\t/gu, '  ');
  const bindingInk = (index) => {
    const palette = [
      [168, 220, 183],
      [224, 182, 220],
      [175, 202, 244],
      [232, 196, 161],
    ];
    const color =
      palette[index] ??
      [0, 2, 4].map((shift) => Math.round(198 + 38 * Math.sin(index * 2.39996 + shift)));
    return rgb(...color) + '\x1b[4m';
  };
  const editorMeasure = (text) => terminalKit.stringWidth(clean(text));
  const fit = (value, width) => {
    const text = clean(value);
    const clipped =
      terminalKit.stringWidth(text) > width
        ? terminalKit.truncateString(text, Math.max(0, width - 1)) + (width ? '…' : '')
        : text;
    return clipped + ' '.repeat(Math.max(0, width - terminalKit.stringWidth(clipped)));
  };
  const paint = (text, tone = 'plain', surface = background, marks = {}) => {
    if (noColor) return text;
    if (tone === 'selected' && !marks.selectionInsetApplied) {
      let inset = Math.min(text.length, marks.selectionInset ?? text.match(/^ */u)[0].length);
      if (!marks.field) inset += text.slice(inset).match(/^[●›▶▸·→←↔] /u)?.[0].length ?? 0;
      return (
        paint(text.slice(0, inset), 'plain', surface) +
        paint(text.slice(inset), tone, surface, {
          ...marks,
          selectionInsetApplied: true,
          spans: sliceHighlights(marks.spans, inset, text.length),
        })
      );
    }
    if (marks.shortcutSpans?.length) {
      let output = '',
        at = 0;
      for (const span of marks.shortcutSpans) {
        const end = Math.min(text.length, span.end);
        if (span.start >= text.length) break;
        output +=
          paint(text.slice(at, span.start), 'muted', surface) +
          paint(text.slice(span.start, end), 'input', surface);
        at = end;
      }
      return output + paint(text.slice(at), 'muted', surface);
    }
    if (marks.spans?.length) {
      let result = '',
        at = 0;
      for (const span of sliceHighlights(marks.spans, 0, text.length).sort(
        (a, b) => a.start - b.start,
      )) {
        if (span.start < at) continue;
        result +=
          paint(text.slice(at, span.start), tone, surface) +
          (span.tone
            ? paint(text.slice(span.start, span.end), span.tone, surface)
            : `${surface}${colors[tone] ?? (tone === 'alternative' ? colors.muted : colors.plain)}${bindingInk(span.color)}${text.slice(span.start, span.end)}\x1b[0m`);
        at = span.end;
      }
      return result + paint(text.slice(at), tone, surface);
    }
    if (tone === 'alternative') {
      return `${surface}${colors.muted}${text.replace('≠', `${colors.warning}≠${colors.muted}`)}\x1b[0m`;
    }
    if (tone === 'event-label') {
      const colored = text.replace(
        /(PARSED EVENT )(\S+ \[[^\]]+\])/u,
        (_, label, value) =>
          `${colors.muted}${label}${colors.selected}${value}\x1b[0m${surface}${colors.plain}`,
      );
      return `${surface}${colors.plain}${colored}\x1b[0m`;
    }
    if (tone === 'amr' || tone === 'amr-event') {
      const bindingNodes = marks.nodes ?? [];
      const eventId = tone === 'amr-event' ? (marks.eventNodeId ?? null) : null;
      const base =
        /\([^\s/()]+\s*\/\s*[^\s()]+|"(?:[^"\\]|\\.)*"|:[A-Za-z0-9_-]+|[()]|\b[\w-]+-\d{2}\b|amr-unknown/gu;
      const ids = bindingNodes.map(({ id }) => id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
      const pattern = new RegExp(
        base.source + (ids.length ? `|\\b(?:${ids.join('|')})\\b` : ''),
        'gu',
      );
      const colored = text.replace(pattern, (token) =>
        bindingNodes.some(({ id }) => id === (token.match(/^\(([^\s/()]+)/u)?.[1] ?? token))
          ? `${bindingInk(bindingNodes.find(({ id }) => id === (token.match(/^\(([^\s/()]+)/u)?.[1] ?? token)).color)}${token}\x1b[0m${surface}${colors.plain}`
          : token.startsWith('(') && token.match(/^\(([^\s/()]+)/u)?.[1] === eventId
            ? `${colors.located}${token}\x1b[0m${surface}${colors.plain}`
            : `${/^[()]$/u.test(token) ? colors.muted : colors.plain}${token}`,
      );
      return `${surface}${colors.plain}${colored}\x1b[0m`;
    }
    return `${surface}${colors[tone]}${text}\x1b[0m`;
  };
  const row = (text = '', tone = 'plain', indent = 0) => ({ text: clean(text), tone, indent });
  // Labels orient; emphasis belongs to the inquiry, selected evidence and answer.
  // An entry's optional third item sets its value tone, independently of its label.
  function labeledRow(values, highlights = []) {
    let value = '';
    const spans = [];
    for (const [label, content, tone = 'plain'] of values) {
      if (value) value += '   ';
      const start = value.length;
      value += `${label}:`;
      spans.push({ start, end: value.length, tone: 'muted' });
      const offset = value.length + 1;
      value += ` ${content}`;
      let at = offset;
      for (const item of highlights
        .filter((item) => item.label === label)
        .sort((a, b) => a.start - b.start)) {
        const from = Math.max(offset, offset + item.start),
          end = Math.min(value.length, offset + item.end);
        if (from < at || end <= from) continue;
        if (from > at) spans.push({ start: at, end: from, tone });
        spans.push({
          start: from,
          end,
          ...(item.color !== undefined ? { color: item.color } : { tone: item.tone ?? 'input' }),
        });
        at = end;
      }
      if (at < value.length) spans.push({ start: at, end: value.length, tone });
    }
    return {
      ...row(value, 'plain', 1),
      spans,
      hangingIndent: values.length === 1 ? editorMeasure(`${values[0][0]}: `) : 0,
    };
  }
  const sectionRows = (rows) => {
    let section = -1;
    const result = [];
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      const h2 = item.tone === 'section' && !item.indent;
      if (h2 && result.length && result.at(-1).text) result.push({ ...row(), surface: background });
      if (h2 && !item.continueSection) section++;
      const surface = item.surface ?? (section >= 0 && section % 2 === 0 ? sourceBand : background);
      const next = rows[i + 1];
      const separator =
        !item.text && next?.tone === 'section' && !next.indent && !next.continueSection;
      result.push({
        ...item,
        keepWithNext: item.keepWithNext || h2,
        tone: item.tone === 'section' && item.indent ? 'subheading' : item.tone,
        surface: separator ? background : surface,
      });
      if (h2 && (next?.text || next?.columns || next?.table)) result.push({ ...row(), surface });
    }
    return result;
  };
  const shortcutRow = (label, actions, inset = '') => {
    const value = inset + label;
    const shortcutSpans = actions
      .flatMap((item) => {
        const at = label.indexOf(item.label);
        return at < 0 || !item.key
          ? []
          : [{ start: inset.length + at, end: inset.length + at + item.key.length }];
      })
      .sort((a, b) => a.start - b.start);
    return { ...row(value, 'muted'), shortcutSpans };
  };
  const wrap = (item, width) => {
    if (item.indent) {
      const indent = Math.min(item.indent, Math.max(0, width - 1));
      return wrap({ ...item, indent: 0 }, width - indent).map((line) => ({
        ...line,
        text: ' '.repeat(indent) + line.text,
        selectionInset: (line.selectionInset ?? 0) + indent,
        spans: sliceHighlights(line.spans, 0, line.text.length, indent),
        ...(line.sectionChoices
          ? {
              sectionChoices: line.sectionChoices.map((choice) => ({
                ...choice,
                start: choice.start + indent,
                end: choice.end + indent,
              })),
            }
          : {}),
        ...(line.caret !== undefined ? { caret: line.caret + indent } : {}),
      }));
    }
    if (item.tabs) {
      const lines = [];
      let line = { ...row(), spans: [], sectionChoices: [], surface: item.surface };
      for (const tab of item.tabs) {
        const label = fit(tab.label, Math.min(Math.max(1, width - 2), editorMeasure(tab.label)));
        const value = tab.active ? `[${label}]` : ` ${label} `;
        if (line.text && editorMeasure(line.text) + 3 + editorMeasure(value) > width) {
          lines.push(line);
          line = { ...row(), spans: [], sectionChoices: [], surface: item.surface };
        }
        if (line.text) line.text += '   ';
        const start = line.text.length;
        const column = editorMeasure(line.text);
        line.text += value;
        line.spans.push({ start, end: line.text.length, tone: tab.active ? 'input' : 'muted' });
        line.sectionChoices.push({
          index: tab.index,
          start: column,
          end: column + editorMeasure(value) - 1,
        });
      }
      if (line.text) lines.push(line);
      return lines;
    }
    if (item.table) {
      const { headers, entries } = item.table;
      // Selection presents: a selected row shows its preview without another key.
      const preview = (entry, available = width) =>
        entry.selected
          ? (entry.preview ?? []).flatMap((text) =>
              wrap(
                {
                  ...row(`↳ ${text}`, 'muted', 4),
                  hangingIndent: 2,
                  surface: item.surface,
                  choiceIndex: entry.choiceIndex,
                },
                available,
              ),
            )
          : [];
      const widths = tableWidths(
        {
          ...item.table,
          entries: entries.map((entry) => ({
            ...entry,
            cells: entry.cells.map((value, column) =>
              column === 0 && Number.isInteger(entry.choiceIndex) ? `  ${value}` : value,
            ),
          })),
        },
        width,
        editorMeasure,
      );
      if (!widths || width < (item.table.minWidth ?? 104))
        return entries.flatMap((entry, index) => {
          const previous = entries[index - 1]?.cells;
          const sameGroup =
            previous &&
            !(item.table.groupColumns ?? []).some(
              (column) => previous[column] !== entry.cells[column],
            );
          return [
            ...(index ? [sameGroup ? row() : row('─'.repeat(width), 'border')] : []),
            ...entry.cells.flatMap((value, column) => {
              if (
                value === '' ||
                value === '—' ||
                (sameGroup &&
                  column < (item.table.repeatColumns ?? 2) &&
                  previous[0] === entry.cells[0] &&
                  previous[column] === value)
              )
                return [];
              const tone = entry.selected ? 'selected' : (entry.cellTones?.[column] ?? entry.tone);
              return [
                {
                  ...labeledRow([
                    [
                      `${column === 0 && entry.selected ? '› ' : ''}${headers[column]}`,
                      value,
                      tone,
                    ],
                  ]),
                  indent: 0,
                  selectorIndex: entry.selectorIndex,
                  choiceIndex: entry.choiceIndex,
                },
              ];
            }),
          ]
            .flatMap((line) => wrap({ ...line, surface: item.surface }, width))
            .concat(preview(entry));
        });
      const result = [];
      let previous;
      const divider = () => ({
        ...row(widths.map((size) => '─'.repeat(size)).join('─┼─'), 'border'),
        surface: item.surface,
      });
      // Spacing and previews sit in the first column, so the column rule stays unbroken.
      const ruled = (line) => {
        let value = fit(line.text, widths[0]);
        const spans = [{ start: 0, end: line.text.length, tone: line.tone }];
        for (const size of widths.slice(1)) {
          spans.push({ start: value.length, end: value.length + 3, tone: 'border' });
          value += ` │ ${' '.repeat(size)}`;
        }
        return { ...line, text: value, spans };
      };
      for (const [index, entry] of [{ cells: headers, tone: 'subheading' }, ...entries].entries()) {
        const groupChanged =
          index > 1 &&
          (item.table.groupColumns ?? []).some(
            (column) => previous[column] !== entry.cells[column],
          );
        if (groupChanged) {
          result.push(divider());
          previous = null;
        } else if (index > 1 && item.table.rowSpacing)
          result.push(
            ...Array.from({ length: item.table.rowSpacing }, () =>
              ruled({ ...row(), surface: item.surface }),
            ),
          );
        const cells = entry.cells.map((value, column) =>
          index &&
          previous &&
          column < (item.table.repeatColumns ?? 2) &&
          previous[0] === entry.cells[0] &&
          (column === 0 || previous[1] === value)
            ? ''
            : column === 0 && Number.isInteger(entry.choiceIndex)
              ? `${entry.selected ? '›' : ' '} ${value}`
              : value,
        );
        const wrappedCells = cells.map((value, column) =>
          wrap(
            row(value, entry.selected ? 'selected' : (entry.cellTones?.[column] ?? entry.tone)),
            widths[column],
          ),
        );
        for (let line = 0; line < Math.max(...wrappedCells.map((cell) => cell.length)); line++) {
          let value = '';
          const spans = [];
          for (let column = 0; column < cells.length; column++) {
            if (column) {
              const start = value.length;
              value += ' │ ';
              spans.push({ start, end: value.length, tone: 'border' });
            }
            const cell = wrappedCells[column][line] ?? row();
            spans.push({
              start: value.length,
              end: value.length + cell.text.length,
              tone: cell.tone,
            });
            value += fit(cell.text, widths[column]);
          }
          result.push({
            ...row(value),
            keepWithNext: index === 0,
            spans,
            surface: item.surface,
            selectorIndex: entry.selectorIndex,
            choiceIndex: entry.choiceIndex,
          });
        }
        if (!index) result.push({ ...divider(), keepWithNext: true });
        else result.push(...preview(entry, widths[0]).map(ruled));
        previous = entry.cells;
      }
      return result;
    }
    if (item.columns) {
      if (width < 74)
        return item.columns
          .flatMap((column, index) => [
            ...(index ? [row()] : []),
            ...(item.stackLabels ? [row(item.stackLabels[index], 'subheading', 1)] : []),
            ...column,
          ])
          .flatMap((line) => wrap({ ...line, surface: item.surface }, width));
      const [leftWidth, rightWidth] = tableWidths(
        {
          headers: ['', ''],
          widths: [24, 24],
          entries: item.columns.flatMap((column, side) =>
            column.map((line) => ({ cells: side ? ['', line.text] : [line.text, ''] })),
          ),
        },
        width,
        editorMeasure,
      );
      const columns = item.columns.map((column, index) =>
        column.flatMap((line) => wrap(line, index ? rightWidth : leftWidth)),
      );
      return Array.from(
        { length: Math.max(...columns.map((column) => column.length)) },
        (_, index) => {
          const left = columns[0][index] ?? row(),
            right = columns[1][index] ?? row();
          const divider =
            left.sentence || right.sentence || left.tone === 'input' || right.tone === 'input'
              ? ' │ '
              : '   ';
          const leftText = fit(left.text, leftWidth),
            prefix = leftText + divider;
          return {
            ...row(prefix + fit(right.text, rightWidth)),
            surface: item.surface,
            spans: [
              { start: 0, end: left.text.length, tone: left.tone },
              { start: leftText.length, end: prefix.length, tone: 'border' },
              { start: prefix.length, end: prefix.length + right.text.length, tone: right.tone },
            ],
          };
        },
      );
    }
    if (item.field) {
      const field = item.field;
      const lines = editorLines(field.value, Math.max(1, width - 1), editorMeasure);
      const activeLine = lines.findLastIndex((line) => line.start <= field.cursor);
      return lines.map((line, i) => {
        return {
          ...item,
          text: clean(line.text),
          ...(item.active && i === activeLine
            ? {
                caret: editorMeasure(
                  Array.from(line.text)
                    .slice(0, field.cursor - line.start)
                    .join(''),
                ),
              }
            : {}),
        };
      });
    }
    const result = [];
    let start = 0;
    // Continuations align with the value, keeping the label column clear.
    const hanging = Math.min(item.hangingIndent ?? 0, Math.max(0, width - 8));
    const inset = () => (result.length ? hanging : 0);
    const line = (value, from, to) => ({
      ...item,
      text: ' '.repeat(inset()) + value,
      spans: sliceHighlights(item.spans, from, to, inset()),
    });
    for (let rest of item.text.split('\n')) {
      const lineEnd = start + rest.length + 1;
      while (terminalKit.stringWidth(rest) > width - inset()) {
        const prefix = terminalKit.truncateString(rest, width - inset());
        const space = prefix.lastIndexOf(' ');
        const cut = space > prefix.length / 3 ? space : prefix.length;
        if (!cut) {
          result.push({ ...item, text: '…', spans: [] });
          const skipped = Array.from(rest)[0].length;
          rest = rest.slice(skipped);
          start += skipped;
          continue;
        }
        result.push(line(rest.slice(0, cut), start, start + cut));
        const next = rest.slice(cut).trimStart();
        start += rest.length - next.length;
        rest = next;
      }
      result.push(line(rest, start, start + rest.length));
      start = lineEnd;
    }
    return result;
  };
  const pack = (items, available) => {
    const result = [];
    let current = '';
    for (const text of items) {
      const next = current ? `${current}   ${text}` : text;
      if (current && terminalKit.stringWidth(next) > available) {
        result.push(current);
        current = text;
      } else current = next;
    }
    if (current) result.push(current);
    return result;
  };

  return {
    clean,
    row,
    labeledRow,
    sectionRows,
    shortcutRow,
    fit,
    paint,
    wrap,
    pack,
    editorMeasure,
    progressHeader,
    background,
    sidebar,
    hoverBand,
    sourceBand,
    inquiryBand,
    headerBand,
    historyBand,
  };
}
