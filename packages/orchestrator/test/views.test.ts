import { describe, expect, it } from 'vitest';
import { version } from '../src/views/html.js';
import { viewAgent, viewPlan } from '../src/views/model.js';

/**
 * `version` is what lets the page update without flashing: a region whose
 * version has not changed is never touched, so an idle system mutates no DOM
 * at all and scroll, selection, focus and open <details> survive indefinitely.
 *
 * It is not a security hash. It only has to be stable for identical markup and
 * different for markup that differs.
 */

describe('version', () => {
  it('is stable, so an unchanged region is never patched', () => {
    const markup = '<table><tr><td>running</td></tr></table>';
    expect(version(markup)).toBe(version(markup));
  });

  it('changes when the markup does, so a changed region always is', () => {
    expect(version('<td>running</td>')).not.toBe(version('<td>done</td>'));
  });

  it('changes for a difference as small as one character', () => {
    expect(version('<td>1 done</td>')).not.toBe(version('<td>2 done</td>'));
  });

  it('is short enough to sit in an attribute on every region', () => {
    const long = '<tr><td>x</td></tr>'.repeat(500);
    expect(version(long).length).toBeLessThanOrEqual(8);
    expect(version(long)).toMatch(/^[0-9a-z]+$/);
  });

  it('handles an empty region', () => {
    expect(typeof version('')).toBe('string');
  });
});

describe('view projections', () => {
  /**
   * The dashboard's one unforgivable bug would be rendering a credential. Until
   * now the only thing preventing it was a test that scans the rendered body —
   * which works, but has to be remembered for every new page.
   *
   * These projections make it structural instead: the view functions are typed
   * on what comes out of here, and what comes out of here is built by naming
   * fields rather than by spreading a row. A hash cannot reach a template even
   * if someone forgets to scan for it.
   */
  it('drops the plan hashes rather than carrying them into a template', () => {
    const view = viewPlan({
      id: 'plan-1',
      project_id: 'project-1',
      state: 'running',
      env: 'dev',
      spec: {} as never,
      proposed_at: new Date(0),
      proposed_by: 'someone@example.com',
      approved_at: null,
      approved_by: null,
      agent_id: 'agent-1',
      agent_token_hash: 'HASH-THAT-MUST-NOT-LEAK',
      gitea_branch: 'plan/plan-1',
      gitea_bot_token_ref: 'BOT-REF-THAT-MUST-NOT-LEAK',
      provision_attempts: 0,
      next_provision_at: null,
      running_at: null,
      ttl_expires_at: null,
      manifest: null,
      terminal_reason: null,
      updated_at: new Date(0),
    });

    const keys = Object.keys(view);
    expect(keys).not.toContain('agent_token_hash');
    expect(keys).not.toContain('gitea_bot_token_ref');
    expect(JSON.stringify(view)).not.toContain('MUST-NOT-LEAK');
    // ...while still carrying what the pages actually render.
    expect(view.id).toBe('plan-1');
    expect(view.state).toBe('running');
  });

  it('drops the supervisor token hash', () => {
    const view = viewAgent({
      id: 'agent-1',
      name: 'mycelium-worker-1',
      env: 'dev',
      base_url: 'http://100.0.0.1:8081',
      token_hash: 'HASH-THAT-MUST-NOT-LEAK',
      enabled: true,
      priority: 100,
      last_heartbeat_at: null,
      created_at: new Date(0),
      healthy: false,
    });

    expect(Object.keys(view)).not.toContain('token_hash');
    expect(JSON.stringify(view)).not.toContain('MUST-NOT-LEAK');
    expect(view.name).toBe('mycelium-worker-1');
    expect(view.healthy).toBe(false);
  });
});
