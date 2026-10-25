const ROLES = Object.freeze({
  CLOCKMAKER: 'CLOCKMAKER', ALCHEMIST: 'ALCHEMIST', INVENTOR: 'INVENTOR', WORKER: 'WORKER',
  TESLA_ENGINEER: 'TESLA_ENGINEER', BRONZE_SMITH: 'BRONZE_SMITH', MAINTENANCE_MECHANIC: 'MAINTENANCE_MECHANIC',
  TIMEKEEPER: 'TIMEKEEPER', PRESSURE_TRAPPER: 'PRESSURE_TRAPPER',
  REVERSE_ENGINEER: 'REVERSE_ENGINEER', ARMOR_FABRICATOR: 'ARMOR_FABRICATOR',
  SABOTEUR: 'SABOTEUR', SMOKE: 'SMOKE', INDUSTRIAL_SPY: 'INDUSTRIAL_SPY', PATENT_FORGER: 'PATENT_FORGER',
  ETHER_SMUGGLER: 'ETHER_SMUGGLER', CLANDESTINE_INFORMANT: 'CLANDESTINE_INFORMANT',
  COPPER_BANKER: 'COPPER_BANKER',
  SCRAP_COLLECTOR: 'SCRAP_COLLECTOR', AUTOMATON: 'AUTOMATON', MAD_SCIENTIST: 'MAD_SCIENTIST', SCRAP_GRAVEDIGGER: 'SCRAP_GRAVEDIGGER',
  SOUL_COLLECTOR: 'SOUL_COLLECTOR'
});

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;

const ROLE_INFO = Object.freeze({
  [ROLES.CLOCKMAKER]: { name: 'Relojoeiro', faction: 'steam', description: 'Inspeciona uma pessoa por noite e descobre a sua fação.' },
  [ROLES.ALCHEMIST]: { name: 'Alquimista', faction: 'steam', description: 'Protege uma pessoa por noite de um ataque.' },
  [ROLES.INVENTOR]: { name: 'Inventor', faction: 'steam', description: 'Dispõe de dois tiros. Se atingir um inocente, morre também.' },
  [ROLES.TESLA_ENGINEER]: { name: 'Engenheiro de Tesla', faction: 'steam', description: 'Vigia uma pessoa durante a noite e descobre quem a visitou.' },
  [ROLES.BRONZE_SMITH]: { name: 'Ferreiro de Bronze', faction: 'steam', description: 'Ativa a sua forja durante a noite. Quem o visitar enquanto estiver ativo é eliminado.' },
  [ROLES.MAINTENANCE_MECHANIC]: { name: 'Mecânico de Manutenção', faction: 'steam', description: 'Ressuscita uma pessoa eliminada uma vez por partida.' },
  [ROLES.TIMEKEEPER]: { name: 'Cronometrista', faction: 'steam', description: 'Ativa o retrocesso do tempo para cancelar uma morte noturna, uma vez por partida.' },
  [ROLES.PRESSURE_TRAPPER]: { name: 'Armadilheiro de Pressão', faction: 'steam', description: 'Arma uma pessoa. Se alguém a visitar esta noite, o visitante fica atordoado e perde a ação na noite seguinte.' },
  [ROLES.REVERSE_ENGINEER]: { name: 'Engenheiro Reverso', faction: 'steam', description: 'Analisa uma pessoa morta e identifica o cargo exato de um jogador que votou nela.' },
  [ROLES.ARMOR_FABRICATOR]: { name: 'Fabricante de Blindagem', faction: 'steam', description: 'Uma vez por partida, distribui placas de titânio a até três jogadores. Cada placa absorve o próximo ataque noturno sofrido.' },
  [ROLES.WORKER]: { name: 'Operário', faction: 'steam', description: 'Inocente sem ação noturna especial.' },
  [ROLES.SABOTEUR]: { name: 'Sabotador', faction: 'syndicate', description: 'Coordena o voto noturno do Sindicato para eliminar um alvo.' },
  [ROLES.SMOKE]: { name: 'Cortina de Fumo', faction: 'syndicate', description: 'Escolhe um aliado por noite para parecer da Aliança ao Relojoeiro.' },
  [ROLES.INDUSTRIAL_SPY]: { name: 'Espião Industrial', faction: 'syndicate', description: 'Investiga uma pessoa por noite e descobre o seu cargo exato.' },
  [ROLES.PATENT_FORGER]: { name: 'Falsificador de Patentes', faction: 'syndicate', description: 'Passivamente, aparece como membro da Aliança nas investigações de fação.' },
  [ROLES.ETHER_SMUGGLER]: { name: 'Contrabandista de Éter', faction: 'syndicate', description: 'Troca as identidades de inspeção de duas pessoas; o Relojoeiro recebe a identidade trocada ao investigar qualquer uma delas.' },
  [ROLES.CLANDESTINE_INFORMANT]: { name: 'Informador Clandestino', faction: 'syndicate', description: 'Silencia uma pessoa durante a noite; essa pessoa não pode enviar mensagens no chat durante o dia seguinte.' },
  [ROLES.COPPER_BANKER]: { name: 'Banqueiro de Cobre', faction: 'syndicate', description: 'Suborna uma pessoa durante a noite. No dia seguinte, o voto dela espelha o voto do Banqueiro.' },
  [ROLES.SCRAP_COLLECTOR]: { name: 'Colecionador de Sucata', faction: 'neutral', description: 'Vence se for eliminado pela votação da Fornalha.' },
  [ROLES.AUTOMATON]: { name: 'Autómato Desgovernado', faction: 'neutral', description: 'Elimina uma pessoa por noite e é imune a ataques noturnos.' },
  [ROLES.MAD_SCIENTIST]: { name: 'Cientista Louco', faction: 'neutral', description: 'Oleia uma pessoa por noite. Pode detonar todos os alvos oleados; vence sozinho se for o único sobrevivente.' },
  [ROLES.SCRAP_GRAVEDIGGER]: { name: 'Coveiro de Sucata', faction: 'neutral', description: 'Escolhe uma pessoa e um novo alvo para redirecionar a ação noturna dela.' },
  [ROLES.SOUL_COLLECTOR]: { name: 'Colecionador de Almas Mecânicas', faction: 'neutral', description: 'Injeta engrenagens numa pessoa viva por noite. Vence assim que todos os sobreviventes estiverem mecanizados por ele.' }
});

const FACTION_NAMES = Object.freeze({ steam: 'Aliança de Vapor', syndicate: 'Sindicato Rebelde', neutral: 'Dissidente' });

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Tabela de facções para partidas completas (8–16). A especificação recebida
// não incluía a tabela numérica; esta progressão mantém o Sindicato próximo
// de 25–30% (com variação inteira em salas ímpares) e aumenta os Dissidentes
// gradualmente, sem ultrapassar o total da sala.
const ROLE_DISTRIBUTION = Object.freeze({
  8: { syndicate: 2, neutral: 2 }, 9: { syndicate: 2, neutral: 2 },
  10: { syndicate: 3, neutral: 2 }, 11: { syndicate: 3, neutral: 2 },
  12: { syndicate: 3, neutral: 3 }, 13: { syndicate: 3, neutral: 3 },
  14: { syndicate: 4, neutral: 4 }, 15: { syndicate: 4, neutral: 4 },
  16: { syndicate: 4, neutral: 4 }
});

function createRoleDeck(playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new RangeError(`A sala precisa de ter entre ${MIN_PLAYERS} e ${MAX_PLAYERS} jogadores.`);
  }

  // Cenário de teste local: garante que ambos os lados têm uma função ativa.
  if (playerCount === 2) return shuffle([ROLES.SABOTEUR, ROLES.CLOCKMAKER]);

  if (playerCount >= 8) {
    const allocation = ROLE_DISTRIBUTION[playerCount];
    const syndicateRoles = [ROLES.SABOTEUR, ROLES.SMOKE, ROLES.PATENT_FORGER, ROLES.ETHER_SMUGGLER, ROLES.CLANDESTINE_INFORMANT, ROLES.COPPER_BANKER];
    const neutralRoles = [ROLES.SCRAP_COLLECTOR, ROLES.AUTOMATON, ROLES.MAD_SCIENTIST, ROLES.SCRAP_GRAVEDIGGER, ROLES.SOUL_COLLECTOR];
    const allianceCount = playerCount - allocation.syndicate - allocation.neutral;
    const allianceRoles = [ROLES.INVENTOR, ROLES.TESLA_ENGINEER, ROLES.BRONZE_SMITH, ROLES.MAINTENANCE_MECHANIC, ROLES.TIMEKEEPER, ROLES.PRESSURE_TRAPPER, ROLES.REVERSE_ENGINEER, ROLES.ARMOR_FABRICATOR];
    const deck = [ROLES.SABOTEUR, ROLES.CLOCKMAKER, ROLES.ALCHEMIST];
    const remainingSyndicate = shuffle(syndicateRoles.filter((role) => role !== ROLES.SABOTEUR)).slice(0, allocation.syndicate - 1);
    const remainingNeutral = shuffle(neutralRoles).slice(0, allocation.neutral);
    const remainingAlliance = shuffle(allianceRoles).slice(0, allianceCount - 2);
    deck.push(...remainingSyndicate, ...remainingNeutral, ...remainingAlliance);
    while (deck.length < playerCount) deck.push(ROLES.WORKER);
    if (deck.length !== playerCount) throw new Error('A tabela de distribuição não corresponde ao número de jogadores.');
    return shuffle(deck);
  }

  // Salas menores continuam disponíveis para testes rápidos locais.
  const syndicateCount = Math.max(1, Math.round(playerCount * 0.28));
  const deck = [ROLES.SABOTEUR, ROLES.CLOCKMAKER, ROLES.ALCHEMIST];
  const neutralPool = [ROLES.SCRAP_COLLECTOR, ROLES.AUTOMATON, ROLES.MAD_SCIENTIST, ROLES.SCRAP_GRAVEDIGGER, ROLES.SOUL_COLLECTOR];
  const neutralCount = playerCount >= 5 ? 1 : 0;
  const extraSyndicate = shuffle([ROLES.SMOKE, ROLES.PATENT_FORGER, ROLES.ETHER_SMUGGLER, ROLES.CLANDESTINE_INFORMANT, ROLES.COPPER_BANKER])
    .slice(0, Math.max(0, syndicateCount - 1));
  deck.push(...extraSyndicate);
  if (neutralCount) deck.push(...shuffle(neutralPool).slice(0, neutralCount));
  const alliancePool = shuffle([ROLES.INVENTOR, ROLES.TESLA_ENGINEER, ROLES.BRONZE_SMITH, ROLES.MAINTENANCE_MECHANIC, ROLES.TIMEKEEPER, ROLES.PRESSURE_TRAPPER, ROLES.REVERSE_ENGINEER, ROLES.ARMOR_FABRICATOR]);
  const allianceSlots = playerCount - syndicateCount - neutralCount - 2;
  deck.push(...alliancePool.slice(0, Math.max(0, allianceSlots)));
  while (deck.length < playerCount) deck.push(ROLES.WORKER);

  if (deck.length !== playerCount) throw new Error('A distribuição de classes não corresponde ao número de jogadores.');
  return shuffle(deck);
}

function getRoleInfo(role) { return ROLE_INFO[role] || null; }
// No lobby ainda não há cargos atribuídos. A consulta de fação deve ser
// segura para esse estado, em vez de interromper a criação da sala.
function getFaction(role) { return ROLE_INFO[role]?.faction || null; }
function getFactionName(faction) { return FACTION_NAMES[faction] || 'Desconhecida'; }

module.exports = { ROLES, ROLE_INFO, FACTION_NAMES, ROLE_DISTRIBUTION, MIN_PLAYERS, MAX_PLAYERS, createRoleDeck, getRoleInfo, getFaction, getFactionName };
