const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let game = {
  roomCode: 'MAFIA1',
  players: [], // { id, name, role, isAlive: true }
  phase: 'LOBBY' // LOBBY, NIGHT, DAY
};

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  // Join Game
  socket.on('joinGame', ({ name }) => {
    const existingPlayer = game.players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      game.players.push({ id: socket.id, name, role: null, isAlive: true });
    }
    io.emit('updatePlayers', game.players);
  });

  // Admin Starts Game & Assigns Roles
  socket.on('startGame', (customRoles) => {
    // customRoles array example: ['Mafia', 'Doctor', 'Suicide Bomber', 'Common Man']
    if (game.players.length < customRoles.length) {
      socket.emit('errorMsg', 'Not enough players for selected roles!');
      return;
    }

    const shuffledRoles = shuffle([...customRoles]);
    
    game.players.forEach((player, index) => {
      player.role = shuffledRoles[index] || 'Common Man';
      player.isAlive = true;
      // Send private role to each specific player socket
      io.to(player.id).emit('assignRole', player.role);
    });

    game.phase = 'NIGHT';
    io.emit('phaseChange', game.phase);
    io.emit('updatePlayers', game.players.map(p => ({ name: p.name, isAlive: p.isAlive })));
  });

  socket.on('disconnect', () => {
    game.players = game.players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', game.players);
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
