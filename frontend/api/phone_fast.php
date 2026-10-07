<?php
// Лёгкий путь для опроса обработчика фото на Mac (scripts/phone_worker.py).
// Обработчик спрашивает сервер каждые 2-10 с, есть ли снимки. Почти всегда очередь пуста,
// а каждый такой вопрос через Python стоил ~0,74 с процессора: около 13 000 запросов
// и 9 600 с процессора в сутки, половина лимита тарифа. Пустой ответ и heartbeat PHP
// отдаёт сам за миллисекунды. Если в очереди есть снимок, запрос уходит в Python как раньше:
// там выдача задания, аренда и очистка.
declare(strict_types=1);

/**
 * true: ответ уже отправлен. false: нужен полный путь через Python.
 * $now передаётся в тестах.
 */
function nota_phone_fast(string $root, string $path, string $authorization, ?float $now = null): bool {
    if (($_SERVER['REQUEST_METHOD'] ?? 'POST') !== 'POST') return false;
    $config = @json_decode((string)@file_get_contents($root.'/phone-config.json'), true);
    if (!is_array($config) || !is_string($config['worker_key'] ?? null) || $config['worker_key'] === '') return false;
    if (!hash_equals('Bearer '.$config['worker_key'], $authorization)) {
        nota_phone_reply(401, ['detail' => 'Нет доступа']);
        return true;
    }
    $now = $now ?? microtime(true);
    try {
        $db = new PDO('sqlite:'.$root.'/data/photos.sqlite', null, null,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 10]);
        if ($path === '/v1/phone/claim') {
            // Есть живой снимок в очереди: выдачу задания делает Python.
            $queued = $db->prepare("SELECT 1 FROM phone_jobs WHERE state='queued' AND created>=? LIMIT 1");
            $queued->execute([$now - 300]);
            if ($queued->fetchColumn()) return false;
        }
        // Обработчик на связи: та же отметка, что ставит Python в heartbeat и claim.
        $db->prepare('INSERT OR REPLACE INTO phone_worker VALUES (1,?)')->execute([$now]);
        if ($path === '/v1/phone/heartbeat') {
            nota_phone_reply(200, ['online' => true]);
            return true;
        }
        // Человек недавно открыл добавление по фото: спрашивать чаще, иначе раз в 10 с.
        $activity = $db->query('SELECT seen FROM phone_activity WHERE id=1')->fetchColumn();
        $next = ($activity !== false && $now - (float)$activity < 300) ? 2 : 10;
        nota_phone_reply(200, ['job' => null, 'next_poll' => $next]);
        return true;
    } catch (Throwable $e) {
        // Нет таблиц или база занята: пусть ответит Python, поведение прежнее.
        error_log('nota phone fast: '.get_class($e));
        return false;
    }
}

function nota_phone_reply(int $status, array $body): void {
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
}
