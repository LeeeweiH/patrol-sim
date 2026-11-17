/**
 * 智能巡检机器人 · 前端交互
 *
 * 约定（见 docs/03_项目架构与接口.md）：
 * - 页面打开时 GET /api/state 拿一次完整状态；
 * - 每次点击方向按钮 POST /api/move，直接用响应里的完整状态重绘，不在前端预测位置；
 * - 失败时按 error.code 处理：4xx 是后端明确拒绝（位置不变），超时/网络/5xx 是结果未确认（提示重新读取，不自动重发）。
 *
 * 服务端是唯一事实来源：前端不保存第二份地图，也不缓存移动结果。
 */
(function () {
  "use strict";

  const TIMEOUT_MS = 8000;
  const DIRECTIONS = { up: "上", down: "下", left: "左", right: "右" };
  const HEADING_ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
  const STATUS_TEXT = { idle: "待命", moving: "移动中" };

  /** 带 code 的请求错误，便于按错误类型分支处理。 */
  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = typeof status === "number" ? status : 0;
    }
  }

  const els = {
    board: document.getElementById("board"),
    placeholder: document.getElementById("placeholder"),
    mapMeta: document.getElementById("map-meta"),
    factPosition: document.getElementById("fact-position"),
    factHeading: document.getElementById("fact-heading"),
    factStatus: document.getElementById("fact-status"),
    factSteps: document.getElementById("fact-steps"),
    factVisited: document.getElementById("fact-visited"),
    feedback: document.getElementById("feedback"),
    reload: document.getElementById("reload"),
    conn: document.getElementById("conn"),
    connText: document.getElementById("conn-text"),
    keys: Array.from(document.querySelectorAll(".key[data-direction]")),
  };

  /** 最后一次「已确认」的服务端状态；失败时用它保持画面不变。 */
  let currentState = null;
  let busy = false;

  /**
   * 本次会话的行走轨迹。后端不返回历史，所以轨迹只记在页面里：
   * - 每次成功移动就把新格子加进集合、步数 +1；
   * - 如果机器人「跳」了不止一格（别的标签页移动过、或手动重新读取时位置已变），
   *   说明本地轨迹已经不可信，直接清空重来，避免画出错误的路线。
   */
  let steps = 0;
  let trail = new Set();

  /* ---------------------------------------------------------------- 请求 */

  /**
   * 发一个 JSON 请求：8 秒超时、统一错误语义、解析响应体。
   * 成功返回解析后的对象；失败抛出 ApiError（4xx 保留后端 error.code/message）。
   */
  async function requestJSON(path, options) {
    const init = Object.assign({ method: "GET", headers: {} }, options || {});
    init.headers = Object.assign({ Accept: "application/json" }, init.headers);
    init.cache = "no-store";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    init.signal = controller.signal;

    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      clearTimeout(timer);
      if (error && error.name === "AbortError") {
        throw new ApiError("timeout", "请求超时（超过 " + TIMEOUT_MS / 1000 + " 秒没有响应）");
      }
      throw new ApiError("network", "网络异常，无法连接后端服务");
    }

    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      clearTimeout(timer);
      if (error && error.name === "AbortError") {
        throw new ApiError("timeout", "请求超时（超过 " + TIMEOUT_MS / 1000 + " 秒没有响应）");
      }
      throw new ApiError("invalid_response", "读取响应内容失败");
    }
    clearTimeout(timer);

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = null;
      }
    }

    if (!response.ok) {
      const info = (data && data.error) || {};
      const fallback = "请求失败（HTTP " + response.status + "）";
      throw new ApiError(info.code || "http_" + response.status, info.message || fallback, response.status);
    }
    if (data === null) {
      throw new ApiError("invalid_response", "服务返回的内容不是合法 JSON", response.status);
    }
    return data;
  }

  /* ---------------------------------------------------------------- 校验 */

  function isInt(value) {
    return typeof value === "number" && Number.isInteger(value);
  }

  /**
   * 校验 GET /api/state 与 POST /api/move 的响应结构。
   * 结构不对就当作失败，避免把不完整的响应画到页面上。
   */
  function validateState(data) {
    const grid = data && data.grid;
    const robot = data && data.robot;
    const bad = (why) => new ApiError("invalid_state", "服务返回的状态格式不正确：" + why);

    if (!grid || !isInt(grid.width) || !isInt(grid.height)) throw bad("缺少网格尺寸");
    if (grid.width < 1 || grid.height < 1 || grid.width > 50 || grid.height > 50) {
      throw bad("网格尺寸超出范围");
    }
    if (!Array.isArray(grid.obstacles)) throw bad("缺少障碍物列表");

    const obstacles = grid.obstacles.filter(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        isInt(item[0]) &&
        isInt(item[1]) &&
        item[0] >= 0 &&
        item[0] < grid.width &&
        item[1] >= 0 &&
        item[1] < grid.height
    );

    if (!robot || !isInt(robot.x) || !isInt(robot.y)) throw bad("缺少机器人坐标");
    if (robot.x < 0 || robot.x >= grid.width || robot.y < 0 || robot.y >= grid.height) {
      throw bad("机器人坐标超出网格");
    }
    if (!Object.prototype.hasOwnProperty.call(HEADING_ARROWS, robot.heading)) {
      throw bad("朝向取值不是 up/down/left/right");
    }
    if (typeof robot.status !== "string") throw bad("缺少运行状态");

    return {
      grid: {
        width: grid.width,
        height: grid.height,
        obstacles: obstacles,
      },
      robot: {
        x: robot.x,
        y: robot.y,
        heading: robot.heading,
        status: robot.status,
      },
    };
  }

  /* ---------------------------------------------------------------- 渲染 */

  function makeAxisCell(text, className) {
    const node = document.createElement("div");
    node.className = "axis " + className;
    node.textContent = String(text);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function cellKey(x, y) {
    return x + "," + y;
  }

  /**
   * 记录一次位置变化：
   * - 正常移动只差一格，累计步数、把新格子并入轨迹；
   * - 位置跳变超过一格（别的标签页移动过 / 重新读取时已不同步），本地轨迹就不可信了，清空重来。
   * 返回 true 表示这次重置过轨迹。
   */
  function trackPosition(state, previous) {
    const jumped =
      Boolean(previous) &&
      Math.abs(previous.x - state.robot.x) + Math.abs(previous.y - state.robot.y) > 1;

    if (!previous || jumped || trail.size === 0) {
      trail = new Set();
      steps = 0;
    }
    trail.add(cellKey(state.robot.x, state.robot.y));
    return jumped;
  }

  function makeCell(state, x, y) {
    const cell = document.createElement("div");
    cell.className = "cell";

    const isBlocked = state.grid.obstacles.some((item) => item[0] === x && item[1] === y);
    const isRobot = state.robot.x === x && state.robot.y === y;
    let label = "第 " + y + " 行第 " + x + " 列，可通行";

    if (isBlocked) {
      cell.classList.add("cell--block");
      cell.textContent = "障";
      label = "第 " + y + " 行第 " + x + " 列，障碍物";
    } else if (isRobot) {
      cell.classList.add("cell--robot");
      const arrow = document.createElement("span");
      arrow.className = "robot-arrow";
      arrow.textContent = HEADING_ARROWS[state.robot.heading];
      const tag = document.createElement("span");
      tag.className = "robot-tag";
      tag.textContent = "机";
      cell.append(arrow, tag);
      label =
        "第 " + y + " 行第 " + x + " 列，机器人，朝向" + DIRECTIONS[state.robot.heading];
    } else if (trail.has(cellKey(x, y))) {
      cell.classList.add("cell--visited");
      label = "第 " + y + " 行第 " + x + " 列，可通行，已走过";
    }

    cell.setAttribute("aria-label", label);
    return cell;
  }

  /** 按后端状态整块重绘地图（8×8=64 格，直接重建比增量更新更好维护）。 */
  function renderState(state, options) {
    const opts = options || {};
    const { width, height } = state.grid;

    els.board.style.setProperty("--columns", String(width));
    els.board.style.setProperty("--rows", String(height));

    const fragment = document.createDocumentFragment();
    const corner = document.createElement("div");
    corner.className = "axis-corner";
    corner.setAttribute("aria-hidden", "true");
    fragment.append(corner);

    for (let x = 0; x < width; x += 1) fragment.append(makeAxisCell(x, "axis-x"));

    for (let y = 0; y < height; y += 1) {
      fragment.append(makeAxisCell(y, "axis-y"));
      for (let x = 0; x < width; x += 1) fragment.append(makeCell(state, x, y));
    }

    els.board.replaceChildren(fragment);
    els.board.setAttribute(
      "aria-label",
      "二维巡检地图，" + width + " 乘 " + height + " 格，机器人位于第 " + state.robot.y + " 行第 " + state.robot.x + " 列"
    );

    if (opts.moved) {
      const robotCell = els.board.querySelector(".cell--robot");
      if (robotCell) {
        // 用「上一格 - 新格」算出位移，交给 CSS 从旧位置滑过来
        if (opts.from) {
          robotCell.style.setProperty("--dx", String(opts.from.x - state.robot.x));
          robotCell.style.setProperty("--dy", String(opts.from.y - state.robot.y));
        }
        robotCell.classList.add("is-moved");
      }
    }

    els.placeholder.hidden = true;
    els.mapMeta.textContent =
      width + " × " + height + " 网格 · 障碍 " + state.grid.obstacles.length + " 处";

    els.factSteps.textContent = String(steps);
    els.factVisited.textContent = String(trail.size);

    els.factPosition.textContent = "(" + state.robot.x + ", " + state.robot.y + ")";
    els.factHeading.textContent =
      DIRECTIONS[state.robot.heading] + " " + HEADING_ARROWS[state.robot.heading];
    els.factStatus.textContent = STATUS_TEXT[state.robot.status] || state.robot.status;
  }

  /* ---------------------------------------------------------------- 界面状态 */

  function setFeedback(message, kind) {
    els.feedback.textContent = message;
    if (kind) {
      els.feedback.dataset.kind = kind;
    } else {
      delete els.feedback.dataset.kind;
    }
  }

  function setConnection(state, text) {
    els.conn.dataset.state = state;
    els.connText.textContent = text;
  }

  /**
   * 方向键只在「已拿到状态」且「没有请求在飞」时可用，避免并发请求。
   * 「重新读取状态」只在请求进行中禁用——它本身就是加载失败后的重试入口，不能跟着一起锁死。
   */
  function syncControls() {
    const noState = !currentState;
    els.keys.forEach((button) => {
      button.disabled = busy || noState;
    });
    els.reload.disabled = busy;
    els.board.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showPlaceholder(message) {
    els.placeholder.textContent = message;
    els.placeholder.hidden = false;
  }

  /* ---------------------------------------------------------------- 交互 */

  async function loadState(options) {
    const initial = Boolean(options && options.initial);
    if (busy) return;

    busy = true;
    syncControls();
    setFeedback(initial ? "正在读取地图与机器人状态…" : "正在重新读取状态…");

    try {
      const state = validateState(await requestJSON("/api/state"));
      const previous = currentState ? { x: currentState.robot.x, y: currentState.robot.y } : null;
      currentState = state;
      const jumped = trackPosition(state, previous);
      renderState(state);
      setConnection("online", "服务在线");
      setFeedback(
        jumped
          ? "已读取最新状态（位置变化较大，轨迹已重新开始）"
          : initial
            ? "已连接，用方向按钮或键盘开始移动"
            : "已读取最新状态",
        jumped || !initial ? "success" : ""
      );
    } catch (error) {
      const reason = describeError(error);
      setFeedback(
        (initial ? "加载失败：" : "重新读取失败：") + reason + "。请确认后端已启动，然后点「重新读取状态」重试。",
        "error"
      );
      if (error.code === "network" || error.code === "timeout") {
        setConnection("offline", "未连接服务");
      }
      if (!currentState) {
        els.mapMeta.textContent = "未读取到地图";
        showPlaceholder("地图加载失败：" + reason + "\n请启动后端后点「重新读取状态」。");
      }
    } finally {
      busy = false;
      syncControls();
    }
  }

  async function move(direction) {
    if (busy || !currentState) return;
    if (!Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)) return;

    const from = { x: currentState.robot.x, y: currentState.robot.y };

    busy = true;
    syncControls();
    setFeedback("正在发送「向" + DIRECTIONS[direction] + "移动」指令…");

    try {
      const state = validateState(
        await requestJSON("/api/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: direction }),
        })
      );
      currentState = state;
      steps += 1;
      trackPosition(state, from);
      renderState(state, { moved: true, from: from });
      setConnection("online", "服务在线");
      setFeedback(
        "已向" + DIRECTIONS[direction] + "移动一格，当前位置 (" + state.robot.x + ", " + state.robot.y + ")。",
        "success"
      );
    } catch (error) {
      const rejected = error.status >= 400 && error.status < 500;
      if (rejected) {
        // 4xx：后端明确拒绝（越界/障碍/非法方向），位置没有变化，画面保持原样。
        setFeedback("移动被拒绝：" + describeError(error), "warn");
        setConnection("online", "服务在线");
      } else {
        // 5xx / 超时 / 网络 / 响应格式：结果未知，不自动重发，交给用户重新读取。
        setFeedback(
          "移动结果未确认：" + describeError(error) + "。最新状态尚未确认，请点「重新读取状态」，不要重复点击方向按钮。",
          "error"
        );
        if (error.code === "network" || error.code === "timeout") {
          setConnection("offline", "未连接服务");
        }
      }
    } finally {
      busy = false;
      syncControls();
    }
  }

  function describeError(error) {
    if (error instanceof ApiError) return error.message;
    return "发生未知错误";
  }

  /* ---------------------------------------------------------------- 绑定 */

  function bindEvents() {
    els.keys.forEach((button) => {
      button.addEventListener("click", () => move(button.dataset.direction));
    });

    els.reload.addEventListener("click", () => loadState({ initial: !currentState }));

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target && target.isContentEditable) return;

      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      const direction = map[event.key];
      if (!direction) return;
      if (busy || !currentState) return;
      event.preventDefault();
      move(direction);
    });
  }

  function init() {
    bindEvents();
    syncControls();
    loadState({ initial: true });
  }

  init();
})();
