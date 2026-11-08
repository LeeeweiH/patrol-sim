"""冒烟测试：先保证骨架能跑、接口形状对。

这些是 C 的底线检查：CI 里跑的就是这几个。A 实现真实仿真逻辑后再补业务用例。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, reset_state


@pytest.fixture()
def client() -> TestClient:
    reset_state()
    return TestClient(create_app())


def test_health(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_state_shape(client: TestClient) -> None:
    data = client.get("/api/state").json()
    assert data["grid"]["width"] > 0
    assert data["grid"]["height"] > 0
    assert data["robot"]["x"] == 0
    assert data["robot"]["y"] == 0
    assert data["robot"]["heading"] in {"up", "down", "left", "right"}


def test_move_success(client: TestClient) -> None:
    resp = client.post("/api/move", json={"direction": "right"})
    assert resp.status_code == 200
    robot = resp.json()["robot"]
    assert (robot["x"], robot["y"]) == (1, 0)
    assert robot["heading"] == "right"


def test_move_blocked_by_boundary(client: TestClient) -> None:
    resp = client.post("/api/move", json={"direction": "up"})
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "out_of_bounds"
    assert "message" in body["error"]


def test_move_invalid_direction(client: TestClient) -> None:
    resp = client.post("/api/move", json={"direction": "north"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_direction"


def test_move_invalid_json(client: TestClient) -> None:
    resp = client.post(
        "/api/move",
        content=b"not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400


def test_unknown_path_returns_404(client: TestClient) -> None:
    assert client.get("/api/not-exist").status_code == 404


def test_wrong_method_on_api_path(client: TestClient) -> None:
    # 根路径挂载了前端静态目录，未匹配到路由的请求会交给静态处理器：
    # 方法不对时返回 404（静态里找不到这个文件）或 405（路由层拒绝）都算正常。
    assert client.get("/api/move").status_code in (404, 405)
