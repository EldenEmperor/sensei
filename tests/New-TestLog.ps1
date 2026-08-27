# New-TestLog.ps1 — generate a synthetic messy application log with a planted
# failure narrative, plus a sidecar .answers.json with the ground-truth counts.
#
# The story: connection-pool WARNs ramp up from 02:10, an OutOfMemory FATAL
# lands at ~02:47:13, and a cascade of retry ERRORs follows. Payment-gateway
# timeout ERRORs and a rare config-parse ERROR occur throughout as red herrings.

param(
    [string]$Path = (Join-Path $PSScriptRoot 'app.log'),
    [int]$Lines = 200000
)

$rand = [Random]::new(42)
$t = [datetime]'2026-08-27 00:00:00'
$rampStart = [datetime]'2026-08-27 02:10:00'
$crashTime = [datetime]'2026-08-27 02:47:13'
$counts = @{
    payment_timeout = 0
    retry_failed    = 0
    config_parse    = 0
    pool_warn       = 0
    fatal           = 0
    total_lines     = 0
}

$stack = @(
    '   at OrderService.Cache.CacheManager.Grow(Int32 newSize)'
    '   at OrderService.Cache.CacheManager.Add(String key, Byte[] payload)'
    '   at OrderService.Handlers.OrderLookupHandler.HandleAsync(OrderRequest req)'
    '   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.TaskOfIActionResultExecutor.Execute(...)'
    '   at Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke(HttpContext httpContext)'
    '   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](...)'
    '   --- End of inner exception stack trace ---'
    '   at System.Threading.ThreadPoolWorkQueue.Dispatch()'
)

$sw = [System.IO.StreamWriter]::new($Path, $false, [System.Text.UTF8Encoding]::new($false))
try {
    while ($counts.total_lines -lt $Lines) {
        $t = $t.AddMilliseconds(50 + $rand.Next(0, 27))
        $stamp = $t.ToString('yyyy-MM-dd HH:mm:ss.fff')

        if ($t -ge $crashTime -and $counts.fatal -eq 0) {
            $sw.WriteLine("$stamp [FATAL] System.OutOfMemoryException: Insufficient memory to continue the execution of the program.")
            $counts.fatal = 1
            $counts.total_lines++
            foreach ($s in $stack) {
                if ($counts.total_lines -ge $Lines) { break }
                $sw.WriteLine($s)
                $counts.total_lines++
            }
            continue
        }

        $postCrash = $t -ge $crashTime
        $inRamp = ($t -ge $rampStart) -and (-not $postCrash)
        $roll = $rand.Next(0, 1000)
        $line = $null

        if ($postCrash -and $roll -lt 400) {
            $counts.retry_failed++
            $line = "$stamp [ERROR] Retry $($rand.Next(1, 6))/5 failed for request $([guid]::NewGuid()): connection refused (10061)"
        } elseif ($inRamp) {
            # WARN probability ramps from ~0% to ~15% as the crash approaches
            $progress = ($t - $rampStart).TotalSeconds / ($crashTime - $rampStart).TotalSeconds
            if ($roll -lt (150 * $progress)) {
                $counts.pool_warn++
                $used = [int](60 + 39 * $progress)
                $line = "$stamp [WARN] Connection pool nearing capacity: $used/100 connections in use, queue depth $($rand.Next(0, 40))"
            }
        }

        if ($null -eq $line) {
            if ($roll -lt 8) {
                $counts.payment_timeout++
                $line = "$stamp [ERROR] Payment gateway timeout after $($rand.Next(3000, 9000)) ms for order $($rand.Next(10000, 99999))"
            } elseif ($roll -lt 10) {
                $counts.config_parse++
                $line = "$stamp [ERROR] Failed to parse config value 'cache.ttl': input string was not in a correct format"
            } elseif ($roll -lt 60) {
                $line = "$stamp [DEBUG] Cache lookup key=order:$($rand.Next(10000, 99999)) hit=$([bool]($rand.Next(0, 2)))"
            } elseif ($roll -lt 80) {
                # legacy component with a different timestamp format, on purpose
                $line = "$($t.ToString('MM/dd/yyyy HH:mm:ss')) [INFO] LegacyBilling: invoice batch $($rand.Next(100, 999)) processed"
            } else {
                $line = switch ($rand.Next(0, 4)) {
                    0 { "$stamp [INFO] Request GET /api/orders/$($rand.Next(10000, 99999)) completed in $($rand.Next(5, 900)) ms (200)" }
                    1 { "$stamp [INFO] Heartbeat OK from worker-$($rand.Next(1, 9))" }
                    2 { "$stamp [INFO] User u$($rand.Next(1000, 9999)) session refreshed" }
                    3 { "$stamp [INFO] Cache refresh completed: $($rand.Next(500, 5000)) entries" }
                }
            }
        }

        $sw.WriteLine($line)
        $counts.total_lines++
    }
} finally {
    $sw.Close()
}

$counts.error_total = $counts.payment_timeout + $counts.retry_failed + $counts.config_parse
$counts.warn_total = $counts.pool_warn
$counts.crash_time = $crashTime.ToString('yyyy-MM-dd HH:mm:ss')
ConvertTo-Json -InputObject $counts | Set-Content -LiteralPath "$Path.answers.json" -Encoding utf8NoBOM
Write-Host "wrote $($counts.total_lines) lines to $Path (answers in $Path.answers.json)"
