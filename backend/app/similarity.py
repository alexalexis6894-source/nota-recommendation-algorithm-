"""Сходство ароматов по конкретным нотам и аккордам с весами Decant.

Ноты весят больше аккордов: «груша, амброксан, мускус» точнее описывает аромат,
чем «фрукты, сладость». Редкие ноты весят больше частых (IDF, обратная частота),
иначе мускус и бергамот, которые есть у каждого третьего аромата, заглушат грушу.
Индекс инвертированный: для каждой ноты хранится список ароматов, где она есть,
поэтому запрос обходит только ароматы с общими нотами, а не весь каталог.
"""
import math
import re
from array import array
from collections import defaultdict

PARENT_SHARE = .5        # «калабрийский бергамот» наполовину считается «бергамотом»
MIN_VOTES = 20           # в подбор попадают ароматы хотя бы с 20 оценками
PROMINENT = .3           # нота заметна, если её вес по голосам не ниже 30 из 100


def parse(text):
    """Компактная строка каталога REG.RU «pear:100|musk:42» в словарь весов 0..1."""
    result = {}
    for part in text.split('|'):
        name, _, weight = part.rpartition(':')
        if name:
            result[name] = int(weight) / 100
    return result


def pack(values):
    # Строка занимает в памяти сервера в разы меньше, чем списки пар.
    return '|'.join(f"{name.replace('|', '/')}:{round(weight * 100)}" for name, weight in values.items())


def weights(record, key, fallback):
    value = record.get(key)
    if isinstance(value, str):
        return parse(value) if value else {}
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return {name: weight for name, weight in value}
    names = record.get(fallback)
    if isinstance(names, dict):
        names = [n for level in names.values() for n in level]
    return {name: round(1 / math.sqrt(i + 1), 3) for i, name in enumerate(names or [])}


def accord_names(record):
    names = record.get('accords')
    if names is not None:
        return names
    # В компактном каталоге аккорды уже упорядочены по силе.
    return list(weights(record, 'accord_weights', 'accords'))


def plain(note):
    # «agarwood (oud)» и «agarwood» один источник запаха.
    return re.sub(r'\s*\(.*?\)\s*', ' ', note).strip()


class SimilarityIndex:
    def __init__(self, records):
        self.records = records
        note_df, accord_df = defaultdict(int), defaultdict(int)
        # Два прохода по каталогу: разобранные веса 140 тысяч ароматов не держим в памяти.
        self.has_notes = array('b')
        for r in records:
            notes = weights(r, 'note_weights', 'notes')
            self.has_notes.append(1 if notes else 0)
            for n in notes:
                note_df[n] += 1
            for a in weights(r, 'accord_weights', 'accords'):
                accord_df[a] += 1
        total = max(1, sum(self.has_notes))
        # Родитель ноты: самый длинный хвост названия, который сам частая нота.
        # В полном каталоге порог 100 ароматов, в маленьком тестовом он ниже.
        floor = min(100, max(2, len(records) // 100))
        frequent = {n for n, c in note_df.items() if c >= floor}
        self.parent = {}
        for n in note_df:
            base = plain(n)
            words = base.split()
            options = [base] if base != n else []
            options += [' '.join(words[i:]) for i in range(1, len(words))]
            for option in options:
                if option in frequent and option != n:
                    self.parent[n] = option
                    break
        df = defaultdict(int, note_df)
        for n, p in self.parent.items():
            df[p] += note_df[n]
        self.note_idf = {n: min(5., math.log((total + 1) / (c + 1)) + 1) for n, c in df.items()}
        self.accord_idf = {a: min(2.5, math.log((len(records) + 1) / (c + 1)) + 1) for a, c in accord_df.items()}
        note_postings, accord_postings = defaultdict(lambda: (array('I'), array('f'))), defaultdict(lambda: (array('I'), array('f')))
        # Векторы не хранятся: только компактные списки «нота -> ароматы пула».
        # Средний рейтинг каталога: опора для ароматов с малым числом голосов.
        ratings = [r['rating'] for r in records if isinstance(r.get('rating'), (int, float))
                   and 0 < r['rating'] <= 5 and (r.get('votes') or 0) >= 1]
        self.prior = sum(ratings) / len(ratings) if ratings else 3.9
        self.pool_size = 0
        for i, r in enumerate(records):
            if (r.get('votes') or 0) < MIN_VOTES:
                continue
            accords = weights(r, 'accord_weights', 'accords')
            if not accords:
                continue
            notes = weights(r, 'note_weights', 'notes')
            self.pool_size += 1
            for postings, vector in ((note_postings, self.note_vector(notes)), (accord_postings, self.accord_vector(accords))):
                for key, value in vector.items():
                    postings[key][0].append(i)
                    postings[key][1].append(value)
        self.note_postings = dict(note_postings)
        self.accord_postings = dict(accord_postings)

    @staticmethod
    def unit(vector):
        norm = math.sqrt(sum(v * v for v in vector.values()))
        return {k: v / norm for k, v in vector.items()} if norm else {}

    def note_vector(self, notes):
        vector = {}
        for n, w in notes.items():
            vector[n] = max(vector.get(n, 0), w * self.note_idf.get(n, 1))
            p = self.parent.get(n)
            if p:
                vector[p] = max(vector.get(p, 0), PARENT_SHARE * w * self.note_idf.get(p, 1))
        return self.unit(vector)

    def accord_vector(self, accords):
        return self.unit({a: w * self.accord_idf.get(a, 1) for a, w in accords.items()})

    def family(self, notes):
        # Сама нота и её родитель: «белый мускус» совпадает с «мускусом».
        return set(notes) | {self.parent[n] for n in notes if n in self.parent}

    def dots(self, postings, vector):
        result = defaultdict(float)
        for key, value in vector.items():
            found = postings.get(key)
            if not found:
                continue
            for i, w in zip(*found):
                result[i] += w * value
        return result
