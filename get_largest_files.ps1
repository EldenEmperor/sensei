# PowerShell script to find largest files on a drive

param (
    [string]$DriveLetter = "E",
    [int]$TopResults = 10
)

$drivePath = "$DriveLetter:\"

Write-Host "Scanning $drivePath for largest files..."

Get-ChildItem -Path $drivePath -Recurse -File -ErrorAction SilentlyContinue | 
Sort-Object Length -Descending | 
Select-Object -First $TopResults | 
Select-Object -Property Fullname,Length | 
Format-List