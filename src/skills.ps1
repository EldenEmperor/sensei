# skills.ps1 — Claude Code-style skills: packaged instruction sets in
# .sensei\skills\<name>\SKILL.md (project) or ~/.sensei/skills/<name>/SKILL.md (user).
# The model discovers them through the `skill` tool (its description lists every
# skill); users invoke them directly as /<name>. Project shadows user on collisions.

function Read-SenseiSkillFile {
    # Parse SKILL.md: optional frontmatter (--- ... ---) with name:/description:,
    # body = everything after. Hand-rolled — no YAML dependency.
    param([string]$Path)
    $lines = @(Get-Content -LiteralPath $Path)
    $name = $null
    $desc = ''
    $bodyStart = 0
    if ($lines.Count -gt 0 -and $lines[0].Trim() -eq '---') {
        for ($i = 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i].Trim() -eq '---') { $bodyStart = $i + 1; break }
            if ($lines[$i] -match '^name:\s*(.+)$') { $name = $Matches[1].Trim().Trim('"').Trim("'") }
            elseif ($lines[$i] -match '^description:\s*(.+)$') { $desc = $Matches[1].Trim().Trim('"').Trim("'") }
        }
    }
    $body = if ($bodyStart -lt $lines.Count) { ($lines[$bodyStart..($lines.Count - 1)] -join "`n").Trim() } else { '' }
    return @{ Name = $name; Description = $desc; Body = $body }
}

function Get-SenseiSkills {
    $skills = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $sources = @(
        @{ Dir = Join-Path (Get-Location).Path '.sensei\skills'; Source = 'project' }
        @{ Dir = Join-Path $script:ConfigDir 'skills'; Source = 'user' }
    )
    foreach ($src in $sources) {
        if (-not (Test-Path -LiteralPath $src.Dir)) { continue }
        foreach ($d in Get-ChildItem -LiteralPath $src.Dir -Directory) {
            $p = Join-Path $d.FullName 'SKILL.md'
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
            $meta = $null
            try { $meta = Read-SenseiSkillFile $p } catch { continue }
            $name = if ($meta.Name) { $meta.Name } else { $d.Name }
            if (-not $seen.Add($name.ToLower())) { continue }   # project scanned first → wins
            $skills.Add(@{ Name = $name; Description = $meta.Description; Dir = $d.FullName; Path = $p; Source = $src.Source })
        }
    }
    return @($skills)
}

function Get-SenseiSkillPrompt {
    # The prompt submitted when a user invokes /<skillname> args.
    param([hashtable]$Skill, [string]$Arguments = '')
    $body = (Read-SenseiSkillFile $Skill.Path).Body
    $hadPlaceholder = $body -match '\$ARGUMENTS'
    $body = $body -replace '\$ARGUMENTS', $Arguments
    $p = "# Skill: $($Skill.Name)`n(Supporting files for this skill live in $($Skill.Dir) — reference them by full path; scripts there can be run with run_powershell.)`n`n$body"
    if ($Arguments -and -not $hadPlaceholder) { $p += "`n`nUser input: $Arguments" }
    return $p
}

function Register-SenseiSkillTool {
    # (Re)build the `skill` tool from the current skill set. Cheap — called at
    # startup and at each turn start so mid-session skill creation is picked up.
    $skills = @(Get-SenseiSkills)
    if ($skills.Count -eq 0) {
        if ($script:ToolRegistry.Contains('skill')) { $script:ToolRegistry.Remove('skill') }
        return
    }
    $list = ($skills | ForEach-Object { "- $($_.Name): $($_.Description)" }) -join "`n"
    Register-SenseiTool -Name 'skill' -ReadOnly $true `
        -Description "Load a skill — packaged instructions for a specialized task. Invoke it when the user's request matches a skill's description, BEFORE attempting the task yourself. Available skills:`n$list" `
        -Parameters @{
            type       = 'object'
            properties = @{ name = @{ type = 'string'; description = 'Skill name, exactly as listed' } }
            required   = @('name')
        } -Handler {
            param($a)
            $skills = @(Get-SenseiSkills)
            $s = $skills | Where-Object { $_.Name -eq [string]$a.name } | Select-Object -First 1
            if (-not $s) {
                return "ERROR: no skill named '$($a.name)' — available: $(($skills | ForEach-Object { $_.Name }) -join ', ')"
            }
            $body = (Read-SenseiSkillFile $s.Path).Body
            return "# Skill: $($s.Name)`n(Supporting files for this skill live in $($s.Dir) — reference them by full path; scripts there can be run with run_powershell.)`n`n$body"
        }
}
