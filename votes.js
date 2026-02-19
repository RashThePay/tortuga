const { Markup } = require('telegraf');
const { findGameByPlayer, getGame, deleteGame } = require('./game');
const { msg, shipLabel, TEAM_NAMES } = require('./messages');
const { sendDM } = require('./actions');
const { renderGameState } = require('./canvas/render');

// Resolve non-voting day actions in order: moves, treasure transfers, inspects
async function resolveDayEndActions(ctx, game) {
  const chatId = game.chatId;
  const resolvedMoves = [];

  // Step 1: Resolve moves
  for (const ev of game.pendingEvents) {
    if (ev.type !== 'move') continue;
    const p = game.players.get(ev.userId);
    if (!p) continue;

    // Captain-leaving-during-mutiny special case:
    // If captain is leaving a ship that has a pending mutiny, treat as accepting mutiny
    const currentShip = game.getPlayerShip(ev.userId);
    if (currentShip && game.isCaptain(ev.userId)) {
      const hasMutiny = game.pendingEvents.some((e) => e.type === 'mutiny' && e.ship === currentShip);
      if (hasMutiny) {
        // Captain expelled — mutiny auto-succeeds
        game.sendToIsland(ev.userId, true); // sets expelledRound
        // Mark the mutiny as auto-resolved
        const mutinyEv = game.pendingEvents.find((e) => e.type === 'mutiny' && e.ship === currentShip);
        if (mutinyEv) mutinyEv.autoResolved = true;
        await ctx.telegram.sendMessage(chatId, msg.captainLeftDuringMutiny(p.name, currentShip), { parse_mode: 'Markdown' });
        continue;
      }
    }

    // Normal move: remove from current location, collect for rank-sorted placement
    const prevRanking = game.removeFromLocation(ev.userId);
    resolvedMoves.push({ userId: ev.userId, dest: ev.destination, prevRanking, name: p.name });
  }

  // Place movers at destinations sorted by previous ranking (lower = higher rank)
  resolvedMoves.sort((a, b) => {
    if (a.prevRanking === null) return 1;
    if (b.prevRanking === null) return -1;
    return a.prevRanking - b.prevRanking;
  });
  for (const m of resolvedMoves) {
    const p = game.players.get(m.userId);
    // Check ship capacity at resolution time (two players may have declared same destination)
    if (m.dest !== 'island' && game.locations[m.dest].crew.length >= 5) {
      // Ship full at resolution — redirect to island
      game.locations.island.residents.push(m.userId);
      p.location = 'island';
      await ctx.telegram.sendMessage(chatId, msg.moveRedirectedToIsland(m.name, m.dest));
    } else if (m.dest === 'island') {
      game.locations.island.residents.push(m.userId);
      p.location = m.dest;
      await ctx.telegram.sendMessage(chatId, msg.movedTo(m.name, m.dest));
    } else {
      game.locations[m.dest].crew.push(m.userId);
      p.location = m.dest;
      await ctx.telegram.sendMessage(chatId, msg.movedTo(m.name, m.dest));
    }
  }

  // Step 3: Resolve treasure transfers
  for (const ev of game.pendingEvents) {
    if (ev.type !== 'treasure_transfer') continue;
    const p = game.players.get(ev.userId);
    if (!p) continue;

    const holds = game.locations[ev.ship].holds;
    const sourceHold = ev.targetHold === 'english' ? 'french' : 'english';

    if (holds[sourceHold] > 0) {
      holds[sourceHold]--;
      holds[ev.targetHold]++;
      if (ev.mistMode) {
        await sendDM(ctx, ev.userId, msg.treasureMovedSuccess(ev.targetHold));
      } else {
        await ctx.telegram.sendMessage(chatId, msg.treasureMoved(p.name, ev.ship, ev.targetHold));
      }
    } else {
      if (ev.mistMode) {
        await sendDM(ctx, ev.userId, msg.treasureMovedFailed);
      }
      // Normal mode: silently fail (source was empty at resolution time)
    }
  }

  // Step 4: Resolve inspects (mist mode — after transfers so first mate sees post-transfer state)
  for (const ev of game.pendingEvents) {
    if (ev.type !== 'inspect') continue;

    const holds = game.locations[ev.ship].holds;
    const inspectText = `📊 *بررسی انبار* (${shipLabel(ev.ship)}):\n🇬🇧: ${holds.english.toLocaleString("fa-IR")}\n🇫🇷: ${holds.french.toLocaleString("fa-IR")}`;
    await sendDM(ctx, ev.initiator, inspectText);
  }
}

// Transition from day to night (called automatically when all players are done)
async function endDay(ctx, game) {
  if (!game) {
    game = getGame(ctx.chat.id);
    if (!game) return;
  }
  if (game.phase !== 'day') return;

  // === Day-end resolution phase: resolve non-voting actions before night ===
  await resolveDayEndActions(ctx, game);

  // Filter out resolved non-voting events, keep only voting events (attack, mutiny, maroon, dispute)
  game.pendingEvents = game.pendingEvents.filter(
    (e) => e.type === 'attack' || e.type === 'mutiny' || e.type === 'maroon' || e.type === 'dispute'
  );

  if (game.pendingEvents.length === 0) {
    // No voting events, skip night
    await ctx.reply(msg.noEventsAtNight, { parse_mode: 'Markdown' });
    return advanceRound(ctx, game);
  }

  game.startNight();
  await ctx.reply(msg.nightStart, { parse_mode: 'Markdown' });

  // Send DMs with vote keyboards (phase 1: attack + mutiny only; dispute DMs sent in phase 2)
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.cancelled || ev.autoResolved) continue;
    if (ev.type === 'dispute') continue; // dispute voting deferred to phase 2

    const voters = game.expectedVoters.get(i);

    let text, keyboard;
    if (ev.type === 'attack') {
      text = msg.voteAttackDM;
      keyboard = Markup.inlineKeyboard([
        Markup.button.callback('⚔️ یورش', `vote_${i}_charge`),
        Markup.button.callback('🔥 آتش', `vote_${i}_fire`),
        Markup.button.callback('💧 خاموش', `vote_${i}_water`),
      ]);
    } else if (ev.type === 'mutiny') {
      text = msg.voteMutinyDM;
      keyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ موافق', `vote_${i}_for`),
        Markup.button.callback('❌ مخالف', `vote_${i}_against`),
      ]);
    }

    for (const voterId of voters) {
      await sendDM(ctx, voterId, text, keyboard);
    }
  }

  // If all events were cancelled, resolve immediately
  if (game.allVotingComplete()) {
    await resolveAllEvents(ctx, game);
  }
}

// Handle vote callback queries from DMs
async function handleVoteCallback(ctx) {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('vote_')) return;

  const parts = data.split('_');
  const eventIndex = parseInt(parts[1]);
  const vote = parts[2];
  const userId = ctx.from.id;

  const game = findGameByPlayer(userId);
  if (!game || game.phase !== 'night') {
    return ctx.answerCbQuery('⚠️ رای‌گیری فعالی وجود ندارد.');
  }

  const recorded = game.recordVote(eventIndex, userId, vote);
  if (!recorded) {
    return ctx.answerCbQuery(msg.alreadyVoted);
  }

  await ctx.answerCbQuery(msg.voteRecorded);
  await ctx.editMessageText(`✅ رای شما ثبت شد.`);

  // Two-phase voting: dispute votes are collected after mutiny/maroon resolve
  if (game._disputePhase) {
    if (disputeVotingComplete(game)) {
      await resolveDisputesAndAdvance(ctx, game);
    }
  } else if (game.allVotingComplete()) {
    await resolveAllEvents(ctx, game);
  }
}

// Handle setup callback (captain choosing initial treasure hold)
async function handleSetupCallback(ctx) {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('setup_')) return;

  const hold = data.replace('setup_', ''); // 'english' or 'french'
  const userId = ctx.from.id;

  const game = findGameByPlayer(userId);
  if (!game || game.phase !== 'setup') {
    return ctx.answerCbQuery('⚠️ بازی در مرحله‌ی تنظیمات نیست.');
  }

  const result = game.placeInitialTreasure(userId, hold);
  if (!result) {
    return ctx.answerCbQuery('⚠️ شما قبلاً انتخاب کرده‌اید.');
  }

  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(msg.treasurePlaced(result.ship, result.hold, false));

  // Announce in group
  await ctx.telegram.sendMessage(
    game.chatId,
    msg.treasurePlaced(result.ship, result.hold, game.mistMode),
    { parse_mode: 'Markdown' }
  );

  // If setup complete, start day
  if (game.isSetupComplete()) {
    game.startDay();
    await sendDayStart(ctx, game);
  }
}

async function resolveAllEvents(ctx, game) {
  const chatId = game.chatId;

  // Resolution order:
  // 1. Mutinies (resolved first)
  // 2. Captain actions: attack or maroon (cancelled if mutiny on same ship succeeded)
  // 3. Disputes
  // 4. Armada (already handled during day)

  // Track which ships had successful mutinies
  const mutinySucceeded = new Set();

  // Step 1: Resolve all mutinies
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'mutiny') continue;

    if (ev.cancelled) {
      await ctx.telegram.sendMessage(chatId, msg.mutinyCancelled(ev.ship), { parse_mode: 'Markdown' });
      continue;
    }

    if (ev.autoResolved) {
      // Mutiny succeeded because captain fled
      await ctx.telegram.sendMessage(
        chatId,
        msg.mutinyAutoSucceeded(ev.ship),
        { parse_mode: 'Markdown' }
      );
      mutinySucceeded.add(ev.ship);
      continue;
    }

    const result = game.resolveMutiny(i);
    await ctx.telegram.sendMessage(
      chatId,
      msg.mutinyResult(result.success, result.forV, result.against, result.ship),
      { parse_mode: 'Markdown' }
    );

    if (result.success) {
      mutinySucceeded.add(ev.ship);
    }
  }

  // Step 2: Resolve captain actions (attack / maroon) — cancelled if mutiny succeeded on same ship
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'attack' && ev.type !== 'maroon') continue;

    // Cancel captain's action if mutiny succeeded on this ship
    if (mutinySucceeded.has(ev.ship)) {
      await ctx.telegram.sendMessage(chatId, msg.captainActionCancelledByMutiny(ev.ship), { parse_mode: 'Markdown' });
      continue;
    }

    if (ev.cancelled) {
      if (ev.type === 'attack') {
        await ctx.telegram.sendMessage(chatId, msg.attackCancelled(ev.ship), { parse_mode: 'Markdown' });
      }
      continue;
    }

    if (ev.type === 'attack') {
      const result = game.resolveAttack(i);
      await ctx.telegram.sendMessage(
        chatId,
        msg.attackResult(result.success, result.charges, result.fires, result.waters, result.ship),
        { parse_mode: 'Markdown' }
      );

      if (result.success) {
        const captainId = game.locations[result.ship].crew[0];
        if (captainId) {
          game._pendingTreasurePlacement = { ship: result.ship, eventIndex: i };
          const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('🇬🇧 انبار انگلیسی', 'loot_english'),
            Markup.button.callback('🇫🇷 انبار فرانسوی', 'loot_french'),
          ]);
          await sendDM(ctx, captainId, msg.captainChooseHold, keyboard);
          // Store remaining events to resolve after loot choice
          game._remainingResolution = { mutinySucceeded };
          return; // Wait for captain's choice
        }
      }
    } else if (ev.type === 'maroon') {
      // Execute maroon: send target to island
      const target = game.players.get(ev.targetId);
      if (target) {
        game.sendToIsland(ev.targetId, true); // Mark as expelled
        const initiatorName = game.players.get(ev.initiator)?.name || '?';
        await ctx.telegram.sendMessage(chatId, msg.maroonPlayer(initiatorName, target.name, ev.ship));
      }
    }
  }

  // Step 3: Set up dispute voting (phase 2) — voters determined now that island residents are final
  await setupDisputePhase(ctx, game);
}

// Two-phase voting: dispute voters are set up AFTER mutiny/maroon resolve
// so that expelled/marooned players can vote in disputes
async function setupDisputePhase(ctx, game) {
  const hasDispute = game.pendingEvents.some(e => e.type === 'dispute' && !e.cancelled);
  if (!hasDispute) {
    return advanceRound(ctx, game);
  }

  // Set up dispute voters based on current island residents (post mutiny/maroon)
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'dispute' || ev.cancelled) continue;

    const voters = new Set();
    for (const id of game.locations.island.residents) voters.add(id);
    game.expectedVoters.set(i, voters);
    game.votes.set(i, new Map());

    if (voters.size === 0) {
      ev.cancelled = true;
      continue;
    }

    // Send dispute vote DMs
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('🇬🇧 انگلیس', `vote_${i}_england`),
      Markup.button.callback('🇫🇷 فرانسه', `vote_${i}_france`),
    ]);
    for (const voterId of voters) {
      await sendDM(ctx, voterId, msg.voteDisputeDM, keyboard);
    }
  }

  game._disputePhase = true;

  // Check if voting is already complete (e.g., all disputes cancelled)
  if (disputeVotingComplete(game)) {
    return resolveDisputesAndAdvance(ctx, game);
  }
}

function disputeVotingComplete(game) {
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'dispute' || ev.cancelled) continue;
    if (!game.isVotingComplete(i)) return false;
  }
  return true;
}

async function resolveDisputesAndAdvance(ctx, game) {
  delete game._disputePhase;
  await resolveDisputes(ctx, game);
  await advanceRound(ctx, game);
}

async function resolveDisputes(ctx, game) {
  const chatId = game.chatId;

  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'dispute') continue;
    if (ev.cancelled) continue;

    const result = game.resolveDispute(i);
    await ctx.telegram.sendMessage(
      chatId,
      msg.disputeResult(result.engVotes, result.frVotes),
      { parse_mode: 'Markdown' }
    );
    if (result.governorDeposed) {
      const govName = game.players.get(result.governor)?.name || '?';
      await ctx.telegram.sendMessage(
        chatId,
        msg.governorDeposed(govName)
      );
    }
  }
}

// Handle loot callback (captain choosing hold after successful attack)
async function handleLootCallback(ctx) {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('loot_')) return;

  const hold = data.replace('loot_', '');
  const userId = ctx.from.id;

  const game = findGameByPlayer(userId);
  if (!game || !game._pendingTreasurePlacement) {
    return ctx.answerCbQuery('⚠️');
  }

  const { ship } = game._pendingTreasurePlacement;
  game.applyAttackSuccess(ship, hold);
  delete game._pendingTreasurePlacement;

  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(msg.treasureCaptured(ship, hold));

  await ctx.telegram.sendMessage(
    game.chatId,
    game.mistMode ? msg.treasureCapturedMistMode(ship) : msg.treasureCaptured(ship, hold),
    { parse_mode: 'Markdown' }
  );

  // Continue resolving remaining captain actions and disputes
  const mutinySucceeded = game._remainingResolution?.mutinySucceeded || new Set();
  delete game._remainingResolution;

  const chatId = game.chatId;

  // Continue with remaining captain actions (attack/maroon) after the one that triggered loot
  let pastLoot = false;
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
    if (ev.type !== 'attack' && ev.type !== 'maroon') continue;
    if (ev.ship === ship && ev.type === 'attack') {
      pastLoot = true; // This was the attack that triggered loot
      continue;
    }
    if (!pastLoot) continue;

    if (mutinySucceeded.has(ev.ship)) {
      await ctx.telegram.sendMessage(chatId, msg.captainActionCancelledByMutiny(ev.ship), { parse_mode: 'Markdown' });
      continue;
    }
    if (ev.cancelled) continue;

    if (ev.type === 'attack') {
      const result = game.resolveAttack(i);
      await ctx.telegram.sendMessage(
        chatId,
        msg.attackResult(result.success, result.charges, result.fires, result.waters, result.ship),
        { parse_mode: 'Markdown' }
      );
      if (result.success) {
        const captainId = game.locations[result.ship].crew[0];
        if (captainId) {
          game._pendingTreasurePlacement = { ship: result.ship, eventIndex: i };
          game._remainingResolution = { mutinySucceeded };
          const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('🇬🇧 انبار انگلیسی', 'loot_english'),
            Markup.button.callback('🇫🇷 انبار فرانسوی', 'loot_french'),
          ]);
          await sendDM(ctx, captainId, msg.captainChooseHold, keyboard);
          return;
        }
      }
    } else if (ev.type === 'maroon') {
      const target = game.players.get(ev.targetId);
      if (target) {
        game.sendToIsland(ev.targetId, true);
        const initiatorName = game.players.get(ev.initiator)?.name || '?';
        await ctx.telegram.sendMessage(chatId, msg.maroonPlayer(initiatorName, target.name, ev.ship));
      }
    }
  }

  // Set up dispute voting phase (phase 2)
  await setupDisputePhase(ctx, game);
}

async function advanceRound(ctx, game) {
  if (game.shouldGameEnd()) {
    return endGame(ctx, game);
  }
  game.round++;
  game.startDay();
  await sendDayStart(ctx, game);
}

function buildRenderData(game) {
  const getName = (id) => game.players.get(id)?.name || '?';
  return {
    island: {
      residents: game.locations.island.residents.map(getName),
      english: game.locations.island.treasures.english,
      french: game.locations.island.treasures.french,
    },
    jollyRoger: {
      crew: game.locations.jollyRoger.crew.map(getName),
      english: game.locations.jollyRoger.holds.english,
      french: game.locations.jollyRoger.holds.french,
    },
    flyingDutchman: {
      crew: game.locations.flyingDutchman.crew.map(getName),
      english: game.locations.flyingDutchman.holds.english,
      french: game.locations.flyingDutchman.holds.french,
    },
    spanish: game.locations.spanishShip.treasures,
  };
}

async function sendDayStart(ctx, game) {
  // Render and send game state image
  try {
    const canvas = await renderGameState(buildRenderData(game));
    const buf = canvas.toBuffer('image/png');
    const gameStateMessage = await ctx.telegram.sendPhoto(
      game.chatId,
      { source: buf },
      { caption: msg.status(game), parse_mode: 'Markdown' }
    );
    await ctx.telegram.sendMessage(
      game.chatId,
      msg.dayStart(game.round, game.mistMode),
      { parse_mode: 'Markdown' }
    );
    try {
      await ctx.telegram.pinChatMessage(game.chatId, gameStateMessage.message_id);
    } catch { }
  } catch (err) {
    // Fallback to text if image rendering fails
    const gameStateMessage = await ctx.telegram.sendMessage(
      game.chatId,
      msg.status(game),
      { parse_mode: 'Markdown' }
    );
    await ctx.telegram.sendMessage(
      game.chatId,
      msg.dayStart(game.round, game.mistMode),
      { parse_mode: 'Markdown' }
    );
    try {
      await ctx.telegram.pinChatMessage(game.chatId, gameStateMessage.message_id);
    } catch { }
  }
}

async function endGame(ctx, game) {
  game.phase = 'ended';
  const chatId = game.chatId;

  await ctx.telegram.sendMessage(chatId, msg.gameEnd, { parse_mode: 'Markdown' });

  const result = game.getWinner();
  const governorId = game.locations.island.residents[0];
  const governorTeam = governorId ? game.players.get(governorId)?.team : null;

  await ctx.telegram.sendMessage(
    chatId,
    msg.finalScores(result.english, result.french, result.winner, governorTeam),
    { parse_mode: 'Markdown' }
  );

  // Dutch result
  const dutchResult = game.getDutchResult();
  if (dutchResult) {
    if (dutchResult.solo) {
      await ctx.telegram.sendMessage(
        chatId,
        '🇳🇱 بازیکن هلندی به‌تنهایی برنده‌ی بازی شد! (حاکم جزیره در بازی مساوی)',
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.sendMessage(
        chatId,
        msg.dutchResult(dutchResult.won, dutchResult.reason)
      );
    }
  }

  // Spanish result
  const spanishResult = game.getSpanishResult();
  if (spanishResult) {
    if (spanishResult.solo) {
      await ctx.telegram.sendMessage(
        chatId,
        '🇪🇸 بازیکن اسپانیایی به‌تنهایی برنده‌ی بازی شد! (حاکم جزیره در بازی مساوی)',
        { parse_mode: 'Markdown' }
      );
    } else if (spanishResult.independent) {
      await ctx.telegram.sendMessage(
        chatId,
        `🇪🇸 بازیکن اسپانیایی نیز *برنده* شد! (${spanishResult.reason})`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.sendMessage(
        chatId,
        msg.spanishResult(spanishResult.won, spanishResult.reason)
      );
    }
  }

  // Reveal all teams
  const reveals = [];
  for (const [, p] of game.players) {
    reveals.push(`${p.name}: ${TEAM_NAMES[p.team]}`);
  }
  await ctx.telegram.sendMessage(
    chatId,
    `🃏 *تیم بازیکنان:*\n${reveals.join('\n')}`,
    { parse_mode: 'Markdown' }
  );

  deleteGame(chatId);
}

module.exports = { endDay, handleVoteCallback, handleSetupCallback, handleLootCallback };
