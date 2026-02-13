const { GameState } = require('./state');

const games = new Map(); // chatId -> GameState

function getGame(chatId) {
  return games.get(chatId) || null;
}

function createGame(chatId) {
  const game = new GameState(chatId);
  games.set(chatId, game);
  return game;
}

function deleteGame(chatId) {
  games.delete(chatId);
}

// Reverse lookup: find which game a user is in (for DM callback queries)
function findGameByPlayer(userId) {
  for (const [chatId, game] of games) {
    if (game.players.has(userId)) return game;
  }
  return null;
}

module.exports = { getGame, createGame, deleteGame, findGameByPlayer };
