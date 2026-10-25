const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { installSocketHandlers } = require('./socketHandler');
const { connectDB, closeDB } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
installSocketHandlers(io);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
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
