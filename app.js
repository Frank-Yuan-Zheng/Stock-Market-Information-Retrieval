// ============================================================
// A股全市场行情看板 · 自选股
// 性能优化版 + 每日涨跌分类导出
// ============================================================

// ============================================================
// 可调参数
// ============================================================
const THS_BASE = "https://fuyao.aicubes.cn";

// —— 性能参数 ——
const TICKER_CONCURRENCY = 4;    // 标的列表并发数
const VAL_CONCURRENCY = 5;       // 估值快照并发数
const VAL_BATCH_SIZE = 100;      // 每批股票数（API 限制 ≤ 100）
const MAX_PAGES = 15;            // 最多拉多少页标的
const PAGE_LIMIT = 500;          // 每页标的数

// —— 本地存储键 ——
const THS_KEY_STORAGE = "ths_api_key";
const WATCHLIST_KEY = "stock_watchlist_v2";
const THEME_KEY = "stock_theme";
const FONT_SCALE_KEY = "stock_font_scale";

// —— 字体缩放 ——
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.35;
const FONT_SCALE_STEP = 0.05;
let currentFontScale = 1;

// —— 分页 ——
const PAGE_SIZE = 50;

// —— 全局状态 ——
let allData = [];
let filteredData = [];
let currentPage = 1;
let isLoadingTHS = false;
let filterEra = "all";
let filterIndustry = "all";
const memoryStore = {};

// ============================================================
// 安全存储
// ============================================================
function safeGetItem(key) {
  try { return localStorage.getItem(key); }
  catch (e) { return memoryStore[key] || null; }
}
function safeSetItem(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) { memoryStore[key] = value; return false; }
}
function safeRemoveItem(key) {
  try { localStorage.removeItem(key); }
  catch (e) { delete memoryStore[key]; }
}

// ============================================================
// 主题 / 字体
// ============================================================
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "light" ? "dark" : "light";
  applyTheme(next);
  safeSetItem(THEME_KEY, next);
}
function applyFontScale(scale) {
  scale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, scale));
  scale = Math.round(scale * 100) / 100;
  currentFontScale = scale;
  document.documentElement.style.setProperty('--fs-scale', scale);
  const d = document.getElementById('fsDisplay');
  if (d) d.textContent = Math.round(scale * 100) + '%';
  const minus = document.querySelector('.fs-btn[data-action="minus"]');
  const plus = document.querySelector('.fs-btn[data-action="plus"]');
  if (minus) minus.disabled = scale <= FONT_SCALE_MIN + 0.001;
  if (plus) plus.disabled = scale >= FONT_SCALE_MAX - 0.001;
  safeSetItem(FONT_SCALE_KEY, String(scale));
}
function changeFontSize(delta) { applyFontScale(currentFontScale + delta * FONT_SCALE_STEP); }
function resetFontSize() { applyFontScale(1); }

// ============================================================
// 通用弹窗 / 轻提示
// ============================================================
let modalResolve = null;
let modalHasInput = true;

function openDialog(opts) {
  const {
    title = "", desc = "", value = "", placeholder = "",
    okText = "确定", cancelText = "取消", showInput = true, danger = false
  } = opts || {};
  return new Promise(resolve => {
    modalResolve = resolve;
    modalHasInput = showInput;
    document.getElementById("modalTitle").textContent = title;
    const descEl = document.getElementById("modalDesc");
    if (desc) { descEl.textContent = desc; descEl.style.display = ""; }
    else { descEl.textContent = ""; descEl.style.display = "none"; }
    const input = document.getElementById("modalInput");
    input.value = value;
    input.placeholder = placeholder || "";
    input.style.display = showInput ? "" : "none";
    const okBtn = document.getElementById("modalOk");
    okBtn.textContent = okText;
    okBtn.className = "btn" + (danger ? " danger" : "");
    document.getElementById("modalCancel").textContent = cancelText;
    document.getElementById("modalOverlay").classList.add("show");
    setTimeout(() => { showInput ? (input.focus(), input.select()) : okBtn.focus(); }, 40);
  });
}
function closeDialog(val) {
  const ov = document.getElementById("modalOverlay");
  if (!ov.classList.contains("show")) return;
  ov.classList.remove("show");
  const r = modalResolve;
  const hasInput = modalHasInput;
  modalResolve = null;
  if (!r) return;
  r(hasInput ? val : (val === null ? null : true));
}
(function bindModal() {
  const ov = document.getElementById("modalOverlay");
  const input = document.getElementById("modalInput");
  document.getElementById("modalOk").addEventListener("click", () => {
    closeDialog(modalHasInput ? input.value : true);
  });
  document.getElementById("modalCancel").addEventListener("click", () => closeDialog(null));
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeDialog(null); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); closeDialog(input.value); }
    else if (e.key === "Escape") { e.preventDefault(); closeDialog(null); }
  });
})();

function showToast(msg, type = "ok") {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  wrap.appendChild(el);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 280);
  }, 1700);
}
function isDialogOpen() {
  const ov = document.getElementById("modalOverlay");
  return !!ov && ov.classList.contains("show");
}

// ============================================================
// 自选股
// ============================================================
let watchlist = { groups: [], currentId: null };

function loadWatchlist() {
  try {
    const raw = safeGetItem(WATCHLIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.groups)) {
        watchlist = {
          groups: parsed.groups
            .filter(g => g && g.id && Array.isArray(g.codes))
            .map(g => ({
              id: String(g.id),
              name: String(g.name || "自选"),
              codes: g.codes.map(String)
            })),
          currentId: parsed.currentId || null
        };
      }
    }
  } catch (e) { console.warn("[自选] 读取失败:", e); }
  if (!Array.isArray(watchlist.groups)) watchlist.groups = [];
  if (watchlist.currentId && !watchlist.groups.find(g => g.id === watchlist.currentId)) {
    watchlist.currentId = null;
  }
}
function saveWatchlist() {
  if (!safeSetItem(WATCHLIST_KEY, JSON.stringify({
    groups: watchlist.groups,
    currentId: watchlist.currentId
  }))) {
    showError("自选数据保存失败（隐私模式或存储已满），已暂存内存。", true);
  }
}
function genId() { return "g" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function getNextGroupNum() {
  const used = new Set();
  watchlist.groups.forEach(g => {
    const m = String(g.name || "").trim().match(/^自选\s*(\d+)$/);
    if (m) used.add(parseInt(m[1], 10));
  });
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
function defaultGroupName() { return "自选" + getNextGroupNum(); }

function getCurrentGroup() {
  if (!watchlist.currentId) return null;
  return watchlist.groups.find(g => g.id === watchlist.currentId) || null;
}
function getTargetGroup() {
  return getCurrentGroup() || watchlist.groups[0] || null;
}

// —— 状态入口 ——
function setMarket(v) { document.getElementById("marketFilter").value = v; refreshFilterUI(); applyFilters(); }
function setEra(v) { filterEra = v; refreshFilterUI(); applyFilters(); }
function setIndustry(v) { filterIndustry = v; refreshFilterUI(); applyFilters(); }
function setWatchGroup(id) { watchlist.currentId = id; saveWatchlist(); refreshFilterUI(); applyFilters(); }

// —— 自选操作 ——
async function createGroupInteractive() {
  const defName = defaultGroupName();
  const raw = await openDialog({
    title: "新建自选分组",
    desc: "给分组取个名字吧，留空则使用默认名称「" + defName + "」。",
    value: defName,
    placeholder: defName,
    okText: "创建"
  });
  if (raw === null) return null;
  const name = String(raw).trim() || defName;
  const g = { id: genId(), name, codes: [] };
  watchlist.groups.push(g);
  watchlist.currentId = g.id;
  saveWatchlist(); updateStats(); refreshFilterUI(); applyFilters();
  showToast(`已创建「${name}」`);
  return g;
}
async function createGroupForAdding() {
  const defName = defaultGroupName();
  const raw = await openDialog({
    title: "新建自选分组",
    desc: "第一次添加自选股，先给分组起个名字吧。留空则使用默认名称「" + defName + "」。",
    value: defName,
    placeholder: defName,
    okText: "创建并添加"
  });
  const name = (raw === null || !String(raw).trim()) ? defName : String(raw).trim();
  const g = { id: genId(), name, codes: [] };
  watchlist.groups.push(g);
  watchlist.currentId = g.id;
  return g;
}
async function deleteGroup(id) {
  const g = watchlist.groups.find(x => x.id === id);
  if (!g) return;
  const ok = await openDialog({
    title: "删除自选分组",
    desc: g.codes.length > 0
      ? `「${g.name}」中有 ${g.codes.length} 只自选股，删除后不可恢复。`
      : `确定删除分组「${g.name}」吗？`,
    okText: "删除",
    showInput: false,
    danger: true
  });
  if (!ok) return;
  watchlist.groups = watchlist.groups.filter(x => x.id !== id);
  if (watchlist.currentId === id) watchlist.currentId = null;
  saveWatchlist(); updateStats(); refreshFilterUI(); applyFilters();
  showToast(`已删除「${g.name}」`, "warn");
}
async function renameGroup(id) {
  const g = watchlist.groups.find(x => x.id === id);
  if (!g) return;
  const raw = await openDialog({
    title: "重命名分组",
    desc: "留空则恢复为默认名称「" + defaultGroupName() + "」。",
    value: g.name,
    placeholder: defaultGroupName(),
    okText: "保存"
  });
  if (raw === null) return;
  const trimmed = String(raw).trim() || defaultGroupName();
  if (trimmed === g.name) return;
  const oldName = g.name;
  g.name = trimmed;
  saveWatchlist(); refreshFilterUI();
  showToast(`「${oldName}」→「${trimmed}」`);
}
let watchBusy = false;
async function toggleWatch(pureCode) {
  if (watchBusy) return;
  watchBusy = true;
  try {
    let g = getTargetGroup();
    let createdNow = false;
    if (!g) {
      g = await createGroupForAdding();
      createdNow = true;
    }
    const idx = g.codes.indexOf(pureCode);
    const adding = idx < 0;
    if (adding) g.codes.push(pureCode);
    else g.codes.splice(idx, 1);
    saveWatchlist(); updateStats(); refreshFilterUI(); applyFilters(false);
    showToast(adding ? `已加入「${g.name}」` : `已从「${g.name}」移除`, adding ? "ok" : "warn");
    if (createdNow) setStatus(`✅ 已创建「${g.name}」并加入自选`);
  } finally {
    watchBusy = false;
  }
}
function clearIndustry() { setIndustry("all"); }

// ============================================================
// 重置
// ============================================================
function resetFilters() {
  document.getElementById("searchInput").value = "";
  document.getElementById("marketFilter").value = "all";
  document.getElementById("sortSelect").value = "code_asc";
  filterEra = "all";
  filterIndustry = "all";
  watchlist.currentId = null;
  saveWatchlist();
  clearAdvInputs();
  refreshFilterUI();
  applyFilters();
  setStatus("✅ 已重置所有筛选");
}

// ============================================================
// 工具函数
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function setStatus(msg) { const el = document.getElementById("dataStatus"); if (el) el.textContent = msg; }
function setLoadingText(msg) {
  const el = document.getElementById("loadingText");
  if (el) el.textContent = msg;
}
function toNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pickNum(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function getLimitRatio(market) {
  if (market === "创业板" || market === "科创板") return 0.20;
  if (market === "北交所") return 0.30;
  return 0.10;
}
function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of ["item", "items", "list", "rows", "records", "data", "result"]) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}
function eraMatch(listDateRaw, era) {
  if (era === "all") return true;
  const y = parseInt((listDateRaw || "").slice(0, 4), 10);
  if (!Number.isFinite(y)) return false;
  if (era === "1990") return y >= 1990 && y <= 1999;
  if (era === "2000") return y >= 2000 && y <= 2009;
  if (era === "2010") return y >= 2010 && y <= 2019;
  if (era === "2020") return y >= 2020;
  return true;
}
function parseIndustry(raw) {
  if (!raw) return { code: "", name: "未知" };
  const s = String(raw);
  const m = s.match(/^([A-Z]\d{1,2})(.+)$/);
  if (m) return { code: m[1], name: m[2] };
  const m2 = s.match(/^([A-Z])(.+)$/);
  if (m2) return { code: m2[1], name: m2[2] };
  return { code: "", name: s };
}
function lookupIndustry(pureCode) {
  const map = window.INDUSTRY_MAP;
  if (!map) return { code: "", name: "未知" };
  const raw = map[pureCode];
  if (!raw) return { code: "", name: "未知" };
  return parseIndustry(raw);
}
function showError(msg, isInfo = false) {
  const b = document.getElementById("errorBanner");
  document.getElementById("errorMsg").textContent = msg;
  b.classList.toggle("info", isInfo);
  b.classList.add("show");
  console[isInfo ? "info" : "error"]("[看板]", msg);
}
function hideError() { document.getElementById("errorBanner").classList.remove("show"); }

// ============================================================
// API Key
// ============================================================
function getStoredKey() { return safeGetItem(THS_KEY_STORAGE) || ""; }
function getApiKey() {
  const el = document.getElementById("thsApiKey");
  if (el) {
    const v = el.value.trim();
    if (v) return v;
  }
  return getStoredKey();
}
function saveApiKey() {
  const el = document.getElementById("thsApiKey");
  const key = el.value.trim();
  if (key) {
    if (safeSetItem(THS_KEY_STORAGE, key)) {
      setStatus("✅ API Key 已保存");
      showToast("API Key 已保存");
      hideError();
    } else {
      showError("API Key 保存失败（隐私模式或存储禁用）。仍可直接加载。", true);
    }
  } else {
    safeRemoveItem(THS_KEY_STORAGE);
    setStatus("已清除 API Key");
    showToast("已清除 API Key", "warn");
  }
}

// ============================================================
// 网络请求
// ============================================================
async function thsFetch(path, params = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("请先输入同花顺 API Key");

  const url = new URL(THS_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: { "X-api-key": apiKey, "Accept": "application/json" },
      mode: "cors"
    });
  } catch (netErr) {
    throw new Error(
      `网络/CORS 错误：${netErr.message}\n` +
      `请求地址：${url.toString()}\n\n` +
      `请用本地服务器打开（例如 python -m http.server 8000），不要用 file://`
    );
  }

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); }
  catch { throw new Error(`非 JSON 响应 HTTP ${resp.status}：\n${text.slice(0, 500)}`); }

  if (!resp.ok) {
    const msg = json?.message || json?.msg || json?.error || text.slice(0, 500);
    throw new Error(`HTTP ${resp.status}：${msg}`);
  }
  if (typeof json.code !== "undefined" && json.code !== 0 && json.code !== 200) {
    throw new Error(`API 错误 code=${json.code}：${json.message || json.msg || ""}`);
  }
  return (json.data !== undefined) ? json.data
       : (json.result !== undefined) ? json.result
       : json;
}

// ============================================================
// 并发拉取标的列表
// ============================================================
async function fetchAllTickers(onProgress) {
  const all = [];
  const MAX_OFFSET = MAX_PAGES * PAGE_LIMIT;

  const firstData = await thsFetch("/api/meta/tickers/list", {
    asset_type: "a-share", limit: PAGE_LIMIT, offset: 0
  });
  const firstItems = extractItems(firstData);
  if (firstItems.length === 0) throw new Error("标的列表为空，请检查 API Key。");
  all.push(...firstItems);
  onProgress?.(all.length);

  if (firstItems.length < PAGE_LIMIT) return all;

  let offset = PAGE_LIMIT;
  let done = false;
  while (!done && offset < MAX_OFFSET) {
    const tasks = [];
    for (let i = 0; i < TICKER_CONCURRENCY; i++) {
      const off = offset + i * PAGE_LIMIT;
      if (off >= MAX_OFFSET) break;
      tasks.push(
        thsFetch("/api/meta/tickers/list", {
          asset_type: "a-share", limit: PAGE_LIMIT, offset: off
        })
        .then(d => ({ off, items: extractItems(d) }))
        .catch(e => {
          console.warn(`[标的] offset=${off} 失败:`, e);
          return { off, items: [] };
        })
      );
    }
    if (tasks.length === 0) break;

    const results = await Promise.all(tasks);
    for (const r of results) {
      if (r.items.length === 0) { done = true; continue; }
      all.push(...r.items);
      if (r.items.length < PAGE_LIMIT) done = true;
    }
    onProgress?.(all.length);
    offset += TICKER_CONCURRENCY * PAGE_LIMIT;
  }

  return all;
}

// ============================================================
// 行情快照
// ============================================================
async function fetchPriceSnapshot() {
  const data = await thsFetch("/api/a-share/prices/snapshot", {});
  const items = extractItems(data);
  const map = new Map();
  for (const p of items) {
    const full = String(p.thscode || "");
    const pure = String(p.ticker || "");
    if (full) map.set(full, p);
    if (pure) map.set(pure, p);
  }
  return map;
}

// ============================================================
// 估值快照（100/批 + 并发，API 硬限制）
// ============================================================
async function fetchValuations(tickers, onProgress) {
  const map = new Map();
  const total = tickers.length;

  const batches = [];
  for (let i = 0; i < total; i += VAL_BATCH_SIZE) {
    batches.push(tickers.slice(i, i + VAL_BATCH_SIZE));
  }

  let completed = 0;
  for (let i = 0; i < batches.length; i += VAL_CONCURRENCY) {
    const group = batches.slice(i, i + VAL_CONCURRENCY);
    const results = await Promise.all(group.map(batch => {
      const codes = batch.map(t => t.thscode || t.ticker).filter(Boolean).join(",");
      if (!codes) return Promise.resolve([]);
      return thsFetch("/api/a-share/valuations/snapshot", { thscodes: codes })
        .then(d => extractItems(d))
        .catch(e => {
          console.warn("[估值] 批次失败:", (e && e.message) || e);
          return [];
        });
    }));

    for (const items of results) {
      for (const v of items) {
        const pure = String(v.ticker || "");
        const full = String(v.thscode || "");
        if (pure) map.set(pure, v);
        if (full) map.set(full, v);
      }
      completed++;
    }
    onProgress?.(Math.min(completed * VAL_BATCH_SIZE, total), total);
  }
  return map;
}

// ============================================================
// 加载数据（主编排）
// ============================================================
async function loadDataFromTHS() {
  if (isLoadingTHS) return;

  const inputEl = document.getElementById("thsApiKey");
  const inputKey = inputEl ? inputEl.value.trim() : "";
  if (inputKey && inputKey !== getStoredKey()) {
    safeSetItem(THS_KEY_STORAGE, inputKey);
  }
  if (!getApiKey()) {
    showError("请先输入同花顺 API Key");
    if (inputEl) inputEl.focus();
    return;
  }

  hideError();
  isLoadingTHS = true;
  const btn = document.getElementById("loadThsBtn");
  btn.disabled = true;
  btn.textContent = "⏳ 加载中...";
  showLoading(true);
  setLoadingText("正在并行拉取标的列表 + 行情快照...");

  const t0 = performance.now();

  try {
    const [tickers, priceMap] = await Promise.all([
      fetchAllTickers(count => setStatus(`正在拉取标的列表... 已获取 ${count} 只`)),
      fetchPriceSnapshot().then(map => {
        console.log(`[行情] 快照 ${map.size} 条`);
        return map;
      })
    ]);

    if (tickers.length === 0) throw new Error("标的列表为空，请检查 API Key。");

    setLoadingText("正在并发拉取估值数据...");
    let valMap = new Map();
    try {
      valMap = await fetchValuations(tickers, (done, total) => {
        setStatus(`正在拉取估值数据... ${done} / ${total}`);
      });
    } catch (e) {
      console.warn("[估值] 整体失败，PE/PB 将显示为 —:", e);
    }

    allData = tickers.map(t => mergeRow(t, priceMap, valMap)).filter(r => r.code);

    updateStats();
    refreshFilterUI();
    applyFilters();

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const matched = allData.filter(r => r.price !== null).length;
    const withInd = allData.filter(r => r.industry && r.industry !== "未知").length;
    const withPE = allData.filter(r => r.pe !== null).length;
    setStatus(`✅ ${allData.length} 只 · 行情 ${matched} · 行业 ${withInd} · PE ${withPE} · 耗时 ${elapsed}s`);

  } catch (e) {
    console.error(e);
    setStatus(`⚠️ 失败：${e.message.split("\n")[0]}`);
    showError("加载失败：\n\n" + e.message);
  } finally {
    isLoadingTHS = false;
    btn.disabled = false;
    btn.textContent = "🔴 从同花顺API加载";
    showLoading(false);
  }
}

function mergeRow(t, priceMap, valMap) {
  const thscode = String(t.thscode || t.ticker || "");
  const pure = String(t.ticker || thscode.replace(/\.(SH|SZ|BJ)$/i, ""));
  const exchange = String(t.exchange || "").toUpperCase();
  const name = String(t.name || "");
  const listDate = String(t.list_date || "");
  const p = priceMap.get(thscode) || priceMap.get(pure) || {};
  const v = valMap.get(thscode) || valMap.get(pure) || {};
  const price  = toNum(p.last_price);
  const chgPct = toNum(p.price_change_ratio_pct);
  const chgAmt = toNum(p.price_change);
  const open   = toNum(p.open_price);
  const high   = toNum(p.high_price);
  const low    = toNum(p.low_price);
  const prev   = toNum(p.prev_price);
  const turnoverYuan = toNum(p.turnover);
  const volumeSh = toNum(p.volume);
  const market = classifyMarket(pure, exchange);
  const ind = lookupIndustry(pure);
  const pe = pickNum(v, ["pe_ttm", "peTTM", "pe", "pe_mrq", "pe_ratio"]);
  const pb = pickNum(v, ["pb", "pb_mrq", "pb_ratio", "pbr"]);
  let amplitude = null;
  if (high !== null && low !== null && prev) {
    amplitude = +(((high - low) / prev) * 100).toFixed(2);
  }
  const limRatio = getLimitRatio(market);
  const limitUp = prev !== null ? +(prev * (1 + limRatio)).toFixed(2) : null;
  const limitDown = prev !== null ? +(prev * (1 - limRatio)).toFixed(2) : null;
  const finalName = name || String(v.name || "");
  return {
    code: thscode || (pure + "." + exchange),
    pureCode: pure,
    name: finalName,
    exchange, market,
    listDate: listDate || "—",
    listDateRaw: listDate,
    industry: ind.name,
    industryCode: ind.code,
    industryFull: ind.code ? (ind.code + ind.name) : "",
    price, chgPct, chgAmt, open, high, low, prev,
    turnover: turnoverYuan !== null ? turnoverYuan / 1e8 : null,
    volume:   volumeSh !== null ? volumeSh / 100 / 1e4 : null,
    amplitude, pe, pb, limitUp, limitDown,
  };
}

function classifyMarket(code, exchange) {
  if (code.startsWith("688")) return "科创板";
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  if (code.startsWith("8") || code.startsWith("9") || code.startsWith("4") || exchange === "BJ") return "北交所";
  if (exchange === "SH") return "沪市主板";
  if (exchange === "SZ") return "深市主板";
  if (code.startsWith("6")) return "沪市主板";
  return "深市主板";
}

// ============================================================
// 演示数据
// ============================================================
const DEMO_INDUSTRIES = [
  "货币金融服务","资本市场服务","保险业","房地产业","土木工程建筑业",
  "汽车制造业","电气机械和器材制造业","计算机、通信和其他电子设备制造业",
  "医药制造业","酒、饮料和精制茶制造业","食品制造业","软件和信息技术服务业",
  "化学原料和化学制品制造业","有色金属冶炼和压延加工业","专用设备制造业",
  "通用设备制造业","零售业","批发业","电力、热力生产和供应业",
];
function generateDemoData(count) {
  const base = [];
  const prefixes = {
    "沪市主板":["600","601","603","605"], "深市主板":["000","001","002","003"],
    "创业板":["300","301"], "科创板":["688"], "北交所":["832","833","870","871","920"]
  };
  const exchOf = { "沪市主板":"SH", "深市主板":"SZ", "创业板":"SZ", "科创板":"SH", "北交所":"BJ" };
  const markets = Object.keys(prefixes);
  for (let i = 0; i < count; i++) {
    const mk = markets[i % markets.length];
    const pfx = prefixes[mk][i % prefixes[mk].length];
    const num = String(1000 + (i * 7) % 9000).padStart(4,"0").slice(-4);
    const exch = exchOf[mk];
    const y = 1995 + Math.floor(Math.random() * 30);
    const m = String(1 + Math.floor(Math.random()*12)).padStart(2,"0");
    const d = String(1 + Math.floor(Math.random()*28)).padStart(2,"0");
    const prev = +(5 + Math.random() * 50).toFixed(2);
    const chgPct = +((Math.random() - 0.45) * 10).toFixed(2);
    const price = +(prev * (1 + chgPct/100)).toFixed(2);
    const open = +(prev * (1 + (Math.random()-0.5)/100)).toFixed(2);
    const high = +(Math.max(price, open) * (1 + Math.random()/100)).toFixed(2);
    const low  = +(Math.min(price, open) * (1 - Math.random()/100)).toFixed(2);
    const ind = DEMO_INDUSTRIES[i % DEMO_INDUSTRIES.length];
    const limRatio = mk === "创业板" || mk === "科创板" ? 0.2 : mk === "北交所" ? 0.3 : 0.1;
    base.push({
      code: pfx + num + "." + exch, pureCode: pfx + num,
      name: `示例${String.fromCharCode(65+(i%26))}${1000+i}`,
      market: mk, exchange: exch,
      listDate: `${y}-${m}-${d}`, listDateRaw: `${y}-${m}-${d}`,
      industry: ind, industryCode: "", industryFull: ind,
      price, chgPct, chgAmt: +(price - prev).toFixed(2),
      open, high, low, prev,
      turnover: +(0.1 + Math.random() * 200).toFixed(2),
      volume: +(1 + Math.random() * 500).toFixed(2),
      amplitude: +(((high - low) / prev) * 100).toFixed(2),
      pe: +(5 + Math.random() * 80).toFixed(2) * (Math.random() < 0.12 ? -1 : 1),
      pb: +(0.5 + Math.random() * 8).toFixed(2),
      limitUp: +(prev * (1 + limRatio)).toFixed(2),
      limitDown: +(prev * (1 - limRatio)).toFixed(2),
    });
  }
  return base;
}
function loadDemoData() {
  hideError();
  showLoading(true);
  setLoadingText("正在生成演示数据...");
  setTimeout(() => {
    allData = generateDemoData(5578);
    updateStats(); refreshFilterUI(); applyFilters();
    showLoading(false);
    setStatus(`演示数据 · ${allData.length} 只`);
    showToast(`已载入演示数据 ${allData.length} 只`);
  }, 300);
}

// ============================================================
// 统计
// ============================================================
function updateStats() {
  document.getElementById("statTotal").textContent = allData.length.toLocaleString();
  const c = (m) => allData.filter(d => d.market === m).length;
  document.getElementById("statShMain").textContent = c("沪市主板").toLocaleString();
  document.getElementById("statSzMain").textContent = c("深市主板").toLocaleString();
  document.getElementById("statGem").textContent = c("创业板").toLocaleString();
  document.getElementById("statStar").textContent = c("科创板").toLocaleString();
  document.getElementById("statBj").textContent = c("北交所").toLocaleString();
  const indSet = new Set();
  allData.forEach(d => { if (d.industry && d.industry !== "未知") indSet.add(d.industry); });
  document.getElementById("statIndustry").textContent = indSet.size.toLocaleString();
  const totalStocks = watchlist.groups.reduce((s, g) => s + g.codes.length, 0);
  document.getElementById("statWatchCount").textContent =
    `${watchlist.groups.length} 组 / ${totalStocks} 只`;
  const up = allData.filter(d => d.chgPct !== null && d.chgPct > 0).length;
  const down = allData.filter(d => d.chgPct !== null && d.chgPct < 0).length;
  const el = document.getElementById("statUpDown");
  el.textContent = `${up} / ${down}`;
  el.className = "stat-value " + (up >= down ? "up" : "down");
}

// ============================================================
// 筛选 UI
// ============================================================
function refreshFilterUI() {
  populateWatchlistUI();
  populateMarketUI();
  populateEraUI();
  populateIndustryUI();
}

function populateWatchlistUI() {
  const topSel = document.getElementById("watchFilter");
  topSel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = `⭐ 全部股票（${allData.length}）`;
  topSel.appendChild(optAll);
  watchlist.groups.forEach(g => {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = `⭐ ${g.name}（${g.codes.length}）`;
    topSel.appendChild(o);
  });
  const optNew = document.createElement("option");
  optNew.value = "__new__";
  optNew.textContent = "＋ 新建分组…";
  topSel.appendChild(optNew);
  topSel.value = watchlist.currentId || "all";
  topSel.classList.toggle("active-filter", !!watchlist.currentId);

  const wlTree = document.getElementById("watchlistTree");
  wlTree.innerHTML = "";
  {
    const div = document.createElement("div");
    div.className = "cat-item" + (watchlist.currentId === null ? " active" : "");
    div.innerHTML = `<span class="name">全部股票</span><span class="cat-count">${allData.length.toLocaleString()}</span>`;
    div.onclick = () => setWatchGroup(null);
    wlTree.appendChild(div);
  }
  watchlist.groups.forEach(g => {
    const div = document.createElement("div");
    div.className = "cat-item watch-item" + (watchlist.currentId === g.id ? " active" : "");
    div.innerHTML = `
      <span class="name" title="${escapeHtml(g.name)}（双击重命名）">${escapeHtml(g.name)}</span>
      <span class="cat-count">${g.codes.length}</span>
      <span class="del-btn" title="删除该分组">×</span>
    `;
    div.addEventListener("click", (e) => {
      if (e.target.classList.contains("del-btn")) {
        e.stopPropagation(); deleteGroup(g.id); return;
      }
      setWatchGroup(g.id);
    });
    div.querySelector(".name").addEventListener("dblclick", (e) => {
      e.stopPropagation(); renameGroup(g.id);
    });
    wlTree.appendChild(div);
  });
}

function populateMarketUI() {
  const curMkt = document.getElementById("marketFilter").value;
  document.getElementById("marketFilter").classList.toggle("active-filter", curMkt !== "all");
  const mktTree = document.getElementById("marketTree");
  mktTree.innerHTML = "";
  const markets = [
    { value: "all", label: "全部市场" },
    { value: "沪市主板", label: "沪市主板" },
    { value: "深市主板", label: "深市主板" },
    { value: "创业板", label: "创业板" },
    { value: "科创板", label: "科创板" },
    { value: "北交所", label: "北交所" },
  ];
  markets.forEach(m => {
    const cnt = m.value === "all" ? allData.length : allData.filter(d => d.market === m.value).length;
    const div = document.createElement("div");
    div.className = "cat-item" + (m.value === curMkt ? " active" : "");
    div.innerHTML = `<span class="name">${m.label}</span><span class="cat-count">${cnt.toLocaleString()}</span>`;
    div.onclick = () => setMarket(m.value);
    mktTree.appendChild(div);
  });
}

function populateEraUI() {
  const topSel = document.getElementById("eraFilterTop");
  topSel.value = filterEra;
  topSel.classList.toggle("active-filter", filterEra !== "all");
  const eraTree = document.getElementById("eraTree");
  eraTree.innerHTML = "";
  const curMkt = document.getElementById("marketFilter").value;
  const marketScoped = curMkt === "all" ? allData : allData.filter(d => d.market === curMkt);
  const eras = [
    { key: "all", label: "全部年代" },
    { key: "1990", label: "1990-1999" },
    { key: "2000", label: "2000-2009" },
    { key: "2010", label: "2010-2019" },
    { key: "2020", label: "2020 至今" },
  ];
  eras.forEach(era => {
    const cnt = era.key === "all" ? marketScoped.length : marketScoped.filter(d => eraMatch(d.listDateRaw, era.key)).length;
    const div = document.createElement("div");
    div.className = "cat-item" + (era.key === filterEra ? " active" : "");
    div.innerHTML = `<span class="name">${era.label}</span><span class="cat-count">${cnt.toLocaleString()}</span>`;
    div.onclick = () => setEra(era.key);
    eraTree.appendChild(div);
  });
}

function populateIndustryUI() {
  const curMkt = document.getElementById("marketFilter").value;
  const base = allData.filter(d => {
    if (curMkt !== "all" && d.market !== curMkt) return false;
    if (!eraMatch(d.listDateRaw, filterEra)) return false;
    return true;
  });
  const counts = {};
  base.forEach(d => { const ind = d.industry || "未知"; counts[ind] = (counts[ind] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (filterIndustry !== "all" && !sorted.find(x => x[0] === filterIndustry)) filterIndustry = "all";
  const topSel = document.getElementById("industryFilterTop");
  topSel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = `全部行业（${base.length}）`;
  topSel.appendChild(optAll);
  sorted.forEach(([ind, cnt]) => {
    const o = document.createElement("option");
    o.value = ind;
    o.textContent = `${ind}（${cnt}）`;
    topSel.appendChild(o);
  });
  topSel.value = filterIndustry;
  topSel.classList.toggle("active-filter", filterIndustry !== "all");
  const indTree = document.getElementById("industryTree");
  indTree.innerHTML = "";
  {
    const div = document.createElement("div");
    div.className = "cat-item" + (filterIndustry === "all" ? " active" : "");
    div.innerHTML = `<span class="name">全部行业</span><span class="cat-count">${base.length.toLocaleString()}</span>`;
    div.onclick = () => setIndustry("all");
    indTree.appendChild(div);
  }
  sorted.forEach(([ind, cnt]) => {
    const div = document.createElement("div");
    div.className = "cat-item" + (ind === filterIndustry ? " active" : "");
    div.title = ind;
    div.innerHTML = `<span class="name">${escapeHtml(ind)}</span><span class="cat-count">${cnt.toLocaleString()}</span>`;
    div.onclick = () => setIndustry(ind);
    indTree.appendChild(div);
  });
}

// ============================================================
// 高级筛选
// ============================================================
const ADV_INPUT_IDS = [
  "fPriceMin","fPriceMax","fChgMin","fChgMax",
  "fAmpMin","fAmpMax","fPeMin","fPeMax",
  "fPbMin","fPbMax","fToMin","fToMax"
];
const ADV_CHECK_IDS = ["fExST","fOnlyQuote","fOnlyUp","fOnlyLimitUp"];

function toggleAdv() {
  const body = document.getElementById("advBody");
  const icon = document.getElementById("advToggleIcon");
  body.classList.toggle("collapsed");
  icon.textContent = body.classList.contains("collapsed") ? "展开 ▼" : "收起 ▲";
}
function setRange(minId, maxId, min, max, btn) {
  const a = document.getElementById(minId), b = document.getElementById(maxId);
  const wasActive = btn && btn.classList.contains("active");
  if (wasActive) {
    if (a) a.value = "";
    if (b) b.value = "";
    btn.classList.remove("active");
  } else {
    if (a) a.value = (min === "" || min === null || min === undefined) ? "" : min;
    if (b) b.value = (max === "" || max === null || max === undefined) ? "" : max;
    if (btn) {
      const group = btn.closest(".quick-btns");
      if (group) group.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
    }
  }
  applyFilters();
}
function onAdvInput(el) {
  const row = el.closest(".adv-row");
  if (row) row.querySelectorAll(".quick-btns button.active").forEach(b => b.classList.remove("active"));
  applyFilters();
}
function resetAdvRow(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.querySelectorAll('input[type="number"]').forEach(el => el.value = "");
  row.querySelectorAll('input[type="checkbox"]').forEach(el => el.checked = false);
  row.querySelectorAll(".quick-btns button.active").forEach(b => b.classList.remove("active"));
  applyFilters();
  updateAdvBadge();
}
function clearAdvInputs() {
  ADV_INPUT_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ADV_CHECK_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  document.querySelectorAll(".quick-btns button.active").forEach(b => b.classList.remove("active"));
  updateAdvBadge();
}
function clearAdv() { clearAdvInputs(); applyFilters(); }
function numVal(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const v = el.value.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function countAdvActive() {
  let n = 0;
  const pairs = [
    ["fPriceMin","fPriceMax"], ["fChgMin","fChgMax"], ["fAmpMin","fAmpMax"],
    ["fPeMin","fPeMax"], ["fPbMin","fPbMax"], ["fToMin","fToMax"]
  ];
  pairs.forEach(([a, b]) => { if (numVal(a) !== null || numVal(b) !== null) n++; });
  ADV_CHECK_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.checked) n++;
  });
  return n;
}
function updateAdvBadge() {
  const n = countAdvActive();
  const badge = document.getElementById("advBadge");
  if (!badge) return;
  badge.style.display = n > 0 ? "inline-block" : "none";
  badge.textContent = n;
}

// ============================================================
// 筛选与排序
// ============================================================
function applyFilters(resetPage = true) {
  const kw = document.getElementById("searchInput").value.trim().toLowerCase();
  const market = document.getElementById("marketFilter").value;
  const sortBy = document.getElementById("sortSelect").value;
  const curGroup = getCurrentGroup();
  const pMin = numVal("fPriceMin"), pMax = numVal("fPriceMax");
  const cMin = numVal("fChgMin"),   cMax = numVal("fChgMax");
  const amMin = numVal("fAmpMin"),  amMax = numVal("fAmpMax");
  const peMin = numVal("fPeMin"),   peMax = numVal("fPeMax");
  const pbMin = numVal("fPbMin"),   pbMax = numVal("fPbMax");
  const toMin = numVal("fToMin"),   toMax = numVal("fToMax");
  const exST = document.getElementById("fExST").checked;
  const onlyQuote = document.getElementById("fOnlyQuote").checked;
  const onlyUp = document.getElementById("fOnlyUp").checked;
  const onlyLimitUp = document.getElementById("fOnlyLimitUp").checked;
  const inRange = (v, lo, hi) => {
    if (lo === null && hi === null) return true;
    if (v === null || v === undefined || !Number.isFinite(v)) return false;
    if (lo !== null && v < lo) return false;
    if (hi !== null && v > hi) return false;
    return true;
  };
  filteredData = allData.filter(d => {
    if (curGroup && !curGroup.codes.includes(d.pureCode)) return false;
    if (market !== "all" && d.market !== market) return false;
    if (!eraMatch(d.listDateRaw, filterEra)) return false;
    if (filterIndustry !== "all" && (d.industry || "未知") !== filterIndustry) return false;
    if (kw) {
      const hay = (d.code + d.name + (d.industry || "")).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (!inRange(d.price, pMin, pMax)) return false;
    if (!inRange(d.chgPct, cMin, cMax)) return false;
    if (!inRange(d.amplitude, amMin, amMax)) return false;
    if (!inRange(d.pe, peMin, peMax)) return false;
    if (!inRange(d.pb, pbMin, pbMax)) return false;
    if (!inRange(d.turnover, toMin, toMax)) return false;
    if (exST && /ST|退/i.test(d.name)) return false;
    if (onlyQuote && d.price === null) return false;
    if (onlyUp && !(d.chgPct > 0)) return false;
    if (onlyLimitUp) {
      if (d.price === null || d.limitUp === null || d.prev === null) return false;
      if (Math.abs(d.price - d.limitUp) > 0.011) return false;
    }
    return true;
  });
  const sorters = {
    code_asc: (a,b) => a.code.localeCompare(b.code),
    industry_asc: (a,b) => (a.industry||"").localeCompare(b.industry||"") || a.code.localeCompare(b.code),
    chg_desc: (a,b) => (b.chgPct ?? -Infinity) - (a.chgPct ?? -Infinity),
    chg_asc:  (a,b) => (a.chgPct ??  Infinity) - (b.chgPct ??  Infinity),
    turnover_desc: (a,b) => (b.turnover ?? -Infinity) - (a.turnover ?? -Infinity),
    volume_desc:   (a,b) => (b.volume ?? -Infinity) - (a.volume ?? -Infinity),
    price_desc:    (a,b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    price_asc:     (a,b) => (a.price ??  Infinity) - (b.price ??  Infinity),
    amplitude_desc: (a,b) => (b.amplitude ?? -Infinity) - (a.amplitude ?? -Infinity),
    pe_asc: (a,b) => (a.pe ?? Infinity) - (b.pe ?? Infinity),
    pb_asc: (a,b) => (a.pb ?? Infinity) - (b.pb ?? Infinity),
    list_date_desc: (a,b) => String(b.listDateRaw||"").localeCompare(String(a.listDateRaw||"")),
  };
  filteredData.sort(sorters[sortBy] || sorters.code_asc);
  if (resetPage) currentPage = 1;
  updateAdvBadge();
  renderTable();
}

// ============================================================
// 表格渲染 + 分页
// ============================================================
function fmt(v, dec = 2) {
  if (v === null || v === undefined) return `<span class="dim">—</span>`;
  return Number(v).toFixed(dec);
}
function renderTable() {
  const tbody = document.getElementById("tableBody");
  const total = filteredData.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > maxPage) currentPage = maxPage;
  const pageData = filteredData.slice((currentPage-1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const target = getTargetGroup();
  const targetName = target ? target.name : "自选";

  if (pageData.length === 0) {
    const curGroup = getCurrentGroup();
    let emptyMsg = "没有符合条件的股票";
    if (curGroup) {
      emptyMsg = curGroup.codes.length === 0
        ? `「${curGroup.name}」还是空的 —— 在左侧选「全部股票」再点表格里的 ➕ 加进来`
        : `「${curGroup.name}」里没有符合当前筛选条件的股票`;
    }
    tbody.innerHTML = `<tr><td colspan="20" class="empty">${emptyMsg}</td></tr>`;
    renderPagination();
    return;
  }

  tbody.innerHTML = pageData.map(d => {
    const tagCls = d.market==="沪市主板"||d.market==="深市主板" ? "tag-main"
      : d.market==="创业板" ? "tag-gem"
      : d.market==="科创板" ? "tag-star" : "tag-bj";
    const cls = d.chgPct === null ? "num-flat" : (d.chgPct > 0 ? "num-up" : d.chgPct < 0 ? "num-down" : "num-flat");
    const chgText = d.chgPct === null ? "—" : (d.chgPct > 0 ? "+" : "") + d.chgPct.toFixed(2) + "%";
    const chgAmtText = d.chgAmt === null ? "—" : (d.chgAmt > 0 ? "+" : "") + d.chgAmt.toFixed(2);
    const pureCode = d.pureCode || d.code.replace(/\.(SH|SZ|BJ)$/,"");
    const indDisplay = d.industry && d.industry !== "未知"
      ? `<span class="ind-cell" title="${escapeHtml(d.industryFull || d.industry)}">${escapeHtml(d.industry)}</span>`
      : `<span class="dim">—</span>`;
    const starred = target ? target.codes.includes(pureCode) : false;
    const btnChar = starred ? "−" : "+";
    const btnCls = starred ? "add-btn on" : "add-btn";
    const btnTitle = starred ? `从「${targetName}」移除` : `加入「${targetName}」`;
    return `<tr>
      <td style="padding:5px 6px;text-align:center;">
        <button class="${btnCls}" data-code="${pureCode}" title="${btnTitle}">${btnChar}</button>
      </td>
      <td><a class="code-link" href="https://stockpage.10jqka.com.cn/${pureCode}/" target="_blank" rel="noopener">${d.code}</a></td>
      <td><strong>${escapeHtml(d.name || "—")}</strong></td>
      <td><span class="tag ${tagCls}">${d.market}</span></td>
      <td>${indDisplay}</td>
      <td class="dim">${d.listDate}</td>
      <td class="${cls}"><b>${fmt(d.price)}</b></td>
      <td class="${cls}"><b>${chgText}</b></td>
      <td class="${cls}">${chgAmtText}</td>
      <td>${fmt(d.amplitude)}</td>
      <td>${fmt(d.open)}</td>
      <td class="num-up">${fmt(d.high)}</td>
      <td class="num-down">${fmt(d.low)}</td>
      <td class="dim">${fmt(d.prev)}</td>
      <td class="num-up">${fmt(d.limitUp)}</td>
      <td class="num-down">${fmt(d.limitDown)}</td>
      <td>${fmt(d.turnover)}</td>
      <td>${fmt(d.volume, 1)}</td>
      <td>${fmt(d.pe)}</td>
      <td>${fmt(d.pb)}</td>
    </tr>`;
  }).join("");
  renderPagination();
}

function renderPagination() {
  const total = filteredData.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const curGroup = getCurrentGroup();
  const status = curGroup
    ? `⭐ 正在查看「${curGroup.name}」（${curGroup.codes.length} 只）`
    : "查看全部股票";
  document.getElementById("pageInfo").textContent =
    `第 ${currentPage} / ${maxPage} 页 · 共 ${total.toLocaleString()} 只 · ${status}`;
  document.getElementById("prevBtn").disabled = currentPage <= 1;
  document.getElementById("nextBtn").disabled = currentPage >= maxPage;
  document.getElementById("firstBtn").disabled = currentPage <= 1;
  document.getElementById("lastBtn").disabled = currentPage >= maxPage;
  const c = document.getElementById("pageNumbers");
  c.innerHTML = "";
  if (maxPage <= 1) return;
  const NUM_COUNT = 6;
  let start = Math.max(1, currentPage - Math.floor(NUM_COUNT / 2));
  let end = start + NUM_COUNT - 1;
  if (end > maxPage) { end = maxPage; start = Math.max(1, end - NUM_COUNT + 1); }
  if (start > 1) {
    const e = document.createElement("span"); e.className = "page-ellipsis"; e.textContent = "…";
    c.appendChild(e);
  }
  for (let i = start; i <= end; i++) {
    const b = document.createElement("button");
    b.textContent = i;
    b.className = (i === currentPage) ? "active" : "";
    b.onclick = () => goToPage(i);
    c.appendChild(b);
  }
  if (end < maxPage) {
    const e = document.createElement("span"); e.className = "page-ellipsis"; e.textContent = "…";
    c.appendChild(e);
  }
  const ji = document.getElementById("jumpInput");
  ji.max = maxPage;
  ji.placeholder = `1-${maxPage}`;
}
function goToPage(p) {
  const maxPage = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  currentPage = Math.min(maxPage, Math.max(1, p));
  renderTable();
  scrollToTableTop();
}
function changePage(d) { goToPage(currentPage + d); }
function goFirst() { goToPage(1); }
function goLast() { goToPage(Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE))); }
function jumpToPage() {
  const i = document.getElementById("jumpInput");
  const v = parseInt(i.value, 10);
  if (!isNaN(v)) { goToPage(v); i.value = ""; }
}
function scrollToTableTop() {
  const w = document.querySelector(".table-wrap");
  if (w) window.scrollTo({ top: w.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
}
function scrollToTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }
function goFirstAndTop() { currentPage = 1; renderTable(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function showLoading(show) {
  const el = document.getElementById("loadingOverlay");
  if (el) el.classList.toggle("show", !!show);
}

// ============================================================
// 事件绑定
// ============================================================
document.querySelectorAll("thead th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    document.getElementById("sortSelect").value = th.dataset.sort;
    applyFilters();
  });
});
document.getElementById("searchInput").addEventListener("input", applyFilters);
document.getElementById("marketFilter").addEventListener("change", (e) => setMarket(e.target.value));
document.getElementById("eraFilterTop").addEventListener("change", (e) => setEra(e.target.value));
document.getElementById("industryFilterTop").addEventListener("change", (e) => setIndustry(e.target.value));
document.getElementById("watchFilter").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "__new__") {
    e.target.value = watchlist.currentId || "all";
    createGroupInteractive();
    return;
  }
  setWatchGroup(v === "all" ? null : v);
});
document.getElementById("sortSelect").addEventListener("change", applyFilters);
document.getElementById("tableBody").addEventListener("click", (e) => {
  const btn = e.target.closest(".add-btn");
  if (!btn) return;
  e.preventDefault();
  const code = btn.dataset.code;
  if (code) toggleWatch(code);
});
document.addEventListener("keydown", (e) => {
  if (isDialogOpen()) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Home") { e.preventDefault(); goFirstAndTop(); }
  if (e.key === "End")  { e.preventDefault(); goLast(); }
  if (e.key === "ArrowLeft" && e.altKey)  { e.preventDefault(); changePage(-1); }
  if (e.key === "ArrowRight" && e.altKey) { e.preventDefault(); changePage(1); }
});

// ============================================================
// 📊 每日涨跌分类导出
// ============================================================
let dataDirHandle = null;
let isExporting = false;

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function groupByMarketAndIndustry(stocks) {
  const result = {};
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const mkt = s.market || "未知";
    const ind = s.industry || "未知";
    if (!result[mkt]) result[mkt] = { count: 0, industries: {} };
    result[mkt].count++;
    if (!result[mkt].industries[ind]) {
      result[mkt].industries[ind] = { count: 0, stocks: [] };
    }
    result[mkt].industries[ind].count++;
    result[mkt].industries[ind].stocks.push({
      code: s.code, pureCode: s.pureCode, name: s.name,
      price: s.price, chgPct: s.chgPct, chgAmt: s.chgAmt,
      open: s.open, high: s.high, low: s.low, prev: s.prev,
      amplitude: s.amplitude, turnover: s.turnover, volume: s.volume,
      pe: s.pe, pb: s.pb, limitUp: s.limitUp, limitDown: s.limitDown
    });
  }
  return result;
}

function countByField(stocks, field) {
  const result = {};
  for (let i = 0; i < stocks.length; i++) {
    const key = stocks[i][field] || "未知";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function buildDailyReport() {
  const up = [], down = [], flat = [];
  for (let i = 0; i < allData.length; i++) {
    const s = allData[i];
    if (s.chgPct === null || s.chgPct === undefined) { flat.push(s); continue; }
    if (s.chgPct > 0) up.push(s);
    else if (s.chgPct < 0) down.push(s);
    else flat.push(s);
  }
  return {
    date: todayStr(),
    generatedAt: new Date().toISOString(),
    total: allData.length,
    counts: { up: up.length, down: down.length, flat: flat.length },
    stats: {
      up:   { byMarket: countByField(up,   "market"), byIndustry: countByField(up,   "industry") },
      down: { byMarket: countByField(down, "market"), byIndustry: countByField(down, "industry") },
      flat: { byMarket: countByField(flat, "market"), byIndustry: countByField(flat, "industry") }
    },
    byDirection: {
      up:   groupByMarketAndIndustry(up),
      down: groupByMarketAndIndustry(down),
      flat: groupByMarketAndIndustry(flat)
    }
  };
}

function escapeCsv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildAllStocksCSV(report) {
  const headers = ["方向","代码","名称","市场","行业","现价","涨跌幅%","涨跌额","开盘","最高","最低","昨收","振幅%","成交额(亿)","成交量(万手)","PE(TTM)","PB"];
  const rows = [headers.join(",")];
  const dirs = [
    ["上涨", report.byDirection.up],
    ["下跌", report.byDirection.down],
    ["平盘", report.byDirection.flat]
  ];
  for (let d = 0; d < dirs.length; d++) {
    const dirLabel = dirs[d][0];
    const grouped = dirs[d][1];
    const markets = Object.keys(grouped);
    for (let m = 0; m < markets.length; m++) {
      const market = markets[m];
      const industries = grouped[market].industries;
      const indNames = Object.keys(industries);
      for (let k = 0; k < indNames.length; k++) {
        const industry = indNames[k];
        const list = industries[industry].stocks;
        for (let n = 0; n < list.length; n++) {
          const s = list[n];
          const row = [
            dirLabel, s.code, s.name, market, industry,
            s.price === null ? "" : s.price,
            s.chgPct === null ? "" : s.chgPct,
            s.chgAmt === null ? "" : s.chgAmt,
            s.open === null ? "" : s.open,
            s.high === null ? "" : s.high,
            s.low === null ? "" : s.low,
            s.prev === null ? "" : s.prev,
            s.amplitude === null ? "" : s.amplitude,
            s.turnover === null ? "" : s.turnover,
            s.volume === null ? "" : s.volume,
            s.pe === null ? "" : s.pe,
            s.pb === null ? "" : s.pb
          ].map(escapeCsv).join(",");
          rows.push(row);
        }
      }
    }
  }
  return "\ufeff" + rows.join("\n");
}

async function writeFileToDir(dirHandle, name, content) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

function updateDirBtnVisibility() {
  const btn = document.getElementById("changeDirBtn");
  if (btn) btn.style.display = dataDirHandle ? "" : "none";
}

function changeDataDir() {
  dataDirHandle = null;
  updateDirBtnVisibility();
  showToast("已清除目录记忆，下次导出时重新选择", "warn");
}

function fallbackDownloadJSON(report) {
  try {
    const merged = {
      date: report.date,
      generatedAt: report.generatedAt,
      total: report.total,
      counts: report.counts,
      stats: report.stats,
      上涨: report.byDirection.up,
      下跌: report.byDirection.down,
      平盘: report.byDirection.flat
    };
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stock_data_" + report.date + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  } catch (e) { console.warn("JSON 兜底下载失败:", e); }

  try {
    const csv = buildAllStocksCSV(report);
    const blob2 = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url2 = URL.createObjectURL(blob2);
    const a2 = document.createElement("a");
    a2.href = url2;
    a2.download = "stock_data_" + report.date + ".csv";
    document.body.appendChild(a2);
    a2.click();
    a2.remove();
    setTimeout(function () { URL.revokeObjectURL(url2); }, 1000);
  } catch (e) { console.warn("CSV 兜底下载失败:", e); }
}

async function exportDailyData() {
  if (isExporting) return;
  if (allData.length === 0) {
    showError("请先加载数据，再导出每日分类。");
    showToast("请先加载数据", "warn");
    return;
  }

  isExporting = true;
  const btn = document.getElementById("exportDailyBtn");
  const origText = btn ? btn.textContent : "📊 导出今日涨跌分类";
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 导出中..."; }

  let report = null;
  try {
    report = buildDailyReport();
    const dateStr = report.date;
    console.log("[导出] 报表已构建", report);

    const hasFSA = typeof window.showDirectoryPicker === "function";
    console.log("[导出] showDirectoryPicker 可用:", hasFSA);
    if (!hasFSA) {
      showToast("浏览器不支持直接写文件夹，已改为下载文件", "warn");
      fallbackDownloadJSON(report);
      setStatus("✅ 已下载 JSON + CSV");
      return;
    }

    let dirHandle = dataDirHandle;
    if (!dirHandle) {
      try {
        console.log("[导出] 弹出目录选择框...");
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        console.log("[导出] 已选目录:", dirHandle.name);
        dataDirHandle = dirHandle;
        updateDirBtnVisibility();
      } catch (e) {
        console.warn("[导出] 用户取消或失败:", e);
        showToast("已取消导出", "warn");
        return;
      }
    } else {
      try {
        let perm = await dirHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
          perm = await dirHandle.requestPermission({ mode: "readwrite" });
        }
        if (perm !== "granted") {
          console.warn("[导出] 权限被拒绝");
          dataDirHandle = null;
          updateDirBtnVisibility();
          showToast("权限被拒绝，请重新选择文件夹", "warn");
          return;
        }
      } catch (e) {
        console.warn("[导出] 权限检查异常:", e);
        dataDirHandle = null;
        updateDirBtnVisibility();
        showToast("权限检查失败，请重新选择文件夹", "warn");
        return;
      }
    }

    console.log("[导出] 创建日期文件夹:", dateStr);
    const dayDir = await dirHandle.getDirectoryHandle(dateStr, { create: true });

    const overview = {
      date: report.date,
      generatedAt: report.generatedAt,
      total: report.total,
      counts: report.counts,
      stats: report.stats,
      note: "按板块 → 行业 → 个股 三层分类，详见同目录 02/03/04 号文件"
    };

    console.log("[导出] 写入 01-总览.json");
    await writeFileToDir(dayDir, "01-总览.json", JSON.stringify(overview, null, 2));

    console.log("[导出] 写入 02-上涨-按板块行业.json");
    await writeFileToDir(dayDir, "02-上涨-按板块行业.json", JSON.stringify(report.byDirection.up, null, 2));

    console.log("[导出] 写入 03-下跌-按板块行业.json");
    await writeFileToDir(dayDir, "03-下跌-按板块行业.json", JSON.stringify(report.byDirection.down, null, 2));

    console.log("[导出] 写入 04-平盘-按板块行业.json");
    await writeFileToDir(dayDir, "04-平盘-按板块行业.json", JSON.stringify(report.byDirection.flat, null, 2));

    console.log("[导出] 写入 05-全部股票.csv");
    await writeFileToDir(dayDir, "05-全部股票.csv", buildAllStocksCSV(report));

    console.log("[导出] ✅ 全部完成");
    const folderName = dirHandle.name || "所选目录";
    setStatus("✅ 已导出 → " + folderName + "/" + dateStr + "/");
    showToast("已保存到「" + folderName + "/" + dateStr + "/」");

  } catch (e) {
    console.error("[导出] ❌ 失败:", e);
    const msg = e && e.message ? e.message : String(e);
    showError("导出失败：\n" + msg + "\n\n（已尝试下载合并 JSON 作为兜底）");
    try {
      fallbackDownloadJSON(report || buildDailyReport());
    } catch (_) {}
  } finally {
    isExporting = false;
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function testExport() {
  console.log("[自检] 开始");
  if (typeof window.showDirectoryPicker !== "function") {
    alert("你的浏览器不支持 showDirectoryPicker，请改用 Chrome / Edge 86+");
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    console.log("[自检] 已选目录:", dir.name);
    const fh = await dir.getFileHandle("_test_写入测试.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("测试成功\n时间：" + new Date().toLocaleString());
    await w.close();
    alert("✅ 文件夹写入正常！\n\n如果导出仍失败，请把 F12 Console 里的报错截图发我。");
  } catch (e) {
    console.error("[自检] 失败:", e);
    alert("❌ 写入失败：" + (e && e.message ? e.message : e));
  }
}

// ============================================================
// 启动
// ============================================================
(function init() {
  const savedTheme = safeGetItem(THEME_KEY) || "dark";
  applyTheme(savedTheme);
  const savedScale = parseFloat(safeGetItem(FONT_SCALE_KEY));
  applyFontScale(Number.isFinite(savedScale) ? savedScale : 1);

  const k = getStoredKey();
  if (k) {
    document.getElementById("thsApiKey").value = k;
    setStatus("已检测到 API Key，点击「从同花顺API加载」");
  } else {
    setStatus("等待加载... 请先填写 API Key");
  }

  loadWatchlist();
  console.log(`[自选] 已从本地恢复 ${watchlist.groups.length} 个分组`);

  setTimeout(() => {
    if (window.INDUSTRY_MAP) {
      const cnt = Object.keys(window.INDUSTRY_MAP).length;
      console.log(`[行业] industry_map.js 已加载，共 ${cnt} 条`);
    } else {
      console.warn("[行业] industry_map.js 未加载，行业列将显示 —");
    }
  }, 100);
})();