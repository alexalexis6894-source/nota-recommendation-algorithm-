<?php
// Публичный шлюз. Код Python, каталог и база находятся вне корня сайта.
declare(strict_types=1);
ini_set('display_errors', '0');
set_time_limit(110);
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function fail_json(int $status, string $message): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['detail' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
$root = '/var/www/u3644424/data/.nota-recognition';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
// Один шлюз на двух адресах: nota.staytech.ru/api (приложение) и staytech.ru/articles/nota-api
// (обработчик фото на Mac, вебхук Telegram и старые ссылки).
if (!is_string($path)) fail_json(404, 'Не найдено');
$prefix = str_starts_with($path, '/api/') ? '/api' : '/articles/nota-api';
if (!str_starts_with($path, $prefix.'/')) fail_json(404, 'Не найдено');
$path = substr($path, strlen($prefix));
if (!preg_match('~^/(health|v1/[a-zA-Z0-9/_-]+)$~D', $path)) fail_json(404, 'Не найдено');
$length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
$max = $path === '/v1/recognition' ? 12*1024*1024 : ($path === '/v1/events' ? 16384 : 65536);
if ($length > $max || $length < 0) fail_json(413, 'Слишком большой запрос');
// Ограничиваем и фактический поток, если Content-Length отсутствует.
$input = fopen('php://temp/maxmemory:1048576', 'w+');
$source = fopen('php://input', 'rb');
$bytes = stream_copy_to_stream($source, $input, $max + 1);
fclose($source);
if ($bytes === false || $bytes > $max) fail_json(413, 'Слишком большой запрос');
rewind($input);
// Опрос обработчика фото на Mac: пустую очередь и heartbeat отвечает PHP, без Python.
if ($path === '/v1/phone/claim' || $path === '/v1/phone/heartbeat') {
    require __DIR__.'/phone_fast.php';
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (nota_phone_fast($root, $path, $auth)) exit;
}
// События воронки пишет сам PHP, без процесса Python и без очереди из 4 мест.
if ($path === '/v1/events') {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail_json(405, 'Метод не поддерживается');
    require __DIR__.'/events.php';
    try {
        nota_store_events($root.'/data', (string)stream_get_contents($input));
    } catch (InvalidArgumentException $e) {
        fail_json(422, $e->getMessage());
    } catch (Throwable $e) {
        // Сбой аналитики не должен мешать человеку: ответ тот же, причина в журнале.
        error_log('nota events: '.get_class($e));
    }
    http_response_code(204);
    exit;
}
$lock = null;
for ($i=0; $i<4; $i++) {
    $candidate = fopen($root.'/worker-'.$i.'.lock', 'c');
    if ($candidate && flock($candidate, LOCK_EX | LOCK_NB)) { $lock=$candidate; break; }
    if ($candidate) fclose($candidate);
}
if (!$lock) fail_json(429, 'Сервис занят. Попробуйте через несколько секунд');
$env = [
    'PATH'=>'/usr/bin:/bin', 'LANG'=>'C.UTF-8', 'PYTHONIOENCODING'=>'utf-8',
    'REQUEST_METHOD'=>$_SERVER['REQUEST_METHOD'], 'PATH_INFO'=>$path,
    'SCRIPT_NAME'=>'', 'QUERY_STRING'=>$_SERVER['QUERY_STRING'] ?? '',
    'SERVER_NAME'=>'staytech.ru', 'SERVER_PORT'=>'443', 'SERVER_PROTOCOL'=>'HTTP/1.1',
    'HTTPS'=>'on', 'GATEWAY_INTERFACE'=>'CGI/1.1', 'CONTENT_LENGTH'=>(string)$bytes,
    'CONTENT_TYPE'=>$_SERVER['CONTENT_TYPE'] ?? 'application/json',
    'HTTP_AUTHORIZATION'=>$_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '',
    'HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'=>$_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '',
];
$output = tmpfile();
$error = fopen($root.'/gateway-error.log', 'ab');
$process = proc_open([$root.'/venv/bin/python', $root.'/gateway.py'], [0=>$input, 1=>$output, 2=>$error], $pipes, $root, $env);
if (!is_resource($process)) fail_json(503, 'Сервис временно недоступен');
$started = microtime(true);
do {
    $state = proc_get_status($process);
    if (!$state['running']) break;
    if (microtime(true)-$started > 100) { proc_terminate($process); break; }
    usleep(20000);
} while (true);
proc_close($process);
fclose($input); fclose($error);
flock($lock, LOCK_UN); fclose($lock);
rewind($output); $raw = stream_get_contents($output, 4*1024*1024); fclose($output);
$parts = preg_split('/\r?\n\r?\n/', $raw ?: '', 2);
if (count($parts) !== 2) fail_json(502, 'Не удалось завершить запрос');
$status = 200;
foreach (preg_split('/\r?\n/', $parts[0]) as $line) {
    if (preg_match('/^Status:\s*(\d{3})/i', $line, $m)) $status=(int)$m[1];
}
http_response_code($status);
header('Content-Type: application/json; charset=utf-8');
echo $parts[1];
