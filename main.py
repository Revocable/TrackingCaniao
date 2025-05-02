import requests
import time
import logging
import hashlib
from flask import Flask
import threading

# --- Flask App ---
app = Flask(__name__)

@app.route('/')
def keep_alive():
    # Rota simples para manter o script ativo em plataformas como Replit/Heroku
    return "Monitor de Rastreamento Ativo."

# --- Configurações ---
# Dicionário para armazenar os alvos de rastreamento e seus estados
TRACKING_TARGETS = {
    "Cainiao": {
        "url": "https://global.cainiao.com/newDetail.htm?mailNoList=CNBR00068636289&otherMailNoList=",
        "previous_hash": None # Hash anterior específico para este alvo
    },
    "Samsung SCL": {
        "url": "https://plusla.samsungscl.com/cello/tms/html/tms/prime/ext/TmsTrackAndTraceBrExt.html?TRACKING_NO=ZGMyMDRhZWZhMjNiY2MyNDU2ZWRjOGUzMmRhMmEzNDU=",
        "previous_hash": None # Hash anterior específico para este alvo
    }
    # Adicione mais dicionários aqui para outros rastreamentos
}

# URL do tópico ntfy.sh
NTFY_TOPIC_URL = "https://ntfy.sh/alertaencomendamurilo"

# Intervalo de verificação em segundos (5 minutos = 300 segundos)
CHECK_INTERVAL_SECONDS = 300

# Cabeçalho User-Agent
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# Configuração de logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("MonitorRastreamento") # Logger específico

# --- Funções Auxiliares ---

def get_page_content(url):
    """Busca o conteúdo da URL, ignorando proxies do sistema."""
    # Define para ignorar proxies do sistema que podem causar '403 Forbidden'
    proxies = {
      "http": None,
      "https": None,
    }
    try:
        response = requests.get(url, headers=HEADERS, timeout=30, proxies=proxies)
        response.raise_for_status()  # Levanta erro para status HTTP ruins (4xx, 5xx)
        logger.info(f"Página buscada com sucesso: {url}")
        return response.content # Retorna bytes para hashing consistente
    except requests.exceptions.RequestException as e:
        logger.error(f"Erro ao buscar a página {url}: {e}")
        # Log extra se for erro de proxy
        if isinstance(e, requests.exceptions.ProxyError):
             logger.error("-> DETECTADO ProxyError. Tentando ignorar proxies do sistema. Se persistir, verifique a rede.")
        return None
    except Exception as e:
        # Captura outros erros inesperados
        logger.error(f"Erro inesperado ao buscar a página {url}: {e}", exc_info=True)
        return None

def send_ntfy_notification(topic_url, message, title="Notificação Rastreamento"):
    """Envia uma notificação para o tópico ntfy.sh."""
    # Verifica se a URL do tópico parece válida
    if not topic_url or not topic_url.startswith(('http://', 'https://')):
         logger.warning(f"URL do tópico NTFY parece inválida: '{topic_url}'. Notificação não enviada.")
         return False

    try:
        # Garante que título e mensagem são strings antes de codificar
        message_str = str(message)
        title_str = str(title)

        response = requests.post(
            topic_url,
            data=message_str.encode('utf-8'), # Envia como bytes UTF-8
            headers={
                # Codifica o título também para evitar problemas com caracteres especiais
                'Title': title_str.encode('utf-8'),
                'Tags': 'package,rastreamento,update', # Tags para filtrar no app ntfy
                 'Content-Type': 'text/plain; charset=utf-8' # Garante UTF-8
            },
            timeout=15 # Timeout para envio da notificação
        )
        response.raise_for_status() # Verifica se o envio foi bem-sucedido (status 2xx)
        logger.info(f"Notificação enviada para {topic_url}")
        return True
    except requests.exceptions.RequestException as e:
        logger.error(f"Erro ao enviar notificação para {topic_url}: {e}")
        return False
    except Exception as e:
        logger.error(f"Erro inesperado ao enviar notificação para {topic_url}: {e}", exc_info=True)
        return False

def get_content_hash(content_bytes):
    """Calcula o hash SHA-256 do conteúdo em bytes."""
    if content_bytes is None:
        return None
    return hashlib.sha256(content_bytes).hexdigest()

# --- Loop de Monitoramento (Executado na Thread) ---

def monitor_loop():
    """Loop principal que verifica as páginas e envia notificações."""
    logger.info(f"Iniciando loop de monitoramento para {len(TRACKING_TARGETS)} alvos.")
    logger.info(f"Intervalo de verificação: {CHECK_INTERVAL_SECONDS} segundos.")
    logger.info(f"Notificações serão enviadas para: {NTFY_TOPIC_URL}")

    # Envio da Notificação de Teste/Início
    test_message = f"Monitor de rastreamento iniciado. Vigiando {len(TRACKING_TARGETS)} encomendas."
    if send_ntfy_notification(NTFY_TOPIC_URL, test_message, "✅ Monitor Iniciado"):
        logger.info("Notificação de teste/início enviada com sucesso.")
    else:
        logger.error("Falha ao enviar notificação de teste/início. Verifique a URL NTFY e a conexão.")
        # Considerar parar se o teste falhar? Por enquanto, apenas loga.

    while True:
        logger.info("--- Iniciando ciclo de verificação ---")
        # Itera sobre cada alvo definido no dicionário
        for target_name, target_data in TRACKING_TARGETS.items():
            url_to_check = target_data["url"]
            previous_hash = target_data["previous_hash"]
            logger.info(f"Verificando [{target_name}]: {url_to_check}...")

            page_content = get_page_content(url_to_check)

            if page_content:
                current_page_hash = get_content_hash(page_content)
                # logger.debug(f"[{target_name}] Hash atual: {current_page_hash}") # Descomente para debug detalhado

                if previous_hash is None:
                    # Primeira verificação bem-sucedida para este alvo
                    TRACKING_TARGETS[target_name]["previous_hash"] = current_page_hash
                    logger.info(f"[{target_name}] Estado inicial capturado. Hash: {current_page_hash[:10]}...") # Mostra só parte do hash
                elif current_page_hash != previous_hash:
                    # Mudança detectada!
                    logger.warning(f"!!! Mudança detectada em [{target_name}] !!!")
                    logger.info(f"[{target_name}] Hash anterior: {previous_hash[:10]}...")
                    logger.info(f"[{target_name}] Hash atual:    {current_page_hash[:10]}...")

                    # Envia notificação específica
                    notification_title = f"📦 Atualização - {target_name}"
                    notification_message = f"Mudança detectada para a encomenda '{target_name}'.\nVerifique o link:\n{url_to_check}"
                    send_ntfy_notification(NTFY_TOPIC_URL, notification_message, notification_title)

                    # Atualiza o hash para o novo estado
                    TRACKING_TARGETS[target_name]["previous_hash"] = current_page_hash
                else:
                    # Nenhuma mudança para este alvo
                    logger.info(f"[{target_name}] Nenhuma mudança detectada.")
            else:
                # Falha ao buscar a página para este alvo
                logger.error(f"[{target_name}] Falha ao obter conteúdo da página. Hash não atualizado.")
                # Pode-se adicionar uma notificação de erro aqui se desejar
                # send_ntfy_notification(NTFY_TOPIC_URL, f"Erro ao buscar página para {target_name}", f"⚠️ Erro Monitor - {target_name}")

            # Pequena pausa entre as requisições para não sobrecarregar os servidores
            time.sleep(2) # Espera 2 segundos antes de verificar o próximo alvo

        # Fim do ciclo de verificação de todos os alvos
        logger.info(f"--- Fim do ciclo. Aguardando {CHECK_INTERVAL_SECONDS} segundos... ---")
        time.sleep(CHECK_INTERVAL_SECONDS)

# --- Início da Execução ---
if __name__ == "__main__":
    logger.info("Iniciando aplicação Flask e thread de monitoramento.")

    # Cria e inicia a thread que executa o loop de monitoramento
    monitor_thread = threading.Thread(target=monitor_loop, daemon=True) # daemon=True faz a thread parar se o programa principal fechar
    monitor_thread.start()

    # Inicia o servidor Flask (para keep-alive e potencialmente outras rotas no futuro)
    # host='0.0.0.0' permite que o servidor seja acessível de fora do container/máquina local
    # Use uma porta diferente de 5000 se ela já estiver em uso
    app.run(host='0.0.0.0', port=8080)

    # O código após app.run() normalmente não é executado até o servidor Flask parar.
    logger.info("Servidor Flask encerrado.")