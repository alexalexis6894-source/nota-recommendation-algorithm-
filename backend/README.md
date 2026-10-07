# Бэкенд

Код с хостинга (`/var/www/u3644424/data/.nota-recognition`): `gateway.py`, `passenger_wsgi.py`, `app/*.py`,
`requirements.txt`, каталог в `data/`.

Не включены и не должны попадать сюда: `phone-config.json` (ключ обработчика на Mac), `telegram.json` (токен бота),
`data/photos.sqlite` (фото и очередь), `data/events.sqlite` (аналитика), логи и бэкапы.
Для локального запуска создай свои по образцу `*.example`.

```sh
cd backend
python3 -m venv venv && . venv/bin/activate
pip install -r requirements.txt
```
