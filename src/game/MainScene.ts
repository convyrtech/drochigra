import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { COLORS, VIEW } from './layout.js';
import { createDomeStatus } from '../ui/domeStatus.js';

/** Empty portrait screen: dome zone on top, shaft zone below. */
export class MainScene extends Phaser.Scene {
  private readonly balance: Balance;

  constructor(balance: Balance) {
    super('main');
    this.balance = balance;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    const domeHeight = height * VIEW.domeHeightShare;

    this.add.rectangle(0, 0, width, domeHeight, COLORS.dome).setOrigin(0, 0);
    this.add.rectangle(0, domeHeight, width, height - domeHeight, COLORS.shaft).setOrigin(0, 0);

    createDomeStatus(this, this.balance, width / 2, domeHeight / 2);
  }
}
