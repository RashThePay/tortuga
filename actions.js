const { Markup } = require('telegraf');
const { getGame, createGame, findGameByPlayer, deleteGame } = require('./game');
const { msg, SHIP_SHORT, shipLabel, LOCATION_NAMES, TEAM_NAMES } = require('./messages');
const { shuffle } = require('./state');

// Lazy require to avoid circular dependency
let _votes;
function getVotes() {
  if (!_votes) _votes = require('./votes');
  return _votes;
}

async function sendDM(ctx, userId, text, extra) {
  try {
    await ctx.telegram.sendMessage(userId, text, { parse_mode: 'Markdown', protect_content: true, ...extra });
    return true;
  } catch {
    return false;
  }
}

// Check if day should end after an action, and trigger night if so
async function checkDayEnd(ctx, game) {
  if (game.phase !== 'day') return;
  if (game.boxMode && game.pendingBoxEffect) return;
  if (!game.allPlayersDone()) return;
  await getVotes().endDay(ctx, game);
}

// /newgame
async function newGame(ctx) {
  const chatId = ctx.chat.id;
  const existing = getGame(chatId);
  if (existing && existing.phase !== 'ended') {
    return ctx.reply(msg.alreadyRunning);
  }
  if (ctx.chat.type === 'private') {
    return ctx.reply('⚠️ این دستور را باید در گروهی که می‌خواهید بازی کنید بفرستید.');
  }
  createGame(chatId);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('عادی', 'newgame_normal')],
    [Markup.button.callback('🌫️ مه‌آلود', 'newgame_mist')],
    [Markup.button.callback('📦 صندوق', 'newgame_box')],
    [Markup.button.callback('🌫️📦 مه‌آلود + صندوق', 'newgame_mistbox')],
  ]);
  return ctx.reply(msg.newGameMode, keyboard);
}

// /join
async function join(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'lobby') return ctx.reply(msg.gameNotLobby);
  if (game.lobbyPlayers.length >= 10) return ctx.reply(msg.tooManyPlayers);

  const user = ctx.from;
  const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
  if (game.lobbyPlayers.find((p) => p.id === user.id)) {
    return ctx.reply(msg.alreadyJoined);
  }

  // Verify bot can DM this player
  const canDM = await sendDM(ctx, user.id, msg.dmCheckOk);
  if (!canDM) {
    return ctx.reply(msg.dmRequired(name));
  }

  game.addLobbyPlayer(user.id, name);
  return ctx.reply(msg.joined(name));
}

// /start - begin the game
async function startGame(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'lobby') return ctx.reply(msg.gameNotLobby);
  if (game.lobbyPlayers.length < 2) return ctx.reply(msg.needMorePlayers);

  const { fdCaptain, jrCaptain } = game.startGame();

  // Build placement text
  const lines = [];
  lines.push(`*${LOCATION_NAMES.flyingDutchman}:*`);
  for (let i = 0; i < game.locations.flyingDutchman.crew.length; i++) {
    const p = game.players.get(game.locations.flyingDutchman.crew[i]);
    lines.push(`  ${(i + 1).toLocaleString("fa-IR")}. ‏${p.name}`);
  }
  lines.push(`\n*${LOCATION_NAMES.jollyRoger}:*`);
  for (let i = 0; i < game.locations.jollyRoger.crew.length; i++) {
    const p = game.players.get(game.locations.jollyRoger.crew[i]);
    lines.push(`  ${(i + 1).toLocaleString("fa-IR")}. ‏${p.name}`);
  }

  await ctx.reply(msg.gameStarted(lines.join('\n')), { parse_mode: 'Markdown' });

  // DM each player their team
  const dmFails = [];
  for (const [userId, p] of game.players) {
    let text;
    if (p.team === 'dutch') {
      text = msg.dutchDM(game.mistMode);
    } else if (p.team === 'spanish') {
      text = msg.spanishDM(game.mistMode);
    } else {
      text = msg.teamDM(p.team);
    }
    const ok = await sendDM(ctx, userId, text);
    if (!ok) dmFails.push(p.name);
  }
  if (dmFails.length > 0) {
    await ctx.reply(dmFails.map((n) => msg.dmFailed(n)).join('\n'));
  }

  // DM captains to choose initial treasure hold
  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('🇬🇧 انبار انگلیسی', 'setup_english'),
    Markup.button.callback('🇫🇷 انبار فرانسوی', 'setup_french'),
  ]);

  if (fdCaptain) {
    await sendDM(ctx, fdCaptain, msg.captainChooseTreasure('flyingDutchman'), keyboard);
  }
  if (jrCaptain) {
    await sendDM(ctx, jrCaptain, msg.captainChooseTreasure('jollyRoger'), keyboard);
  }
}
// /leave - leave the game (only in lobby)
async function leave(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'lobby') return ctx.reply(msg.gameNotLobby);
  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  game.removeLobbyPlayer(userId);
  return ctx.reply(msg.left(p.name));
}

async function endGame(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  // just cancel the game in any situation
  await ctx.reply(msg.gameEnd);
  deleteGame(ctx.chat.id);
}
async function listPlayers(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase === 'lobby') {
    const names = game.lobbyPlayers.map((p) => p.name).join('، ');
    return ctx.reply(`🏴‍☠️ لابی بازی\nبازیکنان: ${names || 'هنوز کسی نیست'}\nتعداد: ${game.lobbyPlayers.length}`)
  };
  const lines = []; let n = 1;
  for (const [userId, p] of game.players) {
    const location = shipLabel(game.getPlayerShip(userId)) || LOCATION_NAMES[p.location] || 'نامشخص';
    const hasSubmitted = game.usedAction.has(userId) ? '✅' : '❌ (هنوز اقدام نکرده)';
    lines.push(`${n.toLocaleString("fa-IR")}. ‏${p.name} - ${location} - ${hasSubmitted}`);
    n++
  }
  return ctx.reply(msg.playerStatus(lines.join('\n')), { parse_mode: 'Markdown' });
}

async function sendHelp(ctx) {
  // with link to channel in markdown
  return ctx.reply(`🏴‍☠️ برای دیدن قوانین بازی به [کانال جزیره گنج](https://t.me/jazire_ganj_game/2) مراجعه کنید.`, { parse_mode: 'Markdown', link_preview_options: { disabled: false } });
}

// /move_location - direct movement from ship to island or island to ship
async function moveLocation(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const currentLoc = p.location;
  if (currentLoc === 'rowboat') return ctx.reply(msg.notValidForMove);

  const buttons = [];

  // From ship -> can go to island only
  if (currentLoc === 'flyingDutchman' || currentLoc === 'jollyRoger') {
    if (game.canMoveTo(userId, 'island')) {
      buttons.push(Markup.button.callback(LOCATION_NAMES.island, `act_moveloc_${userId}_island`));
    }
  }

  // From island -> can go to either ship
  if (currentLoc === 'island') {
    if (game.canMoveTo(userId, 'flyingDutchman') && game.locations.flyingDutchman.crew.length < 5) {
      buttons.push(Markup.button.callback(LOCATION_NAMES.flyingDutchman, `act_moveloc_${userId}_fd`));
    }
    if (game.canMoveTo(userId, 'jollyRoger') && game.locations.jollyRoger.crew.length < 5) {
      buttons.push(Markup.button.callback(LOCATION_NAMES.jollyRoger, `act_moveloc_${userId}_jr`));
    }
  }

  if (buttons.length === 0) {
    return ctx.reply(msg.noValidMoveDestinations);
  }

  return ctx.reply(msg.chooseMoveDest, Markup.inlineKeyboard(buttons, { columns: 1 }));
}

// /attack - captain orders attack
async function attack(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const ship = game.getPlayerShip(userId);
  if (!ship) return ctx.reply(msg.notOnShip);
  if (!game.isCaptain(userId)) return ctx.reply(msg.notCaptain);

  // Black Powder blocks attacks permanently
  if (game.boxMode && game.blackPowderShips.has(ship)) {
    return ctx.reply(msg.attackBlockedByBlackPowder);
  }

  // Check for existing attack/maroon on this ship (captain can only do one)
  if (game.pendingEvents.some((e) => (e.type === 'attack' || e.type === 'maroon') && e.ship === ship)) {
    return ctx.reply(msg.captainAlreadyActed);
  }

  // Determine target
  let target = 'spanishShip';
  if (game.locations.spanishShip.treasures <= 0) {
    const otherShip = ship === 'flyingDutchman' ? 'jollyRoger' : 'flyingDutchman';
    const otherHolds = game.locations[otherShip].holds;
    if (otherHolds.english + otherHolds.french <= 0) {
      return ctx.reply(msg.noTreasureToSteal);
    }
    target = otherShip;
    await ctx.reply(msg.attackOtherShip(otherShip));

    // Let the caller choose which hold to steal from
    // const buttons = [];
    // if (otherHolds.english > 0)
    //   buttons.push(Markup.button.callback(`🇬🇧 انبار انگلیسی`, `act_attackhold_${userId}_english`));
    // if (otherHolds.french > 0)
    //   buttons.push(Markup.button.callback(`🇫🇷 انبار فرانسوی`, `act_attackhold_${userId}_french`));

    // Store context for the callback
    // game._pendingAttackHold = { ship, target, initiator: userId };
    // return ctx.reply(msg.chooseStealHold, Markup.inlineKeyboard(buttons, { columns: 1 }));
  }

  game.addPendingEvent({ type: 'attack', ship, initiator: userId, target });
  game.markAction(userId);
  await ctx.reply(msg.attackOrdered(p.name, ship,));
  await checkDayEnd(ctx, game);
}

// /maroon - show inline keyboard to choose crew member (deferred to night)
async function maroon(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const ship = game.getPlayerShip(userId);
  if (!ship) return ctx.reply(msg.notOnShip);
  if (!game.isCaptain(userId)) return ctx.reply(msg.notCaptain);

  // Check for existing attack/maroon on this ship (captain can only do one)
  if (game.pendingEvents.some((e) => (e.type === 'attack' || e.type === 'maroon') && e.ship === ship)) {
    return ctx.reply(msg.captainAlreadyActed);
  }

  const crew = game.locations[ship].crew;
  if (crew.length <= 1) return ctx.reply(msg.onlyOneCrewCantMaroon);

  const buttons = crew
    .filter((id) => id !== userId)
    .map((id) => {
      const pl = game.players.get(id);
      return Markup.button.callback(pl.name, `act_maroon_${userId}_${id}`);
    });

  return ctx.reply(msg.chooseMaroon, Markup.inlineKeyboard(buttons, { columns: 1 }));
}

// /mutiny - first mate starts mutiny
async function mutiny(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const ship = game.getPlayerShip(userId);
  if (!ship) return ctx.reply(msg.notOnShip);
  if (!game.isFirstMate(userId)) return ctx.reply(msg.notFirstMate);

  // Only one mutiny per ship per round
  if (game.pendingEvents.some((e) => e.type === 'mutiny' && e.ship === ship)) {
    return ctx.reply(msg.mutinyAlreadyPending);
  }

  // In mist mode, first mate can only do one action: mutiny or inspect
  if (game.mistMode && game.pendingEvents.some((e) => e.type === 'inspect' && e.ship === ship)) {
    return ctx.reply(msg.alreadyActedAsFirstMate);
  }

  game.addPendingEvent({ type: 'mutiny', ship, initiator: userId });
  game.markAction(userId);
  await ctx.reply(msg.mutinyStarted(p.name, ship));
  await checkDayEnd(ctx, game);
}

// /inspect - first mate inspects holds in mist mode
async function inspect(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);
  if (!game.mistMode) return ctx.reply(msg.inspectNotInMistMode);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const ship = game.getPlayerShip(userId);
  if (!ship) return ctx.reply(msg.notOnShip);
  if (!game.isFirstMate(userId)) return ctx.reply(msg.notFirstMate);

  // Only one action per first mate per ship per round
  if (game.pendingEvents.some((e) => e.type === 'mutiny' && e.ship === ship)) {
    return ctx.reply(msg.alreadyActedAsFirstMate);
  }
  if (game.pendingEvents.some((e) => e.type === 'inspect' && e.ship === ship)) {
    return ctx.reply(msg.alreadyActedAsFirstMate);
  }

  // Defer inspect to day-end resolution (after treasure transfers, so first mate sees post-transfer state)
  game.addPendingEvent({ type: 'inspect', ship, initiator: userId });
  game.markAction(userId);
  await ctx.reply(msg.inspectOrdered(p.name, ship));
  await checkDayEnd(ctx, game);
}

// /move - show inline keyboard to choose target hold
async function moveTreasure(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  const ship = game.getPlayerShip(userId);
  if (!ship) return ctx.reply(msg.notOnShip);
  if (!game.isCabinBoy(userId)) return ctx.reply(msg.notCabinBoy);

  // Prevent cabin boy from moving treasure if there was a successful attack this round
  if (game.successfulAttackShips.has(ship)) {
    return ctx.reply(msg.cabinBoyBlockedByAttack);
  }

  const holds = game.locations[ship].holds;
  const total = holds.english + holds.french;

  if (game.mistMode) {
    // In mist mode, show direction buttons regardless of whether there's treasure
    if (total === 0) return ctx.reply(msg.noTreasureToMove('english'));

    const buttons = [
      Markup.button.callback('🇬🇧 → 🇫🇷', `act_movemist_${userId}_french`),
      Markup.button.callback('🇫🇷 → 🇬🇧', `act_movemist_${userId}_english`),
    ];
    return ctx.reply(msg.chooseMoveDirection, Markup.inlineKeyboard(buttons, { columns: 1 }));
  }

  // Normal mode
  if (total === 0) return ctx.reply(msg.noTreasureToMove('english'));

  const buttons = [];
  if (holds.french > 0)
    buttons.push(Markup.button.callback(`به ${TEAM_NAMES.english}`, `act_move_${userId}_english`));
  if (holds.english > 0)
    buttons.push(Markup.button.callback(`به ${TEAM_NAMES.french}`, `act_move_${userId}_french`));

  if (buttons.length === 0) return ctx.reply(msg.noTreasureToMove('english'));

  return ctx.reply(msg.chooseMove, Markup.inlineKeyboard(buttons, { columns: 1 }));
}

// /callarmada - island governor calls Spanish armada
async function callArmada(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  if (!game.isOnIsland(userId)) return ctx.reply(msg.notOnIsland);
  if (!game.isGovernor(userId)) return ctx.reply(msg.notGovernor);
  if (game.round < 6) return ctx.reply(msg.tooEarlyForArmada);

  game.armadaCalled = true;
  game.markAction(userId);
  await ctx.reply(msg.armadaCalled(p.name));
  await checkDayEnd(ctx, game);
}

// /dispute - island resident starts dispute
async function dispute(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  if (!game.isOnIsland(userId)) return ctx.reply(msg.notOnIsland);
  if (game.disputeThisRound) return ctx.reply(msg.disputeAlreadyPending);

  if (game.pendingEvents.some((e) => e.type === 'dispute')) {
    return ctx.reply(msg.disputeAlreadyPending);
  }

  game.addPendingEvent({ type: 'dispute', initiator: userId });
  game.disputeThisRound = true;
  game.markAction(userId);
  await ctx.reply(msg.disputeStarted(p.name));
  await checkDayEnd(ctx, game);
}

// /pass - pass action (can be overridden by a real action later)
async function pass(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase !== 'day') return ctx.reply(msg.gameNotDay);

  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) return ctx.reply(msg.notInGame);
  if (game.usedAction.has(userId)) return ctx.reply(msg.alreadyActed);

  game.passAction(userId);
  await ctx.reply(msg.passed(p.name));
  await checkDayEnd(ctx, game);
}

// /status - show game status
async function status(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) return ctx.reply(msg.noGame);
  if (game.phase === 'lobby') {
    const names = game.lobbyPlayers.map((p) => p.name).join('، ');
    return ctx.reply(`🏴‍☠️ لابی بازی\nبازیکنان: ${names || 'هنوز کسی نیست'}\nتعداد: ${game.lobbyPlayers.length}`);
  }
  return ctx.reply(msg.status(game), { parse_mode: 'Markdown' });
}

// Callback handler for day-phase inline keyboards (act_*)
async function handleActionCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const parts = data.split('_'); // act_type_userId_value
  const type = parts[1];
  const ownerId = parseInt(parts[2]);
  const value = parts[3];
  const userId = ctx.from.id;

  if (userId !== ownerId) {
    return ctx.answerCbQuery(msg.notYourButton);
  }

  const game = findGameByPlayer(userId);
  if (!game || game.phase !== 'day') {
    return ctx.answerCbQuery(msg.gameNotDay);
  }
  if (game.usedAction.has(userId)) {
    return ctx.answerCbQuery(msg.alreadyActed);
  }

  const p = game.players.get(userId);
  const chatId = game.chatId;

  if (type === 'moveloc') {
    const dest = SHIP_SHORT[value];
    if (!dest) return ctx.answerCbQuery('⚠️');

    // Check if can move to this location
    if (!game.canMoveTo(userId, dest)) {
      await ctx.answerCbQuery(msg.cannotReturnToExpelled);
      return;
    }

    // Check location capacity
    if (dest === 'flyingDutchman' || dest === 'jollyRoger') {
      if (game.locations[dest].crew.length >= 5) {
        await ctx.answerCbQuery(msg.locationFull(dest));
        return;
      }
    }

    // Defer move to day-end resolution
    game.addPendingEvent({ type: 'move', userId, destination: dest });
    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.moveChosen(p.name, dest));

  } else if (type === 'move') {
    const targetHold = value; // 'english' or 'french'
    const ship = game.getPlayerShip(userId);

    // Defer treasure transfer to day-end resolution
    game.addPendingEvent({ type: 'treasure_transfer', userId, ship, targetHold, mistMode: false });
    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.treasureTransferChosen(p.name, ship));

  } else if (type === 'movemist') {
    // Mist mode: cabin boy chooses direction, defer resolution
    const targetHold = value; // 'english' or 'french'
    const ship = game.getPlayerShip(userId);

    // Defer treasure transfer to day-end resolution
    game.addPendingEvent({ type: 'treasure_transfer', userId, ship, targetHold, mistMode: true });
    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.treasureTransferChosen(p.name, ship));

  } else if (type === 'attackhold') {
    const hold = value; // 'english' or 'french'
    const pending = game._pendingAttackHold;
    if (!pending || pending.initiator !== userId) {
      await ctx.answerCbQuery('⚠️');
      return;
    }
    game.addPendingEvent({ type: 'attack', ship: pending.ship, initiator: userId, target: pending.target, stealFrom: hold });
    game.markAction(userId);
    delete game._pendingAttackHold;
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.attackOrdered(p.name, pending.ship));

  } else if (type === 'maroon') {
    const targetId = parseInt(value);
    const ship = game.getPlayerShip(userId);
    const crew = game.locations[ship].crew;
    if (!crew.includes(targetId)) {
      await ctx.answerCbQuery(msg.playerNotOnShip);
      return;
    }
    const target = game.players.get(targetId);
    // Defer maroon to night phase (so mutiny can cancel it)
    game.addPendingEvent({ type: 'maroon', ship, initiator: userId, targetId });
    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.maroonOrdered(p.name, target.name, ship));
  }

  await checkDayEnd(ctx, game);
}

// Handle newgame mode selection
async function handleNewgameModeCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const game = getGame(ctx.chat.id);
  if (!game || game.phase !== 'lobby') {
    return ctx.answerCbQuery('⚠️ بازی در مرحله لابی نیست.');
  }

  if (data === 'newgame_normal') {
    game.mistMode = false; game.boxMode = false;
  } else if (data === 'newgame_mist') {
    game.mistMode = true; game.boxMode = false;
  } else if (data === 'newgame_box') {
    game.mistMode = false; game.boxMode = true;
  } else if (data === 'newgame_mistbox') {
    game.mistMode = true; game.boxMode = true;
  }

  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(msg.newGame(game.mistMode, game.boxMode), { parse_mode: 'Markdown' });
}

// --- Box mode ---

function boxGuard(ctx) {
  const game = getGame(ctx.chat.id);
  if (!game) { ctx.reply(msg.noGame); return null; }
  if (!game.boxMode) { ctx.reply(msg.boxModeNotActive); return null; }
  if (game.phase !== 'day') { ctx.reply(msg.gameNotDay); return null; }
  const userId = ctx.from.id;
  const p = game.players.get(userId);
  if (!p) { ctx.reply(msg.notInGame); return null; }
  if (game.scurvyActive.has(userId)) { ctx.reply(msg.scurvyBlocked); return null; }
  if (game.usedExtraAction.has(userId)) { ctx.reply(msg.alreadyUsedExtraAction); return null; }
  return { game, userId, p };
}

async function lookBox(ctx) {
  const guard = boxGuard(ctx);
  if (!guard) return;
  const { game, userId } = guard;
  const nonEmpty = game.getNonEmptyBoxes();
  if (nonEmpty.length === 0) return ctx.reply(msg.noNonEmptyBoxes);
  const buttons = nonEmpty.map(b =>
    Markup.button.callback(msg.boxLabel(b.index), `box_look_${userId}_${b.index}`)
  );
  return ctx.reply(msg.chooseBoxToLook, Markup.inlineKeyboard(buttons, { columns: 3 }));
}

async function openBox(ctx) {
  const guard = boxGuard(ctx);
  if (!guard) return;
  const { game, userId } = guard;
  const nonEmpty = game.getNonEmptyBoxes();
  if (nonEmpty.length === 0) return ctx.reply(msg.noNonEmptyBoxes);
  const buttons = nonEmpty.map(b =>
    Markup.button.callback(msg.boxLabel(b.index), `box_open_${userId}_${b.index}`)
  );
  return ctx.reply(msg.chooseBoxToOpen, Markup.inlineKeyboard(buttons, { columns: 3 }));
}

async function giftBox(ctx) {
  const guard = boxGuard(ctx);
  if (!guard) return;
  const { game, userId } = guard;
  const buttons = [];
  for (const [id, pl] of game.players) {
    if (id !== userId) buttons.push(Markup.button.callback(pl.name, `box_giftplayer_${userId}_${id}`));
  }
  if (buttons.length === 0) return ctx.reply('⚠️');
  return ctx.reply(msg.chooseGiftTarget, Markup.inlineKeyboard(buttons, { columns: 2 }));
}

async function handleBoxCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const parts = data.split('_');
  // box_{subtype}_{ownerId}_{...params}
  const subtype = parts[1];
  const ownerId = parseInt(parts[2]);
  const userId = ctx.from.id;

  // For "effect" callbacks the owner might be the target (gift), so handle separately
  if (subtype === 'effect') {
    return handleBoxEffectCallback(ctx, parts);
  }

  if (userId !== ownerId) return ctx.answerCbQuery(msg.notYourButton);

  const game = findGameByPlayer(userId);
  if (!game) return ctx.answerCbQuery('⚠️');

  const p = game.players.get(userId);
  const chatId = game.chatId;

  if (subtype === 'look') {
    const boxIndex = parseInt(parts[3]);
    if (game.usedExtraAction.has(userId)) return ctx.answerCbQuery(msg.alreadyUsedExtraAction);
    const content = game.peekBox(userId, boxIndex);
    if (!content) return ctx.answerCbQuery(msg.noNonEmptyBoxes);

    game.markExtraAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await sendDM(ctx, userId, msg.boxPeeked(content, boxIndex));
    await ctx.telegram.sendMessage(chatId, msg.boxPeekedPublic(p.name, boxIndex));

  } else if (subtype === 'open') {
    const boxIndex = parseInt(parts[3]);
    if (game.usedExtraAction.has(userId)) return ctx.answerCbQuery(msg.alreadyUsedExtraAction);
    const item = game.openBox(boxIndex);
    if (!item) return ctx.answerCbQuery(msg.noNonEmptyBoxes);

    game.markExtraAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.boxOpened(p.name, item, boxIndex));
    await applyBoxEffect(ctx, game, item, userId, userId);

  } else if (subtype === 'giftplayer') {
    const targetId = parseInt(parts[3]);
    if (game.usedExtraAction.has(userId)) return ctx.answerCbQuery(msg.alreadyUsedExtraAction);

    const nonEmpty = game.getNonEmptyBoxes();
    if (nonEmpty.length === 0) return ctx.answerCbQuery(msg.noNonEmptyBoxes);

    const target = game.players.get(targetId);
    if (!target) return ctx.answerCbQuery('⚠️');

    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    const buttons = nonEmpty.map(b =>
      Markup.button.callback(msg.boxLabel(b.index), `box_giftbox_${userId}_${targetId}_${b.index}`)
    );
    await ctx.telegram.sendMessage(chatId, msg.chooseGiftBox(target.name), Markup.inlineKeyboard(buttons, { columns: 3 }));

  } else if (subtype === 'giftbox') {
    const targetId = parseInt(parts[3]);
    const boxIndex = parseInt(parts[4]);
    if (game.usedExtraAction.has(userId)) return ctx.answerCbQuery(msg.alreadyUsedExtraAction);

    const item = game.openBox(boxIndex);
    if (!item) return ctx.answerCbQuery(msg.noNonEmptyBoxes);

    const target = game.players.get(targetId);
    if (!target) return ctx.answerCbQuery('⚠️');

    game.markExtraAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.boxGifted(p.name, target.name, item, boxIndex));
    await applyBoxEffect(ctx, game, item, targetId, userId);

  } else if (subtype === 'crowspeek') {
    // Crow's Nest free peek
    const boxIndex = parseInt(parts[3]);
    const content = game.peekBox(userId, boxIndex);
    if (!content) return ctx.answerCbQuery(msg.noNonEmptyBoxes);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await sendDM(ctx, userId, msg.boxPeeked(content));
    await ctx.telegram.sendMessage(chatId, msg.boxPeekedPublic(p.name, boxIndex));
  }
}

// Apply box effect. targetId = who the effect applies to. actorId = who opened/gifted.
async function applyBoxEffect(ctx, game, item, targetId, actorId) {
  const chatId = game.chatId;
  const target = game.players.get(targetId);
  const targetName = target?.name || '?';
  const isGift = targetId !== actorId;

  switch (item) {
    case 'blackspot': {
      const result = game.tryExpel(targetId, false);
      if (result.blocked) {
        await ctx.telegram.sendMessage(chatId, msg.cloverUsed(targetName));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.blackSpotApplied(targetName));
      }
      break;
    }
    case 'albatross': {
      game.addHeldItem(targetId, 'albatross');
      await ctx.telegram.sendMessage(chatId, msg.albatrossReceived(targetName));
      const ship = game.getPlayerShip(targetId);
      if (ship) {
        const result = game.checkAlbatrossAtShip(ship);
        if (result.triggered) {
          await ctx.telegram.sendMessage(chatId, msg.albatrossTriggered(ship));
        }
      }
      break;
    }
    case 'eldorado': {
      game.addHeldItem(targetId, 'eldorado');
      await ctx.telegram.sendMessage(chatId, msg.eldoradoReceived(targetName));
      break;
    }
    case 'clover': {
      game.addHeldItem(targetId, 'clover');
      await ctx.telegram.sendMessage(chatId, msg.cloverReceived(targetName));
      break;
    }
    case 'atlantis': {
      const ship = game.getPlayerShip(targetId);
      if (!ship) {
        await ctx.telegram.sendMessage(chatId, msg.atlantisNoEffect);
        break;
      }
      const otherShip = ship === 'flyingDutchman' ? 'jollyRoger' : 'flyingDutchman';
      if (game.locations[otherShip].crew.length >= 5) {
        await ctx.telegram.sendMessage(chatId, msg.atlantisShipFull);
        break;
      }
      game.removeFromLocation(targetId);
      game.locations[otherShip].crew.push(targetId);
      target.location = otherShip;
      await ctx.telegram.sendMessage(chatId, msg.atlantisApplied(targetName, otherShip));
      const albResult = game.checkAlbatrossAtShip(otherShip);
      if (albResult.triggered) {
        await ctx.telegram.sendMessage(chatId, msg.albatrossTriggered(otherShip));
      }
      break;
    }
    case 'eightbells': {
      const loc = target.location;
      if (loc === 'flyingDutchman' || loc === 'jollyRoger') {
        shuffle(game.locations[loc].crew);
      } else if (loc === 'island') {
        shuffle(game.locations.island.residents);
      }
      await ctx.telegram.sendMessage(chatId, msg.eightBellsApplied(targetName, loc));
      break;
    }
    case 'piratecode': {
      game.pirateCodeVotes.set(targetId, 2);
      await ctx.telegram.sendMessage(chatId, msg.pirateCodeApplied(targetName));
      break;
    }
    case 'scurvy': {
      const loc = target.location;
      const members = (loc === 'island')
        ? game.locations.island.residents
        : (game.locations[loc]?.crew || []);
      for (const id of members) game.scurvyNextRound.add(id);
      await ctx.telegram.sendMessage(chatId, msg.scurvyApplied(targetName, loc));
      break;
    }
    case 'stormysea': {
      const ship = game.getPlayerShip(targetId);
      if (ship) {
        const holds = game.locations[ship].holds;
        let returned = 0;
        for (let r = 0; r < 2; r++) {
          if (holds.english === 0 && holds.french === 0) break;
          if (holds.english >= holds.french) { holds.english--; }
          else { holds.french--; }
          game.locations.spanishShip.treasures++;
          returned++;
        }
        await ctx.telegram.sendMessage(chatId, msg.stormySeaShip(ship, returned));
      } else if (target.location === 'island') {
        game.locations.island.treasures = { english: 1, french: 1 };
        await ctx.telegram.sendMessage(chatId, msg.stormySeaIsland);
      }
      break;
    }
    case 'crowsnest': {
      // Free peek - the person who gets the effect (target) picks a box
      await ctx.telegram.sendMessage(chatId, msg.crowsNestApplied(targetName));
      const nonEmpty = game.getNonEmptyBoxes();
      if (nonEmpty.length > 0) {
        const buttons = nonEmpty.map(b =>
          Markup.button.callback(msg.boxLabel(b.index), `box_crowspeek_${targetId}_${b.index}`)
        );
        await sendDM(ctx, targetId, msg.crowsNestChooseBox, Markup.inlineKeyboard(buttons, { columns: 3 }));
      }
      break;
    }
    // --- Multi-step effects: show choices to the appropriate person ---
    case 'boat': {
      // Actor (or target if gift) chooses island resident, then ship
      const chooser = isGift ? targetId : actorId;
      const residents = game.locations.island.residents.filter(id => id !== chooser);
      if (residents.length === 0) {
        await ctx.telegram.sendMessage(chatId, msg.boatNoTarget);
        break;
      }
      const buttons = residents.map(id => {
        const pl = game.players.get(id);
        return Markup.button.callback(pl.name, `box_effect_${chooser}_boat_${id}`);
      });
      game.pendingBoxEffect = { type: 'boat', chooserId: chooser, step: 'resident' };
      if (isGift) {
        await sendDM(ctx, chooser, msg.boatChooseResident, Markup.inlineKeyboard(buttons, { columns: 2 }));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.boatChooseResident, Markup.inlineKeyboard(buttons, { columns: 2 }));
      }
      break;
    }
    case 'pistol': {
      const chooser = isGift ? targetId : actorId;
      const allCrew = [
        ...game.locations.flyingDutchman.crew,
        ...game.locations.jollyRoger.crew,
      ].filter(id => id !== chooser);
      if (allCrew.length === 0) {
        await ctx.telegram.sendMessage(chatId, msg.pistolNoTarget);
        break;
      }
      const buttons = allCrew.map(id => {
        const pl = game.players.get(id);
        const ship = game.getPlayerShip(id);
        return Markup.button.callback(`${pl.name} (${shipLabel(ship)})`, `box_effect_${chooser}_pistol_${id}`);
      });
      game.pendingBoxEffect = { type: 'pistol', chooserId: chooser };
      if (isGift) {
        await sendDM(ctx, chooser, msg.pistolChooseCrew, Markup.inlineKeyboard(buttons, { columns: 1 }));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.pistolChooseCrew, Markup.inlineKeyboard(buttons, { columns: 1 }));
      }
      break;
    }
    case 'blackpowder': {
      const chooser = isGift ? targetId : actorId;
      const buttons = [
        Markup.button.callback(LOCATION_NAMES.flyingDutchman, `box_effect_${chooser}_blackpowder_fd`),
        Markup.button.callback(LOCATION_NAMES.jollyRoger, `box_effect_${chooser}_blackpowder_jr`),
      ];
      game.pendingBoxEffect = { type: 'blackpowder', chooserId: chooser };
      if (isGift) {
        await sendDM(ctx, chooser, msg.blackPowderChooseShip, Markup.inlineKeyboard(buttons, { columns: 1 }));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.blackPowderChooseShip, Markup.inlineKeyboard(buttons, { columns: 1 }));
      }
      break;
    }
    case 'shipfever': {
      const chooser = isGift ? targetId : actorId;
      const buttons = [];
      for (const [id, pl] of game.players) {
        if (id !== chooser) buttons.push(Markup.button.callback(pl.name, `box_effect_${chooser}_shipfever_${id}`));
      }
      game.pendingBoxEffect = { type: 'shipfever', chooserId: chooser };
      if (isGift) {
        await sendDM(ctx, chooser, msg.shipFeverChoosePlayer, Markup.inlineKeyboard(buttons, { columns: 2 }));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.shipFeverChoosePlayer, Markup.inlineKeyboard(buttons, { columns: 2 }));
      }
      break;
    }
    case 'mask': {
      const loc = target.location;
      const list = (loc === 'island')
        ? game.locations.island.residents
        : (game.locations[loc]?.crew || []);
      const idx = list.indexOf(targetId);
      const adjacent = [];
      if (idx > 0) adjacent.push(list[idx - 1]);
      if (idx < list.length - 1) adjacent.push(list[idx + 1]);
      if (adjacent.length === 0) {
        await ctx.telegram.sendMessage(chatId, msg.maskNoTarget);
        break;
      }
      const chooser = isGift ? targetId : actorId;
      const buttons = adjacent.map(id => {
        const pl = game.players.get(id);
        return Markup.button.callback(pl.name, `box_effect_${chooser}_mask_${id}`);
      });
      game.pendingBoxEffect = { type: 'mask', chooserId: chooser, targetId };
      if (isGift) {
        await sendDM(ctx, chooser, msg.maskChooseTarget, Markup.inlineKeyboard(buttons, { columns: 1 }));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.maskChooseTarget, Markup.inlineKeyboard(buttons, { columns: 1 }));
      }
      break;
    }
  }
}

// Handle follow-up callbacks for multi-step box effects
async function handleBoxEffectCallback(ctx, parts) {
  // box_effect_{chooserId}_{effectType}_{value}
  const chooserId = parseInt(parts[2]);
  const effectType = parts[3];
  const value = parts[4];
  const userId = ctx.from.id;

  if (userId !== chooserId) return ctx.answerCbQuery(msg.notYourButton);

  const game = findGameByPlayer(userId);
  if (!game) return ctx.answerCbQuery('⚠️');
  if (!game.pendingBoxEffect || game.pendingBoxEffect.chooserId !== chooserId) {
    return ctx.answerCbQuery('⚠️');
  }

  const chatId = game.chatId;
  const pending = game.pendingBoxEffect;

  await ctx.answerCbQuery('✅');
  try { await ctx.deleteMessage(); } catch {}

  if (effectType === 'boat' && pending.step === 'resident') {
    // Step 2: choose ship
    const residentId = parseInt(value);
    const buttons = [];
    if (game.locations.flyingDutchman.crew.length < 5)
      buttons.push(Markup.button.callback(LOCATION_NAMES.flyingDutchman, `box_effect_${chooserId}_boatship_${residentId}_fd`));
    if (game.locations.jollyRoger.crew.length < 5)
      buttons.push(Markup.button.callback(LOCATION_NAMES.jollyRoger, `box_effect_${chooserId}_boatship_${residentId}_jr`));
    if (buttons.length === 0) {
      await ctx.telegram.sendMessage(chatId, msg.boatNoTarget);
      game.pendingBoxEffect = null;
      await checkDayEnd(ctx, game);
      return;
    }
    game.pendingBoxEffect = { ...pending, step: 'ship', residentId };
    // Send to same channel as the first step was shown
    if (pending.chooserId !== userId) {
      await sendDM(ctx, chooserId, msg.boatChooseShip, Markup.inlineKeyboard(buttons, { columns: 1 }));
    } else {
      await ctx.telegram.sendMessage(chatId, msg.boatChooseShip, Markup.inlineKeyboard(buttons, { columns: 1 }));
    }
    return;
  }

  if (effectType === 'boatship') {
    const residentId = parseInt(value);
    const shipShort = parts[5];
    const ship = SHIP_SHORT[shipShort];
    if (!ship || game.locations[ship].crew.length >= 5) {
      game.pendingBoxEffect = null;
      await checkDayEnd(ctx, game);
      return;
    }
    const resident = game.players.get(residentId);
    if (resident && resident.location === 'island') {
      game.removeFromLocation(residentId);
      game.locations[ship].crew.push(residentId);
      resident.location = ship;
      await ctx.telegram.sendMessage(chatId, msg.boatApplied(resident.name, ship));
      const albResult = game.checkAlbatrossAtShip(ship);
      if (albResult.triggered) {
        await ctx.telegram.sendMessage(chatId, msg.albatrossTriggered(ship));
      }
    }
    game.pendingBoxEffect = null;
    await checkDayEnd(ctx, game);
    return;
  }

  if (effectType === 'pistol') {
    const victimId = parseInt(value);
    const victim = game.players.get(victimId);
    if (victim && game.getPlayerShip(victimId)) {
      const result = game.tryExpel(victimId, true);
      if (result.blocked) {
        await ctx.telegram.sendMessage(chatId, msg.cloverUsed(victim.name));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.pistolApplied(victim.name));
      }
    }
    game.pendingBoxEffect = null;
    await checkDayEnd(ctx, game);
    return;
  }

  if (effectType === 'blackpowder') {
    const ship = SHIP_SHORT[value];
    if (ship) {
      game.blackPowderShips.add(ship);
      await ctx.telegram.sendMessage(chatId, msg.blackPowderApplied(ship));
    }
    game.pendingBoxEffect = null;
    await checkDayEnd(ctx, game);
    return;
  }

  if (effectType === 'shipfever') {
    const otherId = parseInt(value);
    const chooser = game.players.get(chooserId);
    const other = game.players.get(otherId);
    if (chooser && other) {
      if (!chooser.originalTeam) chooser.originalTeam = chooser.team;
      if (!other.originalTeam) other.originalTeam = other.team;
      const temp = chooser.team;
      chooser.team = other.team;
      other.team = temp;
      await sendDM(ctx, chooserId, msg.shipFeverDM(chooser.team));
      await sendDM(ctx, otherId, msg.shipFeverDM(other.team));
      await ctx.telegram.sendMessage(chatId, msg.shipFeverApplied);
    }
    game.pendingBoxEffect = null;
    await checkDayEnd(ctx, game);
    return;
  }

  if (effectType === 'mask') {
    const swapWithId = parseInt(value);
    const maskTarget = game.players.get(pending.targetId || chooserId);
    const swapWith = game.players.get(swapWithId);
    if (maskTarget && swapWith && maskTarget.location === swapWith.location) {
      const loc = maskTarget.location;
      const list = (loc === 'island')
        ? game.locations.island.residents
        : (game.locations[loc]?.crew || []);
      const i1 = list.indexOf(pending.targetId || chooserId);
      const i2 = list.indexOf(swapWithId);
      if (i1 !== -1 && i2 !== -1) {
        [list[i1], list[i2]] = [list[i2], list[i1]];
        await ctx.telegram.sendMessage(chatId, msg.maskApplied(maskTarget.name, swapWith.name));
      }
    }
    game.pendingBoxEffect = null;
    await checkDayEnd(ctx, game);
    return;
  }
}

module.exports = {
  newGame, join, startGame, moveLocation, attack, maroon,
  mutiny, inspect, moveTreasure, callArmada, dispute, pass, status, sendDM,
  handleActionCallback, handleNewgameModeCallback, handleBoxCallback, lookBox, openBox, giftBox,
  checkDayEnd, leave, endGame, listPlayers, sendHelp,
};
