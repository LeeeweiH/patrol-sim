"""巡检机器人后端入口。

分工边界：
- C（接口与协作）维护：应用装配、运行时配置、统一错误格式、静态文件挂载、CI。
- A（仿真逻辑）接管：把下面 build_state / move 里的占位规则换成 app/sim.py 的真实实现，
  接口路径和返回字段保持不变（以 docs/03_项目架构与接口.md 为准）。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("patrol")

# ---- 占位仿真数据（A 会替换成真正的仿真模块）--------------------------------
GRID_WIDTH = 8
GRID_HEIGHT = 8
OBSTACLES = {(2, 2), (3, 2), (5, 5)}
DIRECTIONS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}

ROBOT = {"x": 0, "y": 0, "heading": "up", "status": "idle"}


def reset_state() -> None:
    """把机器人放回起点，测试用。"""
    ROBOT.update({"x": 0, "y": 0, "heading": "up", "status": "idle"})


# ---- 运行时配置 --------------------------------------------------------------
def read_port() -> int:
    """读取并校验 PORT，写错时给出人能看懂的原因，而不是抛 StackTrace。"""
    raw = os.environ.get("PORT", "8080")
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"PORT 必须是整数，当前值是 {raw!r}") from None
    if not 1 <= port <= 65535:
        raise SystemExit(f"PORT 必须在 1-65535 之间，当前值是 {port}")
    return port


def error(status: int, code: str, message: str) -> JSONResponse:
    """所有错误统一成 {"error": {"code": ..., "message": ...}}。"""
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def build_state() -> dict:
    return {
        "grid": {
            "width": GRID_WIDTH,
            "height": GRID_HEIGHT,
            "obstacles": [list(item) for item in sorted(OBSTACLES)],
        },
        "robot": dict(ROBOT),
    }


# ---- 应用装配 ----------------------------------------------------------------
def create_app() -> FastAPI:
    app = FastAPI(title="Web 智能巡检机器人", version="0.1.0")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/state")
    def get_state() -> dict:
        return build_state()

    @app.post("/api/move")
    async def move(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return error(400, "invalid_json", "请求体必须是合法的 JSON")

        direction = payload.get("direction") if isinstance(payload, dict) else None
        if direction not in DIRECTIONS:
            return error(400, "invalid_direction", "direction 只能是 up、down、left、right")

        dx, dy = DIRECTIONS[direction]
        nx, ny = ROBOT["x"] + dx, ROBOT["y"] + dy
        if not (0 <= nx < GRID_WIDTH and 0 <= ny < GRID_HEIGHT):
            return error(409, "out_of_bounds", "已到地图边界，无法继续移动")
        if (nx, ny) in OBSTACLES:
            return error(409, "blocked", "目标格是障碍物，无法通过")

        ROBOT.update({"x": nx, "y": ny, "heading": direction, "status": "moving"})
        LOGGER.info("move %s -> (%s, %s)", direction, nx, ny)
        return build_state()

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        LOGGER.exception("未处理异常: %s %s", request.method, request.url.path)
        return error(500, "internal_error", "服务器内部错误")

    # 前端目录存在就挂载到根路径，这样 Docker 里一个容器就能同时提供页面和 API。
    frontend_dir = Path(__file__).resolve().parents[2] / "frontend"
    if frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=read_port())
