import { html, type NavTab, type PageParts } from './html.js';

/**
 * A page that exists so the shell is complete before its contents are.
 *
 * The tab is reachable, the nav is honest about what the dashboard will hold,
 * and the page says what is coming rather than rendering empty and looking
 * broken. Each one is replaced wholesale in the next phase.
 */
export function stubPage(nav: NavTab, title: string, willShow: string): PageParts {
  return {
    title,
    nav,
    // Nothing to poll yet: the client script stops at an empty endpoint.
    live: '',
    attention: 0,
    regions: [
      {
        id: 'stub',
        html: html`<h2>${title}</h2>
          <div class="card">
            <p>Not built yet. This page will show ${willShow}</p>
          </div>`,
      },
    ],
  };
}
