/** The workbench's “Why no answer” table, from the shared explanation. */
import { openingNeeds } from '../../engine/explanation.mjs';

export function questionExplanation(run, relations) {
  return {
    heading: 'Why no answer',
    table: {
      headers: ['Question needs', 'What is missing'],
      widths: [null, null],
      minWidth: 62,
      repeatColumns: 0,
      rowSpacing: 1,
      entries: openingNeeds(run, relations).map(({ needs, reason, openings }, index) => ({
        cells: [needs.join('\n'), reason],
        openings,
        choiceIndex: 1000000 + index,
        cellTones: { 0: 'warning' },
      })),
    },
  };
}
