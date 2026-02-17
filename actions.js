const { Markup } = require('telegraf');
const { getGame, createGame, findGameByPlayer, deleteGame } = require('./game');
const { msg, SHIP_SHORT, shipLabel, LOCATION_NAMES, TEAM_NAMES } = require('./messages');

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
    Markup.button.callback('عادی', 'newgame_normal'),
    Markup.button.callback('🌫️ مه‌گرفتگی', 'newgame_mist'),
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
  if (game.lobbyPlayers.length < 4) return ctx.reply(msg.needMorePlayers);

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

  // Inspect the holds
  const holds = game.locations[ship].holds;
  const inspectText = `📊 *بررسی انبار* (${shipLabel(ship)}):\n🇬🇧: ${holds.english.toLocaleString("fa-IR")}\n🇫🇷: ${holds.french.toLocaleString("fa-IR")}`;

  // Send privately to first mate
  await sendDM(ctx, userId, inspectText);

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
      Markup.button.callback('🇬🇧 → 🇫🇷', `act_move_mist_${userId}_french`),
      Markup.button.callback('🇫🇷 → 🇬🇧', `act_move_mist_${userId}_english`),
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

    // Check if captain is leaving with a pending mutiny - mutiny succeeds automatically
    const currentShip = game.getPlayerShip(userId);
    let mutinyAutoResolved = false;
    if (game.isCaptain(userId) && currentShip && dest !== currentShip) {
      const mutinyEvent = game.pendingEvents.find((e) => e.type === 'mutiny' && e.ship === currentShip);
      if (mutinyEvent) {
        // Captain is leaving so mutiny succeeds automatically
        mutinyEvent.autoResolved = true; // Mark for special handling
        game.sendToIsland(userId, true); // Mark as expelled
        game.markAction(userId);
        await ctx.answerCbQuery('✅');
        await ctx.deleteMessage();
        await ctx.telegram.sendMessage(chatId, msg.captainLeftDuringMutiny(p.name, currentShip));
        await checkDayEnd(ctx, game);
        return;
      }
    }
    // Perform move
    
    const previousRanking = game.removeFromLocation(userId);
    if (dest === 'island') {
      game.locations.island.pendingJoins.push({userId, ranking: previousRanking});
    } else {
      game.locations[dest].pendingJoins.push({userId, ranking: previousRanking});
    }
    p.location = dest;

    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.movedTo(p.name, dest));

  } else if (type === 'move') {
    const targetHold = value; // 'english' or 'french'
    const ship = game.getPlayerShip(userId);
    const holds = game.locations[ship].holds;
    const sourceHold = targetHold === 'english' ? 'french' : 'english';
    if (holds[sourceHold] <= 0) {
      await ctx.answerCbQuery(msg.noTreasureToMove(sourceHold));
      return;
    }
    holds[sourceHold]--;
    holds[targetHold]++;
    game.markAction(userId);
    await ctx.answerCbQuery('✅');
    await ctx.deleteMessage();
    await ctx.telegram.sendMessage(chatId, msg.treasureMoved(p.name, ship, targetHold));

  } else if (type === 'move_mist') {
    // Mist mode: cabin boy chooses direction, result is private
    const targetHold = value; // 'english' or 'french'
    const ship = game.getPlayerShip(userId);
    const holds = game.locations[ship].holds;
    const sourceHold = targetHold === 'english' ? 'french' : 'english';

    let success = false;
    let resultMessage = '';
    if (holds[sourceHold] > 0) {
      holds[sourceHold]--;
      holds[targetHold]++;
      success = true;
      resultMessage = msg.treasureMovedSuccess(targetHold);
    } else {
      resultMessage = msg.treasureMovedFailed;
    }

    game.markAction(userId);
    await ctx.answerCbQuery(resultMessage);
    await ctx.deleteMessage();
    // Publicly announce only the attempt
    const direction = sourceHold === 'english' ? '🇬🇧 → 🇫🇷' : '🇫🇷 → 🇬🇧';
    await ctx.telegram.sendMessage(chatId, msg.treasureMoveAttempt(p.name, ship, direction));

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
    game.mistMode = false;
  } else if (data === 'newgame_mist') {
    game.mistMode = true;
  }

  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(msg.newGame(game.mistMode), { parse_mode: 'Markdown' });
}

module.exports = {
  newGame, join, startGame, moveLocation, attack, maroon,
  mutiny, inspect, moveTreasure, callArmada, dispute, pass, status, sendDM,
  handleActionCallback, handleNewgameModeCallback, checkDayEnd, leave, endGame, listPlayers, sendHelp,
};
