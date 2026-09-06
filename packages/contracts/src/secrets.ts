/**
 * Baseline section 7: no secret is ever written to an event payload.
 *
 * This is the backstop at two boundaries — the supervisor's RPC handler, where
 * an agent emits, and the orchestrator's ingest route, where a supervisor
 * relays. It lives here because those two checks must agree: a key the
 * supervisor accepts and the orchestrator refuses wedges the spool behind one
 * record it can never drain.
 *
 * It replaces `/token|secret|password|api[_-]?key/i` applied as an unanchored
 * substring match. That regex refused `tokens_total`, `tokens_this_attempt`,
 * `input_tokens`, `output_tokens` and `cache_read_tokens` — five of the eight
 * keys in `agent.model_call` — so every model-call event was rejected with
 * `secret_in_payload` before it reached the spool, and the system recorded no
 * per-turn model telemetry from the day it shipped. The worker's own test
 * passed throughout because it asserted against a fake broker rather than the
 * handler.
 *
 * The rule is therefore word-based rather than substring-based. `token` is
 * something you authenticate with; `tokens` is a number you spent.
 */

/** Words that name a credential on their own, wherever they appear in a key. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'bearer',
  'apikey',
  'jwt',
  'signature',
]);

/**
 * Words that name a credential only in company. `key` alone is a map key and
 * `tokens` alone is a count — it is `api` + `key`, or `access` + `tokens`, that
 * makes either one a credential.
 */
const SECRET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['signing', 'key'],
  ['encryption', 'key'],
  ['access', 'tokens'],
  ['refresh', 'tokens'],
  ['bearer', 'tokens'],
  ['id', 'tokens'],
  ['session', 'tokens'],
];

/**
 * Splits a key into lowercase words. Camel-case boundaries are separated before
 * lowercasing, so `botToken` and `BOT_TOKEN` and `bot-token` all reduce to the
 * same two words; an acronym run is split at the last capital, so `APIKey`
 * becomes `api` + `key` rather than `apike` + `y`.
 */
function words(key: string): ReadonlySet<string> {
  return new Set(
    key
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  );
}

/** Whether a payload key names a credential, and so must never be recorded. */
export function looksLikeSecretKey(key: string): boolean {
  const parts = words(key);

  for (const word of parts) {
    if (SECRET_WORDS.has(word)) return true;
  }

  return SECRET_PAIRS.some(([left, right]) => parts.has(left) && parts.has(right));
}
