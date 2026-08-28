/**
 * Telegram Mini App integration, client-side only (no bot, no server).
 *
 * Everything Telegram-specific lives in this one module; the rest of the game
 * never touches window.Telegram. Outside Telegram every call degrades to a
 * harmless no-op, so the game runs exactly as before in a plain browser, a local
 * dev server or on GitHub Pages. No secrets, no requests to a bot — the
 * ready()/theme/fullscreen calls are all part of the WebView page API.
 *
 * One trap is worth stating once (issue #12): the official script is loaded by
 * index.html in every browser and defines window.Telegram.WebApp everywhere, so
 * the object's existence proves nothing. `isTelegram()` below asks for a Mini
 * App session instead, and that is the question the rest of the game asks.
 */

/**
 * The slice of the WebView API we actually use. The official script defines a
 * much bigger WebApp object; declaring only the members we call keeps the types
 * honest and lets a partial or missing build (and test fakes) still work.
 */
interface TelegramWebAppLike {
  ready(): void;
  /**
   * The signed session of a real Mini App launch. Empty outside Telegram — the
   * official script defines the whole WebApp object in any browser, so this is
   * what tells a launch from a stub (issue #12).
   */
  initData?: string;
  initDataUnsafe?: {
    auth_date?: number | string;
    hash?: string;
    query_id?: string;
    user?: unknown;
  };
  /** Push the window out of a collapsed Mini App to full-height, if supported. */
  expand?(): void;
  colorScheme?: 'light' | 'dark';
  themeParams?: { bg_color?: string; text_color?: string };
  /** True when the user's Telegram client is at least a Bot API version. */
  isVersionAtLeast?(version: string): boolean;
  /** Edge-to-edge Mini App (Bot API 8.0+). */
  requestFullscreen?(): Promise<boolean> | void;
  /** Keep the Mini App portrait (Bot API 8.0+). */
  lockOrientation?(): Promise<void> | void;
}

interface TelegramLike {
  WebApp?: TelegramWebAppLike;
}

declare global {
  interface Window {
    Telegram?: TelegramLike;
  }
}

/**
 * The Telegram WebView API object, or null when the script did not define one.
 *
 * Careful: this says the **script** is there, not that Telegram is. `index.html`
 * loads the official telegram-web-app.js unconditionally, and it defines
 * window.Telegram.WebApp in any browser — version «6.0», a working ready() and
 * an empty session. Use it only for calls that are harmless outside Telegram
 * (ready/expand, which post a message nobody is listening to); for decisions,
 * ask `isTelegram()`.
 */
function tg(): TelegramWebAppLike | null {
  const app = window.Telegram?.WebApp;
  return app && typeof app.ready === 'function' ? app : null;
}

/**
 * Was this WebApp object handed a real Mini App session (issue #12)? A launch
 * from Telegram always carries `initData` — the signed launch parameters — while
 * the script's own stub in a plain browser leaves it an empty string. Older
 * clients that filled only the parsed copy are covered by the second half: any
 * of the launch fields being present is a session too. Nothing here is trusted
 * as a credential; it only answers «are we inside the app or not».
 */
function hasTelegramSession(app: TelegramWebAppLike): boolean {
  if (typeof app.initData === 'string' && app.initData.length > 0) {
    return true;
  }
  const parsed = app.initDataUnsafe;
  if (!parsed) {
    return false;
  }
  return (
    parsed.auth_date !== undefined ||
    parsed.hash !== undefined ||
    parsed.query_id !== undefined ||
    parsed.user !== undefined
  );
}

/**
 * True only inside a real Telegram Mini App. Everything that changes behaviour
 * asks this, never the mere existence of the object: `src/main.ts` skips its own
 * screen.orientation.lock inside Telegram (the WebView owns the orientation
 * there), and skipping it everywhere left the portrait lock dead in every
 * browser — the whole of issue #12.
 */
function isTelegram(): boolean {
  const app = tg();
  return app !== null && hasTelegramSession(app);
}

/**
 * Tell Telegram the app has loaded; this hides the placeholder Telegram shows
 * while the frame is loading. It also expand()s the Mini App to full height and
 * registers the first-gesture fullscreen/orientation takeover (Bot API 8.0+).
 * Safe to call at any time; outside Telegram every step is a no-op.
 */
function initTg(): void {
  const app = tg();
  if (!app) {
    return;
  }
  try {
    app.ready();
    app.expand?.();
    setupFullscreenOnGesture(app);
  } catch {
    // The WebView API should never throw here, but never let it block startup.
  }
}

/**
 * Match the page chrome to the Telegram theme without touching the game's own
 * palette (that lives in layout.ts and is intentionally fixed). The FIT canvas
 * covers most of the screen; this only makes the unpainted frame around it
 * blend with the Telegram background (themeParams.bg_color) and keeps native
 * controls (scrollbars, select menus) on the right colour scheme. Outside
 * Telegram the page keeps its fixed dark CSS, unchanged.
 */
function applyTgTheme(): void {
  const app = tg();
  // The stub outside Telegram reports a colour scheme of its own; the plain web
  // build keeps its fixed dark page, so the theme is applied only for a real
  // Mini App session.
  if (!app || !isTelegram()) {
    return;
  }
  try {
    if (app.colorScheme) {
      document.documentElement.style.colorScheme = app.colorScheme;
    }
    const bg = app.themeParams?.bg_color;
    if (bg) {
      document.body.style.backgroundColor = bg;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (meta) {
        meta.content = bg;
      }
    }
  } catch {
    // Theming is cosmetic; failures must not affect the game.
  }
}

/**
 * Take over the whole Mini App screen on the first user tap (Bot API 8.0+):
 * requestFullscreen() makes the game edge-to-edge and lockOrientation() pins it
 * to portrait. Both are best-effort — unsupported or refused calls degrade
 * silently to the CSS safe-area padding and the rotation overlay.
 *
 * This runs only when Telegram is present. main.ts's own setupOrientation()
 * skips its screen.orientation.lock when isTelegram() is true, so the two never
 * fight over the screen orientation.
 */
function setupFullscreenOnGesture(app: TelegramWebAppLike): void {
  // Both calls need Bot API 8.0+. On older clients the official script prints a
  // console error if they are attempted, so gate them on the version support.
  const supported =
    typeof app.isVersionAtLeast === 'function' && app.isVersionAtLeast('8.0');
  const onGesture = (): void => {
    try {
      if (supported) {
        const fs = app.requestFullscreen?.();
        if (fs && typeof (fs as Promise<unknown>).then === 'function') {
          void (fs as Promise<unknown>).catch(() => {
            // Fullscreen can be refused (no gesture / older WebView): the boxed
            // layout below still holds, so there is nothing to do.
          });
        }

        const lock = app.lockOrientation?.();
        if (lock && typeof (lock as Promise<unknown>).then === 'function') {
          void (lock as Promise<unknown>).catch(() => {
            // Lock may be unsupported: the «turn the phone» overlay covers it.
          });
        }
      }
    } catch {
      // Best-effort only.
    }
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('touchend', onGesture);
  };

  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('touchend', onGesture);
}

export { tg, hasTelegramSession, isTelegram, initTg, applyTgTheme };
