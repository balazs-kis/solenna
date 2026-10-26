/**
 * Creates an element. Never uses innerHTML, so text is always safe to pass in.
 *
 *   h('button', { class: 'primary', onclick: save }, t('save'))
 *
 * - `on*` function props become event listeners
 * - `true` sets an empty attribute, `false` / null / undefined skips it
 * - children can be nodes, strings, numbers, nested arrays; null / false are skipped
 */
export function h(tag, props = {}, ...children) {
  return build(document.createElement(tag), props, children);
}

/** Same as h(), for SVG elements (they need their own namespace). */
export function svg(tag, props = {}, ...children) {
  return build(document.createElementNS('http://www.w3.org/2000/svg', tag), props, children);
}

function build(el, props, children) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  el.append(
    ...children
      .flat(Infinity)
      .filter((child) => child != null && child !== false)
      .map((child) => (child instanceof Node ? child : String(child))),
  );
  return el;
}
