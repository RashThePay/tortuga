const { Telegraf, Markup } = require('telegraf');
const Game = require('../game/engine');
const { ACTIONS, LOCATIONS, WAREHOUSES, PHASES, VOTES, TEAMS } = require('../game/constants');

class TreasureIslandBot {
  constructor(token) {
    this.bot = new Telegraf(token);
    this.games = new Map(); // chatId -> Game object
    this.playerGames = new Map(); // playerId -> chatId (to know which game a player is in when they DM)
    this.setupHandlers();
  }

  setupHandlers() {
    this.bot.telegram.setMyCommands([
      { command: 'new_game', description: 'ساخت بازی جدید' },
      { command: 'join', description: 'پیوستن به بازی' },
      { command: 'start', description: 'شروع بازی' },
      { command: 'stop', description: 'توقف و حذف بازی' },
      { command: 'help', description: 'راهنمای بازی' }
    ]);

    this.bot.command('new_game', (ctx) => this.handleNewGame(ctx));
    this.bot.command('join', (ctx) => this.handleJoin(ctx));
    this.bot.command('start', (ctx) => {
      if (ctx.chat.type === 'private') {
        ctx.reply('سلام! من ربات بازی جزیره گنج هستم. برای شروع بازی باید در یک گروه از دستورات /new_game و /join استفاده کنید.');
      } else {
        this.handleStart(ctx);
      }
    });
    this.bot.command('stop', (ctx) => this.handleStop(ctx));
    this.bot.command('help', (ctx) => {
      ctx.reply(`🏴‍☠️ *راهنمای بازی جزیره گنج*

1. ابتدا با دستور /new_game بازی را بسازید.
2. حالت بازی (عادی یا مه‌آلود) را انتخاب کنید.
3. سایر بازیکنان با /join وارد شوند (حداقل ۴ نفر).
4. با دستور /start بازی را شروع کنید.

جزئیات نقش‌ها و اقدامات در پی‌وی ربات برای شما ارسال خواهد شد.`, { parse_mode: 'Markdown' });
    });

    this.bot.action('act_choose_move', async (ctx) => {
        const userId = ctx.from.id;
        const chatId = this.playerGames.get(userId);
        const game = this.games.get(chatId);
        if (!game) return;
        const player = game.players.get(userId);
        if (!player) return;

        const moves = [];
        if (player.location === LOCATIONS.ISLAND) {
            moves.push([Markup.button.callback('🚢 فلاینگ داچمن', `act_${ACTIONS.MOVE}_${LOCATIONS.FLYING_DUTCHMAN}`)]);
            moves.push([Markup.button.callback('🏴‍☠️ جالی راجر', `act_${ACTIONS.MOVE}_${LOCATIONS.JOLLY_ROGER}`)]);
        } else {
            moves.push([Markup.button.callback('🏝 جزیره', `act_${ACTIONS.MOVE}_${LOCATIONS.ISLAND}`)]);
        }
        await ctx.editMessageText('مقصد حرکت را انتخاب کنید:', Markup.inlineKeyboard(moves));
    });

    this.bot.on('callback_query', (ctx) => this.handleCallback(ctx));
  }

  async handleNewGame(ctx) {
    if (ctx.chat.type === 'private') return;
    const chatId = ctx.chat.id;
    if (this.games.has(chatId)) {
      return ctx.reply('یک بازی در این گروه در حال جریان است.');
    }

    this.games.set(chatId, new Game(chatId));
    ctx.reply('🎮 بازی جدید ساخته شد!\nلطفاً حالت بازی را انتخاب کنید:', Markup.inlineKeyboard([
      [Markup.button.callback('عادی ☀️', 'fog_off'), Markup.button.callback('مه‌آلود 🌫', 'fog_on')]
    ]));
  }

  async handleJoin(ctx) {
    if (ctx.chat.type === 'private') return;
    const chatId = ctx.chat.id;
    const game = this.games.get(chatId);
    if (!game) {
      return ctx.reply('ابتدا باید با /new_game یک بازی بسازید.');
    }
    if (game.phase !== PHASES.LOBBY) {
      return ctx.reply('بازی در حال حاضر شروع شده است.');
    }

    const userId = ctx.from.id;
    const userName = ctx.from.first_name;
    if (game.addPlayer(userId, userName)) {
      this.playerGames.set(userId, chatId);
      ctx.reply(`${userName} به بازی پیوست. (تعداد بازیکنان: ${game.players.size}/10)`);
    } else {
      ctx.reply('شما قبلاً عضو شده‌اید یا ظرفیت بازی تکمیل است.');
    }
  }

  async handleStart(ctx) {
    const chatId = ctx.chat.id;
    const game = this.games.get(chatId);
    if (!game) return;
    if (game.phase !== PHASES.LOBBY) return;
    if (!game.players.has(ctx.from.id)) return;

    if (game.players.size < 4) {
      return ctx.reply('برای شروع بازی حداقل به ۴ نفر نیاز است.');
    }

    if (game.fogMode === undefined) {
        return ctx.reply('لطفاً ابتدا حالت بازی (مه‌آلود یا عادی) را انتخاب کنید.');
    }

    game.startGame(game.fogMode);
    ctx.reply(`بازی با ${game.players.size} بازیکن شروع شد! (حالت: ${game.fogMode ? 'مه‌آلود' : 'عادی'})`);
    this.announceRoles(game);
    this.startPreGame(game);
  }

  async handleStop(ctx) {
    const chatId = ctx.chat.id;
    const game = this.games.get(chatId);
    if (!game) return;
    
    // In a real scenario, you might want to restrict this to admins or the host
    game.players.forEach((_, id) => this.playerGames.delete(id));
    this.games.delete(chatId);
    ctx.reply('🛑 بازی متوقف شد.');
  }

  async handleCallback(ctx) {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const chatId = this.playerGames.get(userId);
    const game = this.games.get(chatId);

    if (!game) return ctx.answerCbQuery('بازی یافت نشد.');

    if (data === 'fog_on' || data === 'fog_off') {
      if (game.phase !== PHASES.LOBBY) return;
      game.fogMode = (data === 'fog_on');
      await ctx.editMessageText(`حالت بازی انتخاب شد: ${game.fogMode ? 'مه‌آلود 🌫' : 'عادی ☀️'}\nاکنون بازیکنان می‌توانند با /join وارد شوند و سپس یکی از اعضا /start را بزند.`);
      return;
    }

    if (data.startsWith('init_wh_')) {
      const wh = data.split('_')[2];
      const player = game.setInitialWarehouse(userId, wh);
      if (player) {
        await ctx.editMessageText(`انبار ${game.getWarehouseName(wh)} برای کشتی شما انتخاب شد.`);
        const ship = game.ships[player.location];
        const whText = game.fogMode ? 'نامشخص' : game.getWarehouseName(wh);
        this.bot.telegram.sendMessage(game.chatId, `⚓️ ناخدا ${player.name} گنج اولیه ${ship.name} را در انبار ${whText} قرار داد.`);
        
        if (game.phase === PHASES.DAY) {
          this.startDay(game);
        }
      }
      return;
    }

    if (data.startsWith('act_')) {
      const parts = data.split('_');
      const action = parts[1];
      const target = parts[2];

      if (action === 'choose') return ctx.answerCbQuery();
      
      // Special handling for actions that need more data (like Exile target or Move target)
      const player = game.players.get(userId);
      let actionData = null;
      let announcement = null;

      if (action === ACTIONS.MOVE) {
        if (!target) return ctx.answerCbQuery();
        actionData = { target };
        announcement = `${player.name} اقدام به حرکت به سمت ${game.getLocationName(target)} کرد.`;
      } else if (action === ACTIONS.EXILE) {
        if (!target) {
            const ship = game.ships[player.location];
            const buttons = ship.crew.filter(p => p.id !== userId).map(p => 
                [Markup.button.callback(p.name, `act_EXILE_${p.id}`)]
            );
            await ctx.editMessageText('چه کسی را می‌خواهید اخراج کنید؟', Markup.inlineKeyboard(buttons));
            return;
        } else {
            const targetPlayer = game.players.get(parseInt(target));
            actionData = { targetId: parseInt(target) };
            announcement = `${player.name} اقدام به اخراج ${targetPlayer.name} کرد.`;
        }
      } else if (action === ACTIONS.ATTACK) {
          if (!target) {
             await ctx.editMessageText('گنج دزدیده شده در کدام انبار قرار گیرد؟', Markup.inlineKeyboard([
                 [Markup.button.callback('انگلیسی', `act_ATTACK_${WAREHOUSES.ENGLISH}`)],
                 [Markup.button.callback('فرانسوی', `act_ATTACK_${WAREHOUSES.FRENCH}`)]
             ]));
             return;
          } else {
             actionData = { warehouse: target };
             const whText = game.fogMode ? 'نامشخص' : game.getWarehouseName(target);
             announcement = `${player.name} دستور حمله صادر کرد و انبار مقصد را ${whText} انتخاب کرد.`;
          }
      } else if (action === ACTIONS.TREASURE_MOVE) {
          if (parts.length === 2) {
              await ctx.editMessageText('از کدام انبار؟', Markup.inlineKeyboard([
                  [Markup.button.callback('انگلیسی', `act_TREASURE_MOVE_${WAREHOUSES.ENGLISH}`)],
                  [Markup.button.callback('فرانسوی', `act_TREASURE_MOVE_${WAREHOUSES.FRENCH}`)]
              ]));
              return;
          } else if (parts.length === 3) {
              const from = parts[2];
              const to = from === WAREHOUSES.ENGLISH ? WAREHOUSES.FRENCH : WAREHOUSES.ENGLISH;
              actionData = { from, to };
              announcement = `${player.name} اقدام به جابه‌جایی گنج کرد.`;
          }
      } else {
          announcement = `${player.name} اقدام ${this.getActionName(action)} را انتخاب کرد.`;
      }

      game.submitAction(userId, action, actionData);
      await ctx.editMessageText(`اقدام شما ثبت شد.`);
      this.bot.telegram.sendMessage(game.chatId, `📢 ${announcement}`);
      this.checkDayProgress(game);
    }

    if (data.startsWith('vote_')) {
      const vote = data.split('_')[1];
      game.submitVote(userId, vote);
      await ctx.editMessageText('رأی شما ثبت شد.');
      this.checkNightProgress(game);
    }

    ctx.answerCbQuery();
  }

  announceRoles(game) {
    game.players.forEach(player => {
      this.bot.telegram.sendMessage(player.id, `نقش شما در بازی: ${this.getTeamName(player.team)} ${this.getTeamIcon(player.team)}`);
    });
  }

  startPreGame(game) {
    game.phase = PHASES.PRE_GAME;
    this.bot.telegram.sendMessage(game.chatId, "ناخداها باید انبار گنج اولیه کشتی خود را انتخاب کنند (در پیام شخصی).");
    game.players.forEach(p => {
      if (p.isCaptain()) {
        this.bot.telegram.sendMessage(p.id, "کدام انبار برای گنج اولیه؟", Markup.inlineKeyboard([
          [Markup.button.callback('انگلیسی', `init_wh_${WAREHOUSES.ENGLISH}`)],
          [Markup.button.callback('فرانسوی', `init_wh_${WAREHOUSES.FRENCH}`)]
        ]));
      }
    });
  }

  startDay(game) {
    this.bot.telegram.sendMessage(game.chatId, game.getGameStateSummary(), { parse_mode: 'Markdown' });
    this.bot.telegram.sendMessage(game.chatId, `☀️ *فاز روز راند ${game.round} آغاز شد.*\nبازیکنان اقدامات خود را در پی‌وی ربات انتخاب کنند.`, { parse_mode: 'Markdown' });
    
    game.players.forEach(p => {
      const buttons = this.getAvailableActions(game, p);
      this.bot.telegram.sendMessage(p.id, `راند ${game.round}: اقدام خود را انتخاب کنید:`, Markup.inlineKeyboard(buttons));
    });
  }

  getAvailableActions(game, player) {
    const buttons = [];
    
    // Everyone can Move or Pass
    buttons.push([Markup.button.callback('🚶 حرکت کردن', 'act_choose_move')]);
    
    if (player.isCaptain()) {
      buttons.push([Markup.button.callback('⚔️ دستور حمله', `act_${ACTIONS.ATTACK}`)]);
      buttons.push([Markup.button.callback('🏴‍☠️ اخراج خدمه', `act_${ACTIONS.EXILE}`)]);
    }
    
    if (player.isFirstMate(game.ships[player.location]?.crew.length)) {
      buttons.push([Markup.button.callback('🗡 شورش', `act_${ACTIONS.MUTINY}`)]);
      if (game.fogMode) {
        buttons.push([Markup.button.callback('🔍 بررسی انبار', `act_${ACTIONS.CHECK_WAREHOUSE}`)]);
      }
    }
    
    if (player.isCabinBoy(game.ships[player.location]?.crew.length)) {
      buttons.push([Markup.button.callback('📦 جابه‌جایی گنج', `act_${ACTIONS.TREASURE_MOVE}`)]);
    }
    
    if (player.location === LOCATIONS.ISLAND) {
      buttons.push([Markup.button.callback('⚔️ منازعه', `act_${ACTIONS.CONFLICT}`)]);
      if (player.isGovernor() && game.round >= 6) {
        buttons.push([Markup.button.callback('🚢 خبر کردن ناوگان', `act_${ACTIONS.CALL_FLEET}`)]);
      }
    }
    
    buttons.push([Markup.button.callback('💤 بدون اقدام (Pass)', `act_${ACTIONS.PASS}`)]);

    return buttons;
  }

  checkDayProgress(game) {
    if (game.allActionsSubmitted()) {
      const logs = game.resolveDay();
      this.bot.telegram.sendMessage(game.chatId, `🌕 *فاز شب راند ${game.round} آغاز شد.*\n\n${logs.join('\n')}`, { parse_mode: 'Markdown' });
      
      const expectedVoters = game.getExpectedVoters();
      if (expectedVoters.length === 0) {
        this.resolveNightAndContinue(game);
      } else {
        expectedVoters.forEach(v => {
          this.sendVoteOptions(game, v);
        });
      }
    }
  }

  sendVoteOptions(game, player) {
    const actions = Array.from(game.players.values()).map(p => ({ p, a: p.action }));
    
    // Check what the player needs to vote on
    const mutinyOnShip = actions.find(x => x.a === ACTIONS.MUTINY && x.p.location === player.location);
    if (mutinyOnShip && player.rank !== 1) {
       this.bot.telegram.sendMessage(player.id, "رأی‌گیری برای شورش:", Markup.inlineKeyboard([
           [Markup.button.callback('موافق ✅', `vote_${VOTES.SUPPORT}`), Markup.button.callback('مخالف ❌', `vote_${VOTES.OPPOSE}`)]
       ]));
       return;
    }

    const attackOnShip = actions.find(x => x.a === ACTIONS.ATTACK && x.p.location === player.location);
    if (attackOnShip) {
        this.bot.telegram.sendMessage(player.id, "رأی‌گیری برای حمله:", Markup.inlineKeyboard([
            [Markup.button.callback('⚔️ یورش', `vote_${VOTES.RAID}`)],
            [Markup.button.callback('🔥 آتش', `vote_${VOTES.FIRE}`)],
            [Markup.button.callback('💧 خاموش', `vote_${VOTES.EXTINGUISH}`)]
        ]));
        return;
    }

    const conflictOnIsland = actions.find(x => x.a === ACTIONS.CONFLICT);
    if (conflictOnIsland && player.location === LOCATIONS.ISLAND) {
        this.bot.telegram.sendMessage(player.id, "رأی‌گیری برای منازعه جزیره:", Markup.inlineKeyboard([
            [Markup.button.callback('🇬🇧 انگلیس', `vote_${VOTES.VOTE_ENGLISH}`), Markup.button.callback('🇫🇷 فرانسه', `vote_${VOTES.VOTE_FRENCH}`)]
        ]));
        return;
    }
  }

  checkNightProgress(game) {
    if (game.allVotesSubmitted()) {
      this.resolveNightAndContinue(game);
    }
  }

  async resolveNightAndContinue(game) {
    // Handling Fog Mode "Check Warehouse" before resolving everything
    if (game.fogMode) {
      game.players.forEach(p => {
        if (p.action === ACTIONS.CHECK_WAREHOUSE && p.isFirstMate(game.ships[p.location]?.crew.length)) {
          const ship = game.ships[p.location];
          this.bot.telegram.sendMessage(p.id, `گزارش انبار ${ship.name}:\nانگلیسی: ${ship.warehouses.ENGLISH}\nفرانسوی: ${ship.warehouses.FRENCH}`);
        }
      });
    }

    const logs = game.resolveNight();
    await this.bot.telegram.sendMessage(game.chatId, `☀️ *پایان راند ${game.round - 1}*\n\n${logs.join('\n')}`, { parse_mode: 'Markdown' });

    if (game.phase === PHASES.GAME_OVER) {
      this.endGame(game);
    } else {
      this.startDay(game);
    }
  }

  endGame(game) {
    const winners = game.getWinners();
    const scores = game.getScores();
    
    let msg = `🏁 *بازی به پایان رسید!*\n\n`;
    msg += `📊 امتیازات:\n`;
    msg += `🇬🇧 انگلیس: ${scores[TEAMS.ENGLISH]}\n`;
    msg += `🇫🇷 فرانسه: ${scores[TEAMS.FRENCH]}\n\n`;
    
    msg += `🏆 برندگان:\n`;
    if (winners.length === 0) {
      msg += `هیچ‌کس برنده نشد!`;
    } else {
      winners.forEach(w => {
        msg += `- ${w.name} (${this.getTeamName(w.team)})\n`;
      });
    }

    this.bot.telegram.sendMessage(game.chatId, msg, { parse_mode: 'Markdown' });
    
    // Clean up player mappings
    game.players.forEach((_, id) => this.playerGames.delete(id));
    this.games.delete(game.chatId);
  }

  getTeamName(team) {
    if (team === TEAMS.ENGLISH) return 'انگلیسی';
    if (team === TEAMS.FRENCH) return 'فرانسوی';
    if (team === TEAMS.DUTCH) return 'هلندی';
    if (team === TEAMS.SPANISH) return 'اسپانیایی';
    return team;
  }

  getTeamIcon(team) {
    if (team === TEAMS.ENGLISH) return '🇬🇧';
    if (team === TEAMS.FRENCH) return '🇫🇷';
    if (team === TEAMS.DUTCH) return '🇳🇱';
    if (team === TEAMS.SPANISH) return '🇪🇸';
    return '';
  }

  getActionName(action) {
    if (action === ACTIONS.PASS) return 'استراحت (Pass)';
    if (action === ACTIONS.MUTINY) return 'شورش';
    if (action === ACTIONS.CONFLICT) return 'منازعه جزیره';
    if (action === ACTIONS.CALL_FLEET) return 'خبر کردن ناوگان اسپانیا';
    if (action === ACTIONS.CHECK_WAREHOUSE) return 'بررسی انبار (معاون)';
    if (action === ACTIONS.MOVE) return 'حرکت کردن';
    if (action === ACTIONS.ATTACK) return 'دستور حمله';
    if (action === ACTIONS.EXILE) return 'اخراج خدمه';
    if (action === ACTIONS.TREASURE_MOVE) return 'جابه‌جایی گنج';
    return action;
  }

  launch() {
    this.bot.launch();
    console.log('Bot is running...');
  }
}

module.exports = TreasureIslandBot;
