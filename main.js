const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio'); // Still needed to parse HTML and get text

// --- Configurações ---
const DB_FILE = path.join(__dirname, 'tracking.db');
const NTFY_TOPIC_URL = "https://ntfy.sh/alertaencomendamurilo"; // Substitua se necessário
const CHECK_INTERVAL_MS = 300 * 1000; // 5 minutos
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
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
 * (Removida a coluna 'selector')
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

// closeDb, dbRun, dbAll (sem alterações)
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
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                logger.error(`Erro ao executar SQL: ${sql}`, err);
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
}
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


// --- Funções Auxiliares ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// getPageContent (sem alterações significativas, ainda retorna string HTML)
async function getPageContent(url) {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: 30000,
            proxy: false,
            responseType: 'arraybuffer',
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            },
        });
        logger.info(`Página buscada com sucesso: ${url} (Status: ${response.status})`);
        const htmlString = Buffer.from(response.data).toString('utf-8');
        return htmlString;
    } catch (error) {
        let errMsg = `Erro ao buscar a página ${url}:`;
        if (error.response) { errMsg += ` Status ${error.response.status}`; logger.error(errMsg); }
        else if (error.request) { errMsg += ` ${error.message}`; logger.error(errMsg, error.code ? `(Code: ${error.code})` : ''); }
        else { errMsg += ` ${error.message}`; logger.error(errMsg, '(Erro de configuração)'); }
        if (error.code === 'ECONNABORTED') logger.warn(`-> Timeout ao acessar ${url}`);
        if (error.message?.toLowerCase().includes('proxy')) logger.warn("-> Possível erro de Proxy.");
        return null;
    }
}

// sendNtfyNotification (sem alterações)
async function sendNtfyNotification(topicUrl, message, title = "Notificação Rastreamento") {
    if (!topicUrl || (!topicUrl.startsWith('http://') && !topicUrl.startsWith('https://'))) {
        logger.warn(`URL do tópico NTFY parece inválida: '${topicUrl}'. Notificação não enviada.`);
        return false;
    }
    const cleanTitle = title.replace(/[^\x20-\x7E]/g, '');
    try {
        const response = await axios.post( topicUrl, message, {
                headers: { 'Title': cleanTitle, 'Tags': 'package,rastreamento,update', 'Content-Type': 'text/plain; charset=utf-8' },
                timeout: 15000
        });
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

// normalizeContent (sem alterações)
function normalizeContent(text) {
    if (!text) return '';
    return text.replace(/[\s\n\r\t]+/g, ' ').trim();
}

// getContentHashFromString (sem alterações)
function getContentHashFromString(text) {
    if (typeof text !== 'string') {
        logger.warn("Tentativa de hashear conteúdo não-string.");
        return null;
    }
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}


// --- Loop de Monitoramento (Usa Cheerio para extrair texto do BODY) ---
async function monitorLoop() {
    let firstCycle = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        let targetsToMonitor = [];
        try {
            // Busca os alvos (sem o seletor)
            targetsToMonitor = await dbAll('SELECT id, name, url, previous_hash, last_changed, status FROM tracking_items ORDER BY name ASC');
        } catch (error) {
            logger.error("Erro ao buscar alvos do banco de dados para monitoramento:", error);
            await delay(CHECK_INTERVAL_MS);
            continue;
        }

        const targetCount = targetsToMonitor.length;

        if (firstCycle && targetCount > 0) {
            logger.info(`Iniciando monitoramento para ${targetCount} alvos.`);
            logger.info(`Intervalo: ${CHECK_INTERVAL_MS / 1000}s. Notificações: ${NTFY_TOPIC_URL}`);
            logger.info("Modo de verificação: Hash do texto normalizado do <body>.");
            const testMessage = `Monitor iniciado/reiniciado. Vigiando ${targetCount} encomendas (verificando texto do body).`;
            await sendNtfyNotification(NTFY_TOPIC_URL, testMessage, "Monitor Iniciado");
            firstCycle = false;
        } else if (targetCount === 0) {
            logger.info("Nenhum alvo no banco de dados para monitorar. Aguardando...");
            firstCycle = true;
        }

        if (targetCount > 0) {
            logger.info(`--- Iniciando ciclo de verificação (${targetCount} alvos) ---`);

            for (const target of targetsToMonitor) {
                // Removido 'selector' daqui
                const { id, name, url, previous_hash } = target;
                logger.info(`Verificando [${name}] (ID: ${id}): ${url} (modo: texto do body)...`);
                await dbRun('UPDATE tracking_items SET status = ? WHERE id = ?', ['checking', id]);

                const htmlContent = await getPageContent(url);
                let newStatus = 'failed';
                let newHash = previous_hash;
                let newLastChanged = target.last_changed;

                if (htmlContent) {
                    try {
                        const $ = cheerio.load(htmlContent);
                        // Extrai SEMPRE o texto do body
                        const bodyText = $('body').text();

                        if (bodyText) {
                            const normalizedText = normalizeContent(bodyText);
                            const currentHash = getContentHashFromString(normalizedText);

                            if (currentHash) {
                                if (previous_hash === null) {
                                    newStatus = 'unchanged';
                                    newHash = currentHash;
                                    logger.info(`[${name}] Estado inicial capturado (hash do texto do body). Hash: ${currentHash.substring(0, 10)}...`);
                                } else if (currentHash !== previous_hash) {
                                    newStatus = 'changed';
                                    newHash = currentHash;
                                    newLastChanged = new Date().toISOString();
                                    logger.warn(`!!! Mudança detectada em [${name}] (baseado no texto do body) !!!`);
                                    logger.info(` -> Hash anterior: ${previous_hash.substring(0, 10)}...`);
                                    logger.info(` -> Hash atual:    ${currentHash.substring(0, 10)}...`);

                                    const notificationTitle = `Atualização - ${name}`;
                                    const notificationMessage = `Mudança detectada para '${name}'.\nVerifique: ${url}`;
                                    await sendNtfyNotification(NTFY_TOPIC_URL, notificationMessage, notificationTitle);
                                } else {
                                    newStatus = 'unchanged';
                                    logger.info(`[${name}] Nenhuma mudança detectada (baseado no texto do body).`);
                                }
                            } else {
                                logger.error(`[${name}] Não foi possível calcular o hash do texto normalizado do body.`);
                                // Status 'failed'
                            }
                        } else {
                             logger.error(`[${name}] Não foi possível extrair texto do <body> da página.`);
                             // Status 'failed'
                        }

                    } catch (parseError) {
                        logger.error(`[${name}] Erro ao processar o HTML da página ${url} com Cheerio:`, parseError);
                        // Status 'failed'
                    }
                } else {
                    logger.error(`[${name}] Falha ao obter conteúdo HTML da página.`);
                    // Status 'failed'
                }

                // Atualiza o banco de dados
                try {
                    await dbRun(
                        'UPDATE tracking_items SET previous_hash = ?, last_changed = ?, status = ? WHERE id = ?',
                        [newHash, newLastChanged, newStatus, id]
                    );
                } catch (updateError) {
                     logger.error(`Erro ao atualizar status para [${name}] (ID: ${id}) no BD:`, updateError);
                }

                logger.debug(`Aguardando 2s antes do próximo alvo...`);
                await delay(2000); // Pausa
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

// Rota principal para exibir a página (removido 'selector' da query e da view)
app.get('/', async (req, res) => {
    try {
        const targets = await dbAll('SELECT id, name, url, status, last_changed FROM tracking_items ORDER BY name ASC');
        res.render('index', {
            targets: targets,
            message: req.query.message,
            messageType: req.query.type === 'error' ? 'error' : 'success',
            formatDate: (isoString) => {
                if (!isoString) return '-';
                try {
                    // Use um fuso horário relevante ou deixe o padrão do servidor
                    return new Date(isoString).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                } catch (e) { return 'Data inválida'; }
            }
        });
    } catch (error) {
        logger.error("Erro ao buscar dados para a página inicial:", error);
        res.status(500).render('index', {
             targets: [],
             message: 'Erro ao carregar dados do banco de dados.',
             messageType: 'error',
             formatDate: () => '-'
        });
    }
});

// Rota para adicionar novo rastreamento (removido 'selector')
app.post('/add', async (req, res) => {
    // Removido 'selector' daqui
    const { name, url } = req.body;
    let message = '';
    let messageType = 'error';

    if (!name || !url) {
        message = 'Nome e URL são obrigatórios.';
    } else {
        try {
            new URL(url); // Validação básica da URL
            await dbRun(
                // Removido 'selector' do INSERT
                'INSERT INTO tracking_items (name, url, status) VALUES (?, ?, ?)',
                [name.trim(), url.trim(), 'pending']
            );
            message = `Rastreamento "${name.trim()}" adicionado com sucesso!`;
            messageType = 'success';
            logger.info(`Novo rastreamento adicionado: Nome="${name.trim()}" URL="${url.trim()}"`);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT' && error.message.includes('UNIQUE constraint failed: tracking_items.name')) {
                message = `Já existe um rastreamento com o nome "${name.trim()}".`;
                logger.warn(`Tentativa de adicionar nome duplicado: ${name.trim()}`);
            } else if (error instanceof TypeError && error.message.includes('Invalid URL')) {
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


// Rota para remover um rastreamento (sem alterações necessárias aqui)
app.post('/delete', async (req, res) => {
    const { id } = req.body;
    let message = '';
    let messageType = 'error';

    if (!id) {
        message = 'ID inválido para exclusão.';
    } else {
        try {
            const target = await dbAll('SELECT name FROM tracking_items WHERE id = ?', [id]);
            const targetName = target.length > 0 ? target[0].name : `ID ${id}`;
            const result = await dbRun('DELETE FROM tracking_items WHERE id = ?', [id]);
            if (result.changes > 0) {
                message = `Rastreamento "${targetName}" removido com sucesso!`;
                messageType = 'success';
                logger.info(`Rastreamento removido: "${targetName}" (ID=${id})`);
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
        // Verifica dependência antes de iniciar
        try {
            require.resolve('cheerio');
        } catch (e) {
            console.error("Erro: Dependência 'cheerio' não encontrada.");
            console.error("Por favor, instale executando: npm install cheerio");
            process.exit(1);
        }

        await initDb(); // Inicializa o BD

        app.listen(PORT, '0.0.0.0', () => {
            logger.info(`Servidor Express iniciado na porta ${PORT}.`);
            logger.info(`Interface web disponível em http://localhost:${PORT}/`);
            logger.info("Iniciando loop de monitoramento (modo: texto do body)...");

            monitorLoop().catch(error => {
                logger.error("Erro crítico não tratado no loop de monitoramento:", error);
                closeDb().finally(() => process.exit(1));
            });
        });

    } catch (error) {
        logger.error("Falha ao inicializar a aplicação.", error);
        process.exit(1);
    }
}

// --- Tratamento de Encerramento (sem alterações) ---
async function shutdownGracefully() {
    logger.info('Recebido sinal de encerramento. Fechando conexões...');
    try {
        await closeDb();
        logger.info("Recursos liberados. Encerrando.");
        process.exit(0);
    } catch (error) {
        logger.error("Erro durante o encerramento gracioso:", error);
        process.exit(1);
    }
}

// --- Ponto de Entrada ---
startServer(); // Chama a função assíncrona para iniciar

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);