import requests
import time
import logging
import hashlib

# --- Configurações ---
# URL da página de rastreamento do Cainiao
TRACKING_URL = "https://global.cainiao.com/newDetail.htm?mailNoList=CNBR00068636289&otherMailNoList="

# URL completa do seu tópico ntfy.sh (ex: "https://ntfy.sh/seu_topico_secreto")
# IMPORTANTE: Substitua pela sua URL real!
NTFY_TOPIC_URL = "https://ntfy.sh/alertaencomendamurilo" # <-- CORRIGIDO AQUI

# Intervalo de verificação em segundos (5 minutos = 300 segundos)
CHECK_INTERVAL_SECONDS = 300

# Cabeçalho User-Agent para simular um navegador (ajuda a evitar bloqueios)
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}
# --- Fim das Configurações ---

# Configuração básica de logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Variável para guardar o hash do conteúdo da página anterior
previous_page_hash = None

def get_page_content(url):
    """Busca o conteúdo HTML da URL fornecida."""
    try:
        response = requests.get(url, headers=HEADERS, timeout=30) # Timeout de 30s
        response.raise_for_status()  # Levanta um erro para códigos HTTP ruins (4xx ou 5xx)
        # Usamos response.content para obter os bytes brutos, mais consistente para hashing
        logging.info(f"Página buscada com sucesso: {url}")
        return response.content
    except requests.exceptions.RequestException as e:
        logging.error(f"Erro ao buscar a página {url}: {e}")
        return None
    except Exception as e:
        logging.error(f"Erro inesperado ao buscar a página: {e}")
        return None

def send_ntfy_notification(topic_url, message, title="Monitor Cainiao"):
    """Envia uma notificação para o tópico ntfy.sh."""
    # Verificação melhorada
    if not topic_url or not topic_url.startswith(('http://', 'https://')):
         logging.warning(f"URL do tópico NTFY parece inválida ou não configurada: '{topic_url}'. Notificação não enviada.")
         print("\n*** ATENÇÃO: Configure NTFY_TOPIC_URL com a URL completa (ex: https://ntfy.sh/seu_topico)! ***\n")
         return False

    try:
        # Garante que o título e a mensagem sejam strings antes de codificar
        message_str = str(message)
        title_str = str(title)

        response = requests.post(
            topic_url,
            data=message_str.encode('utf-8'), # Envia como bytes UTF-8
            headers={
                'Title': title_str.encode('utf-8'),
                'Tags': 'package,cainiao,update',
                 'Content-Type': 'text/plain; charset=utf-8' # Garante UTF-8
            },
            timeout=15 # Timeout de 15s para envio
            )
        response.raise_for_status()
        logging.info(f"Notificação enviada para {topic_url}")
        return True
    except requests.exceptions.RequestException as e:
        # O erro original de URL inválida cairia aqui
        logging.error(f"Erro ao enviar notificação para {topic_url}: {e}")
        return False
    except Exception as e:
        logging.error(f"Erro inesperado ao enviar notificação: {e}")
        return False

def get_content_hash(content_bytes):
    """Calcula o hash SHA-256 do conteúdo em bytes."""
    if content_bytes is None:
        return None
    return hashlib.sha256(content_bytes).hexdigest()

def main():
    """Função principal que executa o loop de verificação."""
    global previous_page_hash
    logging.info("Iniciando monitoramento de página Cainiao...")
    logging.info(f"URL: {TRACKING_URL}")
    logging.info(f"Intervalo: {CHECK_INTERVAL_SECONDS} segundos")

    # --- Envio da Notificação de Teste ---
    logging.info("Enviando notificação de teste para verificar configuração ntfy...")
    test_message = f"Teste de notificação do monitor Cainiao para a URL: {TRACKING_URL}"
    if send_ntfy_notification(NTFY_TOPIC_URL, test_message, "Teste Monitor Cainiao"):
        logging.info("Notificação de teste enviada com sucesso (verifique seu dispositivo).")
    else:
        # O erro já será logado dentro de send_ntfy_notification
        logging.error("Falha ao enviar notificação de teste. Verifique a URL NTFY_TOPIC_URL e a conexão.")
        # Você pode decidir se quer continuar ou parar aqui se o teste falhar
        # time.sleep(10) # Dá um tempo para ler o erro
        # return # Descomente para parar se o teste falhar

    # --- Loop Principal de Monitoramento ---
    while True:
        logging.info(f"Verificando a página: {TRACKING_URL}...")
        page_content = get_page_content(TRACKING_URL)

        if page_content:
            current_page_hash = get_content_hash(page_content)
            logging.debug(f"Hash atual da página: {current_page_hash}") # Log de debug

            if previous_page_hash is None:
                # Primeira execução bem-sucedida após o teste
                logging.info(f"Estado inicial da página capturado. Hash: {current_page_hash}")
                previous_page_hash = current_page_hash
                # Nenhuma notificação aqui, apenas registrando o estado inicial

            elif current_page_hash != previous_page_hash:
                logging.info(f"!!! Mudança detectada na página !!!")
                logging.info(f"Hash anterior: {previous_page_hash}")
                logging.info(f"Hash atual:    {current_page_hash}")

                send_ntfy_notification(
                    NTFY_TOPIC_URL,
                    f"A página de rastreamento Cainiao mudou!\nVerifique o link:\n{TRACKING_URL}",
                    "Mudança Detectada - Cainiao"
                )
                previous_page_hash = current_page_hash # Atualiza o hash para o novo estado
            else:
                logging.info("Nenhuma mudança detectada no conteúdo da página.")
        else:
            # Falha ao buscar a página
            logging.error("Falha ao buscar a página nesta verificação. Tentando novamente no próximo ciclo.")
            # Opcional: enviar notificação sobre o erro de busca
            # send_ntfy_notification(NTFY_TOPIC_URL, f"Erro ao buscar página Cainiao: {TRACKING_URL}", "Erro Monitoramento Cainiao")

        logging.info(f"Aguardando {CHECK_INTERVAL_SECONDS} segundos para a próxima verificação...")
        time.sleep(CHECK_INTERVAL_SECONDS)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logging.info("Monitoramento interrompido pelo usuário.")
    except Exception as e:
        logging.critical(f"Erro crítico no loop principal: {e}", exc_info=True)
        # Tenta enviar uma notificação sobre o erro crítico
        send_ntfy_notification(NTFY_TOPIC_URL, f"Erro crítico no script de monitoramento Cainiao: {e}", "ERRO CRÍTICO - Script Cainiao")