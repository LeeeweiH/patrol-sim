"""机体目录接口的测试。"""

from fastapi.testclient import TestClient

from app.main import create_app, reset_state


def client() -> TestClient:
    reset_state()
    return TestClient(create_app())


def test_list_robots() -> None:
    data = client().get("/api/robots").json()
    ids = [r["id"] for r in data["robots"]]
    assert ids == ["go2", "rover"]


def test_robot_fields() -> None:
    data = client().get("/api/robots").json()
    go2, rover = data["robots"]
    assert go2["name"] == "机器狗 · Go2-lite"
    assert go2["radius"] < rover["radius"]      # 轮式车更大，贴边余量更多
    assert go2["speed"] < rover["speed"]        # 轮式车直线更快
    for robot in data["robots"]:
        assert 0 < robot["radius"] < 0.5
        assert 0 < robot["speed"] < 10
        assert robot["kind"] in {"quadruped", "wheeled"}
