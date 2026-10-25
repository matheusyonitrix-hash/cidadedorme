# ⚙️ A Cidade Dorme: Distrito da Fuligem (Ano 1897)

Uma adaptação multiplayer em tempo real com temática **Steampunk**, inspirada nos jogos sociais *A Cidade Dorme*, *Wolvesville* e *Town of Salem*. As partidas completas suportam **8 a 16 jogadores** e incluem automação, espionagem industrial, engenharia reversa e alquimia proibida. Salas menores podem ser usadas para testes locais.

## 🛠️ Tecnologias

- **Backend:** Node.js, Express e Socket.io para comunicação em tempo real.
- **Frontend:** HTML5, CSS3 e JavaScript Vanilla.
- **Deploy:** Blueprint para publicação no Render (`render.yaml`).
- **Persistência opcional:** Mongoose com MongoDB. Sem `MONGODB_URI`, o servidor pode arrancar sem persistir perfis.

## 🎭 Facções e classes

O Distrito da Fuligem disputa o controlo durante os ciclos de **Dia — Tribunal de Bronze** e **Noite — A Engrenagem Gira**.

### 🛡️ Aliança de Vapor

O objetivo é descobrir e eliminar as ameaças na Fornalha de Pressão.

- **Relojoeiro:** Inspeciona uma pessoa por noite para descobrir a sua fação.
- **Alquimista:** Protege uma pessoa por noite contra ataques.
- **Inventor:** Tem dois disparos; se eliminar alguém da Aliança, também morre.
- **Engenheiro de Tesla:** Vigia uma pessoa e descobre quem a visitou durante a noite.
- **Ferreiro de Bronze:** Pode ativar a fornalha com duas cargas para contra-atacar visitantes.
- **Engenheiro Reverso:** Analisa uma pessoa morta e investiga a classe de um dos seus votantes.
- **Operário:** Cidadão básico que participa na discussão e votação diurna.

### 🏴 Sindicato Rebelde

O objetivo é eliminar a Aliança de Vapor até alcançar a maioria na oficina.

- **Sabotador:** Escolhe o alvo de eliminação do Sindicato durante a noite.
- **Cortina de Fumo:** Disfarça um aliado para que pareça pertencer à Aliança nas investigações.
- **Espião Industrial:** Investiga uma pessoa e descobre a sua classe exata.
- **Banqueiro de Cobre:** Suborna uma pessoa; o voto dela espelha o do Banqueiro no dia seguinte.
- **Informador Clandestino:** Silencia uma pessoa para impedir que envie mensagens durante o dia seguinte.

### 🧪 Dissidentes

Os neutros têm objetivos individuais e caóticos.

- **Colecionador de Sucata:** Vence se for eliminado pela votação do Tribunal durante o dia.
- **Autómato Desgovernado:** Ataca todas as noites e é imune a ataques noturnos.
- **Cientista Louco:** Bomba óleo secretamente e pode detonar todos os alvos oleados.
- **Colecionador de Almas Mecânicas:** Mecaniza sobreviventes e vence quando todos os vivos estiverem mecanizados.

## 🎮 Como jogar com amigos

1. Publica o projeto no Render usando o blueprint `render.yaml` e abre o URL atribuído à aplicação.
2. Introduz o teu nome e seleciona **Criar uma Oficina**.
3. Partilha com os amigos o código de cinco caracteres apresentado na oficina.
4. Cada pessoa introduz o seu nome e o código para entrar.
5. Nas partidas completas, reúne de 8 a 16 jogadores. O anfitrião inicia a partida quando o grupo estiver pronto.

> O Render disponibiliza a aplicação, mas não cria uma base de dados MongoDB. Para persistir perfis, configura `MONGODB_URI` com uma instância MongoDB acessível pelo serviço.

## 🧪 Testes locais e modo QA

Requer Node.js 18 ou superior.

1. Instala as dependências e inicia o servidor:

   ```bash
   npm install
   npm start
   ```

2. Abre `http://localhost:3000/` e cria uma oficina com o nome `Yokki_QA` para ativar a distribuição de cargos de depuração.
3. Noutro terminal, liga bots à oficina (substitui o código pelo código mostrado no lobby):

   ```bash
   node botSimulator.js CODIGO_DA_SALA 7
   ```

4. Acompanha as ações e os registos QA no terminal enquanto observas a partida no navegador.

## 📁 Estrutura principal

- `server.js`: servidor HTTP, Express e Socket.io, com porta dinâmica para o Render.
- `gameEngine.js`: estado das salas, fases, ações noturnas, votação e condições de vitória.
- `roles.js`: catálogo de classes e distribuição dos cargos.
- `socketHandler.js`: salas, comunicação em tempo real e validação das ações.
- `public/`: interface do jogo.
- `models/` e `database.js`: preparação para persistência com Mongoose.
