"""Публичная страница группы по ссылке: готовый HTML и картинка превью, без Python на просмотр.

Как устроено. Владелец группы явно включает «Сделать публичной». В этот момент сервер
делает снимок группы (название, ароматы, главные ноты, 6 ароматов «НОТА подобрала»)
и записывает в папку сайта nota.staytech.ru два файла:

  <NOTA_PUBLIC_DIR>/g/<slug>/index.html   страница, её отдаёт веб-сервер как обычный файл
  <NOTA_PUBLIC_DIR>/g/<slug>/og-<N>.jpg    превью 1200x630 для Telegram, WhatsApp и VK

Гость из сторис открывает готовый файл: ни одного процесса Python, процессор хостинга
не тратится. База остаётся источником правды, файлы производные: при правке группы
страница перерисовывается, при снятии с публикации, удалении группы или сессии удаляется.

slug: 10 случайных символов [A-Za-z0-9]. Не совпадает с внутренним id группы, его нельзя
перебрать, после снятия с публикации старая ссылка просто перестаёт работать.

Цен на странице нет: карточка группы в сторис вместе со страницей с ценами может считаться
рекламой, а реклама в Instagram в России запрещена с 01.09.2025.
"""
import html
import json
import os
import re
import secrets
import shutil
import string
import time
from pathlib import Path

SLUG_RE = re.compile(r'^[A-Za-z0-9]{10}$')
ALPHABET = string.ascii_letters + string.digits
# Страницы лежат на nota.staytech.ru рядом с приложением: оно в корне, API в /api.
APP_URL = '/'
ASSETS = '/'
API_BASE = '/api'
# Подпись «by Staytech» в шапке, как у приложения: файлы из /staytech/ того же сайта.
SIGNATURE_HEAD = ('<link rel="stylesheet" href="/staytech/by-signature.css?v=20261003c">'
                  '<link rel="stylesheet" href="/staytech/st-fit.css?v=20261003c">'
                  '<style>.app .top .st-pair{margin-right:auto}.app .top .st-co{--h:20px;gap:4px;min-width:44px;'
                  'padding:0 9px 0 2px;border-radius:8px}.app .top .st-co-arrow{position:absolute;right:0;top:9px;'
                  'width:10px;height:10px;margin:0}@media(max-width:371px){.app .top .st-co{--h:17px}}</style>')
SIGNATURE = ('<a class="st-co" href="https://staytech.ru/" target="_blank" rel="noopener">'
             '<span class="st-co-by" aria-hidden="true">by</span><span class="st-co-logo">'
             '<img class="st-co-img-light" src="/staytech/staytech-transparent.png" alt="by Staytech" width="855" height="208">'
             '<img class="st-co-img-dark" src="/staytech/staytech-transparent-dark.png" alt="" width="900" height="208" loading="lazy">'
             '</span><svg class="st-co-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 11 11 5M6 5h5v5" '
             'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
             '<span class="sr-only">, сайт staytech.ru откроется в новой вкладке</span></a>')
# Яндекс Метрика НОТА: счётчик 113333784, вебвизор выключен. Сам код лежит в mobile/metrika.js
# (отдельный файл проходит CSP без 'unsafe-inline'), он же задаёт window.NOTA_YM_ID для целей.
YM_ID = 113333784
YM_VERSION = '20261002-ym-1'
YM_NOSCRIPT = (f'<noscript><div><img src="https://mc.yandex.ru/watch/{YM_ID}" '
               'style="position:absolute;left:-9999px" alt=""></div></noscript>')
YM_HOSTS = 'https://mc.yandex.ru https://mc.yandex.com'
CSP = ("default-src 'self'; "
       f"script-src 'self' {YM_HOSTS} https://yastatic.net; "
       "style-src 'self' 'unsafe-inline'; "
       f"img-src 'self' data: {YM_HOSTS}; "
       # wss: канал Метрики solid.ws; frame-src: служебный фрейм mc.yandex.ru (синхронизация cookie).
       f"connect-src 'self' {YM_HOSTS} wss://mc.yandex.ru wss://mc.yandex.com; "
       f"frame-src {YM_HOSTS}")
# Ссылки и телефоны в публичном названии не пропускаем: защита от спама и от случайно
# опубликованного своего номера.
LINK_RE = re.compile(r'(https?:|www\.|t\.me|\.ru\b|\.com\b|@[a-z0-9_]{3,})', re.I)
TONES = ('#eadfcc', '#e2e7d4', '#ead9d3', '#e3ddec', '#d8e5e2', '#eee7cc')


def init_db(connect):
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS group_publications(
          group_id TEXT PRIMARY KEY REFERENCES scent_groups(id) ON DELETE CASCADE,
          owner TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
          slug TEXT NOT NULL UNIQUE CHECK(length(slug) = 10),
          version INTEGER NOT NULL DEFAULT 1,
          snapshot TEXT NOT NULL,
          published_at REAL NOT NULL,
          updated_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS group_publications_owner ON group_publications(owner);
        ''')


def public_dir():
    """Корень сайта nota.staytech.ru. Не задан: публикация выключена (локально и в тестах)."""
    value = os.environ.get('NOTA_PUBLIC_DIR', '').strip()
    return Path(value) if value else None


def public_url():
    return os.environ.get('NOTA_PUBLIC_URL', 'https://nota.staytech.ru').rstrip('/')


def page_url(slug):
    return f'{public_url()}/g/{slug}/'


def new_slug():
    return ''.join(secrets.choice(ALPHABET) for _ in range(10))


def has_contacts(text):
    """Ссылка, ник или 10 и больше цифр подряд (номер телефона) в публичном тексте."""
    digits = re.sub(r'[\s()+-]', '', text or '')
    return bool(LINK_RE.search(text or '')) or bool(re.search(r'\d{10,}', digits))


def tone(key):
    """Тот же цвет метки, что в интерфейсе (groups.js chip): хэш ключа по кодам UTF-16."""
    raw = str(key).encode('utf-16-le')
    value = 0
    for i in range(0, len(raw), 2):
        value = (value * 31 + int.from_bytes(raw[i:i + 2], 'little')) & 0xFFFFFFFF
    return value % 6


# ---------------------------------------------------------------- снимок

def snapshot(group_name, items, tags, picks):
    """Что увидит гость. Только названия, бренды и наши метки: без цен, без данных владельца."""
    def item(x):
        return {'name': x['name'], 'brand': x['brand'], 'accords': list(x.get('accords') or [])[:5]}
    return {
        'name': group_name,
        'items': [item(x) for x in items][:30],
        'tags': [{'key': t['key'], 'label': t['label']} for t in tags][:6],
        'picks': [{**item(x), 'matches': [m['label'] for m in (x.get('matches') or [])][:2]}
                  for x in picks][:6],
    }


# ---------------------------------------------------------------- HTML

def esc(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def describe(snap):
    names = [x['name'] for x in snap['items']]
    count = len(names)
    head = ', '.join(names[:2]) + (f' и ещё {count - 2}' if count > 2 else '')
    notes = ', '.join(t['label'].lower() for t in snap['tags'][:3])
    text = f'{count} {plural(count, "аромат", "аромата", "ароматов")}: {head}.'
    return text + (f' Главные ноты: {notes}.' if notes else '')


def strip(accords):
    # Полоса аккордов: ширина сегмента убывает с весом аккорда, цвет как у метки в приложении.
    weights = [5, 4, 3, 2, 1]
    parts = [f'<i class="tone-{tone(a)}" style="flex:{weights[i]}"></i>' for i, a in enumerate(accords[:5])]
    return f'<span class="ng-strip" aria-hidden="true">{"".join(parts)}</span>'


def render_html(slug, snap, version):
    url = page_url(slug)
    image = f'{url}og-{version}.jpg'
    app = f'{APP_URL}?ref=g-{slug}#/collection'
    title = f'{snap["name"]} · НОТА'
    description = describe(snap)
    tags = ''.join(f'<span class="ng-tag tone-{tone(t["key"])}">{esc(t["label"])}</span>' for t in snap['tags'][:3])
    items = ''.join(f'<li class="pg-item"><strong>{esc(x["name"])}</strong><span class="muted">{esc(x["brand"])}</span></li>'
                    for x in snap['items'])
    tiles = ''.join(
        '<li class="ng-tile pg-tile">' + strip(x['accords'])
        + f'<strong class="ng-tile-name">{esc(x["name"])}</strong><span class="ng-tile-brand">{esc(x["brand"])}</span>'
        + (f'<span class="ng-tile-meta">{esc(" · ".join(x["matches"]))}</span>' if x['matches'] else '')
        + '</li>' for x in snap['picks'])
    picks = (f'<section class="pg-block" aria-labelledby="pg-picks"><h2 id="pg-picks">НОТА подобрала похожие</h2>'
             f'<ul class="ng-grid pg-grid">{tiles}</ul></section>') if tiles else ''
    data = json.dumps({'slug': slug, 'v': version}, separators=(',', ':'))
    count = len(snap['items'])
    return f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F1F2EF">
<meta name="color-scheme" content="light">
<meta name="nota-api-base" content="{API_BASE}">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="НОТА">
<meta property="og:title" content="{esc(snap["name"])}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="{esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="{ASSETS}app.css">
<link rel="stylesheet" href="{ASSETS}groups.css">
<link rel="stylesheet" href="{ASSETS}public.css">
{SIGNATURE_HEAD}
</head>
<body>
<div class="app pg-app">
<header class="top glass"><span class="st-pair"><a class="brand" href="{esc(app)}" data-track="public_to_app">НОТА</a>{SIGNATURE}</span></header>
<main id="main" class="pg-main">
<p class="pg-kicker">Группа ароматов · {count} {plural(count, "аромат", "аромата", "ароматов")}</p>
<h1 class="view-title pg-title">{esc(snap["name"])}</h1>
<div class="ng-tags pg-notes">{tags}</div>
<section class="pg-block" aria-labelledby="pg-items"><h2 id="pg-items">Ароматы группы</h2><ul class="pg-items">{items}</ul></section>
{picks}
<section class="pg-cta">
<h2>Подобрать под ваш вкус</h2>
<p class="muted">Добавьте 2-3 своих аромата, и НОТА найдёт похожие по нотам.</p>
<a class="btn pg-go" href="{esc(app)}" data-track="public_to_app">Подобрать мне</a>
</section>
</main>
</div>
<script type="application/json" id="nota-public">{data}</script>
<!-- Яндекс Метрика: до track.js, иначе цель public_opened уйдёт раньше, чем появится ym -->
<script src="{ASSETS}metrika.js?v={YM_VERSION}" defer></script>
{YM_NOSCRIPT}
<script src="{ASSETS}track.js" defer></script>
<script src="{ASSETS}public.js" defer></script>
</body>
</html>
'''


# ---------------------------------------------------------------- превью 1200x630

FONT_CANDIDATES = {
    'bold': ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
             '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
             '/Library/Fonts/Arial Bold.ttf'],
    'regular': ['/usr/share/fonts/dejavu/DejaVuSans.ttf',
                '/System/Library/Fonts/Supplemental/Arial.ttf',
                '/Library/Fonts/Arial.ttf'],
}


def _font(kind, size):
    from PIL import ImageFont
    for path in FONT_CANDIDATES[kind]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def _fit(draw, text, kind, size, width, minimum):
    """Уменьшает кегль до ширины, затем обрезает многоточием."""
    while size > minimum:
        font = _font(kind, size)
        if draw.textlength(text, font=font) <= width:
            return text, font
        size -= 4
    font = _font(kind, minimum)
    if draw.textlength(text, font=font) <= width:
        return text, font
    while text and draw.textlength(text + '…', font=font) > width:
        text = text[:-1]
    return (text.rstrip() + '…') if text else text, font


def render_og(snap):
    """JPEG 1200x630 в палитре Air: название группы, ароматы и три главные ноты."""
    from io import BytesIO
    from PIL import Image, ImageDraw
    image = Image.new('RGB', (1200, 630), '#F1F2EF')
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((48, 48, 1152, 582), radius=40, fill='#FFFFFF')
    draw.text((96, 92), 'НОТА', font=_font('bold', 34), fill='#1F2124')
    text, font = _fit(draw, snap['name'], 'bold', 76, 1008, 44)
    draw.text((96, 160), text, font=font, fill='#1F2124')
    names = [x['name'] for x in snap['items']]
    line = ', '.join(names[:3]) + (f' и ещё {len(names) - 3}' if len(names) > 3 else '')
    text, font = _fit(draw, line, 'regular', 34, 1008, 26)
    draw.text((96, 270), text, font=font, fill='#5D5750')
    tags = snap['tags'][:3]
    # Один кегль на все метки: самый крупный, при котором три капсулы помещаются в строку.
    for size in range(34, 22, -2):
        font = _font('bold', size)
        widths = [int(draw.textlength(t['label'], font=font)) + 56 for t in tags]
        if sum(widths) + 20 * max(0, len(tags) - 1) <= 1008:
            break
    x, used = 96, set()
    for t, width in zip(tags, widths):
        label = t['label']
        if x + width > 1104:
            label, _ = _fit(draw, label, 'bold', size, 1104 - x - 56, size)
            width = int(draw.textlength(label, font=font)) + 56
        k = tone(t['key'])
        while k in used and len(used) < 6:
            k = (k + 1) % 6
        used.add(k)
        draw.rounded_rectangle((x, 360, x + width, 440), radius=40, fill=TONES[k])
        draw.text((x + 28, 400), label, font=font, fill='#34362E', anchor='lm')
        x += width + 20
    draw.text((96, 500), 'Группа ароматов в НОТА', font=_font('regular', 30), fill='#5D5750')
    out = BytesIO()
    image.save(out, 'JPEG', quality=86, optimize=True)
    return out.getvalue()


# ---------------------------------------------------------------- файлы

# Служебные файлы публичных страниц лежат внутри g/: корень сайта занят самим приложением,
# его index.html и .htaccess сервер не трогает.
SCAFFOLD = {
    'g/.htaccess': '''# Публичные страницы НОТА: готовые файлы, генерирует сервер при публикации группы.
Options -Indexes
DirectoryIndex index.html
ErrorDocument 404 /g/404.html
<IfModule mod_headers.c>
  Header set X-Robots-Tag "noindex"
  Header set X-Content-Type-Options "nosniff"
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "\\.jpg$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
</IfModule>
''',
    'g/404.html': f'''<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Группа недоступна · НОТА</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="{ASSETS}app.css"><link rel="stylesheet" href="{ASSETS}public.css">{SIGNATURE_HEAD}</head>
<body><div class="app pg-app"><header class="top glass"><span class="st-pair"><a class="brand" href="{APP_URL}">НОТА</a>{SIGNATURE}</span></header>
<main class="pg-main"><h1 class="view-title pg-title">Группа больше недоступна</h1>
<p class="muted pg-lead">Автор закрыл доступ по ссылке. В НОТА можно собрать свою группу и подобрать похожие ароматы.</p>
<a class="btn pg-go" href="{APP_URL}#/collection">Открыть НОТА</a></main></div>
{YM_NOSCRIPT}
<script src="{ASSETS}metrika.js?v={YM_VERSION}" defer></script></body></html>
''',
}


def _write(path, data):
    # Сначала временный файл, затем атомарная замена: читатель не увидит половину страницы.
    tmp = path.with_name(f'.{path.name}.{secrets.token_hex(4)}.tmp')
    tmp.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _inside(root, path):
    """Путь лежит внутри папки публикации и не проходит через символические ссылки."""
    root = root.resolve()
    current = path
    while current != root and current != current.parent:
        if current.is_symlink():
            return False
        current = current.parent
    return path.resolve().is_relative_to(root)


def group_dir(slug):
    root = public_dir()
    if root is None or not SLUG_RE.match(slug or ''):
        return None
    path = root / 'g' / slug
    return path if _inside(root, path) else None


def ensure_scaffold(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'g').mkdir(exist_ok=True)
    for name, content in SCAFFOLD.items():
        path = root / name
        if not path.exists() or path.read_text(encoding='utf-8') != content:
            _write(path, content)


def write_page(slug, snap, version):
    """Пишет страницу и превью новой версии, старые превью удаляет. Возвращает адрес страницы."""
    root = public_dir()
    folder = group_dir(slug)
    if root is None or folder is None:
        raise RuntimeError('Публикация не настроена')
    ensure_scaffold(root)
    folder.mkdir(exist_ok=True)
    # Номер версии в имени картинки: Telegram кэширует превью по адресу.
    _write(folder / f'og-{version}.jpg', render_og(snap))
    _write(folder / 'index.html', render_html(slug, snap, version))
    for old in folder.glob('og-*.jpg'):
        if old.name != f'og-{version}.jpg':
            old.unlink(missing_ok=True)
    return page_url(slug)


def remove_page(slug):
    folder = group_dir(slug)
    if folder is not None and folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)


def remove_owner_pages(db, owner):
    """Удаляет страницы всех групп владельца. Строки в базе удалит каскад вместе с сессией."""
    try:
        rows = db.execute('SELECT slug FROM group_publications WHERE owner=?', (owner,)).fetchall()
    except Exception:
        return
    for (slug,) in rows:
        remove_page(slug)


def publish(db, owner, group_id, snap):
    """Создаёт или обновляет публикацию: строка в базе плюс файлы. Возвращает (slug, version)."""
    now = time.time()
    found = db.execute('SELECT slug, version FROM group_publications WHERE group_id=? AND owner=?',
                       (group_id, owner)).fetchone()
    raw = json.dumps(snap, ensure_ascii=False, separators=(',', ':'))
    if found:
        slug, version = found[0], found[1] + 1
        db.execute('UPDATE group_publications SET version=?, snapshot=?, updated_at=? WHERE group_id=?',
                   (version, raw, now, group_id))
    else:
        version = 1
        for _ in range(5):
            slug = new_slug()
            if not db.execute('SELECT 1 FROM group_publications WHERE slug=?', (slug,)).fetchone():
                break
        db.execute('INSERT INTO group_publications VALUES (?,?,?,?,?,?,?)',
                   (group_id, owner, slug, version, raw, now, now))
    write_page(slug, snap, version)
    return slug, version


def unpublish(db, owner, group_id):
    found = db.execute('SELECT slug FROM group_publications WHERE group_id=? AND owner=?',
                       (group_id, owner)).fetchone()
    if not found:
        return False
    db.execute('DELETE FROM group_publications WHERE group_id=? AND owner=?', (group_id, owner))
    remove_page(found[0])
    return True
