import { createGame } from './game/createGame.js';
import { loadBalance } from './game/loadBalance.js';

const PARENT_ID = 'game';

async function start(): Promise<void> {
  const balance = await loadBalance();
  createGame(PARENT_ID, balance);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const parent = document.getElementById(PARENT_ID);
  if (parent) {
    parent.textContent = `Ошибка запуска: ${message}`;
  }
  console.error(error);
});
