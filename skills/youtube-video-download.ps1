# youtube-video-download.ps1 — Download & extract audio from YouTube videos
#
# USAGE:  .\youtube-video-download.ps1 "<url_or_list_file>" [-Format mp3] [-Output .\audio]
#
# EXAMPLES:
#   # Download a single video as MP3
#   .\youtube-video-download.ps1 "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
#
#   # Download from a file that contains one URL per line (no file:// prefix needed — use -ListFile flag)
#   .\youtube-video-download.ps1 urls.txt -ListFile -Format m4a
#
#   # Specify output directory
#   .\youtube-video-download.ps1 "https://www.youtube.com/watch?v=abc" -Output D:\Music\yt
#
# FEATURES:
#   • Auto-detect single URL vs text file with multiple URLs
#   • Download only the audio stream (no heavy video)
#   • Convert to your chosen format (mp3, m4a, flac, opus)
#   • Skip files that already exist on disk
#   • Log everything for debugging


param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$InputPath,

    [ValidateSet("mp3","m4a","flac","opus","webm")]
    [string]$Format = "mp3",

    [string]$OutputDir,

    [switch]$ListFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────
function Fail { param([string]$Msg) Write-Error $Msg; exit 1 }
function Log  { param([string]$Msg) Write-Host "[yt-download] $Msg" }

# Find a working python with yt-dlp loaded
function Get-PythonWithYtDlp {
    foreach ($cmd in @("py -3.14", "py -3", "python")) {
        try {
            if ((&$cmd --version 2>&1) -match "Python") {
                $test = & $cmd -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>$null
                if ($LASTEXITCODE -eq 0) { Log "Found yt-dlp $($test.Trim()) via $cmd"; return "$cmd" }
                Write-Verbose "Python $cmd exists but no yt-dlp" -Verbose:$false
            }
        } catch {}
    }
    Fail "No installed Python + yt-dlp found.  Run: py -3 -m pip install --user yt-dlp"
}

function Test-FFmpegInstalled {
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Fail "ffmpeg missing — needed for audio format conversion.  https://www.gyan.dev/ffmpeg/builds/"
    }
    Log "ffmpeg found"
}

# ── Resolve input into a list of URLs ────────────────────────────────
function Get-Urls() {
    if ($ListFile) {
        if (-not (Test-Path $InputPath)) { Fail "List file not found: $InputPath" }
        $lines = (Get-Content $InputPath) -replace '^\s+|\s+$', '' | Where-Object { $_ -and $_ -notmatch '^#' }
        if (-not $lines) { Fail "List file is empty or has no YouTube URLs" }
        Log "Read $($lines.Count) URLs from list file"
        return $lines
    }

    # Single URL argument (may or may not be quoted)
    if ($InputPath -match '^https?://') {
        return @($InputPath)
    }

    # Treat as plain text file with one URL per line
    if (Test-Path $InputPath) {
        $lines = (Get-Content $InputPath) -replace '^\s+|\s+$', '' | Where-Object { $_ -and $_ -notmatch '^#' }
        if (-not $lines) { Fail "File is empty or has no YouTube URLs" }
        Log "Read $($lines.Count) URLs from file: $InputPath"
        return $lines
    }

    Fail "Could not resolve input.  Pass a URL, a .txt list, or use -ListFile for an explicit text-file."
}

# ── Main ─────────────────────────────────────────────────────────────
Log "Starting YouTube audio downloader"

$py = Get-PythonWithYtDlp
Test-FFmpegInstalled

if (-not $OutputDir) { $OutputDir = Join-Path (Resolve-Path $PWD).ProviderPath "\youtube_downloads" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path $OutputDir).ProviderPath  # normalise
Log "Output directory: $OutputDir"

$urls = Get-Urls

$template = "$OutputDir\%(title)s.%(ext)s"
$logFile  = Join-Path $OutputDir "download_log.txt"

# Build the yt-dlp command arguments
$args = @(
    '-x',                     # extract audio only
    '--audio-format', $Format,
    '--audio-quality', 0,     # best quality
    '-o', "`"$template`"",
    '--embed-thumbnail',
    '--no-playlist',          # treat playlists as single video (use without for full playlist)
    '--retry', 3,
    '--continue',             # resume partial downloads
    '--no-overwrites'         # skip already-downloaded files
)

Log "Downloading $($urls.Count) video(s), format=$Format ..."

# yt-dlp accepts multiple URLs; pass them all at once for best efficiency
$allArgs = $args + @( "'"+ $urls -join "', '" + "'" )
$fullCmd = "$py -m yt_dlp $($allArgs -join ' ')"

Log "Command: $fullCmd"

try {
    Invoke-Expression "$fullCmd 2>&1 | Tee-Object -FilePath `"$logFile`""
} catch {
    Fail "yt-dlp failed — rc: $LASTEXITCODE.  Check log: $logFile"
}

if ($LASTEXITCODE -ne 0) {
    Write-Warning "yt-dlp exited with code $LASTEXITCODE; some downloads may have failed."
    Write-Warning "Log file: $logFile"
    exit 1
}

# Show what landed on disk
$files = Get-ChildItem "$OutputDir\*.$Format" -ErrorAction SilentlyContinue
if ($files) {
    Log "`nDownloaded $($files.Count) $( $Format.ToUpper() ) file(s):"
    $files | ForEach-Object { Write-Host "  $($_.Name)  $([math]::Round($_.Length/1MB,1)) MB" }
} else {
    Log "No files written in target format.  Check the log."
}

Log "Done — all files in: $OutputDir"
Log "Full log: $logFile"
