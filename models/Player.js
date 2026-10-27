const mongoose = require('mongoose');
const { ROLES, ROLE_INFO } = require('../roles');

const { Schema } = mongoose;
const XP_PER_FIRST_LEVEL = 1000;

/**
 * O XP é acumulado ao longo da conta. Para passar do nível N ao N+1 são
 * necessários N * 1000 XP; por exemplo: 1000 XP para o nível 2, mais 2000
 * para o nível 3. O cálculo inverso permite atualizar o nível atomicamente.
 */
function levelForXp(xp) {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * xp) / XP_PER_FIRST_LEVEL)) / 2));
}

/** Resolve tanto as chaves estáveis (CLOCKMAKER) como os nomes do manual. */
function resolveRoleKey(role) {
  if (typeof role !== 'string' || !role.trim()) return null;
  const normalized = role.trim().toLocaleLowerCase('pt');
  return Object.values(ROLES).find((key) =>
    key.toLocaleLowerCase('pt') === normalized ||
    ROLE_INFO[key]?.name.toLocaleLowerCase('pt') === normalized
  ) || null;
}

const roleStatsEntrySchema = new Schema(
  {
    played: { type: Number, default: 0, min: 0 },
    won: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

// O mapa mantém o catálogo expansível sem alterar o esquema ao adicionar
// cargos. Cada entrada é validada como played/won e criada sob demanda.
const playerSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 20
    },
    // Apenas o hash scrypt é persistido. O campo fica fora das consultas
    // normais e só é selecionado explicitamente durante o login.
    passwordHash: { type: String, required: true, select: false },
    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },
    currencies: {
      copper_coins: { type: Number, default: 0, min: 0 },
      steam_gears: { type: Number, default: 0, min: 0 },
      gold_gears: { type: Number, default: 0, min: 0 }
    },
    unlocked_cosmetics: { type: [String], default: [] },
    // Mantém apenas os identificadores recentes de Checkout já creditados;
    // o webhook pode ser entregue mais de uma vez pelo Stripe.
    processed_checkout_sessions: { type: [String], default: [] },
    equipped_cosmetic: { type: String, default: null },
    equipped_border: { type: String, default: null },
    match_history: {
      type: [{
        role: { type: String, required: true },
        isVictory: { type: Boolean, required: true },
        xpGained: { type: Number, required: true, min: 0 },
        date: { type: Date, default: Date.now }
      }],
      default: []
    },
    stats: {
      games_played: { type: Number, default: 0, min: 0 },
      victories: { type: Number, default: 0, min: 0 },
      defeats: { type: Number, default: 0, min: 0 }
    },
    roles_stats: {
      type: Map,
      of: roleStatsEntrySchema,
      default: () => new Map()
    }
  },
  {
    timestamps: true,
    versionKey: false,
    // A conta é consultada frequentemente pelo username ao entrar no jogo.
    autoIndex: true
  }
);

// Índices compostos para servir os dois rankings sem ordenar toda a coleção
// a cada abertura da Mesa de Engenharia.
playerSchema.index({ level: -1, xp: -1, username: 1 });
playerSchema.index({ 'currencies.copper_coins': -1, username: 1 });

/** Mantém o nível coerente quando um documento é criado/editado via save(). */
playerSchema.pre('save', function updateLevelFromXp(next) {
  this.level = levelForXp(this.xp || 0);
  next();
});

/**
 * Atualiza perfil e estatísticas numa única operação atómica.
 *
 * O pipeline de atualização é usado em vez de um `$inc` seguido de `save`:
 * duas chamadas permitiriam que resultados simultâneos sobrescrevessem o
 * nível ou as estatísticas. Cada expressão lê o valor corrente no MongoDB,
 * soma o resultado e grava todos os campos como uma única operação.
 *
 * @param {string} username Nome do jogador (trim é aplicado pelo esquema).
 * @param {string} role Chave de roles.js ou nome visível no manual.
 * @param {boolean} isVictory Se o jogador venceu a partida.
 * @param {number} xpGained XP ganho nesta partida, inteiro não negativo.
 * @param {number} coinsGained Moedas de cobre ganhas, inteiro não negativo.
 * @returns {Promise<import('mongoose').HydratedDocument>} Perfil atualizado.
 */
playerSchema.statics.saveMatchResult = async function saveMatchResult(
  username,
  role,
  isVictory,
  xpGained,
  coinsGained
) {
  if (typeof username !== 'string' || !username.trim()) {
    throw new TypeError('username é obrigatório.');
  }
  if (typeof isVictory !== 'boolean') {
    throw new TypeError('isVictory deve ser booleano.');
  }
  for (const [field, value] of [['xpGained', xpGained], ['coinsGained', coinsGained]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} deve ser um inteiro não negativo.`);
    }
  }

  const roleKey = resolveRoleKey(role);
  if (!roleKey) {
    throw new TypeError(`Classe inválida: ${role}`);
  }

  const rolePlayedPath = `roles_stats.${roleKey}.played`;
  const roleWonPath = `roles_stats.${roleKey}.won`;
  const increments = {
    xp: xpGained,
    'currencies.copper_coins': coinsGained,
    'stats.games_played': 1,
    'stats.victories': isVictory ? 1 : 0,
    'stats.defeats': isVictory ? 0 : 1,
    [rolePlayedPath]: 1
  };
  if (isVictory) increments[roleWonPath] = 1;

  // XP, estatísticas e histórico entram juntos numa única atualização. O
  // push mantém apenas os dez resultados mais recentes; o cliente mostra-os
  // em ordem decrescente de data.
  const player = await this.findOneAndUpdate(
    { username: username.trim() },
    {
      $inc: increments,
      $push: {
        match_history: {
          $each: [{ role: ROLE_INFO[roleKey].name, isVictory, xpGained, date: new Date() }],
          $slice: -10
        }
      }
    },
    { new: true, runValidators: true }
  );

  if (!player) {
    throw new Error(`Não existe jogador com o username "${username.trim()}".`);
  }

  // Recalcular o nível e creditar os prémios na mesma atualização atómica
  // evita pagar duas vezes quando resultados concorrentes cruzam um limiar.
  const calculatedLevel = {
    $max: [1, {
      $floor: {
        $divide: [{
          $add: [1, {
            $sqrt: {
              $add: [1, {
                $divide: [{ $multiply: [8, { $ifNull: ['$xp', 0] }] }, XP_PER_FIRST_LEVEL]
              }]
            }
          }]
        }, 2]
      }
    }]
  };
  const previousLevel = { $ifNull: ['$level', 1] };
  const levelsGained = { $max: [0, { $subtract: [calculatedLevel, previousLevel] }] };
  const rewardedProfile = await this.findOneAndUpdate(
    { _id: player._id },
    [{
      $set: {
        level: calculatedLevel,
        'currencies.copper_coins': {
          $add: [
            { $ifNull: ['$currencies.copper_coins', 0] },
            { $multiply: [levelsGained, 100] }
          ]
        },
        'currencies.gold_gears': {
          $add: [{ $ifNull: ['$currencies.gold_gears', 0] }, levelsGained]
        }
      }
    }],
    { new: true }
  );
  return rewardedProfile || this.findById(player._id);
};

const Player = mongoose.models.Player || mongoose.model('Player', playerSchema);

module.exports = Player;
module.exports.levelForXp = levelForXp;
module.exports.resolveRoleKey = resolveRoleKey;
