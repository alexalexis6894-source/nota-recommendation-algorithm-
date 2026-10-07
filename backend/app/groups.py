"""Группы реальных ароматов, объяснимое сходство и сохраненный набор пробников."""
import json
import math
import re
import sqlite3
import time
from collections import Counter
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .similarity import SimilarityIndex, PROMINENT, weights, accord_names
from . import public_pages
from .orders import bonus_balance, MAX_KIT, BONUS_PERCENT

LABELS = {'woody':'Древесный','oud':'Уд','leather':'Кожа','warm spicy':'Тёплые специи',
 'fresh spicy':'Свежие специи','soft spicy':'Мягкие специи','sweet':'Сладкий','vanilla':'Ваниль',
 'amber':'Амбровый','aromatic':'Ароматические травы','citrus':'Цитрус','musky':'Мускус',
 'powdery':'Пудровый','fruity':'Фруктовый','floral':'Цветочный','white floral':'Белые цветы',
 'rose':'Роза','green':'Зелень','fresh':'Свежий','earthy':'Землистый','mossy':'Мох',
 'smoky':'Дымный','balsamic':'Бальзамический','animalic':'Анималистичный','coffee':'Кофе',
 'chocolate':'Шоколад','cacao':'Какао','rum':'Ром','caramel':'Карамель','nutty':'Ореховый',
 'almond':'Миндаль','tobacco':'Табак','lavender':'Лаванда','patchouli':'Пачули','aquatic':'Водный',
 'marine':'Морской','salty':'Солёный','ozonic':'Воздушный','yellow floral':'Жёлтые цветы',
 'violet':'Фиалка','iris':'Ирис','honey':'Мёд','cinnamon':'Корица','conifer':'Хвоя',
 'herbal':'Травяной','gourmand':'Гурманский','tropical':'Тропический','tuberose':'Тубероза',
 'aldehydic':'Альдегидный','lactonic':'Сливочный','milky':'Молочный','coconut':'Кокос',
 'cherry':'Вишня','soapy':'Мыльный','mineral':'Минеральный','metallic':'Металлический',
 'terpenic':'Терпеновый','anis':'Анис','camphor':'Камфорный','sour':'Кислый','bitter':'Горький',
 'foresty':'Лесной','spice':'Пряный','savory':'Пикантный','whiskey':'Виски','wine':'Вино',
 'alcohol':'Алкогольный','vodka':'Водка','champagne':'Шампанское','sake':'Саке','beeswax':'Воск',
 'pear':'Груша','cannabis':'Каннабис','clay':'Глина','sand':'Песок','paper':'Бумага',
 'plastic':'Пластик','rubber':'Резина','vinyl':'Винил','oily':'Маслянистый','asphault':'Асфальт',
 'gasoline':'Бензин','varnish':'Лак','hot iron':'Горячее железо','industrial glue':'Клей',
 'wet plaster':'Мокрая штукатурка','brown scotch tape':'Скотч','tennis ball':'Теннисный мяч',
 'coca-cola':'Кола','bacon':'Бекон','bbq':'Барбекю','meat':'Мясо'}


def _load_notes_ru():
    try:
        return json.loads((Path(__file__).with_name('notes_ru.json')).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


# Русские названия частых нот. Нет перевода, значит показываем исходное название.
NOTES_RU = _load_notes_ru()
MODES = ('close', 'new')
# Сколько ароматов подбора можно показать на экране группы: 12 и «Показать ещё 12» до 36.
MAX_RECOMMENDATIONS = 36
# Порядок ароматов в группе задаёт владелец: сверху любимые. Каждое следующее место весит
# в 0.7 раза меньше предыдущего. Для группы из 3 ароматов доли 46%, 32%, 22%.
RANK_DECAY = .7


def rank_weights(n):
    """Вес аромата по месту в группе, первое место равно 1."""
    return [RANK_DECAY ** k for k in range(n)]


def init_db(connect):
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS scent_groups(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
          name TEXT NOT NULL, pids TEXT NOT NULL, updated_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS scent_groups_owner ON scent_groups(owner);
        CREATE TABLE IF NOT EXISTS sample_selection(
          owner TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
          pid TEXT NOT NULL, group_id TEXT REFERENCES scent_groups(id) ON DELETE SET NULL,
          created_at REAL NOT NULL, PRIMARY KEY(owner,pid));
        ''')


_INDEXES = {}


def similarity_index(records):
    # Индекс строится один раз на загруженный каталог и живёт, пока жив каталог.
    prebuilt = getattr(records, 'similarity', None)
    if prebuilt is not None:
        return prebuilt
    key = id(records)
    found = _INDEXES.get(key)
    if found is None or found.records is not records or len(found.has_notes) != len(records):
        _INDEXES.clear()
        found = _INDEXES[key] = SimilarityIndex(records)
    return found


def note_label(note):
    if note in NOTES_RU:
        return NOTES_RU[note]
    base = re.sub(r'\s*\(.*?\)\s*', ' ', note).strip()
    return NOTES_RU.get(base) or base[:1].upper() + base[1:]


def tag(key, count=None, kind='accord'):
    label = note_label(key) if kind == 'note' else LABELS.get(key, key)
    result = {'key': key, 'label': label, 'kind': kind}
    if count is not None: result['source_count'] = count
    return result


def note_strength(items, index=None):
    """Суммарная заметность нот в группе с поправкой на редкость."""
    strength, counts = Counter(), Counter()
    # Ноты ароматов с верхних мест группы весят больше: так метки и подбор следуют приоритету.
    for r, rank in zip(items, rank_weights(len(items))):
        notes = weights(r, 'note_weights', 'notes')
        top = max(notes.values(), default=0)
        seen = set()
        for n, w in notes.items():
            # В метки идут только заметные ноты; при отсутствии голосов берём все.
            if top >= PROMINENT and w < PROMINENT:
                continue
            key = index.parent.get(n, n) if index and n not in NOTES_RU and index.parent.get(n) in NOTES_RU else n
            idf = index.note_idf.get(key, 1) if index else 1
            strength[key] = max(strength[key], 0) + w * idf * rank
            seen.add(key)
        counts.update(seen)
    return strength, counts


def profile(items, index=None):
    strength, counts = note_strength(items, index)
    notes = sorted(strength, key=lambda n: (-strength[n], n))[:5]
    accord_counts = Counter(a for r in items for a in set(accord_names(r)[:5]))
    accord_weight = Counter()
    for r in items: accord_weight.update(weights(r, 'accord_weights', 'accords'))
    accords = sorted(accord_counts, key=lambda a: (-accord_counts[a], -accord_weight[a], a))
    # Сначала конкретные ноты, аккорды только добирают до шести меток.
    tags = [tag(n, counts[n], 'note') for n in notes]
    labels = {t['label'].lower() for t in tags}
    # «Мускус» как нота и как аккорд не дублируем.
    tags += [tag(a, accord_counts[a]) for a in accords if LABELS.get(a, a).lower() not in labels][:6 - len(tags)]
    names = ['Вечер', 'На каждый день', 'Лето', 'Особый случай']
    lead = [t['label'] for t in tags[:2]]
    if lead: names.insert(0, ' · '.join(lead))
    return {'tags': tags, 'suggested_names': names}


def reputation(r):
    # Число голосов не является числом текстовых отзывов.
    try:
        rating=float(r.get('rating'))
        votes=float(r.get('votes'))
        if not math.isfinite(rating) or not math.isfinite(votes): return None
        if not 0 < rating <= 5 or votes < 1 or not votes.is_integer(): return None
        return {'rating':round(rating,2),'rating_count':int(votes),'rating_source':'Fragrantica'}
    except (TypeError,ValueError):
        return None


def reputation_score(r, prior):
    data=reputation(r)
    if not data: return 0.0
    n=data['rating_count']
    # Сто условных голосов со средним рейтингом каталога сдерживают малые выборки.
    reliable=(n*data['rating']+100*prior)/(n+100)
    popularity=min(1.0,math.log1p(n)/math.log1p(10000))
    return .8*reliable/5+.2*popularity


def public_item(r):
    # Полное исходное название сохраняется отдельно, бренд в интерфейсе не дублируется.
    name=re.sub(r'\s*for (?:women and men|men and women|women|men)\s*$','',r['name'],flags=re.I)
    name=re.sub(r'[\u2013\u2014\u2212]','-',name)
    brand=r['brand']
    # Старый снимок хранил бренд ключом «by-kilian», Decant уже в написании бренда.
    if brand == brand.lower(): brand = brand.replace('-',' ').title()
    name=re.sub(r'\s+'+re.escape(brand)+r'\s*$','',name,flags=re.I)
    if r['pid']=='43632': name='Black Phantom - Memento Mori'
    return {'pid':r['pid'],'name':name,'brand':brand,'accords':accord_names(r),
            'reputation':reputation(r)}


def explain(index, candidate, seed_notes, signature, visible):
    """Общие ноты, новые заметные ноты и характерные ноты группы, которых у аромата нет."""
    notes = weights(candidate, 'note_weights', 'notes')
    family = lambda n: {n, index.parent.get(n, n)}
    seed_family = index.family(seed_notes)
    idf = lambda n: index.note_idf.get(n, 1)
    shared, added = {}, {}
    for n, w in notes.items():
        common = family(n) & seed_family
        if common:
            # Показываем ноту в написании группы: «груша», а не «груша вильямс».
            key = n if n in seed_family else sorted(common)[0]
            shared[key] = max(shared.get(key, 0), w * idf(key))
        elif w >= PROMINENT or max(notes.values()) < PROMINENT:
            added[n] = w * idf(n)
    cand_family = index.family(notes)
    missing = [n for n in signature if not family(n) & cand_family][:2]
    shared_keys = sorted(shared, key=lambda n: (n not in visible, -shared[n], n))[:4]
    matches = [tag(n, kind='note') for n in shared_keys]
    if len(matches) < 2:
        seed_accords = visible
        matches += [tag(a) for a in accord_names(candidate) if a in seed_accords][:4 - len(matches)]
    return matches, {'added': [tag(n, kind='note') for n in sorted(added, key=lambda n: (-added[n], n))[:3]],
                     'missing': [tag(n, kind='note') for n in missing]}


def recommend(records, seeds, excluded, limit=9, mode='close', available=None):
    """Подбор по группе. close: ближе к моим. new: тот же характер, но другие ноты.

    available: множество pid, которые можно заказать. Если задано, в выдачу попадают только они:
    в магазине карточка без возможности купить бесполезна. Порог сходства остаётся прежним.
    """
    if mode not in MODES:
        raise ValueError('Неизвестный режим подбора')
    index = similarity_index(records)
    seed_vectors = []
    for s in seeds:
        nv = index.note_vector(weights(s, 'note_weights', 'notes'))
        av = index.accord_vector(weights(s, 'accord_weights', 'accords'))
        seed_vectors.append((nv, av))
    per_seed = [(index.dots(index.note_postings, nv), index.dots(index.accord_postings, av)) for nv, av in seed_vectors]
    seed_notes = set().union(*(weights(s, 'note_weights', 'notes') for s in seeds))
    seed_pids = {s['pid'] for s in seeds}
    strength, _ = note_strength(seeds, index)
    signature = [n for n in sorted(strength, key=lambda n: -strength[n])[:3]]
    group_profile = profile(seeds, index)
    visible = {t['key'] for t in group_profile['tags']}
    candidates = set()
    for notes, accords in per_seed:
        candidates.update(notes)
        candidates.update(accords)
    ranks = rank_weights(len(seeds)); total_rank = sum(ranks)
    scored = []
    # Баллы считаются только по индексу, без чтения карточек: кандидатов десятки тысяч.
    for i in candidates:
        sims, note_sims, accord_sims = [], [], []
        for (nv, av), (notes, accords) in zip(seed_vectors, per_seed):
            n, a = notes.get(i, 0.), accords.get(i, 0.)
            note_sims.append(n if nv and index.has_notes[i] else 0.)
            accord_sims.append(a)
            if mode == 'new':
                # Тот же характер по аккордам, но состав нот должен заметно отличаться.
                sims.append(.8 * a + .2 * n)
            elif nv and index.has_notes[i]:
                sims.append(.6 * n + .4 * a)
            else:
                sims.append(.85 * a)
        # Средняя близость взвешена по месту аромата в группе. Лучшее совпадение тоже учитывает
        # место, но мягче: сильное сходство с последним ароматом не пропадает совсем.
        score = .7 * sum(w * s for w, s in zip(ranks, sims)) / total_rank + .3 * max(
            s * (.5 + .5 * w) for w, s in zip(ranks, sims))
        if mode == 'new' and (max(note_sims) > .45 or max(accord_sims) < .55):
            continue
        if score < (.45 if mode == 'new' else .3):
            continue
        scored.append((score, i, sims))
    scored.sort(key=lambda x: -x[0])
    blocked = set(excluded) | seed_pids
    # Карточки читаются только для самых близких; при учёте наличия смотрим глубже,
    # потому что у поставщика есть примерно каждый десятый аромат каталога.
    pool = scored[:300 if available is None else 900]
    ranked = [x for x in pool if records[x[1]]['pid'] not in blocked
              and (available is None or records[x[1]]['pid'] in available)]
    prior = index.prior
    best = max((x[0] for x in ranked), default=0)
    # Рейтинг меняет порядок только внутри полосы сходства шириной 0.05.
    # Популярный, но существенно менее похожий аромат не перескочит верхнюю полосу.
    ranked.sort(key=lambda x: (math.floor((best - x[0] + 1e-9) / .05),
                               -reputation_score(records[x[1]], prior), -x[0], records[x[1]]['pid']))
    result = []; brands = Counter(); names = set()
    for score, i, sims in ranked:
        r = records[i]
        if brands[r['brand']] >= 2: continue
        # Одинаковые названия у одного бренда (переиздания, объёмы) показываем один раз.
        title = (r['brand'].lower(), re.sub(r'\W+', ' ', public_item(r)['name'].lower()).strip())
        if title in names: continue
        matches, differences = explain(index, r, seed_notes, signature, visible)
        if not matches: continue
        if mode == 'new' and len(differences['added']) < 2: continue
        result.append({**public_item(r), 'matches': matches, 'differences': differences,
          'similar_to': [public_item(seeds[k]) for k in sorted(range(len(seeds)), key=lambda k: (-sims[k] * ranks[k], k))[:2]],
          'score': round(score, 4)})
        brands[r['brand']] += 1; names.add(title)
        if len(result) >= limit: break
    return result


class GroupInput(BaseModel):
    name: str=Field(default='',max_length=60)
    pids: list[str]=Field(min_length=1,max_length=30)

class SampleInput(BaseModel):
    pid: str=Field(pattern=r'^\d+$',max_length=15)
    group_id: str=Field(min_length=1,max_length=64)


def create_router(owner,connect,get_catalog,offers=None):
    router=APIRouter(prefix='/v1')
    def offer(pid):
        from .orders import public_offer
        return public_offer(offers.get(pid)) if offers else None
    def stocked():
        return bool(offers and offers.all())
    def collection(db,user):
        return {r[0] for r in db.execute('SELECT pid FROM manual_collection WHERE owner=? UNION SELECT pid FROM photo_collection WHERE owner=?',(user,user))}
    def group(db,user,gid):
        r=db.execute('SELECT id,name,pids FROM scent_groups WHERE owner=? AND id=?',(user,gid)).fetchone()
        if not r: raise HTTPException(404,'Группа не найдена')
        return r
    def items(pids):
        # Полные записи каталога: в них веса нот и аккордов для меток и подбора.
        cat=get_catalog()
        return [cat.records[cat.index[p]] for p in pids if p in cat.index]
    def described(rows):
        return profile(rows,similarity_index(get_catalog().records))
    def published(db,user):
        # Адреса публичных страниц групп владельца одним запросом: group_id -> url.
        return {g:public_pages.page_url(slug) for g,slug in db.execute('SELECT group_id,slug FROM group_publications WHERE owner=?',(user,))}
    def packed(r,public_url=None):
        rows=items(json.loads(r[2]))
        return {'id':r[0],'name':r[1],'pids':json.loads(r[2]),'items':[public_item(x) for x in rows],**described(rows),
                'public_url':public_url}
    def snapshot(db,user,r):
        # Снимок для публичной страницы: 6 самых близких ароматов «НОТА подобрала» на момент публикации.
        seeds=items(json.loads(r[2]))
        available=set(offers.all()) if stocked() else None
        picks=recommend(get_catalog().records,seeds,collection(db,user),limit=6,mode='close',available=available) if seeds else []
        return public_pages.snapshot(r[1],[public_item(x) for x in seeds],described(seeds)['tags'],picks)

    @router.get('/groups')
    def groups(user=Depends(owner)):
        with connect() as db:
            rows=db.execute('SELECT id,name,pids FROM scent_groups WHERE owner=? ORDER BY updated_at DESC',(user,)).fetchall()
            urls=published(db,user)
        return {'groups':[packed(r,urls.get(r[0])) for r in rows]}

    @router.post('/groups/preview')
    def preview(body:GroupInput,user=Depends(owner)):
        with connect() as db:
            if not set(body.pids)<=collection(db,user):raise HTTPException(422,'Выберите свои ароматы')
        return described(items(list(dict.fromkeys(body.pids))))

    @router.put('/groups/{gid}')
    def save_group(gid:str,body:GroupInput,user=Depends(owner)):
        if not re.fullmatch('[A-Za-z0-9_-]{1,64}',gid):raise HTTPException(422,'Некорректная группа')
        pids=list(dict.fromkeys(body.pids))
        with connect() as db:
            if not set(pids)<=collection(db,user):raise HTTPException(422,'Выберите ароматы из своей коллекции')
            other=db.execute('SELECT owner FROM scent_groups WHERE id=?',(gid,)).fetchone()
            if other and other[0]!=user:raise HTTPException(404,'Группа не найдена')
            if not other and db.execute('SELECT COUNT(*) FROM scent_groups WHERE owner=?',(user,)).fetchone()[0]>=30:raise HTTPException(422,'Можно сохранить до 30 групп')
            rows=items(pids)
            if len(rows)!=len(pids):raise HTTPException(422,'Аромат больше недоступен в каталоге')
            name=body.name.strip() or described(rows)['suggested_names'][0]
            changed=db.execute('INSERT INTO scent_groups VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,pids=excluded.pids,updated_at=excluded.updated_at WHERE scent_groups.owner=excluded.owner',(gid,user,name,json.dumps(pids),time.time()))
            if changed.rowcount!=1:raise HTTPException(404,'Группа не найдена')
            url=published(db,user).get(gid)
            if url:
                # Группа уже опубликована: страница по ссылке показывает новый состав.
                if len(pids)<2 or public_pages.has_contacts(name) or public_pages.public_dir() is None:
                    public_pages.unpublish(db,user,gid);url=None
                else:
                    public_pages.publish(db,user,gid,snapshot(db,user,(gid,name,json.dumps(pids))))
        return packed((gid,name,json.dumps(pids)),url)

    @router.delete('/groups/{gid}',status_code=204)
    def delete_group(gid:str,user=Depends(owner)):
        with connect() as db:
            group(db,user,gid)
            # Страница по ссылке удаляется вместе с группой, строку публикации удалит каскад.
            public_pages.unpublish(db,user,gid)
            db.execute('DELETE FROM scent_groups WHERE id=? AND owner=?',(gid,user))

    @router.put('/groups/{gid}/public')
    def make_public(gid:str,user=Depends(owner)):
        """Владелец явно открывает группу по ссылке. Повторный вызов обновляет страницу."""
        if public_pages.public_dir() is None:raise HTTPException(503,'Публикация временно недоступна')
        with connect() as db:
            r=group(db,user,gid)
            if len(json.loads(r[2]))<2:raise HTTPException(422,'Чтобы поделиться группой, добавьте в неё хотя бы 2 аромата')
            if public_pages.has_contacts(r[1]):raise HTTPException(422,'Уберите из названия ссылки и номера телефонов')
            slug,_=public_pages.publish(db,user,gid,snapshot(db,user,r))
        return {'public':True,'slug':slug,'url':public_pages.page_url(slug)}

    @router.delete('/groups/{gid}/public',status_code=204)
    def make_private(gid:str,user=Depends(owner)):
        with connect() as db:
            group(db,user,gid)
            public_pages.unpublish(db,user,gid)

    @router.get('/groups/{gid}/recommendations')
    def recommendations(gid:str,mode:str='close',limit:int=9,offset:int=0,user=Depends(owner)):
        # limit и offset: страница выдачи. Всего не больше MAX_RECOMMENDATIONS, по умолчанию 9,
        # как раньше, чтобы старая версия интерфейса из кэша браузера получала прежний ответ.
        if mode not in MODES:raise HTTPException(422,'Неизвестный режим подбора')
        if not 1<=limit<=MAX_RECOMMENDATIONS or not 0<=offset<MAX_RECOMMENDATIONS or offset+limit>MAX_RECOMMENDATIONS:
            raise HTTPException(422,f'Можно показать до {MAX_RECOMMENDATIONS} ароматов')
        with connect() as db:
            r=group(db,user,gid);excluded=collection(db,user)
        seeds=items(json.loads(r[2]));cat=get_catalog()
        records=cat.records
        available=set(offers.all()) if stocked() else None
        # Подбор всё равно сортирует всех кандидатов, поэтому пропуск первых offset почти бесплатный.
        # Ещё один аромат сверх страницы нужен, чтобы честно ответить, есть ли продолжение.
        want=min(offset+limit+1,MAX_RECOMMENDATIONS+1)
        found=recommend(records,seeds,excluded,limit=want,mode=mode,available=available) if seeds else []
        page=found[offset:offset+limit]
        with connect() as db:url=published(db,user).get(gid)
        return {'group':packed(r,url),'mode':mode,'items':[{**x,'offer':offer(x['pid'])} for x in page],
                'offset':offset,'limit':limit,
                'has_more':len(found)>offset+limit and offset+limit<MAX_RECOMMENDATIONS,
                'method':'notes_accords_bands_reputation_rank_stock_v5' if available else 'notes_accords_bands_reputation_rank_v5',
                'stock_connected':stocked()}

    def kit_bonus(db,user):
        # Бонусы живут в таблице заявок; без неё (старая база до первой заявки) баланс нулевой.
        try:return bonus_balance(db,user)
        except sqlite3.OperationalError:return {'available':0,'pending':0,'percent':BONUS_PERCENT}
    @router.get('/samples')
    def samples(user=Depends(owner)):
        with connect() as db:
            rows=db.execute('SELECT s.pid,g.name FROM sample_selection s LEFT JOIN scent_groups g ON s.group_id=g.id WHERE s.owner=? ORDER BY s.created_at',(user,)).fetchall()
            bonus=kit_bonus(db,user)
        mode='order' if stocked() else 'preview'
        if not rows:return {'items':[], 'checkout_mode':mode,'stock_connected':stocked(),'total':0,'bonus':bonus}
        cat=get_catalog()
        items=[{**public_item(cat.summary(cat.index[p])),'group_name':name,'offer':offer(p)} for p,name in rows if p in cat.index]
        return {'items':items,'checkout_mode':mode,'stock_connected':stocked(),
                'total':sum(x['offer']['price'] for x in items if x['offer']),'bonus':bonus}

    @router.post('/samples')
    def add_sample(body:SampleInput,user=Depends(owner)):
        cat=get_catalog()
        if body.pid not in cat.index:raise HTTPException(404,'Аромат не найден')
        if stocked() and not offers.get(body.pid):raise HTTPException(422,'Этого аромата сейчас нет в наличии')
        with connect() as db:
            group(db,user,body.group_id)
            if body.pid in collection(db,user):raise HTTPException(422,'Этот аромат уже есть в коллекции')
            if db.execute('SELECT COUNT(*) FROM sample_selection WHERE owner=?',(user,)).fetchone()[0]>=MAX_KIT and not db.execute('SELECT 1 FROM sample_selection WHERE owner=? AND pid=?',(user,body.pid)).fetchone():raise HTTPException(422,f'В набор можно добавить до {MAX_KIT} ароматов')
            db.execute('INSERT OR IGNORE INTO sample_selection VALUES (?,?,?,?)',(user,body.pid,body.group_id,time.time()))
        return {'saved':True,'pid':body.pid}

    @router.delete('/samples/{pid}',status_code=204)
    def remove_sample(pid:str,user=Depends(owner)):
        with connect() as db:db.execute('DELETE FROM sample_selection WHERE owner=? AND pid=?',(user,pid))
    return router
