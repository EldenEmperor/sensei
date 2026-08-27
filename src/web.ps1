# web.ps1 — web_fetch, web_search, web_browser and their shared helpers.

# --- shared: HTML → readable text + link extraction ------------------------

function ConvertFrom-SenseiHtml {
    param([string]$Html)
    # strip non-content blocks first, then structure → newlines, tags → space
    $t = $Html -replace '(?is)<(script|style|noscript|nav|header|footer|aside|form|svg)\b.*?</\1\s*>', ' '
    $t = $t -replace '(?is)<!--.*?-->', ' '
    $t = $t -replace '(?i)<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article|/ul|/ol)[^>]*>', "`n"
    $t = $t -replace '<[^>]+>', ' '
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $t = $t -replace '[ \t]+', ' '
    $lines = $t -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    # collapse 3+ blank runs (already filtered empties, so just join)
    return ($lines -join "`n")
}

function Get-SenseiLinks {
    # Absolute, de-duplicated http(s) links found in the HTML, resolved vs $BaseUrl.
    param([string]$Html, [string]$BaseUrl, [int]$Max = 30)
    $base = $null
    try { $base = [Uri]$BaseUrl } catch { }
    $seen = [System.Collections.Generic.List[string]]::new()
    $set = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($m in [regex]::Matches($Html, '(?i)<a\b[^>]*?href\s*=\s*["'']([^"''#]+)["'']')) {
        $href = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value).Trim()
        if (-not $href -or $href -match '^(javascript|mailto|tel):') { continue }
        $abs = $href
        if ($href -notmatch '^https?://') {
            if ($base) { try { $abs = [Uri]::new($base, $href).AbsoluteUri } catch { continue } } else { continue }
        }
        if ($abs -notmatch '^https?://') { continue }
        if ($set.Add($abs)) { $seen.Add($abs); if ($seen.Count -ge $Max) { break } }
    }
    return $seen
}

function Format-SenseiPage {
    # Turn raw content + content-type into the tool result: readable text plus a
    # links section for HTML. Used by both web_fetch and web_browser.
    param([string]$Content, [string]$ContentType, [string]$Url, [switch]$IsDom)
    $isHtml = $IsDom -or $ContentType -like '*html*' -or $Content -match '(?i)<html|<!doctype html'
    if ($ContentType -like '*json*') {
        try { return ($Content | ConvertFrom-Json | ConvertTo-Json -Depth 12) } catch { return $Content }
    }
    if (-not $isHtml) { return $Content }   # text/plain, csv, etc.
    $text = ConvertFrom-SenseiHtml $Content
    $links = Get-SenseiLinks -Html $Content -BaseUrl $Url
    if ($links.Count -gt 0) {
        $text += "`n`n--- Links found ($($links.Count)) ---`n" + ($links -join "`n")
    }
    if (-not $text.Trim()) { return "(no readable text at $Url)" }
    return $text
}

function Invoke-SenseiHttpGet {
    # GET with the shared HttpClient, spinner+Ctrl+C. Returns @{ Ok; Status; Body; ContentType; FinalUrl } or throws OperationCanceled.
    param([string]$Url, [int]$TimeoutMs = 30000, [string]$Label = 'fetching…', [hashtable]$Headers)
    $client = Get-SenseiHttpClient
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
    $cts = [System.Threading.CancellationTokenSource]::new($TimeoutMs)
    try {
        $req.Headers.UserAgent.ParseAdd("sensei/$script:SenseiVersion")
        if ($Headers) { foreach ($k in $Headers.Keys) { [void]$req.Headers.TryAddWithoutValidation([string]$k, [string]$Headers[$k]) } }
        $task = $client.SendAsync($req, $cts.Token)
        Invoke-CancellableWait -Task $task -Cts $cts -Label $Label
        $resp = $task.GetAwaiter().GetResult()
        try {
            $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($body.Length -gt 3MB) { $body = $body.Substring(0, 3MB) }
            $ct = ''
            if ($resp.Content.Headers.ContentType) { $ct = [string]$resp.Content.Headers.ContentType.MediaType }
            $final = $Url
            if ($resp.RequestMessage -and $resp.RequestMessage.RequestUri) { $final = $resp.RequestMessage.RequestUri.AbsoluteUri }
            return @{ Ok = $resp.IsSuccessStatusCode; Status = [int]$resp.StatusCode; Body = $body; ContentType = $ct; FinalUrl = $final }
        } finally { $resp.Dispose() }
    } finally {
        $req.Dispose(); $cts.Dispose()
    }
}

# --- web_fetch --------------------------------------------------------------

Register-SenseiTool -Name 'web_fetch' -ReadOnly $true -PrimaryArg 'url' `
    -Description 'Fetch an http(s) URL and return its content as readable text (HTML stripped, JSON pretty-printed), followed by the links found on the page so you can follow onward. Use to read documentation, referenced pages, and error-message lookups.' `
    -Parameters @{
        type       = 'object'
        properties = @{ url = @{ type = 'string' } }
        required   = @('url')
    } -Handler {
        param($a)
        $url = [string]$a.url
        if ($url -notmatch '^https?://') { return 'ERROR: only http(s) URLs are supported' }
        try {
            $r = Invoke-SenseiHttpGet -Url $url
            if (-not $r.Ok) { return "ERROR: HTTP $($r.Status) from $url" }
            return Format-SenseiPage -Content $r.Body -ContentType $r.ContentType -Url $r.FinalUrl
        } catch [System.OperationCanceledException] {
            return "ERROR: fetch of $url timed out or was aborted"
        } catch {
            return "ERROR: $($_.Exception.Message)"
        }
    }

# --- web_search (DuckDuckGo HTML endpoint; no API key, works in --local) ----
# NOTE: this scrapes DuckDuckGo's HTML results. It is inherently brittle — if
# results stop parsing, DDG changed its markup and the regexes below need updating.

function ConvertFrom-DdgResults {
    param([string]$Html, [int]$Max = 8)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($m in [regex]::Matches($Html, '(?is)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>')) {
        $href = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
        # DDG wraps links as /l/?...&uddg=<encoded real url>
        $um = [regex]::Match($href, 'uddg=([^&]+)')
        if ($um.Success) { $href = [Uri]::UnescapeDataString($um.Groups[1].Value) }
        elseif ($href -match '^//') { $href = 'https:' + $href }
        $title = ([System.Net.WebUtility]::HtmlDecode(($m.Groups[2].Value -replace '<[^>]+>', ''))).Trim()
        if ($title -and $href -match '^https?://') {
            $out.Add(@{ Title = $title; Url = $href })
            if ($out.Count -ge $Max) { break }
        }
    }
    # snippets, in document order, paired positionally
    $snips = [System.Collections.Generic.List[string]]::new()
    foreach ($m in [regex]::Matches($Html, '(?is)class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>')) {
        $snips.Add(([System.Net.WebUtility]::HtmlDecode(($m.Groups[1].Value -replace '<[^>]+>', ''))).Trim())
    }
    for ($i = 0; $i -lt $out.Count; $i++) { $out[$i].Snippet = if ($i -lt $snips.Count) { $snips[$i] } else { '' } }
    return $out
}

Register-SenseiTool -Name 'web_search' -ReadOnly $true -PrimaryArg 'query' `
    -Description 'Search the web (DuckDuckGo) and return the top results as title + URL + snippet. Use to FIND sources when you do not already have a link; then web_fetch the promising ones.' `
    -Parameters @{
        type       = 'object'
        properties = @{
            query = @{ type = 'string' }
            top   = @{ type = 'integer'; description = 'How many results (default 8)' }
        }
        required   = @('query')
    } -Handler {
        param($a)
        $q = [string]$a.query
        if (-not $q) { return 'ERROR: query is required' }
        $top = [Math]::Max(1, [int]($a.top ?? 8))
        $url = 'https://html.duckduckgo.com/html/?q=' + [Uri]::EscapeDataString($q)
        try {
            $r = Invoke-SenseiHttpGet -Url $url -Label 'searching…' -Headers @{ Accept = 'text/html' }
            if (-not $r.Ok) { return "ERROR: search returned HTTP $($r.Status)" }
            $results = @(ConvertFrom-DdgResults -Html $r.Body -Max $top)
            if ($results.Count -eq 0) {
                return "(no results parsed for '$q' — DuckDuckGo may have changed its markup or rate-limited. Raw text follows.)`n" + (ConvertFrom-SenseiHtml $r.Body).Substring(0, [Math]::Min(1500, (ConvertFrom-SenseiHtml $r.Body).Length))
            }
            $sb = [System.Text.StringBuilder]::new()
            [void]$sb.AppendLine("[web_search '$q' — top $($results.Count)]")
            $i = 1
            foreach ($res in $results) {
                [void]$sb.AppendLine("$i. $($res.Title)`n   $($res.Url)")
                if ($res.Snippet) { [void]$sb.AppendLine("   $($res.Snippet)") }
                $i++
            }
            return $sb.ToString()
        } catch [System.OperationCanceledException] {
            return 'ERROR: search timed out or was aborted'
        } catch {
            return "ERROR: $($_.Exception.Message)"
        }
    }

# --- web_browser (headless Edge/Chrome for JS-rendered pages) ---------------

function Find-SenseiBrowser {
    foreach ($name in 'msedge', 'chrome') {
        $c = Get-Command $name -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    return $null
}

Register-SenseiTool -Name 'web_browser' -ReadOnly $true -PrimaryArg 'url' `
    -Description 'Render an http(s) page in a headless browser (Edge/Chrome) so JavaScript runs, then return the rendered text + links. Use when web_fetch returns little because the page needs JS. Optional screenshot=true saves a PNG for the USER to open (it is not shown to you — you read the text).' `
    -Parameters @{
        type       = 'object'
        properties = @{
            url        = @{ type = 'string' }
            screenshot = @{ type = 'boolean'; description = 'Also save a PNG to ~/.sensei/screenshots (default false)' }
        }
        required   = @('url')
    } -Handler {
        param($a)
        $url = [string]$a.url
        if ($url -notmatch '^https?://') { return 'ERROR: only http(s) URLs are supported' }
        $browser = Find-SenseiBrowser
        if (-not $browser) { return 'ERROR: no headless browser found (Edge/Chrome). Use web_fetch instead for non-JS pages.' }

        $shotNote = ''
        $args = @('--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions')
        if ([bool]($a.screenshot ?? $false)) {
            $shotDir = Join-Path $script:ConfigDir 'screenshots'
            if (-not (Test-Path -LiteralPath $shotDir)) { New-Item -ItemType Directory -Force -Path $shotDir | Out-Null }
            $shot = Join-Path $shotDir ("shot-{0}.png" -f ([Guid]::NewGuid().ToString('n').Substring(0, 8)))
            $args += @("--screenshot=$shot", '--window-size=1280,1600', '--hide-scrollbars')
            $shotNote = "`n[screenshot saved for you to open: $shot]"
        }
        $args += @('--dump-dom', $url)

        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $browser
        foreach ($x in $args) { $psi.ArgumentList.Add([string]$x) }
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $p = [System.Diagnostics.Process]::Start($psi)
        try {
            $outTask = $p.StandardOutput.ReadToEndAsync()
            [void]$p.StandardError.ReadToEndAsync()
            if (-not $p.WaitForExit(45000)) {
                try { $p.Kill($true) } catch { }
                return "ERROR: browser render of $url timed out (45s)"
            }
            $p.WaitForExit()
            $dom = $outTask.GetAwaiter().GetResult()
            if (-not $dom.Trim()) { return "ERROR: browser returned no DOM for $url$shotNote" }
            if ($dom.Length -gt 3MB) { $dom = $dom.Substring(0, 3MB) }
            return (Format-SenseiPage -Content $dom -ContentType 'text/html' -Url $url -IsDom) + $shotNote
        } finally {
            $p.Dispose()
        }
    }
