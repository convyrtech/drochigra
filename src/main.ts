import { loadArtIndex } from './game/artTextures.js';
import { createGame } from './game/createGame.js';
import { loadBalance } from './game/loadBalance.js';
import { startTg, isTelegram, isTelegramLaunch } from './game/tg.js';
import { fpsRequested, showFpsOverlay } from './ui/fpsOverlay.js';

const PARENT_ID = 'game';
/** Phone-ish: the smaller screen edge under this is a handheld device. */
const MOBILE_EDGE_PX = 600;

async function start(): Promise<void> {
  // Telegram Mini App: ready() hides the placeholder and full-screens on the
  // first tap. Outside Telegram this does nothing at all — it does not even ask
  // telegram.org for the client script, which is what used to hold the whole
  // page hostage to a third-party host (issue #16). Inside Telegram the script
  // is fetched asynchronously and the wiring is applied the moment it lands, so
  // nothing below waits for it either: see src/game/tg.ts.
  startTg();
  // The balance must load or there is no game; the art index is allowed to be
  // missing, and then the game draws itself out of rectangles as it always did.
  const [balance, art] = await Promise.all([loadBalance(), loadArtIndex()]);
  createGame(PARENT_ID, balance, art);
  // `?fps=1` puts the frame counter on the screen (issue #8). Off by default:
  // the players must never see it, the checks always can.
  if (fpsRequested(window.location.search)) {
    showFpsOverlay();
  }
}

/**
 * Keep the game portrait (issue #8). `screen.orientation.lock` needs a user
 * gesture and fullscreen in some browsers and just does not exist on desktop,
 * so it is wrapped and deferred to the first tap. Where the browser refuses
 * (or lock is missing), the CSS fallback — the «turn the phone» overlay, driven
 * by body.landscape below — covers the sideways hold.
 */
function setupOrientation(): void {
  const lock = (): void => {
    // Inside Telegram the WebView takes over orientation/fullscreen on the
    // first tap (src/game/tg.ts), so locking the native orientation here as
    // well would fight it. Outside Telegram this stays the only lock, as before.
    //
    // Asked of the launch, not of the object: the client script is fetched
    // after the game starts now, and a tap that lands before it arrives would
    // otherwise see no `window.Telegram` yet and fire the native lock inside a
    // real Mini App — exactly what the paragraph above forbids. The launch
    // parameters are in the URL from the first byte, so they answer correctly
    // whether the script has turned up or not.
    if (isTelegramLaunch() || isTelegram()) {
      return;
    }
    const orientation =
      'orientation' in screen && screen.orientation ? screen.orientation : null;
    if (!orientation || typeof orientation.lock !== 'function') {
      return;
    }
    orientation.lock('portrait').catch(() => {
      // Lock can be rejected (no user gesture / fullscreen policy): the overlay
      // fallback still applies, so this is not an error worth surfacing.
    });
  };

  // One-time on the first gesture: browsers that allow it lock to portrait.
  const gesture = (): void => {
    lock();
    window.removeEventListener('pointerdown', gesture);
    window.removeEventListener('touchend', gesture);
    window.removeEventListener('keydown', gesture);
  };
  window.addEventListener('pointerdown', gesture);
  window.addEventListener('touchend', gesture);
  window.addEventListener('keydown', gesture);

  // Overlay fallback: on a phone-sized screen held sideways, ask the player to
  // turn it. Desktop (a wide window with a tall enough short edge) is ignored.
  const updateRotate = (): void => {
    const handheld = Math.min(window.innerWidth, window.innerHeight) < MOBILE_EDGE_PX;
    const sideways = window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape', handheld && sideways);
  };
  updateRotate();
  window.addEventListener('resize', updateRotate);
  window.addEventListener('orientationchange', updateRotate);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const parent = document.getElementById(PARENT_ID);
  if (parent) {
    parent.textContent = `Ошибка запуска: ${message}`;
  }
  console.error(error);
});

setupOrientation();
