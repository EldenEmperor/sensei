# PowerShell script to fetch hardware specs

# CPU Info
Get-WmiObject -Class Win32_Processor | Select-Object Name, NumberOfCores, MaxClockSpeed, L2CacheSize, Manufacturer

# GPU Info
Get-WmiObject -Class Win32_VideoController | Select-Object Name, DriverVersion, VideoMemoryType, AdapterRAM

# RAM Info
Get-WmiObject -Class Win32_ComputerSystem | Select-Object TotalPhysicalMemory, Manufacturer, Model

# Motherboard Info (requires admin)
Get-WmiObject -Class Win32_BaseBoard | Select-Object Product, Manufacturer