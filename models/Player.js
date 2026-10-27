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
      steam_gears: { type: Number, default: 0, min: 0 }
    },
    unlocked_cosmetics: { type: [String], default: [] },
    equipped_cosmetic: { type: String, default: null },
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

  const previousXp = { $ifNull: ['$xp', 0] };
  const nextXp = { $add: [previousXp, xpGained] };
  const rolePlayedPath = `roles_stats.${roleKey}.played`;
  const roleWonPath = `roles_stats.${roleKey}.won`;
  const increments = {
    xp: nextXp,
    level: {
      $max: [
        1,
        {
          $floor: {
            $divide: [
              { $add: [1, { $sqrt: { $add: [1, { $divide: [{ $multiply: [8, nextXp] }, XP_PER_FIRST_LEVEL] }] } }] },
              2
            ]
          }
        }
      ]
    },
    'currencies.copper_coins': {
      $add: [{ $ifNull: ['$currencies.copper_coins', 0] }, coinsGained]
    },
    'stats.games_played': { $add: [{ $ifNull: ['$stats.games_played', 0] }, 1] },
    'stats.victories': {
      $add: [{ $ifNull: ['$stats.victories', 0] }, isVictory ? 1 : 0]
    },
    'stats.defeats': {
      $add: [{ $ifNull: ['$stats.defeats', 0] }, isVictory ? 0 : 1]
    },
    [rolePlayedPath]: { $add: [{ $ifNull: [`$${rolePlayedPath}`, 0] }, 1] }
  };

  if (isVictory) {
    increments[roleWonPath] = { $add: [{ $ifNull: [`$${roleWonPath}`, 0] }, 1] };
  }

  const player = await this.findOneAndUpdate(
    { username: username.trim() },
    [{ $set: increments }],
    { new: true, runValidators: true }
  );

  if (!player) {
    throw new Error(`Não existe jogador com o username "${username.trim()}".`);
  }
  return player;
};

const Player = mongoose.models.Player || mongoose.model('Player', playerSchema);

module.exports = Player;
module.exports.levelForXp = levelForXp;
module.exports.resolveRoleKey = resolveRoleKey;
