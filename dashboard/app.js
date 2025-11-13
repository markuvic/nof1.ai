const API_BASE = "/dashboard/api";
const state = {
  nodes: [],
  overview: null,
};

const apiStatusEl = document.getElementById("apiStatus");
const totalsEls = {
  updated: document.getElementById("lastUpdated"),
};
const formPanel = document.getElementById("addTraderPanel");
const toggleFormBtn = document.getElementById("toggleFormBtn");
const closeFormBtn = document.getElementById("closeFormBtn");

function setApiStatus(state) {
  apiStatusEl.className = `status-chip status-${state}`;
  if (state === "online") {
    apiStatusEl.textContent = "API 正常";
  } else if (state === "offline") {
    apiStatusEl.textContent = "API 不可用，请确保已启动仪表板服务";
  } else {
    apiStatusEl.textContent = "正在检测接口...";
  }
}

async function request(path, options) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      const text = await res.text();
      try {
        const payload = JSON.parse(text);
        throw new Error(payload.error || text || "请求失败");
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(text || "请求失败");
        }
        throw error;
      }
    }
    setApiStatus("online");
    if (res.status === 204) return null;
    return await res.json();
  } catch (error) {
    console.error(error);
    setApiStatus("offline");
    throw error;
  }
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatUptime(meta, account) {
  let startTime = null;
  if (account?.accountStartAt) {
    const parsed = Date.parse(account.accountStartAt);
    if (Number.isFinite(parsed)) {
      startTime = parsed;
    }
  }
  if (!startTime && Number.isFinite(meta?.uptimeSeconds)) {
    return `已运行 ${Math.floor(meta.uptimeSeconds / 3600)} 小时 ${Math.floor(
      (meta.uptimeSeconds % 3600) / 60,
    )} 分 (本次会话)`;
  }
  if (!startTime) {
    return "运行时长未知";
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const totalMinutes = Math.floor(diffSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `已运行 ${hours} 小时 ${minutes} 分`;
}

function formatInterval(account) {
  const interval = Number(account?.tradingIntervalMinutes);
  if (!Number.isFinite(interval) || interval <= 0) {
    return "交易周期：未知";
  }
  return `交易周期：${interval} 分钟/轮`;
}

function renderTotals() {
  if (!state.overview) {
    totalsEls.updated.textContent = "等待刷新...";
    return;
  }
  totalsEls.updated.textContent = `最近刷新：${new Date(
    state.overview.generatedAt,
  ).toLocaleString()}`;
}

function renderNodes() {
  const container = document.getElementById("nodesContainer");
  container.innerHTML = "";
  if (!state.nodes.length) {
    container.innerHTML =
      '<p class="muted">还没有添加任何节点，先在上方输入地址吧。</p>';
    return;
  }

  const snapshotsById = new Map();
  state.overview?.nodes.forEach((snapshot) => {
    snapshotsById.set(snapshot.node.id, snapshot);
  });

  state.nodes.forEach((node) => {
    const snapshot = snapshotsById.get(node.id);
    const status = snapshot?.status || "offline";
    const account = snapshot?.account;
    const meta = snapshot?.meta;
    const displayName =
      node.customName || meta?.traderName || "未命名交易员";
    const strategyLabel = meta?.agentProfile || "策略未配置";
    const exchangeLabel = meta?.exchangeProvider
      ? meta.exchangeProvider.toUpperCase()
      : "未知交易所";
    const balanceValue = account
      ? formatNumber(account.totalBalance + account.unrealisedPnl)
      : "--";
    const availableValue = account
      ? formatNumber(account.availableBalance)
      : "--";
    const unrealisedValue = account
      ? formatNumber(account.unrealisedPnl)
      : "--";
    const returnValue = account
      ? formatSignedPercent(account.returnPercent)
      : "--";
    const pnlRaw = account
      ? account.totalBalance +
        account.unrealisedPnl -
        (account.initialBalance || 0)
      : null;
    const pnlValue = account ? formatNumber(pnlRaw) : "--";
    const pnlClass =
      account && typeof pnlRaw === "number"
        ? pnlRaw >= 0
          ? "metric-positive"
          : "metric-negative"
        : "";
    const uptimeLabel = formatUptime(meta, account);
    const intervalLabel = formatInterval(account);
    const isDryRun = meta?.isDryRun === true;
    const modeLabel = meta
      ? isDryRun
        ? "模拟交易"
        : "实盘交易"
      : "模式未知";
    const modeClass = isDryRun ? "tag tag-mode-dry" : "tag tag-mode-live";
    const statusText = status === "online" ? "在线" : "离线";

    const card = document.createElement("div");
    card.className = "node-card";
    card.innerHTML = `
      <div class="card-top">
        <div class="tag-group">
          <span class="tag tag-profile">${strategyLabel}</span>
          <span class="${modeClass}">${modeLabel}</span>
        </div>
        <span class="status-chip status-${status}">${statusText}</span>
      </div>
      <div>
        <h3 class="node-name">${displayName}</h3>
        <p class="node-desc">${intervalLabel}</p>
      </div>
      <div class="node-metrics">
        <div class="stat-item">
          <p class="stat-label">账户余额</p>
          <p class="stat-value">${balanceValue}</p>
        </div>
        <div class="stat-item">
          <p class="stat-label">可用余额</p>
          <p class="stat-value">${availableValue}</p>
        </div>
        <div class="stat-item">
          <p class="stat-label">浮动盈亏</p>
          <p class="stat-value ${
            account
              ? account.unrealisedPnl >= 0
                ? "metric-positive"
                : "metric-negative"
              : ""
          }">${unrealisedValue}</p>
        </div>
        <div class="stat-item">
          <p class="stat-label">现总盈亏</p>
          <p class="stat-value ${pnlClass}">${pnlValue}</p>
        </div>
        <div class="stat-item">
          <p class="stat-label">收益率</p>
          <p class="stat-value ${
            account
              ? account.returnPercent >= 0
                ? "metric-positive"
                : "metric-negative"
              : ""
          }">${returnValue}</p>
        </div>
      </div>
      <div class="node-meta-row">
        <span>${uptimeLabel} · ${exchangeLabel}</span>
      </div>
      <div class="card-actions">
        <a class="btn outline" href="${node.baseUrl}" target="_blank" rel="noopener noreferrer">仪表板</a>
        <button class="btn subtle move-btn" data-id="${node.id}" data-direction="up">上移</button>
        <button class="btn subtle move-btn" data-id="${node.id}" data-direction="down">下移</button>
        <button class="btn subtle remove-btn" data-id="${node.id}">移除</button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function loadNodes() {
  const data = await request("/nodes");
  state.nodes = data.nodes;
  renderNodes();
}

async function loadOverview() {
  if (!state.nodes.length) {
    state.overview = null;
    renderTotals();
    return;
  }
  const overview = await request("/overview");
  if (overview) {
    state.overview = overview;
    renderTotals();
    renderNodes();
  }
}

async function refreshAll() {
  try {
    await loadNodes();
    await loadOverview();
  } catch (error) {
    console.warn("刷新失败", error);
  }
}

async function testConnection(url) {
  const result = await request("/nodes/test", {
    method: "POST",
    body: JSON.stringify({ baseUrl: url }),
  });
  return result;
}

async function addNode(url, customName) {
  await request("/nodes", {
    method: "POST",
    body: JSON.stringify({ baseUrl: url, customName }),
  });
  await refreshAll();
}

async function removeNode(id) {
  await request(`/nodes/${id}`, { method: "DELETE" });
  await refreshAll();
}

async function reorderNodeIds(ids) {
  await request("/nodes/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

async function moveNode(id, direction) {
  const currentIndex = state.nodes.findIndex((node) => node.id === id);
  if (currentIndex === -1) return;
  const targetIndex = direction === "up"
    ? Math.max(0, currentIndex - 1)
    : Math.min(state.nodes.length - 1, currentIndex + 1);
  if (targetIndex === currentIndex) {
    return;
  }
  const reordered = [...state.nodes];
  const [node] = reordered.splice(currentIndex, 1);
  reordered.splice(targetIndex, 0, node);
  state.nodes = reordered;
  renderNodes();
  await reorderNodeIds(reordered.map((item) => item.id));
  await loadOverview();
}

function initForm() {
  const form = document.getElementById("nodeForm");
  const urlInput = document.getElementById("nodeUrl");
  const nameInput = document.getElementById("nodeName");
  const messageEl = document.getElementById("formMessage");
  const testBtn = document.getElementById("testBtn");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    const name = nameInput.value.trim();
    if (!url) return;
    form.querySelectorAll("button").forEach((btn) => (btn.disabled = true));
    messageEl.textContent = "正在保存...";
    try {
      await addNode(url, name);
      urlInput.value = "";
      nameInput.value = "";
      messageEl.textContent = "保存成功";
    } catch (error) {
      messageEl.textContent = `保存失败：${error.message || error}`;
    } finally {
      form.querySelectorAll("button").forEach((btn) => (btn.disabled = false));
      setTimeout(() => (messageEl.textContent = ""), 2500);
    }
  });

  testBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    testBtn.disabled = true;
    messageEl.textContent = "正在测试连接...";
    try {
      const result = await testConnection(url);
      messageEl.innerHTML = `连接成功，节点名称：<b>${
        result.meta?.traderName || "未知"
      }</b>`;
    } catch (error) {
      messageEl.textContent = `连接失败：${error.message || error}`;
    } finally {
      testBtn.disabled = false;
    }
  });
}

function init() {
  setApiStatus("checking");
  initForm();
  toggleFormBtn?.addEventListener("click", () => {
    formPanel?.classList.toggle("hidden");
  });
  closeFormBtn?.addEventListener("click", () => {
    formPanel?.classList.add("hidden");
  });
  document.getElementById("refreshBtn").addEventListener("click", refreshAll);
  document
    .getElementById("nodesContainer")
    .addEventListener("click", (event) => {
      const target = event.target;
      if (target.matches(".remove-btn")) {
        const id = target.getAttribute("data-id");
        if (id) {
          removeNode(id);
        }
      } else if (target.matches(".move-btn")) {
        const id = target.getAttribute("data-id");
        const direction = target.getAttribute("data-direction");
        if (id && direction) {
          moveNode(id, direction);
        }
      }
    });
  refreshAll();
  setInterval(() => {
    if (state.nodes.length) {
      loadOverview();
    }
  }, 5000);
}

document.addEventListener("DOMContentLoaded", init);
