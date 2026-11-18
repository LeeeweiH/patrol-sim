<img width="238" height="30" alt="image" src="https://github.com/user-attachments/assets/98acf5f2-a923-410d-8f6c-5f2a6bdb803f" /># 基于 Web 的智能巡检机器人二维仿真系统

本项目是 广东海洋大学阳江校区人工智能协会 培训班的结课作品。我们将机器人的巡检场景搬到浏览器中，通过二维地图展示机器人如何移动，以及它的位置、朝向和运行状态如何随操作变化。

## 在线演示

可操作的在线演示部署在 `XXX`。打开演示页面后，可以查看二维地图、手动控制机器人，并观察操作后的状态变化。

本项目还展示了 `XXX`。

## 技术选型

- 前端使用 `原生 HTML + CSS + JavaScript（无框架）` 开发页面和操作界面。
- 后端使用 `Python 3.14 + FastAPI + Uvicorn` 提供 API。
- 二维地图和机器人使用 `DOM 元素 + CSS Grid` 绘制。
- 仿真逻辑使用 `纯 Python` 实现，代码位于 `backend/app/sim.py`，不依赖第三方仿真库。
- CI 使用 `GitHub Actions` 运行自动检查（ruff 风格检查、compileall 语法检查、pytest 单元测试）。
- Docker 部署使用 `XXX`。

## 项目文档

- 了解功能范围和验收方式，见[项目需求](docs/01_项目需求.md)。
- 查看模块职责和数据流向，见[项目架构与接口](docs/03_项目架构与接口.md)。
- 本地启动与 Docker 部署步骤，见[运行说明](docs/04_运行与结业提交.md)。
- 查看团队成员及各自完成的内容，见[小组分工](docs/02_小组分工.md)。
