const REGULAR_BOX_POOL = [
  ...Array(3).fill('boat'), ...Array(3).fill('pistol'),
  ...Array(3).fill('blackspot'), ...Array(3).fill('albatross'),
  'atlantis', 'eldorado', 'clover',
];
const SPECIAL_BOX_POOL = [
  'blackpowder', 'shipfever', 'crowsnest', 'eightbells',
  'mask', 'piratecode', 'scurvy', 'stormysea',
];

class GameState {
  constructor(chatId) {
    this.chatId = chatId;
    this.phase = 'lobby'; // lobby | setup | day | night | ended
    this.round = 0;
    this.players = new Map(); // userId -> { id, name, team, location, expelledFrom: [] }
    this.lobbyPlayers = []; // [{ id, name }] before game starts
    this.mistMode = false; // Mist mode: hidden treasure breakdown
    this.locations = {
      flyingDutchman: { crew: [], holds: { english: 0, french: 0 } },
      jollyRoger: { crew: [], holds: { english: 0, french: 0 } },
      island: { residents: [], treasures: { english: 1, french: 1 } },
      spanishShip: { treasures: 4 },
    };
    this.pendingEvents = []; // [{ type, ship?, initiator?, target? }]
    this.votes = new Map(); // eventIndex -> Map<userId, vote>
    this.expectedVoters = new Map(); // eventIndex -> Set<userId>
    this.usedAction = new Set();
    this.passedAction = new Set();
    this.armadaCalled = false;
    this.disputeThisRound = false;
    this.setupPending = new Set(); // captains who still need to place initial treasure
    this.successfulAttackShips = new Set(); // ships that had successful attacks this round and the previous round

    // Box mode
    this.boxMode = false;
    this.boxes = [];             // [{content: string|null, peekedBy: Set}] x5
    this.boxPool = [];           // remaining items for refill
    this.specialBoxItems = [];   // 3 specials chosen for this game
    this.usedExtraAction = new Set();
    this.heldItems = new Map();  // userId -> [{type, used}]
    this.pendingBoxEffect = null; // {type, targetId, gifterId?, step, data}
    this.scurvyNextRound = new Set();
    this.scurvyActive = new Set();
    this.pirateCodeVotes = new Map(); // userId -> remaining votes to skip
    this.blackPowderShips = new Set();
  }

  addLobbyPlayer(id, name) {
    if (this.lobbyPlayers.find((p) => p.id === id)) return false;
    this.lobbyPlayers.push({ id, name });
    return true;
  }
  removeLobbyPlayer(id) {
    this.lobbyPlayers = this.lobbyPlayers.filter((p) => p.id !== id);
  }
  startGame() {
    const players = [...this.lobbyPlayers];
    shuffle(players);

    // Assign teams
    const half = Math.floor(players.length / 2);
    const isOdd = players.length % 2 !== 0;
    const teams = [];
    for (let i = 0; i < half; i++) teams.push('english');
    for (let i = 0; i < half; i++) teams.push('french');

    // Odd number: exactly one Dutch or Spanish
    // Even number: both Dutch and Spanish, or neither (50% chance each)
    if (isOdd) {
      teams.push(Math.random() < 0.5 ? 'dutch' : 'spanish');
    } else {
      if (Math.random() < 0.5) {
        teams.push('dutch');
        teams.push('spanish');
        // Remove one English and one French
        teams.splice(teams.indexOf('english'), 1);
        teams.splice(teams.indexOf('french'), 1);
      }
      // else: no dutch or spanish, all english/french
    }
    shuffle(teams);

    for (let i = 0; i < players.length; i++) {
      this.players.set(players[i].id, {
        id: players[i].id,
        name: players[i].name,
        team: teams[i],
        location: null,
        expelledRound: null, // Round number when expelled (blocks all ships for current + previous round)
      });
    }

    // Distribute players across the two ships
    shuffle(players);
    const fdMax = Math.min(5, Math.ceil(players.length / 2));
    for (let i = 0; i < players.length; i++) {
      const ship = i < fdMax ? 'flyingDutchman' : 'jollyRoger';
      this.locations[ship].crew.push(players[i].id);
      this.players.get(players[i].id).location = ship;
    }

    this.phase = 'setup';
    this.round = 1;

    // Identify captains for initial treasure placement
    const fdCaptain = this.locations.flyingDutchman.crew[0];
    const jrCaptain = this.locations.jollyRoger.crew[0];
    if (fdCaptain) this.setupPending.add(fdCaptain);
    if (jrCaptain) this.setupPending.add(jrCaptain);

    if (this.boxMode) this.initializeBoxes();

    return { fdCaptain, jrCaptain };
  }

  placeInitialTreasure(captainId, hold) {
    const p = this.players.get(captainId);
    if (!p || !this.setupPending.has(captainId)) return false;
    const ship = p.location;
    this.locations[ship].holds[hold] = 1;
    this.setupPending.delete(captainId);
    return { ship, hold };
  }

  isSetupComplete() {
    return this.setupPending.size === 0;
  }

  startDay() {
    this.phase = 'day';
    this.usedAction.clear();
    this.passedAction.clear();
    this.pendingEvents = [];
    this.votes.clear();
    this.expectedVoters.clear();
    this.disputeThisRound = false;

    if (this.boxMode) {
      this.usedExtraAction.clear();
      this.pendingBoxEffect = null;
      this.scurvyActive = new Set(this.scurvyNextRound);
      this.scurvyNextRound.clear();
    }
  }

  markAction(userId) {
    this.usedAction.add(userId);
    this.passedAction.delete(userId);
  }

  passAction(userId) {
    this.passedAction.add(userId);
  }

  allPlayersDone() {
    for (const [id] of this.players) {
      if (!this.usedAction.has(id) && !this.passedAction.has(id)) return false;
    }
    return true;
  }

  getPlayerShip(userId) {
    const p = this.players.get(userId);
    if (!p) return null;
    if (p.location === 'flyingDutchman' || p.location === 'jollyRoger') return p.location;
    return null;
  }

  isCaptain(userId) {
    const ship = this.getPlayerShip(userId);
    if (!ship) return false;
    return this.locations[ship].crew[0] === userId;
  }

  isFirstMate(userId) {
    const ship = this.getPlayerShip(userId);
    if (!ship) return false;
    const crew = this.locations[ship].crew;
    if (crew.length < 2) return false;
    return crew[1] === userId;
  }

  isCabinBoy(userId) {
    const ship = this.getPlayerShip(userId);
    if (!ship) return false;
    const crew = this.locations[ship].crew;
    return crew[crew.length - 1] === userId;
  }

  isOnIsland(userId) {
    const p = this.players.get(userId);
    return p && p.location === 'island';
  }

  isGovernor(userId) {
    const residents = this.locations.island.residents;
    return residents.length > 0 && residents[0] === userId;
  }

  canMoveTo(userId, destination) {
    const p = this.players.get(userId);
    if (!p) return false;

    // Expelled players cannot move to ANY ship for current + previous round
    if ((destination === 'flyingDutchman' || destination === 'jollyRoger') &&
        p.expelledRound !== null &&
        (this.round - p.expelledRound) <= 1) {
      return false;
    }

    return true;
  }

  disembark(userId, destination) {
    if (destination === 'flyingDutchman' || destination === 'jollyRoger') {
      if (this.locations[destination].crew.length >= 5) return false;
      this.removeFromLocation(userId);
      this.locations[destination].crew.push(userId);
      this.players.get(userId).location = destination;
      return true;
    }
    if (destination === 'island') {
      this.removeFromLocation(userId);
      this.locations.island.residents.push(userId);
      this.players.get(userId).location = 'island';
      return true;
    }
    return false;
  }

  removeFromLocation(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    const loc = p.location;
    let prevRanking = null;
    if (loc === 'flyingDutchman' || loc === 'jollyRoger') {
      prevRanking = this.locations[loc].crew.indexOf(userId);
      this.locations[loc].crew = this.locations[loc].crew.filter((id) => id !== userId);
    } else if (loc === 'island') {
      prevRanking = this.locations.island.residents.indexOf(userId);
      this.locations.island.residents = this.locations.island.residents.filter((id) => id !== userId);
    }
    return prevRanking;
  }

  sendToIsland(userId, expelled = false) {
    const p = this.players.get(userId);
    this.removeFromLocation(userId);
    this.locations.island.residents.push(userId);
    p.location = 'island';

    // Track expulsion round to block all ships for current + previous round
    if (expelled) {
      p.expelledRound = this.round;
    }
  }

  addPendingEvent(event) {
    this.pendingEvents.push(event);
  }

  startNight() {
    this.phase = 'night';

    this.successfulAttackShips.clear(); // Reset attack tracking for the new night
    // Pending joins are now resolved in resolveDayEndActions (votes.js) before night starts

    // Set up voters for each pending event
    // Note: dispute voters are set up later (after mutiny/maroon resolve) in setupDisputePhase
    for (let i = 0; i < this.pendingEvents.length; i++) {
      const ev = this.pendingEvents[i];
      const voters = new Set();

      if (ev.autoResolved || ev.cancelled) {
        // Skip — already resolved or cancelled, empty voters = immediately complete
      } else if (ev.type === 'attack') {
        const crew = this.locations[ev.ship].crew;
        if (crew.length < 2) {
          ev.cancelled = true;
        } else {
          for (const id of crew) voters.add(id);
        }
      } else if (ev.type === 'mutiny') {
        const crew = this.locations[ev.ship].crew;
        if (crew.length === 0 || crew.length < 2) {
          ev.cancelled = true;
        } else {
          const captain = crew[0];
          const nonCaptainCrew = crew.filter(id => id !== captain);
          if (nonCaptainCrew.length < 2) {
            ev.cancelled = true;
          } else {
            for (const id of nonCaptainCrew) voters.add(id);
          }
        }
      } else if (ev.type === 'dispute') {
        // Deferred: voters determined after mutiny/maroon resolve so expelled players can vote
      }
      // 'maroon' type has no voting — resolved during night
      this.expectedVoters.set(i, voters);
      this.votes.set(i, new Map());
    }
  }

  recordVote(eventIndex, userId, vote) {
    const expected = this.expectedVoters.get(eventIndex);
    if (!expected || !expected.has(userId)) return false;
    const voteMap = this.votes.get(eventIndex);
    if (voteMap.has(userId)) return false;

    if (this.boxMode && this.pirateCodeVotes.has(userId)) {
      voteMap.set(userId, { vote, nullified: true });
      const remaining = this.pirateCodeVotes.get(userId) - 1;
      if (remaining <= 0) this.pirateCodeVotes.delete(userId);
      else this.pirateCodeVotes.set(userId, remaining);
    } else if (this.boxMode && this.hasUnusedItem(userId, 'eldorado')) {
      voteMap.set(userId, { vote, doubleVote: true });
      this.useItem(userId, 'eldorado');
    } else {
      voteMap.set(userId, vote);
    }
    return true;
  }

  isVotingComplete(eventIndex) {
    const expected = this.expectedVoters.get(eventIndex);
    const voteMap = this.votes.get(eventIndex);
    return voteMap.size >= expected.size;
  }

  allVotingComplete() {
    for (let i = 0; i < this.pendingEvents.length; i++) {
      if (!this.isVotingComplete(i)) return false;
    }
    return true;
  }

  resolveAttack(eventIndex) {
    const ev = this.pendingEvents[eventIndex];
    const voteMap = this.votes.get(eventIndex);
    const effective = this._getEffectiveVotes(voteMap);

    let charges = 0, fires = 0, waters = 0;
    for (const v of effective) {
      if (v === 'charge') charges++;
      else if (v === 'fire') fires++;
      else if (v === 'water') waters++;
    }

    const success = charges === 1 && fires >= 1 && waters <= 1;
    return { success, charges, fires, waters, ship: ev.ship, target: ev.target, initiator: ev.initiator };
  }

  applyAttackSuccess(ship, hold) {
    this.successfulAttackShips.add(ship); // Mark this ship as having had a successful attack
    const ev = this.pendingEvents.find(e => e.type === 'attack' && e.ship === ship);
    const target = ev?.target || 'spanishShip';
    if (target === 'spanishShip') {
      if (this.locations.spanishShip.treasures > 0) {
        this.locations.spanishShip.treasures--;
        this.locations[ship].holds[hold]++;
      }
    } else {
      // Attacking the other pirate ship - use stealFrom chosen at attack time
      const otherShip = target;
      const otherHolds = this.locations[otherShip].holds;
      const stealFrom = (hold == "french" ? 'english' : 'french');
      if (otherHolds[stealFrom] > 0) {
        otherHolds[stealFrom]--;
        this.locations[ship].holds[hold]++;
      }
    }
  }

  resolveMutiny(eventIndex) {
    const ev = this.pendingEvents[eventIndex];
    const voteMap = this.votes.get(eventIndex);
    const effective = this._getEffectiveVotes(voteMap);

    let forV = 0, against = 0;
    for (const v of effective) {
      if (v === 'for') forV++;
      else against++;
    }

    const success = forV > against;
    if (success) {
      const captain = this.locations[ev.ship].crew[0];
      const result = this.tryExpel(captain, true);
      return { success, forV, against, ship: ev.ship, initiator: ev.initiator, cloverBlocked: result.blocked };
    }
    return { success, forV, against, ship: ev.ship, initiator: ev.initiator, cloverBlocked: false };
  }

  resolveDispute(eventIndex) {
    const voteMap = this.votes.get(eventIndex);
    const effective = this._getEffectiveVotes(voteMap);

    let engVotes = 0, frVotes = 0;
    for (const v of effective) {
      if (v === 'england') engVotes++;
      else frVotes++;
    }

    // If solo voter, add random vote
    // if (expected.size === 1) {
    //   if (Math.random() < 0.5) engVotes++;
    //   else frVotes++;
    // }

    if (engVotes > frVotes) {
      this.locations.island.treasures = { english: 2, french: 0 };
    } else if (frVotes > engVotes) {
      this.locations.island.treasures = { english: 0, french: 2 };
    } else {
      this.locations.island.treasures = { english: 1, french: 1 };
    }

    // Check if governor voted for the losing side or didn't win
    const governor = this.locations.island.residents[0];
    let governorDeposed = false;
    if (governor) {
      const rawGovVote = voteMap.get(governor);
      const govVote = typeof rawGovVote === 'object' ? rawGovVote.vote : rawGovVote;
      const govTeam = this.players.get(governor)?.team;

      // Dutch and Spanish governors always get deposed after dispute
      if ((govTeam === 'dutch' || govTeam === 'spanish') && !this.mistMode) {
        // Send to last rank on island instead of rowboat
        this.removeFromLocation(governor);
        this.locations.island.residents.push(governor);
        governorDeposed = true;
      } else if (govVote) {
        const govSide = govVote; // 'england' or 'france'
        // Deposed if didn't win (lost or tie)
        const didNotWin =
          (govSide === 'england' && frVotes >= engVotes) ||
          (govSide === 'france' && engVotes >= frVotes);
        if (didNotWin) {
          // Send to last rank on island instead of rowboat
          this.removeFromLocation(governor);
          this.locations.island.residents.push(governor);
          governorDeposed = true;
        }
      }
    }

    return { engVotes, frVotes, governorDeposed, governor };
  }

  calculateScores() {
    let eng = 0, fr = 0;
    eng += this.locations.island.treasures.english;
    fr += this.locations.island.treasures.french;
    for (const ship of ['flyingDutchman', 'jollyRoger']) {
      eng += this.locations[ship].holds.english;
      fr += this.locations[ship].holds.french;
    }
    return { english: eng, french: fr };
  }

  getWinner() {
    const scores = this.calculateScores();
    if (scores.english > scores.french) return { winner: 'english', ...scores };
    if (scores.french > scores.english) return { winner: 'french', ...scores };
    // Tie: governor's team wins
    const governor = this.locations.island.residents[0];
    const govTeam = governor ? this.players.get(governor).team : null;
    return { winner: govTeam || 'english', tie: true, governorTeam: govTeam, ...scores };
  }

  getDutchResult() {
    let dutchPlayer = null;
    for (const [, p] of this.players) {
      if (p.team === 'dutch') { dutchPlayer = p; break; }
    }
    if (!dutchPlayer) return null;

    const { tie } = this.getWinner();

    // Dutch is governor and it's a tie -> Dutch wins alone
    if (tie && this.isGovernor(dutchPlayer.id)) {
      return { won: true, reason: 'حاکم جزیره در بازی مساوی', solo: true };
    }

    // Dutch is captain of ship with most treasure -> wins
    const ship = this.getPlayerShip(dutchPlayer.id);
    if (ship && this.isCaptain(dutchPlayer.id)) {
      const holds = this.locations[ship].holds;
      const shipTotal = holds.english + holds.french;
      const otherShip = ship === 'flyingDutchman' ? 'jollyRoger' : 'flyingDutchman';
      const otherHolds = this.locations[otherShip].holds;
      const otherTotal = otherHolds.english + otherHolds.french;

      if (shipTotal > otherTotal) {
        return { won: true, reason: 'ناخدای کشتی با گنج بیشتر' };
      }
    }

    return { won: false };
  }

  getSpanishResult() {
    let spanishPlayer = null;
    for (const [, p] of this.players) {
      if (p.team === 'spanish') { spanishPlayer = p; break; }
    }
    if (!spanishPlayer) return null;

    const { tie } = this.getWinner();

    // Spanish ship has at least 2 treasures -> wins independently (others can still win)
    if (this.locations.spanishShip.treasures >= 2) {
      return { won: true, reason: 'کشتی اسپانیایی حداقل ۲ گنج دارد', independent: true };
    }

    // Spanish is governor and it's a tie -> Spanish wins alone
    if (tie && this.isGovernor(spanishPlayer.id)) {
      return { won: true, reason: 'حاکم جزیره در بازی مساوی', solo: true };
    }

    return { won: false };
  }

  // --- Box mode methods ---

  initializeBoxes() {
    const pool = [...REGULAR_BOX_POOL];
    const specials = shuffle([...SPECIAL_BOX_POOL]);
    this.specialBoxItems = specials.slice(0, 3);
    pool.push(...this.specialBoxItems);
    shuffle(pool);

    this.boxes = [];
    for (let i = 0; i < 5; i++) {
      this.boxes.push({ content: pool.pop() || null, peekedBy: new Set() });
    }
    this.boxPool = pool;
  }

  refillBoxes() {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i].content === null && this.boxPool.length > 0) {
        this.boxes[i].content = this.boxPool.pop();
        this.boxes[i].peekedBy = new Set();
      }
    }
  }

  peekBox(userId, boxIndex) {
    const box = this.boxes[boxIndex];
    if (!box || box.content === null) return null;
    box.peekedBy.add(userId);
    return box.content;
  }

  openBox(boxIndex) {
    const box = this.boxes[boxIndex];
    if (!box || box.content === null) return null;
    const item = box.content;
    box.content = null;
    box.peekedBy.clear();
    return item;
  }

  markExtraAction(userId) {
    this.usedExtraAction.add(userId);
  }

  addHeldItem(userId, type) {
    if (!this.heldItems.has(userId)) this.heldItems.set(userId, []);
    this.heldItems.get(userId).push({ type, used: false });
  }

  getHeldItems(userId) {
    return this.heldItems.get(userId) || [];
  }

  hasUnusedItem(userId, type) {
    return this.getHeldItems(userId).some(i => i.type === type && !i.used);
  }

  useItem(userId, type) {
    const items = this.getHeldItems(userId);
    const item = items.find(i => i.type === type && !i.used);
    if (item) { item.used = true; return true; }
    return false;
  }

  tryExpel(userId, expelled = false) {
    if (this.boxMode && this.hasUnusedItem(userId, 'clover')) {
      this.useItem(userId, 'clover');
      return { blocked: true };
    }
    this.sendToIsland(userId, expelled);
    return { blocked: false };
  }

  checkAlbatrossAtShip(shipKey) {
    if (!shipKey || shipKey === 'island') return { triggered: false, affected: [] };
    const crew = this.locations[shipKey].crew;
    const holders = crew.filter(id => this.hasUnusedItem(id, 'albatross'));
    if (holders.length < 2) return { triggered: false, affected: [] };

    // Consume all albatrosses
    for (const id of holders) {
      const items = this.getHeldItems(id);
      for (const item of items) {
        if (item.type === 'albatross' && !item.used) item.used = true;
      }
    }
    // Send all crew to island
    const allCrew = [...crew];
    for (const id of allCrew) {
      this.removeFromLocation(id);
      this.locations.island.residents.push(id);
      this.players.get(id).location = 'island';
    }
    return { triggered: true, affected: allCrew };
  }

  getNonEmptyBoxes() {
    return this.boxes
      .map((b, i) => ({ index: i, content: b.content }))
      .filter(b => b.content !== null);
  }

  // Helper: get effective votes accounting for El Dorado and Pirate Code
  _getEffectiveVotes(voteMap) {
    const votes = [];
    for (const [, v] of voteMap) {
      const vote = typeof v === 'object' ? v.vote : v;
      const nullified = typeof v === 'object' && v.nullified;
      const double = typeof v === 'object' && v.doubleVote;
      if (!nullified) {
        votes.push(vote);
        if (double) votes.push(vote);
      }
    }
    return votes;
  }

  shouldGameEnd() {
    if (this.armadaCalled) return true;
    if (this.round >= 10) return true;
    return false;
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { GameState, shuffle };
