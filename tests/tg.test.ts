import { describe, expect, it } from 'vitest';
// The vendored fallback copy, read as text. `?raw` and not `node:fs`: this
// repository has no `@types/node` (see tests/art.test.ts), and the file is pure
// ASCII, so the UTF-8 decode is lossless.
import vendored from '../content/telegram-web-app.js?raw';
import {
  applyTgTheme,
  disableVerticalSwipes,
  hasLaunchParams,
  hasTelegramSession,
  initTg,
  startTg,
  type TelegramWebAppLike,
} from '../src/game/tg.js';
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

/**
 * The one gesture of the game and the one gesture of Telegram are the same
 * gesture (`PLAN_V1` §3): a vertical swipe. In a Mini App a swipe down closes
 * or minimises the app, so until `disableVerticalSwipes()` is called, dragging
 * the shaft down to look deeper throws the player out of the game.
 *
 * The method arrived in Bot API 7.7. It posts a message to the client and needs
 * no user gesture, so it is made at startup — but only when the client is new
 * enough, because Telegram's own script answers an older client with a console
 * warning on every launch, and because two neighbouring calls in this module do
 * worse than warn.
 */
describe('taking the vertical swipe away from Telegram', () => {
  it('is called on the version that introduced it, 7.7', () => {
    const { app, calls } = fakeApp({ version: '7.7' });
    expect(disableVerticalSwipes(app)).toBe(true);
    expect(calls).toEqual(['disableVerticalSwipes']);
  });

  it('is called on a newer client', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    expect(disableVerticalSwipes(app)).toBe(true);
    expect(calls).toEqual(['disableVerticalSwipes']);
  });

  it('is not called on 7.6, the last client without it', () => {
    const { app, calls } = fakeApp({ version: '7.6' });
    expect(disableVerticalSwipes(app)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is not called on the «6.0» stub the script leaves in a plain browser', () => {
    const { app, calls } = fakeApp({ version: '6.0' });
    expect(disableVerticalSwipes(app)).toBe(false);
    expect(calls).toEqual([]);
  });

  /**
   * 7.10 is a later client than 7.7 and an earlier string. Telegram compares the
   * parts as numbers and so does the fake, so this is here to keep a future
   * `have >= want` on the raw strings from passing the suite.
   */
  it('reads 7.10 as newer than 7.7, not as older', () => {
    const { app } = fakeApp({ version: '7.10' });
    expect(disableVerticalSwipes(app)).toBe(true);
  });

  it('does nothing when the client cannot answer a version question', () => {
    const { app } = fakeApp({ version: '8.0' });
    delete app.isVersionAtLeast;
    expect(disableVerticalSwipes(app)).toBe(false);
  });

  it('does nothing when a new-enough client has no such method', () => {
    const { app, calls } = fakeApp({ version: '8.0', swipeMethod: 'missing' });
    expect(disableVerticalSwipes(app)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('swallows a client that throws instead of bringing the game down', () => {
    const { app, calls } = fakeApp({ version: '8.0', swipeMethod: 'throws' });
    expect(() => disableVerticalSwipes(app)).not.toThrow();
    expect(disableVerticalSwipes(app)).toBe(false);
    expect(calls).toEqual(['disableVerticalSwipes', 'disableVerticalSwipes']);
  });
});

/**
 * The same three questions asked through the real entry points, with the whole
 * of `window` replaced. A real WebApp object exposes `initData` as a read-only
 * getter, so there is no patching a live one — the object is swapped whole, the
 * way the game sees it at startup.
 */
describe('startup inside a replaced window.Telegram', () => {
  it('greets Telegram, expands and takes the swipe on a 7.7 launch', () => {
    const { app, calls } = fakeApp({ version: '7.7' });
    const dom = withDom(app, () => {
      initTg();
    });
    expect(calls).toEqual(['ready', 'expand', 'disableVerticalSwipes']);
    // The fullscreen takeover waits for the first tap; both listeners are armed.
    expect(dom.listeners).toEqual(['pointerdown', 'touchend']);
  });

  it('greets Telegram and expands on 7.6, and leaves the swipe alone', () => {
    const { app, calls } = fakeApp({ version: '7.6' });
    withDom(app, () => {
      initTg();
    });
    expect(calls).toEqual(['ready', 'expand']);
  });

  it('says nothing at all when there is no WebApp object', () => {
    const dom = withDom(null, () => {
      initTg();
      applyTgTheme();
    });
    expect(dom.listeners).toEqual([]);
    expect(dom.game.style).toEqual({});
  });

  /**
   * Issue #12 again, from the other side: on itch.io and on a desktop browser
   * the script's stub is present and answers ready(), and nothing the player can
   * see may change there.
   */
  it('changes nothing a player can see on the script stub of a plain browser', () => {
    const { app, calls } = fakeApp({ version: '6.0', session: false });
    const dom = withDom(app, () => {
      initTg();
      applyTgTheme();
    });
    // ready()/expand() are harmless postMessages nobody listens to. Nothing is
    // repainted: the stub answers «6.0», which is below every colour call.
    expect(calls).toEqual(['ready', 'expand']);
    expect(dom.root.style).toEqual({});
    expect(dom.body.style).toEqual({});
    // The boxes are pinned, and pinned to the same box: the official script sets
    // the variable to 100vh in every browser, so the calc resolves to the CSS
    // index.html already ships. This is the one thing the web build does share
    // with a Mini App, and it shares it because a gate here would be a seam.
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
  });

  /**
   * The seam that gating on a session would open. A launch whose initData is
   * empty is still a launch — and it is the one where being sized to the WebView
   * instead of to the visible area would put the buttons under Telegram's own
   * chrome, which is exactly what `GOAL_V1` condition 2 forbids.
   */
  it('sizes and paints a launch that carries no session, because it is still a launch', () => {
    const { app, calls } = fakeApp({ version: '8.0', session: false });
    const dom = withDom(app, () => {
      initTg();
      applyTgTheme();
    });
    expect(calls).toContain('setBackgroundColor:#05070d');
    expect(calls).toContain('setHeaderColor:#05070d');
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
    expect(dom.body.style).toEqual({});
  });
});

/**
 * `GOAL_V1` condition 2: the foreign chrome must not show through. The game is
 * a fixed dark palette, so the page never takes Telegram's theme — Telegram
 * takes the page's colour instead, and a player on the light theme gets a dark
 * frame around a dark game rather than white bars.
 */
describe('the page colour goes out to Telegram, not the other way round', () => {
  it('paints header, background and bottom bar on a modern client', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    const dom = withDom(app, () => {
      applyTgTheme();
    });
    expect(calls).toEqual([
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
    expect(dom.root.style.colorScheme).toBe('dark');
  });

  it('takes the colour from the page, so index.html stays the one source', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(app, () => {
      applyTgTheme();
    }, { themeColor: '#123456' });
    expect(calls).toEqual([
      'setBackgroundColor:#123456',
      'setHeaderColor:#123456',
      'setBottomBarColor:#123456',
    ]);
  });

  /**
   * Below 6.9 `setHeaderColor` accepts only the theme keys and throws on a hex,
   * and the theme keys are the light theme being covered up. Below 7.10 there is
   * no bottom bar colour at all.
   */
  it('paints only what an older client can take', () => {
    const { app: old, calls: oldCalls } = fakeApp({ version: '6.5' });
    withDom(old, () => {
      applyTgTheme();
    });
    expect(oldCalls).toEqual(['setBackgroundColor:#05070d']);

    const { app: mid, calls: midCalls } = fakeApp({ version: '7.7' });
    withDom(mid, () => {
      applyTgTheme();
    });
    expect(midCalls).toEqual(['setBackgroundColor:#05070d', 'setHeaderColor:#05070d']);
  });

  it('paints nothing at all below 6.1', () => {
    const { app, calls } = fakeApp({ version: '6.0' });
    withDom(app, () => {
      applyTgTheme();
    });
    expect(calls).toEqual([]);
  });

  /**
   * The bug itself, in the property it was written to. The old code did
   * `document.body.style.backgroundColor = app.themeParams.bg_color`, so a
   * player on the light Telegram theme got a white frame around a dark
   * pixel-art game. Nothing in the module may write to the page background
   * again — not on any version, not on any theme.
   */
  it('never repaints the page background, whatever the client theme says', () => {
    for (const version of ['6.0', '6.5', '7.7', '8.0']) {
      const { app } = fakeApp({ version });
      // A client on the light theme, offering exactly the value the old code took.
      const dom = withDom(app, () => {
        initTg();
        applyTgTheme();
      });
      expect(dom.body.style.backgroundColor, `version ${version}`).toBeUndefined();
      expect(dom.body.style, `version ${version}`).toEqual({});
    }
  });

  it('keeps the page dark rather than following the client colour scheme', () => {
    const { app } = fakeApp({ version: '8.0' });
    const dom = withDom(app, () => {
      applyTgTheme();
    });
    // The game's palette is fixed, so the page is dark even on a light client.
    expect(dom.root.style.colorScheme).toBe('dark');
    expect(dom.body.style).toEqual({});
  });

  /**
   * Telegram's parseColorToHex takes `#rgb`, `#rrggbb` and `rgb()` and nothing
   * else, and refuses by **throwing**. `#05070dff` is valid CSS, so a perfectly
   * reasonable edit of index.html used to turn the whole chrome back to the
   * player's own theme. The colour is now checked against what Telegram parses,
   * not against what a browser accepts.
   */
  it('falls back to a colour Telegram can parse when the page declares one it cannot', () => {
    for (const unparsable of ['#05070dff', '#05070', 'black', 'rgb(5 7 13)', '']) {
      const { app, calls } = fakeApp({ version: '8.0' });
      withDom(
        app,
        () => {
          applyTgTheme();
        },
        { themeColor: unparsable },
      );
      expect(calls, unparsable).toEqual([
        'setBackgroundColor:#05070d',
        'setHeaderColor:#05070d',
        'setBottomBarColor:#05070d',
      ]);
    }
  });

  it('takes a short hex, which Telegram parses too', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(
      app,
      () => {
        applyTgTheme();
      },
      { themeColor: '#012' },
    );
    expect(calls).toEqual([
      'setBackgroundColor:#012',
      'setHeaderColor:#012',
      'setBottomBarColor:#012',
    ]);
  });

  /**
   * One try per call. With all three in one, a client that refuses the first
   * silently loses the two behind it — and a half-painted chrome is the light
   * frame again.
   */
  it('paints the rest of the chrome when one call is refused', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    app.setBackgroundColor = () => {
      throw new Error('WebAppBackgroundColorInvalid');
    };
    const dom = withDom(app, () => {
      applyTgTheme();
    });
    expect(calls).toEqual(['setHeaderColor:#05070d', 'setBottomBarColor:#05070d']);
    expect(dom.root.style.colorScheme).toBe('dark');
  });
});

/**
 * The fullscreen takeover waits for the first tap, because that is the gesture
 * Telegram wants for it. Until this was fired in a test, the 8.0 gate around it
 * was asserted by nobody: arming the listener and calling through it are two
 * different things.
 */
describe('the first tap takes the screen, on 8.0 and only there', () => {
  it('goes fullscreen and locks portrait on 8.0', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(app, (dom) => {
      initTg();
      calls.length = 0;
      dom.tap();
    });
    expect(calls).toEqual(['requestFullscreen', 'lockOrientation']);
  });

  it('does neither on 7.10, the last client without them', () => {
    const { app, calls } = fakeApp({ version: '7.10' });
    withDom(app, (dom) => {
      initTg();
      calls.length = 0;
      dom.tap();
    });
    expect(calls).toEqual([]);
  });

  it('asks only once: the second tap is the player playing', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(app, (dom) => {
      initTg();
      calls.length = 0;
      dom.tap();
      dom.tap();
    });
    expect(calls).toEqual(['requestFullscreen', 'lockOrientation']);
  });

  /**
   * The version question is asked outside every `try` in this module, so a
   * client that throws it must not take the listeners down with it.
   */
  it('still arms the listeners when the client throws the version question', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    app.isVersionAtLeast = () => {
      throw new Error('broken client');
    };
    const dom = withDom(app, (fake) => {
      initTg();
      fake.tap();
    });
    expect(dom.listeners).toEqual(['pointerdown', 'touchend']);
    expect(calls).toEqual(['ready', 'expand']);
  });
});

/**
 * `window.innerHeight` inside a Mini App is the height of the WebView, not of
 * the area the player can see: Telegram can open the app as a part-height sheet.
 * The honest number is Telegram's own CSS variable, and the two fixed boxes of
 * index.html are pinned to it — Phaser's Scale.FIT measures the parent box, so
 * the canvas follows without the game ever reading a height itself.
 */
describe('sizing to the Telegram viewport instead of the window', () => {
  it('pins the canvas parent and the rotation overlay to the stable height', () => {
    const { app } = fakeApp({ version: '8.0' });
    const dom = withDom(app, () => {
      initTg();
    });
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
    expect(dom.rotate.style.height).toBe('var(--tg-viewport-stable-height, 100vh)');
  });

  /**
   * There is no «are we in Telegram» gate on the binding, and there must not be:
   * outside Telegram the official script sets the variable to 100vh, so the calc
   * resolves to the box index.html already lays out. A gate would buy nothing
   * and would risk a real launch being sized to the WebView instead.
   */
  it('resolves to the same box outside Telegram, so it needs no gate', () => {
    const { app } = fakeApp({ version: '6.0', session: false });
    const dom = withDom(app, () => {
      initTg();
    });
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
    expect(dom.rotate.style.height).toBe('var(--tg-viewport-stable-height, 100vh)');
  });

  it('touches nothing when the script never defined a WebApp at all', () => {
    const dom = withDom(null, () => {
      initTg();
    });
    expect(dom.game.style).toEqual({});
    expect(dom.rotate.style).toEqual({});
  });
});

/**
 * Issue #16: the official script used to be a plain blocking `<script src>`
 * first thing in index.html's `<head>`, so the parser never reached the game
 * module until telegram.org answered. Measured with the host stubbed out: the
 * page burned the full 30-second timeout and the canvas never appeared once.
 * The players open this game from GitHub Pages and itch.io as well as from
 * Telegram, so the game must not depend on a third-party host to start at all.
 *
 * It is now `startTg()` that fetches the script — asynchronously, after the
 * game has already booted, and only for a launch that came from Telegram.
 */
describe('the official script never holds up the game (issue #16)', () => {
  it('asks telegram.org for nothing at all in a plain browser', () => {
    const dom = withDom(null, () => {
      startTg();
    });
    expect(dom.scripts).toEqual([]);
    // …and nothing was wired either: no listeners, no boxes touched.
    expect(dom.listeners).toEqual([]);
    expect(dom.game.style).toEqual({});
  });

  /**
   * Nothing is lost by not loading it there. With no launch parameters the
   * script leaves the «6.0» stub with an empty session — every call in the
   * module is gated at 6.1 or newer — and sets --tg-viewport-stable-height to
   * the literal string `100vh`, which is what the var() fallback in the binding
   * already resolves to. So the plain-browser page is unchanged down to the CSS.
   */
  it('leaves the box exactly where index.html puts it when no script is loaded', () => {
    const dom = withDom(null, () => {
      startTg();
    });
    expect(dom.game.style.height).toBeUndefined();
    expect(dom.rotate.style.height).toBeUndefined();
  });

  it('uses a WebApp object that is already on the page without asking for another', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    const dom = withDom(app, () => {
      startTg();
    });
    expect(dom.scripts).toEqual([]);
    // The whole wiring, synchronously, exactly as when index.html loaded the
    // script ahead of the module.
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
  });

  it('loads it asynchronously for a launch that carries Telegram parameters', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { hash: '#tgWebAppData=query_id%3DAAA&tgWebAppVersion=8.0&tgWebAppPlatform=android' });
    expect(dom.scripts).toHaveLength(1);
    expect(dom.scripts[0]?.src).toBe('https://telegram.org/js/telegram-web-app.js?63');
    // `async`: the parser must never wait for it again.
    expect(dom.scripts[0]?.async).toBe(true);
  });

  /**
   * The whole risk of loading it late, in one test: the wiring has to be applied
   * when the script lands, not skipped because the game already started.
   */
  it('applies the whole wiring when the script arrives after the game started', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    const dom = withDom(null, (fake) => {
      startTg();
      // The game is up by now and nothing has been asked of Telegram yet.
      expect(calls).toEqual([]);
      fake.deliverScript(app);
    }, { hash: '#tgWebAppVersion=8.0' });
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
    // The viewport binding is part of it: the canvas parent is pinned to
    // Telegram's visible area, and Phaser's FIT re-measures the parent box.
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
    expect(dom.rotate.style.height).toBe('var(--tg-viewport-stable-height, 100vh)');
    expect(dom.root.style.colorScheme).toBe('dark');
  });

  it('still waits for the first tap when the script beat the player to it', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.deliverScript(app);
      calls.length = 0;
      fake.tap();
    }, { hash: '#tgWebAppVersion=8.0' });
    expect(calls).toEqual(['requestFullscreen', 'lockOrientation']);
  });

  /**
   * The other order, and the one the late load invents: the player taps while
   * the script is still in flight. Arming a listener for a gesture that already
   * happened would leave the Mini App windowed and free to rotate, so the
   * takeover is done the moment the script lands instead.
   */
  it('takes the screen at once when the player tapped while the script loaded', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.tap();
      expect(calls).toEqual([]);
      fake.deliverScript(app);
    }, { hash: '#tgWebAppVersion=8.0' });
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      'requestFullscreen',
      'lockOrientation',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
  });

  it('does not take the screen early on a client too old for it', () => {
    const { app, calls } = fakeApp({ version: '7.10' });
    withDom(null, (fake) => {
      startTg();
      fake.tap();
      fake.deliverScript(app);
    }, { hash: '#tgWebAppVersion=7.10' });
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
  });

  it('asks only once, however many times the player taps while it loads', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.tap();
      fake.tap();
      fake.deliverScript(app);
      fake.tap();
    }, { hash: '#tgWebAppVersion=8.0' });
    expect(calls.filter((call) => call === 'requestFullscreen')).toEqual(['requestFullscreen']);
    expect(calls.filter((call) => call === 'lockOrientation')).toEqual(['lockOrientation']);
  });

  it('stays quiet when both requests fail, and the game is none the wiser', () => {
    const dom = withDom(null, (fake) => {
      startTg();
      expect(() => {
        // telegram.org refuses, then the copy we ship is missing too.
        fake.failScript(REMOTE);
        fake.failScript(LOCAL);
      }).not.toThrow();
      // A tap after the failure must not reach a client that is not there.
      fake.tap();
    }, { hash: '#tgWebAppVersion=8.0' });
    expect(dom.game.style).toEqual({});
    expect(dom.root.style).toEqual({});
  });
});

/** Index of each request in `dom.scripts`, in the order the module makes them. */
const REMOTE = 0;
const LOCAL = 1;

/** Telegram's own copy, still the one asked for first. */
const SCRIPT_URL = 'https://telegram.org/js/telegram-web-app.js?63';

/** Where the copy the game ships with is served from. */
const LOCAL_URL = `${import.meta.env.BASE_URL}telegram-web-app.js`;

/**
 * Issue #17, the other side of #16. The game no longer waits for telegram.org —
 * but the whole Telegram wiring lives in the script that host serves, so with
 * the host blocked the client got **nothing**: no `ready`, no `expand`, and no
 * `disableVerticalSwipes`, which hands the one gesture of the game
 * (`PLAN_V1` §3) back to Telegram, where a downward swipe closes the Mini App.
 * `GOAL_V1` condition 2 rolled back silently.
 *
 * And «telegram.org is unreachable» is not «Telegram is unreachable»: for a
 * Russian-speaking audience the domain has been blocked while the app itself
 * kept working, so this is an ordinary launch, not an exotic one.
 *
 * The answer is a fallback, not a replacement: telegram.org stays first so the
 * script keeps updating itself, and the copy in `content/` is asked for only
 * when that host refuses or says nothing for `REMOTE_GRACE_MS`.
 */
describe('the fallback copy of the script (issue #17)', () => {
  const hash = { hash: '#tgWebAppVersion=8.0&tgWebAppPlatform=android' };
  /** What a client hears when a copy of the script finally lands. */
  const FULL_WIRING = [
    'ready',
    'expand',
    'disableVerticalSwipes',
    'setBackgroundColor:#05070d',
    'setHeaderColor:#05070d',
    'setBottomBarColor:#05070d',
  ];

  it('asks telegram.org first and nothing else while that request is open', () => {
    const dom = withDom(null, () => {
      startTg();
    }, hash);
    expect(dom.scripts.map((script) => script.src)).toEqual([SCRIPT_URL]);
    // …with a clock running behind it, because a blocked host never answers.
    expect(dom.waits).toEqual([2500]);
  });

  it('asks for the local copy the moment telegram.org refuses', () => {
    const dom = withDom(null, (fake) => {
      startTg();
      fake.failScript(REMOTE);
    }, hash);
    expect(dom.scripts.map((script) => script.src)).toEqual([SCRIPT_URL, LOCAL_URL]);
    expect(dom.scripts[LOCAL]?.async).toBe(true);
    // A refusal is an answer, so there is nothing left to wait for.
    expect(dom.pending()).toBe(0);
  });

  /**
   * The case the fallback exists for. A blocked host does not refuse — it
   * swallows the connection, `onerror` never fires, and only the clock ends it.
   */
  it('asks for the local copy when telegram.org just never answers', () => {
    const dom = withDom(null, (fake) => {
      startTg();
      expect(fake.scripts).toHaveLength(1);
      fake.fireTimers();
    }, hash);
    expect(dom.scripts.map((script) => script.src)).toEqual([SCRIPT_URL, LOCAL_URL]);
  });

  /**
   * And the whole point of it: the client must end up hearing exactly what it
   * hears when telegram.org is reachable — `ready`, `expand` and the swipe.
   */
  it('gives the client the whole wiring off the local copy', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    const dom = withDom(null, (fake) => {
      startTg();
      fake.fireTimers();
      expect(calls).toEqual([]);
      fake.deliverScript(app, LOCAL);
    }, hash);
    expect(calls).toEqual(FULL_WIRING);
    // The viewport binding rides along, as it does on the remote path.
    expect(dom.game.style.height).toBe(
      'calc(var(--tg-viewport-stable-height, 100vh) - var(--safe-top, 0px) - var(--safe-bottom, 0px))',
    );
    expect(dom.root.style.colorScheme).toBe('dark');
  });

  /** The late-script path of issue #16, reached through the fallback instead. */
  it('takes the screen at once when the player tapped before the local copy landed', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.tap();
      fake.fireTimers();
      fake.deliverScript(app, LOCAL);
    }, hash);
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      'requestFullscreen',
      'lockOrientation',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
  });

  it('still waits for the first tap when the local copy beat the player to it', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.fireTimers();
      fake.deliverScript(app, LOCAL);
      calls.length = 0;
      fake.tap();
    }, hash);
    expect(calls).toEqual(['requestFullscreen', 'lockOrientation']);
  });

  /*
   * Both requests can be open at once — the clock starts the local copy without
   * cancelling the remote one on purpose, because aborting a merely slow
   * request would throw away the last copy if the local one were missing from
   * the deploy. So both arriving is an ordinary launch, not an exotic one: it
   * happens every time telegram.org takes longer than the grace, which is what
   * a throttled host looks like as opposed to a blocked one.
   *
   * Two things then have to be true at once, and they pull in opposite
   * directions. `ready()`, `expand()` and the first-tap listener must happen
   * exactly once whatever the order. The **colours** must not: running the
   * official script re-posts the player's own themeParams at the client, so a
   * second copy that is left alone makes the player's light theme the last word
   * on the chrome — a white frame around a dark game, which is the bug
   * `applyTgTheme` exists to stop and `GOAL_V1` condition 2 rules out.
   *
   * Both orders are checked, and what is asserted is the **last** colour the
   * client heard, not that a colour was sent at all: sending ours and then
   * being overpainted passes the second test and fails the player.
   *
   * The guard is what is tested here, not the browser's willingness to abort a
   * tag: the late copy below is delivered by hand precisely because nothing may
   * depend on it never running.
   */

  /** The last thing the client heard about one colour, or nothing. */
  function lastColour(log: readonly string[], call: string): string | undefined {
    return [...log].reverse().find((entry) => entry.startsWith(`${call}:`));
  }

  /** Every wiring step that must survive a second arrival exactly once. */
  function onceEach(log: readonly string[]): Record<string, number> {
    const counted: Record<string, number> = {};
    for (const step of ['ready', 'expand', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation']) {
      counted[step] = log.filter((entry) => entry === step).length;
    }
    return counted;
  }

  for (const [order, first, second] of [
    ['telegram.org answers after the local copy', LOCAL, REMOTE],
    ['the local copy answers after telegram.org', REMOTE, LOCAL],
  ] as const) {
    it(`says our colour last when ${order}`, () => {
      // One log: two WebApp objects, but one client on the other end.
      const heard: string[] = [];
      const winner = fakeApp({ version: '8.0', log: heard, ownTheme: '#ffffff' });
      const late = fakeApp({ version: '8.0', log: heard, ownTheme: '#ffffff' });
      withDom(null, (fake) => {
        startTg();
        fake.fireTimers();
        // The script executes — posting the player's own theme — and then the
        // tag's load event fires. That is the browser's order, both times.
        winner.runScript();
        fake.deliverScript(winner.app, first);
        expect(lastColour(heard, 'setBackgroundColor')).toBe('setBackgroundColor:#05070d');
        late.runScript();
        fake.deliverScript(late.app, second);
      }, hash);

      expect(lastColour(heard, 'setBackgroundColor')).toBe('setBackgroundColor:#05070d');
      expect(lastColour(heard, 'setHeaderColor')).toBe('setHeaderColor:#05070d');
      expect(lastColour(heard, 'setBottomBarColor')).toBe('setBottomBarColor:#05070d');
      // …and nothing else was done a second time.
      expect(onceEach(heard)).toEqual({
        ready: 1,
        expand: 1,
        disableVerticalSwipes: 1,
        requestFullscreen: 0,
        lockOrientation: 0,
      });
    });

    it(`still takes the screen only once when ${order}`, () => {
      const heard: string[] = [];
      const winner = fakeApp({ version: '8.0', log: heard, ownTheme: '#ffffff' });
      const late = fakeApp({ version: '8.0', log: heard, ownTheme: '#ffffff' });
      withDom(null, (fake) => {
        startTg();
        fake.tap();
        fake.fireTimers();
        winner.runScript();
        fake.deliverScript(winner.app, first);
        late.runScript();
        fake.deliverScript(late.app, second);
        // A tap after both have landed must not find a second listener either.
        fake.tap();
      }, hash);
      expect(onceEach(heard)).toEqual({
        ready: 1,
        expand: 1,
        disableVerticalSwipes: 1,
        requestFullscreen: 1,
        lockOrientation: 1,
      });
      expect(lastColour(heard, 'setBackgroundColor')).toBe('setBackgroundColor:#05070d');
    });
  }

  /**
   * The other half of «asked, not assumed»: a copy that executed and left no
   * WebApp object behind. On Pages a missing file is an honest 404, but a host
   * that answers 200 with an HTML error page makes the tag fire `load`, and
   * counting that as the answer would leave the good copy still in flight
   * ignored — measured as zero events reaching the client.
   */
  it('lets the other copy win when the first one runs but defines nothing', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.fireTimers();
      // The local copy «loads»: the tag fires load, but nothing was defined.
      fake.scripts[LOCAL]?.onload?.();
      expect(calls).toEqual([]);
      // telegram.org turns up afterwards with the real thing.
      fake.deliverScript(app, REMOTE);
    }, hash);
    expect(calls).toEqual(FULL_WIRING);
  });

  it('keeps watching for the tap while a copy that defined nothing is discarded', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      fake.fireTimers();
      fake.scripts[LOCAL]?.onload?.();
      // The player taps after the empty response and before the real one.
      fake.tap();
      fake.deliverScript(app, REMOTE);
    }, hash);
    expect(calls).toContain('requestFullscreen');
    expect(calls).toContain('lockOrientation');
  });

  it('never asks for the local copy when telegram.org answers in time', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    const dom = withDom(null, (fake) => {
      startTg();
      fake.deliverScript(app, REMOTE);
      // The clock is stopped by the arrival, so nothing fires later.
      expect(fake.pending()).toBe(0);
      fake.fireTimers();
    }, hash);
    expect(dom.scripts.map((script) => script.src)).toEqual([SCRIPT_URL]);
    expect(calls).toEqual(FULL_WIRING);
  });

  /**
   * Outside Telegram neither copy is asked for. The remote one was issue #16;
   * the local one is cheap and same-origin, but it is still a request, still
   * 114 KB, and still buys nothing — with no launch parameters the script only
   * leaves its «6.0» stub with an empty session.
   */
  it('asks for neither copy in a plain browser', () => {
    const dom = withDom(null, (fake) => {
      startTg();
      fake.fireTimers();
    });
    expect(dom.scripts).toEqual([]);
    expect(dom.waits).toEqual([]);
  });

  it('gives up only when both copies are gone, not when the first one is', () => {
    const { app, calls } = fakeApp({ version: '8.0' });
    withDom(null, (fake) => {
      startTg();
      // The local copy 404s while telegram.org is still hanging: the tap watch
      // must stay armed, because the remote one can still arrive.
      fake.fireTimers();
      fake.failScript(LOCAL);
      fake.tap();
      fake.deliverScript(app, REMOTE);
    }, hash);
    expect(calls).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
      // The tap happened while both were in flight, so the takeover is done on
      // the spot rather than waited for a second time.
      'requestFullscreen',
      'lockOrientation',
      'setBackgroundColor:#05070d',
      'setHeaderColor:#05070d',
      'setBottomBarColor:#05070d',
    ]);
  });
});

/**
 * The copy in `content/telegram-web-app.js` is somebody else's code, vendored
 * for the one launch where telegram.org cannot be reached. Two things can go
 * wrong with a vendored file and neither one shows up in a browser until the
 * day it is needed: it can be truncated, and it can be quietly replaced.
 *
 * So it is pinned here. The hash below is a plain FNV-1a over the file — this
 * repository has no `@types/node`, so a test cannot reach for `node:crypto` any
 * more than for `node:fs`, and the file is pure ASCII, which makes Vite's
 * `?raw` a lossless read. Refreshing the copy therefore has to be a deliberate
 * act with a number attached to it; `AGENTS.md` carries the sha256 a human can
 * check with `curl … | sha256sum` and the command to redo it.
 */
describe('the vendored copy of telegram-web-app.js', () => {
  it('is the whole file, byte for byte, that AGENTS.md records', () => {
    expect(vendored.length).toBe(116510);
    expect(fnv1a(vendored)).toBe('32ec566c');
  });

  it('is not truncated: it ends where the script ends', () => {
    expect(vendored.trimEnd().endsWith('})();')).toBe(true);
  });

  /**
   * The three things the game actually needs out of it. A file that hashed
   * right but had lost one of these would be a very strange file, but the
   * assertion says out loud what the copy is for.
   */
  it('carries the transports and the call the game depends on', () => {
    expect(vendored).toContain('TelegramWebviewProxy');
    expect(vendored).toContain('WebApp.disableVerticalSwipes');
    expect(vendored).toContain('web_app_setup_swipe_behavior');
  });
});

/** FNV-1a, 32-bit, as eight hex digits. Small, stable and dependency-free. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Which pages get the script at all. A false negative costs a real launch its
 * Telegram wiring, a false positive costs one request nobody waits for, so the
 * question is asked generously — but never of a plain browser, which is the
 * whole point of issue #16.
 */
describe('telling a Telegram launch from a plain page by its URL', () => {
  it('sees the launch parameters every client puts in the hash', () => {
    expect(
      hasLaunchParams('#tgWebAppData=query_id%3DAAA&tgWebAppVersion=8.0', ''),
    ).toBe(true);
    expect(hasLaunchParams('#tgWebAppVersion=6.0&tgWebAppPlatform=tdesktop', '')).toBe(true);
    expect(hasLaunchParams('#tgWebAppThemeParams=%7B%7D', '')).toBe(true);
  });

  it('sees a start parameter passed in the query string', () => {
    expect(hasLaunchParams('', '?tgWebAppStartParam=deep')).toBe(true);
  });

  it('says no to the pages the game is actually opened on', () => {
    expect(hasLaunchParams('', '')).toBe(false);
    expect(hasLaunchParams('#', '?fps=1')).toBe(false);
    expect(hasLaunchParams('#shaft', '?seed=7')).toBe(false);
  });

  it('loads the script for a hash launch and for a query launch', () => {
    for (const where of [{ hash: '#tgWebAppVersion=8.0' }, { search: '?tgWebAppStartParam=x' }]) {
      const dom = withDom(null, () => {
        startTg();
      }, where);
      expect(dom.scripts, JSON.stringify(where)).toHaveLength(1);
    }
  });

  /**
   * A Mini App that reloaded loses nothing — the hash survives a reload — but a
   * page that navigated away from it would, so the copy the official script
   * leaves in sessionStorage is read as well. In a plain browser that entry is
   * either absent or the `{}` the script writes for a launch with no parameters,
   * and neither mentions tgWebApp.
   */
  it('remembers a launch the official script wrote down before a reload', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { stored: '{"tgWebAppVersion":"8.0","tgWebAppPlatform":"android"}' });
    expect(dom.scripts).toHaveLength(1);
  });

  it('is not fooled by the empty note the script leaves in a plain browser', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { stored: '{}' });
    expect(dom.scripts).toEqual([]);
  });

  /**
   * Android **and** iOS inject this one: the iOS client puts the same
   * `TelegramWebviewProxy` name over its WebKit message handler, so there is no
   * separate iOS bridge to look for.
   */
  it('recognises the WebView bridge the native clients inject', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { proxy: true });
    expect(dom.scripts).toHaveLength(1);
  });

  /**
   * The other two transports the official script picks between when it posts an
   * event: the Windows WebView host and a Telegram Web frame. Neither can fire
   * without the hash already having answered — both clients put the launch
   * parameters in the URL — so these close the question rather than open it.
   */
  it('recognises the Windows WebView host, window.external.notify', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { external: { notify: () => {} } });
    expect(dom.scripts).toHaveLength(1);
  });

  it('is not fooled by the window.external every browser has', () => {
    const dom = withDom(null, () => {
      startTg();
    }, { external: {} });
    expect(dom.scripts).toEqual([]);
  });

  it('recognises a frame put up by a Telegram Web client', () => {
    for (const framer of [
      'https://web.telegram.org/k/',
      'https://web.telegram.org/a/#7654321',
      'https://telegram.org/',
    ]) {
      const dom = withDom(null, () => {
        startTg();
      }, { framedBy: framer });
      expect(dom.scripts, framer).toHaveLength(1);
    }
  });

  /**
   * And the reason being framed is not enough on its own: itch.io serves the
   * game inside an iframe (`PLAN_V1` §10, step 9). Treating that as Telegram
   * would put a request to telegram.org on every itch.io launch — the exact
   * third-party dependency issue #16 took out.
   */
  it('does not take an itch.io frame for a Telegram one', () => {
    for (const framer of [
      'https://itch.io/embed-upload/1234567',
      'https://html-classic.itch.zone/html/1234567/index.html',
      'https://nottelegram.org/',
      'https://telegram.org.example.com/',
    ]) {
      const dom = withDom(null, () => {
        startTg();
      }, { framedBy: framer });
      expect(dom.scripts, framer).toEqual([]);
    }
  });

  /**
   * Every client writes the parameters in exactly this casing and the official
   * script reads them that way — but a link that has been through something
   * that folds the fragment is still a Telegram launch, and the cost of being
   * generous is one request nobody waits for.
   */
  it('reads the launch parameters whatever case they arrive in', () => {
    expect(hasLaunchParams('#TGWEBAPPVERSION=8.0', '')).toBe(true);
    expect(hasLaunchParams('#tgwebappdata=query_id%3DAAA', '')).toBe(true);
    expect(hasLaunchParams('', '?TgWebAppStartParam=deep')).toBe(true);
  });

  it('still says no to a plain page in any case', () => {
    expect(hasLaunchParams('#TGWEBAPP', '')).toBe(true);
    expect(hasLaunchParams('#SHAFT', '?SEED=7')).toBe(false);
  });
});

/** Telegram's own version comparison: the parts are numbers, not characters. */
function atLeastVersion(have: string, want: string): boolean {
  const mine = have.split('.');
  const theirs = want.split('.');
  const length = Math.max(mine.length, theirs.length);
  for (let i = 0; i < length; i += 1) {
    const a = Number(mine[i] ?? 0);
    const b = Number(theirs[i] ?? 0);
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

interface FakeAppOptions {
  /** Bot API version the fake client reports. */
  readonly version: string;
  /** Whether the launch carries a signed session (issue #12). Default: yes. */
  readonly session?: boolean;
  /** 'missing' drops disableVerticalSwipes; 'throws' makes it fail. */
  readonly swipeMethod?: 'missing' | 'throws';
  /**
   * Record into this log instead of a fresh one. Two copies of the script are
   * two WebApp objects but one client on the other end, and the question the
   * colour tests ask — «what did the client hear **last**» — can only be asked
   * of one list.
   */
  readonly log?: string[];
  /**
   * The player's own theme colour, as the official script re-posts it at the
   * client every time it runs (`runScript`). Measured from the real script: a
   * late copy said set_header_color, set_background_color and
   * set_bottom_bar_color with the player's own light theme in them.
   */
  readonly ownTheme?: string;
}

/**
 * A WebApp object shaped like the real one, recording what the game asks of it.
 * Only the members this module calls are here; anything else it touched would
 * be a TypeError, which is the point.
 *
 * `runScript()` is the official script *executing* — what happens just before
 * the tag's load event, and what the module does not control. It is separate
 * from `deliverScript` so a test can put the two in the browser's order.
 */
function fakeApp(options: FakeAppOptions): {
  app: TelegramWebAppLike;
  calls: string[];
  runScript: () => void;
} {
  const calls: string[] = options.log ?? [];
  const session = options.session ?? true;
  const app: TelegramWebAppLike = {
    ready: () => {
      calls.push('ready');
    },
    initData: session ? 'query_id=AAA&auth_date=1724800000&hash=abc' : '',
    initDataUnsafe: session ? { query_id: 'AAA', auth_date: 1724800000, hash: 'abc' } : {},
    expand: () => {
      calls.push('expand');
    },
    isVersionAtLeast: (want: string) => atLeastVersion(options.version, want),
    setBackgroundColor: (color: string) => {
      calls.push(`setBackgroundColor:${color}`);
    },
    setHeaderColor: (color: string) => {
      calls.push(`setHeaderColor:${color}`);
    },
    setBottomBarColor: (color: string) => {
      calls.push(`setBottomBarColor:${color}`);
    },
    requestFullscreen: () => {
      calls.push('requestFullscreen');
    },
    lockOrientation: () => {
      calls.push('lockOrientation');
    },
  };
  if (options.swipeMethod !== 'missing') {
    app.disableVerticalSwipes = () => {
      calls.push('disableVerticalSwipes');
      if (options.swipeMethod === 'throws') {
        throw new Error('client refused');
      }
    };
  }
  /*
   * A client on the **light** theme, offering the game exactly the values the
   * old code used to take. `TelegramWebAppLike` deliberately does not declare
   * these — the production type lists only what the module calls — so they are
   * attached from outside: the fake's job is to hold out the temptation, and
   * the tests' job is to prove nothing in the module reaches for it.
   */
  Object.assign(app, {
    colorScheme: 'light',
    themeParams: { bg_color: '#ffffff', secondary_bg_color: '#f0f0f0', text_color: '#000000' },
  });
  const runScript = (): void => {
    const own = options.ownTheme;
    if (own === undefined) {
      return;
    }
    calls.push(`setHeaderColor:${own}`, `setBackgroundColor:${own}`, `setBottomBarColor:${own}`);
  };
  return { app, calls, runScript };
}

interface FakeBox {
  readonly style: Record<string, string>;
}

/** A `<script>` element as the loader builds it, and as the head receives it. */
interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeDom {
  readonly root: FakeBox;
  /**
   * The page's own background lives here. It is in the fake because the bug
   * this module was fixed for was written to exactly this property: the old
   * code copied Telegram's `themeParams.bg_color` onto the body, so a player on
   * the light theme got white bars around a dark game.
   */
  readonly body: FakeBox;
  readonly game: FakeBox;
  readonly rotate: FakeBox;
  /** Window events the module armed, in order. */
  readonly listeners: string[];
  /** Fire the armed pointerdown, the way a player's first tap does. */
  tap(): void;
  /** Every script tag the module put on the page, in order (issue #16). */
  readonly scripts: FakeScript[];
  /**
   * The official script arriving late: it defines window.Telegram.WebApp and
   * then the browser fires the tag's load event, in that order. Without an
   * index it is the newest tag that answers.
   */
  deliverScript(app: TelegramWebAppLike, index?: number): void;
  /** The request failing outright — a refused connection, a 404. */
  failScript(index?: number): void;
  /** Delays the module put on the clock, in the order it asked for them. */
  readonly waits: number[];
  /** How many of those are still armed. */
  pending(): number;
  /** Run every armed timer: the grace period for telegram.org running out. */
  fireTimers(): void;
}

interface FakeDomOptions {
  /** What index.html's theme-color meta says. */
  readonly themeColor?: string;
  /** `location.hash` of the page, where Telegram puts the launch parameters. */
  readonly hash?: string;
  /** `location.search` of the page. */
  readonly search?: string;
  /** What the official script left in sessionStorage on an earlier load. */
  readonly stored?: string;
  /** The WebView bridge the native clients inject before the page is parsed. */
  readonly proxy?: boolean;
  /** `window.external` as the Windows WebView host leaves it. */
  readonly external?: object;
  /**
   * The page is inside a frame, and this is what `document.referrer` says —
   * the URL of the page that framed it (web.telegram.org, or itch.io).
   */
  readonly framedBy?: string;
}

/**
 * Run `run` with `window` and `document` replaced by the smallest fakes the
 * module can work against, then put the globals back. vitest runs these in the
 * node environment, so there is no DOM to patch — and a real WebApp object could
 * not be patched anyway: `initData` is a read-only getter, so the object has to
 * be swapped whole, which is exactly what a Mini App launch does.
 *
 * `run` takes the fake so a test can tap **while the globals are still swapped**:
 * the first-gesture handler reaches for `window` when it fires, not when it is
 * registered.
 */
function withDom(
  app: TelegramWebAppLike | null,
  run: (dom: FakeDom) => void,
  options: FakeDomOptions = {},
): FakeDom {
  const root: FakeBox = { style: {} };
  const bodyBox: FakeBox = { style: {} };
  const game: FakeBox = { style: {} };
  const rotate: FakeBox = { style: {} };
  const listeners: string[] = [];
  const handlers = new Map<string, Set<() => void>>();
  const meta = { content: options.themeColor ?? '#05070d' };
  const scripts: FakeScript[] = [];
  const head = {
    appendChild: (node: FakeScript): FakeScript => {
      scripts.push(node);
      return node;
    },
  };
  const waits: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const win = {
    Telegram: app === null ? undefined : { WebApp: app },
    TelegramWebviewProxy: options.proxy === true ? { postEvent: () => {} } : undefined,
    external: options.external,
    location: { hash: options.hash ?? '', search: options.search ?? '' },
    sessionStorage: {
      getItem: (key: string) =>
        key === '__telegram__initParams' ? (options.stored ?? null) : null,
    },
    // A page that is not framed is its own parent, which is what a browser
    // reports and what `framedByTelegram` asks first.
    parent: undefined as unknown,
    addEventListener: (type: string, handler: () => void) => {
      listeners.push(type);
      const forType = handlers.get(type) ?? new Set<() => void>();
      forType.add(handler);
      handlers.set(type, forType);
    },
    removeEventListener: (type: string, handler: () => void) => {
      handlers.get(type)?.delete(handler);
    },
    setTimeout: (handler: () => void, ms: number): number => {
      const id = nextTimer;
      nextTimer += 1;
      waits.push(ms);
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
  };
  win.parent = options.framedBy === undefined ? win : { name: 'framer' };
  const doc = {
    documentElement: root,
    body: bodyBox,
    head,
    referrer: options.framedBy ?? '',
    createElement: (tag: string): FakeScript => {
      if (tag !== 'script') {
        throw new Error(`the module built a <${tag}>, which it has no business doing`);
      }
      return { src: '', async: false, onload: null, onerror: null };
    },
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? meta : null,
    getElementById: (id: string) => {
      if (id === 'game') {
        return game;
      }
      return id === 'rotate' ? rotate : null;
    },
  };
  const scriptAt = (index?: number): FakeScript => {
    const script = scripts[index ?? scripts.length - 1];
    if (!script) {
      throw new Error(`no script number ${index ?? scripts.length - 1} was put on the page`);
    }
    return script;
  };
  const dom: FakeDom = {
    root,
    body: bodyBox,
    game,
    rotate,
    listeners,
    tap: () => {
      for (const handler of [...(handlers.get('pointerdown') ?? [])]) {
        handler();
      }
    },
    scripts,
    deliverScript: (arriving: TelegramWebAppLike, index?: number) => {
      // The order a browser does it in: the script runs (and defines its
      // object), then the tag's load event fires.
      win.Telegram = { WebApp: arriving };
      scriptAt(index).onload?.();
    },
    failScript: (index?: number) => {
      scriptAt(index).onerror?.();
    },
    waits,
    pending: () => timers.size,
    fireTimers: () => {
      const armed = [...timers.values()];
      timers.clear();
      for (const timer of armed) {
        timer();
      }
    },
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const hadDocument = 'document' in globals;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  globals.window = win;
  globals.document = doc;
  try {
    run(dom);
  } finally {
    if (hadWindow) {
      globals.window = previousWindow;
    } else {
      delete globals.window;
    }
    if (hadDocument) {
      globals.document = previousDocument;
    } else {
      delete globals.document;
    }
  }
  return dom;
}
