#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# patrol-sim 一键启动（Linux / macOS / WSL）
#
#   ./start.sh                 默认 8080 端口，只允许本机访问
#   ./start.sh --port 9000     换端口
#   ./start.sh --lan           监听 0.0.0.0，同 Wi-Fi 的人也能访问
#   ./start.sh --no-browser    不自动开浏览器
#
# 做的事：找 python3(>=3.10) -> 建 backend/.venv -> 缺依赖才装 -> 挑空闲端口
#         -> 延时开浏览器 -> 前台跑 uvicorn
# ---------------------------------------------------------------------------
set -euo pipefail

PORT=8080
HOST_BIND="127.0.0.1"
OPEN_BROWSER=1
LAN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --port|-p)
            PORT="${2:?--port 需要一个端口号}"
            shift 2
            ;;
        --lan)
            LAN=1
            shift
            ;;
        --no-browser)
            OPEN_BROWSER=0
            shift
            ;;
        -h|--help)
            sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "未知参数：$1（用 --help 看用法）" >&2
            exit 1
            ;;
    esac
done

if [ "$LAN" = "1" ]; then
    HOST_BIND="0.0.0.0"
fi

# 切到脚本所在目录，双击/任意位置调用都能跑
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }

# ---------- 1. 找 python ----------
PY=""
for cand in python3 python3.12 python3.11 python3.10 python; do
    if command -v "$cand" >/dev/null 2>&1; then
        if "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
            PY="$cand"
            break
        fi
    fi
done

if [ -z "$PY" ]; then
    say "[!] 没找到 Python 3.10 以上。Ubuntu/Debian 上装一下："
    say "    sudo apt update && sudo apt install -y python3 python3-venv"
    exit 1
fi
say "[+] Python: $("$PY" --version 2>&1)($PY)"

# ---------- 2. 虚拟环境 ----------
ROOT="$PWD"
VENV_DIR="$ROOT/backend/.venv"
VENV_PY="$VENV_DIR/bin/python"

if [ -d "$VENV_DIR" ] && [ ! -x "$VENV_PY" ]; then
    say "[!] $VENV_DIR 存在但里面是别的平台的虚拟环境（比如 Windows 的 Scripts/）。"
    say "    删掉它重来：rm -rf $VENV_DIR"
    exit 1
fi

if [ ! -x "$VENV_PY" ]; then
    say "[+] 创建虚拟环境 $VENV_DIR"
    if ! "$PY" -m venv "$VENV_DIR" 2>/dev/null; then
        say "[!] 建虚拟环境失败，可能需要先装 python3-venv："
        say "    sudo apt install -y python3-venv"
        exit 1
    fi
else
    say "[+] 虚拟环境已存在"
fi

# ---------- 3. 依赖 ----------
# 只装跑服务需要的（fastapi + uvicorn）。pytest / ruff 这些开发工具不是启动必需，
# 想跑测试再手动装：backend/.venv/bin/pip install -r backend/requirements-dev.txt
if "$VENV_PY" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
    say "[+] 依赖齐全"
else
    say "[+] 安装依赖（第一次会慢一点）"
    "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || true
    "$VENV_PY" -m pip install --no-input -r backend/requirements.txt
fi

# ---------- 4. 挑空闲端口 ----------
port_free() {
    "$VENV_PY" - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
try:
    s.bind(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    s.close()
sys.exit(0)
PY
}

START_PORT="$PORT"
tries=0
while ! port_free "$PORT"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 10 ]; then
        say "[!] 从 $START_PORT 开始连续 10 个端口都被占用，请手动 --port 指定"
        exit 1
    fi
    say "[!] 端口 $PORT 被占用，试 $((PORT + 1))"
    PORT=$((PORT + 1))
done

URL="http://127.0.0.1:$PORT/"

# ---------- 5. 开浏览器 ----------
open_url() {
    if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v wslview >/dev/null 2>&1; then
        wslview "$1" >/dev/null 2>&1 && return 0
    fi
    if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v explorer.exe >/dev/null 2>&1; then
        explorer.exe "$1" >/dev/null 2>&1 && return 0
    fi
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 && return 0
    fi
    if command -v open >/dev/null 2>&1; then
        open "$1" >/dev/null 2>&1 && return 0
    fi
    say "[i] 没找到能开浏览器的命令，自己打开：$1"
}

if [ "$OPEN_BROWSER" = "1" ]; then
    ( sleep 3; open_url "$URL" ) >/dev/null 2>&1 &
fi

# ---------- 6. 启动 ----------
say ""
say "=============================================="
say " 服务地址：$URL"
if [ "$LAN" = "1" ]; then
    say " 局域网访问："
    if command -v hostname >/dev/null 2>&1; then
        for ip in $(hostname -I 2>/dev/null || true); do
            case "$ip" in
                127.*) continue ;;
            esac
            say "   http://$ip:$PORT/"
        done
    fi
    say " （防火墙要放行 $PORT；连的是同一个后端，就是同一台机器人）"
fi
say " 停止服务：Ctrl + C"
say "=============================================="
say ""

cd backend
exec "$VENV_PY" -m uvicorn app.main:app --host "$HOST_BIND" --port "$PORT"
