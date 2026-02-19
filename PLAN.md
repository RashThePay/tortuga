# Plan: Game Rules Update + Deferred Resolution Overhaul

## Context
The bot has mismatches with the game rules, and the user wants a fundamental overhaul: during the day, only the player's **choice** is announced — the **resolution** happens when the day ends, following the defined resolution order.

---

## Change 1: Deferred Action Resolution (Overhaul)

**Current**: Move and treasure transfer resolve immediately during day.
**New**: Only announce the choice. Resolutions happen at day-end in order:

1. Moves
2. Treasure transfer (cabin boy)
3. Inspect (first mate, mist mode only — sees holds AFTER transfers)
4. *(Night voting begins)* Mutiny
5. Attack / Maroon
6. Dispute
7. Armada

### Implementation

**`actions.js` — handleActionCallback (type `moveloc`)**:
- Stop calling `removeFromLocation()` and adding to `pendingJoins` immediately
- Instead: `game.addPendingEvent({ type: 'move', userId, destination })` and `game.markAction(userId)`
- Announce only the choice: "X chose to move to [location]"
- Validate at declaration time (ship full, expelled) — keep current validation checks
- Move the captain-leaving-during-mutiny special case from day-time to resolution time: when resolving moves, if captain is leaving a ship with a pending mutiny → treat as "accepting mutiny" (mark captain as expelled with `expelledRound`, auto-resolve mutiny as succeeded). This is NOT a simple move — captain gets expelled status.

**`actions.js` — handleActionCallback (type `move` / `movemist`)**:
- Stop modifying `holds` immediately
- Instead: `game.addPendingEvent({ type: 'treasure_transfer', userId, ship, targetHold, mistMode: false/true })`
- Announce the choice only (normal: "X chose to transfer treasure"; mist: "X attempted transfer")
- Direction chosen at declaration time; if source hold is empty at resolution, transfer silently fails

**`actions.js` — inspect()**:
- Stop sending DM immediately
- Just add pending event and announce "X chose to inspect" (already does this)
- DM sent at resolution time

**`votes.js` — endDay()`**:
- Before night voting setup, resolve non-voting actions in order:
  1. **Resolve moves**: For each `move` event, execute `removeFromLocation` + add to `pendingJoins`. If captain is leaving a ship with a pending mutiny → treat as "accepting mutiny": mark captain as expelled (`expelledRound = round`), mark mutiny as autoResolved, announce mutiny success.
  2. **Resolve pending joins** (call existing `startNight()` logic for joins, or move that logic here)
  3. **Resolve treasure transfers**: Move treasure between holds. In mist mode, send success/fail DM.
  4. **Resolve inspects** (mist mode): Send DM with hold info — runs after treasure transfers so first mate sees actual post-transfer state.
- Then proceed with existing night voting flow

**Important**: A maroon target is NOT expelled during the day — `expelledRound` is only set when maroon actually resolves at night (step 5). Mutiny (step 4) can cancel the maroon, so the target must remain free to act during the day. No expulsion validation should apply to pending-maroon targets.

**`messages.js`**:
- Add new messages: `moveChosen(name, dest)` — "X chose to move to [location]"
- Add resolution messages: `moveResolved(name, dest)` — "X moved to [location]" (can reuse existing `movedTo`)
- `treasureTransferChosen(name, ship)` — "X (cabin boy) chose to transfer treasure"
- Rename/adjust existing messages as needed

---

## Change 2: Expulsion Rule Fix

**Current**: Blocks return to specific ship, forever (cleared on voluntary move).
**New**: Blocks ALL ships for current + previous round (2 rounds).

### Implementation

**`state.js`**:
- Replace `expelledFrom: []` with `expelledRound: null` in player data
- Update `canMoveTo(userId, destination)`:
  ```js
  if ((dest === 'flyingDutchman' || dest === 'jollyRoger') &&
      p.expelledRound !== null &&
      (this.round - p.expelledRound) <= 1) {
    return false;
  }
  ```
- Update `sendToIsland()`: Set `p.expelledRound = this.round` instead of pushing to array
- Remove `p.expelledFrom = []` clear on voluntary move (line 545 in actions.js)

**`actions.js`**:
- Remove `p.expelledFrom = []` in moveloc callback (line 545)
- Update validation messages to reflect "can't go to any ship"

---

## Files to Modify

| File | Changes |
|------|---------|
| [actions.js](actions.js) | Defer move/treasure/inspect resolution; move captain-mutiny special case to resolution phase; remove expelledFrom clear |
| [votes.js](votes.js) | Add day-end resolution phase before night voting |
| [state.js](state.js) | Change expelledFrom→expelledRound; update canMoveTo |
| [messages.js](messages.js) | Add choice/resolution message variants |

---

## Verification
- Test move: declared during day, resolved at day-end, announced separately
- Test treasure transfer: same deferred behavior
- Test captain declares move + first mate declares mutiny on same ship → move resolves first, mutiny auto-succeeds
- Test expulsion blocks ALL ships for exactly 2 rounds
- Test mist mode treasure transfer and inspect still work
- Test attack/mutiny/dispute voting unchanged
