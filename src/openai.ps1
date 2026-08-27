# openai.ps1 — OpenAI Chat Completions client: shared HttpClient, retries, spinner.

$script:HttpClient = $null
$script:OpenAIBase = 'https://api.openai.com/v1'

function Get-KakunaHttpClient {
    if (-not $script:HttpClient) {
        $script:HttpClient = [System.Net.Http.HttpClient]::new()
        $script:HttpClient.Timeout = [TimeSpan]::FromSeconds(600)
    }
    return $script:HttpClient
}

function Invoke-OpenAIRequest {
    # One HTTP round-trip. Returns @{ Status; Body; RetryAfter } and only
    # throws on transport-level failure (DNS, timeout, connection reset).
    param(
        [string]$Method,
        [string]$Url,
        [string]$JsonBody,
        [string]$ApiKey,
        [switch]$NoSpinner
    )
    $client = Get-KakunaHttpClient
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
    try {
        $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiKey)
        if ($JsonBody) {
            $req.Content = [System.Net.Http.StringContent]::new($JsonBody, [System.Text.Encoding]::UTF8, 'application/json')
        }
        $task = $client.SendAsync($req)
        if ($NoSpinner) {
            [void]([System.IAsyncResult]$task).AsyncWaitHandle.WaitOne()
        } else {
            Invoke-WithSpinner -Task $task
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
    }
}

function Invoke-OpenAIChat {
    # Full chat-completions call with retry/backoff. Returns the parsed
    # response hashtable; throws with a user-readable message on fatal errors.
    param($Messages, $ToolSpecs)

    if ($script:LocalMode) {
        $key = 'ollama'   # Ollama ignores auth, but the header must be present
        $url = ([string]$script:Config.local_base_url).TrimEnd('/') + '/chat/completions'
    } else {
        $key = Get-OpenAIApiKey
        if (-not $key) { throw 'No OpenAI API key configured. Set OPENAI_API_KEY or delete ~/.kakuna/config.json to rerun setup.' }
        $url = "$script:OpenAIBase/chat/completions"
    }

    $body = @{
        model    = Get-ActiveModel
        messages = @($Messages)
    }
    if ($script:LocalMode) { $body.max_tokens = [int]$script:Config.max_output_tokens }
    else { $body.max_completion_tokens = [int]$script:Config.max_output_tokens }
    if ($ToolSpecs -and @($ToolSpecs).Count -gt 0) { $body.tools = @($ToolSpecs) }
    $json = ConvertTo-Json -InputObject $body -Depth 30

    $maxAttempts = 5
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            $r = Invoke-OpenAIRequest -Method 'POST' -Url $url -JsonBody $json -ApiKey $key
        } catch {
            if ($script:LocalMode) {
                throw "Couldn't reach Ollama at $($script:Config.local_base_url): $($_.Exception.Message)`nIs Ollama running? Start the Ollama app (or 'ollama serve') and make sure '$(Get-ActiveModel)' is pulled."
            }
            if ($attempt -eq $maxAttempts) { throw "Network error talking to OpenAI: $($_.Exception.Message)" }
            $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
            Write-KakunaNote "network error ($($_.Exception.Message)); retrying in $([int]$delay)s ($attempt/$maxAttempts)…"
            Start-Sleep -Seconds $delay
            continue
        }

        if ($r.Status -eq 200) {
            return $r.Body | ConvertFrom-Json -AsHashtable
        }

        if ($r.Status -in 429, 500, 502, 503 -and $attempt -lt $maxAttempts) {
            $delay = if ($r.RetryAfter) { [double]$r.RetryAfter }
                     else { [Math]::Min(60, [Math]::Pow(2, $attempt)) + (Get-Random -Minimum 0.0 -Maximum 1.0) }
            Write-KakunaNote "OpenAI returned $($r.Status); retrying in $([int]$delay)s ($attempt/$maxAttempts)…"
            Start-Sleep -Seconds $delay
            continue
        }

        $errMsg = try { ($r.Body | ConvertFrom-Json -AsHashtable).error.message } catch { $r.Body }
        if ($r.Status -eq 401) {
            throw "OpenAI rejected the API key (401): $errMsg`nFix OPENAI_API_KEY (or delete ~/.kakuna/config.json to rerun setup)."
        }
        throw "OpenAI API error $($r.Status): $errMsg"
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
