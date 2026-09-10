const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let game = {
  hostId: null,
  players: [],
  phase: 'LOBBY',
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

function processDayVotingResults() {
  let voteCounts = {};
  Object.values(game.votes).forEach(targetId => {
    if (targetId && targetId !== 'SKIP') {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  });

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
      voteMsg = `Town voted! ${eliminated.name} was eliminated.`;
    }
  } else {
    voteMsg = "No one was eliminated in the day vote.";
  }

  game.votes = {};
  io.emit('updatePlayers', game.players);
  io.emit('nightResults', [voteMsg]);

  setTimeout(() => startNightPhase(), 4000);
}

function processNightResults() {
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

  if (game.currentRound >= game.maxRounds) {
    game.phase = 'GAME_OVER';
    io.emit('phaseChange', game.phase);
    io.emit('revealAllRoles', game.players);
  } else {
    setTimeout(() => startRound(), 5000);
  }
}

function startNightPhase() {
  game.phase = 'CITY_SLEEP';
  io.emit('phaseChange', game.phase);
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
  // If no active players exist, assign this new socket as Host immediately
  if (game.players.length === 0 || !game.hostId) {
    game.hostId = socket.id;
  }

  socket.on('joinGame', ({ name }) => {
    let existing = game.players.find(p => p.id === socket.id);
    if (!existing) {
      game.players.push({ id: socket.id, name, role: null, isAlive: true, readyForNight: false });
    }

    // Force check host status
    const isHost = socket.id === game.hostId;
    socket.emit('initPlayer', { isHost });
    io.emit('updatePlayers', game.players);
  });

  socket.on('startGame', ({ config, rounds }) => {
    if (socket.id !== game.hostId) return;

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
      player.readyForNight = false;
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
    game.players = game.players.filter(p => p.id !== socket.id);
    if (socket.id === game.hostId) {
      if (game.players.length > 0) {
        game.hostId = game.players[0].id;
        io.to(game.hostId).emit('initPlayer', { isHost: true });
      } else {
        game.hostId = null;
      }
    }
    io.emit('updatePlayers', game.players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
