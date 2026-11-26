<?php

declare(strict_types=1);

// Native PHP observations for the media-fetch-guard WIRE rows (G-386). Each row
// enters through Image::fromUrl(...)->fetchPublicUrlContent() (or
// fetchUrlContent() for an unguarded control) over Laravel's REAL HTTP client,
// against the loopback server the entry point started for that row. The host
// resolver answers the row's `answers_any` for every name it is asked, which is
// what an attacker's own DNS zone does. Whether anything arrived is read off
// the server, not here; this records only WHICH refusal code stopped the fetch.
//
// The network guard below lets a request leave only when its host, read the
// ways a client may read it (percent-decoded, NFKC-folded, inet_aton numeric
// forms), is a 127.x address or `localhost`. Every wire row's host is such a
// spelling, so a guard that admits one reaches the loopback server, and a host
// that would leave the machine never does.
//
// PRISM_PHP_SRC and PRISM_AUTOLOAD work as in tools/per-call-url-guard/php.php.
// Diagnostics go to stderr: stdout carries only the JSON rows.
ini_set('display_errors', 'stderr');

$source = getenv('PRISM_PHP_SRC');
if (is_string($source) && $source !== '') {
    $source = rtrim(str_replace('\\', '/', (string) realpath($source)), '/');
    if (! is_file($source.'/src/PrismManager.php')) {
        throw new RuntimeException('PRISM_PHP_SRC is not a prism checkout.');
    }
    spl_autoload_register(static function (string $class) use ($source): void {
        $prefix = 'Prism\\Prism\\';
        if (! str_starts_with($class, $prefix)) {
            return;
        }
        $file = $source.'/src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';
        if (is_file($file)) {
            require $file;
        }
    }, prepend: true);
}

require getenv('PRISM_AUTOLOAD') ?: __DIR__.'/../../runners/php/vendor/autoload.php';

if (is_string($source) && $source !== '') {
    foreach (spl_autoload_functions() as $loader) {
        if ($loader instanceof Closure && (new ReflectionFunction($loader))->getStaticVariables()['source'] ?? null) {
            spl_autoload_unregister($loader);
            spl_autoload_register($loader, prepend: true);
        }
    }
}

use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Http;
use Prism\Prism\Exceptions\PrismUrlRefused;
use Prism\Prism\Support\HostResolver;
use Prism\Prism\ValueObjects\Media\Image;
use Psr\Http\Message\RequestInterface;

/** The address a dotted spelling names the way inet_aton reads it, or null. */
function wireInetAton(string $host): ?int
{
    $parts = explode('.', $host);
    if (count($parts) > 4) {
        return null;
    }
    $numbers = [];
    foreach ($parts as $part) {
        if (preg_match('/\A0[xX][0-9a-fA-F]*\z/', $part) === 1) {
            $numbers[] = $part === '0x' || $part === '0X' ? 0 : (int) hexdec(substr($part, 2));
        } elseif (preg_match('/\A0[0-7]+\z/', $part) === 1) {
            $numbers[] = (int) octdec($part);
        } elseif (preg_match('/\A[0-9]+\z/', $part) === 1) {
            $numbers[] = (int) $part;
        } else {
            return null;
        }
    }
    $last = array_pop($numbers);
    $value = 0;
    foreach ($numbers as $index => $number) {
        if ($number > 255) {
            return null;
        }
        $value |= $number << (24 - 8 * $index);
    }
    $room = 32 - 8 * count($numbers);
    if ($last >= (1 << $room)) {
        return null;
    }

    return $value | $last;
}

function wireReachesLoopback(string $host): bool
{
    $candidates = [$host, rawurldecode($host)];
    foreach ($candidates as $candidate) {
        if (class_exists(Normalizer::class)) {
            $candidates[] = (string) Normalizer::normalize($candidate, Normalizer::FORM_KC);
        }
        $candidates[] = str_replace(["\u{3002}", "\u{FF0E}", "\u{FF61}"], '.', $candidate);
    }
    foreach ($candidates as $candidate) {
        $candidate = rtrim(strtolower($candidate), '.');
        if ($candidate === 'localhost') {
            return true;
        }
        $address = wireInetAton($candidate);
        if ($address !== null && ($address >> 24) === 127) {
            return true;
        }
    }

    return false;
}

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);

$app = new Application(dirname(__DIR__, 2));
Facade::setFacadeApplication($app);
$app->instance('config', new Repository(['prism' => ['request_timeout' => 10]]));
$refusals = ['scheme_not_allowed', 'private_address_refused', 'host_did_not_resolve', 'redirect_refused', 'too_many_redirects', 'non_ascii_host_use_punycode'];

$rows = [];
foreach ($input['cases'] as $entry) {
    $app->instance(HostResolver::class, new class($entry['resolves'], $entry['answers_any']) implements HostResolver
    {
        /**
         * @param  array<string, list<string>>  $honest
         * @param  list<string>  $answers
         */
        public function __construct(private array $honest, private array $answers) {}

        public function resolve(string $host): array
        {
            return $this->honest[$host] ?? $this->answers;
        }
    });
    $factory = new Factory;
    $factory->globalMiddleware(static fn (callable $handler): callable => static function (RequestInterface $request, array $options) use ($handler) {
        if (! wireReachesLoopback($request->getUri()->getHost())) {
            throw new RuntimeException('Only a host that reaches loopback may be contacted in this corpus.');
        }

        return $handler($request, $options);
    });
    Http::swap($factory);

    $refusal = null;
    try {
        $image = Image::fromUrl($entry['url']);
        ($entry['guarded'] ?? true) ? $image->fetchPublicUrlContent() : $image->fetchUrlContent();
    } catch (PrismUrlRefused $refused) {
        $refusal = in_array($refused->code(), $refusals, true) ? $refused->code() : 'unrecognised:'.$refused->code();
    } catch (Throwable $error) {
        // The server answers 500 with no image: not a refusal.
        fwrite(STDERR, $entry['id'].': '.get_class($error)."\n");
    }
    $rows[] = ['id' => $entry['id'], 'refusal' => $refusal];
}
echo json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
