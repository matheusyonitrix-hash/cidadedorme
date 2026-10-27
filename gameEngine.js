const { ROLES, MIN_PLAYERS, createRoleDeck, getRoleInfo, getFaction, getFactionName } = require('./roles');

const DURATIONS = Object.freeze({ NIGHT: 45, DAY: 60, VOTING: 30 });

function checkGameOver(room) {
  if (room.ended) return room.gameOverResult || null;
  // Game mantém os jogadores num Map e expõe room.living() como a coleção de
  // sobreviventes. Filtramos alive explicitamente para a condição de infeção.
  const living = room.living().filter((player) => player.alive === true);
  const soulCollector = living.find((player) => player.role === ROLES.SOUL_COLLECTOR);
  const totalAlive = living.length;
  const mechanizedAlive = living.filter((player) => player.alive === true && player.isMechanized === true).length;
  if (soulCollector && totalAlive > 0 && mechanizedAlive === totalAlive) {
    return room.finish('Colecionador de Almas Mecânicas', 'A oficina foi completamente mecanizada! Vitória do Colecionador de Almas.');
  }
  // Com dois jogadores a composição é um duelo didático e as condições de
  // paridade encerrariam a partida logo na primeira noite. Mantemos o ciclo
  // vivo para permitir testar ações, discussão e votação.
  if (room.testMode) return null;
  const survivors = living.map((player) => ({
    id: player.id, name: player.name, role: player.role,
    faction: player.role ? getFaction(player.role) : null
  }));
  const lastElimination = room.lastElimination;

  if (lastElimination?.cause === 'lynch' && lastElimination.player.role === ROLES.SCRAP_COLLECTOR) {
    return room.finish('scrap', 'O Colecionador de Sucata venceu ao ser eliminado pela Fornalha!');
  }

  if (room.lastScientistDetonation && living.length === 1 && living[0].role === ROLES.MAD_SCIENTIST) {
    return room.finish('scientist', 'O Cientista Louco detonou a cidade e venceu sozinho!');
  }

  const automatons = living.filter((player) => player.role === ROLES.AUTOMATON);
  const neutralThreatAlive = living.some((player) =>
    player.role === ROLES.AUTOMATON || player.role === ROLES.MAD_SCIENTIST
  );
  const syndicate = living.filter((player) => getFaction(player.role) === 'syndicate').length;
  const alliance = living.filter((player) => getFaction(player.role) === 'steam').length;

  if (automatons.length === 1 && (living.length === 1 || (
    living.length === 2 && living.some((player) => player.role === ROLES.WORKER)
  ))) {
    return room.finish('automaton', 'O Autómato Desgovernado tomou a cidade.');
  }
  if (syndicate === 0) {
    return room.finish('steam', 'A Aliança de Vapor desmantelou o Sindicato Rebelde!');
  }

  // Um empate no início de uma sala curta ainda deixa a Aliança chegar ao
  // Tribunal de Bronze. Só Inventor com munição e Ferreiro com cargas podem
  // impedir a exceção de paridade depois de a votação da fase ter acontecido.
  const allianceCanStillAttack = living.some((player) =>
    (player.role === ROLES.INVENTOR && player.bullets > 0) ||
    (player.role === ROLES.BRONZE_SMITH && (player.bronzeCharges > 0 || player.isAlerted))
  );
  const smallRoomTieBeforeTribunal = living.length <= 4 && syndicate === alliance &&
    (room.phase === 'NIGHT' || room.phase === 'DAY');
  const syndicateStrictMajority = syndicate > alliance;
  const syndicateParityWithoutAllianceAttack = syndicate === alliance && !allianceCanStillAttack && !smallRoomTieBeforeTribunal;

  // Dissidentes ainda vivos podem alterar o resultado contra o Sindicato;
  // não terminamos a partida enquanto o Autómato ou o Cientista estiver ativo.
  if (!neutralThreatAlive && (syndicateStrictMajority || syndicateParityWithoutAllianceAttack)) {
    return room.finish('syndicate', 'O Sindicato Rebelde tomou o controlo da cidade!');
  }
  return null;
}

class Game {
  constructor(roomCode, onUpdate = () => {}, { isDebug = false } = {}) {
    this.roomCode = roomCode;
    this.onUpdate = onUpdate;
    this.isDebug = Boolean(isDebug);
    this.players = new Map();
    this.phase = 'LOBBY';
    this.day = 0;
    this.deadPlayers = [];
    this.log = [];
    this.votes = new Map();
    this.syndicateVotes = new Map();
    this.actions = new Map();
    this.timer = null;
    this.deadline = null;
    this.winner = null;
    this.winnerFaction = null;
    this.gameOverResult = null;
    this.lastElimination = null;
    this.ended = false;
    this.testMode = false;
    this.lastInventorShot = new Map();
    this.revivalsUsed = false;
    this.oiledTargets = new Set();
    this.oiledHistory = [];
    this.detonationTriggered = false;
    this.lastScientistDetonation = false;
    this.lastNightExplosionDeaths = [];
    this.lastNightCounterattackMessage = null;
    this.armorUsed = false;
    this.bribedPlayerId = null;
    this.bankerId = null;
    this.voteHistory = [];
    this.timeRewindUsed = false;
    this.stunnedNextNight = new Set();
    this.stunnedThisNight = new Set();
    this.silencedNextDay = new Set();
    this.silencedToday = new Set();
    this.inspectionSwaps = new Map();
  }

  addPlayer({ id, name }) {
    if (this.phase !== 'LOBBY') throw new Error('A partida já começou.');
    if (this.players.size >= 16) throw new Error('A sala está cheia (máximo 16).');
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    if (cleanName.length < 2) throw new Error('O nome precisa de ter pelo menos 2 caracteres.');
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) throw new Error('Esse nome já está a ser usado na sala.');
    const player = { id, name: cleanName, role: null, alive: true, connected: true, host: this.players.size === 0, bullets: 2, isReady: false, isSilenced: false, isOiled: false, hasTitaniumPlate: false, mechanizedBy: null, isMechanized: false, subornedBy: null, bronzeCharges: 0, isAlerted: false };
    this.players.set(id, player);
    this.addLog(`${cleanName} entrou na oficina.`, 'system');
    this.emit();
    return player;
  }

  reconnectPlayer(id) {
    const player = this.players.get(id);
    if (player) { player.connected = true; this.emit(); }
    return player;
  }

  disconnectPlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    this.addLog(`${player.name} perdeu a ligação.`, 'system');
    this.emit();
  }

  setReady(playerId, isReady) {
    if (this.phase !== 'LOBBY') throw new Error('O estado Pronto só pode mudar na oficina.');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Jogador não encontrado nesta oficina.');
    player.isReady = Boolean(isReady);
    this.emit();
    return player;
  }

  removePlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return null;
    this.players.delete(playerId);
    if (this.testMode && this.players.size < MIN_PLAYERS) this.testMode = false;
    this.actions.delete(playerId);
    this.votes.delete(playerId);
    this.syndicateVotes.delete(playerId);
    if (player.host) {
      const nextHost = this.players.values().next().value;
      if (nextHost) nextHost.host = true;
    }
    if (this.players.size > 0) {
      this.emit();
      if (this.phase === 'NIGHT') this.checkNightComplete();
      if (this.phase === 'VOTING') this.checkVotingComplete();
      if (!['LOBBY', 'GAMEOVER'].includes(this.phase)) this.checkGameOver();
      this.emit();
    }
    return player;
  }

  start(playerId) {
    if (this.phase !== 'LOBBY') throw new Error('A partida já começou.');
    if (this.getPlayer(playerId)?.host !== true) throw new Error('Só quem criou a sala pode iniciar a partida.');
    if (this.players.size < MIN_PLAYERS) throw new Error(`São necessários pelo menos ${MIN_PLAYERS} jogadores para começar.`);
    this.testMode = this.players.size === 2;
    this.revivalsUsed = false;
    this.oiledTargets.clear();
    this.oiledHistory = [];
    this.detonationTriggered = false;
    this.lastScientistDetonation = false;
    this.armorUsed = false;
    this.bribedPlayerId = null;
    this.bankerId = null;
    this.voteHistory = [];
    this.lastNightExplosionDeaths = [];
    this.timeRewindUsed = false;
    this.stunnedNextNight.clear(); this.stunnedThisNight.clear();
    this.silencedNextDay.clear(); this.silencedToday.clear(); this.inspectionSwaps.clear();
    this.assignRoles();
    this.addLog('A sirene toca. A cidade adormece.', 'system');
    if (this.testMode) {
      this.addLog('Modo de teste com 2 jogadores: ataques e votos não eliminam participantes nem encerram a partida.', 'system');
    }
    this.beginNight();
  }

  assignRoles(players = [...this.players.values()]) {
    const host = players.find((player) => player.host);
    const debugEnabled = this.isDebug || host?.name?.trim().toLocaleLowerCase('pt') === 'yokki_qa';
    let deck;

    if (debugEnabled) {
      // Cenário QA determinístico: host inocente, Cientista, Sabotador e
      // Alquimista nos três primeiros bots; todos os restantes são Operários.
      const debugRolesByName = new Map([
        ['mecânico_bot_1', ROLES.MAD_SCIENTIST],
        ['mecânico_bot_2', ROLES.SABOTEUR],
        ['mecânico_bot_3', ROLES.ALCHEMIST]
      ]);
      const rolesById = new Map();
      // O anfitrião fica como Operário para poder acompanhar o teste sem ter
      // de submeter uma investigação manual para a noite avançar.
      if (host) rolesById.set(host.id, ROLES.WORKER);
      for (const player of players) {
        const fixedRole = debugRolesByName.get(player.name.trim().toLocaleLowerCase('pt'));
        if (fixedRole) rolesById.set(player.id, fixedRole);
      }
      deck = players.map((player) => rolesById.get(player.id) || ROLES.WORKER);
      this.isDebug = true;
    } else {
      deck = createRoleDeck(players.length);
    }

    players.forEach((player, index) => {
      player.role = deck[index];
      player.alive = true;
      player.bullets = 2;
      player.isOiled = false;
      player.hasTitaniumPlate = false;
      player.mechanizedBy = null;
      player.isMechanized = player.role === ROLES.SOUL_COLLECTOR;
      player.subornedBy = null;
      player.bronzeCharges = player.role === ROLES.BRONZE_SMITH ? 2 : 0;
      player.isAlerted = false;
    });
    return deck;
  }

  getPlayer(id) { return this.players.get(id); }
  living() { return [...this.players.values()].filter((p) => p.alive); }
  aliveByRole(role) { return this.living().filter((p) => p.role === role); }
  activateBronzeAlert(playerId) {
    const actor = this.getPlayer(playerId);
    if (this.phase !== 'NIGHT') throw new Error('A Fornalha de Pressão só pode ser ativada durante a noite.');
    if (!actor?.alive || actor.role !== ROLES.BRONZE_SMITH) throw new Error('Só um Ferreiro de Bronze vivo pode ativar a Fornalha.');
    if (actor.bronzeCharges <= 0) throw new Error('Já não tens cargas disponíveis para ativar a Fornalha.');
    if (actor.isAlerted || this.actions.has(playerId)) throw new Error('A Fornalha já foi ativada nesta noite.');
    actor.bronzeCharges -= 1;
    actor.isAlerted = true;
    this.actions.set(playerId, { action: 'veteranActivate', targetId: null });
    this.emitPrivate(playerId, { type: 'bronzeAlertActivated', bronzeCharges: actor.bronzeCharges });
    this.checkNightComplete();
    this.emit();
    return actor;
  }
  skipBronzeAlert(playerId) {
    const actor = this.getPlayer(playerId);
    if (this.phase !== 'NIGHT' || !actor?.alive || actor.role !== ROLES.BRONZE_SMITH) {
      throw new Error('Só um Ferreiro de Bronze vivo pode guardar a carga durante a noite.');
    }
    if (actor.isAlerted || this.actions.has(playerId)) throw new Error('A tua decisão para esta noite já foi registada.');
    this.actions.set(playerId, { action: 'veteranSkip', targetId: null });
    this.emitPrivate(playerId, { type: 'bronzeAlertSkipped', bronzeCharges: actor.bronzeCharges });
    this.checkNightComplete();
    this.emit();
    return actor;
  }
  requiredNightActors() {
    return this.living().filter((p) => [
      ROLES.SABOTEUR, ROLES.ALCHEMIST, ROLES.CLOCKMAKER, ROLES.SMOKE, ROLES.AUTOMATON,
      ROLES.TESLA_ENGINEER, ROLES.BRONZE_SMITH, ROLES.MAINTENANCE_MECHANIC,
      ROLES.INDUSTRIAL_SPY, ROLES.MAD_SCIENTIST, ROLES.SCRAP_GRAVEDIGGER,
      ROLES.TIMEKEEPER, ROLES.PRESSURE_TRAPPER, ROLES.ETHER_SMUGGLER, ROLES.CLANDESTINE_INFORMANT
      , ROLES.REVERSE_ENGINEER, ROLES.ARMOR_FABRICATOR, ROLES.COPPER_BANKER, ROLES.SOUL_COLLECTOR
    ].includes(p.role) && (p.role !== ROLES.REVERSE_ENGINEER || this.reverseCandidates().length > 0) &&
      (p.role !== ROLES.BRONZE_SMITH || p.bronzeCharges > 0));
  }

  reverseCandidates() {
    const candidates = [];
    for (const ballot of this.voteHistory) {
      const deceased = this.getPlayer(ballot.targetId);
      const voter = this.getPlayer(ballot.voterId);
      if (deceased && !deceased.alive && voter && voter.id !== deceased.id) {
        candidates.push({ deadTargetId: deceased.id, deadTargetName: deceased.name, suspectId: voter.id, suspectName: voter.name });
      }
    }
    return candidates;
  }

  beginNight() {
    if (this.ended) return;
    this.phase = 'NIGHT'; this.day += 1; this.actions.clear(); this.votes.clear(); this.syndicateVotes.clear();
    this.detonationTriggered = false;
    this.lastNightCounterattackMessage = null;
    this.silencedToday.clear();
    for (const player of this.players.values()) { player.isSilenced = false; player.isAlerted = false; }
    this.inspectionSwaps.clear();
    this.bribedPlayerId = null;
    this.bankerId = null;
    this.stunnedThisNight = new Set([...this.stunnedNextNight].filter((id) => this.getPlayer(id)?.alive));
    this.stunnedNextNight.clear();
    for (const id of this.stunnedThisNight) {
      this.actions.set(id, { action: 'stunned', targetId: null });
      if (getFaction(this.getPlayer(id)?.role) === 'syndicate') this.syndicateVotes.set(id, null);
      this.emitPrivate(id, { type: 'stunned', day: this.day });
    }
    this.lastScientistDetonation = false;
    this.lastNightExplosionDeaths = [];
    this.addLog(`Noite ${this.day}: as engrenagens da cidade abrandam.`, 'system');
    this.setTimer('NIGHT', () => this.resolveNight());
    this.emit();
    this.checkNightComplete();
  }

  beginDay() {
    if (this.ended) return;
    this.phase = 'DAY'; this.actions.clear();
    const deaths = this.lastNightDeaths || [];
    if (!deaths.length) this.addLog('O sol nasce. Ninguém foi eliminado durante a noite.', 'system');
    else for (const player of deaths) this.addLog(`O sol nasce. ${player.name} foi encontrado sem vida. Era ${getRoleInfo(player.role).name}.`, 'death');
    this.silencedToday = new Set([...this.silencedNextDay].filter((id) => this.getPlayer(id)?.alive));
    this.silencedNextDay.clear();
    for (const player of this.players.values()) player.isSilenced = this.silencedToday.has(player.id);
    for (const player of this.players.values()) player.isAlerted = false;
    for (const id of this.silencedToday) this.emitPrivate(id, { type: 'silencedToday', day: this.day });
    if (!this.ended) { this.setTimer('DAY', () => this.beginVoting()); this.emit(); }
  }

  beginVoting() {
    if (this.ended) return;
    this.phase = 'VOTING'; this.votes.clear();
    this.addLog('Discussão encerrada. Escolham quem será levado à Fornalha.', 'system');
    this.setTimer('VOTING', () => this.resolveVote());
    this.emit();
    this.checkVotingComplete();
  }

  setTimer(phase, callback) {
    clearTimeout(this.timer);
    const seconds = DURATIONS[phase];
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(callback, seconds * 1000);
  }

  submitAction(playerId, action, targetId, options = {}) {
    const actor = this.getPlayer(playerId);
    if (!actor?.alive) throw new Error('Só jogadores vivos podem agir.');
    if (this.phase !== 'NIGHT') throw new Error('As ações só podem ser feitas durante a noite.');
    const valid = {
      [ROLES.SABOTEUR]: ['syndicateKill'], [ROLES.ALCHEMIST]: ['protect'],
      [ROLES.CLOCKMAKER]: ['inspect'], [ROLES.SMOKE]: ['disguise'], [ROLES.AUTOMATON]: ['automatonKill'],
      [ROLES.TESLA_ENGINEER]: ['watch'], [ROLES.BRONZE_SMITH]: ['veteranActivate', 'veteranSkip'],
      [ROLES.MAINTENANCE_MECHANIC]: ['revive'], [ROLES.INDUSTRIAL_SPY]: ['spy'],
      [ROLES.MAD_SCIENTIST]: ['oil', 'detonateOil'], [ROLES.SCRAP_GRAVEDIGGER]: ['redirect'],
      [ROLES.TIMEKEEPER]: ['rewind'], [ROLES.PRESSURE_TRAPPER]: ['trap'],
      [ROLES.ETHER_SMUGGLER]: ['swapInspection'], [ROLES.CLANDESTINE_INFORMANT]: ['silence'],
      [ROLES.REVERSE_ENGINEER]: ['reverseAnalyze'], [ROLES.ARMOR_FABRICATOR]: ['armor'],
      [ROLES.COPPER_BANKER]: ['bribe'], [ROLES.SOUL_COLLECTOR]: ['mechanize']
    }[actor.role] || [];
    if (!valid.includes(action)) throw new Error('Essa ação não pertence à tua classe.');
    if (this.stunnedThisNight.has(playerId)) throw new Error('Foste atordoado e não podes agir esta noite.');
    if (action === 'veteranActivate') return this.activateBronzeAlert(playerId);
    if (action === 'veteranSkip') return this.skipBronzeAlert(playerId);
    const targetOptional = ['veteranActivate', 'detonateOil', 'rewind', 'armor'].includes(action);
    const target = targetId ? this.getPlayer(targetId) : null;
    if (!targetOptional && !target) throw new Error('Escolhe um jogador.');
    let secondTargetId = null;
    let targetIds = null;
    if (action === 'reverseAnalyze') {
      const suspect = this.getPlayer(options.secondTargetId);
      if (!target || target.alive || !this.deadPlayers.some((dead) => dead.id === target.id)) throw new Error('Escolhe uma pessoa eliminada para analisar.');
      if (!suspect || !this.voteHistory.some((ballot) => ballot.targetId === target.id && ballot.voterId === suspect.id)) {
        throw new Error('Esse suspeito não votou na pessoa eliminada escolhida.');
      }
      secondTargetId = suspect.id;
    } else if (action === 'armor') {
      targetIds = [...new Set(Array.isArray(options.targetIds) ? options.targetIds : [])];
      if (this.armorUsed) throw new Error('As placas de titânio já foram distribuídas nesta partida.');
      if (targetIds.length < 1 || targetIds.length > 3 || targetIds.some((id) => !this.getPlayer(id)?.alive)) {
        throw new Error('Escolhe entre uma e três pessoas vivas para receber uma placa.');
      }
    } else if (action === 'revive') {
      if (this.revivalsUsed) throw new Error('O Mecânico já gastou a sua ressurreição nesta partida.');
      if (target?.alive || !this.deadPlayers.some((dead) => dead.id === target?.id)) throw new Error('Escolhe um jogador eliminado para ressuscitar.');
    } else if (target && !target.alive) throw new Error('Escolhe um jogador vivo.');
    if (action === 'oil' && target?.isOiled) throw new Error('Esse jogador já foi oleado.');
    if (action === 'detonateOil' && ![...this.players.values()].some((player) => player.alive && player.isOiled)) throw new Error('Ainda não há jogadores oleados para detonar.');
    if (action === 'rewind' && this.timeRewindUsed) throw new Error('O retrocesso já foi usado nesta partida.');
    if (target?.id === playerId && action !== 'mechanize') throw new Error('Não podes escolher-te como alvo.');
    if (action === 'syndicateKill' && getFaction(target.role) === 'syndicate') throw new Error('O Sindicato não pode escolher um dos seus membros.');
    if (action === 'disguise' && getFaction(target.role) !== 'syndicate') throw new Error('A Cortina de Fumo só pode disfarçar um aliado do Sindicato.');
    if (action === 'redirect') {
      const redirectTarget = this.getPlayer(options.redirectTargetId);
      if (!redirectTarget?.alive || redirectTarget.id === target.id) throw new Error('Escolhe um alvo vivo e diferente para redirecionar a ação.');
      if (![ROLES.CLOCKMAKER, ROLES.ALCHEMIST, ROLES.SABOTEUR, ROLES.SMOKE, ROLES.AUTOMATON, ROLES.TESLA_ENGINEER, ROLES.MAINTENANCE_MECHANIC, ROLES.INDUSTRIAL_SPY, ROLES.MAD_SCIENTIST, ROLES.TIMEKEEPER, ROLES.PRESSURE_TRAPPER, ROLES.ETHER_SMUGGLER, ROLES.CLANDESTINE_INFORMANT, ROLES.COPPER_BANKER, ROLES.SOUL_COLLECTOR].includes(target.role)) {
        throw new Error('Esse jogador não tem uma ação noturna que possa ser desviada.');
      }
    }
    if (action === 'swapInspection') {
      const secondTarget = this.getPlayer(options.secondTargetId);
      if (!secondTarget?.alive || secondTarget.id === target.id) throw new Error('Escolhe duas pessoas vivas e diferentes para trocar as identidades.');
      secondTargetId = secondTarget.id;
    }
    if (action === 'disguise' && target.id === actor.id) throw new Error('Escolhe outro membro do Sindicato.');
    if (action === 'shoot') {
      if (actor.role !== ROLES.INVENTOR) throw new Error('Só o Inventor pode disparar.');
      if (this.phase !== 'VOTING' && this.phase !== 'DAY') throw new Error('O Inventor só pode disparar durante o dia.');
      if (actor.bullets <= 0) throw new Error('Já gastaste os dois disparos.');
      if (target.id === actor.id) throw new Error('Não podes disparar contra ti.');
      actor.bullets -= 1;
      this.eliminate(target, 'shot');
      if (getFaction(target.role) === 'steam') this.eliminate(actor, 'misfire');
      this.addLog(`${actor.name} disparou contra ${target.name}.`, 'event');
      this.checkGameOver(); this.emit(); return;
    }
    const previous = this.actions.get(playerId);
    const redirectTargetId = action === 'redirect' ? options.redirectTargetId : null;
    if (action === 'mechanize' && !target?.alive) throw new Error('Escolhe uma pessoa viva para mecanizar.');
    if (action === 'mechanize' && target.isMechanized) throw new Error('Essa pessoa já foi mecanizada.');
    this.actions.set(playerId, { action, targetId: target?.id || null, targetIds, redirectTargetId, secondTargetId, count: previous?.count || 1 });
    if (action === 'detonateOil') this.detonationTriggered = true;
    if (action === 'syndicateKill') this.syndicateVotes.set(playerId, targetId);
    const confirmationTarget = target?.name || (action === 'veteranActivate' ? 'forja ativada' : action === 'rewind' ? 'retrocesso preparado' : 'detonação preparada');
    this.emitPrivate(playerId, { type: 'actionConfirmed', action, targetName: confirmationTarget });
    // O bombeamento não deixa qualquer vestígio no log global.
    if (action !== 'oil') this.addLog(`${actor.name} confirmou uma ação.`, 'private');
    this.checkNightComplete();
    this.emit();
  }

  shoot(playerId, targetId) {
    const actor = this.getPlayer(playerId);
    if (!actor?.alive) throw new Error('Só jogadores vivos podem disparar.');
    if (!['DAY', 'VOTING'].includes(this.phase)) throw new Error('O Inventor só pode disparar durante o dia.');
    if (actor.role !== ROLES.INVENTOR) throw new Error('Só o Inventor pode disparar.');
    if (actor.bullets <= 0) throw new Error('Já gastaste os dois disparos.');
    const target = this.getPlayer(targetId);
    if (!target?.alive || target.id === actor.id) throw new Error('Escolhe outro jogador vivo.');
    actor.bullets -= 1;
    this.eliminate(target, 'shot');
    if (getFaction(target.role) === 'steam') this.eliminate(actor, 'misfire');
    this.addLog(`${actor.name} disparou contra ${target.name}.`, 'event');
    this.checkGameOver(); this.emit();
  }

  checkNightComplete() {
    if (this.phase !== 'NIGHT') return;
    // Cada função ativa age e todos os membros do Sindicato registam o voto partilhado.
    const actors = this.requiredNightActors();
    const actionsComplete = actors.every((p) => this.actions.has(p.id));
    const syndicateVotesComplete = this.living().filter((p) => getFaction(p.role) === 'syndicate')
      .every((p) => this.syndicateVotes.has(p.id));
    if (actionsComplete && syndicateVotesComplete) { clearTimeout(this.timer); this.resolveNight(); }
  }

  resolveNight() {
    if (this.phase !== 'NIGHT' || this.ended) return;
    clearTimeout(this.timer);
    // O Coveiro altera a intenção registada da vítima antes da resolução.
    for (const [actorId, action] of this.actions) {
      if (action.action !== 'redirect') continue;
      const forcedPlayer = this.getPlayer(action.targetId);
      const forcedAction = forcedPlayer && this.actions.get(forcedPlayer.id);
      if (!forcedAction || !forcedAction.targetId || forcedAction.action === 'redirect' || forcedAction.action === 'veteranActivate') continue;
      forcedAction.targetId = action.redirectTargetId;
      if (forcedPlayer.role === ROLES.SABOTEUR) this.syndicateVotes.set(forcedPlayer.id, action.redirectTargetId);
      this.emitPrivate(forcedPlayer.id, { type: 'actionRedirected', targetName: this.getPlayer(action.redirectTargetId)?.name || 'alvo desconhecido' });
    }

    // Uma ação submetida antes de uma morte simultânea continua a resolver.
    const actionFor = (role) => [...this.actions.entries()].map(([id, a]) => ({ actor: this.getPlayer(id), ...a })).filter((a) => a.actor?.role === role);
    const alertedSmiths = new Set(this.living()
      .filter((player) => player.role === ROLES.BRONZE_SMITH && player.isAlerted)
      .map((player) => player.id));
    const counterattackedIds = new Set();
    const protections = new Set(actionFor(ROLES.ALCHEMIST).map((a) => a.targetId));
    const rewindAction = actionFor(ROLES.TIMEKEEPER).find((a) => a.action === 'rewind');
    const traps = new Set(actionFor(ROLES.PRESSURE_TRAPPER).filter((a) => a.action === 'trap').map((a) => a.targetId));
    for (const { actor, action, targetId, secondTargetId } of actionFor(ROLES.ETHER_SMUGGLER)) {
      if (action === 'swapInspection' && targetId && secondTargetId) {
        this.inspectionSwaps.set(targetId, secondTargetId);
        this.inspectionSwaps.set(secondTargetId, targetId);
      }
    }
    for (const { actor, action, targetId } of actionFor(ROLES.CLANDESTINE_INFORMANT)) {
      if (action === 'silence' && targetId) {
        this.silencedNextDay.add(targetId);
        const target = this.getPlayer(targetId);
        if (target) target.isSilenced = true;
        this.emitPrivate(actor.id, { type: 'silenceApplied', targetName: this.getPlayer(targetId)?.name });
      }
    }
    const disguise = actionFor(ROLES.SMOKE).at(-1)?.targetId;
    const visits = [];
    const addVisit = (visitorId, targetId) => {
      if (targetId && visitorId !== targetId && !this.stunnedThisNight.has(visitorId) && !visits.some((visit) => visit.visitorId === visitorId && visit.targetId === targetId)) {
        visits.push({ visitorId, targetId });
      }
    };
    for (const [visitorId, action] of this.actions) addVisit(visitorId, action.targetId);
    for (const [visitorId, targetId] of this.syndicateVotes) addVisit(visitorId, targetId);

    const attacks = [];
    if ([...this.syndicateVotes.values()].some(Boolean)) {
      const counts = new Map();
      this.syndicateVotes.forEach((targetId) => { if (targetId) counts.set(targetId, (counts.get(targetId) || 0) + 1); });
      const max = Math.max(...counts.values());
      const tied = [...counts].filter(([, count]) => count === max).map(([id]) => id);
      if (tied.length === 1) attacks.push({ targetId: tied[0], source: 'syndicate', attackerId: this.aliveByRole(ROLES.SABOTEUR)[0]?.id });
    }
    actionFor(ROLES.AUTOMATON).forEach((a) => attacks.push({ targetId: a.targetId, source: 'automaton', attackerId: a.actor.id }));
    const scientists = actionFor(ROLES.MAD_SCIENTIST);
    // O Fabricante distribui até três placas uma única vez. A placa fica
    // ativa antes dos ataques, para poder absorver o primeiro que atingir o jogador.
    for (const { actor, action, targetIds = [] } of actionFor(ROLES.ARMOR_FABRICATOR)) {
      if (action !== 'armor' || this.armorUsed) continue;
      this.armorUsed = true;
      for (const id of targetIds) {
        const recipient = this.getPlayer(id);
        if (!recipient?.alive) continue;
        recipient.hasTitaniumPlate = true;
        this.emitPrivate(recipient.id, { type: 'armorGranted', makerName: actor.name });
      }
      this.emitPrivate(actor.id, { type: 'armorDeployed', count: targetIds.length });
    }
    for (const { actor, action, targetId } of actionFor(ROLES.COPPER_BANKER)) {
      if (action !== 'bribe' || !this.getPlayer(targetId)?.alive) continue;
      this.bribedPlayerId = targetId;
      this.bankerId = actor.id;
      this.getPlayer(targetId).subornedBy = actor.id;
      this.emitPrivate(targetId, { type: 'bribed', bankerName: actor.name });
      this.emitPrivate(actor.id, { type: 'bribeApplied', targetName: this.getPlayer(targetId).name });
    }
    const explosionVictimIds = new Set();
    for (const action of scientists) {
      if (action.action === 'oil' && action.targetId && !this.detonationTriggered) {
        const target = this.getPlayer(action.targetId);
        if (target && alertedSmiths.has(target.id)) {
          counterattackedIds.add(action.actor.id);
          continue;
        }
        // O óleo permanece no jogador entre noites. Esta ação não gera log,
        // evento de chat nem confirmação pública.
        if (target?.alive && !target.isOiled) {
          target.isOiled = true;
          if (!this.oiledHistory.includes(target.id)) this.oiledHistory.push(target.id);
          this.oiledTargets.add(target.id); // compatibilidade com interfaces antigas
        }
      }
      if (action.action === 'detonateOil' && this.detonationTriggered) {
        this.lastScientistDetonation = true;
        for (const player of this.players.values()) {
          if (player.alive && player.isOiled) {
            attacks.push({ targetId: player.id, source: 'scientist', attackerId: action.actor.id });
            explosionVictimIds.add(player.id);
          }
        }
      }
    }

    // A forja elimina os visitantes, exceto o Alquimista. O ataque ao Ferreiro
    // falha e o autor é marcado para morrer no contra-ataque.
    for (const smithId of alertedSmiths) {
      for (const visit of visits.filter((entry) => entry.targetId === smithId)) {
        const visitor = this.getPlayer(visit.visitorId);
        if (!visitor?.alive || visitor.role === ROLES.ALCHEMIST) continue;
        counterattackedIds.add(visitor.id);
        attacks.push({ targetId: visitor.id, source: 'veteran', attackerId: smithId });
      }
    }

    const deaths = new Map();
    for (const attack of attacks) {
      const target = this.getPlayer(attack.targetId);
      if (target && alertedSmiths.has(target.id) && attack.source !== 'veteran') {
        if (attack.attackerId) counterattackedIds.add(attack.attackerId);
        continue;
      }
      if (!target?.alive || (target.role === ROLES.AUTOMATON && attack.source !== 'scientist')) continue;
      if (target.hasTitaniumPlate) {
        target.hasTitaniumPlate = false;
        this.emitPrivate(target.id, { type: 'armorAbsorbed', source: attack.source });
        continue;
      }
      if (protections.has(target.id) && attack.source !== 'scientist') continue;
      deaths.set(target.id, target);
    }
    // Contra-ataques são inevitáveis: não podem ser absorvidos por proteções,
    // placas ou imunidade noturna do Autómato.
    for (const attackerId of counterattackedIds) {
      const attacker = this.getPlayer(attackerId);
      if (attacker?.alive) deaths.set(attacker.id, attacker);
    }

    if (rewindAction && !this.detonationTriggered && !this.timeRewindUsed && deaths.size > 0 && !this.testMode) {
      const [savedId] = deaths.keys();
      deaths.delete(savedId);
      this.timeRewindUsed = true;
      this.emitPrivate(rewindAction.actor.id, { type: 'timeRewind', savedName: this.getPlayer(savedId)?.name });
      this.addLog('Um retrocesso temporal impediu uma eliminação durante a noite.', 'event');
    }
    for (const visit of visits) if (traps.has(visit.targetId)) this.stunnedNextNight.add(visit.visitorId);

    let resolvedDeaths = this.testMode ? [] : [...deaths.values()];
    for (const target of resolvedDeaths) this.eliminate(target, 'night');
    this.lastNightExplosionDeaths = this.testMode
      ? []
      : resolvedDeaths.filter((player) => explosionVictimIds.has(player.id)).map((player) => ({ id: player.id, name: player.name, role: player.role }));

    if (this.detonationTriggered) {
      // A detonação consome a reserva de óleo mesmo quando o modo de teste
      // evita aplicar eliminações reais.
      for (const player of this.players.values()) player.isOiled = false;
      this.oiledHistory = [];
      this.oiledTargets.clear();
    }

    // A ressurreição é aplicada depois dos ataques e antes do amanhecer.
    for (const { actor, action, targetId } of actionFor(ROLES.MAINTENANCE_MECHANIC)) {
      if (action !== 'revive' || this.revivalsUsed) continue;
      const target = this.getPlayer(targetId);
      if (!target || target.alive) continue;
      if (this.detonationTriggered && explosionVictimIds.has(target.id)) continue;
      target.alive = true;
      this.revivalsUsed = true;
      this.deadPlayers = this.deadPlayers.filter((dead) => dead.id !== target.id);
      resolvedDeaths = resolvedDeaths.filter((dead) => dead.id !== target.id);
      this.addLog(`${actor.name} reativou ${target.name} na oficina.`, 'event');
      this.emitPrivate(actor.id, { type: 'revivalResult', targetName: target.name });
    }
    // Infeção silenciosa: mecanizar não é um ataque. Esta ação nunca elimina
    // nem altera a vida do alvo, ignora a proteção física do Alquimista e só
    // marca jogadores que continuam vivos depois dos ataques independentes.
    for (const { actor, action, targetId } of actionFor(ROLES.SOUL_COLLECTOR)) {
      const target = this.getPlayer(targetId);
      if (action === 'mechanize' && target?.alive === true && !target.isMechanized) {
        target.isMechanized = true;
        target.mechanizedBy = actor.id;
        if (this.isDebug) {
          console.log(`⚙️ [DEBUG] Colecionador de Almas Mecânicas infectou ${target.name}`);
        }
      }
    }
    this.lastNightDeaths = resolvedDeaths;
    this.lastNightExplosionDeaths = this.lastNightExplosionDeaths.filter((player) => !this.getPlayer(player.id)?.alive);
    const counterattackDeaths = resolvedDeaths.filter((player) => counterattackedIds.has(player.id));
    this.lastNightCounterattackMessage = counterattackDeaths.length
      ? `[FORNALHA] Quem tentou invadir a oficina do Ferreiro de Bronze foi consumido pelo vapor fervente: ${counterattackDeaths.map((player) => player.name).join(', ')}.`
      : null;

    if (this.testMode && attacks.length) {
      this.addLog('O ataque noturno foi simulado; no modo de teste ninguém é eliminado.', 'system');
    }

    // As investigações e a vigilância enviam os seus resultados em privado.
    for (const { actor, targetId } of actionFor(ROLES.CLOCKMAKER)) {
      const target = this.getPlayer(targetId);
      if (!target || alertedSmiths.has(target.id) || counterattackedIds.has(actor.id)) continue;
      const swappedId = this.inspectionSwaps.get(target.id);
      const inspectedIdentity = swappedId ? this.getPlayer(swappedId) : target;
      const falsified = inspectedIdentity?.role === ROLES.PATENT_FORGER;
      const masked = target.id === disguise || falsified;
      const faction = masked ? 'steam' : getFaction(inspectedIdentity?.role);
      this.emitPrivate(actor.id, {
        type: 'inspectionResult',
        targetName: target.name,
        targetRole: masked ? 'Identidade mascarada' : (getRoleInfo(inspectedIdentity?.role)?.name || 'Cargo desconhecido'),
        faction,
        factionName: getFactionName(faction),
        day: this.day
      });
    }

    for (const { actor, targetId } of actionFor(ROLES.INDUSTRIAL_SPY)) {
      const target = this.getPlayer(targetId);
      if (target && !alertedSmiths.has(target.id) && !counterattackedIds.has(actor.id)) this.emitPrivate(actor.id, {
        type: 'spyResult', targetName: target.name,
        targetRole: getRoleInfo(target.role)?.name || 'Cargo desconhecido',
        factionName: getFactionName(getFaction(target.role)), day: this.day
      });
    }
    for (const { actor, targetId } of actionFor(ROLES.TESLA_ENGINEER)) {
      const target = this.getPlayer(targetId);
      if (!target || alertedSmiths.has(target.id) || counterattackedIds.has(actor.id)) continue;
      const visitors = visits.filter((visit) => visit.targetId === targetId)
        .map((visit) => this.getPlayer(visit.visitorId)?.name).filter(Boolean);
      this.emitPrivate(actor.id, { type: 'visitorReport', targetName: target.name, visitors, day: this.day });
    }
    for (const { actor, targetId, secondTargetId } of actionFor(ROLES.REVERSE_ENGINEER)) {
      const deceased = this.getPlayer(targetId), suspect = this.getPlayer(secondTargetId);
      if (!deceased || !suspect) continue;
      this.emitPrivate(actor.id, {
        type: 'reverseAnalysis', deadName: deceased.name, suspectName: suspect.name,
        suspectRole: getRoleInfo(suspect.role)?.name || 'Cargo desconhecido', day: this.day
      });
    }

    if (this.detonationTriggered) {
      // Publica o relatório da madrugada mesmo se a detonação encerrar a partida.
      this.beginDay();
      this.checkGameOver();
      if (!this.ended) this.lastScientistDetonation = false;
      this.emit();
      return;
    }
    this.checkGameOver();
    if (!this.ended) this.lastScientistDetonation = false;
    if (!this.ended) this.beginDay();
    this.emit();
  }

  submitVote(playerId, targetId) {
    const voter = this.getPlayer(playerId);
    if (this.phase !== 'VOTING') throw new Error('A votação está fechada.');
    if (!voter?.alive) throw new Error('Só jogadores vivos podem votar.');
    if (targetId && !this.getPlayer(targetId)?.alive) throw new Error('Esse alvo já não está vivo.');
    if (targetId === playerId) throw new Error('Não podes votar em ti.');
    if (voter.subornedBy) {
      const banker = this.getPlayer(voter.subornedBy);
      if (banker?.alive && this.votes.has(banker.id)) {
        targetId = this.votes.get(banker.id);
        this.emitPrivate(playerId, { type: 'voteConfiscated', targetName: targetId ? this.getPlayer(targetId)?.name : null });
      } else if (banker?.alive) {
        this.emitPrivate(playerId, { type: 'voteConfiscated', waitingForBanker: true });
        return false;
      }
    }
    this.votes.set(playerId, targetId || null);
    this.emitPrivate(playerId, { type: 'voteConfirmed', targetName: targetId ? this.getPlayer(targetId).name : null });
    if (voter.role === ROLES.COPPER_BANKER) {
      for (const bribed of this.living().filter((player) => player.subornedBy === voter.id)) {
        this.votes.set(bribed.id, targetId || null);
        this.emitPrivate(bribed.id, { type: 'voteConfiscated', targetName: targetId ? this.getPlayer(targetId)?.name : null });
      }
    }
    this.checkVotingComplete(); this.emit();
  }

  submitSyndicateVote(playerId, targetId) {
    const voter = this.getPlayer(playerId);
    if (this.phase !== 'NIGHT') throw new Error('O voto do Sindicato só está aberto durante a noite.');
    if (!voter?.alive || getFaction(voter.role) !== 'syndicate') throw new Error('Só membros vivos do Sindicato podem votar no alvo.');
    if (this.stunnedThisNight.has(playerId)) throw new Error('Foste atordoado e não podes agir esta noite.');
    const target = this.getPlayer(targetId);
    if (!target?.alive || getFaction(target.role) === 'syndicate') throw new Error('Escolhe um alvo vivo que não pertença ao Sindicato.');
    this.syndicateVotes.set(playerId, targetId);
    this.emitPrivate(playerId, { type: 'syndicateVoteConfirmed', targetName: target.name });
    this.checkNightComplete();
    this.emit();
  }

  checkVotingComplete() {
    if (this.phase === 'VOTING' && this.living().every((p) => this.votes.has(p.id))) {
      clearTimeout(this.timer); this.resolveVote();
    }
  }

  resolveVote() {
    if (this.phase !== 'VOTING' || this.ended) return;
    clearTimeout(this.timer);
    for (const [voterId, ballotTarget] of this.votes) {
      this.voteHistory.push({ voterId, targetId: ballotTarget, day: this.day });
    }
    const counts = new Map();
    for (const targetId of this.votes.values()) if (targetId) counts.set(targetId, (counts.get(targetId) || 0) + 1);
    const highest = Math.max(0, ...counts.values());
    const leaders = [...counts].filter(([, count]) => count === highest && highest > 0).map(([id]) => id);
    const tied = leaders.length > 1;
    if (leaders.length === 1) {
      const target = this.getPlayer(leaders[0]);
      if (this.testMode) {
        this.addLog(`${target.name} recebeu mais votos. No modo de teste, a eliminação não é aplicada.`, 'system');
      } else {
        this.eliminate(target, 'lynch');
        this.addLog(`${target.name} foi lançado à Fornalha. Era ${getRoleInfo(target.role).name}.`, 'death');
      }
    } else if (tied) {
      const message = '[TRIBUNAL] O comitê de bronze ficou dividido! Houve um empate na votação e ninguém será enviado para a Fornalha hoje.';
      this.addLog('Houve empate. Ninguém foi lançado à Fornalha.', 'system');
      this.onSystemMessage?.(message);
    } else {
      this.addLog('Ninguém recebeu votos. A Fornalha permanece apagada.', 'system');
    }
    // O suborno é temporário: termina com esta votação, mesmo se a partida acabar.
    for (const player of this.players.values()) player.subornedBy = null;
    this.bribedPlayerId = null;
    this.bankerId = null;
    if (tied) {
      this.beginNight();
      return;
    }
    const result = this.checkGameOver();
    if (result) return result;
    if (!this.ended) this.beginNight();
  }

  eliminate(player, cause) {
    if (!player?.alive) return false;
    player.alive = false;
    if (player.isOiled) {
      player.isOiled = false;
      this.oiledTargets.delete(player.id);
    }
    this.deadPlayers.push({ id: player.id, name: player.name, role: player.role, cause, day: this.day });
    this.lastElimination = { player, cause, day: this.day };
    return true;
  }

  checkGameOver() { return checkGameOver(this); }

  finish(winner, message) {
    if (this.ended) return this.gameOverResult;
    this.ended = true; this.winner = winner; this.winnerFaction = winner; this.phase = 'GAMEOVER';
    clearTimeout(this.timer); this.deadline = null;
    this.addLog(message, 'victory');
    this.gameOverResult = {
      winnerFaction: winner,
      survivors: this.living().map((player) => ({
        id: player.id, name: player.name, role: player.role,
        faction: player.role ? getFaction(player.role) : null
      }))
    };
    this.emit();
    return this.gameOverResult;
  }

  resetToLobby({ emit = true } = {}) {
    if (this.phase !== 'GAMEOVER') throw new Error('Só é possível reiniciar uma partida terminada.');
    clearTimeout(this.timer);
    this.timer = null; this.deadline = null; this.phase = 'LOBBY'; this.day = 0;
    // O sinal ended também é publicado ao cliente; deixá-lo true mantinha
    // a tela de fim de jogo aberta mesmo depois de a fase voltar ao lobby.
    this.ended = false;
    this.deadPlayers = []; this.log = []; this.votes.clear(); this.syndicateVotes.clear(); this.actions.clear();
    this.winner = null; this.winnerFaction = null; this.gameOverResult = null; this.lastElimination = null;
    this.testMode = false;
    this.lastNightDeaths = [];
    this.revivalsUsed = false; this.oiledTargets.clear(); this.oiledHistory = []; this.detonationTriggered = false; this.lastScientistDetonation = false;
    this.armorUsed = false; this.bribedPlayerId = null; this.bankerId = null; this.voteHistory = [];
    this.lastNightExplosionDeaths = [];
    this.timeRewindUsed = false;
    this.stunnedNextNight.clear(); this.stunnedThisNight.clear();
    this.silencedNextDay.clear(); this.silencedToday.clear(); this.inspectionSwaps.clear();
    for (const player of this.players.values()) {
      player.role = null; player.alive = true; player.bullets = 2; player.isReady = false; player.isSilenced = false; player.hasTitaniumPlate = false; player.mechanizedBy = null; player.isMechanized = false; player.subornedBy = null; player.bronzeCharges = 0; player.isAlerted = false;
    }
    if (emit) this.emit();
  }

  addLog(message, type = 'event') {
    this.log.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, type, at: Date.now() });
    if (this.log.length > 100) this.log.shift();
  }

  publicState(forPlayerId) {
    const player = this.getPlayer(forPlayerId);
    const privateActions = player ? this.actions.get(player.id) : null;
    const team = player && getFaction(player.role) === 'syndicate'
      ? this.living().filter((p) => getFaction(p.role) === 'syndicate').map((p) => ({ id: p.id, name: p.name })) : [];
    const voteCounts = {};
    for (const targetId of this.votes.values()) {
      if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
    return {
      roomCode: this.roomCode, phase: this.phase, day: this.day, secondsLeft: this.deadline ? Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)) : 0,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, alive: p.alive, connected: p.connected, host: p.host, isReady: p.isReady, isSilenced: Boolean(p.isSilenced), isMechanized: player?.role === ROLES.SOUL_COLLECTOR ? Boolean(p.isMechanized) : undefined, role: p.id === forPlayerId ? p.role : (p.alive ? null : p.role), bullets: p.id === forPlayerId ? p.bullets : undefined, voted: this.votes.has(p.id) })),
      deadPlayers: this.deadPlayers, log: this.log, me: player ? {
        id: player.id, role: player.role, alive: player.alive, bullets: player.bullets,
        actionSubmitted: Boolean(privateActions), voted: this.votes.has(player.id),
        isSilenced: Boolean(player.isSilenced),
        silencedToday: Boolean(player.isSilenced),
        syndicateVoted: this.syndicateVotes.has(player.id),
        revivalUsed: player.role === ROLES.MAINTENANCE_MECHANIC ? this.revivalsUsed : undefined,
        timeRewindUsed: player.role === ROLES.TIMEKEEPER ? this.timeRewindUsed : undefined,
        oiledTargets: player.role === ROLES.MAD_SCIENTIST ? this.living().filter((target) => target.isOiled).length : undefined,
        detonationTriggered: player.role === ROLES.MAD_SCIENTIST ? this.detonationTriggered : undefined
        ,bronzeCharges: player.role === ROLES.BRONZE_SMITH ? player.bronzeCharges : undefined
        ,isAlerted: player.role === ROLES.BRONZE_SMITH ? player.isAlerted : undefined
        ,armorUsed: player.role === ROLES.ARMOR_FABRICATOR ? this.armorUsed : undefined
        ,reverseCandidates: player.role === ROLES.REVERSE_ENGINEER ? this.reverseCandidates() : undefined
        ,bribeVoteControlled: Boolean(player.subornedBy && this.getPlayer(player.subornedBy)?.alive)
        ,bribeVoteLocked: Boolean(player.subornedBy && this.getPlayer(player.subornedBy)?.alive && this.votes.has(player.subornedBy))
        ,mechanizedCount: player.role === ROLES.SOUL_COLLECTOR ? this.living().filter((candidate) => candidate.isMechanized).length : undefined
      } : null,
      roleInfo: player?.role ? getRoleInfo(player.role) : null, syndicate: team, voteCount: [...this.votes.values()].filter(Boolean).length,
      voteCounts, winner: this.winner, winnerFaction: this.winnerFaction,
      survivors: this.gameOverResult?.survivors || [], ended: this.ended, testMode: this.testMode
    };
  }

  emit() { this.onUpdate(this); }
  emitPrivate(playerId, payload) { this.onPrivate?.(playerId, payload); }
  dispose() { clearTimeout(this.timer); }
}

module.exports = { Game, DURATIONS, checkGameOver };
