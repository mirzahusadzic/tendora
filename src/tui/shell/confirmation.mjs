/** Shared yes/no choice behavior for quit and destructive confirmations. */
export function confirmationKey(choice, key) {
  if (['UP', 'DOWN', 'LEFT', 'RIGHT', 'TAB', 'SHIFT_TAB'].includes(key)) {
    choice.yes = !choice.yes;
    return null;
  }
  if (['y', 'Y'].includes(key)) return 'yes';
  if (['n', 'N', 'ESCAPE'].includes(key)) return 'no';
  if (['ENTER', 'KP_ENTER'].includes(key)) return choice.yes ? 'yes' : 'no';
  return null;
}
