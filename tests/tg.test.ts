import { describe, expect, it } from 'vitest';
import {
  applyTgTheme,
  disableVerticalSwipes,
  hasTelegramSession,
  initTg,
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
}

/**
 * A WebApp object shaped like the real one, recording what the game asks of it.
 * Only the members this module calls are here; anything else it touched would
 * be a TypeError, which is the point.
 */
function fakeApp(options: FakeAppOptions): {
  app: TelegramWebAppLike;
  calls: string[];
} {
  const calls: string[] = [];
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
  return { app, calls };
}

interface FakeBox {
  readonly style: Record<string, string>;
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
  options: { themeColor?: string } = {},
): FakeDom {
  const root: FakeBox = { style: {} };
  const bodyBox: FakeBox = { style: {} };
  const game: FakeBox = { style: {} };
  const rotate: FakeBox = { style: {} };
  const listeners: string[] = [];
  const handlers = new Map<string, Set<() => void>>();
  const meta = { content: options.themeColor ?? '#05070d' };
  const win = {
    Telegram: app === null ? undefined : { WebApp: app },
    addEventListener: (type: string, handler: () => void) => {
      listeners.push(type);
      const forType = handlers.get(type) ?? new Set<() => void>();
      forType.add(handler);
      handlers.set(type, forType);
    },
    removeEventListener: (type: string, handler: () => void) => {
      handlers.get(type)?.delete(handler);
    },
  };
  const doc = {
    documentElement: root,
    body: bodyBox,
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? meta : null,
    getElementById: (id: string) => {
      if (id === 'game') {
        return game;
      }
      return id === 'rotate' ? rotate : null;
    },
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
