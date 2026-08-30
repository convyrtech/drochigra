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
import { createFaceButton, type FaceButton } from '../ui/faceButton.js';
import { createHud, type Hud } from '../ui/hud.js';
import { showLayerBanner } from '../ui/layerBanner.js';
import { createShiftReport } from '../ui/shiftReport.js';
import { createVictoryScreen } from '../ui/victoryScreen.js';
import { ART, hasArt, queueArt, sharpenArt, type ArtIndex } from './artTextures.js';
import { createDomeView, type DomeView } from './domeView.js';
import {
  faceScroll,
  isFaceVisible,
  shaftScroll,
  type ShaftBounds,
} from './shaftCamera.js';
import {
  advanceGesture,
  tapPoint,
  type GestureKind,
  type GestureSample,
} from './shaftGesture.js';
import {
  COLORS,
  cssColor,
  domeZoneHeight,
  elevatorBandHeight,
  FONT_FAMILY,
  VIEW,
} from './layout.js';
import { browserStore, loadProfile, saveProfile } from './saveStorage.js';
import { SFX } from './sfx.js';
import { createChipPool, type ChipPool } from '../ui/particles.js';
import { createFloatTextLayer, type FloatTextLayer } from '../ui/floatText.js';

/** Depth order of the drawn parts. */
const LAYER_DEPTH = {
  cells: 0,
  /** Rock and tunnel sprites, over the rectangles they replace. */
  cellArt: 1,
  labels: 2,
  target: 3,
  progress: 4,
  drill: 5,
  faceButton: 8,
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

  /**
   * The sprite over each cell rectangle, or an empty array while there is no
   * cell art at all. The rectangles underneath are never removed: a sprite that
   * was not generated simply leaves its own cell hidden and the rectangle shows
   * through, so the shaft is drawable at every point of the migration.
   */
  private cellTiles: Phaser.GameObjects.Image[] = [];

  private target!: Phaser.GameObjects.Rectangle;
  private progress!: Phaser.GameObjects.Rectangle;
  private drill!: Phaser.GameObjects.Rectangle;
  /** The drill sprite, when there is one; the rectangle is hidden behind it. */
  private drillArt: Phaser.GameObjects.Image | null = null;
  private hud!: Hud;
  private faceButton: FaceButton | null = null;
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
   * Vertical shaft scrolling (issue #10). A tap picks a cell; a drag scrolls the
   * camera up/down so the player can always reach cells deeper than the visible
   * frame, even when everything on screen is dug. While a finger owns the camera
   * the auto-follow stands aside so it does not overwrite the scrolled view; the
   * rules themselves live in `shaftCamera.ts`, this scene only feeds them.
   */
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartScrollY = 0;
  private dragDeltaY = 0;
  /**
   * What the finger now on the screen is doing, latched as it travels: it may
   * grow from a tap into a shaft drag or into an ignored swipe, never back. Only
   * `tap` ever reaches the mine — PLAN_V1 §3: no game decision is taken by a
   * swipe. The rule itself lives in `shaftGesture.ts`.
   */
  private gesture: GestureKind = 'tap';
  /**
   * The player dragged and let go: the view they scrolled to stays put instead
   * of snapping back to the drill on the very next frame. It is handed back to
   * the auto-follow as soon as the player gives an order — looked around,
   * decided, camera drives after the drill again.
   */
  private manualScroll = false;

  /**
   * Whether the offset-tab pause handlers are attached. The scene restarts in
   * place (`scene.restart` reuses the instance and re-runs create), so this
   * guard keeps the listeners from piling up across restarts.
   */
  private pauseWired = false;

  /** Sprites that exist; see `artTextures.ts`. Empty means «all rectangles». */
  private readonly art: ArtIndex;

  constructor(balance: Balance, art: ArtIndex = []) {
    super('main');
    this.balance = balance;
    this.art = art;
  }

  /**
   * Only the sprites `content/art/index.json` names are asked for, so the game
   * never fires a request for a file that is not there.
   */
  preload(): void {
    queueArt(this, this.art);
  }

  create(): void {
    // Pixel art must not be smoothed; done here rather than through Phaser's
    // `pixelArt: true`, which would also coarsen the text.
    sharpenArt(this, this.art);
    const { height } = this.scale.gameSize;
    this.domeHeight = domeZoneHeight(height);
    this.state = null;
    this.cellRects = [];
    this.cellTiles = [];
    this.cellPainted = [];
    this.drillArt = null;
    this.reportShown = false;
    this.announcedLayers = new Set<number>();
    // `scene.restart` reuses this instance, and the shift's own objects are gone
    // by now: the button of the previous shift must not be asked about taps on
    // the base screen. It is built again in startShift.
    this.faceButton = null;
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
    // Time is up and the drill is climbing out on its own: the manual look would
    // leave the player staring at rock through the whole ascent.
    if (state.phase !== 'running') {
      this.manualScroll = false;
    }
    this.updateShaftCamera();
    this.announceLayer(state);
    const faceVisible = this.faceVisible();
    this.faceButton?.setVisible(state.phase === 'running' && !faceVisible);
    this.hud.update(state, faceVisible);
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
    this.cellTiles = [];
    this.cellPainted = [];
    this.drillArt = null;
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
    // Fresh shift, fresh fingers: no dangling drag and no manual look left over
    // from a previous shift (`scene.restart` reuses this instance, so a field
    // that is not reset here survives into the new shift).
    this.dragPointerId = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartScrollY = 0;
    this.gesture = 'tap';
    this.dragDeltaY = 0;
    this.manualScroll = false;

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
        this.orderElevator(state);
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
    this.faceButton = createFaceButton(this, {
      width,
      viewHeight: height,
      depth: LAYER_DEPTH.faceButton,
    });

    // Tap vs vertical shaft-scroll (issue #10). A pointer that stays still is a
    // tap (pick a cell / order the turret); one that moves far enough drags the
    // shaft camera instead. The tap fires on pointerup so a scroll never also
    // fires a stray cell pick.
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    // A finger that leaves the canvas never sends POINTER_UP. Without this the
    // gesture would stay open forever and the camera would never follow again.
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onPointerUp, this);
    // Web Audio needs a user gesture: the first tap anywhere unlocks it.
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      if (!this.unlocked) {
        this.unlocked = true;
        SFX.unlock();
      }
    });
    this.updateShaftCamera();
    const faceVisible = this.faceVisible();
    this.faceButton.setVisible(state.phase === 'running' && !faceVisible);
    this.hud.update(state, faceVisible);
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

  /**
   * One rectangle per cell plus the surface label; colours change later.
   *
   * When there is cell art, a sprite goes on top of every rectangle — the
   * rectangles stay where they are, hidden under the sprites, and come back into
   * view by themselves for any cell whose particular sprite was never generated.
   */
  private drawShaft(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const gap = VIEW.cellGap;
    const cellArtKey = this.anyCellArtKey();
    for (let row = 0; row < state.rowCount; row += 1) {
      for (let col = 0; col < state.width; col += 1) {
        const rect = this.add
          .rectangle(col * size + gap / 2, row * size + gap / 2, size - gap, size - gap, COLORS.dug)
          .setOrigin(0, 0)
          .setDepth(LAYER_DEPTH.cells);
        this.cellRects.push(rect);
        this.cellPainted.push(null);
        if (cellArtKey) {
          this.cellTiles.push(
            this.add
              .image(col * size + gap / 2, row * size + gap / 2, cellArtKey)
              .setOrigin(0, 0)
              .setDisplaySize(size - gap, size - gap)
              // One tile per layer would otherwise wallpaper the whole shaft:
              // ninety-nine identical shells on a screen read as a pattern, not
              // as rock. Mirroring about half the cells breaks the repeat for
              // free — origin (0,0) means a flip moves no edge, so the grid and
              // every hit-box stay exactly where they were.
              .setFlipX(((row * 31 + col * 17) & 1) === 0)
              .setDepth(LAYER_DEPTH.cellArt),
          );
        }
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
      // The lift row is a picture once the surface sprite exists, and white
      // letters on a picture need an outline to stay letters. Six was not
      // enough against the snow of the surface tile: the strokes of the letters
      // are thinner than the outline has to be to separate them from it.
      .setStroke(cssColor(COLORS.shaft), 10)
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
    if (hasArt(this, ART.drill)) {
      const artSize = size * VIEW.drillArtSizeShare;
      this.drillArt = this.add
        .image(0, 0, ART.drill)
        .setDisplaySize(artSize, artSize)
        .setDepth(LAYER_DEPTH.drill);
      this.drill.setVisible(false);
    }
    this.paintDrill();
  }

  /**
   * Any sprite that a cell could show, or null when the shaft has no art at all.
   * A cell sprite needs some texture to be born with, and one is enough: which
   * one each cell ends up showing is decided in `paintCells`.
   */
  private anyCellArtKey(): string | null {
    for (const key of [ART.tunnel, ART.surface, ...ART.rockByLayer]) {
      if (hasArt(this, key)) {
        return key;
      }
    }
    return null;
  }

  /** The sprite a cell of this row shows, or null while that one is missing. */
  private cellArtKey(row: number, dug: boolean): string | null {
    if (dug) {
      const key = row === ENTRANCE_ROW ? ART.surface : ART.tunnel;
      return hasArt(this, key) ? key : null;
    }
    const index = layerIndexForRow(this.balance.layers, row);
    const key = ART.rockByLayer[index] ?? ART.rockByLayer[0];
    return key !== undefined && hasArt(this, key) ? key : null;
  }

  /** Repaints only the cells that changed since the last frame. */
  private paintCells(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const gap = VIEW.cellGap;
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
        // The sprite over this cell, if the shaft has any. A cell whose own
        // sprite is missing hides its tile and shows the rectangle instead, so
        // a half-generated set is still a whole picture.
        const tile = this.cellTiles[index];
        if (tile) {
          const key = this.cellArtKey(row, dug);
          if (key === null) {
            tile.setVisible(false);
          } else {
            // setTexture resizes the image back to the frame, so the display
            // size has to be re-applied after every swap.
            tile.setTexture(key).setDisplaySize(size - gap, size - gap).setVisible(true);
          }
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
    const blocked = isCargoBlocked(state);
    this.drill.setPosition((drill.col + 0.5) * size, (drill.row + 0.5) * size);
    this.drill.fillColor = blocked ? COLORS.drillStuck : COLORS.drill;
    if (this.drillArt) {
      this.drillArt.setPosition((drill.col + 0.5) * size, (drill.row + 0.5) * size);
      // Same warning the rectangle gave by turning red: cargo is full and the
      // drill has stopped.
      if (blocked) {
        this.drillArt.setTint(COLORS.drillStuck);
      } else {
        this.drillArt.clearTint();
      }
    }

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

  /**
   * Put the shaft camera where `shaftCamera.ts` says it belongs: on the drill
   * when nobody is holding the view, on the finger during a drag, and nowhere at
   * all while the player is looking around. Called every frame and on every
   * pointer move, so all three cases go through the same rules.
   */
  private updateShaftCamera(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const wanted = shaftScroll({
      ...this.shaftBounds(state),
      drillRow: state.drill.row,
      dragging: this.dragPointerId !== null && this.gesture === 'shaftDrag',
      pointerDown: this.dragPointerId !== null,
      manualScroll: this.manualScroll,
      dragStartScrollY: this.dragStartScrollY,
      dragDeltaY: this.dragDeltaY,
      currentScrollY: this.cameras.main.scrollY,
    });
    if (wanted !== null) {
      this.cameras.main.setScroll(0, wanted);
    }
  }

  /** The shaft measured against the screen, as `shaftCamera.ts` wants it. */
  private shaftBounds(state: ShiftState): ShaftBounds {
    return {
      cellSize: this.cellSize,
      domeHeight: this.domeHeight,
      viewHeight: this.scale.gameSize.height,
      rowCount: state.rowCount,
    };
  }

  /**
   * Is the face — the deepest row dug this shift — on screen? It drives both the
   * «К ЗАБОЮ» button and the hint in the status line, so both appear and leave
   * together.
   */
  private faceVisible(): boolean {
    const state = this.state;
    if (!state) {
      return true;
    }
    return isFaceVisible(this.shaftBounds(state), state.deepestRow, this.cameras.main.scrollY);
  }

  /**
   * «К ЗАБОЮ»: put the camera on the face and keep it there. The manual look has
   * to go on, or the auto-follow would pull the view back to the drill on the
   * next frame and the button would do nothing at all.
   */
  private jumpToFace(state: ShiftState): void {
    this.cameras.main.setScroll(0, faceScroll(this.shaftBounds(state), state.deepestRow));
    this.manualScroll = true;
  }

  /**
   * A pointer went down. Remember where the gesture began so the move can tell a
   * tap from a drag (issue #10). No cell is picked yet — that happens on pointer
   * up unless the finger actually dragged the shaft.
   */
  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    const state = this.state;
    if (!state || state.phase === 'finished') {
      return;
    }
    this.dragPointerId = pointer.id;
    this.dragStartX = pointer.x;
    this.dragStartY = pointer.y;
    this.dragStartScrollY = this.cameras.main.scrollY;
    this.dragDeltaY = 0;
    this.gesture = 'tap';
  }

  /** The gesture so far, as `shaftGesture.ts` wants to see it. */
  private gestureSample(pointer: Phaser.Input.Pointer): GestureSample {
    return {
      startX: this.dragStartX,
      startY: this.dragStartY,
      x: pointer.x,
      y: pointer.y,
      domeHeight: this.domeHeight,
      threshold: VIEW.dragThreshold,
    };
  }

  /**
   * The finger moved: re-read what the gesture has become. A vertical travel
   * over the shaft scrolls the camera; a wobble under the threshold is still a
   * tap; anything else — a sideways swipe, a swipe that began up in the dome
   * zone — is ignored from here on and will not reach the mine.
   */
  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (pointer.id !== this.dragPointerId) {
      return;
    }
    this.gesture = advanceGesture(this.gesture, this.gestureSample(pointer));
    if (this.gesture !== 'shaftDrag') {
      return;
    }
    this.dragDeltaY = pointer.y - this.dragStartY;
    this.updateShaftCamera();
  }

  /**
   * The gesture ended (here or outside the canvas). A shaft drag has already
   * scrolled the camera and is not a tap: the view it stopped at is kept as a
   * manual look until the player orders the drill somewhere, otherwise the
   * auto-follow would snap back to the drill on the very next frame and the deep
   * cells would stay out of reach. A finger that never travelled far enough is a
   * tap, so pick the cell (or order the turret) now — at the point it went
   * **down**, not where it came up. Every other gesture ends in nothing.
   */
  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id !== this.dragPointerId) {
      return;
    }
    const sample = this.gestureSample(pointer);
    const kind = advanceGesture(this.gesture, sample);
    const tap = tapPoint(kind, sample);
    this.dragPointerId = null;
    this.gesture = 'tap';
    this.dragDeltaY = 0;
    if (kind === 'shaftDrag') {
      this.manualScroll = true;
      return;
    }
    if (tap) {
      this.onTap(tap.x, tap.y);
    }
  }

  /** A tap landed at this point of the screen, in design pixels. */
  private onTap(x: number, y: number): void {
    const state = this.state;
    if (!state || state.phase === 'finished') {
      return;
    }
    // The «К ЗАБОЮ» button floats over the shaft: it is a view control, not a
    // cell, so it answers first. It is only ever hit while it is visible.
    if (this.faceButton?.contains(x, y)) {
      this.jumpToFace(state);
      return;
    }
    // «СДАТЬ» and «ЗАЛП» come next, for the same reason and by the same rules
    // (issue #11): they own their part of the dome zone, so nothing under them
    // is asked about the tap.
    if (this.hud.tap(x, y)) {
      return;
    }
    // Up in the dome zone a tap is an order for the turret, not for the drill.
    if (y < this.domeHeight) {
      const enemyId = this.domeView.pickEnemy(x, y);
      if (enemyId !== null) {
        aimTurret(state, enemyId);
      }
      return;
    }
    const worldY = y + this.cameras.main.scrollY;
    const col = Math.floor((x + this.cameras.main.scrollX) / this.cellSize);
    const row = Math.floor(worldY / this.cellSize);
    // An order means the player is done looking around: the camera goes back to
    // driving after the drill. An order the shift refused changes nothing.
    //
    // The lift row is one cell tall, and a cell is 80 design pixels — just under
    // the minimum touch target (issue #8). So the band that hands the cargo over
    // is the entrance row grown to MIN_TOUCH; the few pixels it borrows are the
    // very top of the first row of rock, which stays tappable everywhere else.
    const entranceTop = ENTRANCE_ROW * this.cellSize;
    const entranceBand = elevatorBandHeight(this.cellSize);
    if (worldY >= entranceTop && worldY < entranceTop + entranceBand) {
      this.orderElevator(state);
      return;
    }
    if (aimDrill(state, col, row)) {
      this.manualScroll = false;
    }
  }

  /**
   * Call the elevator, whichever way the player asked for it: the «СДАТЬ» button
   * of the HUD or a tap on the entrance row. Both are the same order to the same
   * drill, so both end the manual look and hand the camera back to the
   * auto-follow — but only when the shift actually took the order.
   */
  private orderElevator(state: ShiftState): void {
    if (callElevator(state)) {
      this.manualScroll = false;
    }
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
