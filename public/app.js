(() => {
  const socket = io();
  const MIN_PLAYERS = 2;
  const $ = (id) => document.getElementById(id);
  const landing = $('landing'), game = $('game'), lobbyPanel = $('lobbyPanel'), gamePanel = $('gamePanel');
  let state = null, playerId = null, roomCode = null, selectedTargetId = null, selectedTargetIds = [], selectedSyndicateTargetId = null, secondaryTargetId = null, toastTimer = null, revealedRole = null, revealTimer = null, gameOverPayload = null;
  let typingTimeout = null, transitionTimeout = null, lastTransitionPhase = null, lastTransitionAt = 0, localIsTyping = false;
  const typingPlayers = new Map();
  const syndicateMiras = new Map();
  let accountProfile = null, matchProgress = null;
  const cosmetics = [
    { id: 'titulo_mestre_caldeira', name: 'Mestre da Caldeira', price: 150, kind: 'TÍTULO', description: 'Um título de prestígio exibido ao lado do teu nome na lista da oficina.' },
    { id: 'skin_borda_bronze', name: 'Filete de Bronze', price: 300, kind: 'MOLDURA', description: 'Uma borda de bronze para personalizar a tua identidade.' },
    { id: 'skin_borda_ouro', name: 'Filete de Ouro', price: 600, kind: 'MOLDURA', description: 'Um acabamento dourado reservado aos grandes inventores.' }
  ];
  const pendingLobbySends = [];
  // Durante a saída, eventos antigos da sala não podem voltar a abrir o lobby.
  let leavingRoom = false, leaveTimeout = null;
  const roleNames = {
    CLOCKMAKER:'Relojoeiro', ALCHEMIST:'Alquimista', INVENTOR:'Inventor', TESLA_ENGINEER:'Engenheiro de Tesla',
    BRONZE_SMITH:'Ferreiro de Bronze', MAINTENANCE_MECHANIC:'Mecânico de Manutenção', WORKER:'Operário',
    TIMEKEEPER:'Cronometrista', PRESSURE_TRAPPER:'Armadilheiro de Pressão',
    SABOTEUR:'Sabotador', SMOKE:'Cortina de Fumo', INDUSTRIAL_SPY:'Espião Industrial', PATENT_FORGER:'Falsificador de Patentes',
    ETHER_SMUGGLER:'Contrabandista de Éter', CLANDESTINE_INFORMANT:'Informador Clandestino',
    SCRAP_COLLECTOR:'Colecionador de Sucata', AUTOMATON:'Autómato Desgovernado', MAD_SCIENTIST:'Cientista Louco',
    SCRAP_GRAVEDIGGER:'Coveiro de Sucata', REVERSE_ENGINEER:'Engenheiro Reverso', ARMOR_FABRICATOR:'Fabricante de Blindagem',
    COPPER_BANKER:'Banqueiro de Cobre', SOUL_COLLECTOR:'Colecionador de Almas Mecânicas'
  };
  const factions = { steam:'Aliança de Vapor', syndicate:'Sindicato Rebelde', neutral:'Dissidentes' };
  const chatPlaceholder = 'Escreve uma mensagem…';

  // O áudio é sintetizado localmente: apenas um clique mecânico curto é usado.
  // Começa silenciado para respeitar a política de reprodução automática.
  class AudioManager {
    constructor() {
      this.context = null;
      this.master = null;
      this.muted = true;
      this.sfxNodes = new Set();
    }

    async ensureContext() {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return null;
        this.context = new Context();
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : 0.65;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context;
    }

    async toggle() {
      this.muted = !this.muted;
      const context = await this.ensureContext();
      if (context) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.65, context.currentTime, 0.06);
      this.updateToggle();
    }

    updateToggle() {
      const button = $('audioToggle');
      if (!button) return;
      button.setAttribute('aria-pressed', String(!this.muted));
      button.setAttribute('aria-label', this.muted ? 'Ativar som dos cliques' : 'Silenciar som dos cliques');
      button.title = this.muted ? 'Ativar som dos cliques' : 'Silenciar som dos cliques';
      button.textContent = this.muted ? '🔇 CLIQUES MUDOS' : '🔊 SOM DOS CLIQUES';
    }

    playSFX(sound = 'click') {
      if (this.muted) return;
      const tones = sound === 'mechanizationVictory'
        ? [
            { type: 'triangle', from: 740, to: 1040, duration: 0.18, volume: 0.045 },
            { type: 'square', from: 1480, to: 520, duration: 0.34, volume: 0.018 },
            { type: 'triangle', from: 520, to: 330, duration: 0.42, volume: 0.032 }
          ]
        : sound === 'click'
          ? [{ type: 'square', from: 880, to: 587.33, duration: 0.075, volume: 0.045 }]
          : sound === 'shopOpen'
            ? [
                { type: 'triangle', from: 740, to: 930, duration: 0.09, volume: 0.026 },
                { type: 'square', from: 620, to: 460, duration: 0.11, volume: 0.018 }
              ]
            : sound === 'purchase'
              ? [
                  { type: 'triangle', from: 1320, to: 1760, duration: 0.12, volume: 0.035 },
                  { type: 'sine', from: 1040, to: 1390, duration: 0.15, volume: 0.03 },
                  { type: 'triangle', from: 1560, to: 1170, duration: 0.2, volume: 0.024 }
                ]
              : sound === 'error'
                ? [{ type: 'triangle', from: 390, to: 250, duration: 0.13, volume: 0.022 }]
          : [];
      if (!tones.length) return;
      this.ensureContext().then(context => {
        if (!context || this.muted) return;
        const now = context.currentTime;
        tones.forEach((tone, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const startAt = now + (sound === 'mechanizationVictory' ? index * 0.055 : sound === 'purchase' ? index * 0.07 : sound === 'shopOpen' ? index * 0.035 : 0);
          oscillator.type = tone.type;
          oscillator.frequency.setValueAtTime(tone.from, startAt);
          oscillator.frequency.exponentialRampToValueAtTime(tone.to, startAt + tone.duration);
          gain.gain.setValueAtTime(0.0001, startAt);
          gain.gain.exponentialRampToValueAtTime(tone.volume, startAt + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.duration);
          oscillator.connect(gain);
          gain.connect(this.master);
          this.sfxNodes.add(oscillator);
          oscillator.onended = () => {
            this.sfxNodes.delete(oscillator);
            oscillator.disconnect();
            gain.disconnect();
          };
          oscillator.start(startAt);
          oscillator.stop(startAt + tone.duration + 0.015);
        });
      }).catch(() => {});
    }

    playShopOpenSFX() { this.playSFX('shopOpen'); }
    playPurchaseSFX() { this.playSFX('purchase'); }
    playErrorSFX() { this.playSFX('error'); }

    stopAll() {
      for (const node of this.sfxNodes) {
        try { node.stop(); } catch {}
      }
      this.sfxNodes.clear();
      this.muted = true;
      if (this.context && this.master) this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.04);
      this.updateToggle();
    }
  }

  const audioManager = window.AudioManager = new AudioManager();

  function showToast(message) {
    $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
  }

  function levelProgress(profile) {
    const level = Math.max(1, Number(profile?.level) || 1);
    const totalXp = Math.max(0, Number(profile?.xp) || 0);
    const currentLevelStart = (level * (level - 1) / 2) * 1000;
    const xpIntoLevel = Math.max(0, totalXp - currentLevelStart);
    const xpRequired = level * 1000;
    return { level, xpIntoLevel, xpRequired, percent: Math.min(100, xpIntoLevel / xpRequired * 100) };
  }

  function renderAccountProfile(profile) {
    if (!profile?.username) return;
    accountProfile = profile;
    const progress = levelProgress(profile);
    const coins = Number(profile.currencies?.copper_coins) || 0;
    $('accountProgress').classList.remove('hidden');
    $('accountProgressLabel').textContent = `${profile.username} · NÍVEL ${progress.level} · XP ${progress.xpIntoLevel}/${progress.xpRequired} · ${coins} COBRE`;
    $('accountXpBar').style.width = `${progress.percent}%`;
    renderMechanicalProfile(profile, progress, coins);
    $('openHistoryInGame').classList.remove('hidden');
    renderMatchHistory(profile.match_history || []);
    $('openBazarInGame').classList.remove('hidden');
    renderBazar();
    $('accountWelcome').textContent = `Bem-vindo, ${profile.username}. O teu progresso está guardado na caldeira.`;
    $('accountForm').classList.add('hidden');
    $('accountActions').classList.remove('hidden');
  }

  function renderMechanicalProfile(profile, progress, coins) {
    const username = profile.username || 'Mecânico';
    $('profileName').textContent = username;
    $('profileAvatar').textContent = username.slice(0, 1).toLocaleUpperCase('pt');
    $('profileLevel').textContent = `NÍVEL ${progress.level}`;
    $('profileXpBar').style.width = `${progress.percent}%`;
    $('profileXpLabel').textContent = `${progress.xpIntoLevel} / ${progress.xpRequired} XP`;
    $('profileCoins').textContent = String(coins);

    const unlocked = new Set(profile.unlocked_cosmetics || []);
    const allTitles = cosmetics.filter(item => item.kind === 'TÍTULO');
    $('equippedTitle').innerHTML = '<option value="">Sem título</option>' + allTitles.map(item =>
      unlocked.has(item.id)
        ? `<option value="${item.id}">${item.name}</option>`
        : `<option value="" disabled>🔒 ${item.name} · indisponível</option>`
    ).join('');
    $('equippedBorder').innerHTML = '<option value="">Padrão do Distrito</option>' + cosmetics.filter(item => item.kind === 'MOLDURA').map(item =>
      unlocked.has(item.id)
        ? `<option value="${item.id}">${item.name}</option>`
        : `<option value="" disabled>🔒 ${item.name} · indisponível</option>`
    ).join('');
    $('equippedTitle').value = profile.equipped_cosmetic || '';
    $('equippedBorder').value = profile.equipped_border || '';

    const stats = profile.stats || {};
    const victories = Number(stats.victories) || 0;
    const defeats = Number(stats.defeats) || 0;
    const gamesPlayed = Number(stats.games_played) || victories + defeats;
    $('profileWins').textContent = String(victories);
    $('profileDefeats').textContent = String(defeats);
    $('profileWinRate').textContent = `${gamesPlayed ? Math.round(victories / gamesPlayed * 100) : 0}%`;
    const roleStats = profile.roles_stats instanceof Map ? Object.fromEntries(profile.roles_stats) : (profile.roles_stats || {});
    const popular = Object.entries(roleStats)
      .map(([role, data]) => ({ name: roleNames[role] || role, played: Number(data?.played) || 0, won: Number(data?.won) || 0 }))
      .filter(role => role.played > 0)
      .sort((a, b) => b.played - a.played)
      .slice(0, 3);
    $('profileRoleStats').innerHTML = popular.length
      ? popular.map(role => `<div class="role-stat-row"><span>${escapeHtml(role.name)}</span><span>${role.played} partidas</span><b>${role.won} vitórias</b></div>`).join('')
      : '<p class="profile-no-stats">Ainda não há partidas registadas por classe.</p>';
  }

  function setAuthBusy(isBusy) {
    $('loginAccount').disabled = isBusy;
    $('registerAccount').disabled = isBusy;
    $('loginAccount').textContent = isBusy ? 'A verificar credenciais…' : 'Acessar Oficina ↗';
    $('registerAccount').textContent = isBusy ? 'A fundir…' : 'Fundir Nova Conta';
  }

  function acceptAccount(payload, actionLabel) {
    const profile = payload?.account || payload;
    if (!profile?.username) {
      $('authFeedback').textContent = 'O servidor respondeu sem os dados do perfil. Tenta novamente.';
      setAuthBusy(false);
      return;
    }
    $('accountPassword').value = '';
    $('authFeedback').textContent = `${actionLabel}: conta ligada e progresso sincronizado.`;
    setAuthBusy(false);
    renderAccountProfile(profile);
  }
  function renderBazar() {
    if (!accountProfile) return;
    const unlocked = new Set(accountProfile.unlocked_cosmetics || []);
    $('bazar-wallet').textContent = `Saldo: ${Number(accountProfile.currencies?.copper_coins) || 0} moedas de cobre`;
    $('bazarItems').innerHTML = cosmetics.map(item => {
      const owned = unlocked.has(item.id);
      const equipped = accountProfile.equipped_cosmetic === item.id;
      const action = !owned
        ? `<button class="bazar-buy" data-buy-cosmetic="${item.id}" type="button">Comprar · ${item.price} ⚙</button>`
        : item.id === 'titulo_mestre_caldeira'
          ? `<button class="bazar-equip" data-equip-cosmetic="${equipped ? '' : item.id}" type="button">${equipped ? 'Equipado ✓' : 'Equipar título'}</button>`
          : '<button class="bazar-buy owned" type="button" disabled>Adquirido ✓</button>';
      return `<article class="bazar-item ${owned ? 'owned' : ''}"><div class="bazar-item-mark" aria-hidden="true">${item.kind === 'TÍTULO' ? '✦' : '◈'}</div><div class="bazar-item-copy"><span class="bazar-item-kind">${item.kind}</span><h3>${item.name}</h3><p>${item.description}</p></div><div class="bazar-item-action">${owned ? '<span class="bazar-owned">ADQUIRIDO</span>' : `<span class="bazar-price">${item.price} <small>COBRE</small></span>`}${action}</div></article>`;
    }).join('');
  }
  function openBazar() {
    if (!accountProfile) return showToast('Inicia sessão para visitar o Bazar a Vapor.');
    renderBazar();
    $('bazar-modal').classList.add('active');
    $('bazar-modal').setAttribute('aria-hidden', 'false');
    audioManager.playShopOpenSFX();
  }
  function closeBazar() {
    $('bazar-modal').classList.remove('active');
    $('bazar-modal').setAttribute('aria-hidden', 'true');
  }
  function renderMatchHistory(history = []) {
    const recentMatches = Array.isArray(history) ? [...history].slice(-10).reverse() : [];
    $('historyEmpty').classList.toggle('hidden', recentMatches.length > 0);
    $('historyItems').innerHTML = recentMatches.map(match => {
      const role = roleNames[match.role] || match.role || 'Classe desconhecida';
      const parsedDate = new Date(match.date);
      const date = Number.isNaN(parsedDate.getTime()) ? 'Data indisponível' : parsedDate.toLocaleString('pt-PT', { dateStyle: 'medium', timeStyle: 'short' });
      return `<article class="history-row"><div class="history-role"><span class="section-kicker">${escapeHtml(role)}</span><time>${escapeHtml(date)}</time></div><span class="history-xp">+${Math.max(0, Number(match.xpGained) || 0)} XP</span><strong class="history-result ${match.isVictory ? 'victory' : 'defeat'}">${match.isVictory ? 'VITÓRIA' : 'DERROTA'}</strong></article>`;
    }).join('');
  }
  function openHistory() {
    if (!accountProfile) return showToast('Inicia sessão para consultar os teus registos.');
    renderMatchHistory(accountProfile.match_history || []);
    $('history-modal').classList.add('active');
    $('history-modal').setAttribute('aria-hidden', 'false');
  }
  function closeHistory() {
    $('history-modal').classList.remove('active');
    $('history-modal').setAttribute('aria-hidden', 'true');
  }
  let leaderboardController = null;
  function renderLeaderboardRows(items, metric) {
    if (!items?.length) return '<p class="leaderboard-empty">Ainda não há registos nesta caldeira.</p>';
    return items.map((player, index) => {
      const value = metric === 'level'
        ? `NÍVEL ${Number(player.level) || 1}`
        : `${(Number(player.copper_coins) || 0).toLocaleString('pt-PT')} COBRE`;
      return `<div class="leaderboard-row"><span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span><span class="leaderboard-username">${escapeHtml(player.username || 'Mecânico')}</span><strong class="leaderboard-value">${value}</strong></div>`;
    }).join('');
  }
  async function openLeaderboard() {
    const modal = $('leaderboard-modal');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    $('prestigeLeaderboard').innerHTML = '<p class="leaderboard-empty">A consultar os registos…</p>';
    $('fortuneLeaderboard').innerHTML = '<p class="leaderboard-empty">A consultar os registos…</p>';
    $('leaderboardFeedback').textContent = '';
    leaderboardController?.abort();
    leaderboardController = new AbortController();
    try {
      const response = await fetch('/leaderboard', { cache: 'no-store', signal: leaderboardController.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível carregar o ranking.');
      $('prestigeLeaderboard').innerHTML = renderLeaderboardRows(data.prestige, 'level');
      $('fortuneLeaderboard').innerHTML = renderLeaderboardRows(data.fortunes, 'coins');
    } catch (error) {
      if (error.name === 'AbortError') return;
      $('prestigeLeaderboard').replaceChildren();
      $('fortuneLeaderboard').replaceChildren();
      $('leaderboardFeedback').textContent = error.message || 'A Mesa de Engenharia está indisponível.';
    }
  }
  function closeLeaderboard() {
    leaderboardController?.abort();
    leaderboardController = null;
    $('leaderboard-modal').classList.remove('active');
    $('leaderboard-modal').setAttribute('aria-hidden', 'true');
    $('prestigeLeaderboard').replaceChildren();
    $('fortuneLeaderboard').replaceChildren();
    $('leaderboardFeedback').textContent = '';
  }
  const classesModal = $('classes-modal');
  const classesOpenButton = $('classes-manual-open');
  let classesCloseTimer = null;
  function openClassesManual() {
    clearTimeout(classesCloseTimer);
    classesModal.classList.remove('hidden');
    classesModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('classes-manual-open');
    requestAnimationFrame(() => classesModal.classList.add('active'));
    $('classes-modal-close').focus();
  }
  function closeClassesManual() {
    if (classesModal.classList.contains('hidden')) return;
    classesModal.classList.remove('active');
    classesModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('classes-manual-open');
    classesCloseTimer = setTimeout(() => classesModal.classList.add('hidden'), 260);
    classesOpenButton.focus();
  }
  classesOpenButton.addEventListener('click', openClassesManual);
  $('classes-modal-close').addEventListener('click', closeClassesManual);
  $('classes-modal-close-footer').addEventListener('click', closeClassesManual);
  classesModal.addEventListener('click', event => {
    if (event.target === classesModal || event.target.closest('[data-close-classes]')) closeClassesManual();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && classesModal.classList.contains('active')) closeClassesManual();
  });
  function enterRoom(data) {
    if (leavingRoom) return;
    hideReconnectScreen();
    roomCode = data.roomCode; playerId = data.playerId;
    if (data.reconnectToken) {
      sessionStorage.setItem('cidadeDormeReconnect', JSON.stringify({
        username: data.username || accountProfile?.username || state?.players?.find(player => player.id === playerId)?.name || '',
        roomCode,
        reconnectToken: data.reconnectToken
      }));
    }
    matchProgress = null;
    $('roomCodeLabel').textContent = roomCode;
    $('openLeaderboard').classList.remove('hidden');
    landing.classList.add('hidden'); game.classList.remove('hidden');
    // Mostra já a oficina, sem esperar pelo primeiro gameState do servidor.
    lobbyPanel.classList.remove('hidden');
    gamePanel.classList.add('hidden');
    const lobbyChat = document.querySelector('.lobby-chat-container');
    if (lobbyChat) lobbyChat.style.display = 'flex';
    $('lobby-chat-input').disabled = false;
    $('btn-send-lobby-message').disabled = false;
  }
  function showReconnectScreen() {
    const screen = $('reconnect-screen');
    screen.style.display = 'grid';
    screen.setAttribute('aria-hidden', 'false');
    landing.classList.add('hidden');
    game.classList.add('hidden');
    clearTimeout(transitionTimeout);
    $('transition-overlay').classList.remove('is-active');
    $('transition-overlay').setAttribute('aria-hidden', 'true');
  }
  function hideReconnectScreen() {
    const screen = $('reconnect-screen');
    if (!screen) return;
    screen.style.display = 'none';
    screen.setAttribute('aria-hidden', 'true');
  }
  function returnToMenu() {
    audioManager.stopAll();
    syndicateMiras.clear();
    hideReconnectScreen();
    clearTimeout(typingTimeout);
    clearTimeout(transitionTimeout);
    clearTypingPlayers();
    lastTransitionPhase = null;
    $('transition-overlay').classList.remove('is-active');
    $('transition-overlay').setAttribute('aria-hidden','true');
    state = null;
    playerId = null;
    roomCode = null;
    sessionStorage.removeItem('cidadeDormeReconnect');
    clearTargetSelection();
    revealedRole = null;
    gameOverPayload = null;
    clearTimeout(revealTimer);
    clearTimeout(leaveTimeout);
    $('roomInput').value = '';
    $('chatMessages').innerHTML = '<div class="chat-empty">As ondas estão em silêncio.<br>Envia a primeira mensagem.</div>';
    $('lobby-chat-messages').innerHTML = '<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
    $('playersList').innerHTML = '';
    $('lobbyPlayers').innerHTML = '';
    $('actionArea').innerHTML = '';
    $('victoryBanner').classList.add('hidden');
    $('roleRevealModal').classList.add('hidden');
    $('classes-modal').classList.add('hidden');
    document.body.classList.remove('night-phase', 'game-over', 'role-reveal-open', 'classes-manual-open');
    lobbyPanel.classList.add('hidden');
    gamePanel.classList.add('hidden');
    game.classList.add('hidden');
    landing.classList.remove('hidden');
    leavingRoom = false;
  }
  function leaveWorkshop() {
    if (leavingRoom) return;
    if (!roomCode) {
      returnToMenu();
      return;
    }
    leavingRoom = true;
    socket.emit('leaveRoom');
    // Se a resposta do servidor não chegar, manter a sessão segura e informar.
    leaveTimeout = setTimeout(() => {
      if (!leavingRoom) return;
      leavingRoom = false;
      showToast('O servidor ainda não confirmou a saída. Tenta novamente.');
    }, 5000);
  }
  function render() {
    if (!state) return;
    const currentMe = state.me || {};
    const chatIsSilenced = ['DAY','VOTING'].includes(state.phase) && Boolean(currentMe.isSilenced ?? currentMe.silencedToday);
    $('chatInput').disabled = !currentMe.alive || chatIsSilenced;
    $('chatInput').placeholder = chatIsSilenced
      ? '[SILENCIADO: Foste chantageado pelo Informador Clandestino]'
      : chatPlaceholder;
    $('chatInput').classList.toggle('silenced-input', chatIsSilenced);
    $('chatForm').classList.toggle('chat-silenced', chatIsSilenced);
    document.body.classList.toggle('night-phase', state.phase === 'NIGHT');
    const inLobby = state.phase === 'LOBBY';
    // A fase é a fonte de verdade. Uma flag ended antiga não deve sobrepor
    // uma transição já recebida para LOBBY.
    const isGameOver = state.phase === 'GAMEOVER';
    lobbyPanel.classList.toggle('hidden', !inLobby);
    $('openLeaderboard').classList.toggle('hidden', !inLobby);
    gamePanel.classList.toggle('hidden', inLobby || isGameOver);
    $('victoryBanner').classList.toggle('hidden', !isGameOver);
    document.body.classList.toggle('game-over', isGameOver);
    if (isGameOver) {
      renderGameOver();
      return;
    }
    if (inLobby) {
      $('lobbyCount').innerHTML = `${String(state.players.length).padStart(2,'0')} <span>/ ${String(MIN_PLAYERS).padStart(2,'0')} MÍNIMO</span>`;
      $('rosterCount').textContent = String(state.players.length).padStart(2,'0');
      const lobbySlots = Array.from({ length: 16 }, (_, index) => state.players[index] || null);
      $('lobbyPlayers').innerHTML = lobbySlots.map((p, index) => p
        ? `<div class="roster-row ${p.isDisconnected?'roster-disconnected':''} ${p.border==='bronze'?'frame-bronze':p.border==='gold'?'frame-gold':''}"><div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><span>${escapeHtml(p.name)}</span>${p.title?`<small class="player-cosmetic-title">${escapeHtml(p.title)}</small>`:''}${p.isDisconnected?'<small class="disconnect-mark">A RECONECTAR</small>':''}${p.host?'<span class="host-mark">ANFITRIÃO</span>':''}${p.isReady?'<span class="ready-mark">PRONTO</span>':''}</div>`
        : `<div class="roster-row empty"><div class="avatar">${String(index + 1).padStart(2,'0')}</div><span>[Vago]</span></div>`).join('');
      const me = state.players.find(p=>p.id===playerId);
      $('readyButton').textContent = me?.isReady ? 'Cancelar pronto' : 'Marcar como pronto';
      $('readyButton').disabled = !me;
      $('startGame').disabled = !me?.host || state.players.length < MIN_PLAYERS;
      $('startGame').style.opacity = $('startGame').disabled ? '.45' : '1';
      $('hostHint').textContent = me?.host ? (state.players.length < MIN_PLAYERS ? `Faltam ${MIN_PLAYERS-state.players.length} jogadores para começar.` : 'A tripulação está pronta.') : 'Apenas o anfitrião pode iniciar a partida.';
      return;
    }
    const me = state.me || {};
    const role = state.roleInfo;
    $('dayLabel').textContent = `${state.phase === 'NIGHT' ? 'NOITE' : state.phase === 'VOTING' ? 'VOTAÇÃO' : 'DIA'} ${String(state.day).padStart(2,'0')}`;
    $('phaseIcon').textContent = state.phase === 'NIGHT' ? '☾' : state.phase === 'VOTING' ? '⚖' : '☀';
    $('phaseTitle').innerHTML = state.phase === 'NIGHT' ? 'A cidade<br><em>dorme.</em>' : state.phase === 'VOTING' ? 'A Fornalha<br><em>aguarda.</em>' : 'A cidade<br><em>desperta.</em>';
    const phaseHint = state.phase === 'NIGHT' ? 'A noite termina quando todos agirem.' : state.phase === 'VOTING' ? `${state.voteCount} voto(s) registado(s).` : 'A discussão está aberta.';
    $('phaseHint').textContent = state.testMode ? `MODO DE TESTE · ${phaseHint}` : phaseHint;
    $('timerText').textContent = `${state.secondsLeft}s`;
    $('timerBar').style.width = `${Math.min(100,state.secondsLeft/(state.phase==='NIGHT'?45:state.phase==='VOTING'?30:60)*100)}%`;
    $('roleName').textContent = role?.name || '—';
    $('roleDescription').textContent = role?.description || '—';
    $('roleFaction').textContent = factions[role?.faction] || '—';
    $('roleFaction').className = `faction-tag ${role?.faction || ''}`;
    $('ammoInfo').classList.toggle('hidden', me.role !== 'INVENTOR');
    $('ammoInfo').textContent = `MUNIÇÃO · ${me.bullets ?? 0} DISPARO(S)`;
    $('aliveCount').textContent = String(state.players.filter(p=>p.alive).length).padStart(2,'0');
    $('syndicateBox').classList.toggle('hidden', !['SABOTEUR','SMOKE','INDUSTRIAL_SPY','PATENT_FORGER','ETHER_SMUGGLER','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(me.role));
    $('syndicateList').innerHTML = (state.syndicate||[]).map(p=>`<div class="syndicate-member">⚙ ${escapeHtml(p.name)}${p.id===playerId?' · tu':''}</div>`).join('');
    renderPlayers(); renderActions();
  }
  function renderPlayers() {
    $('playersList').innerHTML = state.players.map((p) => {
      const self = p.id === playerId;
      const canTarget = targetable(p);
      const role = p.role ? roleNames[p.role] : null;
      const selected = selectedTargetId === p.id || selectedTargetIds.includes(p.id) || selectedSyndicateTargetId === p.id || secondaryTargetId === p.id;
      const aimingMembers = [...syndicateMiras.values()].filter(mira => mira.targetId === p.id);
      const aimLabel = aimingMembers.map(mira => `<span class="syndicate-aim-label">⌖ ${escapeHtml(mira.senderName)} mira aqui</span>`).join('');
      const votes = state.voteCounts?.[p.id] || 0;
      const bribedClass = self && state.me?.bribeVoteControlled ? 'bribed-vote' : '';
      const bribeBadge = self && state.me?.bribeVoteLocked ? '<span class="bribe-badge" title="O teu voto foi confiscado">🪙 VOTO HERDADO</span>' : '';
      const badge = state.phase === 'VOTING' ? `<span class="vote-count" aria-label="${votes} voto(s)">⚙ ${votes}</span>` : '';
      return `<div class="player-row ${p.alive?'':'dead'} ${p.border==='bronze'?'frame-bronze':p.border==='gold'?'frame-gold':''} ${p.isDisconnected?'player-disconnected':''} ${selected?'selected selected-card':''} ${canTarget?'selectable-card':''} ${aimingMembers.length?'syndicate-aim':''} ${state.phase==='VOTING'?'voting-card':''} ${bribedClass}" ${canTarget?`data-select-target="${escapeHtml(p.id)}" role="button" tabindex="0" aria-pressed="${selected}"`:''}>${badge}<div class="player-avatar">${p.alive?'⚙':'†'}</div><span class="player-name">${escapeHtml(p.name)}${self?' (tu)':''}${p.title?` <small class="player-cosmetic-title">${escapeHtml(p.title)}</small>`:''}</span>${bribeBadge}${role?`<span class="player-role">${escapeHtml(role)}</span>`:`<span class="player-state ${p.alive?'alive':'dead'}">${p.alive?(p.isDisconnected?'[A RECONECTAR]':'VIVO'):'[DESTRUÍDO]'}</span>`}${aimLabel}${canTarget?'<span class="direct-target-hint">CLICAR PARA SELECIONAR</span>':''}</div>`;
    }).join('');
  }
  function targetable(p) {
    const role = state.me?.role;
    if (state.phase === 'NIGHT') {
      const syndicateVoter = ['SABOTEUR','SMOKE','INDUSTRIAL_SPY','PATENT_FORGER','ETHER_SMUGGLER','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role);
      const syndicateIds = (state.syndicate || []).map(member => member.id);
      const isSyndicateEnemy = p.alive && p.id !== playerId && !syndicateIds.includes(p.id);
      if (syndicateVoter && isSyndicateEnemy) return true;
      if (role === 'MAINTENANCE_MECHANIC') return !state.me.revivalUsed && !p.alive && p.id !== playerId;
      if (role === 'SOUL_COLLECTOR') return p.alive && !p.isMechanized;
      if (role === 'REVERSE_ENGINEER') {
        const candidates = state.me.reverseCandidates || [];
        if (!selectedTargetId || !candidates.some(candidate => candidate.deadTargetId === selectedTargetId))
          return candidates.some(candidate => candidate.deadTargetId === p.id);
        return candidates.some(candidate => candidate.deadTargetId === selectedTargetId && candidate.suspectId === p.id);
      }
      if (role === 'ARMOR_FABRICATOR') return !state.me.armorUsed && p.alive;
      if (role === 'SCRAP_GRAVEDIGGER') return p.alive && p.id !== playerId;
      if (role === 'MAD_SCIENTIST') return p.alive && p.id !== playerId && !state.me.actionSubmitted;
      if (role === 'ETHER_SMUGGLER') return p.alive && p.id !== playerId;
      if (!p.alive || p.id === playerId) return false;
      const teammateIds = (state.syndicate || []).map(member => member.id);
      if (role === 'SMOKE') return teammateIds.includes(p.id);
      if (role === 'SABOTEUR') return !teammateIds.includes(p.id);
      return ['CLOCKMAKER','ALCHEMIST','AUTOMATON','TESLA_ENGINEER','INDUSTRIAL_SPY','PRESSURE_TRAPPER','CLANDESTINE_INFORMANT','COPPER_BANKER','PATENT_FORGER'].includes(role);
    }
    if (!p.alive || p.id === playerId) return false;
    if (state.phase === 'VOTING') return !state.me?.bribeVoteLocked;
    return state.phase === 'DAY' && role === 'INVENTOR' && (state.me?.bullets || 0) > 0;
  }
  function clearTargetSelection() {
    selectedTargetId = null;
    selectedTargetIds = [];
    selectedSyndicateTargetId = null;
    secondaryTargetId = null;
  }
  function renderTypingIndicator() {
    const indicator = $('chatTypingIndicator');
    if (!indicator) return;
    const names = [...typingPlayers.values()].map(entry => entry.name);
    indicator.replaceChildren();
    indicator.setAttribute('aria-hidden', names.length ? 'false' : 'true');
    indicator.classList.toggle('is-visible', names.length > 0);
    if (!names.length) return;
    const gear = document.createElement('span');
    gear.className = 'typing-gear';
    gear.setAttribute('aria-hidden', 'true');
    gear.textContent = '⚙';
    const label = document.createElement('span');
    label.textContent = names.length === 1
      ? `${names[0]} está a operar os transmissores…`
      : `${names.join(', ')} estão a operar os transmissores…`;
    indicator.append(gear, label);
  }
  function clearTypingPlayers() {
    for (const entry of typingPlayers.values()) clearTimeout(entry.timeout);
    typingPlayers.clear();
    renderTypingIndicator();
  }
  function sendTypingStatus(isTyping) {
    if (!state || !roomCode) return;
    if (isTyping && (!['DAY','VOTING'].includes(state.phase) || $('chatInput').disabled)) return;
    if (localIsTyping === Boolean(isTyping)) return;
    localIsTyping = Boolean(isTyping);
    socket.emit('playerTyping', { roomCode, isTyping });
  }
  function animatePhaseTransition(phase) {
    const overlay = $('transition-overlay');
    if (!overlay || !['NIGHT','DAY','VOTING'].includes(phase)) return;
    const now = Date.now();
    if (phase === lastTransitionPhase && now - lastTransitionAt < 1500) return;
    lastTransitionPhase = phase;
    lastTransitionAt = now;
    $('transition-caption-text').textContent = phase === 'NIGHT'
      ? 'AS ESCOTILHAS FECHAM · A ENGRENAGEM GIRA'
      : phase === 'VOTING' ? 'O TRIBUNAL DE BRONZE É CONVOCADO' : 'AS ESCOTILHAS ABREM · O DIA REGRESSA';
    clearTimeout(transitionTimeout);
    overlay.classList.remove('is-active');
    overlay.setAttribute('aria-hidden', 'false');
    void overlay.offsetWidth;
    overlay.classList.add('is-active');
    transitionTimeout = setTimeout(() => {
      overlay.classList.remove('is-active');
      overlay.setAttribute('aria-hidden', 'true');
    }, 1500);
  }
  function selectPlayerCard(targetId) {
    const player = state?.players.find(candidate => candidate.id === targetId);
    if (!player || !targetable(player)) return;
    const role = state.me?.role;
    const teammates = (state.syndicate || []).map(member => member.id);
    const canCastSyndicateVote = state.phase === 'NIGHT' && ['SABOTEUR','SMOKE','INDUSTRIAL_SPY','PATENT_FORGER','ETHER_SMUGGLER','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role) && player.alive && player.id !== playerId && !teammates.includes(player.id);
    if (canCastSyndicateVote) {
      selectedSyndicateTargetId = targetId;
      socket.emit('syndicateTargetSelection', { targetId });
    }

    if (state.phase === 'NIGHT' && ['ARMOR_FABRICATOR','ETHER_SMUGGLER','SCRAP_GRAVEDIGGER'].includes(role)) {
      const limit = role === 'ARMOR_FABRICATOR' ? 3 : 2;
      const wasSelected = selectedTargetIds.includes(targetId);
      if (wasSelected) selectedTargetIds = selectedTargetIds.filter(id => id !== targetId);
      else if (selectedTargetIds.length < limit) selectedTargetIds.push(targetId);
      else return showToast(`Seleciona no máximo ${limit} pessoas.`);
      if (role === 'ETHER_SMUGGLER') {
        selectedTargetId = selectedTargetIds[0] || null;
        secondaryTargetId = selectedTargetIds[1] || null;
      } else if (role === 'SCRAP_GRAVEDIGGER') {
        selectedTargetId = selectedTargetIds[0] || null;
        secondaryTargetId = selectedTargetIds[1] || null;
      } else selectedTargetId = selectedTargetIds.at(-1) || null;
    } else if (state.phase === 'NIGHT' && role === 'REVERSE_ENGINEER') {
      const candidates = state.me.reverseCandidates || [];
      const selectedDead = candidates.some(candidate => candidate.deadTargetId === selectedTargetId);
      if (!selectedDead || !candidates.some(candidate => candidate.deadTargetId === selectedTargetId && candidate.suspectId === targetId)) {
        selectedTargetId = targetId;
        secondaryTargetId = null;
      } else secondaryTargetId = targetId;
    } else if (canCastSyndicateVote) {
      selectedSyndicateTargetId = targetId;
      // Nas classes com ação própria contra inimigos, o mesmo clique também escolhe o alvo da habilidade.
      if (['SABOTEUR','INDUSTRIAL_SPY','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role)) selectedTargetId = targetId;
    } else {
      selectedTargetId = targetId;
      selectedTargetIds = [targetId];
      secondaryTargetId = null;
    }
    renderPlayers();
    renderActions();
  }
  function renderActions() {
    const area = $('actionArea');
    const role = state.me?.role, phase = state.phase;
    const canShoot = role === 'INVENTOR' && ['DAY','VOTING'].includes(phase) && state.me.bullets > 0;
    const selectedName = state.players.find(player => player.id === selectedTargetId)?.name;
    const secondName = state.players.find(player => player.id === secondaryTargetId)?.name;
    const selectionNote = selectedName ? `<span class="target-selection-note">Alvo: ${escapeHtml(selectedName)}${secondName?` · ${escapeHtml(secondName)}`:''}</span>` : '<span class="target-selection-note">Clica num card elegível para escolher.</span>';
    const button = (id, label, disabled=false, className='button action-button') => `<button id="${id}" class="${className}" ${disabled?'disabled':''}>${label}</button>`;
    const syndicateVoteButton = () => {
      if (phase !== 'NIGHT' || !['SMOKE','INDUSTRIAL_SPY','PATENT_FORGER','ETHER_SMUGGLER','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role)) return '';
      return button('syndicateVoteSubmit', selectedSyndicateTargetId ? `DEFINIR ATAQUE · ${escapeHtml(state.players.find(p=>p.id===selectedSyndicateTargetId)?.name||'ALVO')}` : 'DEFINIR ATAQUE DO SINDICATO', !selectedSyndicateTargetId, 'button syndicate-vote-action');
    };
    if (phase === 'NIGHT' && role === 'BRONZE_SMITH') {
      const submitted=state.me.actionSubmitted, charges=state.me.bronzeCharges||0, alerted=Boolean(state.me.isAlerted);
      const buttonText=alerted?'🔒 OFICINA TRANCADA · ALERTA MÁXIMO':`🔥 Ativar Fornalha de Pressão (Cargas: ${charges}/2)`;
      area.innerHTML=`<div class="action-prompt">FERREIRO DE BRONZE · ${alerted?'OS VISITANTES SERÃO CONSUMIDOS PELO VAPOR':charges>0?'A FORNALHA PODE SER ARMADA DUAS VEZES POR PARTIDA':'CARGAS ESGOTADAS'}</div><div class="action-row">${button('veteranActivate',buttonText,submitted||charges<=0,`button forge-alert-button ${alerted?'is-alerted':''}`)}${charges>0&&!submitted?button('veteranSkip','GUARDAR CARGA'):''}</div>`;
      $('veteranActivate').onclick=()=>socket.emit('nightAction_ActivateAlert');
      if($('veteranSkip')) $('veteranSkip').onclick=()=>socket.emit('nightAction_SkipAlert');
      return;
    }
    if (phase === 'NIGHT' && role === 'TIMEKEEPER') {
      const submitted=state.me.actionSubmitted, used=state.me.timeRewindUsed;
      area.innerHTML=`<div class="action-prompt">CRONOMETRISTA · ${used?'RETROCESSO JÁ UTILIZADO':'PODE IMPEDIR UMA MORTE ESTA NOITE'}</div><div class="action-row">${button('rewindSubmit',used?'JÁ UTILIZADO':submitted?'RETROCESSO ARMADO':'ATIVAR RETROCESSO ↶',submitted||used)}</div>`;
      $('rewindSubmit').onclick=()=>socket.emit('playerAction',{action:'rewind'});
      return;
    }
    if (phase === 'NIGHT' && role === 'REVERSE_ENGINEER') {
      const candidates=state.me.reverseCandidates||[];
      const deadCandidate=candidates.find(candidate=>candidate.deadTargetId===selectedTargetId);
      const validSuspect=deadCandidate&&candidates.some(candidate=>candidate.deadTargetId===selectedTargetId&&candidate.suspectId===secondaryTargetId);
      area.innerHTML=`<div class="action-prompt">ENGENHEIRO REVERSO · CLICA NUM CARD DE JOGADOR ELIMINADO E DEPOIS NUM DOS SEUS VOTANTES.</div><div class="action-row">${selectionNote}${button('reverseSubmit','ANALISAR VOTO ↗',state.me.actionSubmitted||!validSuspect)}</div>`;
      $('reverseSubmit').onclick=()=>{if(!validSuspect)return showToast('Seleciona uma pessoa eliminada e depois um dos seus votantes.');socket.emit('playerAction',{action:'reverseAnalyze',targetId:selectedTargetId,secondTargetId});};
      return;
    }
    if (phase === 'NIGHT' && role === 'ARMOR_FABRICATOR') {
      area.innerHTML=`<div class="action-prompt">FABRICANTE DE BLINDAGEM · CLICA EM ATÉ TRÊS CARDS VIVOS PARA ATRIBUIR PLACAS.</div><div class="action-row">${selectionNote}<span class="target-selection-count">${selectedTargetIds.length}/3 placas</span>${button('armorSubmit',state.me.armorUsed?'PLACAS UTILIZADAS':'FORJAR PLACAS ↗',state.me.actionSubmitted||state.me.armorUsed||!selectedTargetIds.length)}</div>`;
      $('armorSubmit').onclick=()=>socket.emit('playerAction',{action:'armor',targetIds:[...selectedTargetIds]});
      return;
    }
    if (phase === 'NIGHT' && role === 'ETHER_SMUGGLER') {
      area.innerHTML=`<div class="action-prompt">CONTRABANDISTA DE ÉTER · CLICA EM DOIS HABITANTES PARA TROCAR AS IDENTIDADES DE INSPEÇÃO.</div><div class="action-row">${selectionNote}${button('swapSubmit','TROCAR IDENTIDADES ↗',state.me.actionSubmitted||selectedTargetIds.length!==2)}${syndicateVoteButton()}</div>`;
      $('swapSubmit').onclick=()=>socket.emit('playerAction',{action:'swapInspection',targetId:selectedTargetIds[0],secondTargetId:selectedTargetIds[1]});
      if($('syndicateVoteSubmit')) $('syndicateVoteSubmit').onclick=()=>socket.emit('syndicateVote',{targetId:selectedSyndicateTargetId});
      return;
    }
    if (phase === 'NIGHT' && role === 'SCRAP_GRAVEDIGGER') {
      area.innerHTML=`<div class="action-prompt">COVEIRO DE SUCATA · CLICA NO JOGADOR AFETADO E DEPOIS NO NOVO ALVO.</div><div class="action-row">${selectionNote}${button('redirectSubmit','DESVIAR AÇÃO ↗',state.me.actionSubmitted||selectedTargetIds.length!==2)}</div>`;
      $('redirectSubmit').onclick=()=>{if(selectedTargetIds[0]===selectedTargetIds[1])return showToast('O novo alvo tem de ser diferente.');socket.emit('nightAction_Redirect',{targetId:selectedTargetIds[0],redirectTargetId:selectedTargetIds[1]});};
      return;
    }
    if (phase === 'NIGHT' && role === 'MAD_SCIENTIST') {
      const oilCount=state.me.oiledTargets||0, detonated=Boolean(state.me.detonationTriggered), submitted=Boolean(state.me.actionSubmitted);
      area.innerHTML=`<div class="action-prompt">CIENTISTA LOUCO · ${oilCount} ALVO(S) OLEADO(S). ESCOLHE UM HABITANTE PARA BOMBEAR ÓLEO.</div><div class="action-row">${selectionNote}${button('oilSubmit','BOMBEAR ÓLEO ↗',submitted||!selectedTargetId)}${button('detonateSubmit',detonated?'VÁLVULA ATIVADA':'💥 ATIVAR DETONADOR',submitted||!oilCount||detonated,'button detonation-button')}</div>`;
      $('oilSubmit').onclick=()=>socket.emit('nightAction_PumpOil',{targetId:selectedTargetId});
      $('detonateSubmit').onclick=()=>socket.emit('nightAction_DetonateOil');
      return;
    }
    if (phase === 'NIGHT') {
      const actionConfig={
        CLOCKMAKER:{label:'ESCOLHE QUEM INVESTIGAR',action:'inspect'}, ALCHEMIST:{label:'ESCOLHE QUEM PROTEGER',action:'protect'},
        SABOTEUR:{label:'ESCOLHE O ALVO DO SINDICATO',event:'nightAction_Kill'}, SMOKE:{label:'ESCOLHE O ALIADO A DISFARÇAR',action:'disguise'},
        AUTOMATON:{label:'ESCOLHE QUEM ELIMINAR',action:'automatonKill'}, TESLA_ENGINEER:{label:'ESCOLHE QUEM VIGIAR',action:'watch'},
        INDUSTRIAL_SPY:{label:'ESCOLHE QUEM IDENTIFICAR',action:'spy'}, MAINTENANCE_MECHANIC:{label:state.me.revivalUsed?'RESSURREIÇÃO JÁ UTILIZADA':'ESCOLHE QUEM RESSUSCITAR',action:'revive'},
        PRESSURE_TRAPPER:{label:'ESCOLHE ONDE ARMAR A ARMADILHA',action:'trap'}, CLANDESTINE_INFORMANT:{label:'ESCOLHE QUEM SILENCIAR AMANHÃ',action:'silence'},
        COPPER_BANKER:{label:'ESCOLHE QUEM SUBORNAR',action:'bribe'}, SOUL_COLLECTOR:{label:`COLECIONADOR DE ALMAS · ${state.me.mechanizedCount||0} MECANIZADO(S) · ESCOLHE UM ALVO`,event:'nightAction_Mechanize'}
      };
      const config=actionConfig[role];
      if (!config && ['SMOKE','INDUSTRIAL_SPY','PATENT_FORGER','ETHER_SMUGGLER','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role)) {
        area.innerHTML=`<div class="action-prompt">SINDICATO REBELDE · CLICA NUM HABITANTE INIMIGO PARA ESCOLHER O ALVO DO ATAQUE.</div><div class="action-row">${selectionNote}${syndicateVoteButton()}</div>`;
        if($('syndicateVoteSubmit')) $('syndicateVoteSubmit').onclick=()=>socket.emit('syndicateVote',{targetId:selectedSyndicateTargetId});
        return;
      }
      if (!config) { area.innerHTML=''; return; }
      const submitted=Boolean(state.me.actionSubmitted), revivalUsed=role==='MAINTENANCE_MECHANIC'&&state.me.revivalUsed;
      area.innerHTML=`<div class="action-prompt">${config.label} · CLICA NO CARD DE UM HABITANTE.</div><div class="action-row">${selectionNote}${button('actionSubmit',submitted?'AÇÃO CONFIRMADA':revivalUsed?'JÁ UTILIZADA':'CONFIRMAR AÇÃO ↗',submitted||revivalUsed||!selectedTargetId)}${syndicateVoteButton()}</div>`;
      $('actionSubmit').onclick=()=>{
        if(!selectedTargetId)return showToast('Clica primeiro no card de um habitante elegível.');
        if(config.event) socket.emit(config.event,{targetId:selectedTargetId});
        else socket.emit('playerAction',{action:config.action,targetId:selectedTargetId});
      };
      if($('syndicateVoteSubmit')) $('syndicateVoteSubmit').onclick=()=>socket.emit('syndicateVote',{targetId:selectedSyndicateTargetId});
      return;
    }
    if (phase === 'VOTING') {
      const controlled=Boolean(state.me.bribeVoteControlled||state.me.bribeVoteLocked);
      area.innerHTML=`<div class="action-prompt">${controlled?'BANQUEIRO DE COBRE · O TEU VOTO FOI HERDADO':`ESCOLHE QUEM LEVAR À FORNALHA · ${state.me.voted?'VOTO REGISTADO':''}`}</div><div class="action-row">${selectionNote}${button('voteSubmit',controlled?'🪙 VOTO CONFISCADO':state.me.voted?'ALTERAR VOTO':'VOTAR ↗',controlled||!selectedTargetId,'button vote-button')}${canShoot?button('shootSubmit','DISPARAR · 1 MUNIÇÃO',!selectedTargetId):''}</div>`;
      if(!controlled) $('voteSubmit').onclick=()=>socket.emit('submitVote',{targetId:selectedTargetId});
      if(canShoot) $('shootSubmit').onclick=()=>shootSelected();
    } else if (canShoot) {
      area.innerHTML=`<div class="action-prompt">INVENTOR · ${state.me.bullets} DISPARO(S) RESTANTE(S) · CLICA NUM ALVO.</div><div class="action-row">${selectionNote}${button('shootSubmit','DISPARAR ↗',!selectedTargetId)}</div>`;
      $('shootSubmit').onclick=()=>shootSelected();
    } else if (phase === 'DAY') area.innerHTML='<div class="action-prompt">A DISCUSSÃO ESTÁ ABERTA · A VOTAÇÃO COMEÇA NO FIM DO TEMPO</div>';
    else area.innerHTML='';
  }
  function shootSelected() {
    if (!selectedTargetId) return showToast('Clica primeiro no card de um alvo.');
    socket.emit('playerAction',{action:'shoot',targetId:selectedTargetId});
  }
  function renderGameOver() {
    const winner = gameOverPayload?.winnerFaction || state.winnerFaction || state.winner;
    const resultByFaction = {
      syndicate: { title:'A FUMAÇA DISSIPOU: VITÓRIA DO SINDICATO REBELDE', subtitle:'O Sindicato tomou o controlo do Distrito.', className:'syndicate' },
      steam: { title:'A ORDEM FOI RESTAURADA: VITÓRIA DA ALIANÇA DE VAPOR', subtitle:'A cidade voltou a respirar em segurança.', className:'steam' },
      automaton: { title:'AS ENGRENAGENS TOMARAM A CIDADE: VITÓRIA DO AUTÓMATO', subtitle:'A máquina continuará a avançar, sem ninguém para a deter.', className:'automaton' },
      scrap: { title:'A FORNALHA ESCOLHEU: VITÓRIA DO COLECIONADOR DE SUCATA', subtitle:'O Colecionador transformou a própria queda em triunfo.', className:'scrap' },
      scientist: { title:'A CIDADE DETONOU: VITÓRIA DO CIENTISTA LOUCO', subtitle:'A experiência terminou com o Cientista como único sobrevivente.', className:'scientist' }
      ,souls: { title:'TODAS AS ALMAS MECANIZADAS: VITÓRIA DO COLECIONADOR', subtitle:'As engrenagens do Colecionador alcançaram todos os sobreviventes.', className:'souls' }
      ,'Colecionador de Almas Mecânicas': { title:'A OFICINA FOI COMPLETAMENTE MECANIZADA! VITÓRIA DO COLECIONADOR DE ALMAS', subtitle:'As engrenagens venceram a carne. Todas as almas sobreviventes pertencem à máquina.', className:'souls' }
    };
    const result = resultByFaction[winner] || { title:'A PARTIDA TERMINOU', subtitle:'O destino da cidade foi decidido.', className:'steam' };
    $('victoryPanel').className=`victory-panel ${result.className}`;
    $('victoryText').textContent=result.title;
    $('victorySubtext').textContent=result.subtitle;
    const survivors=gameOverPayload?.survivors||state.survivors||[];
    $('survivorList').innerHTML=survivors.length?survivors.map(p=>`<li><span class="survivor-mark">⚙</span><span>${escapeHtml(p.name)}</span><small>${escapeHtml(roleNames[p.role]||p.role||'Sobrevivente')}</small></li>`).join(''):'<li class="no-survivors">Ninguém sobreviveu.</li>';
    const reward = $('matchProgressReward');
    if (matchProgress) {
      reward.textContent = `+${matchProgress.xpGained} XP${matchProgress.coinsGained ? ` · +${matchProgress.coinsGained} moedas de cobre` : ''}${matchProgress.leveledUp ? ` · NÍVEL ${matchProgress.level} ALCANÇADO` : ''}`;
      reward.classList.remove('hidden');
    } else if (accountProfile) {
      reward.textContent = 'A sincronizar o relatório de progressão…';
      reward.classList.remove('hidden');
    } else reward.classList.add('hidden');
    const host=state.players?.find(p=>p.id===playerId)?.host;
    $('backToLobby').disabled=!host;
    $('backToLobby').classList.toggle('disabled-button',!host);
    $('backToLobby').textContent=host?'Retornar para a Oficina':'A aguardar pelo Anfitrião';
    $('returnHint').textContent=host?'A oficina e o código da sala serão mantidos para uma nova partida.':'O anfitrião pode reiniciar a oficina quando estiver pronto.';
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  $('accountForm').addEventListener('submit', event => {
    event.preventDefault();
    const username = $('accountUsername').value.trim();
    const password = $('accountPassword').value;
    if (!username || !password) return $('authFeedback').textContent = 'Preenche o usuário e a senha.';
    $('authFeedback').textContent = 'A verificar a tua identidade na caldeira…';
    setAuthBusy(true);
    socket.emit('loginAccount', { username, password });
  });
  $('registerAccount').addEventListener('click', () => {
    const username = $('accountUsername').value.trim();
    const password = $('accountPassword').value;
    if (!username || !password) return $('authFeedback').textContent = 'Preenche o usuário e a senha para fundir a conta.';
    $('authFeedback').textContent = 'A fundir uma nova conta…';
    setAuthBusy(true);
    socket.emit('registerAccount', { username, password });
  });
  $('logoutAccount').addEventListener('click', () => {
    socket.emit('logoutAccount');
    accountProfile = null;
    matchProgress = null;
    $('accountProgress').classList.add('hidden');
    $('openBazarInGame').classList.add('hidden');
    $('openHistoryInGame').classList.add('hidden');
    $('accountActions').classList.add('hidden');
    $('accountForm').classList.remove('hidden');
    $('accountUsername').value = '';
    $('accountPassword').value = '';
    $('authFeedback').textContent = 'Sessão terminada. Inicia sessão ou cria uma conta.';
    setAuthBusy(false);
  });
  $('openBazar').addEventListener('click', openBazar);
  $('openBazarInGame').addEventListener('click', openBazar);
  $('openHistory').addEventListener('click', openHistory);
  $('openHistoryInGame').addEventListener('click', openHistory);
  $('closeHistory').addEventListener('click', closeHistory);
  $('history-modal').addEventListener('click', event => { if (event.target === $('history-modal')) closeHistory(); });
  $('openLeaderboard').addEventListener('click', openLeaderboard);
  $('closeLeaderboard').addEventListener('click', closeLeaderboard);
  $('leaderboard-modal').addEventListener('click', event => { if (event.target === $('leaderboard-modal')) closeLeaderboard(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('leaderboard-modal').classList.contains('active')) closeLeaderboard();
  });
  $('togglePlayerProfile').addEventListener('click', () => {
    const panel = $('playerProfilePanel');
    const isOpen = panel.classList.toggle('is-open');
    $('togglePlayerProfile').setAttribute('aria-expanded', String(isOpen));
    panel.setAttribute('aria-hidden', String(!isOpen));
  });
  const saveProfileCosmetics = () => {
    if (!accountProfile) return;
    $('profileFeedback').textContent = 'A gravar o teu equipamento…';
    socket.emit('equipCosmetic', {
      titleId: $('equippedTitle').value || null,
      borderId: $('equippedBorder').value || null
    });
  };
  $('equippedTitle').addEventListener('change', saveProfileCosmetics);
  $('equippedBorder').addEventListener('change', saveProfileCosmetics);
  $('closeBazar').addEventListener('click', closeBazar);
  $('bazar-modal').addEventListener('click', event => { if (event.target === $('bazar-modal')) closeBazar(); });
  $('bazarItems').addEventListener('click', event => {
    const buy = event.target.closest('[data-buy-cosmetic]');
    if (buy) {
      $('bazarFeedback').textContent = 'A negociar com a caldeira…';
      socket.emit('buyCosmetic', { cosmeticId: buy.dataset.buyCosmetic });
      return;
    }
    const equip = event.target.closest('[data-equip-cosmetic]');
    if (equip) socket.emit('equipCosmetic', { cosmeticId: equip.dataset.equipCosmetic || null });
  });
  $('createRoom').onclick=()=>{
    const name=accountProfile?.username;
    if(!name)return showToast('Inicia sessão antes de entrar numa oficina.');
    console.log('Partida rápida solicitada para:', name);
    socket.emit('findMatch', { name });
  };
  $('joinRoom').onclick=()=>{
    const name=accountProfile?.username,code=$('roomInput').value.trim();
    if(!name||!code)return showToast('Inicia sessão e indica o código da oficina.');
    socket.emit('joinRoom',{name,roomCode:code});
  };
  $('roomInput').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
  $('startGame').onclick=()=>socket.emit('startGame');
  $('readyButton').onclick=()=>{const me=state?.players.find(p=>p.id===playerId);if(me)socket.emit('setReady',{isReady:!me.isReady});};
  $('copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);showToast('Código copiado.');}catch{showToast(`Código da sala: ${roomCode}`);}};
  $('backToLobby').onclick=()=>{
    if(!state?.players.find(p=>p.id===playerId)?.host)return;
    $('backToLobby').disabled=true;
    $('backToLobby').textContent='A preparar a Oficina…';
    socket.emit('returnToLobby');
  };
  const backToMenuButton = $('btn-back-to-menu');
  if (backToMenuButton) backToMenuButton.addEventListener('click', () => {
    leaveWorkshop();
  });
  $('audioToggle').addEventListener('click', () => audioManager.toggle());
  document.addEventListener('click', event => {
    if (event.target.closest('button') && !event.target.closest('#audioToggle')) audioManager.playSFX('click');
  }, true);
  $('playersList').addEventListener('click',e=>{
    const card=e.target.closest('[data-select-target]');
    if(card) selectPlayerCard(card.dataset.selectTarget);
  });
  $('playersList').addEventListener('keydown',e=>{
    if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-select-target]')){
      e.preventDefault();
      selectPlayerCard(e.target.dataset.selectTarget);
    }
  });
  $('chatInput').addEventListener('input', () => {
    clearTimeout(typingTimeout);
    if ($('chatInput').value.trim()) {
      sendTypingStatus(true);
      typingTimeout = setTimeout(() => sendTypingStatus(false), 2000);
    } else sendTypingStatus(false);
  });
  $('chatForm').onsubmit=e=>{
    e.preventDefault();
    const input=$('chatInput'), message=input.value.trim();
    clearTimeout(typingTimeout);
    sendTypingStatus(false);
    if(message){socket.emit('sendMessage',{roomCode,message});input.value='';}
  };
  function sendLobbyMessage() {
    const input = $('lobby-chat-input');
    const message = input.value.trim();
    if (!message || !roomCode) return;
    // Um servidor antigo pode ainda não ter carregado sendLobbyMessage. Se
    // não chegar a confirmação pelo evento novo, recorre ao chat existente.
    const pending = { message, timer: null };
    pending.timer = setTimeout(() => {
      const index = pendingLobbySends.indexOf(pending);
      if (index >= 0) pendingLobbySends.splice(index, 1);
      if (!lobbyPanel.classList.contains('hidden') && roomCode) {
        socket.emit('sendMessage', { roomCode, message });
      }
    }, 900);
    pendingLobbySends.push(pending);
    socket.emit('sendLobbyMessage', { roomCode, message });
    input.value = '';
    input.focus();
  }
  $('lobby-chat-form').addEventListener('submit', event => {
    event.preventDefault();
    sendLobbyMessage();
  });
  $('btn-send-lobby-message').addEventListener('click', event => {
    event.preventDefault();
    sendLobbyMessage();
  });
  $('lobby-chat-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendLobbyMessage();
    }
  });
  socket.on('joinedRoom',enterRoom);
  socket.on('roomJoined',enterRoom);
  socket.on('reconnectionSuccess', data => {
    enterRoom(data);
    playerId = data.playerId;
    roomCode = data.roomCode;
    state = data.state || null;
    $('connectionLabel').textContent = 'LIGADO';
    const gameChat = $('chatMessages');
    gameChat.replaceChildren();
    (data.chatHistory || []).forEach(entry => addChat(entry.sender, entry.text, Boolean(entry.private), entry.type || 'player'));
    if (!data.chatHistory?.length) gameChat.innerHTML = '<div class="chat-empty">As ondas estão em silêncio.<br>Envia a primeira mensagem.</div>';
    const lobbyChat = $('lobby-chat-messages');
    lobbyChat.replaceChildren();
    (data.lobbyChatHistory || []).forEach(appendLobbyChatMessage);
    if (!data.lobbyChatHistory?.length) lobbyChat.innerHTML = '<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
    if (state) render();
    hideReconnectScreen();
    showToast('Ligação restaurada. Voltaste à mesma oficina.');
  });
  socket.on('reconnectionError', ({ message } = {}) => {
    sessionStorage.removeItem('cidadeDormeReconnect');
    hideReconnectScreen();
    returnToMenu();
    showToast(message || 'A sessão já não pode ser recuperada.');
  });
  socket.on('registerSuccess', payload => acceptAccount(payload, 'Conta fundida com sucesso'));
  socket.on('loginSuccess', payload => acceptAccount(payload, 'Sessão iniciada'));
  socket.on('purchaseSuccess', ({ account, cosmeticId } = {}) => {
    if (account) renderAccountProfile(account);
    $('bazarFeedback').textContent = 'Artigo adquirido e guardado na tua conta.';
    renderBazar();
    audioManager.playPurchaseSFX();
  });
  socket.on('cosmeticEquipped', ({ account } = {}) => {
    if (account) renderAccountProfile(account);
    $('bazarFeedback').textContent = 'Personalização guardada no perfil.';
    $('profileFeedback').textContent = 'Personalização guardada. A tripulação verá a alteração na oficina.';
    renderBazar();
  });
  socket.on('cosmeticEquipError', ({ message } = {}) => {
    $('profileFeedback').textContent = message || 'Não foi possível guardar a personalização.';
    if (accountProfile) renderMechanicalProfile(accountProfile, levelProgress(accountProfile), Number(accountProfile.currencies?.copper_coins) || 0);
  });
  socket.on('purchaseError', ({ message } = {}) => {
    $('bazarFeedback').textContent = message || 'Não foi possível concluir a operação.';
    audioManager.playErrorSFX();
  });
  socket.on('accountError', ({ message } = {}) => {
    setAuthBusy(false);
    $('authFeedback').textContent = message || 'Falha na autenticação.';
  });
  socket.on('playerProgressUpdated', progress => {
    matchProgress = progress;
    renderAccountProfile(progress);
    if (state?.phase === 'GAMEOVER') renderGameOver();
  });
  socket.on('playerProgressError', ({ message } = {}) => showToast(message || 'Não foi possível guardar o progresso.'));
  socket.on('roomCreated',({roomCode:createdRoomCode,playerId:createdPlayerId}={})=>{
    if (leavingRoom) return;
    if(!createdRoomCode||!createdPlayerId){
      showToast('A oficina foi criada, mas a confirmação veio incompleta. Atualiza a página.');
      return;
    }
    enterRoom({roomCode:createdRoomCode,playerId:createdPlayerId});
  });
  socket.on('gameState',next=>{
    if(leavingRoom)return;
    if(state?.phase!==next.phase) {
      if (state?.phase === 'NIGHT' && next.phase !== 'NIGHT') syndicateMiras.clear();
      if (state && ['DAY','VOTING'].includes(state.phase)) sendTypingStatus(false);
      clearTimeout(typingTimeout);
      clearTypingPlayers();
      clearTargetSelection();
      if (state) animatePhaseTransition(next.phase);
    }
    state=next;
    render();
  });
  socket.on('updateVotes',counts=>{if(!state)return;state.voteCounts=counts||{};renderPlayers();});
  socket.on('leftRoom', () => returnToMenu());
  socket.on('playerTyping', ({ sender, senderId, isTyping } = {}) => {
    if (!state || !['DAY','VOTING'].includes(state.phase) || !sender || senderId === playerId) return;
    const key = senderId || sender;
    const previous = typingPlayers.get(key);
    if (previous) clearTimeout(previous.timeout);
    if (!isTyping) typingPlayers.delete(key);
    else {
      const timeout = setTimeout(() => {
        typingPlayers.delete(key);
        renderTypingIndicator();
      }, 4500);
      typingPlayers.set(key, { name: sender, timeout });
    }
    renderTypingIndicator();
  });
  socket.on('updateSyndicateMiras', ({ senderId, senderName, targetId } = {}) => {
    if (!state || state.phase !== 'NIGHT' || !senderId || !targetId) return;
    syndicateMiras.set(senderId, { senderName: senderName || 'Aliado', targetId });
    renderPlayers();
  });
  socket.on('gameOver',result=>{
    syndicateMiras.clear();
    clearTypingPlayers();
    clearTimeout(transitionTimeout);
    $('transition-overlay').classList.remove('is-active');
    $('transition-overlay').setAttribute('aria-hidden','true');
    gameOverPayload=result;
    if(result.winnerFaction==='Colecionador de Almas Mecânicas'||result.winnerFaction==='souls') audioManager.playSFX('mechanizationVictory');
    state={...(state||{}),phase:'GAMEOVER',ended:true,winnerFaction:result.winnerFaction,survivors:result.survivors||[]};
    document.body.classList.remove('night-phase');
    render();
  });
  socket.on('roomReset',({ roomCode: resetRoomCode } = {})=>{
    syndicateMiras.clear();
    clearTypingPlayers();
    clearTimeout(transitionTimeout);
    lastTransitionPhase=null;
    $('transition-overlay').classList.remove('is-active');
    $('transition-overlay').setAttribute('aria-hidden','true');
    gameOverPayload=null;revealedRole=null;clearTargetSelection();
    matchProgress=null;
    clearTimeout(revealTimer);
    if (resetRoomCode) roomCode = resetRoomCode;
    if (state) {
      state = {
        ...state,
        roomCode: roomCode || state.roomCode,
        phase: 'LOBBY', day: 0, ended: false, winner: null, winnerFaction: null,
        survivors: [], deadPlayers: [], log: [], voteCount: 0, voteCounts: {},
        roleInfo: null, syndicate: [],
        players: (state.players || []).map(player => ({
          ...player, alive: true, isReady: false, isSilenced: false,
          role: null, voted: false
        })),
        me: state.me ? {
          ...state.me, role: null, alive: true, bullets: 2, actionSubmitted: false,
          voted: false, isSilenced: false, silencedToday: false
        } : null
      };
    }
    $('chatMessages').innerHTML='<div class="chat-empty">A oficina foi reiniciada.<br>As ondas aguardam.</div>';
    $('lobby-chat-messages').innerHTML='<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
    $('victoryBanner').classList.add('hidden');
    $('survivorList').replaceChildren();
    $('victoryText').textContent='—';
    $('victorySubtext').textContent='A partida terminou.';
    $('chatInput').disabled=false;
    $('chatInput').placeholder=chatPlaceholder;
    $('chatInput').classList.remove('silenced-input');
    $('chatForm').classList.remove('chat-silenced');
    $('lobby-chat-input').disabled=false;
    $('btn-send-lobby-message').disabled=false;
    $('lobby-chat-input').placeholder='Converse com a oficina...';
    document.body.classList.remove('night-phase','game-over','role-reveal-open');
    $('roleRevealModal').classList.add('hidden');
    lobbyPanel.classList.remove('hidden');
    gamePanel.classList.add('hidden');
    if (state) render();
  });
  socket.on('dayStarted',event=>{
    syndicateMiras.clear();
    if (state) renderPlayers();
    animatePhaseTransition('DAY');
    document.body.classList.remove('night-phase');
    if (Array.isArray(event.players) && state) {
      const roster = new Map(event.players.map(player => [player.id, player]));
      state.players = state.players.map(player => ({...player, isSilenced:Boolean(roster.get(player.id)?.isSilenced)}));
      if (state.me) state.me.isSilenced = Boolean(roster.get(playerId)?.isSilenced);
      render();
    }
    if(event.deaths?.length){
      const names=event.deaths.map(p=>`${p.name}${p.role?` (${p.role})`:''}`).join(', ');
      addChat('Sistema',`A manhã chegou. Eliminado(s) durante a noite: ${names}.`,false,'system');
    }else addChat('Sistema','A manhã chegou. Ninguém foi eliminado durante a noite.',false,'system');
    if(event.explosionMessage) addChat('Sistema · EXPLOSÃO',event.explosionMessage,false,'system-error');
    if(event.counterattackMessage) addChat('Sistema · FORNALHA',event.counterattackMessage,false,'system-warning');
  });
  socket.on('nightStarted', () => animatePhaseTransition('NIGHT'));
  socket.on('updatePlayers',players=>{
    if(!state)return;
    const oldPlayers=new Map(state.players.map(p=>[p.id,p]));
    state.players=players.map(p=>{const old=oldPlayers.get(p.id)||{};return {...old,id:p.id,name:p.name,title:p.title||null,border:p.border||null,host:p.isHost,alive:p.isAlive,isReady:p.isReady,isSilenced:Boolean(p.isSilenced),isDisconnected:Boolean(p.isDisconnected)};});
    if(state.me){const me=players.find(p=>p.id===playerId);if(me)state.me.isSilenced=Boolean(me.isSilenced);}
    render();
  });
  socket.on('gameError',payload=>showToast(payload.message));
  socket.on('privateEvent',event=>{
    if(event.type==='inspectionResult') addChat(
      'O teu relatório',
      `${event.targetName}: cargo ${event.targetRole || 'não identificado'} · fação ${event.factionName}.`,
      true
    );
    if(event.type==='spyResult') addChat('Relatório do Espião Industrial',`${event.targetName}: cargo exato ${event.targetRole} · fação ${event.factionName}.`,true);
    if(event.type==='visitorReport') addChat('Relatório do Engenheiro de Tesla',event.visitors?.length?`${event.visitors.join(', ')} visitou(aram) ${event.targetName}.`:`Ninguém visitou ${event.targetName}.`,true);
    if(event.type==='reverseAnalysis') addChat('Análise do Engenheiro Reverso',`${event.deadName} recebeu o voto de ${event.suspectName}. O cargo do suspeito é ${event.suspectRole}.`,true);
    if(event.type==='armorGranted') addChat('Placa de Titânio',`O Fabricante de Blindagem (${event.makerName}) instalou uma placa na tua oficina. Ela absorve o próximo ataque noturno.`,true);
    if(event.type==='armorDeployed') addChat('Fabricante de Blindagem',`${event.count} placa(s) de titânio foram distribuídas.`,true);
    if(event.type==='armorAbsorbed') addChat('Placa de Titânio','A tua placa absorveu um ataque noturno e foi consumida.',true);
    if(event.type==='bribed') addChat('Suborno de Cobre',`${event.bankerName} comprou o teu voto para a votação de hoje.`,true);
    if(event.type==='bribeApplied') addChat('Banqueiro de Cobre',`${event.targetName} foi subornado; o voto dele espelhará o teu.`,true);
    if(event.type==='bribeVoteCopied') showToast(event.targetName?`O teu voto foi forçado para ${event.targetName}.`:'O teu voto foi forçado à abstenção.');
    if(event.type==='mechanized') addChat('Colecionador de Almas Mecânicas',`${event.targetName} recebeu engrenagens.`,true);
    if(event.type==='revivalResult') addChat('Relatório da Manutenção',`${event.targetName} foi reativado. A ressurreição desta partida foi utilizada.`,true);
    if(event.type==='oilApplied') addChat('Caderno do Cientista',`${event.targetName} foi oleado. Alvos marcados: ${event.count}.`,true);
    if(event.type==='oilPumpFailed') showToast(event.message || 'A bomba de óleo não conseguiu marcar esse alvo.');
    if(event.type==='actionRedirected') addChat('Interferência noturna',`A tua ação foi desviada para ${event.targetName}.`,true);
    if(event.type==='timeRewind') addChat('Retrocesso temporal',`${event.savedName} sobreviveu graças à tua intervenção.`,true);
    if(event.type==='silenceApplied') addChat('Informador Clandestino',`${event.targetName} foi silenciado para o dia seguinte.`,true);
    if(event.type==='silencedToday') showToast('O Informador Clandestino silenciou-te. Não podes enviar mensagens durante este dia.');
    if(event.type==='stunned') showToast('A armadilha de pressão atordoou-te. A tua ação desta noite foi bloqueada.');
    if(event.type==='syndicateMembers'&&state){state.syndicate=event.members;render();}
    if(event.type==='actionConfirmed') showToast(`Ação registada para ${event.targetName}.`);
    if(event.type==='bronzeAlertActivated') showToast(`Fornalha armada. Restam ${event.bronzeCharges}/2 cargas.`);
    if(event.type==='bronzeAlertSkipped') showToast('Guardaste uma carga para outra noite.');
    if(event.type==='voteConfirmed') showToast(event.targetName?`Voto registado em ${event.targetName}.`:'Abstenção registada.');
    if(event.type==='syndicateVoteConfirmed') showToast(`Voto do Sindicato registado em ${event.targetName}.`);
  });
  socket.on('newMessage',msg=>{
    // Compatibilidade com o backend anterior, que publica mensagens do lobby
    // em newMessage em vez de newLobbyMessage.
    if (msg?.type === 'player' && !lobbyPanel.classList.contains('hidden')) {
      appendLobbyChatMessage(msg);
      return;
    }
    addChat(msg.sender,msg.text,msg.private,msg.type);
  });
  socket.on('newLobbyMessage', appendLobbyChatMessage);
  socket.on('lobbyChatHistory', messages => {
    const box = $('lobby-chat-messages');
    box.replaceChildren();
    if (!messages?.length) {
      box.innerHTML = '<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
      return;
    }
    messages.forEach(appendLobbyChatMessage);
  });
  socket.on('chatHistory',messages=>{
    const box=$('chatMessages');box.innerHTML='';
    if(!messages.length){box.innerHTML='<div class="chat-empty">As ondas estão em silêncio.<br>Envia a primeira mensagem.</div>';return;}
    messages.forEach(msg=>addChat(msg.sender,msg.text,msg.private,msg.type));
  });
  socket.on('roleAssigned',data=>{if(state){state.me.role=data.role;state.roleInfo=data.info;render();}});
  socket.on('yourRole',revealRole);
  $('closeRoleReveal').onclick=()=>{$('roleRevealModal').classList.add('hidden');document.body.classList.remove('role-reveal-open');};
  socket.on('connect',()=>{
    $('connectionLabel').textContent='LIGADO';
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('cidadeDormeReconnect') || 'null'); } catch { saved = null; }
    if (saved?.username && saved?.roomCode && saved?.reconnectToken) {
      showReconnectScreen();
      socket.emit('reconnectPlayer', saved);
    }
  });
  socket.on('disconnect',()=>{
    $('connectionLabel').textContent='DESLIGADO';
    clearTimeout(typingTimeout);
    localIsTyping = false;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('cidadeDormeReconnect') || '{}'); } catch { saved = {}; }
    const reconnectRoomCode = roomCode || saved.roomCode;
    if (!reconnectRoomCode) return;
    showReconnectScreen();
    const username = accountProfile?.username || state?.players?.find(player => player.id === playerId)?.name || saved.username;
    if (username && saved.reconnectToken) {
      sessionStorage.setItem('cidadeDormeReconnect', JSON.stringify({ username, roomCode: reconnectRoomCode, reconnectToken: saved.reconnectToken }));
    }
  });
  socket.on('connect_error',()=>{
    $('connectionLabel').textContent='SEM LIGAÇÃO';
    showToast('Não foi possível ligar ao servidor. Atualiza a página e tenta novamente.');
  });
  function addChat(name,message,privateMessage,type='player'){
    const box=$('chatMessages');box.querySelector('.chat-empty')?.remove();
    const row=document.createElement('div');row.className=`chat-message ${type==='system'?'system':''} ${type==='system-error'?'system-error':''} ${type==='system-warning'?'system-warning':''}`;
    const sender=document.createElement('strong');sender.textContent=`${name}${privateMessage?' · PRIVADO':''}`;
    const text=document.createElement('span');text.textContent=message;
    if (type === 'system' || type === 'system-error') {
      const alertBox=document.createElement('div');
      alertBox.className='system-alert-box';
      alertBox.append(sender,text);
      row.append(alertBox);
    } else row.append(sender,text);
    box.appendChild(row);box.scrollTop=box.scrollHeight;
  }
  function appendLobbyChatMessage(data = {}) {
    if (data.type === 'player') {
      const localName = state?.players?.find(player => player.id === playerId)?.name || accountProfile?.username || '';
      if (data.sender === localName) {
        const pendingIndex = pendingLobbySends.findIndex(pending => pending.message === data.text);
        if (pendingIndex >= 0) {
          clearTimeout(pendingLobbySends[pendingIndex].timer);
          pendingLobbySends.splice(pendingIndex, 1);
        }
      }
    }
    const box = $('lobby-chat-messages');
    box.querySelector('.lobby-chat-empty')?.remove();
    const row = document.createElement('div');
    const isSystemAlert = data.type === 'system' || data.type === 'system-error';
    row.className = `lobby-chat-message ${isSystemAlert ? 'system system-alert-message' : 'player'}`;
    const sender = document.createElement('strong');
    sender.textContent = isSystemAlert ? `[Sistema] ${data.sender || 'Sistema'}` : `${data.sender || 'Jogador'}:`;
    const text = document.createElement('span');
    text.textContent = data.text || '';
    if (isSystemAlert) {
      const alertBox = document.createElement('div');
      alertBox.className = 'system-alert-box';
      alertBox.append(sender, text);
      row.append(alertBox);
    } else row.append(sender, text);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }
  function revealRole(payload={}){
    const role=payload.role;
    if(!role||revealedRole===role)return;
    revealedRole=role;
    const info=payload.info||{};
    const name=payload.roleName||info.name||roleNames[role]||role;
    const faction=payload.faction||info.faction||'neutral';
    const factionNames={steam:'Aliança de Vapor',syndicate:'Sindicato Rebelde',neutral:'Dissidentes'};
    const titles={CLOCKMAKER:'O Relojoeiro',ALCHEMIST:'A Alquimista',INVENTOR:'O Inventor',WORKER:'O Operário',SABOTEUR:'O Sabotador',SMOKE:'A Cortina de Fumo',SCRAP_COLLECTOR:'O Colecionador de Sucata',AUTOMATON:'O Autómato Desgovernado',TESLA_ENGINEER:'O Engenheiro de Tesla',BRONZE_SMITH:'O Ferreiro de Bronze',MAINTENANCE_MECHANIC:'O Mecânico de Manutenção',INDUSTRIAL_SPY:'O Espião Industrial',PATENT_FORGER:'O Falsificador de Patentes',MAD_SCIENTIST:'O Cientista Louco',SCRAP_GRAVEDIGGER:'O Coveiro de Sucata',TIMEKEEPER:'O Cronometrista',PRESSURE_TRAPPER:'O Armadilheiro de Pressão',ETHER_SMUGGLER:'O Contrabandista de Éter',CLANDESTINE_INFORMANT:'O Informador Clandestino',REVERSE_ENGINEER:'O Engenheiro Reverso',ARMOR_FABRICATOR:'O Fabricante de Blindagem',COPPER_BANKER:'O Banqueiro de Cobre',SOUL_COLLECTOR:'O Colecionador de Almas Mecânicas'};
    $('revealPlayerName').textContent=payload.playerName?`IDENTIDADE: ${payload.playerName}`:'IDENTIDADE CONFIRMADA';
    $('revealRoleName').textContent=titles[role]||`O ${name}`;
    $('revealFactionName').textContent=factionNames[faction]||faction;
    $('revealFaction').className=`reveal-faction ${faction}`;
    $('revealFactionIcon').textContent=faction==='syndicate'?'◆':faction==='neutral'?'◈':'✦';
    $('revealObjective').textContent=payload.objective||payload.description||info.description||'Cumpre o teu papel e ajuda a decidir o destino da cidade.';
    const modal=$('roleRevealModal'),card=$('roleRevealCard');
    modal.classList.remove('hidden');document.body.classList.add('role-reveal-open');
    card.classList.remove('show-details');$('closeRoleReveal').disabled=true;
    const revealDelay=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1150;
    clearTimeout(revealTimer);revealTimer=setTimeout(()=>{card.classList.add('show-details');$('closeRoleReveal').disabled=false;},revealDelay);
  }
  setInterval(()=>{if(state&&state.secondsLeft>0){state.secondsLeft-=1;render();}},1000);
})();
