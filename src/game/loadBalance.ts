import type { Balance } from '../sim/balance.js';

/**
 * Loads content/balance.json at runtime.
 *
 * content/ is Vite's publicDir, so the file is served as ./balance.json in dev
 * and copied next to index.html on build. The owner edits
 * content/balance.json in the repo root, reloads the page, and sees new numbers
 * without a rebuild.
 */
export async function loadBalance(): Promise<Balance> {
  const url = `${import.meta.env.BASE_URL}balance.json`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
  }

  const raw: unknown = await response.json();
  if (!isBalance(raw)) {
    throw new Error('content/balance.json не похож на баланс: нет shift, drill или layers');
  }
  return raw;
}

function isBalance(value: unknown): value is Balance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Balance>;
  return (
    typeof candidate.shift === 'object' &&
    candidate.shift !== null &&
    typeof candidate.drill === 'object' &&
    candidate.drill !== null &&
    Array.isArray(candidate.layers) &&
    candidate.layers.length > 0
  );
}
