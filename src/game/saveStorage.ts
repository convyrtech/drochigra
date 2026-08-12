import type { Balance } from '../sim/balance.js';
import { createProfile, profileFromSaved, profileToSaved, type Profile } from '../sim/progress.js';

/**
 * The profile in the browser: one key, one JSON, written after every shift and
 * every purchase. src/sim knows nothing about storage, so this is the only place
 * that touches localStorage.
 *
 * Nothing here ever throws: a blocked storage, a full quota or a save written by
 * a foreign version must cost the player at most this session, never the game.
 */

/** The single key the game saves under. Not a game number. */
export const SAVE_KEY = 'vostok9.save';

/** The slice of localStorage this module needs, so tests can pass a plain map. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage when it is there and usable, null in node and in private modes. */
export function browserStore(): KeyValueStore | null {
  try {
    const store = (globalThis as { localStorage?: KeyValueStore | null }).localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/** The saved profile, or a fresh account when there is nothing readable. */
export function loadProfile(balance: Balance, store: KeyValueStore | null = browserStore()): Profile {
  const raw = readRaw(store);
  if (raw === null) {
    return createProfile(balance);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createProfile(balance);
  }
  return profileFromSaved(balance, parsed) ?? createProfile(balance);
}

/** Writes the profile. False when storage refused it — the game goes on either way. */
export function saveProfile(profile: Profile, store: KeyValueStore | null = browserStore()): boolean {
  if (!store) {
    return false;
  }
  try {
    store.setItem(SAVE_KEY, JSON.stringify(profileToSaved(profile)));
    return true;
  } catch {
    return false;
  }
}

function readRaw(store: KeyValueStore | null): string | null {
  if (!store) {
    return null;
  }
  try {
    return store.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}
