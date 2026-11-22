"""多场景（地图）相关用例：列表、切换、切到新地图后的移动规则。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, reset_state


@pytest.fixture()
def client() -> TestClient:
    reset_state()
    return TestClient(create_app())


def test_list_scenes(client: TestClient) -> None:
    data = client.get("/api/scenes").json()
    ids = [item["id"] for item in data["scenes"]]
    assert "standard" in ids
    assert "warehouse" in ids
    assert data["current"] == "standard"

    for item in data["scenes"]:
        assert item["width"] > 0
        assert item["height"] > 0
        assert isinstance(item["obstacles"], list)


def test_state_carries_scene(client: TestClient) -> None:
    data = client.get("/api/state").json()
    assert data["scene"]["id"] == "standard"
    assert data["scene"]["name"]


def test_select_scene(client: TestClient) -> None:
    resp = client.post("/api/scene", json={"id": "warehouse"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["scene"]["id"] == "warehouse"
    assert data["grid"]["width"] == 10
    assert data["grid"]["height"] == 8
    assert data["robot"] == {"x": 0, "y": 0, "heading": "up", "status": "idle"}

    # 切换后 /api/state 也要跟着变
    again = client.get("/api/state").json()
    assert again["scene"]["id"] == "warehouse"


def test_switch_scene_resets_position(client: TestClient) -> None:
    client.post("/api/move", json={"direction": "right"})
    assert client.get("/api/state").json()["robot"]["x"] == 1

    client.post("/api/scene", json={"id": "standard"})
    assert client.get("/api/state").json()["robot"]["x"] == 0


def test_zone_specific_obstacle(client: TestClient) -> None:
    """仓储通道里 (2, 1) 是障碍，走到 (2, 0) 后下行应被拦。"""
    client.post("/api/scene", json={"id": "warehouse"})
    client.post("/api/move", json={"direction": "right"})
    client.post("/api/move", json={"direction": "right"})
    assert client.get("/api/state").json()["robot"]["x"] == 2

    resp = client.post("/api/move", json={"direction": "down"})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "blocked"


def test_unknown_scene(client: TestClient) -> None:
    resp = client.post("/api/scene", json={"id": "moon"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_scene"


def test_scene_invalid_json(client: TestClient) -> None:
    resp = client.post(
        "/api/scene",
        content=b"not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400
