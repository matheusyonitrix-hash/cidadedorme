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
installSocketHandlers(io);
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

const PORT = process.env.PORT || 3000;
async function startServer() {
  // O Render não fornece MongoDB local. Sem MONGODB_URI, o servidor do jogo
  // pode arrancar normalmente; a persistência de perfis fica desativada.
  if (process.env.MONGODB_URI || process.env.NODE_ENV !== 'production') {
    await connectDB();
  } else {
    console.warn('⚠️ [DATABASE] MONGODB_URI não definida; persistência de perfis desativada neste deploy.');
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
