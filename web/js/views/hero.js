import { h } from '../dom.js';

/**
 * The header under a screen's title: the key value, big, then exactly two
 * plain lines. `line1` is the meaning (e.g. the trend), `line2` the context
 * (e.g. the date); either can be missing. On phones the lines sit under the
 * value, on desktop to its right. No chips or "·" separators: keep every
 * screen's header to this one pattern.
 *
 * `size` fits the value: 'number' (the default, "76.8"), 'words' ("Cycle day
 * 28": smaller on phones) or 'name' (a person's name, next to their
 * `picture`).
 */
export function hero({ value, unit, size = 'number', picture, line1, line2 }) {
  const header = h(
    'div',
    { class: 'hero' },
    // The space keeps "76.8 kg" one phrase for screen readers.
    h(
      'p',
      // A number needs no extra class: .hero-value is sized for it.
      { class: size === 'number' ? 'hero-value' : `hero-value hero-value-${size}` },
      value,
      unit && [' ', h('span', { class: 'hero-unit' }, unit)],
    ),
    (line1 || line2) &&
      h(
        'div',
        { class: 'hero-lines' },
        line1 && h('p', { class: 'hero-line1' }, line1),
        line2 && h('p', { class: 'hero-line2' }, line2),
      ),
  );
  return picture ? h('div', { class: 'hero-person' }, picture, header) : header;
}
