import { expect, test } from '@playwright/test';

/** The built game opens, draws a canvas, and logs no browser errors. */
test('game boots with a non-empty canvas and a clean console', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(`requestfailed: ${request.url()}`);
  });

  // `domcontentloaded`, not `load`: `load` waits for every subresource, so a
  // third-party host that hangs would fail this spec as though the game were
  // broken — which is exactly how issue #16 hid for a whole session. What the
  // player needs is the canvas, and that is what is waited for below.
  await page.goto('./', { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveTitle('ВОСТОК-9');

  const canvas = page.locator('#game canvas');
  await expect(canvas).toBeAttached({ timeout: 15_000 });

  const box = await canvas.boundingBox();
  expect(box, 'canvas must be laid out').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // Portrait: the canvas is taller than it is wide.
  expect(box!.height).toBeGreaterThan(box!.width);

  expect(problems, problems.join('\n')).toEqual([]);
});

/**
 * Issue #16: the game must not need telegram.org to start. It used to load the
 * official client script as a plain blocking <script> in <head>, so a host that
 * is blocked or simply dropped — not refused, dropped — stopped the parser
 * before it ever reached the game module: measured at over 40 seconds with no
 * canvas, no <body> and no page style, i.e. a blank screen and a player who
 * leaves. The players open this from GitHub Pages and itch.io as well as from
 * Telegram, so this is a plain-browser guarantee, not a Telegram one.
 *
 * The route below never answers, which is what an unreachable host looks like;
 * `abort()` would be a refusal, and a refusal is the easy case.
 */
test('boots with telegram.org unreachable, and does not even ask for it', async ({ page }) => {
  const askedTelegram: string[] = [];
  // Issue #17 put a copy of the client script next to index.html as a fallback
  // for a blocked telegram.org. Outside Telegram it is as pointless as the
  // remote one — 114 KB for a «6.0» stub with an empty session — so a plain
  // browser must not ask for either.
  const askedCopy: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('telegram.org')) {
      askedTelegram.push(url);
    } else if (url.includes('telegram-web-app.js')) {
      askedCopy.push(url);
    }
  });
  await page.route(/telegram\.org/, () => {
    // Deliberately never fulfilled and never aborted.
  });

  const started = Date.now();
  await page.goto('./', { waitUntil: 'domcontentloaded' });

  const canvas = page.locator('#game canvas');
  await expect(canvas).toBeAttached({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  expect(box, 'canvas must be laid out').not.toBeNull();
  expect(box!.height).toBeGreaterThan(box!.width);

  // A plain launch carries no Telegram parameters, so there is nothing to load:
  // without them the script only leaves its «6.0» stub with an empty session.
  expect(askedTelegram, 'a plain browser must not touch telegram.org').toEqual([]);
  expect(askedCopy, 'and must not load the local copy of it either').toEqual([]);
  // Generous on purpose — this is a floor against the 40-second hang, not a
  // performance budget that a slow CI box can trip over.
  expect(Date.now() - started).toBeLessThan(15_000);
});
