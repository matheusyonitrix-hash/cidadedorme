(() => {
  const socket = io();
  const MIN_PLAYERS = 2;
  const $ = (id) => document.getElementById(id);
  const landing = $('landing'), game = $('game'), lobbyPanel = $('lobbyPanel'), gamePanel = $('gamePanel');
  let state = null, playerId = null, roomCode = null, selectedTarget = null, toastTimer = null, revealedRole = null, revealTimer = null, gameOverPayload = null;
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
          : [];
      if (!tones.length) return;
      this.ensureContext().then(context => {
        if (!context || this.muted) return;
        const now = context.currentTime;
        tones.forEach((tone, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const startAt = now + (sound === 'mechanizationVictory' ? index * 0.055 : 0);
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
    roomCode = data.roomCode; playerId = data.playerId;
    $('roomCodeLabel').textContent = roomCode;
    landing.classList.add('hidden'); game.classList.remove('hidden');
    // Mostra já a oficina, sem esperar pelo primeiro gameState do servidor.
    lobbyPanel.classList.remove('hidden');
    gamePanel.classList.add('hidden');
    const lobbyChat = document.querySelector('.lobby-chat-container');
    if (lobbyChat) lobbyChat.style.display = 'flex';
    $('lobby-chat-input').disabled = false;
    $('btn-send-lobby-message').disabled = false;
  }
  function returnToMenu() {
    audioManager.stopAll();
    state = null;
    playerId = null;
    roomCode = null;
    selectedTarget = null;
    revealedRole = null;
    gameOverPayload = null;
    clearTimeout(revealTimer);
    clearTimeout(leaveTimeout);
    $('nameInput').value = '';
    $('roomInput').value = '';
    $('chatMessages').innerHTML = '<div class="chat-empty">As ondas estão em silêncio.<br>Envia a primeira mensagem.</div>';
    $('lobby-chat-messages').innerHTML = '<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
    $('eventLog').innerHTML = '';
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
    const isGameOver = state.phase === 'GAMEOVER' || state.ended;
    lobbyPanel.classList.toggle('hidden', !inLobby);
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
        ? `<div class="roster-row"><div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><span>${escapeHtml(p.name)}</span>${p.host?'<span class="host-mark">ANFITRIÃO</span>':''}${p.isReady?'<span class="ready-mark">PRONTO</span>':''}</div>`
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
    $('syndicateBox').classList.toggle('hidden', !['SABOTEUR','SMOKE','INDUSTRIAL_SPY','PATENT_FORGER'].includes(me.role));
    $('syndicateList').innerHTML = (state.syndicate||[]).map(p=>`<div class="syndicate-member">⚙ ${escapeHtml(p.name)}${p.id===playerId?' · tu':''}</div>`).join('');
    renderPlayers(); renderActions(); renderLog();
  }
  function renderPlayers() {
    $('playersList').innerHTML = state.players.map((p) => {
      const self = p.id === playerId, canTarget = targetable(p), role = p.role ? roleNames[p.role] : null;
      const selected = selectedTarget === p.id;
      const nightAction = state.phase === 'NIGHT' && canTarget ? quickNightAction(state.me?.role) : null;
      const canVote = state.phase === 'VOTING' && p.alive && !self && !state.me?.bribeVoteLocked;
      const canShoot = ['DAY','VOTING'].includes(state.phase) && state.me?.role === 'INVENTOR' && state.me?.bullets > 0 && p.alive && !self;
      const votes = state.voteCounts?.[p.id] || 0;
      const controls = `${nightAction?`<button class="card-action night-action" data-card-action="${nightAction.event}" ${nightAction.action?`data-action="${nightAction.action}"`:''} data-target-id="${escapeHtml(p.id)}" aria-label="${nightAction.label} ${escapeHtml(p.name)}"><span>${nightAction.icon}</span>${nightAction.label}</button>`:''}${canVote?`<button class="card-action vote-action" data-vote-target="${escapeHtml(p.id)}" aria-label="Votar em ${escapeHtml(p.name)}">⚒ Votar</button>`:''}${canShoot?`<button class="card-action shoot-action" data-shoot-target="${escapeHtml(p.id)}" aria-label="Disparar contra ${escapeHtml(p.name)}">⌖ Disparar</button>`:''}`;
      const badge = state.phase === 'VOTING' ? `<span class="vote-count" aria-label="${votes} voto(s)">⚙ ${votes}</span>` : '';
      const bribedClass = self && state.me?.bribeVoteControlled ? 'bribed-vote' : '';
      const bribeBadge = self && state.me?.bribeVoteLocked ? '<span class="bribe-badge" title="O teu voto foi confiscado">🪙 VOTO HERDADO</span>' : '';
      return `<div class="player-row ${p.alive?'':'dead'} ${selected?'selected':''} ${state.phase==='VOTING'?'voting-card':''} ${bribedClass}">${badge}<div class="player-avatar">${p.alive?'⚙':'†'}</div><span class="player-name">${escapeHtml(p.name)}${self?' (tu)':''}</span>${bribeBadge}${role?`<span class="player-role">${escapeHtml(role)}</span>`:`<span class="player-state ${p.alive?'alive':'dead'}">${p.alive?'VIVO':'[DESTRUÍDO]'}</span>`}${controls}</div>`;
    }).join('');
  }
  function quickNightAction(role) {
    return ({
      CLOCKMAKER:{event:'nightAction_Investigate',icon:'◉',label:'Investigar'},
      ALCHEMIST:{event:'nightAction_Protect',icon:'⬡',label:'Proteger'},
      SABOTEUR:{event:'nightAction_Kill',icon:'⌖',label:'Atacar'},
      SMOKE:{event:'nightAction_Disguise',icon:'♨',label:'Disfarçar'},
      TESLA_ENGINEER:{event:'nightAction_Watch',icon:'⌖',label:'Vigiar'},
      PRESSURE_TRAPPER:{event:'playerAction',action:'trap',icon:'⚑',label:'Armar'},
      CLANDESTINE_INFORMANT:{event:'playerAction',action:'silence',icon:'⊘',label:'Silenciar'},
      INDUSTRIAL_SPY:{event:'nightAction_Spy',icon:'◉',label:'Identificar cargo'},
      MAINTENANCE_MECHANIC:{event:'nightAction_Revive',icon:'✚',label:'Reparar'},
      AUTOMATON:{event:'nightAction_Kill',icon:'⌖',label:'Eliminar'}
      ,SOUL_COLLECTOR:{event:'nightAction_Mechanize',icon:'⚙',label:'Mecanizar'}
    })[role] || null;
  }
  function targetable(p) {
    const role = state.me?.role;
    if (state.phase === 'NIGHT') {
      if (role === 'MAINTENANCE_MECHANIC') return !state.me.revivalUsed && !p.alive && p.id !== playerId;
      if (role === 'SOUL_COLLECTOR') return p.alive && !p.isMechanized;
      if (!p.alive || p.id === playerId) return false;
      const teammateIds = (state.syndicate || []).map(member => member.id);
      if (role === 'SMOKE') return teammateIds.includes(p.id);
      if (role === 'SABOTEUR') return !teammateIds.includes(p.id);
      return ['CLOCKMAKER','ALCHEMIST','AUTOMATON','TESLA_ENGINEER','INDUSTRIAL_SPY','PRESSURE_TRAPPER','CLANDESTINE_INFORMANT','ETHER_SMUGGLER','COPPER_BANKER'].includes(role);
    }
    return p.alive && p.id !== playerId && (state.phase === 'VOTING' || (state.phase === 'DAY' && role === 'INVENTOR' && (state.me?.bullets||0)>0));
  }
  function renderActions() {
    const area = $('actionArea');
    const role = state.me?.role, phase = state.phase;
    const canShoot = role === 'INVENTOR' && ['DAY','VOTING'].includes(phase) && state.me.bullets > 0;
    if (phase === 'NIGHT' && role === 'BRONZE_SMITH') {
      const submitted=state.me.actionSubmitted, charges=state.me.bronzeCharges||0, alerted=Boolean(state.me.isAlerted);
      const buttonText=alerted?'🔒 OFICINA TRANCADA · ALERTA MÁXIMO':`🔥 Ativar Fornalha de Pressão (Cargas: ${charges}/2)`;
      area.innerHTML=`<div class="action-prompt">FERREIRO DE BRONZE · ${alerted?'OS VISITANTES SERÃO CONSUMIDOS PELO VAPOR':charges>0?'A FORNALHA PODE SER ARMADA DUAS VEZES POR PARTIDA':'CARGAS ESGOTADAS'}</div><div class="action-row"><button id="veteranActivate" class="button forge-alert-button ${alerted?'is-alerted':''}" ${submitted||charges<=0?'disabled':''}>${submitted&&!alerted?'CARGA GUARDADA ESTA NOITE':buttonText}</button>${charges>0&&!submitted?'<button id="veteranSkip" class="button action-button">GUARDAR CARGA</button>':''}</div>`;
      $('veteranActivate').onclick=()=>socket.emit('nightAction_ActivateAlert');
      if($('veteranSkip')) $('veteranSkip').onclick=()=>socket.emit('nightAction_SkipAlert');
      return;
    }
    if (phase === 'NIGHT' && role === 'TIMEKEEPER') {
      const submitted=state.me.actionSubmitted, used=state.me.timeRewindUsed;
      area.innerHTML=`<div class="action-prompt">CRONOMETRISTA · ${used?'RETROCESSO JÁ UTILIZADO':'PODE IMPEDIR UMA MORTE ESTA NOITE'}</div><div class="action-row"><button id="rewindSubmit" class="button action-button" ${submitted||used?'disabled':''}>${used?'JÁ UTILIZADO':submitted?'RETROCESSO ARMADO':'ATIVAR RETROCESSO'} ↶</button></div>`;
      $('rewindSubmit').onclick=()=>socket.emit('playerAction',{action:'rewind'});
      return;
    }
    if (phase === 'NIGHT' && role === 'ETHER_SMUGGLER') {
      const submitted=state.me.actionSubmitted, options=state.players.filter(p=>p.alive&&p.id!==playerId).map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
      area.innerHTML=`<div class="action-prompt">CONTRABANDISTA DE ÉTER · TROCA DUAS IDENTIDADES DE INSPEÇÃO</div><div class="action-row"><select id="swapFirst" class="action-select"><option value="">Primeira identidade…</option>${options}</select><select id="swapSecond" class="action-select"><option value="">Segunda identidade…</option>${options}</select><button id="swapSubmit" class="button action-button" ${submitted?'disabled':''}>TROCAR IDENTIDADES ↗</button></div>${renderSyndicateVote()}`;
      $('swapSubmit').onclick=()=>{const targetId=$('swapFirst').value,secondTargetId=$('swapSecond').value;if(!targetId||!secondTargetId||targetId===secondTargetId)return showToast('Escolhe duas pessoas diferentes.');socket.emit('playerAction',{action:'swapInspection',targetId,secondTargetId});};
      bindSyndicateVote(); return;
    }
    if (phase === 'NIGHT' && role === 'PATENT_FORGER') {
      area.innerHTML = `<div class="action-prompt">A TUA PATENTE FALSIFICADA FAZ-TE PARECER DA ALIANÇA</div>${renderSyndicateVote()}`;
      bindSyndicateVote();
      return;
    }
    if (phase === 'NIGHT' && role === 'REVERSE_ENGINEER') {
      const candidates = state.me.reverseCandidates || [];
      const deadOptions = [...new Map(candidates.map(c => [c.deadTargetId, c])).values()];
      area.innerHTML = `<div class="action-prompt">ENGENHEIRO REVERSO · ANALISA UM VOTO CONTRA UMA PESSOA ELIMINADA</div>${deadOptions.length ? `<div class="action-row"><select id="reverseDead" class="action-select"><option value="">Pessoa eliminada…</option>${deadOptions.map(c=>`<option value="${escapeHtml(c.deadTargetId)}">${escapeHtml(c.deadTargetName)}</option>`).join('')}</select><select id="reverseSuspect" class="action-select"><option value="">Suspeito que votou…</option></select><button id="reverseSubmit" class="button action-button" ${state.me.actionSubmitted?'disabled':''}>ANALISAR VOTO ↗</button></div>` : '<p class="action-prompt">Ainda não há pessoas eliminadas por votação com suspeitos registados.</p>'}`;
      if (deadOptions.length) {
        const fillSuspects = () => {
          const suspects = candidates.filter(c=>c.deadTargetId===$('reverseDead').value);
          $('reverseSuspect').innerHTML = `<option value="">Suspeito que votou…</option>${suspects.map(c=>`<option value="${escapeHtml(c.suspectId)}">${escapeHtml(c.suspectName)}</option>`).join('')}`;
        };
        $('reverseDead').onchange = fillSuspects;
        $('reverseSubmit').onclick = () => {
          const targetId=$('reverseDead').value, secondTargetId=$('reverseSuspect').value;
          if (!targetId || !secondTargetId) return showToast('Escolhe a pessoa eliminada e um dos seus votantes.');
          socket.emit('playerAction',{action:'reverseAnalyze',targetId,secondTargetId});
        };
      }
      return;
    }
    if (phase === 'NIGHT' && role === 'ARMOR_FABRICATOR') {
      const options=state.players.filter(p=>p.alive);
      area.innerHTML=`<div class="action-prompt">FABRICANTE DE BLINDAGEM · DISTRIBUI ATÉ TRÊS PLACAS UMA VEZ POR PARTIDA</div><div class="action-row"><select id="armorTargets" class="action-select" multiple size="4" ${state.me.armorUsed?'disabled':''}>${options.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button id="armorSubmit" class="button action-button" ${state.me.actionSubmitted||state.me.armorUsed?'disabled':''}>${state.me.armorUsed?'PLACAS UTILIZADAS':'FORJAR PLACAS ↗'}</button></div>`;
      $('armorSubmit').onclick=()=>{const targetIds=[...$('armorTargets').selectedOptions].map(o=>o.value);if(!targetIds.length||targetIds.length>3)return showToast('Seleciona entre uma e três pessoas vivas.');socket.emit('playerAction',{action:'armor',targetIds});};
      return;
    }
    if (phase === 'NIGHT' && role === 'MAD_SCIENTIST') {
      const submitted = state.me.actionSubmitted;
      const targets = state.players.filter(p => p.alive && p.id !== playerId);
      const oilCount = state.me.oiledTargets || 0;
      const detonated = Boolean(state.me.detonationTriggered);
      area.innerHTML = `<div class="action-prompt">CIENTISTA LOUCO · ${oilCount} ALVO(S) OLEADO(S)</div><div class="action-row"><select id="oilTarget" class="action-select"><option value="">Escolhe quem oleiar…</option>${targets.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button id="oilSubmit" class="button action-button" ${submitted?'disabled':''}>BOMBEAR ÓLEO ↗</button><button id="detonateSubmit" class="button detonation-button" ${submitted||!oilCount||detonated?'disabled':''}>${detonated?'VÁLVULA ATIVADA':'💥 Ativar Detonador de Óleo'}</button></div>`;
      $('oilSubmit').onclick = () => {
        const targetId = $('oilTarget').value;
        if (!targetId) return showToast('Escolhe um jogador para oleiar.');
        socket.emit('nightAction_PumpOil', { targetId });
      };
      $('detonateSubmit').onclick = () => socket.emit('nightAction_DetonateOil');
      return;
    }
    if (phase === 'NIGHT' && role === 'SCRAP_GRAVEDIGGER') {
      const submitted = state.me.actionSubmitted;
      const players = state.players.filter(p => p.alive && p.id !== playerId);
      const options = players.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
      area.innerHTML = `<div class="action-prompt">COVEIRO DE SUCATA · ESCOLHE QUEM SERÁ DESVIADO E O NOVO ALVO</div><div class="action-row"><select id="redirectPlayer" class="action-select"><option value="">Jogador afetado…</option>${options}</select><select id="redirectTarget" class="action-select"><option value="">Novo alvo…</option>${options}</select><button id="redirectSubmit" class="button action-button" ${submitted?'disabled':''}>DESVIAR AÇÃO ↗</button></div>`;
      $('redirectSubmit').onclick = () => {
        const targetId = $('redirectPlayer').value, redirectTargetId = $('redirectTarget').value;
        if (!targetId || !redirectTargetId) return showToast('Escolhe o jogador afetado e o novo alvo.');
        if (targetId === redirectTargetId) return showToast('O novo alvo tem de ser diferente do jogador afetado.');
        socket.emit('nightAction_Redirect', { targetId, redirectTargetId });
      };
      return;
    }
    if (phase === 'NIGHT' && ['CLOCKMAKER','ALCHEMIST','SABOTEUR','SMOKE','AUTOMATON','TESLA_ENGINEER','INDUSTRIAL_SPY','MAINTENANCE_MECHANIC','PRESSURE_TRAPPER','CLANDESTINE_INFORMANT','COPPER_BANKER','SOUL_COLLECTOR'].includes(role)) {
      const submitted = state.me.actionSubmitted;
      const revivalUsed = role === 'MAINTENANCE_MECHANIC' && state.me.revivalUsed;
      const labels = {
        CLOCKMAKER:'ESCOLHE QUEM INVESTIGAR', ALCHEMIST:'ESCOLHE QUEM PROTEGER', SABOTEUR:'ESCOLHE O ALVO DO SINDICATO',
        SMOKE:'ESCOLHE O ALIADO A DISFARÇAR', AUTOMATON:'ESCOLHE QUEM ELIMINAR', TESLA_ENGINEER:'ESCOLHE QUEM VIGIAR',
        INDUSTRIAL_SPY:'ESCOLHE QUEM IDENTIFICAR', MAINTENANCE_MECHANIC:revivalUsed?'RESSURREIÇÃO JÁ UTILIZADA':'ESCOLHE QUEM RESSUSCITAR'
        ,PRESSURE_TRAPPER:'ESCOLHE ONDE ARMAR A ARMADILHA', CLANDESTINE_INFORMANT:'ESCOLHE QUEM SILENCIAR AMANHÃ', COPPER_BANKER:'ESCOLHE QUEM SUBORNAR', SOUL_COLLECTOR:`COLECIONADOR DE ALMAS · ${state.me.mechanizedCount||0} MECANIZADO(S) · ESCOLHE UM ALVO`
      };
      const action = {
        CLOCKMAKER:'inspect', ALCHEMIST:'protect', SABOTEUR:'syndicateKill', SMOKE:'disguise', AUTOMATON:'automatonKill',
        TESLA_ENGINEER:'watch', INDUSTRIAL_SPY:'spy', MAINTENANCE_MECHANIC:'revive'
        ,PRESSURE_TRAPPER:'trap', CLANDESTINE_INFORMANT:'silence', COPPER_BANKER:'bribe', SOUL_COLLECTOR:'mechanize'
      }[role];
      const options = state.players.filter(p=>targetable(p));
      const syndicateVote = ['SMOKE','INDUSTRIAL_SPY','CLANDESTINE_INFORMANT','COPPER_BANKER'].includes(role) ? renderSyndicateVote() : '';
      area.innerHTML = `<div class="action-prompt">${labels[role]}</div><div class="action-row"><select id="targetSelect" class="action-select" ${revivalUsed?'disabled':''}><option value="">Seleciona um habitante…</option>${options.map(p=>`<option value="${escapeHtml(p.id)}" ${selectedTarget===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select><button id="actionSubmit" class="button action-button" ${submitted||revivalUsed?'disabled':''}>${submitted?'AÇÃO CONFIRMADA':revivalUsed?'JÁ UTILIZADA':'CONFIRMAR AÇÃO'} ↗</button></div>${syndicateVote}`;
      $('actionSubmit').onclick = () => {
        const targetId = $('targetSelect').value;
        if (!targetId) return showToast('Seleciona um habitante primeiro.');
        if(role==='SOUL_COLLECTOR') socket.emit('nightAction_Mechanize',{targetId});
        else socket.emit('playerAction',{action,targetId});
      };
      if (syndicateVote) bindSyndicateVote();
    } else if (phase === 'VOTING') {
      const options = state.players.filter(p=>p.alive && p.id!==playerId);
      const controlled=Boolean(state.me.bribeVoteControlled), locked=Boolean(state.me.bribeVoteLocked);
      area.innerHTML = `<div class="action-prompt">${controlled?(locked?'BANQUEIRO DE COBRE · O TEU VOTO FOI HERDADO':'SUBORNO ATIVO · AGUARDA A DECISÃO DO BANQUEIRO'):`ESCOLHE QUEM LEVAR À FORNALHA · ${state.me.voted?'VOTO REGISTADO':''}`}</div><div class="action-row"><select id="voteSelect" class="action-select" ${controlled?'disabled':''}><option value="">Abster-se</option>${options.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button id="voteSubmit" class="button vote-button" ${controlled?'disabled':''}>${controlled?'🪙 VOTO CONFISCADO':state.me.voted?'ALTERAR VOTO':'VOTAR'} ↗</button>${canShoot?'<button id="shootSubmit" class="button action-button">DISPARAR · 1 MUNIÇÃO</button>':''}</div>`;
      if(!controlled)$('voteSubmit').onclick = () => socket.emit('submitVote',{targetId:$('voteSelect').value||null});
      if(canShoot) $('shootSubmit').onclick=()=>shootSelected();
    } else if (canShoot) {
      area.innerHTML = `<div class="action-prompt">INVENTOR · ${state.me.bullets} DISPARO(S) RESTANTE(S)</div><div class="action-row"><select id="shootSelect" class="action-select"><option value="">Seleciona um alvo…</option>${state.players.filter(p=>p.alive&&p.id!==playerId).map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button id="shootSubmit" class="button action-button">DISPARAR ↗</button></div>`;
      $('shootSubmit').onclick=()=>shootSelected();
    } else if (phase === 'DAY') area.innerHTML='<div class="action-prompt">A DISCUSSÃO ESTÁ ABERTA · A VOTAÇÃO COMEÇA NO FIM DO TEMPO</div>';
    else area.innerHTML='';
  }
  function renderSyndicateVote() {
    const options = state.players.filter(p=>p.alive && !(state.syndicate||[]).some(member=>member.id===p.id));
    return `<div class="action-prompt" style="margin-top:13px">VOTO DO SINDICATO · ESCOLHE O ALVO DO ATAQUE</div><div class="action-row"><select id="syndicateVoteSelect" class="action-select"><option value="">Vota num alvo…</option>${options.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select><button id="syndicateVoteSubmit" class="button vote-button">${state.me.syndicateVoted?'ALTERAR VOTO':'VOTAR NO ALVO'} ↗</button></div>`;
  }
  function bindSyndicateVote() {
    $('syndicateVoteSubmit').onclick = () => {
      const targetId = $('syndicateVoteSelect').value;
      if (!targetId) return showToast('Seleciona o alvo do Sindicato.');
      socket.emit('syndicateVote', { targetId });
    };
  }
  function shootSelected() {
    const id = $('shootSelect')?.value || $('voteSelect')?.value;
    if (!id) return showToast('Seleciona um alvo primeiro.');
    socket.emit('playerAction',{action:'shoot',targetId:id});
  }
  function renderLog() {
    $('eventLog').innerHTML = state.log.slice().reverse().map(e=>`<div class="log-entry ${e.type}"><span class="log-time">${new Date(e.at).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})}</span>${escapeHtml(e.message)}</div>`).join('');
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
    const host=state.players?.find(p=>p.id===playerId)?.host;
    $('backToLobby').disabled=!host;
    $('backToLobby').classList.toggle('disabled-button',!host);
    $('backToLobby').textContent=host?'Retornar para a Oficina':'A aguardar pelo Anfitrião';
    $('returnHint').textContent=host?'A oficina e o código da sala serão mantidos para uma nova partida.':'O anfitrião pode reiniciar a oficina quando estiver pronto.';
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  $('createRoom').onclick=()=>{
    const name=$('nameInput').value.trim();
    if(!name)return showToast('Escreve o teu nome primeiro.');
    console.log("Botão clicado! Enviando nome:", name);
    socket.emit('createRoom',{name});
  };
  $('joinRoom').onclick=()=>{const name=$('nameInput').value.trim(),code=$('roomInput').value.trim();if(!name||!code)return showToast('Indica o teu nome e o código da sala.');socket.emit('joinRoom',{name,roomCode:code});};
  $('roomInput').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
  $('startGame').onclick=()=>socket.emit('startGame');
  $('readyButton').onclick=()=>{const me=state?.players.find(p=>p.id===playerId);if(me)socket.emit('setReady',{isReady:!me.isReady});};
  $('copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);showToast('Código copiado.');}catch{showToast(`Código da sala: ${roomCode}`);}};
  $('backToLobby').onclick=()=>{if(!state?.players.find(p=>p.id===playerId)?.host)return;socket.emit('returnToLobby');};
  const backToMenuButton = $('btn-back-to-menu');
  if (backToMenuButton) backToMenuButton.addEventListener('click', () => {
    leaveWorkshop();
  });
  $('audioToggle').addEventListener('click', () => audioManager.toggle());
  document.addEventListener('click', event => {
    if (event.target.closest('button') && !event.target.closest('#audioToggle')) audioManager.playSFX('click');
  }, true);
  $('clearLog').onclick=()=>{$('eventLog').innerHTML='';};
  $('playersList').addEventListener('click',e=>{const id=e.target.closest('[data-target]')?.dataset.target;if(id){selectedTarget=id;renderPlayers();renderActions();}});
  $('playersList').addEventListener('click',e=>{
    const action=e.target.closest('[data-card-action]');
    if(action){socket.emit(action.dataset.cardAction,action.dataset.action?{action:action.dataset.action,targetId:action.dataset.targetId}:{targetId:action.dataset.targetId});return;}
    const vote=e.target.closest('[data-vote-target]');
    if(vote){socket.emit('submitVote',{targetId:vote.dataset.voteTarget});return;}
    const shot=e.target.closest('[data-shoot-target]');
    if(shot){socket.emit('playerAction',{action:'shoot',targetId:shot.dataset.shootTarget});}
  });
  $('chatForm').onsubmit=e=>{e.preventDefault();const input=$('chatInput');if(input.value.trim()){socket.emit('sendMessage',{roomCode,message:input.value.trim()});input.value='';}};
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
  socket.on('roomCreated',({roomCode:createdRoomCode,playerId:createdPlayerId}={})=>{
    if (leavingRoom) return;
    if(!createdRoomCode||!createdPlayerId){
      showToast('A oficina foi criada, mas a confirmação veio incompleta. Atualiza a página.');
      return;
    }
    enterRoom({roomCode:createdRoomCode,playerId:createdPlayerId});
  });
  socket.on('gameState',next=>{if(leavingRoom)return;state=next;render();});
  socket.on('updateVotes',counts=>{if(!state)return;state.voteCounts=counts||{};renderPlayers();});
  socket.on('leftRoom', () => returnToMenu());
  socket.on('gameOver',result=>{
    gameOverPayload=result;
    if(result.winnerFaction==='Colecionador de Almas Mecânicas'||result.winnerFaction==='souls') audioManager.playSFX('mechanizationVictory');
    state={...(state||{}),phase:'GAMEOVER',ended:true,winnerFaction:result.winnerFaction,survivors:result.survivors||[]};
    document.body.classList.remove('night-phase');
    render();
  });
  socket.on('roomReset',()=>{
    gameOverPayload=null;revealedRole=null;selectedTarget=null;
    $('chatMessages').innerHTML='<div class="chat-empty">A oficina foi reiniciada.<br>As ondas aguardam.</div>';
    $('lobby-chat-messages').innerHTML='<div class="lobby-chat-empty">A oficina está em silêncio.<br>Inicia a conversa com a tripulação.</div>';
    document.body.classList.remove('night-phase','game-over','role-reveal-open');
    $('roleRevealModal').classList.add('hidden');
  });
  socket.on('dayStarted',event=>{
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
  socket.on('updatePlayers',players=>{
    if(!state)return;
    const oldPlayers=new Map(state.players.map(p=>[p.id,p]));
    state.players=players.map(p=>{const old=oldPlayers.get(p.id)||{};return {...old,id:p.id,name:p.name,host:p.isHost,alive:p.isAlive,isReady:p.isReady,isSilenced:Boolean(p.isSilenced)};});
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
  socket.on('connect',()=>{$('connectionLabel').textContent='LIGADO';});
  socket.on('disconnect',()=>{$('connectionLabel').textContent='DESLIGADO';});
  socket.on('connect_error',()=>{
    $('connectionLabel').textContent='SEM LIGAÇÃO';
    showToast('Não foi possível ligar ao servidor. Atualiza a página e tenta novamente.');
  });
  function addChat(name,message,privateMessage,type='player'){
    const box=$('chatMessages');box.querySelector('.chat-empty')?.remove();
    const row=document.createElement('div');row.className=`chat-message ${type==='system'?'system':''} ${type==='system-error'?'system-error':''} ${type==='system-warning'?'system-warning':''}`;
    const sender=document.createElement('strong');sender.textContent=`${name}${privateMessage?' · PRIVADO':''}`;
    const text=document.createElement('span');text.textContent=message;
    row.append(sender,text);box.appendChild(row);box.scrollTop=box.scrollHeight;
  }
  function appendLobbyChatMessage(data = {}) {
    if (data.type === 'player') {
      const localName = state?.players?.find(player => player.id === playerId)?.name || $('nameInput').value.trim();
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
    row.className = `lobby-chat-message ${data.type === 'system' ? 'system' : 'player'}`;
    const sender = document.createElement('strong');
    sender.textContent = data.type === 'system' ? `[Sistema] ${data.sender || 'Sistema'}` : `${data.sender || 'Jogador'}:`;
    const text = document.createElement('span');
    text.textContent = data.text || '';
    row.append(sender, text);
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
