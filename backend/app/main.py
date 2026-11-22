"""巡检机器人后端入口。

分工边界：
- C（接口与协作）维护：应用装配、运行时配置、统一错误格式、静态文件挂载、CI。
- A（仿真逻辑）维护 app/sim.py：8×8 网格、障碍物、移动校验与状态字段；
  接口路径和返回字段以 docs/03_项目架构与接口.md 为准。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.sim import (
    DEFAULT_SCENE,
    SCENES,
    Blocked,
    InvalidDirection,
    InvalidScene,
    OutOfBounds,
    Simulation,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("patrol")

# ---- 仿真模块 ---------------------------------------------------------------
SIM = Simulation()


def reset_state() -> None:
    """把场景和机器人一起复位，测试用。"""
    SIM.set_scene(DEFAULT_SCENE)


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
    return SIM.state()


# ---- 应用装配 ----------------------------------------------------------------
def create_app() -> FastAPI:
    app = FastAPI(title="Web 智能巡检机器人", version="0.1.0")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/state")
    def get_state() -> dict:
        return build_state()

    @app.get("/api/scenes")
    def list_scenes() -> dict:
        """可选场景列表，前端开场选择器用。"""
        return {
            "current": SIM.scene_id,
            "scenes": [
                {
                    "id": scene_id,
                    "name": scene["name"],
                    "width": scene["width"],
                    "height": scene["height"],
                    "obstacles": [list(item) for item in sorted(scene["obstacles"])],
                }
                for scene_id, scene in SCENES.items()
            ],
        }

    @app.post("/api/scene")
    async def select_scene(request: Request):
        """切换场景，成功后返回新场景的完整状态。"""
        try:
            payload = await request.json()
        except Exception:
            return error(400, "invalid_json", "请求体必须是合法的 JSON")

        scene_id = payload.get("id") if isinstance(payload, dict) else None
        if not isinstance(scene_id, str):
            return error(400, "invalid_scene", "id 必须是场景标识")
        try:
            state = SIM.set_scene(scene_id)
        except InvalidScene:
            known = "、".join(SCENES.keys())
            return error(400, "invalid_scene", f"未知场景，可选：{known}")

        LOGGER.info("scene -> %s", scene_id)
        return state

    @app.post("/api/move")
    async def move(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return error(400, "invalid_json", "请求体必须是合法的 JSON")

        direction = payload.get("direction") if isinstance(payload, dict) else None
        if not isinstance(direction, str):
            return error(400, "invalid_direction", "direction 只能是 up、down、left、right")
        try:
            state = SIM.move(direction)
        except InvalidDirection:
            return error(400, "invalid_direction", "direction 只能是 up、down、left、right")
        except OutOfBounds:
            return error(409, "out_of_bounds", "已到地图边界，无法继续移动")
        except Blocked:
            return error(409, "blocked", "目标格是障碍物，无法通过")

        LOGGER.info(
            "move %s -> (%s, %s)",
            direction,
            state["robot"]["x"],
            state["robot"]["y"],
        )
        return state

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
