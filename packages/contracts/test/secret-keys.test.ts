import { describe, expect, it } from 'vitest';
import { looksLikeSecretKey } from '../src/secrets.js';

/**
 * Baseline section 7: no secret is ever written to an event payload. This rule
 * is the backstop at both boundaries — the supervisor's RPC handler and the
 * orchestrator's ingest route — so it lives here rather than being written
 * twice and drifting.
 *
 * The rule it replaces was `/token|secret|password|api[_-]?key/i` applied as an
 * unanchored substring match. That refused `tokens_total`, `input_tokens`,
 * `output_tokens` and `cache_read_tokens`, which is every meaningful key in the
 * `agent.model_call` payload — so the system silently recorded no model
 * telemetry at all from the day it shipped. A guard that refuses real data is
 * not a stricter guard; it is a broken one.
 */

describe('looksLikeSecretKey', () => {
  // These are the keys the old regex was written for, and every one of them
  // must still be refused. This list is the reason the fix is a denylist of
  // credential words rather than "drop the guard".
  const SECRETS = [
    'token',
    'Token',
    'bot_token',
    'gitea_bot_token',
    'agent_token_hash',
    'access_token',
    'refresh_token',
    'bearer_token',
    'id_token',
    'session_token',
    'auth_tokens',
    'access_tokens',
    'secret',
    'client_secret',
    'secret_key',
    'password',
    'passwd',
    'pwd',
    'api_key',
    'apiKey',
    'apikey',
    'API_KEY',
    'private_key',
    'signing_key',
    'aws_secret_access_key',
    'authorization',
    'auth',
    'credential',
    'credentials',
    'jwt',
  ];

  for (const key of SECRETS) {
    it(`refuses ${key}`, () => {
      expect(looksLikeSecretKey(key)).toBe(true);
    });
  }

  // The `agent.model_call` payload, verbatim from
  // packages/worker/src/loop/run.ts. Every one of these was refused before.
  const MODEL_CALL = [
    'model',
    'stop_reason',
    'tokens_total',
    'tokens_this_attempt',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'usage_source',
  ];

  for (const key of MODEL_CALL) {
    it(`allows ${key}, which agent.model_call actually sends`, () => {
      expect(looksLikeSecretKey(key)).toBe(false);
    });
  }

  // A sample from the other fourteen event types, so a future tightening of
  // the rule cannot quietly start dropping them the way this one did.
  const REAL_PAYLOAD_KEYS = [
    'from',
    'to',
    'reason',
    'tool',
    'outcome',
    'is_error',
    'duration_ms',
    'action',
    'commit_sha',
    'branch',
    'container_id',
    'image',
    'network',
    'exit_code',
    'timed_out',
    'stdout_bytes',
    'stderr_bytes',
    'limit',
    'allowed',
    'spent',
    'spent_on_other_tasks',
    'next_task_ceiling',
    'calls_since_commit',
    'enforced',
    'agent_id',
    'dispatch_id',
    'attempt',
    'host',
    'port',
    'rule',
    'operator',
    'stage',
    'message',
    'code',
    'dropped_count',
    'containers_killed',
  ];

  for (const key of REAL_PAYLOAD_KEYS) {
    it(`allows ${key}`, () => {
      expect(looksLikeSecretKey(key)).toBe(false);
    });
  }

  it('is case- and separator-insensitive', () => {
    for (const key of ['BOT_TOKEN', 'bot-token', 'botToken', 'bot.token']) {
      expect(looksLikeSecretKey(key), key).toBe(true);
    }
  });

  // D30's cost-denominated budget fields. `cost_microusd` splits to `cost` +
  // `microusd`; neither word is in SECRET_WORDS and no SECRET_PAIRS entry
  // matches either, so these must all pass through unfiltered.
  const COST_KEYS = [
    'cost_microusd',
    'cost_spent_microusd',
    'max_cost_microusd',
    'cost_this_attempt_microusd',
    'total_cost_usd',
  ];

  for (const key of COST_KEYS) {
    it(`allows ${key}, the cost-denominated budget field`, () => {
      expect(looksLikeSecretKey(key)).toBe(false);
    });
  }

  it('treats a plural token count as a count, not a credential', () => {
    // The distinction the whole fix rests on: `token` is a thing you
    // authenticate with, `tokens` is a number you spent.
    expect(looksLikeSecretKey('token')).toBe(true);
    expect(looksLikeSecretKey('tokens')).toBe(false);
    // ...unless something else in the name says otherwise.
    expect(looksLikeSecretKey('access_tokens')).toBe(true);
  });

  it('handles keys that are not worth reasoning about', () => {
    expect(looksLikeSecretKey('')).toBe(false);
    expect(looksLikeSecretKey('_')).toBe(false);
    expect(looksLikeSecretKey('123')).toBe(false);
  });
});
