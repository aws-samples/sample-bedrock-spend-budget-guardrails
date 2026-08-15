import { describe, expect, it } from 'vitest';
import { deriveScope } from '../src/pre-token-gen/index.js';

describe('deriveScope', () => {
  it('returns empty array for a user with no admin groups', () => {
    expect(deriveScope(['Users'])).toEqual([]);
  });

  it('returns ["*"] for BBG-Admin-Wildcard members', () => {
    expect(deriveScope(['BBG-Admin-Wildcard', 'Users'])).toEqual(['*']);
  });

  it('AUZ-2: legacy Admins group no longer grants any scope', () => {
    expect(deriveScope(['Admins'])).toEqual([]);
  });

  it('extracts a single 12-digit account from BBG-Admin-<accountId>', () => {
    expect(deriveScope(['BBG-Admin-111122223333'])).toEqual(['111122223333']);
  });

  // NOTE: use documentation-placeholder account IDs, chosen so the ASSERTED
  // ORDER IS ALSO THE SORTED ORDER — deriveScope() sorts, so fixtures whose
  // listed order differs from their sorted order make this assertion fragile.
  it('extracts multiple account IDs sorted', () => {
    expect(deriveScope(['BBG-Admin-222233334444', 'BBG-Admin-111122223333'])).toEqual([
      '111122223333',
      '222233334444',
    ]);
  });

  it('ignores BBG-Admin-* groups whose tail is not a 12-digit account ID', () => {
    expect(deriveScope(['BBG-Admin-foo', 'BBG-Admin-12345'])).toEqual([]);
  });

  it('wildcard wins over per-account memberships', () => {
    expect(
      deriveScope(['BBG-Admin-Wildcard', 'BBG-Admin-111122223333']),
    ).toEqual(['*']);
  });

  it('AUZ-2: legacy Admins is ignored; only the per-account group counts', () => {
    expect(deriveScope(['Admins', 'BBG-Admin-111122223333'])).toEqual(['111122223333']);
  });

  it('deduplicates if the same account appears twice (shouldn\'t happen but be safe)', () => {
    expect(
      deriveScope(['BBG-Admin-111122223333', 'BBG-Admin-111122223333']),
    ).toEqual(['111122223333']);
  });
});
