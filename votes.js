const { Markup } = require('telegraf');
const { findGameByPlayer, getGame, deleteGame } = require('./game');
const { msg, shipLabel, TEAM_NAMES } = require('./messages');
const { sendDM } = require('./actions');

// Transition from day to night (called automatically when all players are done)
async function endDay(ctx, game) {
  if (!game) {
    game = getGame(ctx.chat.id);
    if (!game) return;
  }
  if (game.phase !== 'day') return;

  if (game.pendingEvents.length === 0) {
    // No events, skip night
    await ctx.reply(msg.noEventsAtNight, { parse_mode: 'Markdown' });
    return advanceRound(ctx, game);
  }

  game.startNight();
  await ctx.reply(msg.nightStart, { parse_mode: 'Markdown' });

  // Send DMs with vote keyboards
  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];
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
    } else if (ev.type === 'dispute') {
      text = msg.voteDisputeDM;
      keyboard = Markup.inlineKeyboard([
        Markup.button.callback('🇬🇧 انگلیس', `vote_${i}_england`),
        Markup.button.callback('🇫🇷 فرانسه', `vote_${i}_france`),
      ]);
    }

    for (const voterId of voters) {
      await sendDM(ctx, voterId, text, keyboard);
    }
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

  // Check if all voting is complete
  if (game.allVotingComplete()) {
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
  await ctx.editMessageText(msg.treasurePlaced(result.ship, result.hold));

  // Announce in group
  await ctx.telegram.sendMessage(
    game.chatId,
    msg.treasurePlaced(result.ship, result.hold),
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

  for (let i = 0; i < game.pendingEvents.length; i++) {
    const ev = game.pendingEvents[i];

    if (ev.type === 'attack') {
      const result = game.resolveAttack(i);
      await ctx.telegram.sendMessage(
        chatId,
        msg.attackResult(result.success, result.charges, result.fires, result.waters),
        { parse_mode: 'Markdown' }
      );

      if (result.success) {
        // Captain chooses which hold to put the treasure
        const captainId = game.locations[result.ship].crew[0];
        if (captainId) {
          // Store pending treasure placement
          game._pendingTreasurePlacement = { ship: result.ship, eventIndex: i };
          const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('🇬🇧 انبار انگلیسی', 'loot_english'),
            Markup.button.callback('🇫🇷 انبار فرانسوی', 'loot_french'),
          ]);
          await sendDM(ctx, captainId, msg.captainChooseHold, keyboard);
          return; // Wait for captain's choice before continuing
        }
      }
    } else if (ev.type === 'mutiny') {
      const result = game.resolveMutiny(i);
      await ctx.telegram.sendMessage(
        chatId,
        msg.mutinyResult(result.success, result.forV, result.against),
        { parse_mode: 'Markdown' }
      );
    } else if (ev.type === 'dispute') {
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

  await advanceRound(ctx, game);
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
    msg.treasureCaptured(ship, hold),
    { parse_mode: 'Markdown' }
  );

  // Continue resolving remaining events
  await advanceRound(ctx, game);
}

async function advanceRound(ctx, game) {
  if (game.shouldGameEnd()) {
    return endGame(ctx, game);
  }
  game.round++;
  game.startDay();
  await sendDayStart(ctx, game);
}

async function sendDayStart(ctx, game) {
  await ctx.telegram.sendMessage(
    game.chatId,
    msg.status(game),
    { parse_mode: 'Markdown' }
  );
  await ctx.telegram.sendMessage(
    game.chatId,
    msg.dayStart(game.round),
    { parse_mode: 'Markdown' }
  );
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
