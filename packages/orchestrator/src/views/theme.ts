/**
 * The dashboard's visual language, as two string constants.
 *
 * They are constants rather than files because `pnpm build` runs tsc and copies
 * no assets: a `.css` file beside this one would typecheck, lint, review well,
 * and ship as nothing.
 *
 * The palette carries meaning rather than decoration. One accent for links and
 * for work that succeeded; amber only ever means "waiting on you"; red only
 * ever means "this broke". Nothing else is coloured, which is what lets a red
 * row be noticed from across a room. Monospace carries every id, hash, count
 * and timestamp — the things you compare character by character — and the sans
 * face carries only prose.
 */

export const STYLE = `
:root{
  color-scheme: dark;
  --bg:#0b0f14; --bg-1:#111823; --bg-2:#18212e; --bg-3:#1e2937;
  --line:#22303f; --line-soft:#1a2432;
  --fg:#dbe4ee; --fg-dim:#8ea0b5; --fg-faint:#5b6b7e;
  --accent:#59e6a9; --warn:#e0a458; --bad:#f2666f; --info:#5fa8e6;
  --mono: ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --r:3px;
}
*{box-sizing:border-box;}
html,body{background:var(--bg);color:var(--fg);}
body{margin:0;padding:0;font:13px/1.45 var(--sans);
     -webkit-font-smoothing:antialiased;}
a{color:var(--accent);text-decoration:none;}
a:hover{text-decoration:underline;}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}

/* The shell: a fixed bar the page scrolls under, so which page you are on and
   whether it is live are answers you never have to scroll for. */
.topbar{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;
        padding:.55rem .9rem;background:var(--bg-1);border-bottom:1px solid var(--line);}
.topbar .grow{flex:1;}
nav.tabs{display:flex;gap:0;padding:0 .9rem;background:var(--bg-1);
         border-bottom:1px solid var(--line);overflow-x:auto;}
nav.tabs a{padding:.5rem .8rem;font:11px/1.4 var(--mono);letter-spacing:.08em;
           text-transform:uppercase;color:var(--fg-dim);border-bottom:2px solid transparent;
           white-space:nowrap;}
nav.tabs a:hover{color:var(--fg);text-decoration:none;}
nav.tabs a[aria-current="page"]{color:var(--fg);border-bottom-color:var(--accent);}
main{padding:.9rem;}

/* Live, stale, or stopped -- stated, because a page that looks fresh and is not
   is worse than one that admits it. */
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;
     background:var(--fg-faint);margin-right:.35rem;}
body.is-stale .dot{background:var(--warn);}
body.is-stale #live-state{color:var(--warn);}
body.is-gone .dot{background:var(--bad);}
body.is-gone #live-state{color:var(--bad);}

h1{font:600 15px/1.2 var(--sans);margin:0 0 .2rem;}
h1 a{color:var(--fg);}
h2{font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
   color:var(--fg-dim);margin:1.6rem 0 .5rem;padding-bottom:.35rem;
   border-bottom:1px solid var(--line-soft);}

.meta{color:var(--fg-dim);font-size:11.5px;}
.empty{color:var(--fg-faint);font-style:italic;font-size:12px;}
code{font-family:var(--mono);font-size:11.5px;color:var(--fg-dim);}
pre{background:var(--bg);border:1px solid var(--line-soft);border-radius:var(--r);
    padding:.6rem;overflow:auto;max-height:28rem;font-family:var(--mono);font-size:11.5px;}

.card{background:var(--bg-1);border:1px solid var(--line);border-radius:var(--r);
      padding:.6rem .7rem;margin:.4rem 0;}
.card.attention{border-left:2px solid var(--warn);}
.card.alert{border-left:2px solid var(--bad);}

table{border-collapse:collapse;width:100%;font-size:12px;}
th{text-align:left;font:600 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
   color:var(--fg-faint);padding:.45rem .5rem;border-bottom:1px solid var(--line);}
td{padding:.45rem .5rem;border-bottom:1px solid var(--line-soft);vertical-align:top;}
tr:hover td{background:var(--bg-1);}

form{display:inline;}
button{font:600 11px/1 var(--mono);letter-spacing:.05em;padding:.45rem .75rem;
       border:1px solid var(--line);border-radius:var(--r);background:var(--bg-2);
       color:var(--fg);cursor:pointer;}
button:hover{background:var(--bg-3);border-color:var(--fg-faint);}
button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent);}

ul{padding-left:1.05rem;margin:.3rem 0;}
li{margin:.15rem 0;}
@media (max-width:52rem){ main{padding:.6rem;} th,td{padding:.35rem;} }
`;

/**
 * Interpolated into `layout()`'s plain template literal, never through the
 * `html` tag: `escape()` would turn its quotes into entities and the browser
 * would render nothing.
 */
export const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
  "%3Crect width='32' height='32' rx='6' fill='%230b0f14'/%3E" +
  "%3Cpath d='M16 27V14' stroke='%2359e6a9' stroke-width='2.4' stroke-linecap='round'/%3E" +
  "%3Cpath d='M16 19l-6.5-5M16 19l6.5-5' stroke='%232f8f63' stroke-width='2.2' stroke-linecap='round'/%3E" +
  "%3Ccircle cx='16' cy='9.5' r='3.4' fill='%2359e6a9'/%3E" +
  "%3Ccircle cx='8.5' cy='12' r='2.3' fill='%232f8f63'/%3E" +
  "%3Ccircle cx='23.5' cy='12' r='2.3' fill='%232f8f63'/%3E%3C/svg%3E";

/** The ground the browser paints behind the page, so the chrome matches it. */
export const THEME_COLOR = '#0b0f14';
