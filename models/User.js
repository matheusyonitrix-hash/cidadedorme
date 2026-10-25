const mongoose = require('mongoose');
const { ROLES } = require('../roles');

const XP_PER_LEVEL = 1000;

const roleMatchStatsSchema = new mongoose.Schema(
  {
    played: { type: Number, default: 0, min: 0 },
    won: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

// Atribui um espaço de estatísticas próprio a todas as classes conhecidas pelo
// catálogo do jogo. Os nomes guardados são as chaves estáveis de roles.js.
const perRoleStatsFields = Object.fromEntries(
  Object.values(ROLES).map((role) => [role, { type: roleMatchStatsSchema, default: () => ({}) }])
);

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 24
    },
    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },
    copperCoins: { type: Number, default: 0, min: 0 },
    stats: {
      gamesPlayed: { type: Number, default: 0, min: 0 },
      gamesWon: { type: Number, default: 0, min: 0 },
      byRole: {
        type: new mongoose.Schema(perRoleStatsFields, { _id: false }),
        default: () => ({})
      }
    }
  },
  { timestamps: true, versionKey: false }
);

userSchema.index({ username: 1 }, { unique: true, name: 'username_unique' });

/**
 * Regista o resultado de uma partida com uma única operação de atualização.
 * O nível é recalculado a partir do XP total atualizado (1 nível por 1000 XP).
 * `role` deve ser uma chave de roles.js, por exemplo ROLES.CLOCKMAKER.
 */
userSchema.statics.addMatchResult = async function addMatchResult(userId, role, isVictory, xpGained) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new TypeError('userId deve ser um ObjectId válido.');
  }
  if (!Object.values(ROLES).includes(role)) {
    throw new TypeError(`Classe inválida: ${role}`);
  }
  if (typeof isVictory !== 'boolean') {
    throw new TypeError('isVictory deve ser booleano.');
  }
  if (!Number.isSafeInteger(xpGained) || xpGained < 0) {
    throw new TypeError('xpGained deve ser um inteiro não negativo.');
  }

  const rolePath = `stats.byRole.${role}`;
  const updatedUser = await this.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          xp: { $add: [{ $ifNull: ['$xp', 0] }, xpGained] },
          level: {
            $add: [
              1,
              {
                $floor: {
                  $divide: [{ $add: [{ $ifNull: ['$xp', 0] }, xpGained] }, XP_PER_LEVEL]
                }
              }
            ]
          },
          'stats.gamesPlayed': { $add: [{ $ifNull: ['$stats.gamesPlayed', 0] }, 1] },
          'stats.gamesWon': {
            $add: [{ $ifNull: ['$stats.gamesWon', 0] }, isVictory ? 1 : 0]
          },
          [`${rolePath}.played`]: {
            $add: [{ $ifNull: [`$${rolePath}.played`, 0] }, 1]
          },
          [`${rolePath}.won`]: {
            $add: [{ $ifNull: [`$${rolePath}.won`, 0] }, isVictory ? 1 : 0]
          }
        }
      }
    ],
    { new: true }
  );

  if (!updatedUser) {
    throw new Error('Jogador não encontrado.');
  }
  return updatedUser;
};

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;
// Também permite importar diretamente: const { addMatchResult } = require('./models/User');
module.exports.addMatchResult = User.addMatchResult.bind(User);
