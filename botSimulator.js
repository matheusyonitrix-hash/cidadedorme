/*
 * Simulador de participantes da Oficina.
 *
 * Instalação da dependência:
 *   npm install socket.io-client
 *
 * Uso (a sala deve existir e o servidor deve estar a correr):
 *   node botSimulator.js ME9QD 7
 *
 * Opcionalmente, altera o endereço do servidor com SERVER_URL:
 *   $env:SERVER_URL = 'http://localhost:3000'
 */

const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const roomCode = String(process.argv[2] || '').trim().toUpperCase();
const botCount = Number(process.argv[3]);
const MAX_BOTS = 16;
const DAY_CHAT_MESSAGES = [
  'Eu sou um autómato de testes e acho o Sabotador suspeito!',
  'Ouvi engrenagens a ranger perto da oficina durante a noite.',
  'Proponho analisarmos as pistas antes de acender a Fornalha.',
  'Alguém consegue confirmar quem esteve na oficina do alvo?'
];
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  gold: '\u001b[33m',
  red: '\u001b[31m',
  purple: '\u001b[35m',
  green: '\u001b[32m',
  gray: '\u001b[90m',
  cyan: '\u001b[36m'
};

if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
  console.error('Uso: node botSimulator.js <CÓDIGO_DA_OFICINA> <QUANTIDADE_DE_BOTS>');
  console.error('O código da oficina deve ter cinco caracteres, por exemplo: ME9QD.');
  process.exit(1);
}

if (!Number.isInteger(botCount) || botCount < 1 || botCount > MAX_BOTS) {
  console.error(`A quantidade de bots deve ser um número inteiro entre 1 e ${MAX_BOTS}.`);
  process.exit(1);
}

const sockets = new Set();
const botRecords = [];
const debugLines = [];
let shuttingDown = false;
let rolePanelDrawn = false;

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function log(botName, message) {
  console.log(`[${botName}] ${message}`);
}

function factionColor(faction) {
  if (faction === 'steam' || /aliança|vapor/i.test(faction || '')) return ANSI.gold;
  if (faction === 'syndicate' || /sindicato|rebelde/i.test(faction || '')) return ANSI.red;
  if (faction === 'neutral' || /dissidente|neutr/i.test(faction || '')) return ANSI.purple;
  return ANSI.gray;
}

function debugLog(message) {
  debugLines.push(message);
  if (debugLines.length > 10) debugLines.shift();
  if (rolePanelDrawn) renderRolePanel();
  else console.log(`${ANSI.dim}${message}${ANSI.reset}`);
}

function renderRolePanel() {
  if (!rolePanelDrawn) return;
  console.clear();
  const border = '─'.repeat(93);
  console.log(`${ANSI.bold}${ANSI.cyan}⚙️  PAINEL DE DEPURAÇÃO — OFICINA ${roomCode}${ANSI.reset}`);
  console.log(border);
  console.log(`${ANSI.bold}${'BOT'.padEnd(25)} ${'CLASSE'.padEnd(29)} ${'FAÇÃO'.padEnd(24)} ESTADO${ANSI.reset}`);
  console.log(border);

  for (const bot of botRecords) {
    const role = bot.roleName || bot.role || 'A aguardar cargo';
    const faction = bot.factionName || bot.faction || '—';
    const destroyed = bot.status === 'DESTRUÍDO';
    const color = destroyed ? ANSI.gray : factionColor(bot.faction);
    const status = destroyed ? `${ANSI.red}[DESTRUÍDO]${ANSI.reset}` : `${ANSI.green}VIVO${ANSI.reset}`;
    console.log(
      `${bot.name.padEnd(25)} ${String(role).slice(0, 28).padEnd(29)} ` +
      `${color}${String(faction).slice(0, 23).padEnd(24)}${ANSI.reset} ${status}`
    );
  }

  console.log(border);
  console.log(`${ANSI.bold}EVENTOS RECENTES${ANSI.reset}`);
  if (debugLines.length === 0) console.log(`${ANSI.dim}A aguardar ações dos bots...${ANSI.reset}`);
  for (const line of debugLines) console.log(`${ANSI.dim}${line}${ANSI.reset}`);
}

function drawPanelWhenRolesReady() {
  if (rolePanelDrawn || botRecords.length !== botCount) return;
  if (!botRecords.every((bot) => bot.role && bot.faction)) return;
  rolePanelDrawn = true;
  console.clear();
  renderRolePanel();
}

function markDestroyed(playerId, playerName) {
  const bot = botRecords.find((record) =>
    (playerId && record.playerId === playerId) || (playerName && record.name === playerName)
  );
  if (!bot || bot.status === 'DESTRUÍDO') return;
  bot.status = 'DESTRUÍDO';
  debugLog(`☠️  ${bot.name} (${bot.roleName || bot.role || 'cargo desconhecido'}) foi eliminado.`);
}

function syncDeaths(players = []) {
  for (const player of players) {
    if (player.alive === false || player.isAlive === false) {
      markDestroyed(player.id, player.name);
    }
  }
}

function maybePerformQaNightAction(bot, gameState = bot.state) {
  if (!gameState || gameState.phase !== 'NIGHT' || !gameState.me?.alive) return;
  const night = Number(gameState.day) || 0;
  if (bot.lastNightActionDay === night) return;

  const actorRole = bot.role || gameState.me.role;
  const players = gameState.players || [];
  const host = players.find((player) => player.host);

  if (bot.name === 'Mecânico_Bot_1' && actorRole === 'MAD_SCIENTIST') {
    if (night === 3) {
      bot.lastNightActionDay = night;
      bot.socket.emit('nightAction_DetonateOil');
      debugLog(`💥 [QA-MODE] ${bot.name} (Cientista Louco) enviou ordem de DETONAÇÃO na Noite 3.`);
      return;
    }
    if (night === 1 || night === 2) {
      const targetName = night === 1 ? 'Mecânico_Bot_3' : 'Mecânico_Bot_4';
      const target = players.find((player) => player.name === targetName && player.alive);
      if (!target) {
        debugLog(`⚠️ [QA-MODE] ${bot.name}: ${targetName} não está presente/vivo na Noite ${night}.`);
        return;
      }
      bot.lastNightActionDay = night;
      bot.socket.emit('nightAction_PumpOil', { targetId: target.id });
      debugLog(`🛢️ [QA-MODE] ${bot.name} bombeou óleo em ${targetName} na Noite ${night}.`);
      return;
    }
  }

  if (bot.name === 'Mecânico_Bot_2' && actorRole === 'SABOTEUR') {
    const target = host?.alive && host.id !== bot.playerId
      ? host
      : players.find((player) => player.alive && player.id !== bot.playerId);
    if (!target) return;
    bot.lastNightActionDay = night;
    bot.socket.emit('nightAction_Kill', { targetId: target.id });
    debugLog(`⚔️ [QA-MODE] ${bot.name} (Sabotador) atacou ${target.name} na Noite ${night}.`);
    return;
  }

  // O Bot 3 protege o anfitrião, que também é o alvo prioritário do Sabotador.
  if (bot.name === 'Mecânico_Bot_3' && actorRole === 'ALCHEMIST') {
    if (!host?.alive || host.id === bot.playerId) return;
    bot.lastNightActionDay = night;
    bot.socket.emit('nightAction_Protect', { targetId: host.id });
    debugLog(`🛡️ [QA-MODE] ${bot.name} (Alquimista) protegeu ${host.name} na Noite ${night}.`);
  }
}

function scheduleDayChat(bot, currentDay) {
  if (bot.chatTimer) clearTimeout(bot.chatTimer);
  const delay = 5000 + Math.floor(Math.random() * 10001);

  bot.chatTimer = setTimeout(() => {
    bot.chatTimer = null;
    const me = bot.state?.me;
    if (shuttingDown || bot.state?.phase !== 'DAY' || !me?.alive) return;

    const message = randomItem(DAY_CHAT_MESSAGES);
    bot.socket.emit('sendMessage', { roomCode, message });
    bot.pendingChatDay = currentDay;
  }, delay);
}

function maybeVote(bot, gameState) {
  const me = gameState.me;
  if (gameState.phase !== 'VOTING' || !me?.alive) return;

  // gameState é retransmitido após várias ações. Vota apenas uma vez por dia.
  const votingDay = Number(gameState.day) || 0;
  if (bot.lastVotedDay === votingDay) return;

  const livingTargets = (gameState.players || []).filter((player) =>
    player.alive && player.id !== me.id
  );
  if (livingTargets.length === 0) return;

  const target = randomItem(livingTargets);
  bot.lastVotedDay = votingDay;
  bot.pendingVote = { day: votingDay, targetId: target.id, targetName: target.name };
  bot.socket.emit('submitVote', { targetId: target.id });
}

function createBot(index) {
  const name = `Mecânico_Bot_${index}`;
  const socket = io(SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 10000
  });
  const bot = {
    name,
    socket,
    state: null,
    chatTimer: null,
    lastVotedDay: null,
    votedLogDay: null,
    pendingVote: null,
    pendingChatDay: null,
    playerId: null,
    role: null,
    roleName: null,
    faction: null,
    factionName: null,
    status: 'VIVO',
    joined: false
  };

  sockets.add(socket);
  botRecords.push(bot);

  socket.on('connect', () => {
    log(name, `ligado ao servidor (${socket.id}); a entrar na oficina ${roomCode}.`);
    socket.emit('joinRoom', { name, roomCode });
  });

  socket.on('joinedRoom', (payload) => {
    bot.joined = true;
    bot.playerId = payload.playerId;
    log(name, `entrou na oficina ${payload.roomCode}.`);
    // O protocolo do lobby usa setReady; o anfitrião continua a iniciar a partida.
    socket.emit('setReady', { isReady: true });
  });

  socket.on('gameState', (gameState) => {
    bot.state = gameState;
    syncDeaths(gameState.players || []);
    if (gameState.phase !== 'DAY' && bot.chatTimer) {
      clearTimeout(bot.chatTimer);
      bot.chatTimer = null;
    }
    maybeVote(bot, gameState);
    maybePerformQaNightAction(bot, gameState);

    if (gameState.phase === 'VOTING' && gameState.me?.voted && bot.pendingVote) {
      const vote = bot.pendingVote;
      if (vote.day === (Number(gameState.day) || 0) && bot.votedLogDay !== vote.day) {
        bot.votedLogDay = vote.day;
        debugLog(`⚙️ [DEBUG] ${bot.name} (${bot.roleName || bot.role}) votou em ${vote.targetName}.`);
      }
    }
  });

  socket.on('yourRole', ({ role, roleName, faction, factionName } = {}) => {
    bot.role = role || 'Desconhecido';
    bot.roleName = roleName || role || 'Desconhecido';
    bot.faction = faction || 'unknown';
    bot.factionName = factionName || ({
      steam: 'Aliança de Vapor',
      syndicate: 'Sindicato Rebelde',
      neutral: 'Dissidentes'
    }[faction] || faction || 'Desconhecida');
    drawPanelWhenRolesReady();
    // O primeiro gameState da noite pode chegar antes do cargo secreto; a
    // chamada após yourRole recupera essa ação sem esperar outra atualização.
    maybePerformQaNightAction(bot);
  });

  socket.on('dayStarted', (event) => {
    for (const death of event.deaths || []) markDestroyed(null, death.name);
    // O evento inclui o roster público da manhã; sincroniza-o até chegar o
    // gameState privado do bot, para que a mensagem respeite o estado vivo.
    if (bot.state && event.players) {
      const roster = new Map(event.players.map((player) => [player.id, player]));
      bot.state.players = (bot.state.players || []).map((player) => ({
        ...player,
        ...(roster.get(player.id) || {})
      }));
      const myRosterEntry = roster.get(bot.state.me?.id);
      if (myRosterEntry && bot.state.me) bot.state.me.alive = myRosterEntry.isAlive;
    }
    if (bot.state) {
      bot.state.phase = 'DAY';
      syncDeaths(event.players || []);
      scheduleDayChat(bot, event.day);
    }
  });

  socket.on('updatePlayers', (players) => {
    syncDeaths(players);
    if (!bot.state) return;
    const roster = new Map(players.map((player) => [player.id, player]));
    bot.state.players = (bot.state.players || []).map((player) => ({
      ...player,
      ...(roster.get(player.id) || {})
    }));
    const myRosterEntry = roster.get(bot.state.me?.id);
    if (myRosterEntry && bot.state.me) bot.state.me.alive = myRosterEntry.isAlive;
  });

  socket.on('newMessage', (message) => {
    if (message?.type === 'player' && message.sender === bot.name && bot.pendingChatDay !== null) {
      debugLog(`⚙️ [DEBUG] ${bot.name} (${bot.roleName || bot.role}) enviou mensagem no chat.`);
      bot.pendingChatDay = null;
    }
  });

  socket.on('gameError', ({ message } = {}) => {
    log(name, `erro do servidor: ${message || 'erro desconhecido'}`);
  });

  socket.on('connect_error', (error) => {
    log(name, `falha de conexão: ${error.message}`);
  });

  socket.on('disconnect', (reason) => {
    if (bot.chatTimer) clearTimeout(bot.chatTimer);
    bot.chatTimer = null;
    log(name, `desligado (${reason}).`);
  });

  return bot;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} recebido; a desligar ${sockets.size} bots...`);

  for (const bot of botRecords) {
    if (bot.chatTimer) clearTimeout(bot.chatTimer);
  }
  for (const socket of sockets) {
    socket.disconnect();
  }
  sockets.clear();
  // Deixa o transporte fechar para o servidor receber os disconnects e
  // libertar as vagas antes de o processo terminar naturalmente.
  process.exitCode = signal === 'erro' ? 1 : 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  console.log(`A ligar ${botCount} bots à oficina ${roomCode} em ${SERVER_URL}...`);
  await Promise.all(Array.from({ length: botCount }, (_, index) => createBot(index + 1)));
  console.log('Bots iniciados. Pressiona Ctrl+C para os desligar.');
}

main().catch((error) => {
  console.error(`Falha ao iniciar a simulação: ${error.message}`);
  shutdown('erro');
});
