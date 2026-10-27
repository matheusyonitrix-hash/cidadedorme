const { randomInt, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { Game } = require('./gameEngine');
const { ROLES, MIN_PLAYERS, getFaction, getRoleInfo } = require('./roles');
const Player = require('./models/Player');

const scryptAsync = promisify(scrypt);
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{2,20}$/u;
const COSMETIC_PRICES = Object.freeze({
  titulo_mestre_caldeira: { type: 'copper', price: 150 },
  skin_borda_bronze: { type: 'copper', price: 300 },
  skin_borda_ouro: { type: 'copper', price: 600 },
  titulo_premium_barao: { type: 'gold', price: 5 },
  skin_premium_cristal: { type: 'gold', price: 12 }
});
const GOLD_GEAR_PACKAGES = Object.freeze({
  pacote_ouro_10: { goldGears: 10, priceBRL: 4.99 }
});
const COSMETIC_TITLES = Object.freeze({
  titulo_mestre_caldeira: 'Mestre da Caldeira',
  titulo_premium_barao: 'Barão da Fuligem'
});
const COSMETIC_BORDERS = Object.freeze({
  skin_borda_bronze: 'bronze',
  skin_borda_ouro: 'gold',
  skin_premium_cristal: 'crystal'
});
// Termos proibidos são tratados como palavras completas (Unicode), para não
// alterar por engano palavras que apenas contenham a mesma sequência de letras.
const OFFENSIVE_TERMS = Object.freeze([
  /(?<![\p{L}\p{N}_])vai\s+tomar\s+no\s+cu(?![\p{L}\p{N}_])/giu,
  /(?<![\p{L}\p{N}_])filho\s+da\s+puta(?![\p{L}\p{N}_])/giu,
  /(?<![\p{L}\p{N}_])(?:caralho|porra|merda|bosta|foda(?:-se)?|foder|fodido|puta|puto|buceta|cuz[aã]o)(?![\p{L}\p{N}_])/giu
]);

function moderateMessage(message) {
  return OFFENSIVE_TERMS.reduce((text, pattern) => text.replace(pattern, '[VAPORIZADO]'), String(message || ''));
}

function normalizeUsername(value) {
  return String(value || '').trim().toLocaleLowerCase('pt');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, keyHex] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = Buffer.from(await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function accountPayload(player) {
  return {
    id: String(player._id),
    username: player.username,
    level: player.level,
    xp: player.xp,
    currencies: {
      copper_coins: player.currencies?.copper_coins || 0,
      steam_gears: player.currencies?.steam_gears || 0,
      gold_gears: player.currencies?.gold_gears || 0
    },
    unlocked_cosmetics: player.unlocked_cosmetics || [],
    equipped_cosmetic: player.equipped_cosmetic || null,
    equipped_border: player.equipped_border || null,
    match_history: player.match_history || [],
    stats: {
      games_played: player.stats?.games_played || 0,
      victories: player.stats?.victories || 0,
      defeats: player.stats?.defeats || 0
    },
    roles_stats: player.roles_stats instanceof Map
      ? Object.fromEntries(player.roles_stats.entries())
      : (player.roles_stats?.toObject?.() || player.roles_stats || {})
  };
}

// Registo de salas conforme o contrato do lobby. O motor Game continua a ser
// a fonte de verdade das regras e é sincronizado para este objeto em memória.
const activeRooms = {};

function makeRoomCode() {
  // Cinco caracteres alfanuméricos, como o exemplo SM7A2.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join(''); } while (activeRooms[code]);
  return code;
}

function installSocketHandlers(io) {
  const games = new Map();
  const playerRooms = new Map();
  const disconnectTimers = new Map();

  function roomRoster(game) {
    return [...game.players.values()].map((p) => ({
      id: p.id, name: p.name, isReady: Boolean(p.isReady), isAlive: Boolean(p.alive),
      isHost: Boolean(p.host), isSilenced: Boolean(p.isSilenced),
      isDisconnected: Boolean(p.isDisconnected), title: p.cosmeticTitle || null, border: p.cosmeticBorder || null
    }));
  }

  function syncActiveRoom(game) {
    const room = activeRooms[game.roomCode];
    if (!room) return;
    room.gameState = game.phase;
    room.lastActivityAt = Date.now();
    room.hostId = [...game.players.values()].find((p) => p.host)?.id || '';
    room.players = [...game.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: Boolean(p.connected), isDisconnected: Boolean(p.isDisconnected), isReady: Boolean(p.isReady), isAlive: Boolean(p.alive),
      role: p.role || '', isHost: Boolean(p.host), subornedBy: p.subornedBy || null,
      isSilenced: Boolean(p.isSilenced), isMechanized: Boolean(p.isMechanized),
      bronzeCharges: p.bronzeCharges, isAlerted: Boolean(p.isAlerted)
    }));
  }

  function emitRoom(game) {
    const previousPhase = activeRooms[game.roomCode]?.gameState;
    syncActiveRoom(game);
    if (game.phase === 'DAY' && previousPhase !== 'DAY') {
      const deaths = (game.lastNightDeaths || []).map((player) => ({ name: player.name, role: getRoleInfo(player.role)?.name || 'Desconhecido' }));
      const explosionVictims = game.lastNightExplosionDeaths || [];
      const explosionMessage = explosionVictims.length
        ? `[EXPLOSÃO] Uma onda de fogo consumiu as oficinas! Incinerados: ${explosionVictims.map((player) => player.name).join(', ')}.`
        : null;
      io.to(game.roomCode).emit('dayStarted', {
        day: game.day, deaths, players: roomRoster(game), explosionMessage,
        counterattackMessage: game.lastNightCounterattackMessage
      });
    }
    for (const player of game.players.values()) {
      const socket = io.sockets.sockets.get(player.id);
      if (socket) socket.emit('gameState', game.publicState(player.id));
    }
    const voteCounts = {};
    for (const targetId of game.votes.values()) {
      if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
    io.to(game.roomCode).emit('updateVotes', voteCounts);
    if (game.phase === 'GAMEOVER' && previousPhase !== 'GAMEOVER' && game.gameOverResult) {
      if (!game.progressAwardsStarted) {
        game.progressAwardsStarted = true;
        awardMatchProgress(game, game.gameOverResult).catch((err) => {
          console.error(`❌ [PROGRESS] Falha ao processar recompensas da oficina ${game.roomCode}: ${err.message}`);
        });
      }
      io.to(game.roomCode).emit('gameOver', game.gameOverResult);
    }
    io.to(game.roomCode).emit('updatePlayers', roomRoster(game));
  }

  function getGame(socket) {
    const code = playerRooms.get(socket.id);
    return code ? games.get(code) : null;
  }

  function sendChatHistory(socket, game) {
    const player = game.getPlayer(socket.id);
    const canSeePrivate = player?.role && getFaction(player.role) === 'syndicate';
    const messages = activeRooms[game.roomCode].chatHistory.filter((entry) => !entry.private || canSeePrivate);
    socket.emit('chatHistory', messages);
  }

  function emitChat(game, entry) {
    const room = activeRooms[game.roomCode];
    if (!room) return;
    room.lastActivityAt = Date.now();
    room.chatHistory.push(entry);
    if (room.chatHistory.length > 100) room.chatHistory.splice(0, room.chatHistory.length - 100);
    const payload = { sender: entry.sender, text: entry.text, type: entry.type, at: entry.at, private: Boolean(entry.private) };
    if (entry.private) {
      for (const player of game.living().filter((p) => getFaction(p.role) === 'syndicate')) {
        io.to(player.id).emit('newMessage', payload);
        io.to(player.id).emit('chatMessage', { name: payload.sender, message: payload.text, at: payload.at, private: true, type: payload.type });
      }
    } else {
      io.to(game.roomCode).emit('newMessage', payload);
      io.to(game.roomCode).emit('chatMessage', { name: payload.sender, message: payload.text, at: payload.at, private: false, type: payload.type });
    }
  }

  function systemMessage(game, text) {
    emitChat(game, { sender: 'Sistema', text, type: 'system', at: Date.now(), private: false });
  }

  function emitLobbyMessage(game, { sender, text, type = 'player' }) {
    const room = activeRooms[game.roomCode];
    if (!room) return;
    room.lastActivityAt = Date.now();
    room.lobbyChatHistory ||= [];
    const entry = { sender, text, type, at: Date.now() };
    room.lobbyChatHistory.push(entry);
    if (room.lobbyChatHistory.length > 100) room.lobbyChatHistory.shift();
    io.to(game.roomCode).emit('newLobbyMessage', entry);
  }

  function lobbySystemMessage(game, text) {
    emitLobbyMessage(game, { sender: 'Sistema', text, type: 'system' });
  }

  function isMatchWinner(player, winnerFaction) {
    if (winnerFaction === 'steam' || winnerFaction === 'syndicate') {
      return getFaction(player.role) === winnerFaction;
    }
    const individualWinners = {
      automaton: ROLES.AUTOMATON,
      scrap: ROLES.SCRAP_COLLECTOR,
      scientist: ROLES.MAD_SCIENTIST,
      'Colecionador de Almas Mecânicas': ROLES.SOUL_COLLECTOR
    };
    return individualWinners[winnerFaction] === player.role;
  }

  async function awardMatchProgress(game, result) {
    const pendingAwards = [...game.players.values()].map(async (player) => {
      if (!player.accountUsername || !player.role) return;
      const isVictory = isMatchWinner(player, result.winnerFaction);
      const xpGained = isVictory ? 250 : 50;
      const coinsGained = isVictory ? 50 : 0;

      try {
        const profile = await Player.saveMatchResult(
          player.accountUsername, player.role, isVictory, xpGained, coinsGained
        );
        const levelsGained = Math.max(0, profile.level - (player.accountLevel || 1));
        io.to(player.id).emit('playerProgressUpdated', {
          ...accountPayload(profile),
          xpGained,
          coinsGained,
          leveledUp: levelsGained > 0,
          levelsGained
        });
        player.accountLevel = profile.level;
      } catch (err) {
        console.error(`❌ [PROGRESS] Falha ao guardar o resultado de ${player.accountUsername}: ${err.message}`);
        io.to(player.id).emit('playerProgressError', {
          message: 'A partida terminou, mas não foi possível guardar o teu progresso. Tenta novamente mais tarde.'
        });
      }
    });
    await Promise.all(pendingAwards);
  }

  function error(socket, err) {
    socket.emit('gameError', { message: err.message || 'Ocorreu um erro inesperado.' });
  }

  function registerPlayer(socket, game, name, { confirmationEvent = 'joinedRoom' } = {}) {
    if (playerRooms.has(socket.id)) throw new Error('Já estás ligado a uma oficina.');
    if (Player.db.readyState === 1 && !socket.data.account) {
      throw new Error('Inicia sessão na tua conta antes de entrar numa oficina.');
    }
    const finalName = socket.data.account?.username || name;
    const player = game.addPlayer({ id: socket.id, name: finalName });
    player.reconnectToken = randomBytes(32).toString('hex');
    if (socket.data.account) {
      player.accountUsername = socket.data.account.username;
      player.accountLevel = socket.data.account.level || 1;
      player.cosmeticTitle = COSMETIC_TITLES[socket.data.account.equipped_cosmetic] || null;
      player.cosmeticBorder = COSMETIC_BORDERS[socket.data.account.equipped_border] || null;
    }
    playerRooms.set(socket.id, game.roomCode);
    socket.join(game.roomCode);
    socket.emit(confirmationEvent, {
      roomCode: game.roomCode, playerId: player.id,
      username: player.accountUsername || player.name,
      reconnectToken: player.reconnectToken
    });
    sendChatHistory(socket, game);
    socket.emit('lobbyChatHistory', activeRooms[game.roomCode].lobbyChatHistory || []);
    if (game.phase === 'LOBBY') {
      lobbySystemMessage(game, `${player.name} conectou as engrenagens à oficina.`);
    }
    systemMessage(game, `${player.name} entrou na oficina.`);
    emitRoom(game);
    return player;
  }

  // Remove um participante tanto numa saída voluntária como numa desconexão.
  // Nas saídas voluntárias, a confirmação é enviada depois da sala estar
  // sincronizada para que o cliente só então regresse ao menu.
  function removeSocketFromRoom(socket, { confirm = false } = {}) {
    const roomCode = playerRooms.get(socket.id);
    const disconnectTimer = disconnectTimers.get(socket.id);
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimers.delete(socket.id);
    const game = roomCode ? games.get(roomCode) : null;
    if (!game) {
      playerRooms.delete(socket.id);
      if (confirm) socket.emit('leftRoom', { roomCode: roomCode || null });
      return;
    }

    const player = game.getPlayer(socket.id);
    playerRooms.delete(socket.id);
    socket.leave(roomCode);
    if (!player) {
      if (confirm) socket.emit('leftRoom', { roomCode });
      return;
    }

    game.addLog(`${player.name} saiu da oficina.`, 'system');
    game.removePlayer(socket.id);
    if (activeRooms[roomCode]) activeRooms[roomCode].lastDisconnectedAt = Date.now();

    if (game.players.size === 0) {
      game.dispose();
      games.delete(roomCode);
      delete activeRooms[roomCode];
    } else {
      // removePlayer emite o roster atualizado; esta mensagem informa os
      // restantes participantes sem incluir o socket que acabou de sair.
      systemMessage(game, `${player.name} saiu da oficina.`);
      if (game.phase === 'LOBBY') {
        lobbySystemMessage(game, `${player.name} desligou as engrenagens da oficina.`);
      }
      emitRoom(game);
    }

    if (confirm) socket.emit('leftRoom', { roomCode });
  }

  io.on('connection', (socket) => {
    socket.on('reconnectPlayer', ({ username, roomCode, reconnectToken } = {}) => {
      try {
        const code = String(roomCode || '').trim().toUpperCase();
        const cleanUsername = normalizeUsername(username);
        const game = games.get(code);
        if (!game) throw new Error('A oficina já não está disponível para reconexão.');
        if (playerRooms.has(socket.id)) throw new Error('Este socket já está ligado a uma oficina.');
        const player = [...game.players.values()].find((candidate) =>
          normalizeUsername(candidate.accountUsername || candidate.name) === cleanUsername && candidate.isDisconnected === true
        );
        if (!player) throw new Error('Não encontrámos uma sessão desligada para este utilizador.');
        const expected = Buffer.from(player.reconnectToken || '', 'hex');
        const supplied = Buffer.from(String(reconnectToken || ''), 'hex');
        if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
          throw new Error('A chave de reconexão não é válida.');
        }

        const previousId = player.id;
        // Cada uso invalida a chave anterior para que uma credencial antiga
        // não possa abrir uma sessão futura.
        player.reconnectToken = randomBytes(32).toString('hex');
        const pendingKick = disconnectTimers.get(previousId);
        if (pendingKick) clearTimeout(pendingKick);
        disconnectTimers.delete(previousId);
        playerRooms.delete(previousId);
        game.reconnectPlayer(previousId, socket.id);
        playerRooms.set(socket.id, code);
        socket.join(code);
        syncActiveRoom(game);
        socket.emit('reconnectionSuccess', {
          roomCode: code,
          playerId: socket.id,
          username: player.accountUsername || player.name,
          role: player.role,
          reconnectToken: player.reconnectToken,
          state: game.publicState(socket.id),
          chatHistory: (activeRooms[code].chatHistory || []).filter((entry) =>
            !entry.private || getFaction(player.role) === 'syndicate'
          ),
          lobbyChatHistory: activeRooms[code].lobbyChatHistory || []
        });
        emitRoom(game);
        systemMessage(game, `As engrenagens de ${player.name} voltaram a funcionar.`);
      } catch (err) {
        socket.emit('reconnectionError', { message: err.message || 'Não foi possível restaurar a sessão.' });
      }
    });

    socket.on('registerAccount', async ({ username, password } = {}) => {
      try {
        if (Player.db.readyState !== 1) {
          throw new Error('A criação de contas está indisponível: MongoDB não está conectado.');
        }
        const normalizedUsername = normalizeUsername(username);
        if (!USERNAME_PATTERN.test(normalizedUsername)) {
          throw new Error('O usuário deve ter de 2 a 20 letras, números, sublinhados ou hífens.');
        }
        if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
          throw new Error('A senha deve ter entre 8 e 128 caracteres.');
        }

        await Player.init();
        if (await Player.exists({ username: normalizedUsername })) {
          throw new Error('Esse usuário já está registado.');
        }
        const player = await Player.create({
          username: normalizedUsername,
          passwordHash: await hashPassword(password),
          level: 1,
          xp: 0
        });
        const account = accountPayload(player);
      socket.data.account = { id: account.id, username: account.username, level: account.level, equipped_cosmetic: account.equipped_cosmetic, equipped_border: account.equipped_border, unlocked_cosmetics: account.unlocked_cosmetics };
        socket.emit('registerSuccess', { account });
      } catch (err) {
        const message = err.code === 11000 ? 'Esse usuário já está registado.' : err.message;
        socket.emit('accountError', { action: 'register', message: message || 'Não foi possível criar a conta.' });
      }
    });

    socket.on('loginAccount', async ({ username, password } = {}) => {
      try {
        if (Player.db.readyState !== 1) {
          throw new Error('O acesso está indisponível: MongoDB não está conectado.');
        }
        const normalizedUsername = normalizeUsername(username);
        if (!USERNAME_PATTERN.test(normalizedUsername) || typeof password !== 'string' || password.length > 128) {
          throw new Error('Usuário ou senha incorretos.');
        }

        const player = await Player.findOne({ username: normalizedUsername }).select('+passwordHash');
        if (!player || !(await verifyPassword(password, player.passwordHash))) {
          throw new Error('Usuário ou senha incorretos.');
        }
        const account = accountPayload(player);
        socket.data.account = { id: account.id, username: account.username, level: account.level, equipped_cosmetic: account.equipped_cosmetic, equipped_border: account.equipped_border, unlocked_cosmetics: account.unlocked_cosmetics };
        socket.emit('loginSuccess', { account });
      } catch (err) {
        socket.emit('accountError', { action: 'login', message: err.message || 'Não foi possível iniciar sessão.' });
      }
    });

    socket.on('logoutAccount', () => {
      if (playerRooms.has(socket.id)) {
        socket.emit('accountError', { action: 'logout', message: 'Sai da oficina antes de terminar a sessão.' });
        return;
      }
      socket.data.account = null;
      socket.emit('logoutSuccess');
    });

    socket.on('buyCosmetic', async ({ cosmeticId } = {}) => {
      try {
        if (!socket.data.account?.username) throw new Error('Inicia sessão para comprar itens no Bazar.');
        if (Player.db.readyState !== 1) throw new Error('O Bazar está indisponível sem ligação ao MongoDB.');
        if (typeof cosmeticId !== 'string' || !Object.hasOwn(COSMETIC_PRICES, cosmeticId)) {
          throw new Error('Este artigo não existe no Bazar.');
        }
        const { type, price } = COSMETIC_PRICES[cosmeticId];
        const currencyPath = type === 'gold' ? 'currencies.gold_gears' : 'currencies.copper_coins';
        const currencyLabel = type === 'gold' ? 'Engrenagens de Ouro' : 'moedas de cobre';

        // A condição e a dedução vivem na mesma operação MongoDB: dois cliques
        // concorrentes não podem cobrar duas vezes nem deixar saldo negativo.
        const profile = await Player.findOneAndUpdate(
          {
            username: socket.data.account.username,
            unlocked_cosmetics: { $ne: cosmeticId },
            [currencyPath]: { $gte: price }
          },
          { $inc: { [currencyPath]: -price }, $push: { unlocked_cosmetics: cosmeticId } },
          { new: true, runValidators: true }
        );

        if (!profile) {
          const current = await Player.findOne({ username: socket.data.account.username });
          if (!current) throw new Error('Não foi possível localizar o teu perfil.');
          if (current.unlocked_cosmetics?.includes(cosmeticId)) throw new Error('Já adquiriste este artigo.');
          throw new Error(`Saldo insuficiente. Este artigo custa ${price} ${currencyLabel}.`);
        }
        socket.data.account.unlocked_cosmetics = profile.unlocked_cosmetics || [];
        socket.emit('purchaseSuccess', { cosmeticId, price, currency: type, account: accountPayload(profile) });
      } catch (err) {
        socket.emit('purchaseError', { message: err.message || 'Não foi possível concluir a compra.' });
      }
    });

    socket.on('buyGoldGears', async ({ packageId } = {}) => {
      try {
        if (!socket.data.account?.username) throw new Error('Inicia sessão para adquirir Engrenagens de Ouro.');
        if (Player.db.readyState !== 1) throw new Error('A loja está indisponível sem ligação ao MongoDB.');
        if (process.env.NODE_ENV === 'production') {
          throw new Error('A compra real de moeda premium ainda não está configurada. Nenhum valor foi cobrado.');
        }
        if (typeof packageId !== 'string' || !Object.hasOwn(GOLD_GEAR_PACKAGES, packageId)) {
          throw new Error('Este pacote de engrenagens não existe.');
        }

        // Em desenvolvimento, o pacote é apenas uma simulação de compra.
        // Produção nunca credita moeda sem confirmação de um gateway real.
        const pack = GOLD_GEAR_PACKAGES[packageId];
        const profile = await Player.findOneAndUpdate(
          { username: socket.data.account.username },
          { $inc: { 'currencies.gold_gears': pack.goldGears } },
          { new: true, runValidators: true }
        );
        if (!profile) throw new Error('Não foi possível localizar o teu perfil.');

        socket.emit('purchaseSuccess', {
          packageId,
          currency: 'gold',
          amount: pack.goldGears,
          priceBRL: pack.priceBRL,
          simulated: true,
          account: accountPayload(profile)
        });
      } catch (err) {
        socket.emit('purchaseError', { message: err.message || 'Não foi possível concluir a compra.' });
      }
    });

    socket.on('equipCosmetic', async (selection = {}) => {
      try {
        if (!socket.data.account?.username) throw new Error('Inicia sessão para equipar um artigo.');
        const hasTitle = Object.hasOwn(selection, 'titleId') || Object.hasOwn(selection, 'cosmeticId');
        const hasBorder = Object.hasOwn(selection, 'borderId');
        const titleId = hasTitle ? (selection.titleId ?? selection.cosmeticId ?? null) : socket.data.account.equipped_cosmetic || null;
        const borderId = hasBorder ? (selection.borderId || null) : socket.data.account.equipped_border || null;
        if (titleId && !Object.hasOwn(COSMETIC_TITLES, titleId)) throw new Error('Este título não pode ser equipado.');
        if (borderId && !Object.hasOwn(COSMETIC_BORDERS, borderId)) throw new Error('Esta moldura não pode ser equipada.');
        const filter = { username: socket.data.account.username };
        const requiredCosmetics = [titleId, borderId].filter(Boolean);
        if (requiredCosmetics.length) filter.unlocked_cosmetics = { $all: requiredCosmetics };
        const profile = await Player.findOneAndUpdate(
          filter,
          { $set: { equipped_cosmetic: titleId, equipped_border: borderId } },
          { new: true, runValidators: true }
        );
        if (!profile) throw new Error('Adquire os itens antes de os equipar.');
        socket.data.account.equipped_cosmetic = profile.equipped_cosmetic || null;
        socket.data.account.equipped_border = profile.equipped_border || null;
        socket.data.account.unlocked_cosmetics = profile.unlocked_cosmetics || [];

        const game = getGame(socket);
        if (game) {
          const player = game.getPlayer(socket.id);
          if (player) {
            player.cosmeticTitle = COSMETIC_TITLES[titleId] || null;
            player.cosmeticBorder = COSMETIC_BORDERS[borderId] || null;
          }
          emitRoom(game);
        }
        socket.emit('cosmeticEquipped', { account: accountPayload(profile) });
      } catch (err) {
        socket.emit('cosmeticEquipError', { message: err.message || 'Não foi possível equipar este artigo.' });
      }
    });

    function createRoomForPlayer(name, isDebug = false) {
      try {
        if (playerRooms.has(socket.id)) throw new Error('Já estás ligado a uma oficina.');
        const code = makeRoomCode();
        const debugMode = isDebug === true || String(name || '').trim().toLocaleLowerCase('pt') === 'yokki_qa';
        const game = new Game(code, emitRoom, { isDebug: debugMode });
        game.progressAwardsStarted = false;
        game.onSystemMessage = (text) => systemMessage(game, text);
        game.onPrivate = (playerId, payload) => {
          io.to(playerId).emit('privateEvent', payload);
          if (payload.type === 'voteConfiscated') {
            io.to(playerId).emit('newMessage', {
              sender: 'Sistema',
              text: payload.waitingForBanker
                ? 'O teu voto foi confiscado; aguarda a decisão do Banqueiro de Cobre.'
                : 'O teu voto foi confiscado e herdado pelo Banqueiro de Cobre!',
              type: 'system-warning'
            });
          }
        };
        games.set(code, game);
        const now = Date.now();
        activeRooms[code] = {
          code, gameState: 'LOBBY', hostId: '', players: [], chatHistory: [], lobbyChatHistory: [],
          isDebug: debugMode, createdAt: now, lastActivityAt: now, lastDisconnectedAt: null
        };
        const player = registerPlayer(socket, game, name);
        // Confirmação explícita usada pelo cliente para abrir o lobby.
        socket.emit('roomCreated', {
          roomCode: code, playerId: player.id,
          username: player.accountUsername || player.name,
          reconnectToken: player.reconnectToken
        });
      } catch (err) { error(socket, err); }
    }

    socket.on('createRoom', ({ name, isDebug = false } = {}) => {
      createRoomForPlayer(name, isDebug);
    });

    socket.on('findMatch', ({ name: playerName } = {}) => {
      try {
        if (playerRooms.has(socket.id)) throw new Error('Já estás ligado a uma oficina.');
        const name = String(playerName || '').trim();
        if (!name) throw new Error('Escreve o teu nome primeiro.');

        // activeRooms expõe o estado atual para matchmaking. Confirmamos também
        // o Game correspondente para evitar entrar numa sala expirada ou lotada.
        const room = Object.values(activeRooms).find((candidate) => {
          if (candidate.gameState !== 'LOBBY' || candidate.players.length >= 16 || candidate.players.length === 0) {
            return false;
          }
          const game = games.get(candidate.code);
          return Boolean(game && game.phase === 'LOBBY' && game.players.size < 16);
        });

        if (!room) {
          const isDebug = name.toLocaleLowerCase('pt') === 'yokki_qa';
          createRoomForPlayer(name, isDebug);
          return;
        }

        const game = games.get(room.code);
        registerPlayer(socket, game, name, { confirmationEvent: 'roomJoined' });
      } catch (err) { error(socket, err); }
    });

    socket.on('joinRoom', ({ roomCode, name } = {}) => {
      try {
        const code = String(roomCode || '').trim().toUpperCase();
        const game = games.get(code);
        if (!game) throw new Error('Não encontrámos essa sala. Confirma o código.');
        if (game.players.size >= 16) throw new Error('A oficina já tem 16 jogadores.');
        if (game.phase !== 'LOBBY') throw new Error('A partida já começou.');
        registerPlayer(socket, game, name);
      } catch (err) { error(socket, err); }
    });

    socket.on('sendLobbyMessage', ({ roomCode, message } = {}) => {
      try {
        const requestedCode = String(roomCode || '').trim().toUpperCase();
        const game = getGame(socket);
        const player = game?.getPlayer(socket.id);
        const room = requestedCode ? activeRooms[requestedCode] : null;
        const text = String(message || '').trim().slice(0, 500);
        if (!room || !game || game.roomCode !== requestedCode || !player) {
          throw new Error('Tens de estar ligado a essa oficina para usar o chat do lobby.');
        }
        if (game.phase !== 'LOBBY') throw new Error('O chat da oficina fecha quando a partida começa.');
        if (!text) return;
        emitLobbyMessage(game, { sender: player.name, text, type: 'player' });
      } catch (err) { error(socket, err); }
    });

    socket.on('setReady', ({ isReady } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        const player = game.setReady(socket.id, isReady);
        systemMessage(game, `${player.name} ${player.isReady ? 'está pronto' : 'ainda não está pronto'}.`);
      } catch (err) { error(socket, err); }
    });

    socket.on('playerAction', ({ action, targetId, redirectTargetId, secondTargetId, targetIds } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        if (action === 'shoot') game.shoot(socket.id, targetId);
        else game.submitAction(socket.id, action, targetId, { redirectTargetId, secondTargetId, targetIds });
      } catch (err) { error(socket, err); }
    });

    const nightActionAliases = {
      nightAction_Investigate: 'inspect',
      nightAction_Protect: 'protect',
      nightAction_Disguise: 'disguise',
      nightAction_Watch: 'watch',
      nightAction_Revive: 'revive',
      nightAction_Spy: 'spy',
      nightAction_Bribe: 'bribe',
      nightAction_Silence: 'silence'
    };
    for (const [eventName, action] of Object.entries(nightActionAliases)) {
      socket.on(eventName, ({ targetId } = {}) => {
        try {
          const game = getGame(socket);
          if (!game) throw new Error('Entra numa oficina primeiro.');
          game.submitAction(socket.id, action, targetId);
          if (game.isDebug && action === 'protect') {
            const actor = game.getPlayer(socket.id);
            const target = game.getPlayer(targetId);
            if (actor?.role === 'ALCHEMIST' && target) {
              console.log(`🛡️ [QA-MODE] ${actor.name} (Alquimista) protegeu ${target.name} na Noite ${game.day}.`);
            }
          }
        } catch (err) { error(socket, err); }
      });
    }
    socket.on('nightAction_Mechanize', ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.submitAction(socket.id, 'mechanize', targetId);
      } catch (err) { error(socket, err); }
    });
    const handlePumpOil = ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        const actor = game.getPlayer(socket.id);
        if (!actor?.alive || actor.role !== 'MAD_SCIENTIST' || game.phase !== 'NIGHT') {
          game.submitAction(socket.id, 'oil', targetId);
          return;
        }
        const target = game.getPlayer(targetId);
        if (!target?.alive || target.isOiled) {
          socket.emit('privateEvent', {
            type: 'oilPumpFailed',
            message: !target?.alive ? 'A bomba falhou: esse jogador já não está vivo.' : 'A bomba falhou: esse jogador já está coberto de óleo.'
          });
          return;
        }
        game.submitAction(socket.id, 'oil', targetId);
        if (game.isDebug) {
          console.log(`🛢️ [QA-MODE] ${actor.name} (Cientista Louco) bombeou óleo em ${target.name} na Noite ${game.day}.`);
        }
      } catch (err) { error(socket, err); }
    };
    socket.on('nightAction_PumpOil', handlePumpOil);
    socket.on('nightAction_Oil', handlePumpOil); // compatibilidade com versões anteriores do cliente
    const activateBronzeAlert = () => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.activateBronzeAlert(socket.id);
      } catch (err) { error(socket, err); }
    };
    socket.on('nightAction_ActivateAlert', activateBronzeAlert);
    socket.on('nightAction_Veteran', activateBronzeAlert); // compatibilidade com o botão antigo
    socket.on('nightAction_SkipAlert', () => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.skipBronzeAlert(socket.id);
      } catch (err) { error(socket, err); }
    });
    const handleOilDetonation = () => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        const actor = game.getPlayer(socket.id);
        game.submitAction(socket.id, 'detonateOil');
        if (game.isDebug && actor?.role === 'MAD_SCIENTIST') {
          console.log(`💥 [QA-MODE] ${actor.name} (Cientista Louco) enviou ordem de DETONAÇÃO para esta noite.`);
        }
      } catch (err) { error(socket, err); }
    };
    socket.on('nightAction_DetonateOil', handleOilDetonation);
    socket.on('nightAction_Detonate', handleOilDetonation); // compatibilidade com versões anteriores
    socket.on('nightAction_Redirect', ({ targetId, redirectTargetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.submitAction(socket.id, 'redirect', targetId, { redirectTargetId });
      } catch (err) { error(socket, err); }
    });
    socket.on('nightAction_Kill', ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        const actor = game.getPlayer(socket.id);
        game.submitAction(socket.id, actor?.role === 'AUTOMATON' ? 'automatonKill' : 'syndicateKill', targetId);
        const target = game.getPlayer(targetId);
        if (game.isDebug && actor?.role === 'SABOTEUR' && target) {
          console.log(`⚔️ [QA-MODE] ${actor.name} (Sabotador) atacou ${target.name} na Noite ${game.day}.`);
        }
      } catch (err) { error(socket, err); }
    });

    socket.on('submitVote', ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.submitVote(socket.id, targetId || null);
      } catch (err) { error(socket, err); }
    });

    socket.on('syndicateVote', ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        game.submitSyndicateVote(socket.id, targetId);
      } catch (err) { error(socket, err); }
    });

    socket.on('syndicateTargetSelection', ({ targetId } = {}) => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        const aim = game.selectSyndicateTarget(socket.id, targetId);
        for (const recipient of game.players.values()) {
          if (recipient.id === socket.id || !recipient.alive || recipient.isDisconnected || recipient.connected === false) continue;
          if (getFaction(recipient.role) !== 'syndicate') continue;
          io.to(recipient.id).emit('updateSyndicateMiras', aim);
        }
      } catch (err) { error(socket, err); }
    });

    socket.on('startGame', () => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        if (game.players.size < MIN_PLAYERS) {
          throw new Error(`São necessários pelo menos ${MIN_PLAYERS} jogadores para começar.`);
        }
        const room = activeRooms[game.roomCode];
        const host = game.getPlayer(socket.id);
        game.isDebug = Boolean(room?.isDebug || host?.name?.trim().toLocaleLowerCase('pt') === 'yokki_qa');
        game.start(socket.id);
        if (game.isDebug) {
          console.log('⚙️ [QA-MODE] Sala iniciada em Modo de Depuração. Classes injetadas manualmente.');
        }
        for (const player of game.players.values()) {
          const info = getRoleInfo(player.role);
          io.to(player.id).emit('roleAssigned', { role: player.role, info });
          io.to(player.id).emit('yourRole', {
            playerName: player.name, role: player.role, roleName: info.name,
            faction: info.faction, description: info.description, objective: info.description
          });
          if (getFaction(player.role) === 'syndicate') {
            io.to(player.id).emit('privateEvent', { type: 'syndicateMembers', members: game.publicState(player.id).syndicate });
          }
        }
      } catch (err) { error(socket, err); }
    });

    socket.on('returnToLobby', () => {
      try {
        const game = getGame(socket);
        if (!game) throw new Error('Entra numa oficina primeiro.');
        if (game.phase !== 'GAMEOVER') throw new Error('A partida ainda não terminou.');
        if (game.getPlayer(socket.id)?.host !== true) throw new Error('Só o anfitrião pode devolver a sala à oficina.');
        activeRooms[game.roomCode].chatHistory = [];
        activeRooms[game.roomCode].lobbyChatHistory = [];
        game.resetToLobby({ emit: false });
        game.progressAwardsStarted = false;
        io.to(game.roomCode).emit('roomReset', { roomCode: game.roomCode });
        lobbySystemMessage(game, 'A oficina foi preparada para uma nova partida.');
        systemMessage(game, 'A oficina foi preparada para uma nova partida.');
        game.emit();
      } catch (err) { error(socket, err); }
    });

    socket.on('leaveRoom', () => {
      try {
        removeSocketFromRoom(socket, { confirm: true });
      } catch (err) { error(socket, err); }
    });

    const handleSendMessage = ({ message } = {}) => {
      const game = getGame(socket);
      const player = game?.getPlayer(socket.id);
      const text = moderateMessage(String(message || '').trim().slice(0, 500));
      if (!game || !player || !text || !player.alive || game.ended) return;
      if (['DAY', 'VOTING'].includes(game.phase) && player.isSilenced === true) {
        socket.emit('newMessage', {
          sender: 'Sistema',
          text: 'Estás silenciado por chantagem e não podes falar hoje!',
          type: 'system-error'
        });
        return;
      }
      if (game.phase === 'NIGHT' && getFaction(player.role) !== 'syndicate') {
        socket.emit('gameError', { message: 'A comunicação está desligada durante a noite.' });
        return;
      }
      emitChat(game, { sender: player.name, text, type: 'player', at: Date.now(), private: game.phase === 'NIGHT' });
    };
    socket.on('sendMessage', handleSendMessage);
    socket.on('chatMessage', handleSendMessage); // compatibilidade com clientes anteriores

    socket.on('reportPlayer', ({ targetId } = {}) => {
      const game = getGame(socket);
      const normalizedTargetId = String(targetId || '');
      if (!game) {
        socket.emit('reportResult', { ok: false, message: 'Entra numa oficina primeiro.' });
        return;
      }

      const result = game.reportPlayer(socket.id, normalizedTargetId);
      if (!result.ok) {
        socket.emit('reportResult', { ok: false, targetId: normalizedTargetId, duplicate: Boolean(result.duplicate), message: result.reason });
        return;
      }

      socket.emit('reportResult', { ok: true, targetId: normalizedTargetId, silenced: result.silenced });
      if (result.silenced) {
        systemMessage(game, `[MODERAÇÃO] As transmissões de ${result.targetName} foram cortadas devido a denúncias do distrito.`);
      }
      // Publica imediatamente o estado de silêncio e sincroniza os clientes.
      game.emit();
    });

    // O estado de digitação só é transmitido durante a conversa pública.
    // O roomCode recebido do cliente não é confiado: a sala é resolvida pelo socket.
    socket.on('playerTyping', ({ isTyping } = {}) => {
      const game = getGame(socket);
      const player = game?.getPlayer(socket.id);
      if (!game || !player) return;
      const typing = Boolean(isTyping);
      if (typing && (!player.alive || game.ended || !['DAY', 'VOTING'].includes(game.phase) || player.isSilenced)) return;
      const payload = {
        sender: player.name,
        senderId: player.id,
        isTyping: typing
      };
      for (const recipient of game.players.values()) {
        if (recipient.id === player.id || !recipient.alive || recipient.isDisconnected || recipient.connected === false) continue;
        io.to(recipient.id).emit('playerTyping', payload);
      }
    });

    socket.on('disconnect', () => {
      const roomCode = playerRooms.get(socket.id);
      const game = roomCode ? games.get(roomCode) : null;
      const player = game?.getPlayer(socket.id);
      if (game && player && ['NIGHT', 'DAY', 'VOTING', 'GAMEOVER'].includes(game.phase)) {
        player.isDisconnected = true;
        player.connected = false;
        game.addLog(`${player.name} perdeu a ligação; a aguardar reconexão.`, 'system');
        game.emit();
        systemMessage(game, `As engrenagens de ${player.name} vacilaram. Aguardando reconexão...`);
        const timer = setTimeout(() => {
          disconnectTimers.delete(socket.id);
          if (player.isDisconnected && player.id === socket.id) removeSocketFromRoom(socket);
        }, 60_000);
        timer.unref?.();
        disconnectTimers.set(socket.id, timer);
        return;
      }
      removeSocketFromRoom(socket);
    });
  });

  return games;
}

module.exports = { activeRooms, installSocketHandlers };
