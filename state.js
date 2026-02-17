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
    this.successfulAttackShips = new Set(); // ships that had successful attacks this round
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
        expelledFrom: [], // Track expelled locations from current and previous round
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
    this.successfulAttackShips.clear(); // Reset attack tracking for the new day

    // Clear expulsion history from 2+ rounds ago (keep only current and previous round)
    for (const [, p] of this.players) {
      if (p.expelledFrom && p.expelledFrom.length > 0) {
        // Keep only the most recent expulsion
        p.expelledFrom =p.expelledFrom.slice(-1);
      }
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

    // Cannot return to location expelled from in current or previous round
    if (p.expelledFrom && p.expelledFrom.includes(destination)) {
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
    if (loc === 'flyingDutchman' || loc === 'jollyRoger') {
      this.locations[loc].crew = this.locations[loc].crew.filter((id) => id !== userId);
    } else if (loc === 'island') {
      this.locations.island.residents = this.locations.island.residents.filter((id) => id !== userId);
    }
  }

  sendToIsland(userId, expelled = false) {
    const p = this.players.get(userId);
    const fromLocation = p.location;
    this.removeFromLocation(userId);
    this.locations.island.residents.push(userId);
    p.location = 'island';

    // Track expulsion to prevent immediate return
    if (expelled && fromLocation && fromLocation !== 'island') {
      if (!p.expelledFrom) p.expelledFrom = [];
      p.expelledFrom.push(fromLocation);
    }
  }

  addPendingEvent(event) {
    this.pendingEvents.push(event);
  }

  startNight() {
    this.phase = 'night';
    // Set up voters for each pending event
    for (let i = 0; i < this.pendingEvents.length; i++) {
      const ev = this.pendingEvents[i];
      const voters = new Set();
      if (ev.type === 'attack') {
        const crew = this.locations[ev.ship].crew;
        if (crew.length < 2) {
          ev.cancelled = true;
        } else {
          for (const id of crew) voters.add(id);
        }
      } else if (ev.type === 'mutiny') {
        const crew = this.locations[ev.ship].crew;
        // If ship has no crew or captain is no longer captain (not at index 0), cancel mutiny
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
        for (const id of this.locations.island.residents) voters.add(id);
      }
      // 'maroon' and 'inspect' types have no voting - they just get resolved during night
      this.expectedVoters.set(i, voters);
      this.votes.set(i, new Map());
    }
  }

  recordVote(eventIndex, userId, vote) {
    const expected = this.expectedVoters.get(eventIndex);
    if (!expected || !expected.has(userId)) return false;
    const voteMap = this.votes.get(eventIndex);
    if (voteMap.has(userId)) return false;
    voteMap.set(userId, vote);
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

    let charges = 0, fires = 0, waters = 0;
    for (const v of voteMap.values()) {
      if (v === 'charge') charges++;
      else if (v === 'fire') fires++;
      else if (v === 'water') waters++;
    }

    // New rules: exactly 1 charge, at least 1 fire, extinguish votes must not be > 1
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
      const stealFrom = ev?.stealFrom || (otherHolds.english > 0 ? 'english' : 'french');
      if (otherHolds[stealFrom] > 0) {
        otherHolds[stealFrom]--;
        this.locations[ship].holds[hold]++;
      }
    }
  }

  resolveMutiny(eventIndex) {
    const ev = this.pendingEvents[eventIndex];
    const voteMap = this.votes.get(eventIndex);

    let forV = 0, against = 0;
    for (const v of voteMap.values()) {
      if (v === 'for') forV++;
      else against++;
    }

    const success = forV > against;
    if (success) {
      const captain = this.locations[ev.ship].crew[0];
      this.sendToIsland(captain, true); // Mark as expelled
    }
    // No penalty for failed mutiny anymore
    return { success, forV, against, ship: ev.ship, initiator: ev.initiator };
  }

  resolveDispute(eventIndex) {
    const voteMap = this.votes.get(eventIndex);

    let engVotes = 0, frVotes = 0;
    for (const v of voteMap.values()) {
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
      const govVote = voteMap.get(governor);
      const govTeam = this.players.get(governor)?.team;

      // Dutch and Spanish governors always get deposed after dispute
      if (govTeam === 'dutch' || govTeam === 'spanish') {
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

module.exports = { GameState };
