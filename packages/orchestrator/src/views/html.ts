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

const STYLE = `
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; padding: 1rem; max-width: 60rem; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 2rem 0 .5rem; }
a { color: inherit; }
.meta { opacity: .6; font-size: .85rem; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: .75rem; margin: .5rem 0; }
.card.attention { border-left: 3px solid #d97706; }
.card.alert { border-left: 3px solid #dc2626; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
th { font-weight: 600; opacity: .7; }
code { font-size: .85em; opacity: .8; }
form { display: inline; }
button { font: inherit; padding: .35rem .75rem; border: 1px solid var(--line);
         border-radius: 4px; background: transparent; cursor: pointer; }
button.danger { color: #dc2626; }
.empty { opacity: .55; font-style: italic; }
ul { padding-left: 1.1rem; margin: .35rem 0; }
@media (max-width: 40rem) { body { padding: .6rem; } th, td { padding: .3rem; } }
`;

/**
 * The refresh is progressive enhancement: the page is complete without it, and
 * it reloads rather than patching, because at this size a reload is cheaper
 * than anything that would keep a diff correct. Browsers throttle timers in
 * background tabs, so the page states when it was rendered rather than
 * pretending to be live.
 */
const REFRESH = `
<script>
  setTimeout(function () { location.reload(); }, 5000);
</script>`;

export function layout(title: string, now: Date, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · mycelium</title>
<style>${STYLE}</style>
</head>
<body>
<h1><a href="/ui" style="text-decoration:none">mycelium</a></h1>
<p class="meta">refreshed ${escape(now.toISOString())}</p>
${body}
${REFRESH}
</body>
</html>`;
}
