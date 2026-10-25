const mongoose = require('mongoose');

const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/cidade_dorme_steampunk';
let initialConnectionAttempt = true;

// Pode definir MONGODB_URI no ambiente para usar outra instância sem alterar
// o código; por omissão, a base local pedida pelo projeto é utilizada.
const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;

mongoose.connection.on('connected', () => {
  console.log('⚙️ [DATABASE] Conexão ao MongoDB estabelecida com sucesso na caldeira local!');
});

mongoose.connection.on('error', (error) => {
  // O erro da tentativa inicial é tratado em connectDB para impedir mensagens
  // duplicadas. Este listener continua a monitorizar erros após a conexão.
  if (!initialConnectionAttempt) {
    console.error(`❌ [DATABASE] Falha crítica ao conectar ao MongoDB: ${error.message}`);
  }
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ [DATABASE] A conexão com o MongoDB foi interrompida.');
});

/** Liga ao MongoDB antes de a aplicação começar a aceitar clientes. */
async function connectDB() {
  initialConnectionAttempt = true;
  try {
    await mongoose.connect(mongoUri);
    initialConnectionAttempt = false;
    return mongoose.connection;
  } catch (error) {
    initialConnectionAttempt = false;
    console.error(`❌ [DATABASE] Falha crítica ao conectar ao MongoDB: ${error.message}`);
    throw error;
  }
}

/** Fecha a conexão para o servidor poder terminar sem deixar recursos abertos. */
async function closeDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
}

module.exports = { connectDB, closeDB };
