const { Telegraf, Markup, session } = require('telegraf');
const TOKEN = process.env.BOT_TOKEN; // Set your bot token in .env

if (!TOKEN) {
    console.error('BOT_TOKEN not set');
    process.exit(1);
}

const bot = new Telegraf(TOKEN);

// Persian texts
const TEXTS = {
    teams: {
        EN: '🇬🇧 انگلیسی',
        FR: '🇫🇷 فرانسوی',
        NL: '🇳🇱 هلندی',
        ES: '🇪🇸 اسپانیایی'
    },
    ships: {
        FD: 'فلاینگ داچمن',
        JR: 'جالی راجر'
    },
    holds: {
        en: 'انبار انگلیسی',
        fr: 'انبار فرانسوی'
    },
    actions: {
        pass: 'عبور ⏭️',
        move_island: 'به جزیره حرکت 🚣',
        move_fd: 'به فلاینگ داچمن حرکت 🚢',
        move_jr: 'به جالی راجر حرکت 🚢',
        attack: 'دستور حمله ⚔️',
        fire: 'اخراج خدمه 🏴‍☠️',
        mutiny: 'شورش علیه ناخدا 🗡',
        swap_en_fr: 'انگلیسی → فرانسوی 📦',
        swap_fr_en: 'فرانسوی → انگلیسی 📦',
        dispute: 'منازعه ⚔️',
        call_fleet: 'خبر کردن ناوگان اسپانیا 🚢',
        check_holds: 'بررسی انبار 🔍'
    },
    announces: {
        pass: (name) => `${name} عبور کرد.`,
        move: (name, target) => `${name} به ${target} حرکت می‌کند 🚣`,
        attack: (name) => `${name} حمله اعلام کرد ⚔️`,
        fire: (name, targetName) => `${name} ${targetName} را اخراج می‌کند 🏴‍☠️`,
        mutiny: (name) => `${name} شورش علیه ناخدا اعلام کرد 🗡`,
        swap: (name, dir) => `${name} گنج را جابه‌جا می‌کند: ${dir} 📦`,
        swap_fog: (name) => `${name} گنج را جابه‌جا می‌کند 📦`,
        dispute: (name) => `${name} منازعه به‌پا کرد ⚔️`,
        call_fleet: (name) => `${name} ناوگان اسپانیا را خبر کرد 🚢`,
        check: (name) => `${name} انبار را بررسی کرد 🔍`
    },
    votes: {
        mutiny_yes: 'موافق ✅',
        mutiny_no: 'مخالف ❌',
        attack_raid: 'یورش ⚔️',
        attack_fire: 'آتش 🔥',
        attack_ext: 'خاموش 💧',
        dispute_en: '🇬🇧',
        dispute_fr: '🇫🇷'
    },
    status_prefix: '🏴‍☠️ **جزیره گنج**\n\n',
    round: (r) => `**راند ${r}**\n\n`,
    ship_header: (ship) => `${TEXTS.ships[ship]}:\n`,
    island_header: '🏝 **جزیره**:\n',
    player_rank: (rank, name) => `${rank}. ${name}\n`,
    treasures: {
        normal: (ship, en, fr) => `${TEXTS.ships[ship]}: انگلیسی ${en} | فرانسوی ${fr} (${en + fr})\n`,
        fog: (ship, total) => `${TEXTS.ships[ship]}: ${total}\n`,
        spanish: (num) => `کشتی اسپانیایی: ${num}\n`,
        island: (en, fr) => `جزیره: انگلیسی ${en} | فرانسوی ${fr}\n`
    },
    choose_hold: 'انبار مقصد گنج را انتخاب کنید:',
    initial_hold: 'گنج اولیه کشتی را در کدام انبار بگذارید:',
    dispute_already: 'منازعه قبلاً شروع شده است!',
    success: 'موفق! ✅',
    fail: 'ناموفق! ❌',
    end_title: '🏁 **پایان بازی!**',
    winners: {
        en: '🇬🇧 **انگلیسی‌ها برنده شدند!**',
        fr: '🇫🇷 **فرانسوی‌ها برنده شدند!**',
        nl: '🇳🇱 **هلندی برنده شد!**',
        es: '🇪🇸 **اسپانیایی برنده شد!**',
        tie_gov: (team) => `تساوی! **${TEXTS.teams[team]} برنده شد!** (حاکم)`
    },
    dm_team: (team) => `شما ${TEXTS.teams[team]} هستید. 🤫`,
    check_result: (en, fr) => `انبار انگلیسی: ${en}\nفرانسوی: ${fr}`,
    commands: {
        newgame: 'شروع بازی جدید (عادی)',
        newgame_fog: 'شروع بازی جدید (مه‌گرفتگی)',
        join: 'عضو شدن در بازی',
        startgame: 'شروع بازی',
        status: 'وضعیت فعلی'
    }
};

// Enums
const TEAMS = { EN: 'EN', FR: 'FR', NL: 'NL', ES: 'ES' };
const SHIPS = { FD: 'FD', JR: 'JR' };
const HOLDS = { EN: 'en', FR: 'fr' };
const VOTE_TYPES = { MUTINY: 'mutiny', ATTACK: 'attack', DISPUTE: 'dispute' };
const ACTION_TYPES = {
    PASS: 'pass',
    MOVE: 'move',
    ATTACK: 'attack',
    FIRE: 'fire',
    MUTINY: 'mutiny',
    SWAP: 'swap',
    DISPUTE: 'dispute',
    CALL_FLEET: 'call_fleet',
    CHECK: 'check'
};

class Game {
    constructor(chatId, fog = false) {
        this.chatId = chatId;
        this.fog = fog;
        this.state = 'lobby'; // lobby, initial_holds, day, night, ended
        this.players = new Set(); // user ids
        this.playerList = []; // array for shuffling
        this.playerData = new Map(); // id => {name, team}
        this.playerLoc = new Map(); // id => loc ('FD','JR','island')
        this.treasures = {
            spanish: 4,
            fd: { en: 0, fr: 0 },
            jr: { en: 0, fr: 0 },
            island: { en: 1, fr: 1 }
        };
        this.ships = { FD: [], JR: [] };
        this.island = [];
        this.expelledRound = new Map(); // id => round
        this.round = 0;
        this.phase = '';
        this.pendingDay = new Set();
        this.dayActions = new Map(); // id => {type, targetLoc?, fireTarget?, swapDir?, subchoice? (hold for attack)}
        this.disputeRecorder = null; // id who first dispute
        this.mutinyAnnounced = { FD: false, JR: false }; // if any vice announced
        this.attackAnnounced = { FD: false, JR: false };
        this.disputeAnnounced = false;
        this.callFleet = false;
        this.pendingNight = new Map(); // id => Set<vote_types>
        this.nightVotes = new Map(); // id => {mutiny?:string, attack?:, dispute?:}
        this.pendingInitial = new Set(); // ships waiting hold choice
        this.initialChoices = new Map(); // ship => 'en'|'fr'
        this.groupMessageId = null; // last status msg id for edit? but new msg each time
    }

    isSpecial(team) {
        return team === TEAMS.NL || team === TEAMS.ES;
    }

    getCaptain(ship) {
        return this.ships[ship][0];
    }

    getVice(ship) {
        return this.ships[ship][1] || null;
    }

    getPawn(ship) {
        return this.ships[ship].at(-1);
    }

    getGovernor() {
        return this.island[0];
    }

    getLocPlayers(loc) {
        if (loc === 'island') return this.island;
        return this.ships[loc];
    }

    getPlayerRank(id) {
        const loc = this.playerLoc.get(id);
        const list = this.getLocPlayers(loc);
        return list.indexOf(id) + 1;
    }

    getOldRank(id) {
        return this.getPlayerRank(id);
    }

    async sendGroup(msg, ctx) {
        const sent = await ctx.telegram.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
        // this.groupMessageId = sent.message_id; not used
    }

    async sendDM(id, text, kb = null) {
        try {
            await bot.telegram.sendMessage(id, text, kb ? { ...kb, parse_mode: 'Markdown' } : { parse_mode: 'Markdown' });
        } catch (e) {
            console.log(`DM to ${id} failed`);
        }
    }

    buildStatus() {
        let status = TEXTS.status_prefix + TEXTS.round(this.round);

        // Ships
        Object.keys(this.ships).forEach(ship => {
            status += TEXTS.ship_header(ship);
            this.ships[ship].forEach((pid, idx) => {
                const name = this.playerData.get(pid).name;
                status += TEXTS.player_rank(idx + 1, name);
            });
            status += '\n';
            const t = this.treasures[ship];
            const total = t.en + t.fr;
            if (this.fog) {
                status += TEXTS.treasures.fog(ship, total);
            } else {
                status += TEXTS.treasures.normal(ship, t.en, t.fr);
            }
        });

        // Island
        status += TEXTS.island_header;
        this.island.forEach((pid, idx) => {
            const name = this.playerData.get(pid).name;
            status += TEXTS.player_rank(idx + 1, name);
        });
        status += '\n';
        status += TEXTS.treasures.island(this.treasures.island.en, this.treasures.island.fr);

        // Spanish
        status += TEXTS.treasures.spanish(this.treasures.spanish);

        return status;
    }

    buildDayKB(playerId) {
        const loc = this.playerLoc.get(playerId);
        const rank = this.getPlayerRank(playerId);
        const kb = [];

        // Common: pass, move
        kb.push([Markup.button.callback(TEXTS.actions.pass, `game:${this.chatId}:action:${ACTION_TYPES.PASS}`)]);

        if (loc !== 'island') {
            kb.push([Markup.button.callback(TEXTS.actions.move_island, `game:${this.chatId}:action:${ACTION_TYPES.MOVE}:island`)]);
        } else {
            kb.push([Markup.button.callback(TEXTS.actions.move_fd, `game:${this.chatId}:action:${ACTION_TYPES.MOVE}:${SHIPS.FD}`)]);
            kb.push([Markup.button.callback(TEXTS.actions.move_jr, `game:${this.chatId}:action:${ACTION_TYPES.MOVE}:${SHIPS.JR}`)]);
        }

        // Ship roles
        if (loc !== 'island') {
            const ship = loc;
            const captainId = this.getCaptain(ship);
            const viceId = this.getVice(ship);
            const pawnId = this.getPawn(ship);

            if (playerId === captainId) {
                // Attack or Fire
                const fireBtns = [];
                this.ships[ship].slice(1).forEach(pid => { // excl self
                    const name = this.playerData.get(pid).name;
                    fireBtns.push(Markup.button.callback(`${TEXTS.actions.fire} ${name}`, `game:${this.chatId}:action:${ACTION_TYPES.FIRE}:${pid}`));
                });
                if (fireBtns.length > 0) {
                    kb.push(fireBtns.slice(0, 3)); // max 3 row?
                    if (fireBtns.length > 3) kb.push(fireBtns.slice(3, 6));
                }
                kb.push([Markup.button.callback(TEXTS.actions.attack, `game:${this.chatId}:action:${ACTION_TYPES.ATTACK}`)]);

            } else if (playerId === viceId) {
                kb.push([Markup.button.callback(TEXTS.actions.mutiny, `game:${this.chatId}:action:${ACTION_TYPES.MUTINY}`)]);
                if (this.fog) {
                    kb.push([Markup.button.callback(TEXTS.actions.check_holds, `game:${this.chatId}:action:${ACTION_TYPES.CHECK}`)]);
                }
            } else if (playerId === pawnId) {
                // Swap
                kb.push([Markup.button.callback(TEXTS.actions.swap_en_fr, `game:${this.chatId}:action:${ACTION_TYPES.SWAP}:en_fr`)]);
                kb.push([Markup.button.callback(TEXTS.actions.swap_fr_en, `game:${this.chatId}:action:${ACTION_TYPES.SWAP}:fr_en`)]);
            }
        } else {
            // Island
            if (!this.disputeAnnounced) {
                kb.push([Markup.button.callback(TEXTS.actions.dispute, `game:${this.chatId}:action:${ACTION_TYPES.DISPUTE}`)]);
            }
            const govId = this.getGovernor();
            if (playerId === govId && this.round >= 6 && !this.callFleet) {
                kb.push([Markup.button.callback(TEXTS.actions.call_fleet, `game:${this.chatId}:action:${ACTION_TYPES.CALL_FLEET}`)]);
            }
        }

        return Markup.inlineKeyboard(kb);
    }

    async startDay(ctx) {
        this.phase = 'day';
        this.pendingDay = new Set(this.playerList);
        this.dayActions.clear();
        this.disputeRecorder = null;
        this.disputeAnnounced = false;
        this.mutinyAnnounced = { FD: false, JR: false };
        this.attackAnnounced = { FD: false, JR: false };

        const status = this.buildStatus();
        await this.sendGroup(status, ctx);

        // Send KB to each player DM
        for (const pid of this.playerList) {
            await this.sendDM(pid, 'اقدام روزانه خود را انتخاب کنید:', this.buildDayKB(pid));
        }
    }

    async handleDayAction(playerId, type, target = null, dir = null) {
        if (!this.pendingDay.has(playerId)) return;
        this.pendingDay.delete(playerId);

        let action = { type };
        if (type === ACTION_TYPES.MOVE) action.targetLoc = target;
        else if (type === ACTION_TYPES.FIRE) action.fireTarget = target;
        else if (type === ACTION_TYPES.SWAP) action.swapDir = dir; // en_fr or fr_en
        this.dayActions.set(playerId, action);

        // Announce
        const name = this.playerData.get(playerId).name;
        let announce = '';
        switch (type) {
            case ACTION_TYPES.PASS:
                announce = TEXTS.announces.pass(name);
                break;
            case ACTION_TYPES.MOVE:
                announce = TEXTS.announces.move(name, TEXTS.ships[target] || 'جزیره');
                break;
            case ACTION_TYPES.ATTACK:
                const ship = this.playerLoc.get(playerId);
                this.attackAnnounced[ship] = true;
                announce = TEXTS.announces.attack(name);
                // Send subchoice hold
                await this.sendDM(playerId, TEXTS.choose_hold, Markup.inlineKeyboard([
                    [Markup.button.callback(TEXTS.holds.en, `game:${this.chatId}:hold:${HOLDS.EN}`)],
                    [Markup.button.callback(TEXTS.holds.fr, `game:${this.chatId}:hold:${HOLDS.FR}`)]
                ]));
                break;
            case ACTION_TYPES.FIRE:
                const tname = this.playerData.get(target).name;
                announce = TEXTS.announces.fire(name, tname);
                break;
            case ACTION_TYPES.MUTINY:
                const mship = this.playerLoc.get(playerId);
                this.mutinyAnnounced[mship] = true;
                announce = TEXTS.announces.mutiny(name);
                break;
            case ACTION_TYPES.SWAP:
                const sdir = dir === 'en_fr' ? TEXTS.holds.en + ' → ' + TEXTS.holds.fr : TEXTS.holds.fr + ' → ' + TEXTS.holds.en;
                announce = this.fog ? TEXTS.announces.swap_fog(name) : TEXTS.announces.swap(name, sdir);
                break;
            case ACTION_TYPES.DISPUTE:
                if (this.disputeAnnounced) {
                    await this.sendDM(playerId, TEXTS.dispute_already);
                    this.pendingDay.add(playerId); // revert
                    return;
                }
                this.disputeAnnounced = true;
                this.disputeRecorder = playerId;
                announce = TEXTS.announces.dispute(name);
                break;
            case ACTION_TYPES.CALL_FLEET:
                this.callFleet = true;
                announce = TEXTS.announces.call_fleet(name);
                break;
            case ACTION_TYPES.CHECK:
                announce = TEXTS.announces.check(name);
                const shipc = this.playerLoc.get(playerId);
                const tc = this.treasures[shipc];
                await this.sendDM(playerId, TEXTS.check_result(tc.en, tc.fr), null);
                break;
        }
        if (announce) await this.sendGroup(announce, { telegram: bot.telegram });

        if (this.pendingDay.size === 0) {
            await this.resolveDay();
        }
    }

    async setHold(playerId, hold) {
        const ship = this.playerLoc.get(playerId);
        if (this.getCaptain(ship) !== playerId) return;
        this.initialChoices.set(ship, hold);
        this.pendingInitial.delete(ship);
        if (this.pendingInitial.size === 0) {
            // Place initial
            for (const [s, h] of this.initialChoices) {
                this.treasures[s][h]++;
            }
            await this.startDay({ telegram: bot.telegram });
        }
    }

    async resolveDay() {
        // 1. Moves
        const movers = new Map(); // targetLoc => [ {id, oldRank} ]
        for (const [pid, act] of this.dayActions) {
            if (act.type === ACTION_TYPES.MOVE) {
                const oldLoc = this.playerLoc.get(pid);
                const oldR = this.getOldRank(pid);
                if (!movers.has(act.targetLoc)) movers.set(act.targetLoc, []);
                movers.get(act.targetLoc).push({ id: pid, oldRank: oldR });
                // Check expel restrict
                const lastExp = this.expelledRound.get(pid) || 0;
                if (oldLoc === 'island' && this.round - lastExp <= 1) {
                    // Cannot move, revert to pass?
                    continue;
                }
            }
        }

        // Process moves per loc
        ['FD', 'JR', 'island'].forEach(tloc => {
            const entrants = movers.get(tloc) || [];
            if (entrants.length === 0) return;

            // Sort entrants by oldRank asc, then id asc
            entrants.sort((a, b) => a.oldRank - b.oldRank || a.id - b.id);

            // Stayers: current minus movers out
            let stayers;
            if (tloc === 'island') {
                stayers = this.island.filter(p => !movers.has(this.playerLoc.get(p)));
            } else {
                stayers = this.ships[tloc].filter(p => !movers.has(this.playerLoc.get(p)));
            }

            // New list
            const newList = [...stayers, ...entrants.map(e => e.id)];

            // Set
            if (tloc === 'island') {
                this.island = newList;
            } else {
                this.ships[tloc] = newList;
            }

            // Update playerLoc
            newList.forEach(pid => this.playerLoc.set(pid, tloc));
        });

        // Update all playerLoc for stayers implicitly done.

        // 2. Pawn swaps
        Object.keys(this.ships).forEach(ship => {
            const pawnId = this.getPawn(ship);
            if (!pawnId) return;
            const act = this.dayActions.get(pawnId);
            if (act?.type === ACTION_TYPES.SWAP) {
                const sourceHold = act.swapDir === 'en_fr' ? 'en' : 'fr';
                const targetHold = act.swapDir === 'en_fr' ? 'fr' : 'en';
                const t = this.treasures[ship];
                if (t[sourceHold] > 0) {
                    t[sourceHold]--;
                    t[targetHold]++;
                }
            }
        });

        // Now night phase if any votes
        await this.startNight();
    }

    async startNight() {
        this.phase = 'night';
        this.pendingNight.clear();
        this.nightVotes.clear();

        const voters = new Map(); // voteType => Set<players eligible>
        voters.set(VOTE_TYPES.MUTINY, new Set());
        voters.set(VOTE_TYPES.ATTACK, new Set());
        voters.set(VOTE_TYPES.DISPUTE, new Set());

        // Mutiny
        Object.keys(this.ships).forEach(ship => {
            if (this.mutinyAnnounced[ship]) {
                const crew = this.ships[ship].slice(1); // excl captain
                crew.forEach(pid => voters.get(VOTE_TYPES.MUTINY).add(pid));
            }
        });

        // Attack
        Object.keys(this.ships).forEach(ship => {
            if (this.attackAnnounced[ship] && this.ships[ship].length >= 2) {
                this.ships[ship].forEach(pid => voters.get(VOTE_TYPES.ATTACK).add(pid));
            }
        });

        // Dispute
        if (this.disputeAnnounced && this.island.length > 0) {
            this.island.forEach(pid => voters.get(VOTE_TYPES.DISPUTE).add(pid));
        }

        // Send KBs
        for (const pid of this.playerList) {
            const reqVotes = new Set();
            for (const [vtype, vset] of voters) {
                if (vset.has(pid)) {
                    reqVotes.add(vtype);
                    // Send KB for this vote
                    let kb;
                    switch (vtype) {
                        case VOTE_TYPES.MUTINY:
                            kb = Markup.inlineKeyboard([
                                [Markup.button.callback(TEXTS.votes.mutiny_yes, `game:${this.chatId}:vote:${VOTE_TYPES.MUTINY}:yes`)],
                                [Markup.button.callback(TEXTS.votes.mutiny_no, `game:${this.chatId}:vote:${VOTE_TYPES.MUTINY}:no`)]
                            ]);
                            break;
                        case VOTE_TYPES.ATTACK:
                            kb = Markup.inlineKeyboard([
                                [Markup.button.callback(TEXTS.votes.attack_raid, `game:${this.chatId}:vote:${VOTE_TYPES.ATTACK}:raid`)],
                                [Markup.button.callback(TEXTS.votes.attack_fire, `game:${this.chatId}:vote:${VOTE_TYPES.ATTACK}:fire`)],
                                [Markup.button.callback(TEXTS.votes.attack_ext, `game:${this.chatId}:vote:${VOTE_TYPES.ATTACK}:ext`)]
                            ]);
                            break;
                        case VOTE_TYPES.DISPUTE:
                            kb = Markup.inlineKeyboard([
                                [Markup.button.callback(TEXTS.votes.dispute_en, `game:${this.chatId}:vote:${VOTE_TYPES.DISPUTE}:en`)],
                                [Markup.button.callback(TEXTS.votes.dispute_fr, `game:${this.chatId}:vote:${VOTE_TYPES.DISPUTE}:fr`)]
                            ]);
                            break;
                    }
                    const vtext = vtype === VOTE_TYPES.MUTINY ? 'رأی شورش' :
                        vtype === VOTE_TYPES.ATTACK ? 'رأی حمله' : 'رأی منازعه';
                    await this.sendDM(pid, `**${vtext}:**`, { reply_markup: kb });
                }
            }
            if (reqVotes.size > 0) {
                this.pendingNight.set(pid, reqVotes);
            }
        }

        // If no votes, skip to next round
        if (this.pendingNight.size === 0) {
            await this.resolveNight();
            return;
        }

        // Announce night events if any
        let nightMsg = '🌙 **فاز شب**\n';
        if (Object.values(this.mutinyAnnounced).some(b => b)) nightMsg += 'شورش در یکی از کشتی‌ها\n';
        if (Object.values(this.attackAnnounced).some(b => b)) nightMsg += 'رأی‌گیری حمله\n';
        if (this.disputeAnnounced) nightMsg += 'منازعه در جزیره\n';
        await this.sendGroup(nightMsg, { telegram: bot.telegram });
    }

    async handleNightVote(playerId, vtype, choice) {
        if (!this.pendingNight.has(playerId)) return;
        const pending = this.pendingNight.get(playerId);
        if (!pending.has(vtype)) return;

        const votes = this.nightVotes.get(playerId) || {};
        votes[vtype] = choice;
        this.nightVotes.set(playerId, votes);

        pending.delete(vtype);
        if (pending.size === 0) {
            this.pendingNight.delete(playerId);
        }

        if (this.pendingNight.size === 0) {
            await this.resolveNight();
        }
    }

    async resolveNight() {
        // 3. Mutiny
        let nightMessage = '🌞 **نتایج فاز شب:**\n';
        Object.keys(this.ships).forEach(ship => {
            if (!this.mutinyAnnounced[ship]) return;
            const crew = this.ships[ship].slice(1); // excl capt
            let yes = 0, no = 0;
            for (const pid of crew) {
                const v = this.nightVotes.get(pid)?.mutiny;
                if (v === 'yes') yes++;
                else if (v === 'no') no++;
            }
            let msg = '';
            if (yes > no) {
                // Success, expel captain
                const oldCapt = this.ships[ship].shift();
                this.island.push(oldCapt);
                this.playerLoc.set(oldCapt, 'island');
                this.expelledRound.set(oldCapt, this.round);
                msg = `شورش در ${TEXTS.ships[ship]} ${TEXTS.success} (${yes}-${no})`;
            } else {
                msg = `شورش در ${TEXTS.ships[ship]} ${TEXTS.fail} (${yes}-${no})`;
            }
            nightMessage += msg + '\n';
        });

        // 4. Attack / Fire (after mutiny, captains may changed)
        Object.keys(this.ships).forEach(ship => {
            if (!this.attackAnnounced[ship]) return;
            const captId = this.getCaptain(ship);
            const act = this.dayActions.get(captId);
            if (!act || act.type !== ACTION_TYPES.ATTACK) return; // should be

            const holdChoice = act.subchoice; // en or fr set earlier
            if (!holdChoice) return;

            // Tally
            let raid = 0, fire = 0, ext = 0;
            this.ships[ship].forEach(pid => {
                const v = this.nightVotes.get(pid)?.attack;
                if (v === 'raid') raid++;
                else if (v === 'fire') fire++;
                else if (v === 'ext') ext++;
            });

            let msg = '';
            if (raid === 1 && fire >= 1 && ext <= 1) {
                // Success
                let stolen = false;
                if (this.treasures.spanish > 0) {
                    this.treasures.spanish--;
                    stolen = true;
                } else {
                    // Attack other ship
                    const targetShip = ship === 'FD' ? 'JR' : 'FD';
                    const ttarget = this.treasures[targetShip];
                    const captTeam = this.playerData.get(captId).team;
                    let sourceH = null;
                    if (captTeam === TEAMS.EN) sourceH = 'fr';
                    else if (captTeam === TEAMS.FR) sourceH = 'en';
                    else { // special
                        sourceH = ttarget.en > 0 ? 'en' : 'fr';
                    }
                    if (ttarget[sourceH] > 0) {
                        ttarget[sourceH]--;
                        stolen = true;
                    } else if (ttarget[sourceH === 'en' ? 'fr' : 'en'] > 0) {
                        const alt = sourceH === 'en' ? 'fr' : 'en';
                        ttarget[alt]--;
                        stolen = true;
                    }
                }
                if (stolen) {
                    this.treasures[ship][holdChoice]++;
                }
                msg = `حمله ${TEXTS.ships[ship]} ${TEXTS.success} (${raid} یورش, ${fire} آتش, ${ext} خاموش)`;
            } else {
                msg = `حمله ${TEXTS.ships[ship]} ${TEXTS.fail} (${raid} یورش, ${fire} آتش, ${ext} خاموش)`;
            }
            nightMessage += msg + '\n';

            // Fire if captain chose fire instead? Wait, fire is separate action.
            // Captain action is either attack or fire, but in kb separate.
            // Rules: captain announces attack or fire.
            // In code, if fire, no vote, direct expel at day end? No.
            // Wait, resolve order: fire is part of captain action priority 4, after mutiny.
            // But fire no vote, direct.
            // In my code, I have attack vote in night.
            // For fire: if captain action fire, after mutiny, expel the target.
            // Yes, I missed fire resolve.

            // Add fire resolve here, after mutiny.
            if (act.type === ACTION_TYPES.FIRE) {
                const targetId = act.fireTarget;
                if (this.ships[ship].includes(targetId)) { // still crew?
                    // Remove target, shift ranks
                    const idx = this.ships[ship].indexOf(targetId);
                    this.ships[ship].splice(idx, 1);
                    this.island.push(targetId);
                    this.playerLoc.set(targetId, 'island');
                    this.expelledRound.set(targetId, this.round);
                    // await this.sendGroup(`${TEXTS.ships[ship]}: ${this.playerData.get(targetId).name} اخراج شد.`, { telegram: bot.telegram });
                    nightMessage += `${TEXTS.ships[ship]}: ${this.playerData.get(targetId).name} اخراج شد.\n`;
                }
            }
        });

        // 5. Dispute
        if (this.disputeAnnounced) {
            let enV = 0, frV = 0;
            this.island.forEach(pid => {
                const v = this.nightVotes.get(pid)?.dispute;
                if (v === 'en') enV++;
                else if (v === 'fr') frV++;
            });
            let winner = enV > frV ? 'en' : frV > enV ? 'fr' : 'tie';
            let msg = `منازعه جزیره: `;
            if (winner !== 'tie') {
                this.treasures.island[winner] = 2;
                this.treasures.island[winner === 'en' ? 'fr' : 'en'] = 0;
                msg += `${TEXTS.teams[winner === 'en' ? TEAMS.EN : TEAMS.FR]} ${TEXTS.success} (${enV}-${frV})`;
            } else {
                this.treasures.island.en = 1;
                this.treasures.island.fr = 1;
                msg += `مساوی (${enV}-${frV})`;
            }
            nightMessage += msg + '\n';

            // Depose gov?
            const govId = this.getGovernor();
            const govTeam = this.playerData.get(govId).team;
            const govVote = this.nightVotes.get(govId)?.dispute;
            let badVote = (winner === 'tie') || (govVote !== winner);
            let depose = false;
            if (!this.fog && this.isSpecial(govTeam)) {
                depose = true;
            } else if (badVote) {
                depose = true;
            }
            if (depose) {
                // Move to end
                this.island.splice(0, 1);
                this.island.push(govId);
                nightMessage += 'حاکم عزل شد و به انتها رفت!\n';
            }
        }
        await this.sendGroup(nightMessage, { telegram: bot.telegram });
        // 6. Call fleet
        if (this.callFleet) {
            await this.endGame({ telegram: bot.telegram });
            return;
        }

        // Next round
        this.round++;
        if (this.round > 10) {
            await this.endGame({ telegram: bot.telegram });
        } else {
            await this.startDay({ telegram: bot.telegram });
        }
    }

    async endGame(ctx) {
        this.state = 'ended';
        this.phase = 'end';

        const enScore = this.treasures.island.en + this.treasures.fd.en + this.treasures.jr.en;
        const frScore = this.treasures.island.fr + this.treasures.fd.fr + this.treasures.jr.fr;

        let winners = [];
        if (enScore > frScore) {
            winners.push(TEAMS.EN);
        } else if (frScore > enScore) {
            winners.push(TEAMS.FR);
        } else {
            // Tie, gov team
            const govTeam = this.playerData.get(this.getGovernor())?.team;
            if (govTeam === TEAMS.NL || govTeam === TEAMS.ES) {
                winners.push(govTeam);
            } else {
                winners.push(govTeam);
            }
        }

        // NL check
        const fdTotal = this.treasures.fd.en + this.treasures.fd.fr;
        const jrTotal = this.treasures.jr.en + this.treasures.jr.fr;
        let maxShip = fdTotal > jrTotal ? 'FD' : jrTotal > fdTotal ? 'JR' : null;
        if (maxShip) {
            const nlCapt = this.getCaptain(maxShip);
            if (this.playerData.get(nlCapt)?.team === TEAMS.NL) {
                winners.push(TEAMS.NL);
            }
        }

        // ES check
        if (this.treasures.spanish >= 2) {
            winners.push(TEAMS.ES);
        }

        // Unique winners
        winners = [...new Set(winners)];

        let endMsg = TEXTS.end_title + '\n\n';
        endMsg += `انگلیسی: ${enScore} | فرانسوی: ${frScore}\n\n`;
        winners.forEach(w => {
            endMsg += TEXTS.winners[w === TEAMS.NL || w === TEAMS.ES ? w : (w === TEAMS.EN ? 'en' : 'fr')] + '\n';
        });

        await this.sendGroup(endMsg, ctx);
    }

    async assignTeamsAndShips() {
        const n = this.players.size;
        if (n < 4 || n > 10) throw new Error('Invalid player count');

        let numEN, numFR, specials = [];
        if (n % 2 === 0) {
            numEN = numFR = n / 2;
            if (Math.random() < 0.5) {
                numEN--;
                numFR--;
                specials = [TEAMS.NL, TEAMS.ES];
            }
        } else {
            const base = Math.floor((n - 1) / 2);
            numEN = numFR = base;
            specials = [Math.random() < 0.5 ? TEAMS.NL : TEAMS.ES];
        }

        // Assign
        const assignments = [];
        for (let i = 0; i < numEN; i++) assignments.push(TEAMS.EN);
        for (let i = 0; i < numFR; i++) assignments.push(TEAMS.FR);
        specials.forEach(s => assignments.push(s));
        // Shuffle
        for (let i = assignments.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
        }

        this.playerList = Array.from(this.players);
        this.playerList.forEach((pid, idx) => {
            const team = assignments[idx];
            this.playerData.set(pid, { name: this.playerData.get(pid).name, team });
            this.sendDM(pid, TEXTS.dm_team(team));
        });

        // Ships random balance
        const shuffled = [...this.playerList].sort(() => Math.random() - 0.5);
        const fdPlayers = shuffled.slice(0, Math.ceil(n / 2));
        const jrPlayers = shuffled.slice(Math.ceil(n / 2));

        // Shuffle orders
        fdPlayers.sort(() => Math.random() - 0.5);
        jrPlayers.sort(() => Math.random() - 0.5);

        this.ships.FD = fdPlayers;
        this.ships.JR = jrPlayers;
        fdPlayers.forEach(p => this.playerLoc.set(p, 'FD'));
        jrPlayers.forEach(p => this.playerLoc.set(p, 'JR'));

        // Island empty

        // Initial holds
        this.pendingInitial.clear();
        this.initialChoices.clear();
        ['FD', 'JR'].forEach(ship => {
            if (this.ships[ship].length > 0) {
                this.pendingInitial.add(ship);
                const capt = this.ships[ship][0];
                this.sendDM(capt, TEXTS.initial_hold, Markup.inlineKeyboard([
                    [Markup.button.callback(TEXTS.holds.en, `game:${this.chatId}:initial:${HOLDS.EN}`)],
                    [Markup.button.callback(TEXTS.holds.fr, `game:${this.chatId}:initial:${HOLDS.FR}`)]
                ]));
            }
        });

        this.state = 'initial_holds';
    }
}

// Games map
const games = new Map(); // chatId => Game

// Middleware to parse callback
bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        if (data.startsWith('game:')) {
            const parts = data.split(':');
            const gChatId = parseInt(parts[1]);
            const game = games.get(gChatId);
            if (!game) return;
            ctx.game = game;
            ctx.playerId = ctx.from.id;
            await next();
            return;
        }
    }
    await next();
});

// Commands in group
bot.command('newgame', async (ctx) => {
    const chatId = ctx.chat.id;
    if (games.has(chatId)) {
        return ctx.reply('بازی در حال انجام است!');
    }
    games.set(chatId, new Game(chatId, false));
    ctx.reply(TEXTS.commands.newgame);
});

bot.command('newgame_fog', async (ctx) => {
    const chatId = ctx.chat.id;
    if (games.has(chatId)) {
        return ctx.reply('بازی در حال انجام است!');
    }
    games.set(chatId, new Game(chatId, true));
    ctx.reply(TEXTS.commands.newgame_fog);
});

bot.command('join', async (ctx) => {
    const chatId = ctx.chat.id;
    const game = games.get(chatId);
    if (!game || game.state !== 'lobby') {
        return ctx.reply('بازی در لابی نیست!');
    }
    const uid = ctx.from.id;
    const name = ctx.from.first_name || ctx.from.username || 'ناشناس';
    if (game.players.has(uid)) {
        return ctx.reply('شما عضو هستید!');
    }
    game.players.add(uid);
    game.playerData.set(uid, { name, team: null });
    ctx.reply(`خوش آمدید ${name}! (${game.players.size}/10)`);
});

bot.command('startgame', async (ctx) => {
    const chatId = ctx.chat.id;
    const game = games.get(chatId);
    if (!game || game.state !== 'lobby') {
        return ctx.reply('لابی آماده نیست!');
    }
    const uid = ctx.from.id;
    if (!game.players.has(uid)) {
        return ctx.reply('ابتدا /join کنید!');
    }
    try {
        await game.assignTeamsAndShips();
        await game.sendGroup(`بازی شروع شد! ${game.players.size} بازیکن. ${game.fog ? 'مه‌گرفتگی فعال' : ''}`, ctx);
    } catch (e) {
        ctx.reply('خطا در شروع: ' + e.message);
    }
});

bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const game = games.get(chatId);
    if (!game) return;
    const status = game.buildStatus();
    await ctx.reply(status);
});

// Callback handler
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    if (parts[0] !== 'game') return;

    const gChatId = parseInt(parts[1]);
    const game = games.get(gChatId);
    if (!game) return ctx.answerCbQuery('بازی یافت نشد');

    const playerId = ctx.from.id;
    if (!game.playerList.includes(playerId)) return ctx.answerCbQuery('شما در بازی نیستید');

    const cmd = parts[2];
    if (cmd === 'action') {
        const type = parts[3];
        const arg1 = parts[4] || null;
        const arg2 = parts[5] || null;
        await game.handleDayAction(playerId, type, arg1, arg2);
        await ctx.answerCbQuery(TEXTS.success);
    } else if (cmd === 'hold') {
        const hold = parts[3];
        const act = game.dayActions.get(playerId);
        if (act) {
            act.subchoice = hold;
            game.dayActions.set(playerId, act);
        }
        await ctx.answerCbQuery('ثبت شد');
    } else if (cmd === 'initial') {
        const hold = parts[3];
        await game.setHold(playerId, hold);
        await ctx.answerCbQuery('ثبت شد');
    } else if (cmd === 'vote') {
        const vtype = parts[3];
        const choice = parts[4];
        await game.handleNightVote(playerId, vtype, choice);
        await ctx.answerCbQuery('رأی ثبت شد');
    }
    ctx.answerCbQuery();
});

// Handle any text? Not needed, only callbacks for actions.

bot.launch();
console.log('Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));