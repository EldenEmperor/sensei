# openai.ps1 — chat-completions client: shared HttpClient, retries, SSE streaming,
# Ctrl+C cancellation. Works against OpenAI and Ollama's OpenAI-compatible endpoint.

$script:HttpClient = $null
$script:OpenAIBase = 'https://api.openai.com/v1'

function Get-SenseiHttpClient {
    if (-not $script:HttpClient) {
        $script:HttpClient = [System.Net.Http.HttpClient]::new()
        $script:HttpClient.Timeout = [TimeSpan]::FromSeconds(600)
    }
    return $script:HttpClient
}

function Invoke-OpenAIRequest {
    # One non-streaming HTTP round-trip. Returns @{ Status; Body; RetryAfter }.
    # Throws on transport failure; throws OperationCanceledException on Ctrl+C.
    param(
        [string]$Method,
        [string]$Url,
        [string]$JsonBody,
        [string]$ApiKey,
        [switch]$NoSpinner,
        [string]$Label = 'thinking…'
    )
    $client = Get-SenseiHttpClient
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
    $cts = [System.Threading.CancellationTokenSource]::new()
    try {
        $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiKey)
        if ($JsonBody) {
            $req.Content = [System.Net.Http.StringContent]::new($JsonBody, [System.Text.Encoding]::UTF8, 'application/json')
        }
        $task = $client.SendAsync($req, $cts.Token)
        if ($NoSpinner) {
            try { [void]$task.Wait() } catch { }
        } else {
            Invoke-CancellableWait -Task $task -Cts $cts -Label $Label
        }
        $resp = $task.GetAwaiter().GetResult()
        try {
            $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $retryAfter = $null
            if ($resp.Headers.RetryAfter -and $resp.Headers.RetryAfter.Delta) {
                $retryAfter = $resp.Headers.RetryAfter.Delta.TotalSeconds
            }
            return @{ Status = [int]$resp.StatusCode; Body = $body; RetryAfter = $retryAfter }
        } finally {
            $resp.Dispose()
        }
    } finally {
        $req.Dispose()
        $cts.Dispose()
    }
}

# --- SSE accumulation (pure, unit-testable) ---------------------------------

function New-SseAccumulator {
    return @{
        Content = [System.Text.StringBuilder]::new()
        Acc     = @{}      # tool-call fragments keyed by index
        Usage   = $null
        Finish  = $null
    }
}

function Add-SseLine {
    # Feed one raw SSE line. Returns @{ Done; ContentDelta }.
    param([hashtable]$A, [string]$Line)
    $r = @{ Done = $false; ContentDelta = $null }
    if ($null -eq $Line -or -not $Line.StartsWith('data:')) { return $r }
    $data = $Line.Substring(5).Trim()
    if ($data -eq '[DONE]') { $r.Done = $true; return $r }
    $chunk = $null
    try { $chunk = $data | ConvertFrom-Json -AsHashtable } catch { return $r }
    if ($chunk.usage) { $A.Usage = $chunk.usage }
    if (-not $chunk.choices -or @($chunk.choices).Count -eq 0) { return $r }
    $ch = $chunk.choices[0]
    if ($ch.finish_reason) { $A.Finish = $ch.finish_reason }
    $delta = $ch.delta
    if ($null -eq $delta) { return $r }
    if ($null -ne $delta.content -and $delta.content -ne '') {
        [void]$A.Content.Append([string]$delta.content)
        $r.ContentDelta = [string]$delta.content
    }
    if ($delta.tool_calls) {
        foreach ($frag in @($delta.tool_calls)) {
            $idx = [int]($frag.index ?? 0)
            if (-not $A.Acc.ContainsKey($idx)) {
                $A.Acc[$idx] = @{ id = $null; name = $null; args = [System.Text.StringBuilder]::new() }
            }
            if ($frag.id) { $A.Acc[$idx].id = [string]$frag.id }
            if ($frag.function) {
                if ($frag.function.name) { $A.Acc[$idx].name = [string]$frag.function.name }
                if ($null -ne $frag.function.arguments) { [void]$A.Acc[$idx].args.Append([string]$frag.function.arguments) }
            }
        }
    }
    return $r
}

function Complete-SseAccumulator {
    # Synthesize the non-streaming response shape from accumulated deltas.
    param([hashtable]$A)
    $toolCalls = $null
    if ($A.Acc.Count -gt 0) {
        $toolCalls = @(foreach ($idx in ($A.Acc.Keys | Sort-Object)) {
            $e = $A.Acc[$idx]
            @{ id = $e.id; type = 'function'; function = @{ name = $e.name; arguments = $e.args.ToString() } }
        })
    }
    $content = if ($A.Content.Length -gt 0) { $A.Content.ToString() } else { $null }
    if ($content) { $content = [regex]::Replace($content, '(?s)<think>.*?</think>\s*', '') }
    if ($content -eq '') { $content = $null }
    $finish = $A.Finish
    if (-not $finish) { $finish = if ($toolCalls) { 'tool_calls' } else { 'stop' } }
    return @{
        choices   = @(@{ message = @{ role = 'assistant'; content = $content; tool_calls = $toolCalls }; finish_reason = $finish })
        usage     = $A.Usage
        _streamed = $true
    }
}

# --- streaming request ------------------------------------------------------

function Invoke-OpenAIStreamRequest {
    # Returns the synthesized response (with _streamed/_printed), or
    # @{ HttpError = @{Status;Body;RetryAfter} } on a non-200 (nothing rendered yet).
    # Throws OperationCanceledException on Ctrl+C; other exceptions = transport failure.
    param([string]$Url, [string]$Json, [string]$Key, [string]$Label = 'thinking…')
    $client = Get-SenseiHttpClient
    $cts = [System.Threading.CancellationTokenSource]::new()
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Url)
    $resp = $null
    $sr = $null
    $canKeys = -not [Console]::IsInputRedirected
    $canSpin = -not [Console]::IsOutputRedirected
    $prevCC = $null
    try {
        $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Key)
        $req.Content = [System.Net.Http.StringContent]::new($Json, [System.Text.Encoding]::UTF8, 'application/json')
        $sendTask = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token)
        Invoke-CancellableWait -Task $sendTask -Cts $cts -Label $Label
        $resp = $sendTask.GetAwaiter().GetResult()
        if ([int]$resp.StatusCode -ne 200) {
            $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $retryAfter = $null
            if ($resp.Headers.RetryAfter -and $resp.Headers.RetryAfter.Delta) {
                $retryAfter = $resp.Headers.RetryAfter.Delta.TotalSeconds
            }
            return @{ HttpError = @{ Status = [int]$resp.StatusCode; Body = $body; RetryAfter = $retryAfter } }
        }
        $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $sr = [System.IO.StreamReader]::new($stream)
        $acc = New-SseAccumulator
        $renderer = New-StreamRenderer
        $st = @{ Printed = $false; I = 0 }
        $frames = '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'
        if ($canKeys) {
            while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
            $prevCC = [Console]::TreatControlCAsInput
            [Console]::TreatControlCAsInput = $true
        }
        $tick = if ($canSpin) {
            { if (-not $st.Printed) {
                $label = if ($acc.Acc.Count -gt 0) { 'calling tools…' } else { $Label }
                Write-Host -NoNewline "`r$($script:Theme.Accent)$($frames[$st.I % $frames.Count]) $label$($script:Theme.Reset)"
                $st.I++
            } }
        } else { $null }
        while ($true) {
            $lineTask = $sr.ReadLineAsync()
            Wait-SenseiTask -Task $lineTask -Cts $cts -OnTick $tick
            $line = $lineTask.GetAwaiter().GetResult()
            if ($null -eq $line) { break }
            $d = Add-SseLine -A $acc -Line $line
            if ($d.Done) { break }
            if ($d.ContentDelta) {
                if (-not $st.Printed) {
                    if ($canSpin) { Write-Host -NoNewline ("`r" + (' ' * 20) + "`r") }
                    Write-Host ''
                    $st.Printed = $true
                }
                Write-StreamDelta -R $renderer -Text $d.ContentDelta
            }
        }
        if ($st.Printed) { Complete-StreamRender -R $renderer }
        elseif ($canSpin) { Write-Host -NoNewline ("`r" + (' ' * 20) + "`r") }
        $result = Complete-SseAccumulator -A $acc
        $result._printed = $st.Printed
        return $result
    } finally {
        if ($null -ne $prevCC) { [Console]::TreatControlCAsInput = $prevCC }
        if ($sr) { $sr.Dispose() }
        if ($resp) { $resp.Dispose() }
        $req.Dispose()
        $cts.Dispose()
    }
}

# --- main chat entry --------------------------------------------------------

function Invoke-OpenAIChat {
    # Full chat call with retry/backoff. Returns the parsed response hashtable,
    # or @{ Aborted = $true } on Ctrl+C; throws user-readable errors otherwise.
    param(
        $Messages,
        $ToolSpecs,
        [switch]$AllowStream,
        [string]$SpinnerLabel = 'thinking…'
    )

    if ($script:LocalMode) {
        $key = 'ollama'   # Ollama ignores auth, but the header must be present
        $url = ([string]$script:Config.local_base_url).TrimEnd('/') + '/chat/completions'
    } else {
        $key = Get-OpenAIApiKey
        if (-not $key) { throw 'No OpenAI API key configured. Set OPENAI_API_KEY or delete ~/.sensei/config.json to rerun setup.' }
        $url = "$script:OpenAIBase/chat/completions"
    }

    $useStream = $AllowStream -and [bool]$script:Config.stream -and -not [Console]::IsOutputRedirected

    $body = @{
        model    = Get-ActiveModel
        messages = @($Messages)
    }
    if ($script:LocalMode) { $body.max_tokens = [int]$script:Config.max_output_tokens }
    else { $body.max_completion_tokens = [int]$script:Config.max_output_tokens }
    if ($ToolSpecs -and @($ToolSpecs).Count -gt 0) { $body.tools = @($ToolSpecs) }
    if ($useStream) {
        $body.stream = $true
        $body.stream_options = @{ include_usage = $true }
    }
    $json = ConvertTo-Json -InputObject $body -Depth 30

    $maxAttempts = 5
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $r = $null
        if ($useStream) {
            try {
                $s = Invoke-OpenAIStreamRequest -Url $url -Json $json -Key $key -Label $SpinnerLabel
            } catch [System.OperationCanceledException] {
                return @{ Aborted = $true }
            } catch {
                if ($script:LocalMode) {
                    throw "Couldn't reach Ollama at $($script:Config.local_base_url): $($_.Exception.Message)`nIs Ollama running? Start the Ollama app (or 'ollama serve') and make sure '$(Get-ActiveModel)' is pulled."
                }
                if ($attempt -eq $maxAttempts) { throw "Streaming error talking to OpenAI: $($_.Exception.Message)" }
                Start-Sleep -Seconds ([Math]::Min(60, [Math]::Pow(2, $attempt)))
                continue
            }
            if (-not $s.HttpError) { return $s }
            $r = $s.HttpError
        } else {
            try {
                $r = Invoke-OpenAIRequest -Method 'POST' -Url $url -JsonBody $json -ApiKey $key -Label $SpinnerLabel
            } catch [System.OperationCanceledException] {
                return @{ Aborted = $true }
            } catch {
                if ($script:LocalMode) {
                    throw "Couldn't reach Ollama at $($script:Config.local_base_url): $($_.Exception.Message)`nIs Ollama running? Start the Ollama app (or 'ollama serve') and make sure '$(Get-ActiveModel)' is pulled."
                }
                if ($attempt -eq $maxAttempts) { throw "Network error talking to OpenAI: $($_.Exception.Message)" }
                $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
                Write-SenseiNote "network error ($($_.Exception.Message)); retrying in $([int]$delay)s ($attempt/$maxAttempts)…"
                Start-Sleep -Seconds $delay
                continue
            }
            if ($r.Status -eq 200) {
                return $r.Body | ConvertFrom-Json -AsHashtable
            }
        }

        if ($r.Status -in 429, 500, 502, 503 -and $attempt -lt $maxAttempts) {
            $delay = if ($r.RetryAfter) { [double]$r.RetryAfter }
                     else { [Math]::Min(60, [Math]::Pow(2, $attempt)) + (Get-Random -Minimum 0.0 -Maximum 1.0) }
            Write-SenseiNote "API returned $($r.Status); retrying in $([int]$delay)s ($attempt/$maxAttempts)…"
            Start-Sleep -Seconds $delay
            continue
        }

        $errMsg = try { ($r.Body | ConvertFrom-Json -AsHashtable).error.message } catch { $r.Body }
        if ($r.Status -eq 401) {
            throw "OpenAI rejected the API key (401): $errMsg`nFix OPENAI_API_KEY (or delete ~/.sensei/config.json to rerun setup)."
        }
        throw "API error $($r.Status): $errMsg"
    }
}

function Test-OpenAIKey {
    param([string]$Key)
    try {
        $r = Invoke-OpenAIRequest -Method 'GET' -Url "$script:OpenAIBase/models" -ApiKey $Key -NoSpinner
        return $r.Status -eq 200
    } catch {
        return $false
    }
}
