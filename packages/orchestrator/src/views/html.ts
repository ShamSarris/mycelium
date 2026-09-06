/**
 * The whole of the dashboard's rendering: template literals and one escape
 * function.
 *
 * There is no framework here on purpose. The page polls, there is one
 * operator, and every view is a table of rows that already exist in Postgres —
 * an SPA's advantages would go unused while its build step joined the deploy
 * path. What that buys is that every page is asserted through the same
 * `app.inject()` harness as every route, with no jsdom standing in for a
 * browser.
 */

import { LIVE_SCRIPT } from './live.js';
import { FAVICON, STYLE, THEME_COLOR } from './theme.js';

/**
 * Everything interpolated into a page goes through this. Plans are authored by
 * the operator, but they are authored *with* a model that reads untrusted
 * content, and event payloads come from three services and a semi-trusted
 * agent — so "it is our own data" is not true here in the way it usually is.
 */
export function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tagged template that escapes every interpolation, so forgetting is not possible. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, part, i) => {
    if (i === 0) return part;
    const value = values[i - 1];
    // An array of already-rendered fragments joins as-is; anything else is data.
    const rendered = Array.isArray(value)
      ? value.join('')
      : value instanceof Raw
        ? value.value
        : escape(value);
    return out + rendered + part;
  }, '');
}

/** Marks a string as already-rendered markup. Used only by the layout helpers below. */
class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

/** One independently refreshable block of a page. */
export interface Region {
  /** Stable across renders: it is how a poll finds the block to replace. */
  id: string;
  html: string;
}

/**
 * A page, described rather than rendered. Every page function returns this, and
 * both the document route and the fragment route render it — which is what
 * stops the two from drifting, since neither has its own copy of the markup.
 */
/** Which tab is the one you are on. A plan page belongs to the overview. */
export type NavTab = 'overview' | 'projects' | 'servers' | 'monitor';

const TABS: ReadonlyArray<{ tab: NavTab; href: string; label: string }> = [
  { tab: 'overview', href: '/ui', label: 'overview' },
  { tab: 'projects', href: '/ui/projects', label: 'projects' },
  { tab: 'servers', href: '/ui/servers', label: 'servers' },
  { tab: 'monitor', href: '/ui/monitor', label: 'monitor' },
];

export interface PageParts {
  title: string;
  nav: NavTab;
  /** The fragment endpoint that refreshes this page's regions. */
  live: string;
  /** Plans waiting on a decision. Becomes the count in the tab title. */
  attention: number;
  regions: Region[];
}

/**
 * FNV-1a over the region's markup. Not a security hash and not a cache key
 * anyone else sees: it only has to be stable for identical markup and
 * different for markup that differs.
 *
 * This is the whole anti-flash mechanism. A poll compares this against the
 * `data-v` already on the page and skips the region when they match, so an
 * idle system mutates no DOM at all — scroll position, text selection, focus
 * and open <details> survive for as long as nothing actually changes.
 */
export function version(markup: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < markup.length; i += 1) {
    hash ^= markup.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function tabs(current: NavTab): string {
  return TABS.map(
    ({ tab, href, label }) =>
      `<a href="${href}"${tab === current ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
}

/** A region as it sits in the document, carrying the version a poll compares. */
function section(region: Region): string {
  return `<section data-region="${escape(region.id)}" data-v="${version(region.html)}">${region.html}</section>`;
}

export function renderPage(parts: PageParts, now: Date): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${THEME_COLOR}">
<title>${escape(parts.title)} · mycelium</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body data-live="${escape(parts.live)}" data-title="${escape(parts.title)} &#183; mycelium">
<header class="topbar">
<h1><a href="/ui">mycelium</a></h1>
<span class="grow"></span>
<span class="meta">refreshed <time id="as-of" datetime="${escape(now.toISOString())}">${escape(now.toISOString())}</time> <span class="dot"></span><span id="live-state">static</span></span>
</header>
<nav class="tabs">${tabs(parts.nav)}</nav>
<main>
${parts.regions.map(section).join('\n')}
</main>
${LIVE_SCRIPT}
</body>
</html>`;
}
