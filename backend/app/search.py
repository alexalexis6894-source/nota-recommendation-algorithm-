"""Поиск по словам и проверенным вариантам названий без объединения изданий."""
import re
import unicodedata
from collections import defaultdict

# Подтверждено официальной карточкой Kilian; юбилейная версия остается отдельной.
# https://www.bykilian.com/black-phantom-iconic-kilian-fragrance
ALIASES = {'43632': ['Black Phantom Memento Mori Kilian']}
WORDS = {
    'amouge': 'amouage', 'амуаж': 'amouage', 'амуаз': 'amouage',
    'киллиан': 'kilian', 'килиан': 'kilian', 'killian': 'kilian',
    'опус': 'opus', 'мементо': 'memento', 'мори': 'mori',
    'блэк': 'black', 'блек': 'black', 'фантом': 'phantom',
    'диор': 'dior', 'саваж': 'sauvage', 'соваж': 'sauvage',
    'шанель': 'chanel', 'герлен': 'guerlain', 'том': 'tom', 'форд': 'ford',
    'крид': 'creed', 'бай': 'by', 'клайв': 'clive', 'кристиан': 'christian',
}
# Русские написания брендов и распространенных названий. Это словарь поиска, не новые карточки.
WORDS.update({
    'прада':'prada', 'гуччи':'gucci', 'армани':'armani', 'версаче':'versace',
    'монталь':'montale', 'мансера':'mancera', 'нишане':'nishane', 'иницио':'initio',
    'байредо':'byredo', 'диптик':'diptyque', 'мемо':'memo', 'зержофф':'xerjoff',
    'ксерджофф':'xerjoff', 'ксерджоф':'xerjoff', 'роя':'roja', 'парфюмс':'parfums',
    'марли':'marly', 'делина':'delina', 'авентус':'aventus', 'эрба':'erba', 'пура':'pura',
    'баккара':'baccarat', 'бакара':'baccarat', 'руж':'rouge', 'франсис':'francis',
    'куркджян':'kurkdjian', 'куркджан':'kurkdjian', 'мейсон':'maison', 'мезон':'maison',
    'лост':'lost', 'черри':'cherry', 'интенс':'intense', 'эликсир':'elixir',
    'реклесс':'reckless', 'реклес':'reckless', 'лезер':'leather', 'ледер':'leather',
    'аткинсонс':'atkinsons', 'борн':'born', 'этернити':'eternity',
    'хлоя':'chloe', 'шалимар':'shalimar', 'ганимед':'ganymede',
    'марк':'marc', 'антуан':'antoine', 'барруа':'barrois', 'тициана':'tiziana',
    'терензи':'terenzi', 'кирке':'kirke', 'лайра':'lira', 'нейшн':'nation',
    'лалика':'lalique', 'лалик':'lalique', 'лютанс':'lutens', 'серж':'serge',
    'люи':'louis', 'луи':'louis', 'виттон':'vuitton', 'имаджинейшн':'imagination',
    'хачиват':'hacivat', 'хасиват':'hacivat', 'ангелс':'angels', 'шер':'share',
    'бланш':'blanche', 'брют':'brut', 'нероли':'neroli', 'портофино':'portofino', 'ом':'homme',
})
RU_MAP = dict(zip('абвгдеёзийклмнопрстуфхыэ',
                  ['a','b','v','g','d','e','e','z','i','y','k','l','m','n','o','p','r','s','t','u','f','h','y','e']))
RU_MAP.update({'ж':'zh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ю':'yu','я':'ya','ь':'','ъ':''})


def word_alias(word):
    if word in WORDS:
        return WORDS[word]
    if len(word) >= 4 and re.fullmatch('[а-яё]+', word):
        choices = {v for k,v in WORDS.items() if re.fullmatch('[а-яё]+', k) and one_edit(word, k)}
        if len(choices) == 1:
            return choices.pop()
    return word

# Физические клавиши стандартных русской и английской раскладок.
EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`"
RU_KEYS = "йцукенгшщзхъфывапролджэячсмитьбюё"
LAYOUTS = (str.maketrans(EN_KEYS, RU_KEYS), str.maketrans(RU_KEYS, EN_KEYS))

ROMANS = dict(zip('i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx'.split(), map(str, range(1, 21))))


def tokens(text):
    text = unicodedata.normalize('NFC', text.casefold())
    # Убираем диакритику только у латиницы, сохраняя русские й и ё.
    text = ''.join(''.join(x for x in unicodedata.normalize('NFKD', c)
                          if not unicodedata.combining(x))
                   if unicodedata.name(c, '').startswith('LATIN') else c for c in text)
    text = re.sub(r"(?<=\w)['’](?=\w)", '', text)
    result = [word_alias(t) for t in re.findall(r'[^\W_]+', text)]
    # Римские числа переводим только после Opus, чтобы не менять чужие названия.
    for i in range(1, len(result)):
        if result[i - 1] == 'opus':
            result[i] = ROMANS.get(result[i], result[i])
    if 'opus' in result:
        result = [ROMANS.get(t, t) if j+1 < len(result) and result[j+1] == 'opus' else t for j,t in enumerate(result)]
    return result


def one_edit(a, b):
    """Не более одной вставки, удаления, замены или перестановки соседних букв."""
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        bad = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        return len(bad) <= 1 or (len(bad) == 2 and bad[1] == bad[0] + 1
                                and a[bad[0]] == b[bad[1]] and a[bad[1]] == b[bad[0]])
    short, long = sorted((a, b), key=len)
    i = next((i for i, (x, y) in enumerate(zip(short, long)) if x != y), len(short))
    return short[i:] == long[i + 1:]


def two_edits(a, b):
    """Ограниченное расстояние Дамерау: две ошибки только для длинных слов."""
    if min(len(a),len(b)) < 7 or abs(len(a)-len(b)) > 2:
        return False
    previous = list(range(len(b)+1))
    older = None
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            cost = min(current[-1]+1, previous[j]+1, previous[j-1]+(ca != cb))
            if older is not None and j > 1 and ca == b[j-2] and a[i-2] == cb:
                cost = min(cost, older[j-2]+1)
            current.append(cost)
        if min(current) > 2:
            return False
        older, previous = previous, current
    return previous[-1] <= 2


class SearchIndex:
    def __init__(self, records):
        self.records = records
        self.postings = defaultdict(set)
        self.name_tokens = []
        for i, r in enumerate(records):
            name = re.sub(r'\s+for (?:women and men|men and women|women|men)\s*$', '', r['name'], flags=re.I)
            self.name_tokens.append(tokens(name))
            text = ' '.join([name, r['brand'], *ALIASES.get(r['pid'], [])])
            for word in set(tokens(text)):
                self.postings[word].add(i)
        self.vocabulary = list(self.postings)
        self.brands = {r['brand']: r['brand'].replace('-', ' ').title() for r in records}

    def suggest_brands(self, query, limit=5):
        words = tokens(query)
        if not words or len(query.strip()) < 2:
            return []
        matches = []
        for key, name in self.brands.items():
            parts = tokens(name)
            if parts[:1] == ['by'] and words[:1] != ['by']:
                parts = parts[1:]
            if len(words) > len(parts):
                continue
            penalties = []
            for word, part in zip(words, parts):
                if part == word:
                    penalties.append(0)
                elif part.startswith(word):
                    penalties.append(1)
                elif len(word) >= 4 and one_edit(word, part):
                    penalties.append(2)
                else:
                    break
            if len(penalties) == len(words):
                matches.append((sum(penalties), name, key))
        return [{'key': key, 'name': name} for _, name, key in sorted(matches)[:limit]]

    def find(self, query, limit, brand=None):
        direct = self._find(query, limit, brand)
        if direct:
            return direct
        # Переключение раскладки предлагается только при пустом исходном результате.
        for layout in LAYOUTS:
            corrected = query.casefold().translate(layout)
            if corrected != query.casefold():
                found = self._find(corrected, limit, brand)
                if found:
                    return found
        # Второй проход только после строгого поиска и проверки раскладки.
        return self._find(query, limit, brand, loose=True)

    def lookup(self, query, limit=15, brand=None):
        """Основная выдача отдельно от предположений. Ни одно слово запроса не выбрасывается."""
        exact = self._find(query, limit, brand, typos=False)
        if exact:
            return exact, []
        near = self._find(query, 60, brand)
        if near:
            # Небольшая опечатка надежна, когда в найденном контексте есть одно исправление.
            ambiguous = False
            for word in tokens(query):
                if any(t.startswith(word) and any(i in self.postings[t] for i in near) for t in self.vocabulary):
                    continue
                corrections = {t for t in self.vocabulary if one_edit(word,t)
                               and any(i in self.postings[t] for i in near)}
                if len(corrections) != 1:
                    ambiguous = True
            return ([], near[:3]) if ambiguous else (near[:limit], [])
        # Неверная раскладка надежна только при точных известных словах после переключения.
        for layout in LAYOUTS:
            corrected = query.casefold().translate(layout)
            parts = tokens(corrected)
            if corrected != query.casefold() and parts and all(w in self.postings for w in parts):
                found = self._find(corrected, limit, brand, typos=False)
                if found:
                    return found, []
        guesses = self._find(query, 3, brand, loose=True)
        # Общая транслитерация и неверная раскладка дают только подсказки.
        for variant in [' '.join(''.join(RU_MAP.get(c,c) for c in w) for w in tokens(query)),
                        *(query.casefold().translate(layout) for layout in LAYOUTS)]:
            if not guesses and variant != query.casefold():
                guesses = self._find(variant, 3, brand, loose=True)
        return [], guesses[:3]

    def _find(self, query, limit, brand=None, loose=False, typos=True):
        words = list(dict.fromkeys(tokens(query)))
        if not words or len(words) > 20 or len(query.strip()) < 2:
            return []
        scores = None
        for word in words:
            options = {word: 0} if word in self.postings else {}
            if (len(word) >= 2 or (word == words[-1] and len(words) > 1)) and not word.isdigit():
                for term in self.vocabulary:
                    if term != word and term.startswith(word):
                        options[term] = 1
                    elif typos and len(word) >= 4 and len(term) >= 4 and term != word and one_edit(word, term):
                        options[term] = 2
                    elif loose and term != word and two_edits(word, term):
                        options[term] = 5
            matched = {}
            for term, penalty in options.items():
                for i in self.postings.get(term, ()):
                    matched[i] = min(matched.get(i, 99), penalty)
            scores = matched if scores is None else {i: s + matched[i] for i, s in scores.items() if i in matched}
            if not scores:
                return []
        if brand:
            scores = {i: s for i, s in scores.items() if self.records[i]['brand'] == brand}
        # Сначала ароматы бренда, совпавшего с запросом, по популярности, затем совпадения по названию.
        kinds = {i: self.brand_kind(self.records[i]['brand'], words) for i in scores}
        for i in scores:
            # Название, начинающееся с запроса целыми словами (Baccarat Rouge 540), стоит рядом с брендом.
            if kinds[i] and scores[i] == 0 and self.name_tokens[i][:len(words)] == words:
                kinds[i] = 0
        return sorted(scores, key=lambda i: (kinds[i],
                      scores[i] if kinds[i] == 2 else 0,
                      -(self.records[i]['votes'] or 0) if kinds[i] < 2 else 0,
                      self.name_tokens[i][:len(words)] != words,
                      len(self.name_tokens[i]),
                      -(self.records[i]['votes'] or 0), int(self.records[i]['pid'])))[:limit]

    def brand_kind(self, name, words):
        """0: бренд начинается с запроса, 1: все слова запроса есть в бренде, 2: бренд не совпал."""
        cache = self.__dict__.setdefault('_brand_tokens', {})
        parts = cache.get(name)
        if parts is None:
            parts = cache[name] = tokens(name)
        if parts[:1] == ['by'] and words[:1] != ['by']:
            parts = parts[1:]
        hit = lambda w, p: p == w or p.startswith(w)
        if len(words) <= len(parts) and all(hit(w, p) for w, p in zip(words, parts)):
            return 0
        if all(any(hit(w, p) for p in parts) for w in words):
            return 1
        return 2


def catalog_response(index, query, summary, limit=15, brand=None):
    direct, possible = index.lookup(query, limit, brand)
    suggestions = []
    for i in possible:
        item = summary(i)
        clean = re.sub(r'\s+for (?:women and men|men and women|women|men)\s*$', '', item['name'], flags=re.I)
        suggestions.append({'pid':item['pid'], 'name':item['name'], 'brand':item['brand'],
                            'query':(item['brand']+' '+clean)[:150]})
    return {'items':[summary(i) for i in direct], 'suggestions':suggestions,
            'brands':index.suggest_brands(query)}
