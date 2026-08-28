import { describe, expect, it } from 'vitest';
import { hasTelegramSession } from '../src/game/tg.js';
import { fpsRequested } from '../src/ui/fpsOverlay.js';

/**
 * Issue #12: index.html loads the official telegram-web-app.js in every browser
 * and it defines window.Telegram.WebApp everywhere — version «6.0», a working
 * ready(), and no session. Believing that object meant `isTelegram()` was true
 * on a desktop and on itch.io, and `src/main.ts` skipped its portrait lock as
 * «Telegram will handle it». These are the two shapes the object comes in.
 */
describe('telling a Telegram launch from the script stub', () => {
  const ready = (): void => {};

  it('says no to the stub the script leaves in a plain browser', () => {
    // Measured in chromium on the production build: the object is there, the
    // session is not.
    expect(hasTelegramSession({ ready, initData: '', initDataUnsafe: {} })).toBe(false);
  });

  it('says no when the object carries no session fields at all', () => {
    expect(hasTelegramSession({ ready })).toBe(false);
  });

  it('says yes to a real Mini App launch, which is signed', () => {
    expect(
      hasTelegramSession({
        ready,
        initData: 'query_id=AAA&user=%7B%22id%22%3A1%7D&auth_date=1724800000&hash=abc',
        initDataUnsafe: { query_id: 'AAA', auth_date: 1724800000, hash: 'abc' },
      }),
    ).toBe(true);
  });

  it('says yes to a client that filled only the parsed copy', () => {
    expect(hasTelegramSession({ ready, initData: '', initDataUnsafe: { user: { id: 1 } } })).toBe(
      true,
    );
  });
});

/** The frame counter is opt-in: players never see it, checks always can. */
describe('the ?fps switch', () => {
  it('is off unless it is asked for', () => {
    expect(fpsRequested('')).toBe(false);
    expect(fpsRequested('?seed=7')).toBe(false);
    expect(fpsRequested('?fps=0')).toBe(false);
    expect(fpsRequested('?fps=')).toBe(false);
  });

  it('is on for ?fps=1', () => {
    expect(fpsRequested('?fps=1')).toBe(true);
    expect(fpsRequested('?seed=7&fps=1')).toBe(true);
    expect(fpsRequested('?fps=yes')).toBe(true);
  });
});
