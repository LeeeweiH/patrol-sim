"""巡检报告留档相关用例：入库、列表倒序、参数校验。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, reset_state


@pytest.fixture()
def client() -> TestClient:
    reset_state()
    return TestClient(create_app())


def _report(scene: str = "standard", **extra) -> dict:
    payload = {"scene": scene, "points": 15, "seconds": 12.7, "steps": 31, "visited": 31}
    payload.update(extra)
    return payload


def test_save_report(client: TestClient) -> None:
    resp = client.post("/api/report", json=_report())
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] is True
    assert data["count"] == 1
    report = data["report"]
    assert report["id"] == 1
    assert report["scene"] == "standard"
    assert report["scene_name"] == "标准巡检区"
    assert report["points"] == 15
    assert report["seconds"] == 12.7
    assert report["steps"] == 31
    assert report["visited"] == 31
    assert len(report["received_at"]) == 19


def test_list_reports_newest_first(client: TestClient) -> None:
    client.post("/api/report", json=_report(steps=10))
    client.post("/api/report", json=_report(scene="warehouse", steps=22))

    data = client.get("/api/reports").json()
    assert data["count"] == 2
    assert [item["steps"] for item in data["reports"]] == [22, 10]
    assert data["reports"][0]["scene"] == "warehouse"

    limited = client.get("/api/reports", params={"limit": 1}).json()
    assert len(limited["reports"]) == 1
    assert limited["reports"][0]["steps"] == 22


def test_report_unknown_scene(client: TestClient) -> None:
    resp = client.post("/api/report", json=_report(scene="moon"))
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "invalid_report"
    assert "standard" in body["error"]["message"]


def test_report_bad_numbers(client: TestClient) -> None:
    for bad in ({"steps": -1}, {"points": "15"}, {"seconds": None}, {"visited": True}):
        resp = client.post("/api/report", json=_report(**bad))
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["code"] == "invalid_report"


def test_report_invalid_json(client: TestClient) -> None:
    resp = client.post(
        "/api/report",
        content=b"{oops",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_json"
