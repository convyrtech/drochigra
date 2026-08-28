/**
 * The frame counter, shown only when the page is opened with `?fps=1`
 * (issue #8: «стабильные 60 кадров» has to be a number somebody can read off
 * the screen, not a feeling). It is a plain DOM box over the canvas, not a
 * Phaser text: that way it survives every scene restart, costs the game loop
 * nothing, and cannot be mistaken for part of the game.
 *
 * It counts the frames the browser actually paints, on its own
 * requestAnimationFrame — not Phaser's `loop.actualFps`, which is smoothed and
 * would hide exactly the stutter this is here to catch. Three figures:
 *
 *   КАДРЫ  — frames painted over the last second;
 *   ХУДШИЕ — the worst such second since the page opened;
 *   ПИК    — the longest single frame, in milliseconds (60 fps is 16.7).
 */

/** How often the box is repainted, in milliseconds. Reading it is enough. */
const REFRESH_MS = 250;
/** The window the frame rate is counted over. */
const WINDOW_MS = 1000;
/**
 * Frames ignored after the start and after every resume: the first frames of a
 * page (and of a tab coming back from the background) are always long, and a
 * counter that remembers them for the rest of the session says nothing.
 */
const WARMUP_MS = 1500;

/** True when the page asks for the counter: `?fps=1`. */
export function fpsRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('fps');
  return value !== null && value !== '0' && value !== '';
}

/** Attach the counter to the page. Call once, after the game is created. */
export function showFpsOverlay(): void {
  const box = document.createElement('div');
  box.id = 'fps';
  box.setAttribute('style', [
    'position:fixed',
    'top:0',
    'left:0',
    'z-index:1001',
    'padding:4px 8px',
    'font:12px/1.35 system-ui, sans-serif',
    'color:#8ef0ff',
    'background:rgba(5,7,13,0.78)',
    'white-space:pre',
    'pointer-events:none',
  ].join(';'));
  document.body.appendChild(box);

  /** Timestamps of the frames of the last second. */
  let recent: number[] = [];
  let previous: number | null = null;
  let fps = 0;
  let worstFps = Infinity;
  let worstFrameMs = 0;
  let measuringFrom = performance.now() + WARMUP_MS;
  let painted = 0;

  // A tab in the background is not a slow game: the scene is paused there
  // (MainScene.wirePauseHandling) and rAF stops, so the frame that spans the
  // pause would otherwise be recorded as the worst one of the run.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      measuringFrom = performance.now() + WARMUP_MS;
      previous = null;
      recent = [];
    }
  });

  const frame = (now: number): void => {
    requestAnimationFrame(frame);

    recent.push(now);
    while (recent.length > 0 && (recent[0] as number) <= now - WINDOW_MS) {
      recent.shift();
    }
    const span = now - (recent[0] as number);
    if (span > 0) {
      fps = ((recent.length - 1) * 1000) / span;
    }

    const gap = previous === null ? 0 : now - previous;
    previous = now;

    // A full window of frames is needed before the worst second means anything.
    if (now >= measuringFrom) {
      worstFrameMs = Math.max(worstFrameMs, gap);
      if (span >= WINDOW_MS * 0.9) {
        worstFps = Math.min(worstFps, fps);
      }
    }

    if (now - painted >= REFRESH_MS) {
      painted = now;
      const worst = Number.isFinite(worstFps) ? worstFps : fps;
      box.textContent =
        `КАДРЫ ${Math.round(fps)} · ХУДШИЕ ${Math.round(worst)} · ПИК ${Math.round(worstFrameMs)} мс`;
    }
  };

  requestAnimationFrame(frame);
}
