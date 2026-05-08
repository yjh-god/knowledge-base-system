# 重启应用：先释放常用开发端口，再执行根目录 npm run dev（前后端并行）
# 用法（在项目根目录）:
#   powershell -ExecutionPolicy Bypass -File .\重启应用.ps1
#   powershell -ExecutionPolicy Bypass -File .\重启应用.ps1 -StopQdrant

param(
    [int[]]$Ports = @(3001, 5173),
    [switch]$StopQdrant
)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Stop-ListeningPorts {
    param([int[]]$PortsToStop)

    foreach ($port in $PortsToStop) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($null -eq $conns) {
            Write-Host "[重启应用] 端口 $port 无监听，跳过。"
            continue
        }

        # 注意：不要用 $pid 作为循环变量——它与只读的自动变量 $PID（当前 Shell 进程）冲突，会导致结束错进程或未结束目标进程。
        $procIds = @($conns | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
        if ($procIds.Count -gt 0) {
            Write-Host "[重启应用] 端口 $port 占用进程: $($procIds -join ', ') ，正在结束..."
            foreach ($procId in $procIds) {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Milliseconds 800
            $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            if ($null -ne $still) {
                Write-Host "[重启应用] 警告: 端口 $port 仍有监听，请检查权限或其它服务占用。"
            }
        }
    }
}

if ($StopQdrant) {
    Write-Host "[重启应用] 将尝试结束 Qdrant 监听端口 6333..."
    Stop-ListeningPorts -PortsToStop @(6333)
}

Write-Host "[重启应用] 将尝试结束后端/前端开发端口: $($Ports -join ', ')..."
Stop-ListeningPorts -PortsToStop $Ports

Set-Location $Root
Write-Host "[重启应用] 当前目录: $Root"
Write-Host "[重启应用] 启动后自检: GET http://127.0.0.1:3001/health 的 data 应含 service=knowledge-base-backend 与 notFoundShape=json404；"
Write-Host "[重启应用] 任意不存在路径应返回 JSON（code:404），若仍为 HTML Cannot GET 则说明 3001 上不是本仓库最新后端进程。"
Write-Host "[重启应用] 正在执行 npm run dev ..."
npm run dev
