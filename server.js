const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Game State Management
let players = [];
let gamePhase = 'LOBBY'; // LOBBY, DISCUSSION, DAY_VOTING, CITY_SLEEP, GAME_OVER
let currentRound = 1;
let maxRounds = 5;
let dayVotes = {};
let nightActions = { mafia: null, doctor: null, police: null, bomber: null };

// Utility for clean timing delays
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. Player Joins or Reconnects
  socket.on('joinGame', (data) => {
    let player = players.find((p) => p.token === data.token);

    if (player) {
      player.id = socket.id; // Update socket reference
      player.name = data.name;
    } else {
      player = {
        id: socket.id,
        token: data.token,
        name: data.name,
        role: null,
        isAlive: true,
        readyForNight: false,
      };
      players.push(player);
    }

    const isHost = players[0]?.id === socket.id;
    socket.emit('initPlayer', { isHost });
    io.emit('updatePlayers', players);
  });

  // 2. Update Nickname
  socket.on('updateName', (data) => {
    const player = players.find((p) => p.id === socket.id);
    if (player) {
      player.name = data.name;
      io.emit('updatePlayers', players);
    }
  });

  // 3. Start Game (Host Command)
  socket.on('startGame', (data) => {
    if (players[0]?.id !== socket.id) return; // Host check

    const { config, rounds } = data;
    maxRounds = parseInt(rounds) || 5;
    currentRound = 1;

    // Assign Roles
    const roles = [];
    for (let i = 0; i < config.mafia; i++) roles.push('Mafia');
    for (let i = 0; i < config.doctor; i++) roles.push('Doctor');
    for (let i = 0; i < config.police; i++) roles.push('Police');
    for (let i = 0; i < config.bomber; i++) roles.push('Suicide Bomber');
    while (roles.length < players.length) roles.push('Common Man');

    // Shuffle roles
    roles.sort(() => Math.random() - 0.5);

    const mafiaPartners = players
      .filter((_, idx) => roles[idx] === 'Mafia')
      .map((p) => p.name);

    players.forEach((player, idx) => {
      player.role = roles[idx];
      player.isAlive = true;
      player.readyForNight = false;

      const myPartners = player.role === 'Mafia' 
        ? mafiaPartners.filter((n) => n !== player.name) 
        : [];

      io.to(player.id).emit('assignRole', {
        role: player.role,
        mafiaPartners: myPartners,
      });
    });

    startDiscussionPhase();
  });

  // 4. Discussion Ready Proceed
  socket.on('playerProceed', () => {
    const player = players.find((p) => p.id === socket.id);
    if (player) player.readyForNight = true;

    io.emit('updatePlayers', players);

    const alivePlayers = players.filter((p) => p.isAlive);
    const allReady = alivePlayers.every((p) => p.readyForNight);

    if (allReady && gamePhase === 'DISCUSSION') {
      startNightSequence();
    }
  });

  // 5. Submit Night Actions
  socket.on('submitNightAction', (data) => {
    const player = players.find((p) => p.id === socket.id);
    if (!player || !player.isAlive) return;

    if (player.role === 'Mafia') nightActions.mafia = data.targetId;
    if (player.role === 'Doctor') nightActions.doctor = data.targetId;
    if (player.role === 'Suicide Bomber') nightActions.bomber = data.targetId;
  });

  // 6. Police Investigation
  socket.on('submitPoliceAction', (data) => {
    const player = players.find((p) => p.id === socket.id);
    if (!player || !player.isAlive || player.role !== 'Police') return;

    const target = players.find((p) => p.id === data.targetId);
    if (target) {
      socket.emit('policeResult', {
        targetName: target.name,
        role: target.role,
      });
    }
  });

  // 7. Day Voting
  socket.on('submitDayVote', (data) => {
    if (gamePhase !== 'DAY_VOTING') return;

    dayVotes[socket.id] = data.targetId;

    const alivePlayers = players.filter((p) => p.isAlive);
    if (Object.keys(dayVotes).length >= alivePlayers.length) {
      resolveDayVotes();
    }
  });

  // 8. Reset to Lobby
  socket.on('resetToLobby', () => {
    if (players[0]?.id !== socket.id) return;

    gamePhase = 'LOBBY';
    players.forEach((p) => {
      p.role = null;
      p.isAlive = true;
      p.readyForNight = false;
    });

    io.emit('phaseChange', { phase: 'LOBBY' });
    io.emit('updatePlayers', players);
  });

  // Handle Disconnects
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    io.emit('updatePlayers', players);
  });
});

// --- GAME FLOW LOGIC ---

function startDiscussionPhase() {
  gamePhase = 'DISCUSSION';
  players.forEach((p) => (p.readyForNight = false));

  io.emit('updatePlayers', players);
  io.emit('phaseChange', {
    phase: 'DISCUSSION',
    round: currentRound,
    maxRounds,
  });
}

// Clean Async Night Sequence Flow
async function startNightSequence() {
  if (checkGameOver()) return;

  gamePhase = 'CITY_SLEEP';
  nightActions = { mafia: null, doctor: null, police: null, bomber: null };

  io.emit('phaseChange', { phase: 'CITY_SLEEP', round: currentRound, maxRounds });

  // Step 1: Sleep Beep
  io.emit('triggerAlert', { type: 'SLEEP_BEEP' });
  await delay(10000);

  // Step 2: Mafia Turn (Gun sound)
  io.emit('nightStepChange', { subPhase: 'MAFIA' });
  io.emit('triggerAlert', { type: 'MAFIA_GUN' });
  await delay(5000);

  // Step 3: Doctor Turn (ECG sound)
  io.emit('nightStepChange', { subPhase: 'DOCTOR' });
  io.emit('triggerAlert', { type: 'DOCTOR_ECG' });
  await delay(5000);

  // Step 4: Police Turn (Siren sound)
  io.emit('nightStepChange', { subPhase: 'POLICE' });
  io.emit('triggerAlert', { type: 'POLICE_SIREN' });
  await delay(5000);

  // Step 5: Suicide Bomber Turn (Explosion sound)
  io.emit('nightStepChange', { subPhase: 'BOMBER' });
  io.emit('triggerAlert', { type: 'BOMBER_EXPLODE' });
  await delay(5000);

  // Step 6: Resolve Night Actions & City Wakes Up
  resolveNightActions();
}

function resolveNightActions() {
  const announcements = [];

  // Wakeup chimes and bird chirps alert trigger
  io.emit('triggerAlert', { type: 'CITY_WAKEUP' });

  // 1. Process Suicide Bomber explosion
  if (nightActions.bomber && nightActions.bomber !== 'NONE') {
    const bomber = players.find((p) => p.role === 'Suicide Bomber' && p.isAlive);
    const target = players.find((p) => p.id === nightActions.bomber && p.isAlive);

    if (bomber) bomber.isAlive = false;
    if (target) target.isAlive = false;

    if (bomber && target) {
      announcements.push(`💥 **Suicide Bomber** blew up taking **${target.name}** with them!`);
    }
  }

  // 2. Process Mafia Kill & Doctor Save
  if (nightActions.mafia) {
    const target = players.find((p) => p.id === nightActions.mafia && p.isAlive);

    if (target) {
      if (nightActions.doctor === nightActions.mafia) {
        announcements.push(`💉 **${target.name}** was attacked by Mafia, but saved by the Doctor!`);
      } else {
        target.isAlive = false;
        announcements.push(`💀 **${target.name}** was eliminated by the Mafia!`);
      }
    }
  }

  if (announcements.length === 0) {
    announcements.push('🌅 City woke up! It was a quiet night, nobody died.');
  }

  io.emit('nightResults', announcements);
  io.emit('updatePlayers', players);

  if (!checkGameOver()) {
    startDayVotingPhase();
  }
}

function startDayVotingPhase() {
  gamePhase = 'DAY_VOTING';
  dayVotes = {};

  io.emit('phaseChange', {
    phase: 'DAY_VOTING',
    round: currentRound,
    maxRounds,
  });
}

function resolveDayVotes() {
  const counts = {};
  Object.values(dayVotes).forEach((targetId) => {
    if (targetId !== 'SKIP') {
      counts[targetId] = (counts[targetId] || 0) + 1;
    }
  });

  const voteTallies = Object.keys(counts).map((targetId) => {
    const p = players.find((p) => p.id === targetId);
    return { name: p ? p.name : 'Unknown', count: counts[targetId] };
  });

  let maxVotes = 0;
  let eliminatedId = null;
  let tie = false;

  Object.entries(counts).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedId = id;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  });

  let verdict = '';
  if (eliminatedId && !tie) {
    const eliminated = players.find((p) => p.id === eliminatedId);
    if (eliminated) {
      eliminated.isAlive = false;
      verdict = `⚖️ The city voted to execute **${eliminated.name}**!`;
    }
  } else {
    verdict = '⚖️ No player was executed due to a tie or skipped votes.';
  }

  io.emit('dayVotingDetails', { voteTallies, verdict });
  io.emit('updatePlayers', players);

  if (!checkGameOver()) {
    currentRound++;
    if (currentRound > maxRounds) {
      triggerGameOver('⌛ Maximum game rounds reached!');
    } else {
      setTimeout(startDiscussionPhase, 6000);
    }
  }
}

function checkGameOver() {
  const aliveMafia = players.filter((p) => p.isAlive && p.role === 'Mafia');
  const aliveInnocents = players.filter((p) => p.isAlive && p.role !== 'Mafia');

  if (aliveMafia.length === 0) {
    triggerGameOver('🎉 INNOCENTS WIN! All Mafia have been eliminated.');
    return true;
  }

  if (aliveMafia.length >= aliveInnocents.length) {
    triggerGameOver('🔴 MAFIA WINS! They have taken over the city.');
    return true;
  }

  return false;
}

function triggerGameOver(winnerMessage) {
  gamePhase = 'GAME_OVER';
  io.emit('phaseChange', { phase: 'GAME_OVER', winnerMessage });
  io.emit('revealAllRoles', players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia Game server running on port ${PORT}`);
});
