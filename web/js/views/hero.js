import { h } from '../dom.js';

/**
 * The header under a screen's title: the key value, big, then exactly two
 * plain lines. `line1` is the meaning (e.g. the trend), `line2` the context
 * (e.g. the date); either can be missing. On phones the lines sit under the
 * value, on desktop to its right. No chips or "·" separators: keep every
 * screen's header to this one pattern.
 */
export function hero({ value, unit, line1, line2 }) {
  return h(
    'div',
    { class: 'hero' },
    // The space keeps "76.8 kg" one phrase for screen readers.
    h('p', { class: 'hero-value' }, value, unit && [' ', h('span', { class: 'hero-unit' }, unit)]),
    (line1 || line2) &&
      h(
        'div',
        { class: 'hero-lines' },
        line1 && h('p', { class: 'hero-line1' }, line1),
        line2 && h('p', { class: 'hero-line2' }, line2),
      ),
  );
}
