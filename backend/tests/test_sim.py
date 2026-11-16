import pytest

from app.sim import Blocked, InvalidDirection, OutOfBounds, Simulation


@pytest.fixture()
def sim() -> Simulation:
    return Simulation()


def test_initial_state(sim: Simulation) -> None:
    state = sim.state()
    assert state["grid"]["width"] == 8
    assert state["grid"]["height"] == 8
    assert state["robot"] == {
        "x": 0,
        "y": 0,
        "heading": "up",
        "status": "idle",
    }


def test_move_right(sim: Simulation) -> None:
    state = sim.move("right")
    assert state["robot"] == {
        "x": 1,
        "y": 0,
        "heading": "right",
        "status": "moving",
    }


def test_out_of_bounds_does_not_move(sim: Simulation) -> None:
    with pytest.raises(OutOfBounds):
        sim.move("up")

    state = sim.state()
    assert (state["robot"]["x"], state["robot"]["y"]) == (0, 0)


def test_blocked_does_not_move(sim: Simulation) -> None:
    sim.move("right")   # (1,0)
    sim.move("right")   # (2,0)
    sim.move("down")    # (2,1)

    with pytest.raises(Blocked):
        sim.move("down")  # (2,2) 是障碍物

    state = sim.state()
    assert (state["robot"]["x"], state["robot"]["y"]) == (2, 1)


def test_invalid_direction(sim: Simulation) -> None:
    with pytest.raises(InvalidDirection):
        sim.move("north")


def test_reset(sim: Simulation) -> None:
    sim.move("right")
    sim.reset()

    state = sim.state()
    assert (state["robot"]["x"], state["robot"]["y"]) == (0, 0)
    assert state["robot"]["heading"] == "up"
    assert state["robot"]["status"] == "idle"
