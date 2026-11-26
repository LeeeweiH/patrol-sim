/**
 * 智能巡检机器人 · 前端交互
 *
 * 两套操控方式，共用同一张地图和同一台机器人：
 *
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
  /** 机体目录：半径与速度跟后端 /api/robots 一致，改这里记得同步 sim.py。 */
  const ROBOTS = {
    go2: { sprite: "dog", radius: 0.26, speed: 3.2, label: "机器狗" },
    rover: { sprite: "rover", radius: 0.34, speed: 3.8, label: "轮式巡检车" },
  };

  function robotSpec() {
    return ROBOTS[selection.robot] || ROBOTS.go2;
  }

  function robotRadius() {
    return robotSpec().radius;
  }

  function robotSpeed() {
    return robotSpec().speed;
  }

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
    routeEditBtn: document.getElementById("route-edit"),
    routeEditLabel: document.getElementById("route-edit-label"),
    routeConfirm: document.getElementById("route-confirm"),
    mapTally: document.getElementById("map-tally"),
    tallyTotal: document.getElementById("tally-total"),
    tallyDone: document.getElementById("tally-done"),
    factPosition: document.getElementById("fact-position"),
    factHeading: document.getElementById("fact-heading"),
    factStatus: document.getElementById("fact-status"),
    factSteps: document.getElementById("fact-steps"),
    factVisited: document.getElementById("fact-visited"),
    feedback: document.getElementById("feedback"),
    reload: document.getElementById("reload"),
    manualBtn: document.getElementById("patrol-manual"),
    manualLabel: document.getElementById("patrol-manual-label"),
    anomalyBtn: document.getElementById("anomaly-edit"),
    anomalyLabel: document.getElementById("anomaly-edit-label"),
    palette: document.getElementById("anomaly-palette"),
    chips: document.getElementById("anomaly-chips"),
    tallyAnomaly: document.getElementById("tally-anomaly"),
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
    sensorToggle: document.getElementById("sensor-toggle"),
    traceToggle: document.getElementById("trace-toggle"),
    reportsOpen: document.getElementById("reports-open"),
    reportsSheet: document.getElementById("reports-sheet"),
    reportsClose: document.getElementById("reports-close"),
    reportsBody: document.getElementById("reports-body"),
    reportsHint: document.getElementById("reports-hint"),
    factScanned: document.getElementById("fact-scanned"),
    openScene: document.getElementById("open-scene"),
    start: document.getElementById("start"),
    startGo: document.getElementById("start-go"),
    robotPreview: document.getElementById("robot-preview"),
    roverPreview: document.getElementById("rover-preview"),
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
  let trackPoints = [];
  let traceOn = true;
  let traceLayer = null;
  let tracePath = null;

  /** 开场选择：现在各只有一个选项，但结构按「以后会加」来写。 */
  const selection = { map: "standard", robot: "go2" };
  // 后端当前场景 id，切地图时用它判断要不要发 /api/scene
  let currentSceneId = "standard";
  let started = false;
  // 只保留自由移动（格点移动已移除）。这里仍是常量而不是删掉变量：
  // 少数旧分支用 mode 做守卫，留着可以保证它们永远不可达，也方便以后加别的模式。
  const mode = "free";

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

  const sprites = { dog: null, rover: null, sign: null, crate: null };

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

      // 入口出口缺失时不算致命错误：地图照常跑，只是少了两个地标
      sprites.crate = holder.querySelector("#crate");
      sprites.rover = holder.querySelector("#rover");
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
    // 重绘地图会把角色节点从 DOM 里摘掉，但引用还在；这里必须判 isConnected，
    // 否则换机体之后拿到的还是上一次那个（比如一直是机器狗）。
    const kind = robotSpec().sprite;
    if (actor.node && actor.node.isConnected) {
      // 换了机体但地图没重绘：就地换掉立牌里的精灵和主题类
      if (actor.kind === kind) return actor.node;
      const billboard = actor.node.querySelector(".billboard");
      const stale = billboard && billboard.querySelector(".sprite");
      const fresh = cloneSprite(kind);
      if (billboard && stale && fresh) {
        stale.replaceWith(fresh);
        billboard.classList.remove("billboard--dog", "billboard--rover");
        billboard.classList.add("billboard--" + kind);
        actor.sprite = fresh;
        actor.kind = kind;
      }
      return actor.node;
    }
    actor.node = null;
    actor.sprite = null;
    actor.facing = null;
    actor.tag = null;

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
    const billboard = makeBillboard(robotSpec().sprite);
    const sprite = cloneSprite(robotSpec().sprite);
    if (sprite) billboard.append(sprite);
    const tag = document.createElement("span");
    tag.className = "unit-tag";
    tag.textContent = "机";
    billboard.append(tag);

    node.append(ground, billboard);
    els.board.append(node);

    actor.node = node;
    actor.kind = kind;
    actor.sprite = sprite;
    actor.facing = facing;
    actor.tag = tag;
    return node;
  }

  function applyActorTransform() {
    if (!actor.node) return;
    const prevX = typeof actor.lastX === "number" ? actor.lastX : actor.x;
    actor.vx = actor.x - prevX;
    actor.lastX = actor.x;
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
      // 头朝哪边看水平位移：向右为正、向左为负；静止时保留上一次的朝向
      if (typeof actor.vx === "number" && Math.abs(actor.vx) > 0.002) {
        actor.flip = actor.vx < 0 ? -1 : 1;
      }
      actor.sprite.style.setProperty("--flip", String(actor.flip || HEADING_FLIP[actor.heading]));
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
      const radius = robotRadius();
      if (dx * dx + dy * dy < radius * radius) return true;
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

  /**
   * 线段与轴对齐矩形是否相交（slab 法）。
   * 用精确几何判断，不用采样，拐角不会漏。
   */
  function segmentHitsRect(px, py, qx, qy, minX, minY, maxX, maxY) {
    const dx = qx - px;
    const dy = qy - py;
    let t0 = 0;
    let t1 = 1;

    if (Math.abs(dx) < 1e-9) {
      if (px < minX || px > maxX) return false;
    } else {
      let ta = (minX - px) / dx;
      let tb = (maxX - px) / dx;
      if (ta > tb) {
        const swap = ta;
        ta = tb;
        tb = swap;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }

    if (Math.abs(dy) < 1e-9) {
      if (py < minY || py > maxY) return false;
    } else {
      let ta = (minY - py) / dy;
      let tb = (maxY - py) / dy;
      if (ta > tb) {
        const swap = ta;
        ta = tb;
        tb = swap;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }

    return true;
  }

  /**
   * 扫掠碰撞：半径 ROBOT_RADIUS 的圆沿 a→b 扫过去，会不会碰到障碍或越界。
   * 把每个障碍方块按半径膨胀成 Minkowski 矩形再做线段求交，
   * 等价于圆的连续碰撞检测——逐点采样会在拐角处漏判，这里不会。
   */
  function blockedAlong(ax, ay, bx, by) {
    if (!currentState) return true;
    const grid = currentState.grid;
    const r = robotRadius();

    if (Math.min(ax, bx) < 0 || Math.max(ax, bx) > grid.width - 1) return true;
    if (Math.min(ay, by) < 0 || Math.max(ay, by) > grid.height - 1) return true;

    for (let i = 0; i < grid.obstacles.length; i += 1) {
      const ox = grid.obstacles[i][0];
      const oy = grid.obstacles[i][1];
      const minX = ox - 0.5 - r;
      const maxX = ox + 0.5 + r;
      const minY = oy - 0.5 - r;
      const maxY = oy + 0.5 + r;
      if (segmentHitsRect(ax, ay, bx, by, minX, minY, maxX, maxY)) return true;
    }
    return false;
  }

  /** 两点之间能不能直着过去（精确扫掠判定），用来把折线拉直。 */
  function canWalkStraight(a, b) {
    return !blockedAlong(a.x, a.y, b.x, b.y);
  }

  /**
   * 格子路径 → 可直接跟随的路点。
   * 起点用角色的真实坐标（不是四舍五入后的格子），否则半路改目标时
   * 第一段会从一个「假起点」出发，斜着切过障碍。
   */
  function buildWaypoints(cells, target) {
    const points = [{ x: actor.x, y: actor.y }];
    for (let i = 0; i < cells.length; i += 1) points.push({ x: cells[i].x, y: cells[i].y });
    if (target) points.push(target);

    const out = [];
    let index = 0;
    let guard = 0;
    while (index < points.length - 1 && guard < 400) {
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

  /**
   * 走一步。先整段做一次精确扫掠；被挡就退化成两轴分别推进，
   * 于是贴墙时还能顺着另一轴滑走。全程不瞬移，不会穿模。
   */
  function advance(dx, dy) {
    if (!currentState) return false;
    const ax = actor.x;
    const ay = actor.y;
    if (!blockedAlong(ax, ay, ax + dx, ay + dy)) {
      actor.x = ax + dx;
      actor.y = ay + dy;
      return true;
    }
    let moved = false;
    if (Math.abs(dx) > 1e-9 && !blockedAlong(ax, ay, ax + dx, ay)) {
      actor.x = ax + dx;
      moved = true;
    }
    if (Math.abs(dy) > 1e-9 && !blockedAlong(actor.x, ay, actor.x, ay + dy)) {
      actor.y = ay + dy;
      moved = true;
    }
    return moved;
  }

  /** 按轴分别推进：撞到障碍只停被挡的那一轴，另一轴照走，于是能贴着障碍滑过去。 */
  function nudge(dx, dy) {
    const moved = advance(dx, dy);
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
    const stepLength = robotSpeed() * dt;

    if (dist <= stepLength) {
      // 最后一步也要经过扫掠测试，不能直接赋值瞬移过去
      const arrived = advance(dx, dy);
      if (arrived) actor.path.shift();
      else actor.path.length = 0;
      return arrived;
    } else {
      const ux = dx / dist;
      const uy = dy / dist;
      if (dist < 0.4) {
        // 靠近拐点时朝目标方向走，姿态跟着拐
        if (Math.abs(ux) > Math.abs(uy)) actor.heading = ux > 0 ? "right" : "left";
        else actor.heading = uy > 0 ? "down" : "up";
      }
      const walked = advance(ux * stepLength, uy * stepLength);
      if (!walked) actor.path.length = 0;
      return walked;
    }
  }

  // 自由模式下角色每帧都在动，但 updateScan/paintTrack 原本只在 renderState 里跑，
  // 于是雷达扇形和轨迹会「停在上一帧」。这里按 90ms 或换格时补刷一次，既跟手又不掉帧。
  let lastScanPaint = 0;
  let lastScanCell = "";
  /**
   * 导图层的尺寸只在这里统一算：resize / 全屏切换 / 右栏折叠后，
   * 扫描扇形和轨迹线都会跟着重算一遍，不会出现「放大后消失、点一下才回来」。
   */
  let lastBoardW = 0;
  let lastBoardH = 0;

  function layoutOverlays() {
    if (!els.board) return;
    const width = els.board.clientWidth;
    const height = els.board.clientHeight;
    if (!width || !height) return;
    const box = "0 0 " + width + " " + height;
    [scanLayerElement(), traceLayerElement()].forEach((svg) => {
      if (!svg) return;
      svg.setAttribute("viewBox", box);
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("preserveAspectRatio", "none");
    });
    // 尺寸变了，角色的像素坐标也得按新格宽重算，否则会出现「格子变了、狗还站在老地方」
    if (actor.node) {
      applyActorTransform();
      applyActorLook();
    }
    updateScan();
    paintTrack();
    paintTrail();
  }

  function refreshOverlays(timestamp, force) {
    // 兜底自检：浏览器偶尔不发 resize（iframe 内嵌、某些全屏切换），
    // 只靠事件会让导图层停在旧尺寸上——这里每帧比一次尺寸，变了就重排。
    if (els.board) {
      const bw = els.board.clientWidth;
      const bh = els.board.clientHeight;
      if (bw && bh && (bw !== lastBoardW || bh !== lastBoardH)) {
        lastBoardW = bw;
        lastBoardH = bh;
        layoutOverlays();
        lastScanPaint = timestamp || 0;
        return;
      }
    }
    const cell = Math.round(actor.x) + "," + Math.round(actor.y);
    if (!force && cell === lastScanCell && timestamp - lastScanPaint < 90) return;
    lastScanCell = cell;
    lastScanPaint = timestamp || 0;
    updateScan();
    paintTrack();
  }

  function frame(timestamp) {
    rafId = window.requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.06) : 0;
    lastFrame = timestamp;

    if (!started || mode !== "free" || !actor.node) return;

    let moving = false;
    const dir = heldVector();
    if (dir) {
      if (patrol.on) stopPatrol("已停止自动巡检：转手动控制。");
      actor.path.length = 0;
      const sprint = robotSpeed() * dt;
      moving = nudge(dir.x * sprint, dir.y * sprint);
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
      refreshOverlays(timestamp, true);
      const arrived = "(" + actor.x.toFixed(1) + ", " + actor.y.toFixed(1) + ")";
      if (patrol.on) {
        setFeedback("巡检中 " + patrol.done + "/" + patrol.total + "：已到 " + arrived, "success");
      } else {
        setFeedback("已到达 " + arrived + "。", "success");
      }
      actor.target = null;
    }

    // 自动巡检：静止且没有目标时，取下一个点位
    if (patrol.on && !moving && !actor.target) patrolNext();

    if (moving) {
      applyActorTransform();
      applyActorLook();
      recordTrail();
      pushTrackPoint(actor.x, actor.y);
      updateFacts();
      refreshOverlays(timestamp);
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
    checkManualHit(cellX, cellY);
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

  /** 轨迹采样点：同一处不重复记，太长就丢最早的点。 */
  function pushTrackPoint(x, y) {
    const last = trackPoints[trackPoints.length - 1];
    // 切地图 / 重新读取 / 任何瞬移都会让相邻两点隔很远，直接连起来就是一条横跨全图的假线，
    // 所以超过 3 格就当作新的一段轨迹重新开始。
    if (last && Math.hypot(x - last.x, y - last.y) > 3) trackPoints = [];
    if (last && Math.abs(last.x - x) < 0.02 && Math.abs(last.y - y) < 0.02) return;
    trackPoints.push({ x: x, y: y });
    if (trackPoints.length > 2400) trackPoints.shift();
    paintTrack();
  }

  /** 轨迹线画在地图坐标系里，跟平面一起倾斜，所以看起来是贴着地面的折线。 */
  function traceLayerElement() {
    if (traceLayer && traceLayer.isConnected) return traceLayer;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "trace");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    els.board.append(svg);
    traceLayer = svg;
    tracePath = path;
    return svg;
  }

  function paintTrack() {
    if (!els.board) return;
    const svg = traceLayerElement();
    const metrics = currentState ? gridMetrics() : null;
    if (!metrics) return;
    svg.setAttribute("viewBox", "0 0 " + els.board.clientWidth + " " + els.board.clientHeight);
    const enough = trackPoints.length > 1;
    svg.classList.toggle("is-on", traceOn && enough);
    if (!traceOn || !enough) {
      tracePath.setAttribute("d", "");
      return;
    }
    let d = "";
    for (let i = 0; i < trackPoints.length; i += 1) {
      const pt = trackPoints[i];
      const px = metrics.originX + pt.x * metrics.step;
      const py = metrics.originY + pt.y * metrics.step;
      d += (i === 0 ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1);
    }
    tracePath.setAttribute("d", d);
  }

  function setTrace(on) {
    traceOn = Boolean(on);
    try {
      window.localStorage.setItem("patrol.trace", traceOn ? "1" : "0");
    } catch (err) {
      /* 隐私模式写不了 localStorage，忽略 */
    }
    if (els.traceToggle) {
      els.traceToggle.setAttribute("aria-checked", traceOn ? "true" : "false");
      els.traceToggle.classList.toggle("is-on", traceOn);
    }
    paintTrack();
  }

  function restoreTrace() {
    let saved = null;
    try {
      saved = window.localStorage.getItem("patrol.trace");
    } catch (err) {
      saved = null;
    }
    setTrace(saved === null ? true : saved === "1");
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
  /** 点下去立刻给个回执：目标格自己闪一个朝下的箭头，落定后淡出。
   *  直接挂在格子上，省掉坐标换算——格子本身在 3D 里，箭头跟着它走就不会偏。 */
  function flashTarget(cellX, cellY, offsetX, offsetY) {
    const cell = els.board.querySelector('.cell[data-x="' + cellX + '"][data-y="' + cellY + '"]');
    if (!cell) return;
    // 箭头落在「真正的落点」上，而不是格心：落点 = 格内相对位置，和走过去的坐标一致
    const tx = offsetX === undefined ? 0.5 : offsetX;
    const ty = offsetY === undefined ? 0.5 : offsetY;
    // 用像素而不是百分比：格子只有 aspect-ratio 没有显式高度，
    // 百分比 top 在 ::after 上解析出来的基准会跑偏
    cell.style.setProperty("--tx", (tx * cell.offsetWidth).toFixed(1) + "px");
    cell.style.setProperty("--ty", (ty * cell.offsetHeight).toFixed(1) + "px");
    cell.classList.remove("is-tapped");
    void cell.offsetWidth; // 连续点同一格也能重播动画
    cell.classList.add("is-tapped");
    window.setTimeout(() => cell.classList.remove("is-tapped"), 620);
  }

  function walkTo(cellX, cellY, offsetX, offsetY, options) {
    if (!currentState) return;
    // 手动点地图说明用户要自己开，先把自动巡检停掉
    if (patrol.on && !(options && options.silent)) stopPatrol("已停止自动巡检：转手动控制。");
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
    if (!(options && options.silent)) {
      if (!(options && options.silent)) flashTarget(cellX, cellY, offsetX, offsetY);
      setFeedback("正在走向 (" + target.x.toFixed(1) + ", " + target.y.toFixed(1) + ")…");
    }
  }

  /* ---------------------------------------------------------------- 自动巡检 */

  const patrolBtn = document.getElementById("patrol-toggle");
  const patrolLabel = document.getElementById("patrol-label");
  const patrolReportBtn = document.getElementById("patrol-report");

  /* ---- 手动标定的巡检顺序：用户在标定模式下依次点地板 ---- */
  let customRoute = [];
  let routeEdit = false;
  const ROUTE_KEY = "patrol.route.v1";

    const patrol = {
    on: false,
    queue: [],
    total: 0,
    done: 0,
    skipped: 0,
    startedAt: 0,
    steps0: 0,
    visited0: 0,
    lastSummary: null,
    current: null,
  };

  /**
   * 候选点位：按行蛇形采样，每两格取一点，跳过装了禁止通行牌的格子。
   * 密度刻意比格子稀疏，走起来像巡视，而不是逐格扫描。
   */
  /** 候选点位：铺满地图的稀疏采样（每两格一个），避开禁行牌。 */
  function patrolCandidates(state) {
    const width = state.grid.width;
    const height = state.grid.height;
    const points = [];
    const push = (x, y) => {
      if (isBlockedCell(x, y)) return;
      if (points.some((p) => p.x === x && p.y === y)) return;
      points.push({ x: x, y: y });
    };
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) push(x, y);
    }
    // 宽高是奇数时，末行/末列不会被两格步长覆盖，补一排，边上那圈也巡得到
    if ((height - 1) % 2 !== 0) {
      for (let x = 0; x < width; x += 2) push(x, height - 1);
    }
    if ((width - 1) % 2 !== 0) {
      for (let y = 0; y < height; y += 2) push(width - 1, y);
    }
    return points;
  }

  /**
   * 巡检顺序自己规划：从当前位置出发，每次挑「真的走得最近」的未巡检点。
   * 距离用 A* 的路径格数，不是直线距离——绕开牌子之后的远近才是关键；
   * 一个点都到不了（被围死）就跳过，避免整轮卡住。
   */
  function planPatrolRoute(state, start) {
    const remaining = patrolCandidates(state);
    const route = [];
    const from = { x: Math.round(start.x), y: Math.round(start.y) };
    let cursor = from;
    while (remaining.length) {
      let bestIndex = -1;
      let bestCost = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const point = remaining[i];
        const path = findPathCells(cursor.x, cursor.y, point.x, point.y);
        const cost = path && path.length ? path.length : Infinity;
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;
      const next = remaining.splice(bestIndex, 1)[0];
      route.push(next);
      cursor = next;
    }
    return route;
  }

  function setPatrolButton(on) {
    if (!patrolBtn) return;
    patrolBtn.classList.toggle("is-on", on);
    patrolBtn.setAttribute("aria-pressed", String(on));
    if (patrolLabel) patrolLabel.textContent = on ? "停止巡检" : "自动巡检";
    if (on && patrolReportBtn) patrolReportBtn.hidden = true;
  }

  /** 取下一个点位；走不到就跳过，全部走完就收尾。 */
  function patrolNext() {
    if (!patrol.on) return;
    if (!patrol.queue.length) {
      finishPatrol();
      return;
    }
    const point = patrol.queue.shift();

    // 最近的候选点可能就是脚下这一格：直接算作已巡检，别在原地等一个永远走不到的终点
    if (Math.abs(point.x - actor.x) < 0.35 && Math.abs(point.y - actor.y) < 0.35) {
      patrol.done += 1;
      patrolNext();
      return;
    }

    walkTo(point.x, point.y, 0.5, 0.5, { silent: true });
    if (actor.target) {
      patrol.done += 1;
      patrol.current = point;
      paintPatrolMarks();
      updateTally(patrol.total, patrol.done);
      setFeedback(
        "巡检中 " + patrol.done + "/" + patrol.total + "：前往第 " + patrol.done + " 个点位…"
      );
    } else {
      patrol.skipped += 1;
      patrolNext();
    }
  }

  /** 巡检结束：给出步数、覆盖率与用时，并把导出按钮亮出来。 */
  function finishPatrol() {
    const seconds = ((performance.now() - patrol.startedAt) / 1000).toFixed(1);
    // 注意：这里不能叫 steps，会和模块级的 let steps 撞名字，导致 TDZ 报错
    const movedSteps = Math.max(0, steps - patrol.steps0);
    const visited = Math.max(0, trail.size - patrol.visited0);
    patrol.on = false;
    patrol.queue = [];
    patrol.current = null;
    setPatrolButton(false);
    clearPatrolMarks();
    updateTally(patrol.total, patrol.done);
    patrol.lastSummary = {
      seconds: seconds,
      steps: movedSteps,
      visited: visited,
      points: patrol.done,
      total: patrol.total,
    };
    if (patrolReportBtn) patrolReportBtn.hidden = false;
    setFeedback(
      "巡检完成：" +
        patrol.done +
        " 个点位，用时 " +
        seconds +
        " 秒，移动 " +
        movedSteps +
        " 步，新覆盖 " +
        visited +
        " 格。" +
        (patrol.skipped ? "（跳过 " + patrol.skipped + " 个走不到的点位）" : ""),
      "success"
    );
  }

  /* ---- 异常点位：火 / 坑 / 自定义字，红三角标 ---- */
  const ANOMALY_KEY = "patrol.anomalies.v1";
  const ANOMALY_TYPE_KEY = "patrol.anomalyTypes.v1";
  const ANOMALY_TYPES = ["火", "坑"];
  let customTypes = [];        // 用户自己加的类型，持久化在 localStorage

  function loadCustomTypes() {
    try {
      const raw = window.localStorage.getItem(ANOMALY_TYPE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      customTypes = Array.isArray(arr) ? arr.filter((t) => typeof t === "string" && t) : [];
    } catch (error) {
      customTypes = [];
    }
  }

  function saveCustomTypes() {
    try {
      window.localStorage.setItem(ANOMALY_TYPE_KEY, JSON.stringify(customTypes));
    } catch (error) {
      /* 存不了就算了，本页仍然可用 */
    }
  }

  /** 调色板要显示的全部类型：预设 + 自定义 + 已放置过但不在前两者里的 */
  function allAnomalyTypes() {
    const out = [];
    ANOMALY_TYPES.concat(customTypes).forEach((t) => {
      if (out.indexOf(t) === -1) out.push(t);
    });
    anomalies.forEach((a) => {
      if (out.indexOf(a.type) === -1) out.push(a.type);
    });
    return out;
  }
  let anomalies = [];          // [{ x, y, type, detected }]
  let anomalyEdit = false;     // 「标定异常点位」模式
  let armedType = ANOMALY_TYPES[0];
  let anomalyDrag = null;      // 拖动中的那个 chip

  function loadAnomalies() {
    try {
      const raw = window.localStorage.getItem(ANOMALY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      anomalies = Array.isArray(parsed)
        ? parsed.filter((a) => a && Number.isFinite(a.x) && Number.isFinite(a.y) && typeof a.type === "string")
        : [];
    } catch (error) {
      anomalies = [];
    }
  }

  function saveAnomalies() {
    try {
      window.localStorage.setItem(ANOMALY_KEY, JSON.stringify(anomalies));
    } catch (error) {
      /* 存不了就算了，不影响本轮 */
    }
  }

  function anomalyAt(x, y) {
    return anomalies.find((a) => a.x === x && a.y === y) || null;
  }

  function updateAnomalyTally() {
    if (!els.tallyAnomaly) return;
    els.tallyAnomaly.textContent = String(anomalies.filter((a) => a.detected).length);
  }

  /** 把异常标画到格子上（每次重建地图后调用） */
  function renderAnomalies() {
    if (!els.board) return;
    els.board.querySelectorAll(".cell .anomaly").forEach((node) => node.remove());
    anomalies.forEach((a) => {
      const cell = els.board.querySelector('.cell[data-x="' + a.x + '"][data-y="' + a.y + '"]');
      if (!cell) return;
      const badge = document.createElement("span");
      badge.className = "anomaly";
      badge.textContent = a.type;
      badge.setAttribute("aria-hidden", "true");
      cell.append(badge);
    });
    updateAnomalyTally();
    detectAnomalies();
  }

  function toggleAnomaly(cellX, cellY, type) {
    if (isBlockedCell(cellX, cellY, currentState ? obstacleSet() : new Set())) {
      setFeedback("那一格立着「禁止通行」牌，不能放异常。", "warn");
      return;
    }
    const found = anomalyAt(cellX, cellY);
    if (found) {
      anomalies = anomalies.filter((a) => a !== found);
      setFeedback("移除了 (" + cellX + ", " + cellY + ") 的「" + found.type + "」。", "info");
    } else {
      anomalies = anomalies.concat([{ x: cellX, y: cellY, type: type, detected: false }]);
      setFeedback("(" + cellX + ", " + cellY + ") 放了一个「" + type + "」。", "success");
    }
    saveAnomalies();
    renderAnomalies();
  }

  function losClear(ax, ay, bx, by, blocked) {
    const dist = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.ceil(dist / 0.1));
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const gx = Math.round(ax + (bx - ax) * t);
      const gy = Math.round(ay + (by - ay) * t);
      if (blocked.has(gx + "," + gy)) return false;
    }
    return true;
  }

  /** 雷达扫到异常格中心 → 计一次「已发现」 */
  function emitAnomalyVisibility(visible) {
    if (!els.board) return;
    els.board.querySelectorAll(".cell .anomaly").forEach((node) => {
      const cell = node.parentElement;
      const key = cell.dataset.x + "," + cell.dataset.y;
      node.classList.toggle("is-near", visible.has(key));
    });
  }

  function detectAnomalies() {
    if (!currentState || !scanOn || !anomalies.length) {
      emitAnomalyVisibility(new Set());
      return;
    }
    const blocked = obstacleSet();
    const visible = new Set();
    let changed = false;
    anomalies.forEach((a) => {
      if (Math.hypot(a.x - actor.x, a.y - actor.y) > SCAN_RANGE) return;
      if (!losClear(actor.x, actor.y, a.x, a.y, blocked)) return;
      visible.add(a.x + "," + a.y);
      if (!a.detected) {
        a.detected = true;
        changed = true;
        setFeedback("雷达发现异常：(" + a.x + ", " + a.y + ") 的「" + a.type + "」。", "warn");
      }
    });
    emitAnomalyVisibility(visible);
    if (changed) saveAnomalies();
  }

  function buildPalette() {
    if (!els.chips) return;
    els.chips.replaceChildren();
    allAnomalyTypes().forEach((type) => {
      const wrap = document.createElement("span");
      wrap.className = "chip-wrap";
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.type = type;
      chip.textContent = type;
      chip.title = "拖动放置「" + type + "」，或先点它再点地板";
      chip.addEventListener("click", () => {
        armedType = type;
        els.chips.querySelectorAll(".chip").forEach((n) => n.classList.toggle("is-armed", n === chip));
        setFeedback("已选定「" + type + "」，点地图放置。", "info");
      });
      wrap.append(chip);
      if (customTypes.indexOf(type) !== -1) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "chip-del";
        del.textContent = "×";
        del.title = "删除自定义异常「" + type + "」";
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          customTypes = customTypes.filter((t) => t !== type);
          saveCustomTypes();
          if (armedType === type) armedType = ANOMALY_TYPES[0];
          buildPalette();
          setFeedback("已删除自定义异常「" + type + "」。", "info");
        });
        wrap.append(del);
      }
      els.chips.append(wrap);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "chip chip--add";
    add.textContent = "＋";
    add.title = "添加一种自定义异常";
    add.addEventListener("click", () => {
      const name = window.prompt("输入异常名称（1~3 个字）", "水");
      if (!name) return;
      const trimmed = name.trim().slice(0, 3);
      if (!trimmed) return;
      armedType = trimmed;
      if (customTypes.indexOf(trimmed) === -1) {
        customTypes.push(trimmed);
        saveCustomTypes();
      }
      buildPalette();
      setFeedback("已添加异常类型「" + trimmed + "」，点地图放置。", "success");
    });
    els.chips.append(add);
    els.chips.querySelectorAll(".chip").forEach((n) => n.classList.toggle("is-armed", n.dataset.type === armedType));
  }

  function setAnomalyEdit(on) {
    anomalyEdit = on;
    if (on) {
      if (patrol.on) stopPatrol("已停止自动巡检：进入异常标定。");
      if (manualPatrol) stopManualPatrol();
      if (routeEdit) setRouteEdit(false);
    }
    if (els.palette) els.palette.hidden = !on;
    if (els.anomalyBtn) {
      els.anomalyBtn.classList.toggle("is-on", on);
      els.anomalyBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (els.anomalyLabel) els.anomalyLabel.textContent = on ? "点地板放异常" : "标定异常点位";
    if (on) {
      buildPalette();
      setFeedback("把红三角拖到地板上，或先选类型再点地板；再点一次可移除。", "info");
    } else {
      saveAnomalies();
      setFeedback("异常点位已保存，共 " + anomalies.length + " 个。", "success");
    }
  }

  /* ---- 手动巡检：点位照样标出来，但由人自己走过去 ---- */
  let manualPatrol = null;

  function stopManualPatrol() {
    if (!manualPatrol) return;
    manualPatrol = null;
    if (els.manualBtn) els.manualBtn.classList.remove("is-on");
    if (els.manualLabel) els.manualLabel.textContent = "手动巡检";
    clearPatrolMarks();
  }

  function startManualPatrol() {
    const points =
      customRoute.length && currentState && customRoute.every((p) => p.x < currentState.grid.width && p.y < currentState.grid.height)
        ? customRoute.map((p) => ({ x: p.x, y: p.y }))
        : planPatrolRoute(currentState, { x: actor.x, y: actor.y });
    if (!points.length) {
      setFeedback("没有可用的巡检点位，先「标定巡检顺序」或换一张地图。", "warn");
      return;
    }
    if (patrol.on) stopPatrol("已停止自动巡检。");
    if (routeEdit) setRouteEdit(false);
    if (anomalyEdit) setAnomalyEdit(false);
    manualPatrol = { points: points, done: 0 };
    if (els.manualBtn) els.manualBtn.classList.add("is-on");
    if (els.manualLabel) els.manualLabel.textContent = "结束手动巡检";
    updateTally(points.length, 0);
    paintManualMarks();
    setFeedback("手动巡检开始：共 " + points.length + " 个点位，自己走过去吧。", "info");
  }

  function paintManualMarks() {
    clearPatrolMarks();
    if (!manualPatrol || !els.board) return;
    manualPatrol.points.forEach((point, index) => {
      if (index < manualPatrol.done) return;
      const cell = els.board.querySelector('.cell[data-x="' + point.x + '"][data-y="' + point.y + '"]');
      if (!cell) return;
      cell.classList.add("is-waypoint");
      if (index === manualPatrol.done) cell.classList.add("is-target");
    });
  }

  function checkManualHit(cellX, cellY) {
    if (!manualPatrol) return;
    const point = manualPatrol.points[manualPatrol.done];
    if (!point || point.x !== cellX || point.y !== cellY) return;
    manualPatrol.done += 1;
    updateTally(manualPatrol.points.length, manualPatrol.done);
    if (manualPatrol.done >= manualPatrol.points.length) {
      setFeedback("手动巡检完成：" + manualPatrol.done + " 个点位全部走过。", "success");
      stopManualPatrol();
      return;
    }
    setFeedback("手动巡检 " + manualPatrol.done + "/" + manualPatrol.points.length + "，下一个点位已标出。", "success");
    paintManualMarks();
  }

  /* ---- 巡检点位标记：复用点击回执那个下指箭头 ---- */

  /** 给当前排队的点位挂上 is-waypoint，队首那颗再挂 is-target（更亮、会呼吸）。 */
  function paintPatrolMarks() {
    clearPatrolMarks();
    if (!patrol.on) return;
    // 正在走过去的那个点位也要标（它已经出队了，不然会「还没到箭头就消失」）
    const marks = [];
    if (patrol.current) marks.push(patrol.current);
    patrol.queue.forEach((point) => marks.push(point));
    marks.forEach((point) => {
      const cell = els.board.querySelector(
        '.cell[data-x="' + point.x + '"][data-y="' + point.y + '"]'
      );
      if (!cell) return;
      // 用像素而不是百分比：格子只有 aspect-ratio、没有显式高度，
      // ::after 的百分比 top 会按 0 高度解析，箭头会跑到格子外面
      cell.style.setProperty("--tx", (cell.offsetWidth / 2).toFixed(1) + "px");
      cell.style.setProperty("--ty", (cell.offsetHeight / 2).toFixed(1) + "px");
      cell.classList.add("is-waypoint");
      if (patrol.current && point === patrol.current) cell.classList.add("is-target");
    });
  }

  function clearPatrolMarks() {
    els.board.querySelectorAll(".cell.is-waypoint").forEach((cell) => {
      cell.classList.remove("is-waypoint", "is-target");
    });
  }

  /* ---- 地标计数与标定交互 ---- */

  function updateTally(total, done) {
    if (!els.mapTally) return;
    els.mapTally.hidden = !(total > 0);
    if (els.tallyTotal) els.tallyTotal.textContent = String(total || 0);
    if (els.tallyDone) els.tallyDone.textContent = String(done || 0);
  }

  function saveCustomRoute() {
    try {
      window.localStorage.setItem(ROUTE_KEY, JSON.stringify(customRoute));
    } catch (error) {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  }

  function loadCustomRoute() {
    try {
      const raw = window.localStorage.getItem(ROUTE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      customRoute = parsed
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    } catch (error) {
      customRoute = [];
    }
  }

  function clearRouteIndexes() {
    els.board.querySelectorAll(".wp-index").forEach((badge) => badge.remove());
  }

  function renderRouteIndexes() {
    clearRouteIndexes();
    if (!routeEdit) return;
    customRoute.forEach((point, index) => {
      const cell = els.board.querySelector(
        '.cell[data-x="' + point.x + '"][data-y="' + point.y + '"]'
      );
      if (!cell) return;
      const badge = document.createElement("span");
      badge.className = "wp-index";
      badge.textContent = String(index + 1);
      cell.append(badge);
    });
  }

  function toggleRoutePoint(cellX, cellY) {
    if (isBlockedCell(cellX, cellY)) {
      setFeedback("那一格立着「禁止通行」牌，不能当地标。", "warn");
      return;
    }
    const index = customRoute.findIndex((p) => p.x === cellX && p.y === cellY);
    if (index >= 0) {
      customRoute.splice(index, 1);
      setFeedback("已移除第 " + (index + 1) + " 个地标，现在共 " + customRoute.length + " 个。");
    } else {
      customRoute.push({ x: cellX, y: cellY });
      setFeedback(
        "已加第 " + customRoute.length + " 个地标，继续点地板，点「确定」结束标定。"
      );
    }
    renderRouteIndexes();
    updateTally(customRoute.length, 0);
    saveCustomRoute();
  }

  function setRouteEdit(on) {
    routeEdit = on;
    if (els.routeEditBtn) {
      els.routeEditBtn.setAttribute("aria-pressed", on ? "true" : "false");
      els.routeEditBtn.classList.toggle("is-on", on);
    }
    if (els.routeEditLabel) {
      els.routeEditLabel.textContent = on ? "标定中：点地板加点位" : "标定巡检顺序";
    }
    if (els.routeConfirm) els.routeConfirm.hidden = !on;
    if (on) {
      if (patrol.on) stopPatrol("已停止自动巡检：开始标定新顺序。");
      if (manualPatrol) stopManualPatrol();
      if (anomalyEdit) setAnomalyEdit(false);
      renderRouteIndexes();
      setFeedback("标定模式：按顺序点地板（禁区点不了），点「确定」结束。");
    } else {
      clearRouteIndexes();
      setFeedback("巡检顺序已保存：" + customRoute.length + " 个地标。");
    }
    updateTally(customRoute.length, 0);
  }

  function startPatrol() {
    if (!currentState || patrol.on) return;
    if (manualPatrol) stopManualPatrol();
    if (routeEdit) setRouteEdit(false);
    if (anomalyEdit) setAnomalyEdit(false);
    const route = customRoute.length
      ? customRoute.map((p) => ({ x: p.x, y: p.y }))
      : planPatrolRoute(currentState, { x: actor.x, y: actor.y });
    if (!route.length) {
      setFeedback("没有可以巡检的格子。", "warn");
      return;
    }
    heldKeys.clear();
    actor.path.length = 0;
    actor.target = null;
    patrol.queue = route;
    patrol.total = route.length;
    patrol.done = 0;
    patrol.skipped = 0;
    patrol.startedAt = performance.now();
    patrol.steps0 = steps;
    patrol.visited0 = trail.size;
    patrol.on = true;
    setPatrolButton(true);
    updateTally(patrol.total, 0);
    paintPatrolMarks();
    startLoop();
    setFeedback(
      "自动巡检开始：" +
        patrol.total +
        " 个点位，按就近顺序走，随时点地图或按方向键可接管。"
    );
    patrolNext();
  }

  function stopPatrol(reason) {
    if (!patrol.on) return;
    patrol.on = false;
    patrol.queue = [];
    actor.target = null;
    actor.path.length = 0;
    setWalking(false);
    setPatrolButton(false);
    // 中途停下来就没有完整统计了，把上一轮的结果和导出按钮一起收掉
    patrol.lastSummary = null;
    patrol.current = null;
    if (patrolReportBtn) patrolReportBtn.hidden = true;
    clearPatrolMarks();
    if (reason) setFeedback(reason, "warn");
  }

  /** 生成 Markdown 巡检报告并下载，方便贴进结业材料或存档。 */
  /** 把轨迹整理成「字符画地图 + 坐标序列」，写进导出的 Markdown。 */
  function describeRoute(grid) {
    const width = grid.width || 0;
    const height = grid.height || 0;
    const blocked = new Set((grid.obstacles || []).map((pair) => pair[0] + "," + pair[1]));
    const cells = [];
    const seen = new Set();
    trackPoints.forEach((pt) => {
      const key = Math.round(pt.x) + "," + Math.round(pt.y);
      if (seen.has(key)) return;
      seen.add(key);
      cells.push(key);
    });
    const rx = currentState ? currentState.robot.x : -1;
    const ry = currentState ? currentState.robot.y : -1;
    const ascii = [];
    for (let y = 0; y < height; y += 1) {
      let row = "";
      for (let x = 0; x < width; x += 1) {
        const key = x + "," + y;
        let ch = ".";
        if (blocked.has(key)) ch = "#";
        if (seen.has(key)) ch = "o";
        if (x === rx && y === ry) ch = "@";
        row += ch;
      }
      ascii.push(row);
    }
    const line = cells.map((key) => "(" + key + ")").join(" → ") || "（本轮没有移动）";
    return { cells: cells, ascii: ascii, line: line };
  }

  function exportPatrolReport() {
    if (!patrol.lastSummary) {
      setFeedback("还没有走完一整轮巡检，暂时没有可导出的统计。", "warn");
      return;
    }
    const sum = patrol.lastSummary;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" +
      pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const grid = currentState ? currentState.grid : { width: 0, height: 0, obstacles: [] };
    const pos = currentState
      ? "(" + currentState.robot.x.toFixed(1) + ", " + currentState.robot.y.toFixed(1) + ")"
      : "未知";
    const route = describeRoute(grid);
    const lines = [
      "# 巡检报告",
      "",
      "- 生成时间：" + now.toLocaleString("zh-CN"),
      "- 地图：" + grid.width + " × " + grid.height + "，障碍 " + grid.obstacles.length + " 处",
      "- 巡检点位：" + patrol.done + " / " + patrol.total +
        (patrol.skipped ? "（跳过 " + patrol.skipped + " 个）" : ""),
      "- 用时：" + sum.seconds + " 秒",
      "- 移动步数：" + sum.steps + " 步",
      "- 新覆盖格子：" + sum.visited + " 格",
      "- 结束位置：" + pos,
      "- 异常点位：" +
        (anomalies.length
          ? anomalies.length + " 个（已发现 " + anomalies.filter((a) => a.detected).length + " 个）"
          : "无"),
      "",
      "## 异常点位",
      "",
      ...(anomalies.length
        ? anomalies.map(
            (a) =>
              "    (" + a.x + ", " + a.y + ")  " + a.type + "  " + (a.detected ? "已发现" : "未发现")
          )
        : ["    无"]),
      "",
      "## 本轮路线",
      "",
      "共 " + trackPoints.length + " 个采样点，按格子去重后 " + route.cells.length + " 格：",
      "",
      "    " + route.line,
      "",
      "## 路线策略",
      "",
      "按行蛇形采样生成巡检点位（每两格取一点，跳过禁止通行牌），按巡游顺序",
      "逐个推进；每段路径由 A* 规划并做连续扫掠碰撞检测，遇障自动绕行。",
      "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "巡检报告-" + stamp + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setFeedback("巡检报告已导出。", "success");

    // 顺手存一份到服务端，多次巡检可以在 /api/reports 里对比
    requestJSON("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene: currentSceneId,
        points: sum.points,
        seconds: Number(sum.seconds),
        steps: sum.steps,
        visited: sum.visited,
        anomalies: anomalies.map((a) => ({ x: a.x, y: a.y, type: a.type, detected: !!a.detected })),
        anomaly_count: anomalies.filter((a) => a.detected).length,
      }),
    })
      .then((res) => {
        setFeedback("巡检报告已导出，并存档为第 " + res.report.id + " 条记录。", "success");
      })
      .catch(() => {
        setFeedback("巡检报告已导出（服务端存档失败，可稍后重试）。", "warn");
      });
  }

  /* ------------------------------------------------------------ 巡检记录 */

  function fmtTime(iso) {
    if (!iso) return "—";
    const text = String(iso).replace("T", " ");
    return text.length >= 16 ? text.slice(0, 16) : text;
  }

  function renderReports(list, limit) {
    if (!els.reportsBody) return;
    const wrap = els.reportsBody;
    wrap.textContent = "";
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "sheet-empty";
      empty.textContent = "还没有记录。跑完一轮自动巡检并导出一次报告，这里就会出现一条。";
      wrap.append(empty);
      return;
    }
    const table = document.createElement("table");
    table.className = "rep-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["#", "时间", "地图", "点位", "用时", "异常", "异常状态"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    });
    head.append(headRow);
    const body = document.createElement("tbody");
    list.forEach((item) => {
      const tr = document.createElement("tr");
      const cells = [
        String(item.id),
        fmtTime(item.received_at),
        item.scene_name || item.scene || "—",
        item.points + " 个",
        item.seconds + " 秒",
        (item.anomalies ? item.anomalies.length : item.anomaly_count || 0) + " 个",
        (item.anomalies && item.anomalies.length
          ? item.anomalies.map((a) => a.type + (a.detected ? "✓" : "")).join("、")
          : "—"),
      ];
      cells.forEach((text, index) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (index === 0) td.className = "rep-id";
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body);
    wrap.append(table);
    if (els.reportsHint) {
      els.reportsHint.textContent = "共 " + list.length + " 条（最多显示最近 " + limit + " 条）。";
    }
  }

  function openReports() {
    if (!els.reportsSheet) return;
    els.reportsSheet.hidden = false;
    if (els.reportsBody) {
      els.reportsBody.textContent = "正在读取…";
    }
    if (els.reportsClose) els.reportsClose.focus();
    requestJSON("/api/reports?limit=20")
      .then((data) => {
        renderReports(data.reports || [], data.limit || 20);
      })
      .catch((err) => {
        if (!els.reportsBody) return;
        els.reportsBody.textContent = "";
        const tip = document.createElement("p");
        tip.className = "sheet-empty";
        tip.textContent = "读取失败：" + err.message + "。后端可能没启动，稍后再试。";
        els.reportsBody.append(tip);
      });
  }

  function closeReports() {
    if (els.reportsSheet) els.reportsSheet.hidden = true;
    if (els.reportsOpen) els.reportsOpen.focus();
  }

  /* ------------------------------------------------------------ 虚拟传感器 */

  /** 障碍格集合，传感器步进时直接查表。 */
  function obstacleSet() {
    const set = new Set();
    const grid = currentState && currentState.grid;
    if (!grid) return set;
    (grid.obstacles || []).forEach((pair) => {
      if (Array.isArray(pair) && pair.length >= 2) set.add(pair[0] + "," + pair[1]);
    });
    return set;
  }

  function scanLayerElement() {
    if (scanLayer && scanLayer.isConnected) return scanLayer;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "scan");
    svg.setAttribute("aria-hidden", "true");
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const clip = document.createElementNS(ns, "clipPath");
    clip.setAttribute("id", "scan-clip");
    const clipRect = document.createElementNS(ns, "rect");
    clip.append(clipRect);
    defs.append(clip);
    const group = document.createElementNS(ns, "g");
    group.setAttribute("clip-path", "url(#scan-clip)");
    const rays = document.createElementNS(ns, "path");
    rays.setAttribute("class", "rays");
    const ring = document.createElementNS(ns, "path");
    ring.setAttribute("class", "ring");
    group.append(ring, rays);
    svg.append(defs, group);
    els.board.append(svg);
    scanLayer = svg;
    return svg;
  }

  /**
   * 从机器人所在格向外打一圈射线：碰到障碍或出界就停。
   * 射线经过的格子记进 scanned，射线端点连成扫描线。
   */
  function updateScan() {
    const metrics = currentState ? gridMetrics() : null;
    const svg = scanLayerElement();

    if (!currentState || !metrics) {
      svg.classList.remove("is-on");
      return;
    }

    if (els.factScanned) els.factScanned.textContent = String(scanned.size);
    detectAnomalies();
    svg.classList.toggle("is-on", scanOn);
    if (!scanOn) return;

    const width = currentState.grid.width;
    const height = currentState.grid.height;
    const blocked = obstacleSet();

    // 视图框用「内边距盒」尺寸，和 inset:0 的绝对定位一致，避免 1~2px 的缩放错位
    const boxW = els.board.clientWidth;
    const boxH = els.board.clientHeight;
    svg.setAttribute("viewBox", "0 0 " + boxW + " " + boxH);
    svg.setAttribute("width", String(boxW));
    svg.setAttribute("height", String(boxH));

    // 传感器只画在地图范围内：网格的左右边界取「第一格左沿 / 最后一格右沿」
    const pad = metrics.cellPx / 2;
    const clipRect = svg.querySelector("#scan-clip rect");
    if (clipRect) {
      clipRect.setAttribute("x", String(metrics.originX - pad));
      clipRect.setAttribute("y", String(metrics.originY - pad));
      clipRect.setAttribute("width", String((width - 1) * metrics.step + metrics.cellPx));
      clipRect.setAttribute("height", String((height - 1) * metrics.step + metrics.cellPx));
    }

    const cx = metrics.originX + actor.x * metrics.step;
    const cy = metrics.originY + actor.y * metrics.step;
    // 1) 逐格判定「看得到」：先算格心距离，再沿视线做亚格采样判断有没有被牌子挡住。
    //    这样做比「沿射线累加格子」稳定：不会因为射线数量/步长出现漏格或锯齿。
    const visible = new Set();
    const inRange = new Set();
    const span = Math.ceil(SCAN_RANGE) + 1;
    const baseX = Math.round(actor.x);
    const baseY = Math.round(actor.y);

    for (let gy = baseY - span; gy <= baseY + span; gy += 1) {
      for (let gx = baseX - span; gx <= baseX + span; gx += 1) {
        if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
        const key = gx + "," + gy;
        if (blocked.has(key)) continue; // 牌子本身不算可走的格子
        const dist = Math.hypot(gx - actor.x, gy - actor.y);
        if (dist > SCAN_RANGE) continue;
        inRange.add(key);

        // 从机器人往格心采样，任何一步落在牌子上就看不见
        let occluded = false;
        const samples = Math.max(2, Math.ceil(dist / 0.1));
        for (let s = 1; s <= samples; s += 1) {
          const t = s / samples;
          const sx = actor.x + (gx - actor.x) * t;
          const sy = actor.y + (gy - actor.y) * t;
          const bx = Math.round(sx);
          const by = Math.round(sy);
          if (bx === gx && by === gy) break; // 已经走到目标格，不再往后看
          if (blocked.has(bx + "," + by)) {
            occluded = true;
            break;
          }
        }
        if (!occluded) visible.add(key);
      }
    }

    scanFresh = false;
    visible.forEach((key) => {
      if (!scanned.has(key)) {
        scanned.add(key);
        scanFresh = true;
      }
    });
    // 机器人脚下那一格永远算扫到
    const here = cellKey(Math.round(actor.x), Math.round(actor.y));
    if (!scanned.has(here)) {
      scanned.add(here);
      scanFresh = true;
    }

    // 2) 每个方向的最大可见距离：撞牌子或出界就停，最多到量程。
    //    同一组距离既画射线、也画量程轮廓——所以遇到障碍时轮廓会凹进去，不再是个正圆。
    const stepLen = 0.08;
    const segs = [];
    const ringPts = [];
    for (let i = 0; i < SCAN_RAYS; i += 1) {
      const angle = (Math.PI * 2 * i) / SCAN_RAYS;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let dist = 0;
      while (dist < SCAN_RANGE) {
        const next = Math.min(dist + stepLen, SCAN_RANGE);
        const px = actor.x + dx * next;
        const py = actor.y + dy * next;
        if (px < -0.5 || py < -0.5 || px > width - 0.5 || py > height - 0.5) break;
        if (blocked.has(Math.round(px) + "," + Math.round(py))) break;
        dist = next;
      }
      const ex = cx + dx * dist * metrics.step;
      const ey = cy + dy * dist * metrics.step;
      segs.push("M" + cx.toFixed(1) + " " + cy.toFixed(1) + "L" + ex.toFixed(1) + " " + ey.toFixed(1));
      ringPts.push(ex.toFixed(1) + " " + ey.toFixed(1));
    }
    svg.querySelector("path.rays").setAttribute("d", segs.join(" "));
    svg.querySelector("path.ring").setAttribute("d", "M" + ringPts.join("L") + "Z");

    // 3) 每次都重刷类名：盲区随位置变化，不能等「有新格子」才更新，
    //    否则站着不动或走进旧区域时，斜纹会停在上一帧的位置。
    els.board.querySelectorAll(".cell").forEach((cell) => {
      const key = cell.dataset.x + "," + cell.dataset.y;
      cell.classList.toggle("cell--scanned", scanned.has(key));
      cell.classList.toggle("cell--unseen", inRange.has(key) && !visible.has(key));
    });

    if (els.factScanned) els.factScanned.textContent = String(scanned.size);

    if (scanFresh) {
      svg.classList.remove("is-pulse");
      void svg.offsetWidth;
      svg.classList.add("is-pulse");
      window.clearTimeout(scanPulseTimer);
      scanPulseTimer = window.setTimeout(() => svg.classList.remove("is-pulse"), 560);
    }
  }


  function setScan(on) {
    scanOn = Boolean(on);
    try {
      window.localStorage.setItem("patrol.sensor", scanOn ? "1" : "0");
    } catch (err) {
      /* 隐私模式下写不进去就算了 */
    }
    if (els.sensorToggle) els.sensorToggle.setAttribute("aria-checked", scanOn ? "true" : "false");
    updateScan();
  }

  function restoreScan() {
    let saved = null;
    try {
      saved = window.localStorage.getItem("patrol.sensor");
    } catch (err) {
      saved = null;
    }
    if (saved === "0") scanOn = false;
    if (els.sensorToggle) els.sensorToggle.setAttribute("aria-checked", scanOn ? "true" : "false");
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
      trackPoints = [];
      trail = new Set();
      steps = 0;
    }
    trail.add(cellKey(state.robot.x, state.robot.y));
    pushTrackPoint(state.robot.x, state.robot.y);
    return jumped;
  }

  /** 入口在左上角、出口在右下角，都只是地标——判定上和普通可通行格一样。 */

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

    if (scanOn && scanned.has(cellKey(x, y))) {
      cell.classList.add("cell--scanned");
    }

    // 入口（左上）与出口（右下）：只是标记，不是障碍，谁都能踩上去

    cell.setAttribute("aria-label", label);
    return cell;
  }

  /** 按后端状态整块重绘地图（8×8=64 格，直接重建比增量更新更好维护）。 */
  /** 把服务端状态同步到本地 actor 上；换地图/重读都必须走这里，否则角色还停在旧坐标。 */
  function applyStateToActor(state) {
    actor.x = state.robot.x;
    actor.y = state.robot.y;
    actor.heading = state.robot.heading;
    actor.cell = cellKey(state.robot.x, state.robot.y);
  }

  function renderState(state, options) {
    const opts = options || {};
    const { width, height } = state.grid;

    // 换图（尺寸变了）就把扫描记录清掉，不然会留着上一张图的格子
    const dims = width + "x" + height;
    if (dims !== lastGridDims) {
      lastGridDims = dims;
      scanned = new Set();
    }

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
    updateScan();
    // 格点模式不经过 rAF，这里补一次采样，轨迹线才不会断
    pushTrackPoint(state.robot.x, state.robot.y);
    paintTrack();

    els.placeholder.hidden = true;
    els.mapMeta.textContent = mapMeta(state);

    els.factSteps.textContent = String(steps);
    els.factVisited.textContent = String(trail.size);
    updateFacts();
  
    // 地图刚重绘时布局可能还没稳定（换场景会改变列数），
    // 等下一帧再按真实格宽摆一次角色和导图层，避免站在旧坐标上。
    window.requestAnimationFrame(() => {
      applyActorTransform();
      layoutOverlays();
    });
}

  function mapMeta(state) {
    const name = state.scene && state.scene.name ? state.scene.name + " · " : "";
    return name + state.grid.width + " × " + state.grid.height + " 网格 · 禁止通行 " +
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
    patrolBtn.disabled = busy || noState;
    els.board.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showPlaceholder(message) {
    els.placeholder.textContent = message;
    els.placeholder.hidden = false;
  }

  /** 自由移动的固定文案：没有模式切换，进入场景时刷一次就够。 */
  function applyFreeTexts() {
    els.controlHint.textContent = "点击或长按地图走过去";
    els.keysHint.innerHTML = "也可以按住 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 连续移动";
    els.footNote.textContent =
      "地图与障碍来自后端接口；移动是在页面内连续计算的，不会为每一步请求后端。";
    if (actor.node) actor.node.classList.remove("is-grid");
  }

  /* ---------------------------------------------------------------- 交互 */

  async function loadState(options) {
    const initial = Boolean(options && options.initial);
    if (busy) return;
    // 重新读数会让位置跳变，先把自动巡检停掉
    stopPatrol("已停止自动巡检：状态被重新读取。");

    busy = true;
    syncControls();
    setFeedback(initial ? "正在读取地图与机器人状态…" : "正在重新读取状态…");

    try {
      const state = validateState(await requestJSON("/api/state"));
      const previous = currentState ? { x: currentState.robot.x, y: currentState.robot.y } : null;
      currentState = state;
      const jumped = trackPosition(state, previous);

      applyStateToActor(state);

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

  // 服务端把「刚完成一次移动」只保持一小段时间，之后自动回到 idle。
  // 这里在移动结束后悄悄再读一次状态，只刷新面板上的坐标/朝向/状态，不动提示文案。

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
    stopPatrol("已停止自动巡检：重新选择了场景。");
    els.start.hidden = false;
    started = false;
    setWalking(false);
    actor.path.length = 0;
    heldKeys.clear();
    window.setTimeout(() => els.startGo.focus(), 30);
  }

  async function beginRun() {
    // 每次开场都让后端把场景重设一遍：既处理换地图，也把机器人放回起点
    // （只换机体、地图没变时同样要重置，否则会从上一次停下的位置继续）
    const wanted = selection.map || currentSceneId;
    if (wanted) {
      try {
        const state = await requestJSON("/api/scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: wanted }),
        });
        validateState(state);
        currentState = state;
        currentSceneId = state.scene ? state.scene.id : wanted;
        // 换了地图就是新的一轮：步数、痕迹、轨迹、扫描全清，角色回到新图的起点
        steps = 0;
        trail = new Set();
        trackPoints = [];
        scanned = new Set();
        lastGridDims = "";
        patrol.lastSummary = null;
        if (patrolReportBtn) patrolReportBtn.hidden = true;
        applyStateToActor(state);
        renderState(state);
        applyActorTransform();
        applyActorLook();
        layoutOverlays();
      } catch (error) {
        // 后端连不上时不清空本地状态，用上一次读到的地图先进入，至少不会白屏
        if (!currentState) {
          setFeedback("进入场景失败：" + describeError(error), "warn");
          return;
        }
      }
    }

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
    // 开场选完机体才进入：这里必须按当前选择重画一次，立牌才会换成选中的那台
    trackPoints = [];
    if (currentState) renderState(currentState);
    applyActorTransform();
    applyActorLook();
    startLoop();
    els.board.focus({ preventScroll: true });
  }

  function restoreSelection() {
    try {
      const saved = JSON.parse(window.localStorage.getItem("patrol.selection") || "null");
      // 旧版本存的是 grid8，映射到现在的场景 id
      if (saved && saved.map === "grid8") selection.map = "standard";
      else if (saved && saved.map) selection.map = saved.map;
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

    if (els.traceToggle) {
      els.traceToggle.addEventListener("click", () => setTrace(!traceOn));
    }
    if (els.reportsOpen) els.reportsOpen.addEventListener("click", openReports);
    if (els.reportsClose) els.reportsClose.addEventListener("click", closeReports);
    if (els.reportsSheet) {
      els.reportsSheet.addEventListener("click", (event) => {
        if (event.target === els.reportsSheet) closeReports();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && els.reportsSheet && !els.reportsSheet.hidden) closeReports();
    });
    if (els.sensorToggle) {
      els.sensorToggle.addEventListener("click", () => setScan(!scanOn));
    }

    if (els.stickToggle) {
      els.stickToggle?.addEventListener("click", () => setStick(!stick.on));
    }
  }
  /* --------------------------------------------------------- 虚拟传感器 */

  const SCAN_RANGE = 2.6; // 量程，单位「格」
  const SCAN_RAYS = 56; // 射线数，够密就行，太多会拖帧
  let scanned = new Set(); // 本会话扫到过的格子（跨地图切换时清空）
  let scanOn = true;
  let scanLayer = null;
  let scanPulseTimer = 0;
  let scanFresh = false;
  let lastGridDims = "";

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
      resizeFrame = window.requestAnimationFrame(() => {
        fitStage({ instant: true });
        layoutOverlays();
      });
    };
    window.addEventListener("resize", refit);
    window.addEventListener("resize", () => layoutOverlays());

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
    // 方向键：按住持续走，松手停
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
    });

    if (patrolBtn) {
      patrolBtn.addEventListener("click", () => {
        if (patrol.on) stopPatrol("已停止自动巡检。");
        else startPatrol();
      });
    }

    if (patrolReportBtn) {
      patrolReportBtn.addEventListener("click", exportPatrolReport);
    }

    // 点地图：自由模式下走过去
    // 地图上按住就能走：按下立刻出发，按住拖动时换成指针下面的那个格子
    // 命中格子：先按元素找，找不到就在几像素内绕一圈再找，最后退回「最近的格心」。
    // 斜俯视下格子是平行四边形、格子之间还有 4px 缝，直接 elementFromPoint
    // 经常落在 .board 或轴上，用户就会觉得「点了没反应」。
    const cellUnder = (clientX, clientY) => {
      const direct = document.elementFromPoint(clientX, clientY);
      const hit = direct && direct.closest ? direct.closest(".cell") : null;
      if (hit && hit.dataset.x) return hit;

      const RING = [3, 6, 10];
      for (const radius of RING) {
        for (let i = 0; i < 8; i += 1) {
          const angle = (Math.PI * 2 * i) / 8;
          const el = document.elementFromPoint(
            clientX + Math.cos(angle) * radius,
            clientY + Math.sin(angle) * radius
          );
          const cell = el && el.closest ? el.closest(".cell") : null;
          if (cell && cell.dataset.x) return cell;
        }
      }

      let best = null;
      let bestDist = 48;
      els.board.querySelectorAll(".cell").forEach((cell) => {
        if (!cell.dataset.x) return;
        const rect = cell.getBoundingClientRect();
        const d = Math.hypot(rect.left + rect.width / 2 - clientX, rect.top + rect.height / 2 - clientY);
        if (d < bestDist) {
          bestDist = d;
          best = cell;
        }
      });
      return best;
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
      if (event.button > 0) return;
      // 先挡住默认行为：不然按在轴标签/立牌/格子缝隙上会开始「拖选文字」，
      // 松手时浏览器把这次点击吃掉，看起来就是「按了没反应」。
      event.preventDefault();
      if (!started || !currentState) return;
      const point = pointIn(cellUnder(event.clientX, event.clientY), event.clientX, event.clientY);
      if (!point) return;
      if (anomalyEdit) {
        toggleAnomaly(point.cellX, point.cellY, armedType);
        return;
      }

      if (routeEdit) {
        toggleRoutePoint(point.cellX, point.cellY);
        return;
      }
      pressPoint = point;
      try {
        els.board.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 没有 pointer capture 也能用，只是拖出地图后会断 */
      }
      walkTo(point.cellX, point.cellY, point.offsetX, point.offsetY);
    });

    els.board.addEventListener("pointermove", (event) => {
      // 鼠标只是滑过去（没按住）时不要改目标；松开在画布外时 buttons 也会归零
      if (!pressPoint || event.buttons === 0) return;
      event.preventDefault();
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
    els.board.addEventListener("pointerleave", (event) => {
      if (event.buttons === 0) endPress();
    });
    // 松开发生在画布外（比如拖到右栏再放手）时，board 收不到 pointerup，这里兜底
    window.addEventListener("pointerup", endPress);
    window.addEventListener("pointercancel", endPress);
    els.anomalyBtn.addEventListener("click", () => setAnomalyEdit(!anomalyEdit));

    els.manualBtn.addEventListener("click", () => {
      if (manualPatrol) {
        stopManualPatrol();
        setFeedback("已结束手动巡检。", "info");
        return;
      }
      startManualPatrol();
    });

    els.reload.addEventListener("click", () => {
      // 手动重新读取＝重新开始一轮巡检，把这一轮的痕迹和步数一起清掉
      steps = 0;
      trail = new Set();
      trackPoints = [];
      paintTrack();
      actor.cell = "";
      paintTrail();
      els.factSteps.textContent = "0";
      els.factVisited.textContent = "0";
      loadState({ initial: !currentState });
    });
    if (els.routeEditBtn) {
      els.routeEditBtn.addEventListener("click", () => setRouteEdit(!routeEdit));
    }
    if (els.routeConfirm) {
      els.routeConfirm.addEventListener("click", () => setRouteEdit(false));
    }
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
      if (routeEdit) return;

      const direction = KEY_TO_DIRECTION[event.key];
      if (!direction) return;
      event.preventDefault();
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
    restoreScan();
    restoreTrace();
    loadCustomRoute();
    loadCustomTypes();
    loadAnomalies();
    buildPalette();
    updateTally(customRoute.length, 0);
    syncControls();
    applyFreeTexts();
    // 扫描扇形与轨迹要跟着角色走：单独一层 rAF，和移动循环解耦，
    // 这样即使没在移动（改变窗口大小、切右栏）也能对上位置。
    (function overlayLoop(ts) {
      refreshOverlays(ts);
      window.requestAnimationFrame(overlayLoop);
    })(0);

    loadState({ initial: true });

    // 模型异步取：取到以后重画一遍，角色和牌子才会立到地图上
    loadSprites().then((ok) => {
      if (!ok) return;
      if (els.robotPreview && sprites.dog) {
        const preview = cloneSprite("dog");
        if (preview) els.robotPreview.append(preview);
      }
      if (els.roverPreview && sprites.rover) {
        const preview = cloneSprite("rover");
        if (preview) els.roverPreview.append(preview);
      }
      if (currentState) renderState(currentState);
    });
  }

  init();
})();
