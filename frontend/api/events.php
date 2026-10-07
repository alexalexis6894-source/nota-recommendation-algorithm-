<?php
// События воронки НОТА без запуска Python: PHP пишет пачку событий в отдельную SQLite.
// Один запрос стоит миллисекунды процессора, а не 0,7 с, как любой запрос к FastAPI.
// Хранится только: имя события из списка, случайный id браузера, раздел, мелкие параметры.
// Адрес клиента, токен сессии и телефон сюда не попадают.
declare(strict_types=1);

const NOTA_EVENTS = [
    'group_created',   // создал группу
    'group_ranked',    // расставил ароматы группы по приоритету
    'recs_opened',     // открыл подбор по группе
    'recs_more',       // нажал «Показать ещё 12»
    'kit_added',       // добавил аромат в набор
    'share_opened',    // открыл лист «Поделиться»
    'shared',          // поделился: картинка через меню телефона, сохранил картинку или скопировал ссылку
    'group_published', // сделал группу публичной
    'public_opened',   // открыл публичную ссылку на группу
    'public_to_app',   // со страницы группы перешёл к себе в НОТА
    'order_sent',      // отправил заявку на набор
];
const NOTA_EVENTS_MAX_BATCH = 20;
const NOTA_EVENTS_DAILY_CAP = 50000;

function nota_event_params($params): string {
    // Параметры: до 6 ключей латиницей, значения строка до 64 символов, число или булево.
    if (!is_array($params)) return '{}';
    $clean = [];
    foreach ($params as $key => $value) {
        if (count($clean) >= 6) break;
        if (!is_string($key) || !preg_match('~^[a-z_]{1,20}$~D', $key)) continue;
        if (is_bool($value) || is_int($value)) $clean[$key] = $value;
        elseif (is_float($value) && is_finite($value)) $clean[$key] = round($value, 3);
        elseif (is_string($value)) $clean[$key] = mb_substr(preg_replace('~[\x00-\x1F\x7F]~u', '', $value) ?? '', 0, 64);
    }
    return $clean ? (json_encode($clean, JSON_UNESCAPED_UNICODE) ?: '{}') : '{}';
}

/** Сохраняет пачку событий. Возвращает число записанных. Бросает InvalidArgumentException на мусор. */
function nota_store_events(string $dataDir, string $raw, ?float $now = null): int {
    $now = $now ?? microtime(true);
    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['events']) || !is_array($data['events'])) {
        throw new InvalidArgumentException('Проверьте события');
    }
    $vid = is_string($data['v'] ?? null) && preg_match('~^[A-Za-z0-9_-]{8,40}$~D', $data['v']) ? $data['v'] : '';
    $page = in_array($data['page'] ?? '', ['app', 'public'], true) ? $data['page'] : 'app';
    $rows = [];
    foreach (array_slice($data['events'], 0, NOTA_EVENTS_MAX_BATCH) as $event) {
        if (!is_array($event) || !in_array($event['n'] ?? null, NOTA_EVENTS, true)) continue;
        // Время браузера принимаем только в пределах суток от времени сервера.
        $client = is_numeric($event['t'] ?? null) ? ((float)$event['t']) / 1000 : $now;
        if (abs($client - $now) > 86400) $client = $now;
        $rows[] = [$event['n'], nota_event_params($event['p'] ?? []), $client];
    }
    if (!$rows) return 0;
    $path = $dataDir . '/events.sqlite';
    $fresh = !file_exists($path);
    $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 3]);
    if ($fresh) @chmod($path, 0600);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY, day TEXT NOT NULL, name TEXT NOT NULL, vid TEXT NOT NULL,
        page TEXT NOT NULL, params TEXT NOT NULL, client_at REAL NOT NULL, created_at REAL NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS events_day ON events(day, name)');
    // День по Москве: так удобнее сверять с заявками и активностью.
    $day = (new DateTimeImmutable('@' . (int)$now))->setTimezone(new DateTimeZone('Europe/Moscow'))->format('Y-m-d');
    $count = $db->prepare('SELECT COUNT(*) FROM events WHERE day=?');
    $count->execute([$day]);
    if ((int)$count->fetchColumn() >= NOTA_EVENTS_DAILY_CAP) return 0;
    $insert = $db->prepare('INSERT INTO events(day, name, vid, page, params, client_at, created_at) VALUES (?,?,?,?,?,?,?)');
    $db->beginTransaction();
    foreach ($rows as [$name, $params, $client]) $insert->execute([$day, $name, $vid, $page, $params, $client, $now]);
    $db->commit();
    return count($rows);
}
