/**
 * Telegram Mini App integration, client-side only (no bot, no server).
 *
 * Everything Telegram-specific lives in this one module; the rest of the game
 * never touches window.Telegram. Outside Telegram every call degrades to a
 * harmless no-op, so the game runs exactly as before in a plain browser, a local
 * dev server or on GitHub Pages. No secrets, no requests to a bot — the
 * ready()/swipe/colour/fullscreen calls are all part of the WebView page API.
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
  /** True when the user's Telegram client is at least a Bot API version. */
  isVersionAtLeast?(version: string): boolean;
  /**
   * Stop a vertical swipe from closing or minimising the Mini App
   * (Bot API 7.7+). The one gesture the game has is a vertical swipe over the
   * shaft, so without this the player scrolls the mine and leaves the game.
   */
  disableVerticalSwipes?(): void;
  /** Colour of the area Telegram paints around the Mini App (Bot API 6.1+). */
  setBackgroundColor?(color: string): void;
  /** Colour of Telegram's own header above the Mini App (hex: Bot API 6.9+). */
  setHeaderColor?(color: string): void;
  /** Colour of Telegram's bottom action bar (Bot API 7.10+). */
  setBottomBarColor?(color: string): void;
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
 * The Bot API version each optional call was introduced in. Telegram's own
 * script checks the same numbers and only prints a console warning when a call
 * is too new for the client, but two of them do more than warn — a hex header
 * colour throws below 6.9 — and a warning on every launch is noise we can just
 * not make. So every call below is asked for by version first.
 */
const SINCE = {
  /** disableVerticalSwipes / enableVerticalSwipes. */
  verticalSwipes: '7.7',
  /** setBackgroundColor. */
  backgroundColor: '6.1',
  /** setHeaderColor with a hex colour; older clients take theme keys only. */
  headerColor: '6.9',
  /** setBottomBarColor. */
  bottomBarColor: '7.10',
  /** requestFullscreen and lockOrientation. */
  fullscreen: '8.0',
} as const;

/**
 * The two fixed boxes index.html lays out: the Phaser parent and the «turn the
 * phone» overlay. Both are sized to the window, and inside Telegram the window
 * is not the visible area — see `bindTelegramViewport()`.
 */
const GAME_BOX_ID = 'game';
const ROTATE_BOX_ID = 'rotate';

/**
 * The page's own background, kept in one place: the `theme-color` meta of
 * index.html. Telegram's chrome is painted with it so the player's own light
 * theme cannot show through around a dark game (see `applyTgTheme`).
 */
const PAGE_BACKGROUND = '#05070d';

/**
 * The colours Telegram's own parseColorToHex accepts: `#rgb` and `#rrggbb`.
 * Anything else — an 8-digit hex, a colour name — makes the setters throw.
 */
const TELEGRAM_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The official client script. It has to come from Telegram's own origin so a
 * client update reaches every Mini App without a rebuild, which is why
 * `index.html` used to carry it as a plain `<script src>` first thing in
 * `<head>` — and that is exactly what stopped the parser dead on a browser that
 * cannot reach telegram.org. A blocked host does not refuse the connection, it
 * swallows it: measured with the host dropped, the page still had no <body>, no
 * page style and no canvas after 40 seconds — a blank white screen and a player
 * who leaves (issue #16). The tag is gone from the page; the script is asked for
 * from here instead, after the game has already started, and only for a launch
 * that actually came from Telegram (`isTelegramLaunch`).
 */
const SCRIPT_URL = 'https://telegram.org/js/telegram-web-app.js?63';

/**
 * The prefix of every launch parameter Telegram puts in the URL of a Mini App:
 * `#tgWebAppData=…&tgWebAppVersion=…&tgWebAppPlatform=…&tgWebAppThemeParams=…`.
 * Android, iOS, Desktop and Web all pass them the same way, and the official
 * script reads that same hash.
 */
const LAUNCH_PARAM_PREFIX = 'tgWebApp';

/**
 * Where the official script keeps the launch parameters once it has read them
 * (`sessionStorageSet('initParams', …)`), so a Mini App whose page reloaded
 * without the hash is still recognised as one.
 */
const LAUNCH_MEMORY_KEY = '__telegram__initParams';

/**
 * Start Telegram without ever making the player wait for Telegram (issue #16).
 *
 * Two things happen here, and the order is the whole point:
 *
 * 1. If the WebApp object is already on the page — a client that injected it, a
 *    test harness — the wiring is applied **synchronously**, exactly as it was
 *    when `index.html` loaded the script ahead of the module. Nothing about a
 *    real launch that goes this way changes.
 * 2. Otherwise the script is fetched asynchronously and the caller returns at
 *    once, so the game boots while the request is still in flight. When (and
 *    only if) the script arrives, the same wiring is applied to the object it
 *    defined — see `applyTgWiring`.
 *
 * And it is only fetched for a launch that looks like Telegram's, because for
 * any other page the fetch buys nothing: with no launch parameters the script
 * leaves the «6.0» stub with an empty session, every call in this module is
 * gated at 6.1 or newer, and the one thing it does set — the viewport variable
 * — it sets to the literal string `100vh`, which is what our own `var(…, 100vh)`
 * fallback already resolves to. So the plain-browser build is unchanged down to
 * the CSS, minus one request to a third-party host that can hang.
 */
function startTg(): void {
  if (applyTgWiring()) {
    return;
  }
  if (!isTelegramLaunch()) {
    return;
  }
  // The fullscreen takeover waits for the player's first tap, and a script that
  // arrives after that tap would arm a listener for a gesture that has already
  // happened. So the tap is watched for while we wait, and handed to the wiring.
  let tapped = false;
  const seen = (): void => {
    tapped = true;
    forget();
  };
  const forget = (): void => {
    window.removeEventListener('pointerdown', seen);
    window.removeEventListener('touchend', seen);
  };
  window.addEventListener('pointerdown', seen);
  window.addEventListener('touchend', seen);
  loadTelegramScript(() => {
    forget();
    applyTgWiring({ tapped });
  }, forget);
}

/**
 * Apply everything this module does to the client, if there is a client object
 * to apply it to. Returns whether there was one.
 */
function applyTgWiring(options: { readonly tapped?: boolean } = {}): boolean {
  if (tg() === null) {
    return false;
  }
  initTg(options);
  applyTgTheme();
  return true;
}

/**
 * Put the official script on the page without blocking anything: `async` so the
 * parser never waits for it, appended after the game module has already run.
 * `onReady` fires when the script has executed and defined its object, `onGone`
 * when the request failed. A request that neither answers nor fails — a host
 * that is quietly dropped rather than refused, which is the case this whole
 * change is about — simply never calls either, and nothing is waiting on it.
 */
function loadTelegramScript(onReady: () => void, onGone: () => void): void {
  try {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = onReady;
    script.onerror = onGone;
    const parent = document.head ?? document.documentElement;
    parent.appendChild(script);
  } catch {
    // A page that will not take a script tag is a page without Telegram; the
    // game is already running and does not care.
    onGone();
  }
}

/**
 * Does this page look like a Mini App launch? Three signals, any one is enough:
 * the launch parameters in the URL, the copy the official script leaves in
 * sessionStorage after a reload, and the WebView object the mobile clients
 * inject before the page is even parsed.
 *
 * A false negative costs a launch its Telegram wiring, a false positive costs
 * one request nobody waits for — so this is deliberately generous.
 */
function isTelegramLaunch(): boolean {
  if (hasWebviewProxy() || rememberedLaunch()) {
    return true;
  }
  try {
    const url = window.location;
    return hasLaunchParams(String(url?.hash ?? ''), String(url?.search ?? ''));
  } catch {
    return false;
  }
}

/**
 * Do these two halves of a URL carry Telegram's launch parameters? Kept apart
 * from `location` so the question can be asked of a string in a test, the way
 * `fpsRequested` is.
 */
function hasLaunchParams(hash: string, search: string): boolean {
  return hash.includes(LAUNCH_PARAM_PREFIX) || search.includes(LAUNCH_PARAM_PREFIX);
}

/** The launch the official script wrote down before the page was reloaded. */
function rememberedLaunch(): boolean {
  try {
    const stored = window.sessionStorage?.getItem(LAUNCH_MEMORY_KEY);
    return typeof stored === 'string' && stored.includes(LAUNCH_PARAM_PREFIX);
  } catch {
    // Storage can be denied outright (private mode, third-party frame): then
    // this signal is simply not available and the other two decide.
    return false;
  }
}

/**
 * The bridge the Android client puts on `window` before the page is parsed;
 * Telegram's own script talks to the client through it, so its presence is a
 * Mini App and nothing else. iOS uses a WebKit message handler instead, which
 * every WKWebView has and so proves nothing — an iOS launch is recognised by
 * its hash like every other.
 */
function hasWebviewProxy(): boolean {
  const host = window as unknown as { TelegramWebviewProxy?: unknown };
  return host.TelegramWebviewProxy !== undefined && host.TelegramWebviewProxy !== null;
}

/**
 * The Telegram WebView API object, or null when the script did not define one.
 *
 * Careful: this says the **script** is there, not that Telegram is. The script
 * defines window.Telegram.WebApp in any browser it is loaded into — version
 * «6.0», a working ready() and an empty session — and a harness or a client can
 * put the object there itself. Use it only for calls that are harmless outside
 * Telegram (ready/expand, which post a message nobody is listening to); for
 * decisions, ask `isTelegram()`.
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
 * Is this client's Bot API new enough for a call? The stub the script leaves in
 * a plain browser answers «6.0» to everything, so this is false there for every
 * version below, which is what keeps the web build silent and unchanged.
 *
 * It answers a boolean and nothing else, on purpose: every caller asks it before
 * a `try`, so a client whose isVersionAtLeast throws would otherwise take out
 * the call that was about to be guarded — and, in `setupFullscreenOnGesture`,
 * the listeners that had not been registered yet.
 */
function supports(app: TelegramWebAppLike, version: string): boolean {
  if (typeof app.isVersionAtLeast !== 'function') {
    return false;
  }
  try {
    return app.isVersionAtLeast(version) === true;
  } catch {
    return false;
  }
}

/**
 * Take the vertical swipe away from Telegram and give it to the shaft.
 *
 * `PLAN_V1` §3 has exactly one gesture: a vertical swipe over the mine, which
 * scrolls the camera deeper. In Telegram a vertical swipe down is also the
 * client's own «close / minimise the Mini App» gesture, so without this call the
 * player who drags the shaft down leaves the game. Bot API 7.7+; the call posts
 * a message to the client and needs no user gesture, so it is made at startup.
 *
 * Returns whether the call was actually made, which is what the tests read.
 */
function disableVerticalSwipes(app: TelegramWebAppLike): boolean {
  if (!supports(app, SINCE.verticalSwipes) || typeof app.disableVerticalSwipes !== 'function') {
    // Older client, or a build of the script without the method: the swipe stays
    // Telegram's. Nothing else in the game depends on this having worked.
    return false;
  }
  try {
    app.disableVerticalSwipes();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell Telegram the app has loaded; this hides the placeholder Telegram shows
 * while the frame is loading. It also expand()s the Mini App to full height,
 * takes the vertical swipe away from the client (Bot API 7.7+) and registers the
 * first-gesture fullscreen/orientation takeover (Bot API 8.0+).
 * Safe to call at any time; outside Telegram every step is a no-op.
 *
 * `tapped` says the player has already made that first gesture — which happens
 * when the official script arrived after the game had started (issue #16), and
 * means the takeover has to be done now rather than waited for.
 */
function initTg(options: { readonly tapped?: boolean } = {}): void {
  const app = tg();
  if (!app) {
    return;
  }
  try {
    app.ready();
    // expand() first: everything measured afterwards (the viewport binding
    // below, Phaser's first fit) should see the full-height Mini App, not the
    // collapsed sheet Telegram can open it in.
    app.expand?.();
    disableVerticalSwipes(app);
    setupFullscreenOnGesture(app, options.tapped === true);
  } catch {
    // The WebView API should never throw here, but never let it block startup.
  }
  bindTelegramViewport();
}

/**
 * Keep the game's own dark page, and paint Telegram's chrome to match it.
 *
 * The game's palette is fixed (`layout.ts`) and the page around the FIT canvas
 * is fixed dark (`index.html`). Copying `themeParams.bg_color` onto the page —
 * which this used to do — meant a player on the light Telegram theme got white
 * letterbox bars around a dark pixel-art game, which is exactly the «foreign
 * theme showing through» that `GOAL_V1` condition 2 rules out. So the flow is
 * reversed: our colour goes out to Telegram, not Telegram's colour into us.
 *
 * Every call is version-gated and optional; on a client too old for them the
 * page is still dark and only Telegram's own header stays themed.
 * Outside Telegram nothing here runs at all.
 */
function applyTgTheme(): void {
  const app = tg();
  // Not `isTelegram()`. A session says a launch was signed; what this needs to
  // know is whether there is a Telegram client on the other end at all, and a
  // launch that arrived with an empty initData is still a launch — gating the
  // chrome on the session would leave exactly that player with a light frame
  // around a dark game. Any real client answers 6.1 or newer; the script's stub
  // in a plain browser answers «6.0» to everything, so the web build is silent.
  if (!app || !supports(app, SINCE.backgroundColor)) {
    return;
  }
  const color = pageBackground();
  // One try per call, not one around all four. `setBackgroundColor` and friends
  // throw on a colour they cannot parse, and sharing a try means the first
  // refusal silently swallows the two calls behind it.
  paint(() => {
    // Native controls (scrollbars, select menus) follow the page, not the client.
    document.documentElement.style.colorScheme = 'dark';
  });
  paint(() => app.setBackgroundColor?.(color));
  // A hex header colour needs 6.9. Below that the method accepts only the theme
  // keys (`bg_color` / `secondary_bg_color`) and throws on anything else — and
  // those keys are the light theme we are covering up, so on an older client the
  // header is simply left alone.
  if (supports(app, SINCE.headerColor)) {
    paint(() => app.setHeaderColor?.(color));
  }
  if (supports(app, SINCE.bottomBarColor)) {
    paint(() => app.setBottomBarColor?.(color));
  }
}

/** Run one cosmetic step; a failed one must never take the next one with it. */
function paint(step: () => void): void {
  try {
    step();
  } catch {
    // Colouring is cosmetic; failures must not affect the game.
  }
}

/**
 * The page background as index.html declares it, with the value as a fallback.
 *
 * The test is not «is this valid CSS» but «will Telegram parse it»: its
 * parseColorToHex takes `#rgb`, `#rrggbb` and `rgb()/rgba()` and nothing else,
 * and a colour it refuses makes setBackgroundColor **throw** rather than return.
 * `#05070dff` is perfectly good CSS and would have turned the whole chrome back
 * to the player's own light theme, which is the bug this file exists to stop.
 */
function pageBackground(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const declared = meta?.content?.trim();
  return declared !== undefined && TELEGRAM_HEX.test(declared) ? declared : PAGE_BACKGROUND;
}

/**
 * Size the page to Telegram's visible area instead of the WebView window.
 *
 * `window.innerHeight` inside a Mini App is the height of the WebView, and
 * Telegram's visible area is not the same number: a Mini App can open as a
 * part-height sheet, and while it is being dragged the visible area shrinks
 * while the window does not. Telegram publishes the honest number as the CSS
 * variable `--tg-viewport-stable-height` (the last *settled* height, so it does
 * not jitter through the drag), and this pins the two fixed boxes of index.html
 * to it. Phaser's Scale.FIT measures the parent box, so the canvas follows.
 *
 * There is deliberately no “are we in Telegram” gate on this. The official
 * script sets the variable in every browser — 100vh when no client ever sent a
 * viewport — so outside Telegram the calc resolves to exactly the box index.html
 * already lays out, and the web build is unchanged. A gate would only buy the
 * chance of a real Mini App launch failing the gate and being sized to the
 * WebView instead of to the screen the player can see.
 */
function bindTelegramViewport(): void {
  try {
    const stable = 'var(--tg-viewport-stable-height, 100vh)';
    const game = document.getElementById(GAME_BOX_ID);
    if (game) {
      // The safe-area insets are taken off the box in index.html by `top` and
      // `bottom`; with an explicit height `bottom` is ignored, so both insets
      // have to come out of the height instead.
      game.style.height = `calc(${stable} - var(--safe-top, 0px) - var(--safe-bottom, 0px))`;
    }
    const rotate = document.getElementById(ROTATE_BOX_ID);
    if (rotate) {
      // The overlay is a full-bleed blocker; it only has to stop its centred
      // message from being centred in a box taller than the player can see.
      rotate.style.height = stable;
    }
  } catch {
    // A layout hint only: without it the page keeps the box index.html ships.
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
 *
 * `alreadyTapped` is the late-script case of issue #16: the script can arrive
 * after the player has tapped, and then there is no first gesture left to wait
 * for. Both calls are postMessages to the client and need no gesture of their
 * own — the tap is what the takeover is polite about, not what it requires —
 * so the takeover is simply done on the spot.
 */
function setupFullscreenOnGesture(app: TelegramWebAppLike, alreadyTapped = false): void {
  // Both calls need Bot API 8.0+. On older clients the official script prints a
  // console error if they are attempted, so gate them on the version support.
  const supported = supports(app, SINCE.fullscreen);
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

  if (alreadyTapped) {
    onGesture();
    return;
  }

  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('touchend', onGesture);
}

export {
  tg,
  hasTelegramSession,
  isTelegram,
  startTg,
  initTg,
  applyTgTheme,
  disableVerticalSwipes,
  hasLaunchParams,
  isTelegramLaunch,
};
export type { TelegramWebAppLike };
