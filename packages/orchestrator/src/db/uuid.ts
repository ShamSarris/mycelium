import { v7 as uuidv7 } from 'uuid';

/**
 * UUIDv7 (RFC 9562): opaque like v4, so plan ids in dashboard URLs and branch
 * names leak nothing, but time-ordered, so the high-insert tables do not
 * fragment their indexes. Postgres 17 has no native uuidv7(), so it is minted
 * here rather than by a column default.
 */
export function newId(): string {
  return uuidv7();
}
