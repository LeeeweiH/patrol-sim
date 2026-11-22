/**
 * 智能巡检机器人 · 前端交互
 *
 * 两套操控方式，共用同一张地图和同一台机器人：
 *
 * - 格点移动（grid）：只认服务端。点方向键 → POST /api/move → 用响应里的完整状态重绘，
 *   前端不预测位置。这是与后端契约（docs/03_项目架构与接口.md）一致的演示路径。
 * - 自由移动（free）：页面内的连续运动模拟。点地图任意位置就走过去（A* 绕开障碍），
 *   按 WASD/方向键则持续移动；障碍按正方形碰撞体处理，机器人是圆形，可以贴边滑行。
 *   这条路径不写服务端，切回格点模式时以服务端状态为准。
 *
 * 失败语义两套模式一样：4xx 是明确拒绝（位置不变），超时/网络/5xx 是结果未确认（提示重新读取，不自动重发）。
 */
(function () {
  "use strict";

  const TIMEOUT_MS = 8000;
  const DIRECTIONS = { up: "上", down: "下", left: "左", right: "右" };
  const HEADING_ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
  const STATUS_TEXT = { idle: "待命", moving: "移动中" };

  /** 自由移动的行走速度（格/秒）与机器人碰撞半径（格）。 */
  const FREE_SPEED = 2.6;
  const ROBOT_RADIUS = 0.26;

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
    stage: document.getElementById("stage"),
    layout: document.querySelector(".layout"),
    sideToggle: document.getElementById("side-toggle"),
    sideToggleGlyph: document.getElementById("side-toggle-glyph"),
    sideToggleText: document.querySelector(".side-toggle-text"),
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
    controlHint: document.getElementById("control-hint"),
    keysHint: document.getElementById("keys-hint"),
    keys: Array.from(document.querySelectorAll(".key[data-direction]")),
    dpad: document.getElementById("dpad"),
    stickWrap: document.getElementById("stick"),
    stickBase: document.getElementById("stick-base"),
    stickKnob: document.getElementById("stick-knob"),
    stickToggle: document.getElementById("stick-toggle"),
    modeBtns: Array.from(document.querySelectorAll(".mode-btn")),
    openScene: document.getElementById("open-scene"),
    start: document.getElementById("start"),
    startGo: document.getElementById("start-go"),
    robotPreview: document.getElementById("robot-preview"),
    picks: Array.from(document.querySelectorAll(".pick[data-pick]")),
  };

  /** 最后一次「已确认」的服务端状态；请求失败时用它保持画面不变。 */
  let currentState = null;
  let busy = false;

  /**
   * 本次会话的行走轨迹：后端不返回历史，轨迹只记在页面里。
   * 位置跳变超过一格（别的标签页动过、重新读取时已不同步）就清空重来，避免画出错误路线。
   */
  let steps = 0;
  let trail = new Set();

  /** 开场选择：现在各只有一个选项，但结构按「以后会加」来写。 */
  const selection = { map: "grid8", robot: "go2" };
  let started = false;
  let mode = "free"; // free | grid

  /* ---------------------------------------------------------------- 模型 */

  /**
   * 地面是斜的（.board 绕 X 轴倾斜），站在上面的东西要反向转回来才立得住。
   * 立牌素材放在 assets/scene.svg，页面启动时取一次、内联进 DOM，
   * 之后每处克隆一份——换模型（以后换角色、加时装）只改那个 svg。
   */
  const SCENE_URL = "assets/scene.svg?v=4";

  const HEADING_DEG = { right: 0, down: 90, left: 180, up: -90 };
  const HEADING_TURN = { right: 0, left: 0, up: -38, down: 38 };
  const HEADING_FLIP = { right: 1, left: -1, up: 1, down: 1 };

  const sprites = { dog: null, sign: null, crate: null };

  async function loadSprites() {
    try {
      const response = await fetch(SCENE_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const markup = await response.text();

      const holder = document.createElement("div");
      holder.className = "sprite-bank";
      holder.setAttribute("aria-hidden", "true");
      holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      holder.innerHTML = markup;

      const dog = holder.querySelector("#dog");
      const sign = holder.querySelector("#sign");
      if (!dog || !sign) throw new Error("场景文件缺少 #dog 或 #sign");

      sprites.dog = dog;
      sprites.sign = sign;
      sprites.crate = holder.querySelector("#crate");
      document.body.append(holder);
      return true;
    } catch (error) {
      // 模型只是画面装饰：取不到就退回纯色格子，地图和操作都不受影响
      return false;
    }
  }

  function cloneSprite(kind) {
    const template = sprites[kind];
    if (!template) return null;
    const node = template.cloneNode(true);
    node.removeAttribute("id");
    node.removeAttribute("width");
    node.removeAttribute("height");
    node.classList.add("sprite");
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("focusable", "false");
    return node;
  }

  function makeBillboard(kind) {
    const board = document.createElement("div");
    board.className = "billboard billboard--" + kind;
    return board;
  }

  /* ---------------------------------------------------------------- 网格度量 */

  /** 量一次格子的位置与边长，自由移动的坐标换算都靠它。 */
  function gridMetrics() {
    const cell = els.board.querySelector(".cell");
    if (!cell) return null;
    const width = els.board.querySelectorAll(".axis-x").length;
    // 夹一下，异常尺寸时别把舞台撑坏
    const cellPx = Math.max(24, Math.min(170, cell.offsetWidth));
    if (!cellPx) return null;
    const gap = parseFloat(getComputedStyle(els.board).gap) || 0;
    return {
      cellPx: cellPx,
      step: cellPx + gap,
      originX: cell.offsetLeft + cellPx / 2,
      originY: cell.offsetTop + cellPx / 2,
      columns: width,
    };
  }

  /**
   * 量一次格子边长，写进 --cell-px（立牌按它换算尺寸），
   * 再把舞台高度收成「倾斜后真正看得见的高度 + 立牌高度」，
   * 否则旋转前后的布局高度对不上，地图下面会空出一大块。
   */
  function fitStage(options) {
    const instant = Boolean(options && options.instant);
    const cell = els.board.querySelector(".cell");
    if (!cell) return;
    // 夹一下，异常尺寸时别把舞台撑坏
    const cellPx = Math.max(24, Math.min(170, cell.offsetWidth));
    const boardH = els.board.offsetHeight;
    if (!cellPx || !boardH) return;

    const tilt =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tilt")) || 56;
    const cos = Math.cos((tilt * Math.PI) / 180);

    els.board.style.setProperty("--cell-px", cellPx + "px");
    els.stage.style.setProperty("--stage-h", Math.round(boardH * cos + cellPx * 1.15 + 24) + "px");

    // 重排时先关掉 220ms 过渡，否则窗口一变角色会从旧位置「滑」过去，看着像在跳
    if (instant && actor.node) {
      actor.node.style.transition = "none";
      applyActorTransform();
      void actor.node.offsetWidth;
      actor.node.style.transition = "";
      return;
    }

    applyActorTransform();
  }

  /* ---------------------------------------------------------------- 请求 */

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
      grid: { width: grid.width, height: grid.height, obstacles: obstacles },
      robot: { x: robot.x, y: robot.y, heading: robot.heading, status: robot.status },
    };
  }

  /* ---------------------------------------------------------------- 角色（立牌） */

  const actor = {
    x: 0,
    y: 0,
    heading: "up",
    path: [],
    walking: false,
    node: null,
    sprite: null,
    facing: null,
    tag: null,
    cell: null,
  };

  /** 把角色立到地图上；重绘地图后节点会被清掉，所以每次重绘都要重新装配。 */
  function ensureActor() {
    if (actor.node) return actor.node;

    const node = document.createElement("div");
    node.className = "actor";
    node.id = "actor";

    // 地面层：地灯光晕 + 朝向光锥，跟着地面一起倾斜
    const ground = document.createElement("div");
    ground.className = "actor-ground";
    const halo = document.createElement("span");
    halo.className = "actor-halo";
    const facing = document.createElement("span");
    facing.className = "facing";
    ground.append(halo, facing);

    // 立牌层：反向转回竖直，里面就是屏幕坐标
    const billboard = makeBillboard("dog");
    const sprite = cloneSprite("dog");
    if (sprite) billboard.append(sprite);
    const tag = document.createElement("span");
    tag.className = "unit-tag";
    tag.textContent = "机";
    billboard.append(tag);

    node.append(ground, billboard);
    els.board.append(node);

    actor.node = node;
    actor.sprite = sprite;
    actor.facing = facing;
    actor.tag = tag;
    return node;
  }

  function applyActorTransform() {
    if (!actor.node) return;
    const metrics = gridMetrics();
    if (!metrics) return;
    const px = metrics.originX + actor.x * metrics.step;
    const py = metrics.originY + actor.y * metrics.step;
    actor.node.style.transform = "translate3d(" + px + "px," + py + "px, 1px)";
  }

  function applyActorLook() {
    if (actor.node) {
      actor.node.style.setProperty("--heading-deg", HEADING_DEG[actor.heading] + "deg");
    }
    if (actor.sprite) {
      actor.sprite.style.setProperty("--flip", String(HEADING_FLIP[actor.heading]));
      actor.sprite.style.setProperty("--turn", HEADING_TURN[actor.heading] + "deg");
    }
  }

  function setWalking(on) {
    if (!actor.sprite) return;
    actor.walking = on;
    actor.sprite.classList.toggle("is-walking", on);
  }

  /* ---------------------------------------------------------------- 碰撞 */

  function isBlockedCell(x, y) {
    if (!currentState) return false;
    return currentState.grid.obstacles.some((item) => item[0] === x && item[1] === y);
  }

  /** 圆形机器人 vs 正方形障碍格：贴边滑行靠这个判定。 */
  function hits(x, y) {
    if (!currentState) return true;
    const grid = currentState.grid;
    const pad = 0; // 圆心不越出最外圈格子中心，坐标永远不会出现负数
    if (x < -pad || y < -pad || x > grid.width - 1 + pad || y > grid.height - 1 + pad) return true;

    for (let i = 0; i < grid.obstacles.length; i += 1) {
      const bx = grid.obstacles[i][0];
      const by = grid.obstacles[i][1];
      const nx = Math.max(bx - 0.5, Math.min(x, bx + 0.5));
      const ny = Math.max(by - 0.5, Math.min(y, by + 0.5));
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy < ROBOT_RADIUS * ROBOT_RADIUS) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- 寻路 */

  /** 8×8 网格上的 A*（四连通），返回格子坐标数组（含起点与终点）。 */
  function findPathCells(from, to) {
    if (!currentState) return [];
    const grid = currentState.grid;
    const key = (x, y) => x + "," + y;
    const startKey = key(from.x, from.y);
    const goalKey = key(to.x, to.y);
    if (startKey === goalKey) return [from];

    const open = [{ x: from.x, y: from.y, g: 0, f: 0 }];
    const cameFrom = new Map();
    const best = new Map([[startKey, 0]]);
    const closed = new Set();

    while (open.length) {
      let pick = 0;
      for (let i = 1; i < open.length; i += 1) if (open[i].f < open[pick].f) pick = i;
      const node = open.splice(pick, 1)[0];
      const nodeKey = key(node.x, node.y);
      if (nodeKey === goalKey) {
        const path = [{ x: node.x, y: node.y }];
        let cursor = nodeKey;
        while (cameFrom.has(cursor)) {
          const prev = cameFrom.get(cursor);
          path.unshift({ x: prev.x, y: prev.y });
          cursor = key(prev.x, prev.y);
        }
        return path;
      }
      closed.add(nodeKey);

      const neighbours = [
        { x: node.x + 1, y: node.y },
        { x: node.x - 1, y: node.y },
        { x: node.x, y: node.y + 1 },
        { x: node.x, y: node.y - 1 },
      ];
      for (const next of neighbours) {
        if (next.x < 0 || next.y < 0 || next.x >= grid.width || next.y >= grid.height) continue;
        if (isBlockedCell(next.x, next.y)) continue;
        const nextKey = key(next.x, next.y);
        if (closed.has(nextKey)) continue;
        const g = node.g + 1;
        if (best.has(nextKey) && best.get(nextKey) <= g) continue;
        best.set(nextKey, g);
        cameFrom.set(nextKey, { x: node.x, y: node.y });
        open.push({ x: next.x, y: next.y, g: g, f: g + Math.abs(to.x - next.x) + Math.abs(to.y - next.y) });
      }
    }
    return [];
  }

  /** 两点之间能不能直着过去（沿途采样做碰撞检查），用来把折线拉直。 */
  function canWalkStraight(a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(2, Math.ceil(dist / 0.12));
    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      if (hits(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }

  /** 格子路径 → 可直接跟随的路点，顺手把能直连的中间点剪掉。 */
  function buildWaypoints(cells, target) {
    const points = cells.map((cell) => ({ x: cell.x, y: cell.y }));
    if (target) points.push(target);

    const out = [];
    let index = 0;
    let guard = 0;
    while (index < points.length - 1 && guard < 200) {
      guard += 1;
      let reach = index + 1;
      for (let probe = points.length - 1; probe > index + 1; probe -= 1) {
        if (canWalkStraight(points[index], points[probe])) {
          reach = probe;
          break;
        }
      }
      out.push(points[reach]);
      index = reach;
    }
    return out;
  }

  /* ---------------------------------------------------------------- 自由移动 */

  let rafId = 0;
  let lastFrame = 0;
  const heldKeys = new Set();

  /** 键盘按住时，让对应的方向按钮也亮一下，知道现在按的是哪个方向。 */
  function markHeldKey(direction, on) {
    els.keys.forEach((button) => {
      if (button.dataset.direction === direction) button.classList.toggle("is-held", on);
    });
  }

  function heldVector() {
    // 摇杆优先：拖出死区以后就按摇杆方向走，键盘方向键先不管用
    if (stick.on && stick.active) return { x: stick.dx, y: stick.dy };

    let x = 0;
    let y = 0;
    if (heldKeys.has("left")) x -= 1;
    if (heldKeys.has("right")) x += 1;
    if (heldKeys.has("up")) y -= 1;
    if (heldKeys.has("down")) y += 1;
    if (!x && !y) return null;
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  /** 按轴分别推进：撞到障碍只停被挡的那一轴，另一轴照走，于是能贴着障碍滑过去。 */
  function nudge(dx, dy) {
    const nx = actor.x + dx;
    const ny = actor.y + dy;
    let moved = false;
    if (!hits(nx, actor.y)) {
      actor.x = nx;
      moved = true;
    }
    if (!hits(actor.x, ny)) {
      actor.y = ny;
      moved = true;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) actor.heading = "right";
      else if (dx < 0) actor.heading = "left";
    } else if (dy !== 0) {
      if (dy > 0) actor.heading = "down";
      else actor.heading = "up";
    }
    return moved;
  }

  function followPath(dt) {
    const next = actor.path[0];
    if (!next) return false;
    const dx = next.x - actor.x;
    const dy = next.y - actor.y;
    const dist = Math.hypot(dx, dy);
    const stepLength = FREE_SPEED * dt;

    if (dist <= stepLength) {
      if (!hits(next.x, next.y)) {
        actor.x = next.x;
        actor.y = next.y;
      }
      actor.path.shift();
    } else {
      const ux = dx / dist;
      const uy = dy / dist;
      if (dist < 0.4) {
        // 靠近拐点时朝目标方向走，姿态跟着拐
        if (Math.abs(ux) > Math.abs(uy)) actor.heading = ux > 0 ? "right" : "left";
        else actor.heading = uy > 0 ? "down" : "up";
      }
      nudge(ux * stepLength, uy * stepLength);
    }
    return true;
  }

  function frame(timestamp) {
    rafId = window.requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.06) : 0;
    lastFrame = timestamp;

    if (!started || mode !== "free" || !actor.node) return;

    let moving = false;
    const dir = heldVector();
    if (dir) {
      actor.path.length = 0;
      moving = nudge(dir.x * FREE_SPEED * dt, dir.y * FREE_SPEED * dt);
    } else if (actor.path.length) {
      moving = followPath(dt);
    }

    if (moving !== actor.walking) {
      setWalking(moving);
      // 停下来的时候补一次面板刷新，否则「状态」会一直停在「行走中」
      if (!moving) updateFacts();
    }

    if (!moving && actor.target) {
      // 走到终点了：补一次状态刷新，否则面板会停在「行走中」
      applyActorTransform();
      applyActorLook();
      updateFacts();
      setFeedback("已到达 (" + actor.x.toFixed(1) + ", " + actor.y.toFixed(1) + ")。", "success");
      actor.target = null;
    }

    if (moving) {
      applyActorTransform();
      applyActorLook();
      recordTrail();
      updateFacts();
    }
  }

  function startLoop() {
    if (rafId) return;
    lastFrame = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  /** 记录走过的格子：格子变了才计步，避免每帧都加。 */
  function recordTrail() {
    const cellX = Math.round(actor.x);
    const cellY = Math.round(actor.y);
    const key = cellX + "," + cellY;
    if (actor.cell === key) return;
    actor.cell = key;
    if (!trail.has(key)) {
      trail.add(key);
      steps += 1;
    }
    paintTrail();
    els.factSteps.textContent = String(steps);
    els.factVisited.textContent = String(trail.size);
    els.board.setAttribute(
      "aria-label",
      "二维巡检地图，" + currentState.grid.width + " 乘 " + currentState.grid.height + " 格，机器人位于第 " +
        cellY + " 行第 " + cellX + " 列"
    );
  }

  /** 只给走过的格子换底色，不动整张地图（自由移动每帧都可能变）。 */
  function paintTrail() {
    els.board.querySelectorAll(".cell--visited").forEach((cell) => {
      if (!trail.has(cell.dataset.x + "," + cell.dataset.y)) cell.classList.remove("cell--visited");
    });
    trail.forEach((key) => {
      const parts = key.split(",");
      const cell = cellAt(Number(parts[0]), Number(parts[1]));
      if (cell) cell.classList.add("cell--visited");
    });
  }

  function cellAt(x, y) {
    return els.board.querySelector('.cell[data-x="' + x + '"][data-y="' + y + '"]');
  }

  function updateFacts() {
    if (mode === "free") {
      els.factPosition.textContent = "(" + actor.x.toFixed(1) + ", " + actor.y.toFixed(1) + ")";
      els.factHeading.textContent = DIRECTIONS[actor.heading] + " " + HEADING_ARROWS[actor.heading];
      els.factStatus.textContent = actor.walking ? "行走中" : "待命";
    } else if (currentState) {
      els.factPosition.textContent = "(" + currentState.robot.x + ", " + currentState.robot.y + ")";
      els.factHeading.textContent =
        DIRECTIONS[currentState.robot.heading] + " " + HEADING_ARROWS[currentState.robot.heading];
      els.factStatus.textContent = STATUS_TEXT[currentState.robot.status] || currentState.robot.status;
    }
  }

  /** 地图上按下时的落点，松开就清空。 */
  let pressPoint = null;

  /** 点地图：走过去。目标点落在格子内任意位置，绕障碍用 A*。 */
  function walkTo(cellX, cellY, offsetX, offsetY) {
    if (!currentState) return;
    if (isBlockedCell(cellX, cellY)) {
      setFeedback("那一格立着「禁止通行」牌，站不了人。", "warn");
      return;
    }

    const startX = Math.round(actor.x);
    const startY = Math.round(actor.y);
    const target = { x: cellX - 0.5 + offsetX, y: cellY - 0.5 + offsetY };

    const cells = findPathCells({ x: startX, y: startY }, { x: cellX, y: cellY });
    if (!cells.length) {
      setFeedback("找不到过去的路：障碍把这一格围住了。", "warn");
      return;
    }

    actor.path = buildWaypoints(cells, target);
    actor.target = target;
    setWalking(true);
    if (actor.node) actor.node.classList.add("is-free");
    setFeedback("正在走向 (" + target.x.toFixed(1) + ", " + target.y.toFixed(1) + ")…");
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
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);

    let label = "第 " + y + " 行第 " + x + " 列，可通行";

    if (isBlockedCell(x, y)) {
      cell.classList.add("cell--block");
      label = "第 " + y + " 行第 " + x + " 列，禁止通行";

      const board = makeBillboard("sign");
      const sprite = cloneSprite("sign");
      if (sprite) {
        board.append(sprite);
      } else {
        // 场景文件没取到时退回纯文字格子（不只靠颜色区分）
        cell.textContent = "禁";
        cell.classList.add("cell--fallback");
      }
      cell.append(board);
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

    actor.node = null; // 旧节点会被一起清掉，下面重新装配
    els.board.replaceChildren(fragment);
    ensureActor();

    if (opts.moved) {
      // 格点模式：让角色从旧位置滑到新位置（.actor 上有 transition）
      actor.node.classList.remove("is-free");
      actor.node.classList.add("is-grid");
      setWalking(true);
      window.clearTimeout(walkTimer);
      walkTimer = window.setTimeout(() => setWalking(false), 420);
    }

    fitStage();
    applyActorTransform();
    applyActorLook();

    els.placeholder.hidden = true;
    els.mapMeta.textContent = mapMeta(state);

    els.factSteps.textContent = String(steps);
    els.factVisited.textContent = String(trail.size);
    updateFacts();
  }

  function mapMeta(state) {
    return state.grid.width + " × " + state.grid.height + " 网格 · 禁止通行 " +
      state.grid.obstacles.length + " 处";
  }

  let walkTimer = 0;

  /* ---------------------------------------------------------------- 界面状态 */

  function setFeedback(message, kind) {
    els.feedback.textContent = message;
    if (kind) els.feedback.dataset.kind = kind;
    else delete els.feedback.dataset.kind;
  }

  function setConnection(state, text) {
    els.conn.dataset.state = state;
    els.connText.textContent = text;
  }

  function syncControls() {
    const noState = !currentState;
    els.keys.forEach((button) => {
      button.disabled = busy || noState;
    });
    // 「重新读取状态」是加载失败后的重试入口，只跟着请求在飞时禁用
    els.reload.disabled = busy;
    els.board.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showPlaceholder(message) {
    els.placeholder.textContent = message;
    els.placeholder.hidden = false;
  }

  function setMode(next) {
    mode = next;
    els.modeBtns.forEach((btn) => {
      const on = btn.dataset.mode === next;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
    });

    if (next === "free") {
      els.controlHint.textContent = "点击地图走过去";
      els.keysHint.innerHTML = "也可以按住 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 连续移动";
      els.footNote.textContent =
        "地图与障碍来自后端接口；自由移动是页面内的运动模拟，切回格点移动会以服务端状态为准。";
      actor.path.length = 0;
      setWalking(false);
      if (actor.node) actor.node.classList.remove("is-grid");
    } else {
      els.controlHint.textContent = "每次点击移动一格";
      els.keysHint.innerHTML = "也可以直接用键盘 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 移动";
      els.footNote.textContent =
        "地图与状态全部来自后端接口，页面不做本地预测；请求失败时不会改变画面中的机器人位置。";
      heldKeys.clear();
      actor.path.length = 0;
      setWalking(false);
      if (currentState) {
        actor.x = currentState.robot.x;
        actor.y = currentState.robot.y;
        actor.heading = currentState.robot.heading;
        applyActorTransform();
        applyActorLook();
      }
      if (actor.node) actor.node.classList.add("is-grid");
    }
    updateFacts();
    syncControls();
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

      actor.x = state.robot.x;
      actor.y = state.robot.y;
      actor.heading = state.robot.heading;
      actor.cell = cellKey(state.robot.x, state.robot.y);

      renderState(state);
      setConnection("online", "服务在线");
      setFeedback(
        jumped
          ? "已读取最新状态（位置变化较大，轨迹已重新开始）"
          : initial
            ? "已连接，可以开始巡检"
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
    if (mode !== "grid" || busy || !currentState) return;
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

      actor.x = state.robot.x;
      actor.y = state.robot.y;
      actor.heading = state.robot.heading;
      actor.cell = cellKey(state.robot.x, state.robot.y);

      renderState(state, { moved: true });
      setConnection("online", "服务在线");
      setFeedback(
        "已向" + DIRECTIONS[direction] + "移动一格，当前位置 (" + state.robot.x + ", " + state.robot.y + ")。",
        "success"
      );
      scheduleSettle();
    } catch (error) {
      const rejected = error.status >= 400 && error.status < 500;
      if (rejected) {
        setFeedback("移动被拒绝：" + describeError(error), "warn");
        setConnection("online", "服务在线");
      } else {
        setFeedback(
          "移动结果未确认：" + describeError(error) + "。最新状态尚未确认，请点「重新读取状态」，不要重复点击方向键。",
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

  // 服务端把「刚完成一次移动」只保持一小段时间，之后自动回到 idle。
  // 这里在移动结束后悄悄再读一次状态，只刷新面板上的坐标/朝向/状态，不动提示文案。
  let settleTimer = 0;

  function scheduleSettle() {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(async () => {
      if (busy || !currentState || mode !== "grid") return;
      try {
        const state = validateState(await requestJSON("/api/state"));
        if (busy) return;
        currentState = state;
        updateFacts();
      } catch (error) {
        // 只是让状态显示落回「待命」，失败就不动，保留上一次的画面
      }
    }, 900);
  }

  function describeError(error) {
    if (error instanceof ApiError) return error.message;
    return "发生未知错误";
  }

  /* ---------------------------------------------------------------- 开场选择 */

  function markPicks() {
    els.picks.forEach((btn) => {
      const on = selection[btn.dataset.pick] === btn.dataset.value;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-checked", String(on));
    });
  }

  function openSetup() {
    els.start.hidden = false;
    started = false;
    setWalking(false);
    actor.path.length = 0;
    heldKeys.clear();
    window.setTimeout(() => els.startGo.focus(), 30);
  }

  function beginRun() {
    started = true;
    els.start.hidden = true;
    applyInputMode();
    try {
      window.localStorage.setItem("patrol.selection", JSON.stringify(selection));
    } catch (error) {
      /* 隐私模式下写不了，忽略 */
    }
    if (currentState) {
      els.mapMeta.textContent = mapMeta(currentState);
    }
    setFeedback("已进入巡检，点地图任意位置或按住方向键开始。", "");
    applyActorTransform();
    applyActorLook();
    startLoop();
    els.board.focus({ preventScroll: true });
  }

  function restoreSelection() {
    try {
      const saved = JSON.parse(window.localStorage.getItem("patrol.selection") || "null");
      if (saved && saved.map) selection.map = saved.map;
      if (saved && saved.robot) selection.robot = saved.robot;
    } catch (error) {
      /* 忽略损坏的本地数据 */
    }
  }

  /* ---------------------------------------------------------------- 绑定 */

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return Boolean(target.isContentEditable);
  }

  /* ---------------------------------------------------------------- 摇杆 */

  const stick = { on: false, active: false, dx: 0, dy: 0 };
  let stickPointer = null;
  let stickLastStep = 0;

  /** 摇杆开着就藏起方向键，换成摇杆面板；提示文案也跟着换。 */
  function applyInputMode() {
    if (els.dpad) els.dpad.hidden = stick.on;
    if (els.stickWrap) els.stickWrap.hidden = !(stick.on && started);
    if (els.keysHint) {
      els.keysHint.innerHTML = stick.on
        ? "摇杆已开启，键盘移动暂停用；关掉摇杆就能继续用 WASD"
        : '也可以按住键盘 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 连续移动';
    }
  }

  function setStick(on) {
    stick.on = Boolean(on);
    if (els.stickToggle) {
      els.stickToggle.setAttribute("aria-checked", stick.on ? "true" : "false");
    }
    releaseStick();
    applyInputMode();
    try {
      window.localStorage.setItem("patrol.stick", stick.on ? "1" : "0");
    } catch (error) {
      /* 隐私模式下写不了，忽略 */
    }
  }

  function restoreStick() {
    let saved = "0";
    try {
      saved = window.localStorage.getItem("patrol.stick") || "0";
    } catch (error) {
      saved = "0";
    }
    setStick(saved === "1");
  }

  function resetStickKnob() {
    if (els.stickKnob) els.stickKnob.style.transform = "";
    if (els.stickBase) els.stickBase.classList.remove("is-active");
    stick.active = false;
    stick.dx = 0;
    stick.dy = 0;
  }

  function releaseStick() {
    if (stickPointer !== null && els.stickBase) {
      try {
        els.stickBase.releasePointerCapture(stickPointer);
      } catch (error) {
        /* 已经释放过了 */
      }
    }
    stickPointer = null;
    resetStickKnob();
  }

  /** 格点模式下摇杆当成「推一下走一格」，用冷却时间挡掉连发。 */
  function stickStep(dx, dy) {
    const now = Date.now();
    if (now - stickLastStep < 420) return;
    stickLastStep = now;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (Math.abs(dx) > 0.05) move(dx > 0 ? "right" : "left");
    } else {
      move(dy > 0 ? "down" : "up");
    }
  }

  function trackStick(event) {
    if (!els.stickBase || stickPointer === null) return;
    const rect = els.stickBase.getBoundingClientRect();
    const maxRadius = rect.width * 0.33;
    let dx = event.clientX - (rect.left + rect.width / 2);
    let dy = event.clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    if (els.stickKnob) {
      els.stickKnob.style.transform = "translate(" + dx.toFixed(1) + "px, " + dy.toFixed(1) + "px)";
    }

    const magnitude = Math.min(dist / maxRadius, 1);
    if (magnitude < 0.22) {
      stick.active = false;
      return;
    }

    const len = Math.hypot(dx, dy) || 1;
    // 拖得越远走得越快：最小留 35% 速度，推到边缘就是全速
    const speed = 0.35 + 0.65 * Math.min((magnitude - 0.22) / 0.78, 1);
    stick.active = true;
    stick.dx = (dx / len) * speed;
    stick.dy = (dy / len) * speed;

    if (mode === "grid") {
      stickStep(stick.dx, stick.dy);
      return;
    }
    startLoop();
  }

  function bindStick() {
    if (!els.stickBase) return;

    els.stickBase.addEventListener("pointerdown", (event) => {
      if (!started) return;
      event.preventDefault();
      stickPointer = event.pointerId;
      els.stickBase.classList.add("is-active");
      try {
        els.stickBase.setPointerCapture(stickPointer);
      } catch (error) {
        /* 抓不住也还能用 pointermove */
      }
      trackStick(event);
    });

    els.stickBase.addEventListener("pointermove", (event) => {
      if (stickPointer === null || event.pointerId !== stickPointer) return;
      event.preventDefault();
      trackStick(event);
    });

    ["pointerup", "pointercancel", "pointerleave"].forEach((name) => {
      els.stickBase.addEventListener(name, (event) => {
        if (stickPointer === null) return;
        if (typeof event.pointerId === "number" && event.pointerId !== stickPointer) return;
        releaseStick();
      });
    });

    if (els.stickToggle) {
      els.stickToggle?.addEventListener("click", () => setStick(!stick.on));
    }
  }
  const KEY_TO_DIRECTION = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    s: "down",
    a: "left",
    d: "right",
    W: "up",
    S: "down",
    A: "left",
    D: "right",
  };

  /** 右侧面板收起 / 展开；状态记在 localStorage，刷新后保持。 */
  function setSide(collapsed) {
    els.layout.classList.toggle("is-collapsed", collapsed);
    els.sideToggle.setAttribute("aria-expanded", String(!collapsed));
    els.sideToggleGlyph.textContent = collapsed ? "‹" : "›";
    els.sideToggleText.textContent = collapsed ? "展开" : "收起";
    els.sideToggle.title = collapsed ? "展开右侧面板" : "收起右侧面板";
    els.sideToggle.setAttribute("aria-label", els.sideToggle.title);
    try {
      localStorage.setItem("patrol.side", collapsed ? "collapsed" : "open");
    } catch (error) {
      /* 隐私模式下写不进去就算了 */
    }
    // 面板宽度变了，地图的格子尺寸要重新算
    requestAnimationFrame(fitStage);
    window.setTimeout(fitStage, 300);
  }

  function restoreSide() {
    let saved = "";
    try {
      saved = localStorage.getItem("patrol.side") || "";
    } catch (error) {
      saved = "";
    }
    setSide(saved === "collapsed");
  }

  function bindEvents() {
    // 窗口尺寸变化最先绑，后面任何一处抛错都不会影响地图重排
    let resizeFrame = 0;
    const refit = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => fitStage({ instant: true }));
    };
    window.addEventListener("resize", refit);

    // resize 事件偶尔拿到的还是旧布局（尤其是全屏切换），再挂一层观察器兜底
    if (typeof ResizeObserver === "function" && els.stage) {
      const observer = new ResizeObserver(refit);
      observer.observe(els.stage);
      observer.observe(els.board);
    }
    bindStick();
    els.sideToggle.addEventListener("click", () => {
      setSide(!els.layout.classList.contains("is-collapsed"));
    });
    // 方向键：自由模式按住持续走，格点模式点一下走一格
    els.keys.forEach((button) => {
      const direction = button.dataset.direction;

      button.addEventListener("pointerdown", (event) => {
        if (mode !== "free" || !started) return;
        event.preventDefault();
        button.classList.add("is-held");
        heldKeys.add(direction);
        startLoop();
      });
      const release = () => {
        button.classList.remove("is-held");
        heldKeys.delete(direction);
      };
      button.addEventListener("pointerup", release);
      button.addEventListener("pointerleave", release);
      button.addEventListener("pointercancel", release);

      button.addEventListener("click", () => {
        if (mode !== "grid") return;
        move(direction);
      });
    });

    els.modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    // 点地图：自由模式下走过去
    // 地图上按住就能走：按下立刻出发，按住拖动时换成指针下面的那个格子
    const cellUnder = (clientX, clientY) => {
      const el = document.elementFromPoint(clientX, clientY);
      return el && el.closest ? el.closest(".cell") : null;
    };

    const pointIn = (cell, clientX, clientY) => {
      if (!cell || !cell.dataset.x) return null;
      const rect = cell.getBoundingClientRect();
      const clamp = (value) => Math.max(0.12, Math.min(0.88, value));
      return {
        cell,
        cellX: Number(cell.dataset.x),
        cellY: Number(cell.dataset.y),
        offsetX: clamp(rect.width ? (clientX - rect.left) / rect.width : 0.5),
        offsetY: clamp(rect.height ? (clientY - rect.top) / rect.height : 0.5),
      };
    };

    els.board.addEventListener("pointerdown", (event) => {
      if (!started || mode !== "free" || !currentState) return;
      if (event.button > 0) return;
      const point = pointIn(event.target.closest ? event.target.closest(".cell") : null, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      pressPoint = point;
      try {
        els.board.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 没有 pointer capture 也能用，只是拖出地图后会断 */
      }
      walkTo(point.cellX, point.cellY, point.offsetX, point.offsetY);
    });

    els.board.addEventListener("pointermove", (event) => {
      if (!pressPoint) return;
      // 用元素命中判断：被 capture 到 board 上的事件 target 不再是格子
      const cell = cellUnder(event.clientX, event.clientY);
      if (!cell || !cell.dataset.x) return;
      if (cell === pressPoint.cell) return;
      const point = pointIn(cell, event.clientX, event.clientY);
      if (!point) return;
      pressPoint = point;
      walkTo(point.cellX, point.cellY, point.offsetX, point.offsetY);
    });

    const endPress = () => {
      pressPoint = null;
    };
    els.board.addEventListener("pointerup", endPress);
    els.board.addEventListener("pointercancel", endPress);
    els.reload.addEventListener("click", () => {
      // 手动重新读取＝重新开始一轮巡检，把这一轮的痕迹和步数一起清掉
      steps = 0;
      trail = new Set();
      actor.cell = "";
      paintTrail();
      els.factSteps.textContent = "0";
      els.factVisited.textContent = "0";
      loadState({ initial: !currentState });
    });
    els.openScene.addEventListener("click", openSetup);
    els.startGo.addEventListener("click", beginRun);

    els.picks.forEach((btn) => {
      btn.addEventListener("click", () => {
        selection[btn.dataset.pick] = btn.dataset.value;
        markPicks();
      });
    });

    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!started || isTypingTarget(event.target)) return;
      if (!els.start.hidden) return;
      if (stick.on) return;

      const direction = KEY_TO_DIRECTION[event.key];
      if (!direction) return;
      event.preventDefault();

      if (mode === "grid") {
        if (!event.repeat) move(direction);
        return;
      }
      heldKeys.add(direction);
      markHeldKey(direction, true);
      startLoop();
    });

    window.addEventListener("keyup", (event) => {
      const direction = KEY_TO_DIRECTION[event.key];
      if (!direction) return;
      heldKeys.delete(direction);
      markHeldKey(direction, false);
    });

    window.addEventListener("blur", () => {
      heldKeys.clear();
      els.keys.forEach((button) => button.classList.remove("is-held"));
    });
  }

  function init() {
    els.footNote = document.getElementById("foot-note");
    restoreSelection();
    markPicks();
    bindEvents();
    restoreStick();
    restoreSide();
    syncControls();
    setMode("free");
    loadState({ initial: true });

    // 模型异步取：取到以后重画一遍，角色和牌子才会立到地图上
    loadSprites().then((ok) => {
      if (!ok) return;
      if (els.robotPreview && sprites.dog) {
        const preview = cloneSprite("dog");
        if (preview) els.robotPreview.append(preview);
      }
      if (currentState) renderState(currentState);
    });
  }

  init();
})();
