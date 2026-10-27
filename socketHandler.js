const { randomInt } = require('node:crypto');
const { Game } = require('./gameEngine');
const { MIN_PLAYERS, getFaction, getRoleInfo } = require('./roles');

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

  function roomRoster(game) {
    return [...game.players.values()].map((p) => ({
      id: p.id, name: p.name, isReady: Boolean(p.isReady), isAlive: Boolean(p.alive),
      isHost: Boolean(p.host), isSilenced: Boolean(p.isSilenced)
    }));
  }

  function syncActiveRoom(game) {
    const room = activeRooms[game.roomCode];
    if (!room) return;
    room.gameState = game.phase;
    room.lastActivityAt = Date.now();
    room.hostId = [...game.players.values()].find((p) => p.host)?.id || '';
    room.players = [...game.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: Boolean(p.connected), isReady: Boolean(p.isReady), isAlive: Boolean(p.alive),
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

  function error(socket, err) {
    socket.emit('gameError', { message: err.message || 'Ocorreu um erro inesperado.' });
  }

  function registerPlayer(socket, game, name, { confirmationEvent = 'joinedRoom' } = {}) {
    if (playerRooms.has(socket.id)) throw new Error('Já estás ligado a uma oficina.');
    const player = game.addPlayer({ id: socket.id, name });
    playerRooms.set(socket.id, game.roomCode);
    socket.join(game.roomCode);
    socket.emit(confirmationEvent, { roomCode: game.roomCode, playerId: player.id });
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
    function createRoomForPlayer(name, isDebug = false) {
      try {
        if (playerRooms.has(socket.id)) throw new Error('Já estás ligado a uma oficina.');
        const code = makeRoomCode();
        const debugMode = isDebug === true || String(name || '').trim().toLocaleLowerCase('pt') === 'yokki_qa';
        const game = new Game(code, emitRoom, { isDebug: debugMode });
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
        socket.emit('roomCreated', { roomCode: code, playerId: player.id });
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
      nightAction_Bribe: 'bribe'
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
      const text = String(message || '').trim().slice(0, 500);
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

    socket.on('disconnect', () => removeSocketFromRoom(socket));
  });

  return games;
}

module.exports = { activeRooms, installSocketHandlers };
