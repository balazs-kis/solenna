import { setState } from './store.js';

/** Where `/` and "go home" links lead. */
export const HOME = '/weight';

export function navigate(path) {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
  setState({ path });
}

/** Wires up link interception and back/forward. Returns the initial path. */
export function startRouter() {
  // Handle same-origin links in the router instead of reloading the page.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      link.target ||
      link.origin !== location.origin ||
      link.pathname.startsWith('/api/') ||
      link.pathname.startsWith('/auth/')
    ) {
      return;
    }
    event.preventDefault();
    navigate(link.pathname);
  });

  window.addEventListener('popstate', () => setState({ path: location.pathname }));

  if (location.pathname === '/') history.replaceState(null, '', HOME);
  return location.pathname;
}
