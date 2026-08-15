import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { layerIndexForRow, cellYield } from '../sim/mining.js';
import { isDomeWarning, turretTarget } from '../sim/defense.js';
import {
  applyShiftResult,
  buyUpgrade,
  collectHangar,
  hangarHarvest,
  hasConveyor,
  isBottomReached,
  planBalance,
  shiftBalance,
  startNextPlan,
  touchVisit,
  type HangarHarvest,
  type Profile,
} from '../sim/progress.js';
import {
  aimDrill,
  aimTurret,
  callElevator,
  cellAt,
  createShift,
  digProgress,
  drillLayerIndex,
  ENTRANCE_ROW,
  fireSalvo,
  isCargoBlocked,
  shiftReport,
  step,
  type ShiftState,
} from '../sim/shift.js';
import { createBaseScreen, type BaseScreen } from '../ui/baseScreen.js';
import { createHangarScreen } from '../ui/hangarScreen.js';
import { createHud, type Hud } from '../ui/hud.js';
import { showLayerBanner } from '../ui/layerBanner.js';
import { createShiftReport } from '../ui/shiftReport.js';
import { createVictoryScreen } from '../ui/victoryScreen.js';
import { createDomeView, type DomeView } from './domeView.js';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from './layout.js';
import { browserStore, loadProfile, saveProfile } from './saveStorage.js';
import { SFX } from './sfx.js';
import { createChipPool, type ChipPool } from '../ui/particles.js';
import { createFloatTextLayer, type FloatTextLayer } from '../ui/floatText.js';

/** Depth order of the drawn parts. */
const LAYER_DEPTH = {
  cells: 0,
  labels: 1,
  target: 2,
  progress: 3,
  drill: 4,
  hud: 10,
  dome: 11,
  alarm: 12,
  banner: 15,
  report: 20,
  base: 30,
  hangar: 40,
  victory: 50,
} as const;

/** How often the turret pews while it is firing, in seconds. View tuning. */
const TURRET_BEAT_SEC = 0.32;
/** How often the warning siren wails while the dome is on the edge. */
const SIREN_BEAT_SEC = 1.0;
/** View tuning for the floating reward and the crack/dig particles. */
const FLOAT_DEPTH = 6;

/**
 * The loop of the game: base → shift → report → base. The base screen and the
 * report are views over the profile (src/sim/progress.ts); the shift itself is
 * a state machine in src/sim. This scene only paints what it finds and feeds
 * taps back in.
 *
 * The profile lives on the scene and is written to storage after every purchase
 * and every shift, so a scene restart never costs the player what was bought.
 */
export class MainScene extends Phaser.Scene {
  private readonly balance: Balance;

  /** Loaded once, then kept across restarts of the scene. */
  private profile: Profile | null = null;

  private state: ShiftState | null = null;
  private cellRects: Phaser.GameObjects.Rectangle[] = [];
  /** What each cell currently shows; null until it is painted the first time. */
  private cellPainted: (boolean | null)[] = [];
  private cellSize = 0;
  private domeHeight = 0;

  private target!: Phaser.GameObjects.Rectangle;
  private progress!: Phaser.GameObjects.Rectangle;
  private drill!: Phaser.GameObjects.Rectangle;
  private hud!: Hud;
  private domeView!: DomeView;
  private baseScreen: BaseScreen | null = null;
  private reportShown = false;
  /** Pooled effects for the shift, so a busy dig never allocates per frame. */
  private chipPool: ChipPool | null = null;
  private floatLayer: FloatTextLayer | null = null;
  /**
   * Layers already announced by the banner this shift. A view-only memory: the
   * simulation has no idea a banner exists, and a shift that starts deep does not
   * announce the layer the elevator drops the drill into.
   */
  private announcedLayers = new Set<number>();

  /**
   * Cross-frame memory for the effect triggers. Nothing here decides gameplay —
   * it only spots the transition in the view (issue #7):
   *   - dome hp falling        → dome hit (sound, shake, vibration, flash)
   *   - an enemy disappearing  → a kill (shake on the big ones)
   *   - banked rising          → cargo handed over (sound)
   *   - crystals rising        → a crystal dropped out of a dig
   *   - salvo fired            → salvo (sound, shake)
   *   - turret target alive    → turret fire cadence
   *   - dome warning           → siren on a slow pulse
   */
  private prevDomeHp = 0;
  private prevBanked = 0;
  private prevCrystals = 0;
  private prevEnemyHp = new Map<number, { hp: number; type: string }>();
  private turretTick = 0;
  private sirenTick = 0;
  private prevWarning = false;
  /** The crack overlay drawn over the cell being dug. */
  private cracks!: Phaser.GameObjects.Graphics;

  /** Sound starts only on a user gesture: unlock on the first tap anywhere. */
  private unlocked = false;

  /**
   * Whether the offset-tab pause handlers are attached. The scene restarts in
   * place (`scene.restart` reuses the instance and re-runs create), so this
   * guard keeps the listeners from piling up across restarts.
   */
  private pauseWired = false;

  constructor(balance: Balance) {
    super('main');
    this.balance = balance;
  }

  create(): void {
    const { height } = this.scale.gameSize;
    this.domeHeight = height * VIEW.domeHeightShare;
    this.state = null;
    this.cellRects = [];
    this.cellPainted = [];
    this.reportShown = false;
    this.announcedLayers = new Set<number>();
    this.wirePauseHandling();

    // localStorage and the clock are the view's business, never the simulation's.
    this.profile ??= loadProfile(this.balance, browserStore(), Date.now());

    // Coming back to a hangar with something in it: the collection screen first,
    // the base right after it. An empty hangar says nothing.
    const harvest = hangarHarvest(this.balance, this.currentProfile(), Date.now());
    if (harvest.scrap > 0) {
      this.showHangar(harvest);
      return;
    }
    this.showBase(harvest);
  }

  /**
   * Pause the game while the tab is hidden or the window loses focus (issue #8):
   * the shift timer runs in `update`, so while the page is in the background it
   * would keep ticking in real time and the player would come back to a finished
   * or nearly-finished shift. Pausing the whole scene stops `update` (and with
   * it every tween, so the particles and float numbers of #7 simply hold and
   * resume) until the tab is visible and focused again.
   *
   * The profile is already saved after every purchase and every shift end, so
   * pausing mid-shift loses nothing that the save owns; only an in-progress
   * shift is dropped, which is the pre-existing behaviour on full close.
   *
   * `pause`/`resume` are idempotent and cheap, so both the visibility change and
   * the focus events can fire for the same moment without double-stepping.
   */
  private wirePauseHandling(): void {
    if (this.pauseWired) {
      return;
    }
    this.pauseWired = true;
    const key = 'main';
    const pause = (): void => {
      if (this.scene.isActive(key)) {
        this.scene.pause(key);
      }
    };
    const resume = (): void => {
      if (this.scene.isPaused(key)) {
        this.scene.resume(key);
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        pause();
      } else {
        resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', pause);
    window.addEventListener('focus', resume);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', pause);
      window.removeEventListener('focus', resume);
      this.pauseWired = false;
    });
  }

  override update(_time: number, deltaMs: number): void {
    const state = this.state;
    if (!state) {
      return;
    }
    step(state, deltaMs / 1000);
    this.detectShiftEvents(state, deltaMs);
    this.paintCells();
    this.paintDrill();
    this.followDrill();
    this.announceLayer(state);
    this.hud.update(state);
    this.domeView.update(state);

    if (state.phase === 'finished' && !this.reportShown) {
      this.showReport();
    }
  }

  /**
   * Spots the transitions that sound, shake and vibrate respond to, by comparing
   * the frame before with the frame after. This is view-only: it reads the state
   * `step` just produced and never tells the simulation anything (issue #7).
   */
  private detectShiftEvents(state: ShiftState, deltaMs: number): void {
    const defense = state.defense;
    const dt = deltaMs / 1000;

    // Once the shift is over the trackers are reset so a restart cannot fire
    // effects from the previous shift as though they happened now.
    if (state.phase !== 'running') {
      this.prevEnemyHp.clear();
      this.prevDomeHp = defense.hp;
      this.prevBanked = state.banked;
      this.prevCrystals = state.crystals;
      this.prevWarning = false;
      this.sirenTick = 0;
      this.turretTick = 0;
      return;
    }

    // Dome hit: an enemy reached the shell and took health away this frame.
    const domeHit = defense.hp < this.prevDomeHp - 0.001;
    if (domeHit) {
      SFX.domeHit();
      SFX.vibrate(50);
      this.domeView.flashDome();
      this.shake(0.012, 260);
    }
    this.prevDomeHp = defense.hp;

    // Cargo handed over: the banked figure moved (manual elevator or conveyor).
    if (state.banked > this.prevBanked) {
      SFX.bank();
    }
    this.prevBanked = state.banked;

    // A kill: an enemy vanished while no enemy bit the dome for it. Only the
    // big ones (drowned, moth) shake the screen — the aberration swarm is too
    // frequent to jolt on.
    const live = new Map<number, number>();
    for (const enemy of defense.enemies) {
      live.set(enemy.id, enemy.hp);
    }
    for (const [id, record] of this.prevEnemyHp) {
      if (live.has(id)) {
        continue;
      }
      if (record.hp <= 0.001) {
        continue;
      }
      if (domeHit) {
        // It reached the dome and did its damage; the dome hit already spoke.
        continue;
      }
      if (record.type === 'drowned' || record.type === 'moth') {
        this.shake(0.008, 220);
      }
    }
    this.prevEnemyHp.clear();
    for (const enemy of defense.enemies) {
      this.prevEnemyHp.set(enemy.id, { hp: enemy.hp, type: enemy.type });
    }

    // Turret fire: while the turret has a target, a short pew on a steady beat.
    if (turretTarget(defense)) {
      this.turretTick += dt;
      if (this.turretTick >= TURRET_BEAT_SEC) {
        this.turretTick = 0;
        SFX.turret();
      }
    } else {
      this.turretTick = 0;
    }

    // Siren: the dome is on the edge — a two-tone wail on a slow pulse, with a
    // prickling vibration each time it warns.
    const warning = isDomeWarning(state.balance, defense);
    if (warning && !this.prevWarning) {
      this.sirenTick = 0;
    }
    if (warning) {
      this.sirenTick += dt;
      if (this.sirenTick >= SIREN_BEAT_SEC) {
        this.sirenTick = 0;
        SFX.siren();
        SFX.vibrate([200, 80, 200]);
      }
    } else {
      this.sirenTick = 0;
    }
    this.prevWarning = warning;
  }

  /** A quick shake of the combat camera; higher intensity = more violent. */
  private shake(intensity: number, duration: number): void {
    this.cameras.main.shake(duration, intensity);
  }

  /**
   * The hangar screen of a returning player: the scrap is banked the moment the
   * button is tapped, so nothing is lost if the page is closed mid-animation,
   * and the visit stamp moves with it so the same hours are never paid twice.
   */
  private showHangar(harvest: HangarHarvest): void {
    const { width, height } = this.scale.gameSize;
    this.cameras.main.setScroll(0, 0);
    createHangarScreen(this, {
      width,
      height,
      depth: LAYER_DEPTH.hangar,
      balance: this.balance,
      harvest,
      onCollect: () => {
        const collected = collectHangar(this.balance, this.currentProfile(), Date.now());
        this.profile = collected.profile;
        saveProfile(collected.profile);
        // Collected: the hangar starts filling again from empty.
        this.showBase(hangarHarvest(this.balance, collected.profile, Date.now()));
      },
    });
  }

  /** The base between shifts: the wallet, the upgrades and the depth to start at. */
  private showBase(harvest: HangarHarvest): void {
    const { width, height } = this.scale.gameSize;
    const profile = this.currentProfile();
    this.cameras.main.setScroll(0, 0);
    this.baseScreen = createBaseScreen(this, {
      width,
      height,
      depth: LAYER_DEPTH.base,
      balance: this.planBalance(),
      profile,
      harvest,
      onBuy: (upgradeId) => {
        this.buy(upgradeId);
      },
      onStartShift: (startRow) => {
        // Next tick on purpose: this runs inside the button's own pointer event,
        // and the shift registers a screen-wide tap handler that would otherwise
        // catch the very same tap and aim the drill at it.
        this.time.delayedCall(0, () => {
          this.startShift(startRow);
        });
      },
    });
  }

  private buy(upgradeId: string): void {
    const bought = buyUpgrade(this.planBalance(), this.currentProfile(), upgradeId);
    if (!bought) {
      return;
    }
    this.profile = bought;
    saveProfile(bought);
    this.baseScreen?.update(bought);
  }

  /**
   * Starts a shift on the balance of the current five-year plan bent by the
   * upgrades (src/sim/progress.ts), from the checkpoint the player picked. The
   * seed comes from outside: src/sim never reads a clock.
   */
  private startShift(startRow: number): void {
    const { width, height } = this.scale.gameSize;
    // Going down stamps the visit: the hangar must not pay for the time the
    // player spends in the mine.
    const profile = touchVisit(this.currentProfile(), Date.now());
    this.profile = profile;
    saveProfile(profile);

    this.baseScreen?.destroy();
    this.baseScreen = null;

    const state = createShift(shiftBalance(this.balance, profile), Date.now(), {
      startRow,
      autoBank: hasConveyor(profile),
    });
    this.state = state;
    this.cellSize = width / state.width;
    this.cellRects = [];
    this.cellPainted = [];
    this.reportShown = false;
    // The layer the elevator drops the drill into is where the shift begins, not
    // a border it crossed: it is marked as seen so no banner greets the descent.
    this.announcedLayers = new Set<number>([drillLayerIndex(state)]);
    // Forget the last shift's effect trackers: a restart must not read the old
    // dome/enemies/bank of the previous shift as fresh events.
    this.prevDomeHp = state.defense.hp;
    this.prevBanked = state.banked;
    this.prevCrystals = state.crystals;
    this.prevEnemyHp.clear();
    this.prevWarning = false;
    this.sirenTick = 0;
    this.turretTick = 0;

    this.drawShaft();
    // Effects that only the shift uses: created fresh for the shift so pools
    // follow a scene restart instead of leaking objects across it.
    this.chipPool = createChipPool(this, FLOAT_DEPTH);
    this.floatLayer = createFloatTextLayer(this);
    this.hud = createHud(this, {
      width,
      domeHeight: this.domeHeight,
      depth: LAYER_DEPTH.hud,
      onBank: () => {
        callElevator(state);
      },
      onSalvo: () => {
        // Salvo only fires when it is ready; the sound and jolt go with the blast.
        if (fireSalvo(state)) {
          SFX.salvo();
          this.shake(0.02, 420);
        }
      },
    });
    this.domeView = createDomeView(this, {
      width,
      height,
      depth: LAYER_DEPTH.dome,
      frameDepth: LAYER_DEPTH.alarm,
    });

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onTap, this);
    // Web Audio needs a user gesture: the first tap anywhere unlocks it.
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      if (!this.unlocked) {
        this.unlocked = true;
        SFX.unlock();
      }
    });
    this.followDrill();
    this.hud.update(state);
    this.domeView.update(state);
  }

  private currentProfile(): Profile {
    this.profile ??= loadProfile(this.balance, browserStore(), Date.now());
    return this.profile;
  }

  /**
   * The numbers of the five-year plan the player is in: what the base, the report
   * and the victory screen all read, so the prices, the quota and the figures on
   * paper are the ones the next shift will actually run on. The upgrades are put
   * on top of this only inside a shift (`shiftBalance`), because the base has to
   * show what a level costs, not what it already gives.
   */
  private planBalance(): Balance {
    return planBalance(this.balance, this.currentProfile().fiveYearPlan);
  }

  /**
   * The drill has bitten into a layer nobody announced yet: say so once. The
   * border between layers is where the rock changes colour and a new enemy starts
   * coming out (PLAN_V1 §5), and this is what tells the player it happened.
   */
  private announceLayer(state: ShiftState): void {
    if (state.phase !== 'running') {
      return;
    }
    const index = drillLayerIndex(state);
    if (this.announcedLayers.has(index)) {
      return;
    }
    this.announcedLayers.add(index);
    const layer = state.balance.layers[index];
    if (!layer) {
      return;
    }
    const { width } = this.scale.gameSize;
    showLayerBanner(this, {
      width,
      top: this.domeHeight + VIEW.layerBanner.topGap,
      depth: LAYER_DEPTH.banner,
      index,
      layer,
    });
  }

  /** One rectangle per cell plus the surface label; colours change later. */
  private drawShaft(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const gap = VIEW.cellGap;
    for (let row = 0; row < state.rowCount; row += 1) {
      for (let col = 0; col < state.width; col += 1) {
        const rect = this.add
          .rectangle(col * size + gap / 2, row * size + gap / 2, size - gap, size - gap, COLORS.dug)
          .setOrigin(0, 0)
          .setDepth(LAYER_DEPTH.cells);
        this.cellRects.push(rect);
        this.cellPainted.push(null);
      }
    }
    this.paintCells();

    this.add
      .text(
        (state.width * size) / 2,
        ENTRANCE_ROW * size + size * VIEW.surfaceLabelYShare,
        'ЛИФТ · ПОВЕРХНОСТЬ',
        {
          fontFamily: FONT_FAMILY,
          fontSize: VIEW.font.small,
          color: cssColor(COLORS.text),
        },
      )
      .setOrigin(0.5)
      .setDepth(LAYER_DEPTH.labels);

    this.target = this.add
      .rectangle(0, 0, size - gap, size - gap)
      .setOrigin(0, 0)
      .setStrokeStyle(3, COLORS.target)
      .setDepth(LAYER_DEPTH.target)
      .setVisible(false);

    this.progress = this.add
      .rectangle(0, 0, 0, size * VIEW.digBarHeightShare, COLORS.progress)
      .setOrigin(0, 0)
      .setDepth(LAYER_DEPTH.progress)
      .setVisible(false);

    // The cracks overlay: jagged lines drawn on the cell being dug, fading in
    // with the dig progress. Its lines are cleared and repainted every frame.
    this.cracks = this.add.graphics().setDepth(LAYER_DEPTH.progress);

    const drillSize = size * VIEW.drillSizeShare;
    this.drill = this.add
      .rectangle(0, 0, drillSize, drillSize, COLORS.drill)
      .setDepth(LAYER_DEPTH.drill);
    this.paintDrill();
  }

  /** Repaints only the cells that changed since the last frame. */
  private paintCells(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    for (let row = 0; row < state.rowCount; row += 1) {
      const rockColor = this.rockColor(row);
      for (let col = 0; col < state.width; col += 1) {
        const index = row * state.width + col;
        const dug = cellAt(state, col, row) === 'dug';
        if (this.cellPainted[index] === dug) {
          continue;
        }
        const wasRock = this.cellPainted[index] === false;
        const rect = this.cellRects[index];
        if (!rect) {
          continue;
        }
        if (dug) {
          rect.fillColor = row === ENTRANCE_ROW ? COLORS.surface : COLORS.dug;
          rect.setStrokeStyle(1, COLORS.dugEdge);
          // A rock that just opened is a finished dig: reward it out loud.
          if (wasRock) {
            this.onCellDug(row, col);
          }
        } else {
          rect.fillColor = rockColor;
          rect.setStrokeStyle(0);
        }
        this.cellPainted[index] = dug;
      }
    }
  }

  private rockColor(row: number): number {
    const index = layerIndexForRow(this.balance.layers, row);
    return COLORS.rockByLayer[index] ?? COLORS.rockByLayer[0];
  }

  private paintDrill(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const { drill } = state;
    const target = drill.target;
    this.drill.setPosition((drill.col + 0.5) * size, (drill.row + 0.5) * size);
    this.drill.fillColor = isCargoBlocked(state) ? COLORS.drillStuck : COLORS.drill;

    const digging = target?.kind === 'cell';
    this.target.setVisible(digging);
    this.progress.setVisible(digging);
    if (!digging || !target) {
      this.cracks.clear();
      return;
    }
    const gap = VIEW.cellGap;
    this.target.setPosition(target.col * size + gap / 2, target.row * size + gap / 2);
    this.progress.setPosition(
      target.col * size + gap / 2,
      (target.row + 1) * size - gap / 2 - size * VIEW.digBarHeightShare,
    );
    this.progress.width = (size - gap) * digProgress(state);
    this.drawCracks(target.col, target.row, size, gap, digProgress(state));
  }

  /**
   * Jagged lines across the rock being dug, fading in with the progress: the
   * stone itself gives way, not just the bar under it. Cheap — the lines for the
   * single active cell are cleared and redrawn every frame.
   */
  private drawCracks(col: number, row: number, size: number, gap: number, share: number): void {
    const g = this.cracks;
    g.clear();
    g.lineStyle(2, COLORS.progress, Math.min(1, 0.15 + share * 0.7));
    const x0 = col * size + gap / 2;
    const y0 = row * size + gap / 2;
    const w = size - gap;
    // Three short strokes across the cell; their positions drift with progress
    // so the crack looks like it spreads as the drill works.
    const center = Math.min(0.85, Math.max(0.15, share));
    g.lineBetween(x0 + w * 0.3, y0, x0 + w * center, y0 + w * 0.5);
    g.lineBetween(x0 + w * center, y0 + w * 0.5, x0 + w * 0.2, y0 + w);
    g.lineBetween(x0 + w * 0.6, y0 + w * 0.3, x0 + w * 0.9, y0 + w * 0.7);
    g.lineBetween(x0 + w * 0.15, y0 + w * 0.4, x0 + w * 0.7, y0 + w * 0.85);
  }

  /**
   * A cell just opened: reward it with the crack of the drill, a floating
   * «+scrap» (and «+1 crystal» when one dropped), and a burst of chips. All
   * view-only — the simulation has already finished the dig and moved on. The
   * chips and numbers come from pools, so a run of quick digs never creates or
   * destroys objects (issue #8 performance).
   */
  private onCellDug(row: number, col: number): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const cx = (col + 0.5) * size;
    const cy = (row + 0.5) * size;

    SFX.dig();
    this.chipPool?.burst(cx, cy, size);

    const scrap = cellYield(state.balance.layers, row);
    this.floatLayer?.show(cx, cy, `+${scrap}`, COLORS.scrap, FLOAT_DEPTH);

    // A crystal dropped this dig: say so, in its own colour, on the same cell.
    if (state.crystals > this.prevCrystals) {
      this.floatLayer?.show(cx, cy + size * 0.3, '+1 ✦', COLORS.crystal, FLOAT_DEPTH);
      this.prevCrystals = state.crystals;
    }
    this.prevCrystals = state.crystals;
  }

  /** Camera keeps the drill in the middle of the shaft zone, below the dome. */
  private followDrill(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const { height } = this.scale.gameSize;
    const shaftHeight = height - this.domeHeight;
    const drillY = (state.drill.row + 0.5) * this.cellSize;
    const worldHeight = state.rowCount * this.cellSize;
    const wanted = drillY - (this.domeHeight + shaftHeight / 2);
    const maxScroll = Math.max(-this.domeHeight, worldHeight - height);
    this.cameras.main.setScroll(0, Phaser.Math.Clamp(wanted, -this.domeHeight, maxScroll));
  }

  private onTap(pointer: Phaser.Input.Pointer): void {
    const state = this.state;
    if (!state || state.phase === 'finished') {
      return;
    }
    // Up in the dome zone a tap is an order for the turret, not for the drill.
    if (pointer.y < this.domeHeight) {
      const enemyId = this.domeView.pickEnemy(pointer.x, pointer.y);
      if (enemyId !== null) {
        aimTurret(state, enemyId);
      }
      return;
    }
    const worldY = pointer.y + this.cameras.main.scrollY;
    const col = Math.floor((pointer.x + this.cameras.main.scrollX) / this.cellSize);
    const row = Math.floor(worldY / this.cellSize);
    if (row === ENTRANCE_ROW) {
      callElevator(state);
      return;
    }
    aimDrill(state, col, row);
  }

  /**
   * The shift is over: fold it into the profile, save, and show what it brought.
   * The button leads back to the base, where the earnings are spent — or, when
   * the bottom of the Abyss was reached, to the victory screen: first the paper,
   * then the triumph.
   */
  private showReport(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const { width, height } = this.scale.gameSize;
    this.reportShown = true;

    const balance = this.planBalance();
    const report = shiftReport(state);
    const outcome = applyShiftResult(balance, this.currentProfile(), report);
    // The shift itself is time spent in the game, not in the hangar: the stamp
    // moves to now, so the six minutes underground are never paid for offline.
    const saved = touchVisit(outcome.profile, Date.now());
    this.profile = saved;
    saveProfile(saved);

    createShiftReport(this, report, {
      width,
      height,
      depth: LAYER_DEPTH.report,
      maxDepthRow: balance.shift.grid_depth,
      outcome,
      // A restart wipes the shaft of the finished shift; the profile is a field
      // of the scene and survives it, and it is on disk either way.
      onBack: () => {
        SFX.unlock();
        if (isBottomReached(balance, saved)) {
          this.showVictory(saved);
          return;
        }
        this.scene.restart();
      },
    });
  }

  /**
   * The city is found: the plan is closed and the next one starts (PLAN_V1 §5).
   * The new plan is written to disk the moment the button is tapped, so closing
   * the page right after the triumph cannot cost it.
   */
  private showVictory(profile: Profile): void {
    const { width, height } = this.scale.gameSize;
    createVictoryScreen(this, {
      width,
      height,
      depth: LAYER_DEPTH.victory,
      balance: this.planBalance(),
      profile,
      onNextPlan: () => {
        const next = startNextPlan(profile);
        this.profile = next;
        saveProfile(next);
        this.scene.restart();
      },
    });
  }
}
