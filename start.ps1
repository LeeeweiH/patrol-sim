# ============================================================
#  一键启动：建虚拟环境 -> 装依赖 -> 起后端 -> 打开浏览器
#
#  用法（在仓库根目录）：
#    .\start.ps1                 默认 8080 端口，只允许本机访问
#    .\start.ps1 -Port 9000      换端口
#    .\start.ps1 -Lan            监听 0.0.0.0，同宿舍/同 Wi-Fi 的人也能访问
#    .\start.ps1 -NoBrowser      不自动开浏览器
#
#  按 Ctrl+C 停止服务。
# ============================================================
param(
  [int]$Port = 8080,
  [switch]$Lan,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "[*] $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "[+] $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "[!] $text" -ForegroundColor Yellow }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'

Write-Host ''
Write-Host '  智能巡检机器人 · 本地启动' -ForegroundColor White
Write-Host '  ------------------------------' -ForegroundColor DarkGray

if (-not (Test-Path (Join-Path $backend 'app\main.py'))) {
  Write-Bad "没找到 backend\app\main.py，确认这个脚本放在仓库根目录。"
  exit 1
}

# ---------- 1. 找 Python ----------
Write-Step '检查 Python'
$pythonCmd = $null
$pythonArgs = @()
foreach ($candidate in @(@('python'), @('py', '-3'))) {
  $exe = $candidate[0]
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  $prefix = @()
  if ($candidate.Length -gt 1) { $prefix = $candidate[1..($candidate.Length - 1)] }
  try {
    $raw = & $exe @prefix -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
  } catch {
    continue
  }
  if ($LASTEXITCODE -eq 0 -and $raw) {
    $parts = "$raw".Trim().Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -eq 3 -and $minor -ge 10) {
      $pythonCmd = $exe
      $pythonArgs = $prefix
      Write-Ok "Python $raw（$exe）"
      break
    }
  }
}

if (-not $pythonCmd) {
  Write-Bad '没找到 Python 3.10 以上版本。到 https://www.python.org/downloads/ 装一个，安装时勾选 "Add python.exe to PATH"。'
  exit 1
}

# ---------- 2. 准备虚拟环境 ----------
$venvPython = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
  Write-Step '创建虚拟环境 backend\.venv（只做一次，可能要等十几秒）'
  Push-Location $backend
  try {
    & $pythonCmd @pythonArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'venv 创建失败' }
  } finally {
    Pop-Location
  }
  Write-Ok '虚拟环境就绪'
} else {
  Write-Ok '虚拟环境已存在'
}

# ---------- 3. 装依赖 ----------
Write-Step '检查依赖'
& $venvPython -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Step '首次运行，安装依赖（之后不会重复装）'
  Push-Location $backend
  try {
    & $venvPython -m pip install --disable-pip-version-check -q --upgrade pip
    & $venvPython -m pip install --disable-pip-version-check -r requirements-dev.txt
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
  } finally {
    Pop-Location
  }
  Write-Ok '依赖安装完成'
} else {
  Write-Ok '依赖齐全'
}

# ---------- 4. 选端口 ----------
if (-not $Lan) {
  $tries = 0
  while ($tries -lt 10) {
    $busy = $false
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
      $listener.Start()
      $listener.Stop()
    } catch {
      $busy = $true
    }
    if (-not $busy) { break }
    Write-Bad "端口 $Port 被占用，换下一个"
    $Port += 1
    $tries += 1
  }
}

$bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$url = "http://localhost:$Port/"

Write-Host ''
Write-Ok "服务地址：$url"

if ($Lan) {
  $ips = @()
  try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback|vEthernet' } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    $ips = @()
  }
  if ($ips.Count -gt 0) {
    foreach ($ip in $ips) { Write-Host "    局域网：http://${ip}:$Port/" -ForegroundColor White }
    Write-Bad '注意：允许局域网访问时，Windows 防火墙可能会弹窗，要选「允许访问」。'
  } else {
    Write-Bad '没读到局域网 IP，用 ipconfig 查一下再拼地址。'
  }
}

Write-Host '    按 Ctrl+C 停止服务' -ForegroundColor DarkGray
Write-Host ''

# ---------- 5. 开浏览器 ----------
if (-not $NoBrowser) {
  Start-Job -ScriptBlock {
    param($target)
    Start-Sleep -Seconds 3
    try { Start-Process $target } catch { }
  } -ArgumentList $url | Out-Null
}

# ---------- 6. 起服务（前台，Ctrl+C 结束）----------
Push-Location $backend
try {
  & $venvPython -m uvicorn app.main:app --host $bind --port $Port
} finally {
  Pop-Location
}