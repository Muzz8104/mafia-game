const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let game = {
  hostId: null,
  players: [], // { id, token, name, role, isAlive, readyForNight, policeUsed }
  phase: 'LOBBY',
  currentRound: 0,
  maxRounds: 5,
  timer: 0,
  nightActions: { mafiaTarget: null, doctorTarget: null, bomberTarget: null },
  votes: {}, // { voterSocketId: targetSocketId or 'SKIP' }
  winner: null
};

let timerInterval = null;

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function startTimer(seconds, onComplete) {
  clearInterval(timerInterval);
  game.timer = seconds;
  io.emit('timerUpdate', game.timer);

  timerInterval = setInterval(() => {
    game.timer--;
    io.emit('timerUpdate', game.timer);
    if (game.timer <= 0) {
      clearInterval(timerInterval);
      onComplete();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  game.timer = 0;
  io.emit('timerUpdate', 0);
}

function checkWinConditions() {
  const alivePlayers = game.players.filter(p => p.isAlive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'Mafia');
  const aliveNonMafia = alivePlayers.filter(p => p.role !== 'Mafia');

  if (aliveMafia.length === 0) {
    game.winner = 'COMMON_MAN';
    return true;
  }
  if (aliveMafia.length >= aliveNonMafia.length) {
    game.winner = 'MAFIA';
    return true;
  }
  return false;
}

function endGame(winnerMessage) {
  stopTimer();
  game.phase = 'GAME_OVER';
  io.emit('phaseChange', { phase: 'GAME_OVER', winnerMessage });
  io.emit('revealAllRoles', game.players);
}

function processDayVotingResults() {
  stopTimer();

  let voteCounts = {};
  let skipVotes = 0;

  // Tally total vote counts without saving voter names
  Object.values(game.votes).forEach(targetId => {
    if (targetId === 'SKIP') {
      skipVotes++;
    } else if (targetId) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  });

  // Prepare simple tallies for display
  let voteTallies = [];
  Object.entries(voteCounts).forEach(([targetId, count]) => {
    const target = game.players.find(p => p.id === targetId);
    if (target) {
      voteTallies.push({ name: target.name, count: count });
    }
  });

  if (skipVotes > 0) {
    voteTallies.push({ name: 'Skipped Votes', count: skipVotes });
  }

  // Find player with the most votes
  let eliminatedId = null;
  let maxVotes = 0;
  for (let id in voteCounts) {
    if (voteCounts[id] > maxVotes) {
      maxVotes = voteCounts[id];
      eliminatedId = id;
    }
  }

  let voteMsg = "";
  if (eliminatedId) {
    const eliminated = game.players.find(p => p.id === eliminatedId);
    if (eliminated) {
      eliminated.isAlive = false;
      voteMsg = `🚨 <strong>Town Verdict:</strong> ${eliminated.name} received the most votes (${maxVotes}) and was eliminated!`;
    }
  } else {
    voteMsg = "🚨 <strong>Town Verdict:</strong> No majority reached or everyone skipped. No one was eliminated.";
  }

  game.votes = {};
  io.emit('updatePlayers', game.players);

  // Broadcast anonymous vote counts and final verdict
  io.emit('dayVotingDetails', { voteTallies, verdict: voteMsg });

  if (checkWinConditions()) {
    const msg = game.winner === 'COMMON_MAN' ? "🎉 Common Men Win! All Mafias Eliminated!" : "🗡️ Mafias Win! They took over the town!";
    setTimeout(() => endGame(msg), 5000);
  } else {
    setTimeout(() => startNightPhase(), 6000);
  }
}

function processNightResults() {
  stopTimer();
  let announcements = [];
  const { mafiaTarget, doctorTarget, bomberTarget } = game.nightActions;

  if (mafiaTarget) {
    if (mafiaTarget === doctorTarget) {
      announcements.push("The person targeted by the Mafia was SAVED by the Doctor!");
    } else {
      const victim = game.players.find(p => p.id === mafiaTarget);
      if (victim) {
        victim.isAlive = false;
        announcements.push(`${victim.name} was killed by the Mafia!`);
      }
    }
  } else {
    announcements.push("Mafia did not strike tonight.");
  }

  if (bomberTarget && bomberTarget !== 'NONE') {
    const bomber = game.players.find(p => p.role === 'Suicide Bomber');
    const bombVictim = game.players.find(p => p.id === bomberTarget);
    if (bomber && bomber.isAlive) {
      bomber.isAlive = false;
      announcements.push(`BOOM! Suicide Bomber ${bomber.name} blew up!`);
    }
    if (bombVictim && bombVictim.isAlive) {
      bombVictim.isAlive = false;
      announcements.push(`${bombVictim.name} was caught in the suicide explosion!`);
    }
  }

  game.nightActions = { mafiaTarget: null, doctorTarget: null, bomberTarget: null };

  io.emit('updatePlayers', game.players);
  io.emit('nightResults', announcements);

  if (checkWinConditions()) {
    const msg = game.winner === 'COMMON_MAN' ? "🎉 Common Men Win! All Mafias Eliminated!" : "🗡️ Mafias Win! They took over the town!";
    setTimeout(() => endGame(msg), 3000);
  } else if (game.currentRound >= game.maxRounds) {
    endGame("⚖️ Maximum Rounds Reached!");
  } else {
    setTimeout(() => startRound(), 5000);
  }
}

function startNightPhase() {
  game.phase = 'CITY_SLEEP';
  io.emit('phaseChange', { phase: 'CITY_SLEEP' });
  io.emit('vibrateRoleActions');

  startTimer(30, () => processNightResults());
}

function startRound() {
  game.currentRound++;
  game.players.forEach(p => p.readyForNight = false);

  if (game.currentRound >= 2) {
    game.phase = 'DAY_VOTING';
    io.emit('phaseChange', { phase: 'DAY_VOTING', round: game.currentRound, maxRounds: game.maxRounds });
    startTimer(30, () => processDayVotingResults());
  } else {
    game.phase = 'DISCUSSION';
    io.emit('phaseChange', { phase: 'DISCUSSION', round: game.currentRound, maxRounds: game.maxRounds });
  }
}

io.on('connection', (socket) => {

  socket.on('joinGame', ({ name, token }) => {
    let existingPlayer = game.players.find(p => p.token === token);

    if (existingPlayer) {
      existingPlayer.id = socket.id;
    } else {
      existingPlayer = {
        id: socket.id,
        token: token,
        name: name,
        role: null,
        isAlive: true,
        readyForNight: false,
        policeUsed: false
      };
      game.players.push(existingPlayer);
    }

    if (!game.hostId || !game.players.some(p => p.id === game.hostId)) {
      game.hostId = socket.id;
    }

    const isHost = socket.id === game.hostId;
    socket.emit('initPlayer', { isHost, player: existingPlayer, currentPhase: game.phase });

    if (game.phase !== 'LOBBY' && existingPlayer.role) {
      const mafias = game.players.filter(p => p.role === 'Mafia').map(p => p.name);
      socket.emit('assignRole', {
        role: existingPlayer.role,
        mafiaPartners: existingPlayer.role === 'Mafia' ? mafias.filter(m => m !== existingPlayer.name) : []
      });
      socket.emit('phaseChange', { phase: game.phase, round: game.currentRound, maxRounds: game.maxRounds });
    }

    io.emit('updatePlayers', game.players);
  });

  socket.on('startGame', ({ config, rounds }) => {
    if (socket.id !== game.hostId) return;

    game.maxRounds = parseInt(rounds) || 5;
    game.currentRound = 0;
    game.winner = null;

    let roleDeck = [];
    for (let i = 0; i < config.mafia; i++) roleDeck.push('Mafia');
    for (let i = 0; i < config.doctor; i++) roleDeck.push('Doctor');
    for (let i = 0; i < config.police; i++) roleDeck.push('Police');
    for (let i = 0; i < config.bomber; i++) roleDeck.push('Suicide Bomber');
    for (let i = 0; i < config.common; i++) roleDeck.push('Common Man');

    roleDeck = shuffle(roleDeck);

    game.players.forEach((player, index) => {
      player.role = roleDeck[index] || 'Common Man';
      player.isAlive = true;
      player.readyForNight = false;
      player.policeUsed = false;
    });

    const mafias = game.players.filter(p => p.role === 'Mafia').map(p => p.name);

    game.players.forEach(p => {
      io.to(p.id).emit('assignRole', {
        role: p.role,
        mafiaPartners: p.role === 'Mafia' ? mafias.filter(m => m !== p.name) : []
      });
    });

    startRound();
  });

  socket.on('playerProceed', () => {
    const player = game.players.find(p => p.id === socket.id);
    if (player) {
      player.readyForNight = true;
      io.emit('updatePlayers', game.players);

      const alivePlayers = game.players.filter(p => p.isAlive);
      const readyCount = alivePlayers.filter(p => p.readyForNight).length;

      if (readyCount >= alivePlayers.length) {
        startNightPhase();
      }
    }
  });

  socket.on('submitDayVote', ({ targetId }) => {
    const player = game.players.find(p => p.id === socket.id);
    if (player && player.isAlive) {
      game.votes[socket.id] = targetId;

      const alivePlayers = game.players.filter(p => p.isAlive);
      if (Object.keys(game.votes).length >= alivePlayers.length) {
        processDayVotingResults();
      }
    }
  });

  socket.on('submitPoliceAction', ({ targetId }) => {
    const player = game.players.find(p => p.id === socket.id);
    if (player && player.role === 'Police' && !player.policeUsed && player.isAlive) {
      const target = game.players.find(p => p.id === targetId);
      if (target) {
        player.policeUsed = true;
        socket.emit('policeResult', { targetName: target.name, role: target.role });
      }
    }
  });

  socket.on('submitNightAction', ({ targetId }) => {
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;

    if (player.role === 'Mafia') game.nightActions.mafiaTarget = targetId;
    if (player.role === 'Doctor') game.nightActions.doctorTarget = targetId;
    if (player.role === 'Suicide Bomber') game.nightActions.bomberTarget = targetId;
  });

  socket.on('disconnect', () => {
    if (socket.id === game.hostId) {
      const remaining = game.players.filter(p => p.id !== socket.id);
      if (remaining.length > 0) {
        game.hostId = remaining[0].id;
        io.to(game.hostId).emit('initPlayer', { isHost: true });
      }
    }
    io.emit('updatePlayers', game.players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
