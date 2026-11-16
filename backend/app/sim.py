"""仿真逻辑：地图、障碍物、机器人状态和移动规则。"""

from __future__ import annotations

# 地图大小：8×8
GRID_WIDTH = 8
GRID_HEIGHT = 8

# 障碍物坐标
OBSTACLES = {(2, 2), (3, 2), (5, 5)}

# 四个方向对应的坐标变化
DIRECTIONS = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}


class InvalidDirection(Exception):
    """方向不是 up / down / left / right。"""


class OutOfBounds(Exception):
    """移动后会超出地图边界。"""


class Blocked(Exception):
    """目标格是障碍物。"""


class Simulation:
    """维护地图和机器人状态，并判断移动是否合法。"""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """把机器人放回起点。"""
        self.x = 0
        self.y = 0
        self.heading = "up"
        self.status = "idle"

    def state(self) -> dict:
        """返回当前完整状态，格式和 API 契约一致。"""
        return {
            "grid": {
                "width": GRID_WIDTH,
                "height": GRID_HEIGHT,
                "obstacles": [list(item) for item in sorted(OBSTACLES)],
            },
            "robot": {
                "x": self.x,
                "y": self.y,
                "heading": self.heading,
                "status": self.status,
            },
        }

    def move(self, direction: str) -> dict:
        """移动一格；不合法时抛出异常，不修改状态。"""
        if direction not in DIRECTIONS:
            raise InvalidDirection(direction)

        dx, dy = DIRECTIONS[direction]
        nx, ny = self.x + dx, self.y + dy

        # 先检查边界
        if not (0 <= nx < GRID_WIDTH and 0 <= ny < GRID_HEIGHT):
            raise OutOfBounds(direction)

        # 再检查障碍物
        if (nx, ny) in OBSTACLES:
            raise Blocked(direction)

        # 全部通过后，才修改机器人状态
        self.x, self.y = nx, ny
        self.heading = direction
        self.status = "moving"
        return self.state()
