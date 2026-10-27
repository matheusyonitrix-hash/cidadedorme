const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { Server } = require('socket.io');
const { installSocketHandlers, activeRooms } = require('./socketHandler');
const { connectDB, closeDB } = require('./database');
const { getFactionName, getFaction, getRoleInfo } = require('./roles');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
const games = installSocketHandlers(io);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/admin/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  // A chave deve ser configurada no ambiente como ADMIN_STATUS_SECRET; não
  // guardar credenciais administrativas no código ou no repositório.
  const expectedSecret = process.env.ADMIN_STATUS_SECRET;
  const suppliedSecret = typeof req.query.secret === 'string' ? req.query.secret : '';
  const expected = Buffer.from(expectedSecret || '', 'utf8');
  const supplied = Buffer.from(suppliedSecret, 'utf8');
  const authorized = Boolean(expectedSecret) && expected.length === supplied.length &&
    timingSafeEqual(expected, supplied);

  if (!authorized) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const rooms = Object.values(activeRooms).map((room) => ({
    code: room.code,
    gameState: room.gameState,
    hostId: room.hostId,
    players: (room.players || []).map((player) => {
      const role = player.role || null;
      const roleInfo = role ? getRoleInfo(role) : null;
      const faction = role ? getFaction(role) : null;
      return {
        name: player.name,
        role: roleInfo?.name || role || null,
        faction: faction ? getFactionName(faction) : null,
        isAlive: Boolean(player.isAlive),
        isReady: Boolean(player.isReady),
        isSilenced: Boolean(player.isSilenced),
        isMechanized: Boolean(player.isMechanized)
      };
    })
  }));

  return res.json({ totalRooms: rooms.length, rooms });
});
// A interface é uma aplicação de página única; caminhos como /** devem
// continuar a servir o ecrã principal em vez de devolver Cannot GET.
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const ROOM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const EMPTY_LOBBY_TTL_MS = 15 * 60 * 1000;
const roomCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [roomCode, room] of Object.entries(activeRooms)) {
    const players = Array.isArray(room.players) ? room.players : [];
    const hasConnectedPlayers = players.some((player) => player.connected !== false);
    const inactiveLobbySince = room.lastDisconnectedAt || room.lastActivityAt || room.createdAt || now;
    const inactiveLobby = room.gameState === 'LOBBY' && !hasConnectedPlayers &&
      now - inactiveLobbySince >= EMPTY_LOBBY_TTL_MS;
    const emptyRoom = players.length === 0;

    if (emptyRoom || inactiveLobby) {
      delete activeRooms[roomCode];
      const game = games.get(roomCode);
      if (game) {
        game.dispose();
        games.delete(roomCode);
      }
      console.log(`🧹 [ROOM-GC] Oficina ${roomCode} removida (${emptyRoom ? 'sem jogadores' : 'lobby inativo há 15 minutos'}).`);
    }
  }
}, ROOM_CLEANUP_INTERVAL_MS);
roomCleanupTimer.unref();

const PORT = process.env.PORT || 3000;
async function startServer() {
  // Usa a URI de produção quando configurada e mantém o MongoDB local como
  // conveniência no desenvolvimento. Sem Mongo em produção, o jogo continua.
  if (process.env.MONGODB_URI || process.env.NODE_ENV !== 'production') {
    await connectDB();
  } else {
    console.warn('⚠️ [DATABASE] MONGODB_URI não definida; autenticação e progressão persistente desativadas.');
  }

  server.listen(PORT, () => {
    console.log(`Cidade Dorme Steampunk disponível na porta ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error(`Servidor não iniciado: ${error.message}`);
  process.exitCode = 1;
});

let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(roomCleanupTimer);
  try {
    // io.close também encerra o servidor HTTP associado e os sockets ativos.
    await new Promise((resolve) => io.close(resolve));
    await closeDB();
  } catch (error) {
    console.error(`Erro durante o encerramento: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
