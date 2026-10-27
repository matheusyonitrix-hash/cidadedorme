const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { Server } = require('socket.io');
const { installSocketHandlers, activeRooms, claimCheckoutCredential, finishCheckoutCredential } = require('./socketHandler');
const { connectDB, closeDB } = require('./database');
const { getFactionName, getFaction, getRoleInfo } = require('./roles');
const Player = require('./models/Player');

const PORT = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const GOLD_GEAR_PACKAGES = Object.freeze({
  pacote_ouro_10: Object.freeze({ goldGears: 10, amountCents: 499, currency: 'brl', name: 'Pacote de 10 Engrenagens de Ouro' })
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
const games = installSocketHandlers(io);

// O Stripe precisa receber o corpo sem parsing para validar a assinatura.
// Esta rota deve permanecer antes de qualquer middleware express.json().
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'O webhook de pagamentos ainda não está configurado.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.warn(`⚠️ [STRIPE] Assinatura de webhook inválida: ${error.message}`);
    return res.status(400).send('Assinatura Stripe inválida.');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const username = String(session.metadata?.username || '').trim().toLocaleLowerCase('pt');
    const packageId = session.metadata?.packageId;
    const pack = GOLD_GEAR_PACKAGES[packageId];

    // Nunca creditar sessões não pagas, moedas ou preços que não correspondam
    // ao pacote fixo definido no servidor.
    if (!pack || !username || session.client_reference_id !== username || session.mode !== 'payment' || session.payment_status !== 'paid' ||
        session.currency !== pack.currency || session.amount_total !== pack.amountCents) {
      console.error(`❌ [STRIPE] Checkout ${session.id} rejeitado: pacote, estado ou valor inválido.`);
      return res.status(400).send('Sessão de Checkout inválida.');
    }
    if (Player.db.readyState !== 1) {
      console.error('❌ [STRIPE] MongoDB indisponível; o webhook será tentado novamente pelo Stripe.');
      return res.status(500).send('Base de dados indisponível.');
    }

    try {
      const priorSessions = { $ifNull: ['$processed_checkout_sessions', []] };
      const wasAlreadyCredited = { $in: [session.id, priorSessions] };
      const result = await Player.updateOne(
        { username },
        [{
          $set: {
            'currencies.gold_gears': {
              $add: [
                { $ifNull: ['$currencies.gold_gears', 0] },
                { $cond: [wasAlreadyCredited, 0, pack.goldGears] }
              ]
            },
            // O ID de cada sessão fica registado para que reentregas futuras
            // do mesmo evento Stripe nunca voltem a creditar a compra.
            processed_checkout_sessions: {
              $cond: [
                wasAlreadyCredited,
                priorSessions,
                { $concatArrays: [priorSessions, [session.id]] }
              ]
            }
          }
        }]
      );

      if (result.matchedCount === 0) {
        console.error(`❌ [STRIPE] Conta ${username} não encontrada para Checkout ${session.id}.`);
        return res.status(500).send('Conta de jogador ainda não disponível.');
      }
      console.log(`✅ [STRIPE] Checkout ${session.id} processado para ${username} (${pack.goldGears} Engrenagens).`);
    } catch (error) {
      console.error(`❌ [STRIPE] Falha ao creditar Checkout ${session.id}: ${error.message}`);
      return res.status(500).send('Falha ao creditar a compra.');
    }
  }

  return res.json({ received: true });
});

app.post('/create-checkout-session', express.json({ limit: '10kb' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Checkout indisponível: configura STRIPE_SECRET_KEY no servidor.' });
  }
  if (Player.db.readyState !== 1) {
    return res.status(503).json({ error: 'Checkout indisponível sem ligação ao MongoDB.' });
  }

  const username = String(req.body?.username || '').trim().toLocaleLowerCase('pt');
  const packageId = req.body?.packageId;
  const pack = GOLD_GEAR_PACKAGES[packageId];
  if (!pack) return res.status(400).json({ error: 'Pacote de Engrenagens desconhecido.' });
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!username || !bearer) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Inicia sessão novamente.' });
  }
  try {
    const playerExists = await Player.exists({ username });
    if (!playerExists) return res.status(404).json({ error: 'Não foi possível localizar a conta do jogador.' });

    let baseUrl = process.env.PUBLIC_APP_URL;
    if (!baseUrl && process.env.NODE_ENV !== 'production') baseUrl = `http://localhost:${PORT}`;
    if (!baseUrl) {
      return res.status(503).json({ error: 'Configura PUBLIC_APP_URL com o endereço público do jogo no Render.' });
    }
    const publicUrl = new URL(baseUrl);
    if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
      return res.status(503).json({ error: 'PUBLIC_APP_URL deve usar HTTPS em produção.' });
    }
    const siteUrl = publicUrl.origin;
    if (!claimCheckoutCredential(bearer[1], username)) {
      return res.status(401).json({ error: 'Sessão inválida, expirada ou já utilizada. Inicia sessão novamente.' });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: username,
        line_items: [{
          price_data: {
            currency: pack.currency,
            unit_amount: pack.amountCents,
            product_data: { name: pack.name, description: `${pack.goldGears} Engrenagens de Ouro para A Cidade Dorme` }
          },
          quantity: 1
        }],
        metadata: { username, packageId },
        success_url: `${siteUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?payment=cancelled`
      });

      finishCheckoutCredential(bearer[1], true);
      return res.json({ url: session.url });
    } catch (error) {
      finishCheckoutCredential(bearer[1], false);
      throw error;
    }
  } catch (error) {
    console.error(`❌ [STRIPE] Não foi possível criar o Checkout para ${username}: ${error.message}`);
    return res.status(502).json({ error: 'Não foi possível abrir o Checkout. Tenta novamente.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/leaderboard', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (Player.db.readyState !== 1) {
    return res.status(503).json({
      error: 'A Mesa de Engenharia está sem pressão no manómetro de dados. Tenta novamente mais tarde.'
    });
  }

  try {
    const [prestige, fortunes] = await Promise.all([
      Player.find({}, { username: 1, level: 1, xp: 1, _id: 0 })
        .sort({ level: -1, xp: -1, username: 1 })
        .limit(10)
        .lean(),
      Player.find({}, { username: 1, 'currencies.copper_coins': 1, _id: 0 })
        .sort({ 'currencies.copper_coins': -1, username: 1 })
        .limit(10)
        .lean()
    ]);

    return res.json({
      prestige: prestige.map(({ username, level }) => ({ username, level })),
      fortunes: fortunes.map(({ username, currencies }) => ({
        username,
        copper_coins: currencies?.copper_coins || 0
      }))
    });
  } catch (error) {
    console.error(`❌ [LEADERBOARD] Falha ao consultar a Mesa de Engenharia: ${error.message}`);
    return res.status(500).json({ error: 'A Mesa de Engenharia teve uma falha. Tenta novamente.' });
  }
});
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
