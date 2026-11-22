# 后端说明

## 功能与环境

- 已实现的接口和仿真功能（如地图读取、机器人移动、状态查询）为 `三个接口：GET /api/health 健康检查、GET /api/state 查询地图与机器人状态、POST /api/move 手动移动；仿真为 8×8 二维网格、3 处固定障碍，越界与撞障碍都会被拦截`。
- 后端使用 `Python 3.10+ + FastAPI + Uvicorn` 开发，仿真逻辑使用 `纯 Python` 实现（CI 在 `Python 3.14` 上验证，WSL 的 3.10 与 Windows 的 3.12 均实测通过）。
- 本地运行需要安装 `Python 和 pip`，最低版本 `Python 3.10`。

## 本地启动流程

1. **进入目录。** 从仓库根目录进入 `backend/`。

2. **建虚拟环境并装依赖。** 依赖只装进项目内的 `.venv`（已在 `.gitignore` 里），不要装到系统全局 Python，否则换一台机器或换一个项目就会出现版本冲突。

   Linux / macOS / WSL：

   ```bash
   cd backend
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

   Windows（PowerShell）：

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

   - 只跑服务装 `requirements.txt` 就够了；要跑测试与代码检查，再装 `requirements-dev.txt`。
   - 不激活也能用，写全路径即可：Linux 是 `.venv/bin/python -m pip install -r requirements.txt`，Windows 是 `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`。
   - Windows 上激活若报「禁止运行脚本」，先执行 `Set-ExecutionPolicy -Scope Process Bypass`，或改用 `cmd` 里的 `.\.venv\Scripts\activate.bat`。

   国内网络直连 pypi.org 很慢（WSL 里拉一个 2 MB 的包能卡上半分钟），可以先配镜像再装：

   ```bash
   mkdir -p ~/.config/pip
   printf '[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\n' > ~/.config/pip/pip.conf
   ```

3. **准备配置和初始数据。** 不需要配置文件；环境变量只有 `PORT`，示例值 `8080`（不设置时默认 8080）。没有需要初始化的数据，地图尺寸与障碍物坐标直接定义在 `backend/app/sim.py` 的 `GRID_WIDTH`、`GRID_HEIGHT`、`OBSTACLES` 中，因此没有单独的加载步骤。`PORT` 必须是 1–65535 的整数，非整数或超出范围时启动直接报错退出并输出可读原因。

4. **启动后端。** Linux / macOS / WSL 执行 `python3 -m app.main`，Windows 执行 `python -m app.main`；服务地址都是 `http://localhost:8080`，启动成功时可以看到 `Uvicorn running on http://0.0.0.0:8080`。要换端口就在前面加环境变量：`PORT=9000 python3 -m app.main`（Windows PowerShell 写 `$env:PORT=9000; python -m app.main`）。

5. **验证接口。** 按下方示例发出请求，核对状态码和响应内容。联调页面时，按[前端说明](../frontend/README.md)启动前端。

## 接口验证示例

选一个已实现的接口，例如地图读取或机器人状态查询，补全以下内容。

- 接口用途为：获取二维地图与机器人当前状态
- 请求方法和路径为：GET /api/state
- 可直接执行的请求命令为：curl http://localhost:8080/api/state
- 预期 HTTP 状态码为 200，预期响应内容为：
  {"grid":{"width":8,"height":8,"obstacles":[[2,2],[3,2],[5,5]]},
   "robot":{"x":0,"y":0,"heading":"up","status":"idle"}}

## 构建与检查

- 无构建命令/产物，由纯Python源码运行
- 测试或检查命令为 `ruff check .（预期 All checks passed!）、python -m compileall -q app（预期无输出）、pytest -q（预期 15 passed）`。
