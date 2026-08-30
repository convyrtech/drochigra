import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import { ART } from '../src/game/artIds.js';
import { MIN_TOUCH, VIEW } from '../src/game/layout.js';
import { fontPx, lineHeight, textWidth } from '../src/game/textMetrics.js';
import {
  BASE_TITLE,
  branchEffectLine,
  branchNameLine,
  buyBox,
  buyLine,
  chipBox,
  DEPTH_TITLE,
  fullBox,
  hangarBarLine,
  muteBox,
  muteLine,
  planLeftBox,
  planNumberLine,
  planRightBox,
  quotaLine,
  rowTextBox,
  startBox,
  startLine,
  titleBox,
  titleX,
  walletLine,
} from '../src/ui/baseText.js';
import {
  hangarPage,
  reportPage,
  victoryPage,
  type FormPage,
  type FormText,
} from '../src/ui/formLayout.js';
import {
  cargoBarLine,
  depthBox,
  depthLine,
  domeBarLine,
  halfWidth,
  insideBox,
  nextWaveBox,
  nextWaveLine,
  statsBox,
  statsFallbackLine,
  statusBox,
  statusText,
  timerBox,
  timerLine,
  waveBox,
  waveLine,
  type Box,
} from '../src/ui/hudText.js';
import type { Balance } from '../src/sim/balance.js';
import type { HangarHarvest, Profile, ShiftOutcome } from '../src/sim/progress.js';
import { createProfile, upgradeIds } from '../src/sim/progress.js';
import type { ShiftReport, ShiftState } from '../src/sim/shift.js';

/**
 * **No line of text may leave the panel it is written in, in any state of the
 * game.** That is the whole of this file.
 *
 * It exists because the same class of bug came back three times. A caption is
 * written at an x that looked right when the words were short; the words get
 * longer, or a badge is put in front of them, or the panel is made narrower for
 * an unrelated reason — and the line runs off the paper onto the shaft behind
 * it. Nothing catches that: the game measures text in a canvas, the tests run in
 * node, and until `src/game/textMetrics.ts` the two had never met. The last
 * review found five such lines, three of them in one screen; the run before
 * that had found the same thing somewhere else.
 *
 * So every screen with words on it now builds its lines as plain data, each one
 * carrying the box it must stay inside, and this file checks the two against
 * each other:
 *
 *  - **both grounds.** The screens look different with the art and without it —
 *    the ink flips, the badge appears, the masthead moves — so both are built.
 *  - **the states that make lines long.** A two-digit five-year plan, a
 *    seven-figure record, a thousand-percent plan, a breached dome with a lost
 *    cargo, three-digit upgrade levels, a full hangar.
 *  - **the widest font that could be found.** `textMetrics.ts` bounds every
 *    sans-serif that could be measured, so a line that fits here fits on the
 *    phone.
 *
 * When one of these fails the fix is never to widen the box a little: it is
 * either shorter words or a smaller size, decided in the layout, where the test
 * can see it.
 */

const balance = balanceJson as unknown as Balance;

/** Everything drawn. The pages differ between the two, so both are measured. */
const GROUNDS = [
  { name: 'with the art', hasArt: () => true },
  { name: 'with no art at all', hasArt: () => false },
] as const;

const { width, height } = VIEW;

/** Where a line actually starts and ends, from its origin and its width. */
function span(line: FormText): { left: number; right: number; width: number } {
  const w = textWidth(line.text, line.fontSize);
  const left = line.x - w * line.originX;
  return { left, right: left + w, width: w };
}

/** The same, down the page. */
function rows(line: FormText): { top: number; bottom: number } {
  const h = lineHeight(line.fontSize);
  const top = line.y - h * line.originY;
  return { top, bottom: top + h };
}

/**
 * No two lines of a page may be printed over each other.
 *
 * Sideways is what the boxes above are for; this is the other axis, and it is
 * the one that catches a headline grown one size too big, a masthead line that
 * has slipped out of its dark band onto the paper, or a signature that has
 * walked down into the button.
 */
function checkNoOverlap(what: string, page: FormPage): void {
  const lines = page.texts.filter((line) => line.text !== '');
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i]!;
      const b = lines[j]!;
      const [ax, bx] = [span(a), span(b)];
      const [ay, by] = [rows(a), rows(b)];
      const across = ax.left < bx.right - 0.5 && bx.left < ax.right - 0.5;
      const down = ay.top < by.bottom - 0.5 && by.top < ay.bottom - 0.5;
      expect(
        across && down,
        `${what}: «${a.text}» (${a.id}) is printed over «${b.text}» (${b.id})`,
      ).toBe(false);
    }
  }
  // And every one of them is on the sheet, top and bottom.
  for (const line of lines) {
    const { top, bottom } = rows(line);
    expect(top, `${what} · ${line.id}: starts above the sheet`).toBeGreaterThanOrEqual(page.panel.y);
    expect(bottom, `${what} · ${line.id}: ends below the sheet`).toBeLessThanOrEqual(
      page.panel.y + page.panel.height,
    );
  }
  // No line of ink may run under a sprite. The victory promises had their own
  // rule for this because the stamp sits in their band, but the report and the
  // hangar receipt print the same stamp and were guarded by nothing: the gap
  // between «отчёт принят к учёту» and the stamp above it was four and a half
  // design pixels, and a stamp nudged up by five printed straight through the
  // signature with every test still green. One rule over every sprite on every
  // page costs nothing and cannot be forgotten on the next page we add.
  // Backdrops are what ink is *supposed* to sit on: the sheet itself, the plate
  // behind a row, the heap of scrap the hangar prints its figure over. Only the
  // marks stamped on top of the page are in scope. Listing the backdrops rather
  // than the marks is deliberate — a sprite added later is guarded by default
  // and has to be excused on purpose.
  const backdrops = new Set<unknown>([ART.paper, ART.panelPlate, ART.baseSky, ART.hangarPile]);
  for (const line of lines) {
    const ink = { ...span(line), ...rows(line) };
    for (const art of page.art) {
      if (backdrops.has(art.id)) {
        continue;
      }
      const artLeft = art.centred === true ? art.x - art.width / 2 : art.x;
      const artTop = art.centred === true ? art.y - art.height / 2 : art.y;
      const across = ink.left < artLeft + art.width - 0.5 && artLeft < ink.right - 0.5;
      const down = ink.top < artTop + art.height - 0.5 && artTop < ink.bottom - 0.5;
      expect(
        across && down,
        `${what} · ${line.id}: «${line.text}» runs under ${String(art.id)}`,
      ).toBe(false);
    }
  }

  // The button is the last thing on the page and nothing may reach it. There is
  // deliberately no escape hatch here: an earlier version skipped any line that
  // *started* below the button's top edge, which excused exactly the lines that
  // had fallen furthest — a signature pushed into the button passed as «not
  // applicable» instead of failing. The button's own label lives in
  // `page.button.label`, not in `page.texts`, so nothing in this loop is
  // supposed to be down there at all.
  for (const line of lines) {
    expect(
      rows(line).bottom,
      `${what} · ${line.id}: «${line.text}» reaches the button`,
    ).toBeLessThanOrEqual(page.button.y);
  }
}

/**
 * A masthead line is light type on a dark printed band. Slip below the band and
 * it is pale grey on pale paper — invisible, and nothing but this would say so.
 */
function checkMasthead(what: string, page: FormPage, headerHeight: number): void {
  const band = page.panel.y + headerHeight;
  for (const line of page.texts) {
    if (line.id !== 'title' && line.id !== 'formCode') {
      continue;
    }
    expect(rows(line).bottom, `${what} · ${line.id}: hangs out of the masthead`).toBeLessThanOrEqual(
      band,
    );
  }
  for (const line of page.texts) {
    if (line.id === 'title' || line.id === 'formCode' || line.text === '') {
      continue;
    }
    expect(rows(line).top, `${what} · ${line.id}: is written on the masthead`).toBeGreaterThanOrEqual(
      band,
    );
  }
}

/** The one assertion this file is made of. */
function fits(what: string, text: string, fontSize: string, box: Box): void {
  const w = textWidth(text, fontSize);
  const room = box[1] - box[0];
  expect(
    w,
    `${what}: «${text}» is ${w.toFixed(0)}px at ${fontSize}, the box is ${room.toFixed(0)}px`,
  ).toBeLessThanOrEqual(room);
}

function checkPage(what: string, page: FormPage): void {
  for (const line of page.texts) {
    if (line.text === '') {
      continue;
    }
    const { left, right, width: w } = span(line);
    const room = line.box[1] - line.box[0];
    expect(
      w,
      `${what} · ${line.id}: «${line.text}» is ${w.toFixed(0)}px at ${line.fontSize}, the box is ${room.toFixed(0)}px`,
    ).toBeLessThanOrEqual(room);
    // The box may sit anywhere; the line has to sit inside the box it was given,
    // which is what an origin of 0.5 or 1 can get wrong on its own.
    expect(left, `${what} · ${line.id}: starts left of its box`).toBeGreaterThanOrEqual(
      line.box[0] - 0.5,
    );
    expect(right, `${what} · ${line.id}: ends right of its box`).toBeLessThanOrEqual(
      line.box[1] + 0.5,
    );
    // And the box itself has to be on the paper.
    expect(line.box[0], `${what} · ${line.id}: the box starts off the panel`).toBeGreaterThanOrEqual(
      page.panel.x,
    );
    expect(line.box[1], `${what} · ${line.id}: the box ends off the panel`).toBeLessThanOrEqual(
      page.panel.x + page.panel.width,
    );
  }
  fits(`${what} · button`, page.button.label.text, page.button.label.fontSize, page.button.label.box);
}

// ---------------------------------------------------------------------------
// Fixtures: the states that make lines long
// ---------------------------------------------------------------------------

function profileWith(over: Partial<Profile>): Profile {
  return { ...createProfile(balance), ...over };
}

function outcomeWith(over: Partial<ShiftOutcome>): ShiftOutcome {
  return {
    profile: profileWith({}),
    quota: 100,
    scrapEarned: 0,
    crystalsEarned: 0,
    bonusScrap: 0,
    newCheckpoints: 0,
    checkpointCrystals: 0,
    record: false,
    ...over,
  } as ShiftOutcome;
}

function reportWith(over: Partial<ShiftReport>): ShiftReport {
  return {
    mined: 0,
    banked: 0,
    crystals: 0,
    deepestRow: 0,
    waves: 0,
    endReason: 'timeout',
    ...over,
  } as ShiftReport;
}

/** The report in the states that make its lines longest. */
const REPORT_CASES = [
  {
    name: 'a first shift that missed the plan',
    report: reportWith({ mined: 40, banked: 12, deepestRow: 3, waves: 1 }),
    outcome: outcomeWith({ quota: 120 }),
  },
  {
    name: 'a shift that beat the plan ten times over',
    report: reportWith({ mined: 12_000, banked: 11_500, deepestRow: 96, waves: 9 }),
    outcome: outcomeWith({
      quota: 1_150,
      scrapEarned: 12_650,
      crystalsEarned: 24,
      bonusScrap: 1_150,
      newCheckpoints: 3,
      checkpointCrystals: 30,
      record: true,
    }),
  },
  {
    name: 'a breached dome on the twelfth five-year plan, with a record of a million',
    report: reportWith({
      mined: 1_234_567,
      banked: 1_234_000,
      deepestRow: 132,
      waves: 123,
      endReason: 'breach',
    }),
    outcome: outcomeWith({
      profile: profileWith({ fiveYearPlan: 12, bestShiftScrap: 1_234_567 }),
      quota: 1,
      scrapEarned: 1_234_000,
      crystalsEarned: 1_234,
      bonusScrap: 1_234_567,
      newCheckpoints: 7,
      checkpointCrystals: 700,
      record: true,
    }),
  },
] as const;

const VICTORY_CASES = [
  { name: 'the first plan closed', profile: profileWith({}) },
  {
    name: 'the twelfth plan closed by a millionaire',
    profile: profileWith({
      fiveYearPlan: 12,
      bestShiftScrap: 1_234_567,
      wallet: { scrap: 12_345_678, crystal: 123_456 },
      upgrades: Object.fromEntries(upgradeIds(balance).map((id) => [id, deepLevel(balance, id)])),
    } as Partial<Profile>),
  },
] as const;

/**
 * A level deep enough to stretch every line the branch writes, and no deeper.
 *
 * «As many levels as possible» is not a state: `elevator` costs 3 crystals and
 * grows 1.4× a level, so level 123 of it is a nineteen-digit price nobody will
 * ever be shown and no button could ever hold. The scrap branches grow 1.022× so
 * four hundred levels of them is a six-figure price — which is the longest
 * anything on this screen realistically gets.
 */
function deepLevel(one: Balance, id: string): number {
  const item = one.upgrades.items[id];
  const max = item?.max_level;
  const deep = (item?.cost_growth ?? one.upgrades.cost_growth) > 1.1 ? 40 : 400;
  return max === undefined ? deep : max;
}

const HANGAR_CASES = [
  { name: 'an empty hangar', harvest: { scrap: 0, hours: 0, fillShare: 0 } },
  { name: 'a full hangar', harvest: { scrap: 1_234_567, hours: 12.5, fillShare: 1 } },
] as const;

// ---------------------------------------------------------------------------
// The three form screens
// ---------------------------------------------------------------------------

describe('the shift report stays on its paper', () => {
  for (const ground of GROUNDS) {
    for (const shift of REPORT_CASES) {
      it(`${shift.name}, ${ground.name}`, () => {
        checkPage(
          'report',
          reportPage({
            width,
            height,
            hasArt: ground.hasArt,
            report: shift.report,
            outcome: shift.outcome,
            maxDepthRow: balance.shift.grid_depth,
          }),
        );
      });
    }
  }

  it('never prints one line over another, and never off the masthead', () => {
    for (const ground of GROUNDS) {
      for (const shift of REPORT_CASES) {
        const page = reportPage({
          width,
          height,
          hasArt: ground.hasArt,
          report: shift.report,
          outcome: shift.outcome,
          maxDepthRow: balance.shift.grid_depth,
        });
        checkNoOverlap(`report · ${shift.name}`, page);
        checkMasthead(`report · ${shift.name}`, page, VIEW.report.headerHeight);
      }
    }
  });
});

describe('the closed five-year plan stays on its paper', () => {
  for (const ground of GROUNDS) {
    for (const plan of VICTORY_CASES) {
      it(`${plan.name}, ${ground.name}`, () => {
        checkPage(
          'victory',
          victoryPage({ width, height, hasArt: ground.hasArt, balance, profile: plan.profile }),
        );
      });
    }
  }

  it('never prints one line over another', () => {
    for (const ground of GROUNDS) {
      for (const plan of VICTORY_CASES) {
        checkNoOverlap(
          `victory · ${plan.name}`,
          victoryPage({ width, height, hasArt: ground.hasArt, balance, profile: plan.profile }),
        );
      }
    }
  });

  it('leaves the promises clear of the rubber stamp beside them', () => {
    // The stamp shares its band with the four promises — there is nowhere else
    // on the sheet for it — so it is the promises' right-hand edge, not the
    // margin. Two of them used to be printed straight through it.
    const page = victoryPage({
      width,
      height,
      hasArt: () => true,
      balance,
      profile: profileWith({}),
    });
    const stamp = page.art.find((art) => art.id === ART.stamp);
    expect(stamp, 'the stamp is not on the page').toBeDefined();
    const stampLeft = stamp!.x - stamp!.width / 2;
    for (const line of page.texts.filter((text) => text.id.startsWith('promise'))) {
      expect(
        span(line).right,
        `«${line.text}» runs under the stamp`,
      ).toBeLessThanOrEqual(stampLeft - VIEW.victory.promiseStampGap + 0.5);
    }
  });
});

describe('the hangar receipt stays on its paper', () => {
  for (const ground of GROUNDS) {
    for (const hangar of HANGAR_CASES) {
      it(`${hangar.name}, ${ground.name}`, () => {
        checkPage(
          'hangar',
          hangarPage({
            width,
            height,
            hasArt: ground.hasArt,
            balance,
            harvest: hangar.harvest as HangarHarvest,
          }),
        );
      });
    }
  }

  it('never prints one line over another, and never off the masthead', () => {
    for (const ground of GROUNDS) {
      for (const one of HANGAR_CASES) {
        const page = hangarPage({
          width,
          height,
          hasArt: ground.hasArt,
          balance,
          harvest: one.harvest as HangarHarvest,
        });
        checkNoOverlap(`hangar · ${one.name}`, page);
        checkMasthead(`hangar · ${one.name}`, page, VIEW.hangar.headerHeight);
      }
    }
  });
});

describe('a form row never prints its figure over its caption', () => {
  // The caption is a fixed string and the figure is whatever the shift produced,
  // so the two boxes are cut apart at the end of the caption. This is the check
  // that the cut leaves the gap it promises — «Графа 10 · рекорд смены» and a
  // five-digit record used to overlap by forty pixels.
  it('keeps the gap between every caption and every figure', () => {
    const pages: readonly (readonly [string, FormPage])[] = [
      ...REPORT_CASES.map(
        (shift) =>
          [
            `report · ${shift.name}`,
            reportPage({
              width,
              height,
              hasArt: () => true,
              report: shift.report,
              outcome: shift.outcome,
              maxDepthRow: balance.shift.grid_depth,
            }),
          ] as const,
      ),
      ...VICTORY_CASES.map(
        (plan) =>
          [
            `victory · ${plan.name}`,
            victoryPage({ width, height, hasArt: () => true, balance, profile: plan.profile }),
          ] as const,
      ),
      ...HANGAR_CASES.map(
        (hangar) =>
          [
            `hangar · ${hangar.name}`,
            hangarPage({
              width,
              height,
              hasArt: () => true,
              balance,
              harvest: hangar.harvest as HangarHarvest,
            }),
          ] as const,
      ),
    ];
    for (const [what, page] of pages) {
      const byId = new Map(page.texts.map((line) => [line.id, line]));
      for (const line of page.texts) {
        if (!line.id.endsWith('-value')) {
          continue;
        }
        const label = byId.get(line.id.replace('-value', '-label'));
        expect(label, `${what}: ${line.id} has no caption`).toBeDefined();
        expect(
          span(line).left,
          `${what}: «${line.text}» runs into «${label!.text}»`,
        ).toBeGreaterThanOrEqual(span(label!).right);
      }
      const signature = byId.get('signature');
      const note = byId.get('signature-note');
      if (signature && note) {
        expect(
          span(note).left,
          `${what}: the signature note runs into the signature`,
        ).toBeGreaterThanOrEqual(span(signature).right);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The base
// ---------------------------------------------------------------------------

describe('the base screen stays inside its rows', () => {
  const rich = profileWith({
    fiveYearPlan: 123,
    bestShiftScrap: 1_234_567,
    wallet: { scrap: 12_345_678, crystal: 123_456 },
    upgrades: Object.fromEntries(upgradeIds(balance).map((id) => [id, deepLevel(balance, id)])),
  } as Partial<Profile>);
  const rowWidth = width - VIEW.base.margin * 2;

  for (const hasEmblem of [true, false]) {
    it(`fits the header, badge ${hasEmblem ? 'and all' : 'missing'}`, () => {
      fits('base · title', BASE_TITLE, VIEW.font.small, titleBox(width, hasEmblem));
      // And the title starts where the badge leaves off, not on top of it.
      expect(titleX(hasEmblem)).toBeGreaterThanOrEqual(VIEW.base.titleX);
    });
  }

  it('fits the sound toggle', () => {
    for (const muted of [true, false]) {
      fits('base · mute', muteLine(muted), VIEW.font.tiny, muteBox(width));
    }
  });

  it('fits the wallet and the plan row of a millionaire', () => {
    for (const profile of [profileWith({}), rich]) {
      const amounts = new Map(Object.entries(profile.wallet));
      fits('base · wallet', walletLine(balance, amounts), VIEW.font.medium, fullBox(width));
      const left = planNumberLine(profile);
      const right = quotaLine(balance, profile);
      fits('base · plan', left, VIEW.font.small, planLeftBox(width, right));
      fits('base · quota', right, VIEW.font.small, planRightBox(width, left));
      // The two halves of that row must not meet in the middle either.
      expect(
        VIEW.base.margin + textWidth(left, VIEW.font.small) + VIEW.base.rowTextGap,
        'the five-year plan runs into the quota',
      ).toBeLessThanOrEqual(width - VIEW.base.margin - textWidth(right, VIEW.font.small));
    }
  });

  for (const hasIcon of [true, false]) {
    it(`fits all eight branches, machines ${hasIcon ? 'and all' : 'missing'}`, () => {
      const textSpan = rowTextBox(VIEW.base.margin, rowWidth, hasIcon);
      const priceSpan = buyBox(VIEW.base.margin, rowWidth);
      for (const profile of [profileWith({}), rich]) {
        for (const id of upgradeIds(balance)) {
          fits(`base · ${id} name`, branchNameLine(balance, profile, id), VIEW.font.medium, textSpan);
          fits(`base · ${id} effect`, branchEffectLine(balance, id), VIEW.font.tiny, textSpan);
          const price = buyLine(balance, profile, id, priceSpan[1] - priceSpan[0]);
          fits(`base · ${id} price`, price, VIEW.font.small, priceSpan);
        }
      }
    });
  }

  it('fits the checkpoint chips, the depth title, the start button and the hangar bar', () => {
    const chipWidth = (rowWidth - VIEW.base.chipGap * 6) / 7;
    fits('base · chip', String(balance.shift.grid_depth), VIEW.font.small, chipBox(0, chipWidth));
    fits('base · depth title', DEPTH_TITLE, VIEW.font.small, fullBox(width));
    fits('base · start', startLine(balance.shift.grid_depth), VIEW.font.large, startBox(width));
    for (const profile of [profileWith({}), rich]) {
      fits(
        'base · hangar bar',
        hangarBarLine(balance, profile, 1),
        VIEW.font.tiny,
        startBox(width),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The dome panel
// ---------------------------------------------------------------------------

describe('the dome panel stays inside its zone', () => {
  /**
   * A shift in the state that makes every one of these lines longest: eleven
   * minutes on the clock, a seven-figure purse, the bottom row, a hundred and
   * twenty-three waves and a full cargo. Cast rather than built, because the
   * panel reads a dozen fields of a very large state and building the rest of it
   * would test the builder, not the panel.
   */
  function state(over: Record<string, unknown>): ShiftState {
    return { balance, ...over } as unknown as ShiftState;
  }

  const defense = {
    hp: 1_000,
    hpMax: 1_000,
    elapsedSec: 0,
    wavesSent: 123,
    enemies: [],
    focusId: null,
    salvoCooldownSec: 0,
    leaked: 0,
    killed: 0,
    nextEnemyId: 1,
  };

  const busy = state({
    timeLeftSec: 660,
    banked: 1_234_567,
    crystals: 12_345,
    cargo: 12_000,
    deepestRow: 132,
    phase: 'running',
    endReason: null,
    drill: { mode: 'blocked', target: null },
    defense,
    upgrades: {},
  });

  it('fits the timer and both wave labels beside it', () => {
    fits('hud · timer', timerLine(busy), VIEW.font.large, timerBox(width));
    fits('hud · wave', waveLine(busy), VIEW.font.tiny, waveBox(width));
    // The countdown never runs past one wave interval, but the clock can print
    // two digits of minutes and the label has to hold that too.
    for (const line of [nextWaveLine(busy), 'ЧЕРЕЗ 10:00']) {
      fits('hud · countdown', line, VIEW.font.tiny, nextWaveBox(width));
    }
    // The reserved timer box is what keeps the three apart, so it has to be
    // wide enough for the longest clock the shift can show.
    expect(
      textWidth('СМЕНА 10:00', VIEW.font.large),
      'the timer is wider than the box reserved for it',
    ).toBeLessThanOrEqual(VIEW.hud.timerWidth);
  });

  it('fits the stats row, purse and depth, without the two meeting', () => {
    const depth = depthLine(busy);
    for (const purse of [statsFallbackLine(busy), String(1_234_567)]) {
      fits('hud · purse', purse, VIEW.font.small, statsBox(width, depth));
      fits('hud · depth', depth, VIEW.font.small, depthBox(width, purse));
    }
    // With the icons there the numbers start after them, so the whole group has
    // to clear the depth on the right of the same row.
    const { statIconSize, statIconGap, margin } = VIEW.hud;
    const numberX = margin + statIconSize + statIconGap;
    const scrapWidth = textWidth('1234567', VIEW.font.small);
    const crystalX = numberX + scrapWidth + statIconGap * 3;
    const groupEnd = crystalX + statIconSize + statIconGap + textWidth('12345', VIEW.font.small);
    expect(groupEnd, 'the stat icons and numbers reach the depth').toBeLessThanOrEqual(
      statsBox(width, depth)[1],
    );
  });

  it('fits both bar captions inside their bars', () => {
    const barWidth = halfWidth(width, VIEW.hud.barGap);
    fits('hud · dome bar', domeBarLine(busy), VIEW.font.small, insideBox(0, barWidth));
    fits('hud · cargo bar', cargoBarLine(busy), VIEW.font.small, insideBox(0, barWidth));
  });

  it('fits both button captions inside their buttons', () => {
    const buttonWidth = halfWidth(width, VIEW.hud.buttonGap);
    for (const label of ['СДАТЬ', 'ЗАЛП', 'ЗАЛП 123']) {
      fits('hud · button', label, VIEW.font.medium, insideBox(0, buttonWidth));
    }
  });

  it('fits every status line the shift can print', () => {
    const box = statusBox(width);
    const cases: readonly ShiftState[] = [
      state({ ...busy, phase: 'finished', endReason: 'breach' }),
      state({ ...busy, phase: 'finished', endReason: 'timeout' }),
      state({ ...busy, phase: 'ending' }),
      state({ ...busy, defense: { ...defense, hp: 1 } }),
      state({ ...busy, drill: { mode: 'idle', target: null } }),
      state({ ...busy, drill: { mode: 'moving', target: { kind: 'surface' } } }),
      state({ ...busy, drill: { mode: 'moving', target: { kind: 'cell' } } }),
      state({ ...busy, drill: { mode: 'digging', target: null } }),
      state({ ...busy, drill: { mode: 'blocked', target: null } }),
      state({ ...busy, drill: { mode: 'banking', target: null } }),
    ];
    for (const one of cases) {
      for (const faceVisible of [true, false]) {
        fits('hud · status', statusText(one, faceVisible), VIEW.font.small, box);
      }
    }
  });

  it('fits «К ЗАБОЮ ▾» inside the button that says it', () => {
    const { faceButton, font } = VIEW;
    fits('shaft · К ЗАБОЮ', 'К ЗАБОЮ ▾', font.medium, [
      faceButton.labelPad,
      faceButton.width - faceButton.labelPad,
    ]);
    expect(faceButton.height, 'the button is under the touch minimum').toBeGreaterThanOrEqual(
      MIN_TOUCH,
    );
  });
});

// ---------------------------------------------------------------------------
// The measure itself
// ---------------------------------------------------------------------------

describe('the width measure', () => {
  it('reads the font sizes the layout writes', () => {
    for (const size of Object.values(VIEW.font)) {
      expect(fontPx(size)).toBeGreaterThan(0);
    }
    expect(() => fontPx('26')).toThrow();
    expect(() => fontPx('')).toThrow();
  });

  it('grows with the string and with the size, and is zero for nothing', () => {
    expect(textWidth('', VIEW.font.small)).toBe(0);
    expect(textWidth('АА', VIEW.font.small)).toBeCloseTo(textWidth('А', VIEW.font.small) * 2, 6);
    expect(textWidth('А', VIEW.font.huge)).toBeGreaterThan(textWidth('А', VIEW.font.tiny));
  });

  it('charges an unmeasured character as the widest one it knows', () => {
    // A glyph nobody measured must never make a line look narrower than it is.
    const widest = Math.max(
      ...[...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'].map((c) => textWidth(c, VIEW.font.small)),
    );
    expect(textWidth('\u{1F600}', VIEW.font.small)).toBeGreaterThanOrEqual(widest);
  });
});
