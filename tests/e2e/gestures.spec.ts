import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #11 in the built game: a swipe that starts on a button must not press
 * it. The salvo is the expensive case — 45 seconds of cooldown spent by a finger
 * that was only scrolling the shaft — so it is the one measured here, on the
 * production build, through real pointer events.
 *
 * There is no hook into the game state on purpose: what the test reads is what
 * the player sees. While the salvo is ready its button is a still picture
 * («ЗАЛП», filled); the moment it is spent the fill drains and the label starts
 * counting down. So «did the salvo go off» is «did those pixels change», and
 * the picture is byte-stable between frames as long as nothing happens.
 */

/** Design pixels of the layout (src/game/layout.ts), the canvas is FIT-scaled. */
const DESIGN_WIDTH = 720;
/** «ЗАЛП»: the right half of the button row of the dome zone. */
const SALVO = { x: 372, y: 346, width: 324, height: 56 };
/** «НАЧАТЬ СМЕНУ» on the base screen. */
const START = { x: 360, y: 1138 };
/** A travel this long is a swipe by any reading (the threshold is 24). */
const SWIPE = 300;

/** Maps design pixels to page pixels through the canvas box. */
async function canvasFrame(page: Page) {
  const canvas = page.locator('#game canvas');
  await expect(canvas).toBeAttached({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('the canvas has no box');
  }
  const scale = box.width / DESIGN_WIDTH;
  return {
    point: (x: number, y: number) => ({ x: box.x + x * scale, y: box.y + y * scale }),
    clip: (x: number, y: number, width: number, height: number) => ({
      x: box.x + x * scale,
      y: box.y + y * scale,
      width: width * scale,
      height: height * scale,
    }),
  };
}

test('a swipe that starts on «ЗАЛП» does not spend the salvo, a press does', async ({ page }) => {
  // `domcontentloaded`, not `load`: nothing here needs every subresource, and
  // waiting for them let an unreachable third-party host read as a code
  // regression (issue #16). `canvasFrame` waits for what actually matters.
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  const frame = await canvasFrame(page);
  await page.waitForTimeout(1500);

  // Base → shift.
  const start = frame.point(START.x, START.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1500);

  const button = frame.clip(SALVO.x, SALVO.y, SALVO.width, SALVO.height);
  const ready = await page.screenshot({ clip: button });
  // The picture of a ready salvo does not move by itself.
  await page.waitForTimeout(600);
  expect(await page.screenshot({ clip: button })).toEqual(ready);

  // A finger that goes down on the button and travels away: no order.
  const from = frame.point(SALVO.x + SALVO.width / 2, SALVO.y + SALVO.height / 2);
  const to = frame.point(SALVO.x + SALVO.width / 2, SALVO.y + SALVO.height / 2 + SWIPE);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect(await page.screenshot({ clip: button }), 'a swipe must not fire the salvo').toEqual(ready);

  // A press that wobbles under the threshold is still a press, and it fires on
  // release.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 3);
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect(await page.screenshot({ clip: button }), 'a press must fire the salvo').not.toEqual(ready);
});

test('a swipe that starts on «НАЧАТЬ СМЕНУ» does not start the shift', async ({ page }) => {
  // `domcontentloaded`, not `load`: nothing here needs every subresource, and
  // waiting for them let an unreachable third-party host read as a code
  // regression (issue #16). `canvasFrame` waits for what actually matters.
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  const frame = await canvasFrame(page);
  await page.waitForTimeout(1500);

  // The bottom strip of the base screen: the start button and the hangar bar.
  const strip = frame.clip(0, 1060, DESIGN_WIDTH, 200);
  const base = await page.screenshot({ clip: strip });

  const from = frame.point(START.x, START.y);
  const to = frame.point(START.x, START.y - SWIPE);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 12);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
  expect(await page.screenshot({ clip: strip }), 'the base screen must still be here').toEqual(base);

  // …and a plain press does start it.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1500);
  expect(await page.screenshot({ clip: strip }), 'the shift must have started').not.toEqual(base);
});
