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
 * The same script, vendored into `content/` and therefore served from the very
 * origin the game itself came from — the fallback for issue #17.
 *
 * Loading it from telegram.org is worth keeping: the client script is versioned
 * by the client, and a copy that updates itself is one less thing to remember.
 * But «telegram.org is unreachable» and «Telegram is unreachable» are not the
 * same sentence, and for a Russian-speaking audience they routinely come apart:
 * the domain gets blocked while the app itself keeps working. Then the game
 * starts (that was issue #16) and the client hears nothing at all — no ready(),
 * no expand(), and no `disableVerticalSwipes()`, which hands the one gesture of
 * the game (`PLAN_V1` §3) back to Telegram, where it means «close the Mini App».
 *
 * So the remote copy is tried first and this one is asked for only when that
 * fails or stays silent — see `loadTelegramScript`. Same origin as the page, so
 * whatever reached the game reaches this too; `publicDir: 'content'` copies it
 * next to index.html on build, and `BASE_URL` keeps the path relative, exactly
 * as `loadBalance()` and the art do.
 */
const LOCAL_SCRIPT_URL = `${import.meta.env.BASE_URL}telegram-web-app.js`;

/**
 * How long telegram.org is given before the local copy is asked for as well.
 *
 * A blocked host is the case this exists for, and a blocked host does not
 * refuse — it swallows the connection and never answers, so `onerror` never
 * fires and only a clock can end the wait. The number is a compromise between
 * two costs: too short and a player on a slow-but-working connection fetches
 * 114 KB twice, too long and the swipe stays Telegram's for that long after the
 * game is already on screen. Nothing waits on this timer — the game has been
 * running since before the request was made.
 */
const REMOTE_GRACE_MS = 2500;

/**
 * The prefix of every launch parameter Telegram puts in the URL of a Mini App:
 * `#tgWebAppData=…&tgWebAppVersion=…&tgWebAppPlatform=…&tgWebAppThemeParams=…`.
 * Android, iOS, Desktop and Web all pass them the same way, and the official
 * script reads that same hash.
 */
const LAUNCH_PARAM_PREFIX = 'tgWebApp';

/** The same prefix, folded once, for the case-insensitive look-up below. */
const LAUNCH_PARAM_NEEDLE = LAUNCH_PARAM_PREFIX.toLowerCase();

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
 *    once, so the game boots while the request is still in flight — from
 *    telegram.org first and, if that host refuses or says nothing, from the
 *    copy the game ships with (issue #17). When (and only if) one of them
 *    arrives, the same wiring is applied to the object it defined — see
 *    `applyTgWiring`. If both arrive, `ready()`, `expand()` and the first-tap
 *    listener still happen exactly once; only the chrome colours are said
 *    again, because the second script re-posts the player's own theme on its
 *    way in and ours has to be the last word — see `loadTelegramScript`.
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
  loadTelegramScript(
    () => {
      // Asked, not assumed: `applyTgWiring` answers whether there was a client
      // object to wire at all. A copy that ran and left nothing behind must not
      // count as the answer, or the good copy still in flight is ignored — and
      // the tap must stay watched for, because that copy still needs it.
      const wired = applyTgWiring({ tapped });
      if (wired) {
        forget();
      }
      return wired;
    },
    // A second copy landed on top of a wired page. It re-posts the player's own
    // theme at the client on the way in, so our colour has to be said last
    // again; everything else about the wiring stays once.
    applyTgTheme,
    forget,
  );
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
 * Put the official script on the page without blocking anything, and make sure
 * one of the two copies of it actually lands (issues #16 and #17).
 *
 * The order is telegram.org first, our own copy second, and the second one is
 * asked for on either of the two ways the first can fail:
 *
 * - **it refuses** — `onerror`, the easy case, answered at once;
 * - **it says nothing** — the case this exists for. A blocked host does not
 *   refuse, it swallows the connection, so there is no event to react to and
 *   `REMOTE_GRACE_MS` on the clock is the only thing that can end the wait.
 *
 * Three things can happen to a copy, and each has its own callback:
 *
 * - `onArrived` — it executed and left a WebApp object. It **answers whether the
 *   wiring actually went on**, and only that answer closes the question: a
 *   response that executed but defined nothing (a 200 that was not the script)
 *   is counted as a failure, not as a win, so the other copy still gets its
 *   turn. Asking the callback rather than assuming is the difference between
 *   «the wiring landed» and «something loaded».
 * - `onAgain` — a **second** copy arrived after the wiring was already in place.
 *   This is not noise. Running the official script re-posts the player's own
 *   `themeParams` at the client, and three of those posts are colours: measured,
 *   the late copy said `set_background_color #ffffff`, `set_header_color
 *   bg_color` and `set_bottom_bar_color #ffffff`, so the **last** word on the
 *   chrome was the player's light theme around our dark game — exactly the bug
 *   `applyTgTheme` exists to prevent and `GOAL_V1` condition 2 rules out. So the
 *   colours are said again. `ready()`, `expand()` and the first-tap listener are
 *   not: those are once, whatever the order of arrivals.
 * - `onGone` — it failed, and it fires only when **both** have. A remote request
 *   that is still hanging is not «failed»: it may yet arrive.
 *
 * Both requests can be in flight at once — the timer starts the local copy
 * without cancelling the remote one, deliberately: aborting a slow request would
 * throw away the only copy left if the local one turned out to be missing from
 * the deploy. Two copies arriving is therefore an ordinary case, not an exotic
 * one: it happens on every launch where telegram.org takes longer than
 * `REMOTE_GRACE_MS`, which is what a throttled — rather than blocked — host
 * looks like.
 */
function loadTelegramScript(
  onArrived: () => boolean,
  onAgain: () => void,
  onGone: () => void,
): void {
  /** The wiring has been handed to a copy that arrived; the rest is noise. */
  let applied = false;
  let gaveUp = false;
  let localAsked = false;
  let remoteDead = false;
  let localDead = false;
  let waiting: number | undefined;

  const stopWaiting = (): void => {
    if (waiting === undefined) {
      return;
    }
    const timer = waiting;
    waiting = undefined;
    try {
      window.clearTimeout?.(timer);
    } catch {
      // A window without timers cannot have started one either.
    }
  };

  // Only when there is nothing left in flight: a dead local copy while the
  // remote one is still hanging is not an answer yet.
  const bothGone = (): void => {
    if (applied || gaveUp || !remoteDead || !localDead) {
      return;
    }
    gaveUp = true;
    stopWaiting();
    onGone();
  };

  /**
   * One copy of the script finished running. `gone` is how *this* copy reports
   * a failure, because an arrival that left no object behind is a failure — it
   * must not close the question for the other copy.
   */
  const arrival = (gone: () => void) => (): void => {
    if (applied) {
      onAgain();
      return;
    }
    if (onArrived()) {
      applied = true;
      stopWaiting();
      return;
    }
    gone();
  };

  const localGone = (): void => {
    localDead = true;
    bothGone();
  };

  const askLocal = (): void => {
    if (applied || localAsked) {
      return;
    }
    localAsked = true;
    stopWaiting();
    if (!appendScript(LOCAL_SCRIPT_URL, arrival(localGone), localGone)) {
      localGone();
    }
  };

  const remoteGone = (): void => {
    remoteDead = true;
    askLocal();
    bothGone();
  };

  if (!appendScript(SCRIPT_URL, arrival(remoteGone), remoteGone)) {
    // A page that will not take a script tag will not take the second one
    // either, but the cost of finding out is one more failed createElement.
    remoteGone();
    return;
  }
  waiting = waitBriefly(askLocal, REMOTE_GRACE_MS);
}

/**
 * One `<script async>` on the page: the parser never waits for it, and neither
 * does the game. Returns whether the tag could be built and appended at all.
 */
function appendScript(src: string, onLoad: () => void, onError: () => void): boolean {
  try {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = onLoad;
    script.onerror = onError;
    const parent = document.head ?? document.documentElement;
    parent.appendChild(script);
    return true;
  } catch {
    // A page that will not take a script tag is a page without Telegram; the
    // game is already running and does not care.
    return false;
  }
}

/**
 * `window.setTimeout`, asked of the window rather than of the global, so a test
 * can hand the module its own clock the way it already hands it its own
 * `location` and `sessionStorage`. A window without timers simply never gets
 * the fallback, which is the behaviour this module had before it existed.
 */
function waitBriefly(run: () => void, ms: number): number | undefined {
  try {
    return typeof window.setTimeout === 'function' ? window.setTimeout(run, ms) : undefined;
  } catch {
    return undefined;
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
  if (hasClientBridge() || rememberedLaunch()) {
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
 *
 * Case-insensitively. Every client writes the parameters in exactly the casing
 * the constant has, and the official script reads them that way too — but a
 * link that has been through something that lowercases fragments would still be
 * a Telegram launch, and the cost of being wrong here is one request nobody
 * waits for against a whole Mini App left unwired.
 */
function hasLaunchParams(hash: string, search: string): boolean {
  return mentionsLaunch(hash) || mentionsLaunch(search);
}

/** `tgWebApp…` somewhere in this string, whatever case it arrived in. */
function mentionsLaunch(text: string): boolean {
  return text.toLowerCase().includes(LAUNCH_PARAM_NEEDLE);
}

/** The launch the official script wrote down before the page was reloaded. */
function rememberedLaunch(): boolean {
  try {
    const stored = window.sessionStorage?.getItem(LAUNCH_MEMORY_KEY);
    return typeof stored === 'string' && mentionsLaunch(stored);
  } catch {
    // Storage can be denied outright (private mode, third-party frame): then
    // this signal is simply not available and the other two decide.
    return false;
  }
}

/**
 * Is there a Telegram client on the other end of the page at all?
 *
 * These are the three transports the official script itself picks between when
 * it posts an event (`postEvent`, telegram-web-app.js), asked in its order:
 *
 * 1. `window.TelegramWebviewProxy` — the object the native clients inject
 *    before the page is parsed. **Both** mobile clients use it: iOS injects the
 *    same name over its WebKit message handler, so there is no separate iOS
 *    signal to look for.
 * 2. `window.external.notify` — the Windows WebView host. `window.external`
 *    exists in every browser; `notify` on it does not.
 * 3. A frame whose parent is a Telegram Web client. Being framed is *not*
 *    enough on its own — itch.io serves the game in an iframe too (`PLAN_V1`
 *    §10, step 9), and treating that as Telegram would put a request to
 *    telegram.org on every itch.io launch, which is exactly what issue #16
 *    took out. So the framer has to say it is Telegram.
 *
 * None of the three can fire without the first one already being true in
 * practice: web.telegram.org and the Windows client both put the launch
 * parameters in the hash, so the URL answers first. They are here so the
 * question «is a client listening» has the same answer as the script's own.
 */
function hasClientBridge(): boolean {
  const host = window as unknown as {
    TelegramWebviewProxy?: unknown;
    external?: unknown;
  };
  if (host.TelegramWebviewProxy !== undefined && host.TelegramWebviewProxy !== null) {
    return true;
  }
  try {
    const external = host.external;
    if (typeof external === 'object' && external !== null && 'notify' in external) {
      return true;
    }
  } catch {
    // Reaching for window.external can throw in a sandboxed frame.
  }
  return framedByTelegram();
}

/** Hosts the Telegram Web clients are served from: `web.telegram.org` and kin. */
const TELEGRAM_HOST = /(^|\.)telegram\.org$/i;

/**
 * A page framed by a Telegram Web client. The parent is cross-origin, so its
 * URL cannot be read — but a framed document's `referrer` is the framing page,
 * and that is enough to tell web.telegram.org from itch.io.
 */
function framedByTelegram(): boolean {
  try {
    if (window.parent === null || window.parent === window) {
      return false;
    }
    const referrer = document.referrer;
    if (typeof referrer !== 'string' || referrer === '') {
      return false;
    }
    return TELEGRAM_HOST.test(new URL(referrer).hostname);
  } catch {
    // No parent to ask, or a referrer that is not a URL: not a Telegram frame.
    return false;
  }
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
