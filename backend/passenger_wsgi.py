import os,sys
from pathlib import Path
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root))
# Ключ хранится вне публичного каталога и вне пакета публикации.
secret=root/'anthropic.env'
if secret.exists():
    if secret.stat().st_mode & 0o077:
        raise RuntimeError('Unsafe secret permissions')
    for line in secret.read_text().splitlines():
        if line.startswith(('ANTHROPIC_API_KEY=', 'NOTA_VISION_MODEL=', 'NOTA_VISION_DAILY_LIMIT=')):
            key,value=line.split('=',1)
            os.environ[key]=value.strip().strip('"').strip("'")
# На публичном сервере личная подписка не подключена.
os.environ['NOTA_VISION_PROVIDER']='disabled'
os.environ['NOTA_PHONE_CONFIG']=str(root/'phone-config.json')
# Настройки Telegram-бота заявок лежат рядом, вне пакета публикации.
os.environ['NOTA_TELEGRAM_CONFIG']=str(root/'telegram.json')
# Публичные страницы групп: готовые файлы на nota.staytech.ru/g/<slug>/.
os.environ['NOTA_PUBLIC_DIR']='/var/www/u3644424/data/www/nota.staytech.ru'
os.environ['NOTA_PUBLIC_URL']='https://nota.staytech.ru'
from a2wsgi import ASGIMiddleware
from app.photo_server import create_app
application=ASGIMiddleware(create_app(root/'data'))
