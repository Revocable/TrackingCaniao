const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Importa sqlite3

// --- Configurações ---
const DB_FILE = path.join(__dirname, 'tracking.db'); // Nome do arquivo do BD
const NTFY_TOPIC_URL = "https://ntfy.sh/alertaencomendamurilo";
const CHECK_INTERVAL_MS = 300 * 1000; // 5 minutos
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

// Logger (sem alterações)
const logger = {
    info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
    warn: (message) => console.warn(`[WARN] ${new Date().toISOString()} - ${message}`),
    error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error || ''),
    debug: (message) => console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`)
};

// --- Banco de Dados SQLite ---
let db;

/**
 * Inicializa a conexão com o banco de dados e cria a tabela se não existir.
 * @returns {Promise<void>}
 */
function initDb() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                logger.error('Erro ao conectar ao banco de dados SQLite:', err);
                return reject(err);
            }
            logger.info('Conectado ao banco de dados SQLite.');

            db.run(`CREATE TABLE IF NOT EXISTS tracking_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                url TEXT NOT NULL,
                previous_hash TEXT,
                last_changed DATETIME,
                status TEXT DEFAULT 'pending' NOT NULL
            )`, (err) => {
                if (err) {
                    logger.error('Erro ao criar tabela tracking_items:', err);
                    return reject(err);
                }
                logger.info('Tabela tracking_items verificada/criada com sucesso.');
                resolve();
            });
        });
    });
}

/**
 * Fecha a conexão com o banco de dados.
 * @returns {Promise<void>}
 */
function closeDb() {
    return new Promise((resolve, reject) => {
        if (db) {
            db.close((err) => {
                if (err) {
                    logger.error('Erro ao fechar o banco de dados:', err);
                    return reject(err);
                }
                logger.info('Conexão com o banco de dados fechada.');
                resolve();
            });
        } else {
            resolve();
        }
    });
}

// --- Funções Auxiliares do Banco de Dados (Promisificadas) ---
/**
 * Executa uma query SQL que não retorna linhas (INSERT, UPDATE, DELETE).
 * @param {string} sql - A query SQL.
 * @param {Array} params - Os parâmetros para a query.
 * @returns {Promise<{lastID: number, changes: number}>}
 */
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) { // Usar function() para ter acesso a this
            if (err) {
                logger.error(`Erro ao executar SQL: ${sql}`, err);
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
}

/**
 * Executa uma query SQL e retorna todas as linhas encontradas.
 * @param {string} sql - A query SQL.
 * @param {Array} params - Os parâmetros para a query.
 * @returns {Promise<Array<Object>>}
 */
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                logger.error(`Erro ao executar SQL: ${sql}`, err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// --- Funções Auxiliares (delay, getPageContent, sendNtfyNotification, getContentHash - sem alterações) ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getPageContent(url) {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: 30000,
            proxy: false,
            responseType: 'arraybuffer'
        });
        if (response.status >= 200 && response.status < 300) {
            logger.info(`Página buscada com sucesso: ${url}`);
            return Buffer.from(response.data);
        } else {
            logger.error(`Erro ao buscar a página ${url}: Status ${response.status}`);
            return null;
        }
    } catch (error) {
        logger.error(`Erro ao buscar a página ${url}: ${error.message}`, error.code === 'ECONNABORTED' ? '(Timeout)' : '');
        if (error.message.toLowerCase().includes('proxy')) {
             logger.error("-> Possível erro de Proxy. Tentando ignorar proxies do sistema.");
        }
        return null;
    }
}

async function sendNtfyNotification(topicUrl, message, title = "Notificação Rastreamento") {
    if (!topicUrl || (!topicUrl.startsWith('http://') && !topicUrl.startsWith('https://'))) {
        logger.warn(`URL do tópico NTFY parece inválida: '${topicUrl}'. Notificação não enviada.`);
        return false;
    }
    const cleanTitle = title.replace(/[^\x20-\x7E]/g, '');
    try {
        const response = await axios.post(
            topicUrl, message,
            {
                headers: { 'Title': cleanTitle, 'Tags': 'package,rastreamento,update', 'Content-Type': 'text/plain; charset=utf-8' },
                timeout: 15000
            }
        );
        if (response.status >= 200 && response.status < 300) {
            logger.info(`Notificação enviada para ${topicUrl}`); return true;
        } else {
            logger.error(`Erro ao enviar notificação para ${topicUrl}: Status ${response.status}`); return false;
        }
    } catch (error) {
        let errMsg = `Erro ao enviar notificação para ${topicUrl}: ${error.message}`;
        if (error.response) { errMsg += ` | Status: ${error.response.status}`; }
        else if (error.request) { errMsg += ' | Nenhuma resposta recebida.'; }
        else { errMsg += ' | Erro na configuração.'; }
        logger.error(errMsg, error.code ? `(Code: ${error.code})` : '');
        return false;
    }
}

function getContentHash(contentBuffer) {
    if (!contentBuffer || !Buffer.isBuffer(contentBuffer)) { return null; }
    return crypto.createHash('sha256').update(contentBuffer).digest('hex');
}

// --- Loop de Monitoramento (Usa o BD) ---
async function monitorLoop() {
    let firstCycle = true; // Para enviar notificação inicial apenas uma vez

    // eslint-disable-next-line no-constant-condition
    while (true) {
        let targetsToMonitor = [];
        try {
            // Busca os alvos do banco de dados a cada ciclo
            targetsToMonitor = await dbAll('SELECT * FROM tracking_items ORDER BY name ASC');
        } catch (error) {
            logger.error("Erro ao buscar alvos do banco de dados para monitoramento:", error);
            await delay(CHECK_INTERVAL_MS); // Espera antes de tentar novamente
            continue; // Pula para a próxima iteração do while
        }

        const targetCount = targetsToMonitor.length;

        if (firstCycle && targetCount > 0) {
            logger.info(`Iniciando monitoramento para ${targetCount} alvos.`);
            logger.info(`Intervalo: ${CHECK_INTERVAL_MS / 1000}s. Notificações: ${NTFY_TOPIC_URL}`);
            const testMessage = `Monitor iniciado/reiniciado. Vigiando ${targetCount} encomendas.`;
            await sendNtfyNotification(NTFY_TOPIC_URL, testMessage, "Monitor Iniciado");
            firstCycle = false;
        } else if (targetCount === 0) {
            logger.info("Nenhum alvo no banco de dados para monitorar. Aguardando...");
            firstCycle = true; // Reseta para enviar notificação se um alvo for adicionado
        }

        if (targetCount > 0) {
            logger.info(`--- Iniciando ciclo de verificação (${targetCount} alvos) ---`);

            for (const target of targetsToMonitor) {
                const { id, name, url, previous_hash } = target;
                logger.info(`Verificando [${name}] (ID: ${id}): ${url}...`);
                await dbRun('UPDATE tracking_items SET status = ? WHERE id = ?', ['checking', id]);

                const pageContentBuffer = await getPageContent(url);
                let newStatus = 'failed'; // Assume falha por padrão
                let newHash = previous_hash;
                let newLastChanged = target.last_changed; // Mantém o último se não houver mudança

                if (pageContentBuffer) {
                    const currentPageHash = getContentHash(pageContentBuffer);

                    if (currentPageHash) { // Hash calculado com sucesso
                        if (previous_hash === null) { // Primeira verificação bem-sucedida
                            newStatus = 'unchanged';
                            newHash = currentPageHash;
                            logger.info(`[${name}] Estado inicial capturado. Hash: ${currentPageHash.substring(0, 10)}...`);
                        } else if (currentPageHash !== previous_hash) { // Mudança detectada!
                            newStatus = 'changed';
                            newHash = currentPageHash;
                            newLastChanged = new Date().toISOString(); // Atualiza timestamp da mudança
                            logger.warn(`!!! Mudança detectada em [${name}] !!!`);
                            logger.info(` -> Hash anterior: ${previous_hash.substring(0, 10)}...`);
                            logger.info(` -> Hash atual:    ${currentPageHash.substring(0, 10)}...`);

                            const notificationTitle = `Atualização - ${name}`;
                            const notificationMessage = `Mudança detectada para '${name}'.\nVerifique: ${url}`;
                            await sendNtfyNotification(NTFY_TOPIC_URL, notificationMessage, notificationTitle);
                        } else { // Nenhuma mudança
                            newStatus = 'unchanged';
                            logger.info(`[${name}] Nenhuma mudança detectada.`);
                        }
                    } else {
                        logger.error(`[${name}] Não foi possível calcular o hash do conteúdo.`);
                        // Status já é 'failed'
                    }
                } else {
                    logger.error(`[${name}] Falha ao obter conteúdo da página.`);
                    // Status já é 'failed'
                }

                // Atualiza o banco de dados com o novo estado
                try {
                    await dbRun(
                        'UPDATE tracking_items SET previous_hash = ?, last_changed = ?, status = ? WHERE id = ?',
                        [newHash, newLastChanged, newStatus, id]
                    );
                } catch (updateError) {
                     logger.error(`Erro ao atualizar status para [${name}] (ID: ${id}) no BD:`, updateError);
                }


                logger.debug(`Aguardando 2s antes do próximo alvo...`);
                await delay(2000); // Pequena pausa entre requisições
            } // Fim do for

            logger.info(`--- Fim do ciclo. Aguardando ${CHECK_INTERVAL_MS / 1000} segundos... ---`);
        } // Fim do if targetCount > 0

        await delay(CHECK_INTERVAL_MS);

    } // Fim do while(true)
}


// --- Express App ---
const app = express();
const PORT = process.env.PORT || 8080;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Rota principal para exibir a página
app.get('/', async (req, res) => {
    try {
        // Busca os dados mais recentes do BD para exibir
        const targets = await dbAll('SELECT * FROM tracking_items ORDER BY name ASC');
        res.render('index', {
            targets: targets,
            message: req.query.message,
            messageType: req.query.type === 'error' ? 'error' : 'success' // Garante tipo válido
        });
    } catch (error) {
        logger.error("Erro ao buscar dados para a página inicial:", error);
        res.status(500).render('index', {
             targets: [],
             message: 'Erro ao carregar dados do banco de dados.',
             messageType: 'error'
        });
    }
});

// Rota para adicionar novo rastreamento
app.post('/add', async (req, res) => {
    const { name, url } = req.body;
    let message = '';
    let messageType = 'error';

    if (!name || !url) {
        message = 'Nome e URL são obrigatórios.';
    } else {
        try {
            new URL(url); // Validação básica da URL
            // Tenta inserir no banco de dados (coluna 'name' é UNIQUE)
            await dbRun(
                'INSERT INTO tracking_items (name, url, status) VALUES (?, ?, ?)',
                [name.trim(), url.trim(), 'pending']
            );
            message = `Rastreamento "${name.trim()}" adicionado com sucesso!`;
            messageType = 'success';
            logger.info(`Novo rastreamento adicionado: Nome="${name.trim()}"`);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT') { // Verifica erro de constraint (nome duplicado)
                message = `Já existe um rastreamento com o nome "${name.trim()}".`;
                logger.warn(`Tentativa de adicionar nome duplicado: ${name.trim()}`);
            } else if (error instanceof TypeError) {
                message = 'A URL fornecida parece ser inválida.';
                logger.warn(`Tentativa de adicionar URL inválida: ${url}`);
            } else {
                message = 'Ocorreu um erro ao adicionar o rastreamento no banco de dados.';
                logger.error('Erro ao inserir no BD:', error);
            }
        }
    }
    res.redirect(`/?message=${encodeURIComponent(message)}&type=${messageType}`);
});

// Rota para remover um rastreamento
app.post('/delete', async (req, res) => {
    const { id } = req.body;
    let message = '';
    let messageType = 'error';

    if (!id) {
        message = 'ID inválido para exclusão.';
    } else {
        try {
            const result = await dbRun('DELETE FROM tracking_items WHERE id = ?', [id]);
            if (result.changes > 0) {
                message = `Rastreamento (ID: ${id}) removido com sucesso!`;
                messageType = 'success';
                logger.info(`Rastreamento removido: ID=${id}`);
            } else {
                 message = `Rastreamento com ID ${id} não encontrado para remoção.`;
                 logger.warn(`Tentativa de remover ID não existente: ${id}`);
            }
        } catch (error) {
            message = 'Ocorreu um erro ao remover o rastreamento do banco de dados.';
            logger.error(`Erro ao remover ID ${id} do BD:`, error);
        }
    }
    res.redirect(`/?message=${encodeURIComponent(message)}&type=${messageType}`);
});


// --- Início da Execução ---
async function startServer() {
    try {
        await initDb(); // Inicializa o BD ANTES de iniciar o servidor e o loop

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Servidor Express iniciado na porta ${PORT}.`);
            logger.info(`Interface web (Dark Mode) disponível em http://localhost:${PORT}/`);
            logger.info("Iniciando loop de monitoramento com persistência SQLite...");

            // Inicia o loop de monitoramento
             monitorLoop().catch(error => {
                logger.error("Erro crítico não tratado no loop de monitoramento:", error);
                // Considerar fechar o BD antes de sair
                closeDb().finally(() => process.exit(1));
            });
        });

    } catch (error) {
        logger.error("Falha ao inicializar o banco de dados. Aplicação não iniciada.", error);
        process.exit(1);
    }
}

startServer(); // Chama a função assíncrona para iniciar

// --- Tratamento de Encerramento ---
async function shutdownGracefully() {
    logger.info('Recebido sinal de encerramento. Fechando conexões...');
    try {
        await closeDb(); // Tenta fechar o BD
        logger.info("Recursos liberados. Encerrando.");
        process.exit(0);
    } catch (error) {
        logger.error("Erro durante o encerramento gracioso:", error);
        process.exit(1);
    }
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);