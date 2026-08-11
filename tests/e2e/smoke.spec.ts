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

  await page.goto('./', { waitUntil: 'load' });

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
