# 本脚本暂停运行中的项目，只重启目标端口上的 GoalHub 后端，并验证启动结果。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendPort = 3210
if ($env:PORT) {
    if (-not [int]::TryParse($env:PORT, [ref]$backendPort) -or $backendPort -lt 1 -or $backendPort -gt 65535) {
        throw 'PORT 必须为 1–65535 的整数。'
    }
}
$backendUrl = "http://127.0.0.1:$backendPort"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodePath --version).TrimStart('v').Split('.')[0]
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 24) { throw '需要 Node.js 24 或更新版本。' }

# Get-BackendListener 查询指定端口的监听进程，避免停止其他 Node.js 服务。
function Get-BackendListener {
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $backendPort)
}

try {
    $listeners = @(Get-BackendListener)
    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($processIds.Count -gt 1) { throw "端口 $backendPort 有多个监听进程，请先检查端口占用。" }
    if ($processIds.Count -eq 1) {
        $backendProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($processIds[0])"
        if ($backendProcess.Name -ne 'node.exe' -or $backendProcess.CommandLine -notmatch '(?i)(?:^|[\\/\s"])server\.mjs(?:"|\s|$)') {
            throw "端口 $backendPort 被其他程序占用，未停止该程序。"
        }
        $status = Invoke-RestMethod "$backendUrl/api/status" -TimeoutSec 10
        if (-not $status.runtime -or $null -eq $status.activeProjects -or -not $status.node) {
            throw '无法确认端口上的服务是 GoalHub，未停止该程序。'
        }
        foreach ($projectId in $status.activeProjects) {
            Write-Host "暂停项目 $projectId，保存执行进度……"
            $null = Invoke-RestMethod "$backendUrl/api/projects/$projectId/pause" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 120
        }
        # Windows 不支持向普通后台 Node 进程发送 SIGTERM；暂停完成后回收其进程树。
        Write-Host "停止后端进程 $($backendProcess.ProcessId)……"
        & taskkill.exe /PID $backendProcess.ProcessId /T /F | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '停止后端失败。' }
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (@(Get-BackendListener).Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        }
        if (@(Get-BackendListener).Count) { throw '后端端口尚未释放。' }
    }

    # 后台启动并保留标准输出与错误日志，双击入口退出后服务仍可使用。
    $logDirectory = Join-Path $projectRoot 'output\backend'
    $null = New-Item -ItemType Directory -Path $logDirectory -Force
    $logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutPath = Join-Path $logDirectory "$logStamp.stdout.log"
    $stderrPath = Join-Path $logDirectory "$logStamp.stderr.log"
    $serverPath = Join-Path $projectRoot 'server.mjs'
    $startedProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        $startedProcess.Refresh()
        if ($startedProcess.HasExited) { throw "后端启动失败：$(Get-Content -LiteralPath $stderrPath -Raw)" }
        try { $status = Invoke-RestMethod "$backendUrl/api/status" -TimeoutSec 2 } catch { continue }
        if ($status.runtime -and $status.node -and @(Get-BackendListener | Where-Object OwningProcess -eq $startedProcess.Id).Count) {
            Write-Host "后端已启动：$backendUrl（PID $($startedProcess.Id)）"
            Write-Host "日志：$logDirectory"
            Write-Host '已暂停的项目可在页面点击“继续执行”。'
            exit 0
        }
    }
    throw "启动检查超时，请查看 $stderrPath；新进程 PID：$($startedProcess.Id)。"
} catch {
    Write-Host "重启失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
