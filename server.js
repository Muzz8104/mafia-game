const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let game = {
  players: [], // { id, name, role, isAlive, votesReceived, nightAction }
  phase: 'LOBBY', // LOBBY, NIGHT, DAY_VOTING, GAME_OVER
  currentRound: 0,
  maxRounds: 3,
  timer: 0,
  nightActions: { mafiaTarget: null, doctorTarget: null, bomberTarget: null },
  votes: {}
};

let timerInterval = null;

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function startPhaseTimer(seconds, nextPhaseCallback) {
  clearInterval(timerInterval);
  game.timer = seconds;
  io.emit('timerUpdate', game.timer);

  timerInterval = setInterval(() => {
    game.timer--;
    io.emit('timerUpdate', game.timer);
    if (game.timer <= 0) {
      clearInterval(timerInterval);
      nextPhaseCallback();
    }
  }, 1000);
}

function processNightResults() {
  let deathLog = [];
  const { mafiaTarget, doctorTarget, bomberTarget } = game.nightActions;

  // Mafia Kill
  if (mafiaTarget) {
    if (mafiaTarget === doctorTarget) {
      deathLog.push("The Doctor saved someone tonight!");
    } else {
      const victim = game.players.find(p => p.id === mafiaTarget);
      if (victim) {
        victim.isAlive = false;
        deathLog.push(`${victim.name} was killed by the Mafia!`);
      }
    }
  }

  // Suicide Bomber Attack
  if (bomberTarget) {
    const bomber = game.players.find(p => p.role === 'Suicide Bomber');
    const bombVictim = game.players.find(p => p.id === bomberTarget);
    if (bomber && bomber.isAlive) {
      bomber.isAlive = false;
      deathLog.push(`BOOM! Suicide Bomber ${bomber.name} blew up!`);
    }
    if (bombVictim && bombVictim.isAlive) {
      bombVictim.isAlive = false;
      deathLog.push(`${bombVictim.name} was caught in the suicide explosion!`);
    }
  }

  // Reset Night Actions
  game.nightActions = { mafiaTarget: null, doctorTarget: null, bomberTarget: null };

  // Check Game Over or Next Round
  io.emit('updateState', game);
  io.emit('announcement', deathLog.join(' ') || "Night passed peacefully. No one died.");

  // Move to Day Discussion / Voting
  game.phase = 'DAY_VOTING';
  io.emit('phaseChange', game.phase);
  startPhaseTimer(45, () => processVotingResults());
}

function processVotingResults() {
  let voteCounts = {};
  Object.values(game.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  let eliminatedId = null;
  let maxVotes = 0;
  for (let id in voteCounts) {
    if (voteCounts[id] > maxVotes) {
      maxVotes = voteCounts[id];
      eliminatedId = id;
    }
  }

  if (eliminatedId) {
    const eliminated = game.players.find(p => p.id === eliminatedId);
    if (eliminated) {
      eliminated.isAlive = false;
      io.emit('announcement', `Town voted! ${eliminated.name} was eliminated.`);
    }
  } else {
    io.emit('announcement', "No one was eliminated in the vote.");
  }

  game.votes = {};

  // Check Round Limit or End Game
  if (game.currentRound >= game.maxRounds) {
    endGame();
  } else {
    startNightPhase();
  }
}

function startNightPhase() {
  game.currentRound++;
  game.phase = 'NIGHT';
  io.emit('phaseChange', game.phase);
  io.emit('updateState', game);
  io.emit('announcement', `CITY SLEEP! Close your eyes... (Round ${game.currentRound}/${game.maxRounds})`);

  startPhaseTimer(30, () => processNightResults());
}

function endGame() {
  game.phase = 'GAME_OVER';
  io.emit('phaseChange', game.phase);
  io.emit('revealRoles', game.players);
  io.emit('announcement', "GAME OVER! All roles have been revealed below.");
}

io.on('connection', (socket) => {
  socket.on('joinGame', ({ name }) => {
    if (!game.players.find(p => p.id === socket.id)) {
      game.players.push({ id: socket.id, name, role: null, isAlive: true });
    }
    io.emit('updateState', game);
  });

  socket.on('setupAndStartGame', ({ config, rounds }) => {
    game.maxRounds = parseInt(rounds) || 3;
    game.currentRound = 0;

    let roleDeck = [];
    for (let i = 0; i < config.mafia; i++) roleDeck.push('Mafia');
    for (let i = 0; i < config.doctor; i++) roleDeck.push('Doctor');
    for (let i = 0; i < config.bomber; i++) roleDeck.push('Suicide Bomber');
    for (let i = 0; i < config.common; i++) roleDeck.push('Common Man');

    roleDeck = shuffle(roleDeck);

    game.players.forEach((player, index) => {
      player.role = roleDeck[index] || 'Common Man';
      player.isAlive = true;
      io.to(player.id).emit('assignRole', player.role);
    });

    startNightPhase();
  });

  socket.on('nightAction', ({ targetId }) => {
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    if (player.role === 'Mafia') game.nightActions.mafiaTarget = targetId;
    if (player.role === 'Doctor') game.nightActions.doctorTarget = targetId;
    if (player.role === 'Suicide Bomber') game.nightActions.bomberTarget = targetId;
  });

  socket.on('castVote', ({ targetId }) => {
    const player = game.players.find(p => p.id === socket.id);
    if (player && player.isAlive) {
      game.votes[socket.id] = targetId;
    }
  });

  socket.on('disconnect', () => {
    game.players = game.players.filter(p => p.id !== socket.id);
    io.emit('updateState', game);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
