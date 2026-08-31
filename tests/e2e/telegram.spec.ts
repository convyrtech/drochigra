import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Issue #17, in a real browser and against the real official script.
 *
 * Issue #16 stopped the game waiting for telegram.org, and it worked — the game
 * boots. But every Telegram call the game makes lives inside the script that
 * host serves, so with the host blocked the client got **nothing**: no
 * `web_app_ready`, no `web_app_expand`, and no `web_app_setup_swipe_behavior`.
 * That last one is the one that matters: the only gesture the game has
 * (`PLAN_V1` §3) is a vertical swipe over the shaft, and in a Mini App a
 * vertical swipe is Telegram's own «close me». Without that event the player
 * who drags the shaft down leaves the game — `GOAL_V1` condition 2, rolled back
 * silently while everything looked fine.
 *
 * «telegram.org is blocked» and «Telegram is down» are different sentences, and
 * for a Russian-speaking audience they routinely come apart, so this is an
 * ordinary launch. The fix is a fallback: telegram.org first (the script keeps
 * updating itself), the copy in content/ when that host refuses or says nothing.
 */

/** What a Mini App launch puts in the URL: platform, version, theme, session. */
const LAUNCH =
  '#tgWebAppPlatform=android' +
  '&tgWebAppVersion=8.0' +
  '&tgWebAppThemeParams=%7B%22bg_color%22%3A%22%23ffffff%22%2C%22text_color%22%3A%22%23000000%22%7D' +
  '&tgWebAppData=query_id%3DAAA%26auth_date%3D1724800000%26hash%3Dabc';

/**
 * The bridge the native clients inject before the page is parsed. The official
 * script picks it over every other transport, so this is the client's ear: what
 * lands in `__tgEvents` is exactly what a real Telegram client would receive.
 */
const CLIENT = `
  window.__tgEvents = [];
  window.__tgLog = [];
  window.TelegramWebviewProxy = {
    postEvent: (type, data) => {
      window.__tgEvents.push(type);
      window.__tgLog.push(type + ' ' + (data === undefined ? '' : data));
    },
  };
`;

/** The three events issue #17 says the client must hear. */
const REQUIRED = ['web_app_ready', 'web_app_expand', 'web_app_setup_swipe_behavior'];

/** telegram.org, whatever path or cache-buster is on it. */
function fromTelegram(url: string): boolean {
  return url.includes('telegram.org');
}

/** The copy we serve ourselves, from the game's own origin. */
function fromUs(url: string): boolean {
  return !fromTelegram(url) && url.includes('telegram-web-app.js');
}

/** Everything the client has heard so far. */
async function heard(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __tgEvents: string[] }).__tgEvents ?? []);
}

/** The same, with the payload of each event: `web_app_set_header_color {…}`. */
async function heardWithData(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __tgLog: string[] }).__tgLog ?? []);
}

/**
 * The **last** thing the client was told about one colour. Not «was it sent» —
 * running the official script re-posts the player's own themeParams, so a
 * second copy of it can overpaint our dark chrome with the player's light theme
 * and still leave our call in the log.
 */
function lastColour(log: readonly string[], event: string): string | undefined {
  return [...log].reverse().find((entry) => entry.startsWith(`${event} `));
}

/** The three colour events, checked together: our own page colour must win. */
function assertOursLast(log: readonly string[]): void {
  for (const event of [
    'web_app_set_background_color',
    'web_app_set_header_color',
    'web_app_set_bottom_bar_color',
  ]) {
    expect(lastColour(log, event), `${event}: the last word must be our own colour`).toContain(
      PAGE_COLOUR,
    );
  }
}

/** index.html's theme-color, the colour tg.ts pushes out to Telegram's chrome. */
const PAGE_COLOUR = '#05070d';

/** Wait until the client has heard all three, or fail saying what it did hear. */
async function waitForWiring(page: Page): Promise<string[]> {
  await expect
    .poll(async () => (await heard(page)).filter((event) => REQUIRED.includes(event)).sort(), {
      timeout: 15_000,
      message: 'the client must hear ready, expand and the swipe even with telegram.org gone',
    })
    .toEqual([...REQUIRED].sort());
  return heard(page);
}

/** Launch as a Mini App, with the client listening and the canvas up. */
async function launch(page: Page): Promise<void> {
  await page.addInitScript(CLIENT);
  await page.goto(`./${LAUNCH}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#game canvas')).toBeAttached({ timeout: 15_000 });
}

test('inside Telegram with telegram.org dropped, the client still gets the whole wiring', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    asked.push(request.url());
  });
  // Never fulfilled and never aborted: a dropped host does not refuse, it
  // swallows the connection. `abort()` would be the easy case, and the easy
  // case is not the one that broke.
  await page.route(/telegram\.org/, () => {
    /* silence */
  });

  const started = Date.now();
  await launch(page);
  // The game is on screen long before any of this; that was issue #16.
  expect(Date.now() - started, 'the game must not wait for any of it').toBeLessThan(15_000);

  const events = await waitForWiring(page);

  // …and it came from our own copy, because telegram.org never answered.
  expect(asked.filter(fromTelegram), 'telegram.org is still asked first').not.toEqual([]);
  expect(asked.filter(fromUs), 'the local copy is what got through').not.toEqual([]);
  // Once each. Nothing was applied twice.
  expect(events.filter((event) => event === 'web_app_ready')).toHaveLength(1);
  expect(events.filter((event) => event === 'web_app_setup_swipe_behavior')).toHaveLength(1);
  // And the chrome ends up our colour, not the player's light theme.
  assertOursLast(await heardWithData(page));
});

test('a refused telegram.org is answered at once, without waiting out the grace', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    asked.push(request.url());
  });
  await page.route(/telegram\.org/, (route: Route) => route.abort());

  await launch(page);
  const started = Date.now();
  await waitForWiring(page);
  // A refusal is an answer: the fallback does not sit out the 2.5 s the silent
  // host gets. Generous against a slow box, but far under two grace periods.
  expect(Date.now() - started, 'a refusal must not cost the grace period').toBeLessThan(2_500);
  expect(asked.filter(fromUs)).not.toEqual([]);
});

test('telegram.org answering in time is used, and our copy is never asked for', async ({
  page,
  request,
}) => {
  // The real script, served off our own origin — which is also a check that the
  // vendored copy is actually deployed and executable, not just committed.
  const copy = await request.get('./telegram-web-app.js');
  expect(copy.ok(), 'the vendored copy must be served next to index.html').toBe(true);
  const script = await copy.text();
  expect(script.length).toBe(116510);

  const asked: string[] = [];
  page.on('request', (request_) => {
    asked.push(request_.url());
  });
  await page.route(/telegram\.org/, (route: Route) =>
    route.fulfill({ contentType: 'application/javascript', body: script }),
  );

  await launch(page);
  await waitForWiring(page);
  expect(asked.filter(fromTelegram), 'telegram.org is asked').not.toEqual([]);
  expect(asked.filter(fromUs), 'and nothing else is').toEqual([]);
});

/**
 * The awkward order the fallback invents: telegram.org is merely slow, so both
 * copies are in flight and both arrive. The remote request is deliberately not
 * cancelled when the grace runs out — aborting a slow request would throw away
 * the last copy if the local one were missing from the deploy — so the script
 * really does execute twice here.
 *
 * Two different things must then hold, and they pull in opposite directions.
 * `ready`, `expand` and the swipe must happen **once**. The chrome colours must
 * **not**: running the official script re-posts the player's own themeParams at
 * the client, so a second copy left to itself makes the player's light theme
 * the last word on the chrome — a white frame around a dark game, which is
 * exactly what `GOAL_V1` condition 2 records as fixed.
 *
 * Both orders are covered: on a throttled host either copy can be the slow one,
 * and a throttled telegram.org — not a blocked one — is the ordinary case for
 * the audience this fallback was written for.
 */
for (const order of ['telegram.org last', 'the local copy last'] as const) {
  test(`with both copies arriving, ${order}, the wiring is once and our colour is last`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const script = await (await request.get('./telegram-web-app.js')).text();
    const slowly = (ms: number) => async (route: Route) => {
      await new Promise<void>((done) => {
        setTimeout(done, ms);
      });
      await route.fulfill({ contentType: 'application/javascript', body: script });
    };
    // Either way both are in flight past the 2.5 s grace, so both are fetched
    // and both execute; only the order of arrival differs.
    const remoteMs = order === 'telegram.org last' ? 6_000 : 3_500;
    const localMs = order === 'telegram.org last' ? 0 : 6_000;
    await page.route((url) => url.hostname === 'telegram.org', slowly(remoteMs));
    if (localMs > 0) {
      await page.route(
        (url) => url.hostname !== 'telegram.org' && url.pathname.endsWith('/telegram-web-app.js'),
        slowly(localMs),
      );
    }

    await launch(page);
    await waitForWiring(page);
    // Let the late arrival land and run.
    await page.waitForTimeout(8_000);

    const events = await heard(page);
    expect(events.filter((event) => event === 'web_app_ready')).toHaveLength(1);
    expect(events.filter((event) => event === 'web_app_expand')).toHaveLength(1);
    expect(events.filter((event) => event === 'web_app_setup_swipe_behavior')).toHaveLength(1);
    // The script really did run twice — otherwise this proves nothing.
    expect(
      events.filter((event) => event === 'web_app_request_theme').length,
      'both copies must actually have executed',
    ).toBeGreaterThan(1);
    assertOursLast(await heardWithData(page));
  });
}
