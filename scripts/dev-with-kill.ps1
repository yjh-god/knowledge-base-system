param(
    [int[]]$Ports = @(3001, 5173, 8902),
    [switch]$StopQdrant
)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Stop-ListeningPorts {
    param([int[]]$PortsToStop)

    foreach ($port in $PortsToStop) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($null -eq $conns) {
            Write-Host ("port " + $port + " not listening, skip")
            continue
        }

        $procIds = @($conns | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
        if ($procIds.Count -gt 0) {
            $procIdsJoined = ($procIds -join ", ")
            Write-Host ("stopping port " + $port + " occupiedBy=[" + $procIdsJoined + "]")
            foreach ($procId in $procIds) {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

if ($StopQdrant) {
    Write-Host "stopping qdrant port 6333..."
    Stop-ListeningPorts -PortsToStop @(6333)
}

Write-Host ("stopping dev ports: " + ($Ports -join ", "))
Stop-ListeningPorts -PortsToStop $Ports

Write-Host "starting dev services..."

# Use local concurrently; npx should not download anything if already present.
npx concurrently -k -n backend,frontend,embedding -c blue,magenta,green "npm run dev --prefix backend" "npm run dev --prefix frontend" "python embedding_server.py"

