// 鯉魚國小來賓通報系統：工作人員端（接待報到／介紹台／名單與 QR）
import {
  configured, auth, db, googleLogin, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit,
  writeBatch, runTransaction
} from "./firebase.js";
import { $, pad, fmt, esc, newId, toast, startClock, siteBase, qrCanvas, saveBlob } from "./utils.js";
import { SCHOOL, CATS } from "./config.js";

const LAST = CATS[CATS.length - 1];
const catRank = c => { const i = CATS.indexOf(c); return i < 0 ? 99 : i; };
const grpOf = g => CATS.includes(g.cat) ? g.cat : LAST;
const nameKey = s => (s || "").replace(/\s/g, "");
const who = g => `${g.title ? g.title + " " : ""}${g.name || ""}`.trim();
const catCls = c => { const i = CATS.indexOf(c); return "k" + (i < 0 ? CATS.length - 1 : i); };
const catPill = c => `<span class="cat ${catCls(c)}">${esc(c)}</span>`;
// 報到序號：像醫院掛號，每場活動從 001 開始
const noTxt = n => typeof n === "number" ? String(n).padStart(3, "0") : "";
const noPill = g => typeof g.no === "number" ? `<span class="regno">${noTxt(g.no)}<small>號</small></span>` : (g.status === "arrived" || g.status === "introduced") && !numBlocked ? `<span class="regno wait">取號中</span>` : "";
const P_SIZE = 8, D_SIZE = 15;

// ---------- 狀態 ----------
let me = null, isStaff = false, isAdmin = false, isOwner = false, staffDoc = { owner: "", admins: [], emails: [] };
const ROLE_NAME = { owner: "系統管理者", admin: "管理者", staff: "工作人員" };
let guests = [], cfg = { event: "", notice: "" }, loaded = false;
let prevStatus = new Map(), fresh = new Set(), scanId = null, reviewKey = "";
let expTab = CATS[0], stageTab = CATS[0], pPage = 0, dPage = 0;
let curPending = [], curTabIds = [], drag = null, unsubs = [], requests = [];
// 送達確認：hasPendingWrites 的資料代表「這台裝置寫了、伺服器還沒確認」
const SLOW_MS = 6000;
let pendSince = new Map(), ackWatch = new Map(), connErr = "";
let conn = { online: false, syncedAt: 0, updatedAt: 0, offlineSince: 0, startedAt: 0 };
// 介紹台「下一位」
let nextId = null, pinned = false, knownFirst = new Set(), firstAlertId = null, dismissed = new Set(), forceNext = null, undoInfo = null;
// 活動紀錄
let archives = [], archErr = "", archAsk = null;
let allIds = [], numbering = false, numTimer = null, numBlocked = false;
const counterRef = () => doc(db, "settings", "counter");
try { const t = localStorage.getItem("liyu-exp-tab"); if (CATS.includes(t)) expTab = t; } catch (e) {}
try { const t = localStorage.getItem("liyu-stage-tab"); if (CATS.includes(t)) stageTab = t; } catch (e) {}

$("#schoolName").textContent = SCHOOL.name;
startClock($("#clock"));
$("#w-cat").innerHTML = CATS.map((c, i) => `<input type="radio" name="wcat" id="wcat${i}" value="${esc(c)}"${i === 1 ? " checked" : ""}><label for="wcat${i}">${esc(c)}</label>`).join("");
const tabsHtml = cls => CATS.map(c => `<button type="button" role="tab" class="stab ${cls} ${catCls(c)}" data-grp="${esc(c)}">${esc(c)} <span class="cnt">0</span></button>`).join("");
$("#subtabs").innerHTML = tabsHtml("exp");
$("#stageTabs").innerHTML = tabsHtml("stg");

// ---------- 排序 ----------
function sortPending(a, b) {
  return (b.first ? 1 : 0) - (a.first ? 1 : 0) || catRank(a.cat) - catRank(b.cat) || (a.arrivedAt || 0) - (b.arrivedAt || 0);
}
// 手動拖曳過的依 rank；新到的依自動規則插進去
function orderPending(list) {
  const r = list.filter(g => typeof g.rank === "number").sort((a, b) => a.rank - b.rank);
  const u = list.filter(g => typeof g.rank !== "number").sort(sortPending);
  const out = []; let i = 0, j = 0;
  while (i < u.length || j < r.length) {
    if (j >= r.length || (i < u.length && sortPending(u[i], r[j]) < 0)) out.push(u[i++]); else out.push(r[j++]);
  }
  return out;
}

// ---------- 畫面切換 ----------
const VIEWS = ["reception", "stage", "guests", "system"];
function showView(v) {
  ["landing", ...VIEWS].forEach(x => $("#v-" + x).hidden = x !== v);
  $("#tabs").hidden = v === "landing";
  VIEWS.forEach(x => { const a = document.querySelector(`nav a[data-view="${x}"]`); if (x === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (v === "guests") drawQRs();
}
function route() {
  if (!isStaff) { showView("landing"); render(); return; }
  const h = location.hash.replace("#", "");
  if (h.startsWith("g-")) { scanId = h.slice(2); showView("reception"); render(); return; }
  let v = VIEWS.includes(h) ? h : "reception";
  if (v === "system" && !isOwner) v = "reception";
  showView(v); render();
}
window.addEventListener("hashchange", route);

// ---------- 連線狀態（每個分頁上方常駐顯示） ----------
const hms = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
function setStatus(m) { connErr = m || ""; renderConn(); }
function renderConn() {
  let html, warn = false;
  const online = conn.online && navigator.onLine !== false;
  if (connErr) { html = esc(connErr); warn = true; }
  else if (!conn.syncedAt) {
    warn = conn.startedAt && Date.now() - conn.startedAt > 10000;
    html = warn ? `<span class="dot"></span>資料暫時連不上，請確認網路` : `<span class="dot"></span>連線中…`;
  } else if (online) html = `<span class="dot"></span>即時連線中・資料最後更新 ${hms(conn.updatedAt || conn.syncedAt)}`;
  else { warn = true; html = `<span class="dot"></span>連線中斷${conn.offlineSince ? `（${fmt(conn.offlineSince)} 起）` : ""}・畫面停在 ${hms(conn.syncedAt)} 的狀態，可能不是最新`; }
  ["#st1", "#st2", "#st3", "#st4"].forEach(s => { const el = $(s); el.innerHTML = html; el.classList.toggle("warn", !!warn); el.classList.toggle("ok", !warn && !!conn.syncedAt); });
}
window.addEventListener("offline", () => { if (conn.online) { conn.online = false; conn.offlineSince = Date.now(); } render(); });
window.addEventListener("online", () => render());
// 有通報還沒送到伺服器時，離開或重新整理頁面會遺失，先提醒
window.addEventListener("beforeunload", e => { if (guests.some(g => g._pending)) { e.preventDefault(); e.returnValue = ""; } });
// 每 3 秒檢查：讓「傳送中」超過時間後變成「尚未送達」、連線時間持續更新
setInterval(() => { if (pendSince.size) render(); else renderConn(); }, 3000);

const delivState = g => !g._pending ? "ok" : (!conn.online || navigator.onLine === false || Date.now() - (pendSince.get(g.id) || Date.now()) > SLOW_MS) ? "slow" : "sending";
const delivTag = g => { const s = delivState(g); return s === "sending" ? `<span class="dv sending">傳送中…</span>` : s === "slow" ? `<span class="dv slow">⚠ 尚未送達</span>` : g.status === "arrived" ? `<span class="dv ok">✓ 已送達介紹台</span>` : ""; };

// ---------- QR ----------
let qrKey = "";
function drawQRs() {
  const base = siteBase();
  qrCanvas($("#selfQR2"), base + "checkin.html", 160);
  qrCanvas($("#recQR"), base + "#reception", 160);
  if ($("#v-guests").hidden) return;
  const list = [...guests].filter(g => g.source !== "self").sort((a, b) => catRank(a.cat) - catRank(b.cat) || (a.createdAt || 0) - (b.createdAt || 0));
  const key = list.map(g => g.id + g.status + g.title + g.name).join("|");
  if (key === qrKey) return; qrKey = key;
  const grid = $("#qrGrid");
  if (!list.length) { grid.innerHTML = `<p class="empty">先匯入或貼上預約名單，QR Code 會自動出現在這裡。</p>`; return; }
  grid.innerHTML = list.map(g => `<div class="qrc"><canvas data-qr="${g.id}"></canvas><div class="tt">${esc(g.title)}</div><div class="nm">${esc(g.name)}</div>${g.status !== "expected" ? `<div class="st">已報到 ${fmt(g.arrivedAt)}</div>` : ""}</div>`).join("");
  grid.querySelectorAll("canvas[data-qr]").forEach(cv => qrCanvas(cv, base + "#g-" + cv.dataset.qr, 150));
}
function drawLanding() {
  const url = siteBase() + "checkin.html";
  qrCanvas($("#selfQR"), url, 240);
  $("#selfUrl").textContent = url;
}

// ---------- 畫面 ----------
function render() {
  const ev = cfg.event || SCHOOL.defaultEvent;
  $("#eventSub").textContent = ev + "・來賓通報";
  $("#heroEvent").textContent = `歡迎蒞臨 ${ev}`;
  document.title = `${ev}｜${SCHOOL.name}來賓通報`;
  if (!isStaff) return;
  renderConn();
  const n = $("#notice"); n.hidden = !cfg.notice; n.querySelector("span").textContent = cfg.notice || "";
  const ro = !isStaff;

  const pendingAll = orderPending(guests.filter(g => g.status === "arrived"));
  const done = guests.filter(g => g.status === "introduced").sort((a, b) => (b.introducedAt || 0) - (a.introducedAt || 0));
  const b = $("#pendBadge"); b.hidden = !pendingAll.length; b.textContent = pendingAll.length;
  renderReview();

  // 掃描卡
  const sc = $("#scanCard");
  if (scanId) {
    sc.hidden = false;
    const g = guests.find(x => x.id === scanId);
    if (!loaded) { sc.className = "scan"; sc.innerHTML = `<div class="ttl">讀取來賓資料中…</div>`; }
    else if (!g) { sc.className = "scan"; sc.innerHTML = `<div class="who">找不到這張 QR Code</div><div class="ttl">可能已從名單刪除。請改用下方「臨時來賓」通報。</div><div><button class="btn ghost" data-act="closescan">關閉</button></div>`; }
    else if (g.status === "expected") { sc.className = "scan"; sc.innerHTML = `<div class="ttl">${esc(g.title)}</div><div class="who">${esc(g.name)}</div><div>${catPill(g.cat)}</div><div class="btnrow fill"><button class="btn big" data-act="arrive" data-id="${g.id}" data-first="0">報到（一般）</button><button class="btn big koi" data-act="arrive" data-id="${g.id}" data-first="1">報到・第一優先</button></div><div><button class="btn ghost sm" data-act="closescan">取消</button></div>`; }
    else { sc.className = "scan okay"; sc.innerHTML = `${typeof g.no === "number" ? `<div class="bigno"><small>報到序號</small>${noTxt(g.no)}</div>` : numBlocked ? "" : `<div class="bigno wait"><small>報到序號</small>取號中…</div>`}<div class="ttl">${esc(g.title)}</div><div class="who">${esc(g.name)}</div><div class="state">${g.status === "introduced" ? "已報到，也已介紹過" : "已報到"}（${fmt(g.arrivedAt)}）${g.first ? "・第一優先" : ""}</div><div class="btnrow" style="justify-content:center">${g.status === "arrived" && !g.first ? `<button class="btn koi sm" data-act="setfirst" data-id="${g.id}">改為第一優先</button>` : ""}<button class="btn ghost sm" data-act="closescan">完成</button></div>`; }
  } else sc.hidden = true;

  // 送達狀態橫幅
  renderDeliv();

  // 搜尋：跨所有分類，顯示未報到／已報到；沒有搜尋時才用四頁簽
  const qRaw = $("#q").value.trim(), q = nameKey(qRaw);
  $("#subtabs").hidden = !!q;
  $("#expTitle").innerHTML = q ? `搜尋結果 <span class="hint">「${esc(qRaw)}」・包含已報到的來賓</span>` : `預約來賓 <span class="hint">掃來賓的 QR Code，或在上方搜尋後點「報到」</span>`;
  if (q) { renderSearch(q, qRaw); }
  else {
  let expAll = guests.filter(g => g.status === "expected");
  const ecnt = {}; CATS.forEach(c => ecnt[c] = 0); expAll.forEach(g => ecnt[grpOf(g)]++);
  document.querySelectorAll(".stab.exp").forEach(t => { const on = t.dataset.grp === expTab; t.setAttribute("aria-selected", on); t.classList.toggle("on", on); t.querySelector(".cnt").textContent = ecnt[t.dataset.grp]; });
  const exp = expAll.filter(g => grpOf(g) === expTab).sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh-Hant"));
  const others = CATS.filter(c => c !== expTab && ecnt[c]).map(c => `${c} ${ecnt[c]} 位`);
  $("#expList").innerHTML = exp.length
    ? exp.slice(0, 40).map(g => `<li class="g"><div class="info">${catPill(g.cat)} <span class="nm">${esc(g.name)}</span><div class="tt">${esc(g.title)}</div></div><div class="btnrow"><button class="btn sm" data-act="arrive" data-id="${g.id}" data-first="0">報到</button><button class="btn sm koi" data-act="arrive" data-id="${g.id}" data-first="1">第一優先</button></div></li>`).join("") + (exp.length > 40 ? `<li class="empty">還有 ${exp.length - 40} 位，請輸入關鍵字縮小範圍</li>` : "")
    : `<li class="empty">${!loaded ? "讀取中…" : others.length ? `這個頁簽沒有待報到的來賓；其他頁簽：${others.join("、")}。` : guests.length ? "預約來賓都已報到。" : "還沒有預約名單。到「名單與 QR」匯入，或直接用臨時來賓通報。"}</li>`;
  }

  // 剛剛通報（這台裝置還沒送達的排最前面）
  const recent = guests.filter(g => g.status === "arrived" || g.status === "introduced").sort((a, b) => (b._pending ? 1 : 0) - (a._pending ? 1 : 0) || (b.arrivedAt || 0) - (a.arrivedAt || 0)).slice(0, 8);
  $("#recentList").innerHTML = recent.length ? recent.map(g => `<li class="g${g._pending ? " pend" : ""}"><div class="info">${g.first ? `<span class="first">第一優先</span> ` : ""}${g.selfReported || g.source === "self" ? `<span class="self">自助</span> ` : ""}${noPill(g)} <span class="nm">${esc(who(g))}</span> ${delivTag(g)}<div class="tt">${fmt(g.arrivedAt)} 報到${g.status === "introduced" ? "・已介紹" : ""}${g.reporterName ? "・" + esc(g.reporterName) : ""}</div></div>${g.status === "introduced" ? "" : `<div class="btnrow">${g.first ? `<button class="btn sm ghost" data-act="unfirst" data-id="${g.id}">取消優先</button>` : `<button class="btn sm ghost" data-act="setfirst" data-id="${g.id}">設第一優先</button>`}<button class="btn sm danger" data-act="undo" data-id="${g.id}">撤回</button></div>`}</li>`).join("") : `<li class="empty">還沒有人報到。</li>`;

  // 介紹台：下一位
  curPending = pendingAll.map(g => g.id);
  const nx = pickNext(pendingAll);
  renderNext(nx, pendingAll);
  const scnt = {}, sfirst = {}, sfresh = {};
  CATS.forEach(c => { scnt[c] = 0; sfirst[c] = false; sfresh[c] = false; });
  pendingAll.forEach(g => { const c = grpOf(g); scnt[c]++; if (g.first) sfirst[c] = true; if (fresh.has(g.id)) sfresh[c] = true; });
  document.querySelectorAll(".stab.stg").forEach(t => {
    const c = t.dataset.grp, on = c === stageTab;
    t.setAttribute("aria-selected", on); t.classList.toggle("on", on);
    t.classList.toggle("hasfirst", sfirst[c]); t.classList.toggle("ping", sfresh[c] && !on);
    t.querySelector(".cnt").textContent = scnt[c];
  });
  const tabItems = pendingAll.filter(g => grpOf(g) === stageTab);
  curTabIds = tabItems.map(g => g.id);
  const pPages = Math.max(1, Math.ceil(tabItems.length / P_SIZE)); pPage = Math.min(pPage, pPages - 1); const pStart = pPage * P_SIZE;
  const dPages = Math.max(1, Math.ceil(done.length / D_SIZE)); dPage = Math.min(dPage, dPages - 1); const dStart = dPage * D_SIZE;
  $("#n-pend").textContent = pendingAll.length; $("#n-done").textContent = done.length;
  const otherPend = CATS.filter(c => c !== stageTab && scnt[c]).map(c => `${c} ${scnt[c]} 位`);
  if (!drag) {
    $("#pendList").innerHTML = tabItems.length
      ? tabItems.slice(pStart, pStart + P_SIZE).map((g, i) => `<li class="prow" data-id="${g.id}"><button class="handle" data-handle data-id="${g.id}" aria-label="拖曳或用上下鍵調整 ${esc(g.name || g.title)} 的順序">⋮⋮</button><button class="card${g.first ? " isfirst" : ""}${fresh.has(g.id) ? " fresh" : ""}${nx && nx.id === g.id ? " isnext" : ""}" data-act="intro" data-id="${g.id}"><span class="ord">${pStart + i + 1}</span><span class="line"><small>${esc(g.title)}</small>${esc(g.name)}</span><span class="meta">${noPill(g)}${nx && nx.id === g.id ? `<span class="nexttag">下一位</span>` : ""}${g.first ? `<span class="first">第一優先</span>` : ""}${g.selfReported || g.source === "self" ? `<span class="self">自助</span>` : ""}${catPill(g.cat)}${fmt(g.arrivedAt)} 到場</span></button></li>`).join("")
      : `<li class="empty">${!loaded ? "讀取中…" : otherPend.length ? `「${esc(stageTab)}」目前沒有待介紹；其他頁簽：${otherPend.join("、")}。` : "目前沒有待介紹的來賓。接待老師報到後會即時出現在這裡。"}</li>`;
    $("#pendPager").innerHTML = pager("p", pPage, pPages, tabItems.length, tabItems.slice(0, pStart).some(g => g.first));
  }
  $("#donePager").innerHTML = pager("d", dPage, dPages, done.length, false);
  $("#doneList").innerHTML = done.length ? done.slice(dStart, dStart + D_SIZE).map(g => `<li class="dcard"><span class="ord">✓</span><span class="dinfo"><span class="line">${typeof g.no === "number" ? `<span class="regno sm">${noTxt(g.no)}</span> ` : ""}${esc(who(g))}</span><span class="meta">${fmt(g.introducedAt)} 介紹</span></span><button class="btn sm ghost" data-act="back" data-id="${g.id}">↩ 送回待介紹</button></li>`).join("") : `<li class="empty">尚無</li>`;

  // 名單與 QR
  $("#cfgPanel").hidden = !isAdmin; $("#staffPanel").hidden = !isAdmin || isOwner;
  $("#sysTab").hidden = !isOwner;
  renderSystem();
  document.querySelectorAll(".admin-only").forEach(el => el.hidden = !isAdmin);
  document.querySelector(".admin-note").hidden = isAdmin;
  const total = guests.length, arr = guests.filter(g => g.status === "arrived" || g.status === "introduced").length;
  $("#countLine").textContent = total ? `共 ${total} 位・已報到 ${arr} 位` : "";
  const all = [...guests].sort((a, b) => catRank(a.cat) - catRank(b.cat) || (a.createdAt || 0) - (b.createdAt || 0));
  $("#allList").innerHTML = all.length ? all.map(g => `<li><span>${catPill(g.cat)} ${typeof g.no === "number" ? `<span class="regno sm">${noTxt(g.no)}</span> ` : ""}${esc(who(g))}${g.status === "review" ? ` <span class="self">待確認</span>` : g.status !== "expected" ? ` <span class="hint">已報到</span>` : ""}</span>${isAdmin ? `<span data-delbox="${g.id}"><button class="btn sm danger" data-act="askdel" data-id="${g.id}">刪除</button></span>` : ""}</li>`).join("") : `<li class="empty" style="background:none">名單是空的</li>`;
  // 清空只在還沒有人報到時開放（例如匯入錯檔）；活動結束請用「結案封存」
  const canClear = isAdmin && total && !guests.some(g => g.status === "arrived" || g.status === "introduced");
  if (!$("#clearBox").dataset.asking) $("#clearBox").innerHTML = canClear ? `<button class="btn sm danger" data-act="askclear">清空名單（還沒有人報到時才能用）</button>` : isAdmin && total ? `<span class="hint">已有來賓報到；活動結束請用上方「結案封存」，紀錄會保留下來。</span>` : "";
  renderStaff();
  renderArchives();
  drawQRs();
}

// ---------- 接待：搜尋結果 ----------
function renderSearch(q, qRaw) {
  const hit = g => nameKey(g.name).includes(q) || nameKey(g.title).includes(q) || nameKey((g.title || "") + (g.name || "")).includes(q);
  const ST_RANK = { expected: 0, arrived: 1, introduced: 2 };
  const list = guests.filter(g => g.status !== "review" && hit(g))
    .sort((a, b) => (ST_RANK[a.status] ?? 3) - (ST_RANK[b.status] ?? 3) || catRank(a.cat) - catRank(b.cat) || (a.title || "").localeCompare(b.title || "", "zh-Hant"));
  const nameCnt = {}; list.forEach(g => { const k = nameKey(g.name); if (k) nameCnt[k] = (nameCnt[k] || 0) + 1; });
  const stTag = g => g.status === "expected" ? `<span class="stt no">未報到</span>` : g.status === "arrived" ? `<span class="stt yes">已報到 ${fmt(g.arrivedAt)}</span> ${noPill(g)}` : `<span class="stt yes">已報到・已介紹</span> ${noPill(g)}`;
  const row = g => {
    const same = nameCnt[nameKey(g.name)] > 1;
    const btns = g.status === "expected" ? `<div class="btnrow"><button class="btn sm" data-act="arrive" data-id="${g.id}" data-first="0">報到</button><button class="btn sm koi" data-act="arrive" data-id="${g.id}" data-first="1">第一優先</button></div>`
      : g.status === "arrived" && !g.first ? `<div class="btnrow"><button class="btn sm ghost" data-act="setfirst" data-id="${g.id}">改為第一優先</button></div>` : "";
    return `<li class="g${g.status === "expected" ? "" : " isdone"}${same ? " same" : ""}"><div class="info">${stTag(g)} ${catPill(g.cat)} <span class="nm">${esc(g.name)}</span>${same ? ` <span class="samenm">同名，請核對頭銜</span>` : ""}<div class="tt">${esc(g.title) || "（未填頭銜）"}</div></div>${btns}</li>`;
  };
  $("#expList").innerHTML = list.length
    ? list.slice(0, 40).map(row).join("") + (list.length > 40 ? `<li class="empty">還有 ${list.length - 40} 位，請多打幾個字縮小範圍</li>` : "")
    : `<li class="empty">${!loaded ? "讀取中…" : `找不到「${esc(qRaw)}」。<button class="linkbtn" type="button" data-act="walkfill">用臨時來賓通報「${esc(qRaw)}」</button>`}</li>`;
}

// ---------- 接待：尚未送達橫幅 ----------
function renderDeliv() {
  const slow = guests.filter(g => g._pending && delivState(g) === "slow");
  const bar = $("#delivBar"); bar.hidden = !slow.length;
  if (slow.length) bar.innerHTML = `<b>⚠ 有 ${slow.length} 筆通報尚未送達介紹台</b><span>${slow.slice(0, 4).map(g => esc(who(g))).join("、")}${slow.length > 4 ? " 等" : ""}</span><span class="hint">資料已存在這台手機，網路恢復後會自動補送。請不要關閉或重新整理這個頁面，也不必重複報到；急的話請口頭通知司儀。</span>`;
}

// ---------- 介紹台：下一位 ----------
// 規則：跟著佇列第一位走；只有「新到的第一優先」不會直接把正在念的人換掉，而是跳出提示讓司儀決定
function pickNext(list) {
  const lock = (g, pin) => { nextId = g.id; pinned = !!pin; knownFirst = new Set(list.filter(x => x.first).map(x => x.id)); firstAlertId = null; return g; };
  // 撤銷或按「改為下一位」指定的人：固定在下一位，直到他被介紹
  if (forceNext) { const f = list.find(g => g.id === forceNext); if (f) { forceNext = null; return lock(f, true); } }
  const desired = list[0] || null;
  if (!desired) { nextId = null; pinned = false; firstAlertId = null; return null; }
  const cur = nextId ? list.find(g => g.id === nextId) : null;
  if (!cur) return lock(desired);
  if (pinned) { firstAlertId = desired.id !== cur.id && desired.first && !knownFirst.has(desired.id) && !dismissed.has(desired.id) ? desired.id : null; return cur; }
  if (desired.id === cur.id) { firstAlertId = null; return cur; }
  if (desired.first && !knownFirst.has(desired.id)) { firstAlertId = dismissed.has(desired.id) ? null : desired.id; return cur; }
  return lock(desired);
}
function renderNext(nx, list) {
  const box = $("#nextBox");
  if (!nx) box.innerHTML = `<div class="nb-lbl">下一位</div><div class="nb-empty">${loaded ? "目前沒有待介紹的來賓" : "讀取中…"}</div>`;
  else {
    const after = list.filter(g => g.id !== nx.id).slice(0, 2);
    box.innerHTML = `<div class="nb-lbl">下一位 ${noPill(nx)}${nx.first ? `<span class="first">第一優先</span>` : ""}${catPill(nx.cat)}<span class="hint">${fmt(nx.arrivedAt)} 到場</span></div>
      <div class="nb-title">${esc(nx.title) || "&nbsp;"}</div>
      <div class="nb-name">${esc(nx.name)}</div>
      <div class="nb-foot"><button class="btn big ok" type="button" data-act="intro" data-id="${nx.id}">✓ 介紹完畢</button>${after.length ? `<span class="nb-after">接著：${after.map(g => esc(who(g))).join("、")}</span>` : ""}</div>`;
  }
  const al = $("#firstAlert"), fg = firstAlertId && list.find(g => g.id === firstAlertId);
  al.hidden = !fg;
  if (fg) al.innerHTML = `<div><b>第一優先來賓到場：</b><span class="fa-who">${esc(who(fg))}</span><div class="hint">已排在佇列最前面；念完目前這位就會輪到，或現在切換。</div></div><div class="btnrow"><button class="btn koi" type="button" data-act="takefirst" data-id="${fg.id}">改為下一位</button><button class="btn ghost" type="button" data-act="laterfirst" data-id="${fg.id}">念完這位再說</button></div>`;
  const ub = $("#undoBar"), live = undoInfo && Date.now() < undoInfo.until;
  ub.hidden = !live;
  if (live) ub.innerHTML = `<span>已介紹：<b>${esc(undoInfo.label)}</b></span><button class="btn sm" type="button" data-act="undointro" data-id="${undoInfo.id}">↩ 撤銷</button>`;
}

// ---------- 活動紀錄 ----------
function renderArchives() {
  $("#askClose").hidden = !isAdmin;
  const box = $("#archList");
  if (archErr) { box.innerHTML = `<li class="empty">${esc(archErr)}</li>`; return; }
  box.innerHTML = archives.length ? archives.map(a => {
    const ask = archAsk && archAsk.id === a.id ? archAsk.act : "";
    const btns = ask === "restore" ? `<span class="confirm">切換回這場？${a.count} 位來賓會放回目前名單，活動名稱改為「${esc(a.event)}」。<button class="btn sm koi" data-act="archrestore" data-id="${a.id}">確定切換</button><button class="btn sm ghost" data-act="archno">取消</button></span>`
      : ask === "del" ? `<span class="confirm">永久刪除這份紀錄？無法復原。<button class="btn sm danger" data-act="archdel" data-id="${a.id}">刪除</button><button class="btn sm ghost" data-act="archno">取消</button></span>`
      : `<button class="btn sm ghost" data-act="archcsv" data-id="${a.id}">匯出 CSV</button>${isAdmin ? `<button class="btn sm ghost" data-act="archaskrestore" data-id="${a.id}">切換回這場</button>` : ""}${isOwner ? `<button class="btn sm danger" data-act="archaskdel" data-id="${a.id}">刪除</button>` : ""}`;
    return `<li class="g"><div class="info"><span class="nm">${esc(a.event)}</span><div class="tt">${fullTime(a.closedAt)} 結案・共 ${a.count} 位・已報到 ${a.arrived}・已介紹 ${a.introduced}${a.closedBy ? "・" + esc(a.closedBy) : ""}</div></div><div class="btnrow">${btns}</div></li>`;
  }).join("") : `<li class="empty">還沒有結案的活動。</li>`;
}

function pager(k, pg, pages, total, firstBefore) {
  if (pages <= 1) return "";
  return `<button class="btn sm ghost" data-act="pg" data-k="${k}" data-to="${pg - 1}" ${pg <= 0 ? "disabled" : ""}>‹ 上一頁</button><span class="pinfo">第 ${pg + 1} / ${pages} 頁・共 ${total} 位${firstBefore ? `<span class="first">前頁有第一優先</span>` : ""}</span><button class="btn sm ghost" data-act="pg" data-k="${k}" data-to="${pg + 1}" ${pg >= pages - 1 ? "disabled" : ""}>下一頁 ›</button>`;
}

function renderStaff() {
  if (!isAdmin) return;
  const chip = (e, role, removable) => `<li>${esc(e)}${e === me.email ? " <b>（你）</b>" : ""}${removable ? `<button type="button" data-act="rmstaff" data-role="${role}" data-email="${esc(e)}" aria-label="移除 ${esc(e)}">✕</button>` : ""}</li>`;
  $("#ownerList").innerHTML = staffDoc.owner ? chip(staffDoc.owner, "owner", false) : `<li>尚未設定</li>`;
  $("#adminList").innerHTML = (staffDoc.admins || []).map(e => chip(e, "admins", isOwner)).join("") || `<li class="hint" style="background:none">還沒有加入管理者</li>`;
  $("#staffList").innerHTML = (staffDoc.emails || []).map(e => chip(e, "emails", true)).join("") || `<li class="hint" style="background:none">還沒有加入工作人員</li>`;
  $("#addAdmin").hidden = !isOwner;
}

// ---------- 資料寫入 ----------
const gref = id => doc(db, "guests", id);
// 寫入先套用到畫面，不等伺服器（離線時 Promise 會一直等）；送達與否由 hasPendingWrites 顯示
function setGuest(id, patch, msg) {
  const p = updateDoc(gref(id), patch);
  if (msg) toast(msg);
  return p.catch(e => { ackWatch.delete(id); toast(e && e.code === "permission-denied" ? "沒有權限，請請管理者把你加入工作人員" : "更新失敗，請再試一次"); });
}
// 報到類的寫入：等伺服器確認後跳出「已送達介紹台」
function watchAck(id, label) { ackWatch.set(id, label); }
async function batchWrite(ops) { // ops: [{type:"set"|"update"|"delete", id, data}]
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(o => o.type === "delete" ? b.delete(gref(o.id)) : o.type === "update" ? b.update(gref(o.id), o.data) : b.set(gref(o.id), o.data));
    await b.commit();
  }
}

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || !isStaff) return;
  const id = b.dataset.id, act = b.dataset.act, g = guests.find(x => x.id === id);
  if (act === "closescan") { scanId = null; history.replaceState(null, "", "#reception"); render(); return; }
  if (act === "pg") { const to = +b.dataset.to; if (b.dataset.k === "p") pPage = to; else dPage = to; render(); b.closest(".zone").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  if (act === "arrive" && g) { b.disabled = true; const f = b.dataset.first === "1"; watchAck(id, who(g)); setGuest(id, { status: "arrived", rank: null, first: f, arrivedAt: Date.now(), reporterName: me.displayName || me.email }, `${g.name || g.title} 報到傳送中…`); return; }
  if (act === "setfirst") { setGuest(id, { first: true, rank: null }, "已設為第一優先"); return; }
  if (act === "unfirst") { setGuest(id, { first: false, rank: null }, "已取消優先"); return; }
  if (act === "intro" && g) {
    b.disabled = true;
    undoInfo = { id, label: who(g), until: Date.now() + 10000 };
    setTimeout(() => { if (undoInfo && undoInfo.id === id && Date.now() >= undoInfo.until) { undoInfo = null; render(); } }, 10100);
    setGuest(id, { status: "introduced", introducedAt: Date.now() }); return;
  }
  if (act === "undointro") { undoInfo = null; forceNext = id; setGuest(id, { status: "arrived", introducedAt: null }, `${g ? who(g) : ""} 已回到下一位`); render(); return; }
  if (act === "takefirst") { forceNext = id; firstAlertId = null; render(); return; }
  if (act === "laterfirst") { dismissed.add(id); firstAlertId = null; render(); return; }
  if (act === "walkfill") { $("#w-name").value = $("#q").value.trim(); $("#q").value = ""; render(); $("#walkForm").scrollIntoView({ block: "start", behavior: "smooth" }); $("#w-title").focus({ preventScroll: true }); return; }
  if (act === "back") { b.disabled = true; setGuest(id, { status: "arrived", rank: null, introducedAt: null }, `${g ? g.name || g.title : ""} 已送回待介紹`); return; }
  if (act === "undo" && g) {
    if (g.source === "walkin" || g.source === "self") { try { await deleteDoc(gref(id)); toast("已撤回"); } catch (err) { toast("撤回失敗"); } }
    else setGuest(id, { status: "expected", first: false, rank: null, arrivedAt: null, reporterName: null, selfReported: false, no: null }, "已撤回，回到預約名單");
    ackWatch.delete(id);
    return;
  }
  if (act === "archcsv") { exportArchive(id, b); return; }
  if (act === "archaskrestore" || act === "archaskdel") {
    if (act === "archaskrestore" && guests.length) { toast("目前名單還有資料：請先「結案封存」目前這場，才能切換到另一場"); return; }
    archAsk = { id, act: act === "archaskrestore" ? "restore" : "del" }; renderArchives(); return;
  }
  if (act === "archno") { archAsk = null; renderArchives(); return; }
  if (act === "archrestore") { b.disabled = true; await restoreArchive(id); archAsk = null; renderArchives(); return; }
  if (act === "archdel") { b.disabled = true; await deleteArchive(id); archAsk = null; renderArchives(); return; }
  if (act === "askdel") { document.querySelector(`[data-delbox="${id}"]`).innerHTML = `<span class="confirm">確定？<button class="btn sm danger" data-act="del" data-id="${id}">刪除</button><button class="btn sm ghost" data-act="nodel">取消</button></span>`; return; }
  if (act === "nodel") { render(); return; }
  if (act === "del") { try { await deleteDoc(gref(id)); toast("已刪除"); } catch (err) { toast("刪除失敗"); } return; }
  if (act === "askclear") { const box = $("#clearBox"); box.dataset.asking = "1"; box.innerHTML = `確定清空全部 ${guests.length} 位來賓？無法復原。<button class="btn sm danger" data-act="doclear">清空</button><button class="btn sm ghost" data-act="noclear">取消</button>`; return; }
  if (act === "noclear") { delete $("#clearBox").dataset.asking; render(); return; }
  if (act === "doclear") { b.disabled = true; try { await batchWrite(allIds.map(x => ({ type: "delete", id: x }))); toast("已清空名單"); } catch (err) { toast("清空失敗，需要管理者權限"); } delete $("#clearBox").dataset.asking; render(); return; }
  if (act === "rvok") { b.disabled = true; await confirmSelf(id, b.dataset.first === "1"); return; }
  if (act === "rvask") { document.querySelector(`[data-rvdel="${id}"]`).innerHTML = `<span class="confirm">確定刪除？<button class="btn sm danger" data-act="rvdel" data-id="${id}">刪除</button><button class="btn sm ghost" data-act="rvno">取消</button></span>`; return; }
  if (act === "rvno") { reviewKey = ""; render(); return; }
  if (act === "rvdel") { try { await deleteDoc(gref(id)); reviewKey = ""; toast("已刪除"); } catch (err) { toast("刪除失敗"); } return; }
  if (act === "rmstaff") { await saveStaff(b.dataset.role, (staffDoc[b.dataset.role] || []).filter(x => x !== b.dataset.email)); return; }
});

document.querySelectorAll(".stab.exp").forEach(t => t.addEventListener("click", () => { expTab = t.dataset.grp; try { localStorage.setItem("liyu-exp-tab", expTab); } catch (e) {} render(); }));
document.querySelectorAll(".stab.stg").forEach(t => t.addEventListener("click", () => { stageTab = t.dataset.grp; pPage = 0; try { localStorage.setItem("liyu-stage-tab", stageTab); } catch (e) {} render(); }));
$("#q").addEventListener("input", render);

// ---------- 拖曳排序（只在目前頁簽、目前頁內） ----------
const PL = $("#pendList");
const pageIds = () => [...PL.querySelectorAll("li.prow")].map(li => li.dataset.id);
function fullOrder(ids) {
  const tab = curTabIds.slice(); tab.splice(pPage * P_SIZE, ids.length, ...ids);
  const inTab = new Set(curTabIds); let k = 0;
  return curPending.map(id => inTab.has(id) ? tab[k++] : id);
}
async function saveOrder(order) {
  const ranks = new Map(order.map((id, i) => [id, (i + 1) * 1000]));
  const changed = guests.filter(g => ranks.has(g.id) && g.rank !== ranks.get(g.id));
  if (!changed.length) return;
  guests = guests.map(g => ranks.has(g.id) ? { ...g, rank: ranks.get(g.id) } : g); render();
  try { await batchWrite(changed.map(g => ({ type: "update", id: g.id, data: { rank: ranks.get(g.id) } }))); toast("順序已更新"); }
  catch (e) { toast("順序沒有存到，請再拖一次"); }
}
function stepMove(li, y) {
  const prev = li.previousElementSibling, next = li.nextElementSibling;
  if (prev && prev.dataset.id) { const r = prev.getBoundingClientRect(); if (y < r.top + r.height / 2) { PL.insertBefore(li, prev); return; } }
  if (next && next.dataset.id) { const r = next.getBoundingClientRect(); if (y > r.top + r.height / 2) PL.insertBefore(next, li); }
}
PL.addEventListener("pointerdown", e => {
  const h = e.target.closest("[data-handle]"); if (!h) return; e.preventDefault();
  const li = h.closest("li"); drag = { li, start: pageIds().join(",") }; li.classList.add("dragging");
  try { h.setPointerCapture(e.pointerId); } catch (err) {}
});
PL.addEventListener("pointermove", e => {
  if (!drag) return; stepMove(drag.li, e.clientY);
  if (e.clientY < 70) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
});
function endDrag() { if (!drag) return; const d = drag; drag = null; d.li.classList.remove("dragging"); const now = pageIds(); if (now.join(",") !== d.start) saveOrder(fullOrder(now)); else render(); }
PL.addEventListener("pointerup", endDrag); PL.addEventListener("pointercancel", endDrag);
PL.addEventListener("keydown", e => {
  const h = e.target.closest("[data-handle]"); if (!h || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return; e.preventDefault();
  const li = h.closest("li"), id = h.dataset.id;
  if (e.key === "ArrowUp" && li.previousElementSibling) PL.insertBefore(li, li.previousElementSibling);
  else if (e.key === "ArrowDown" && li.nextElementSibling) PL.insertBefore(li.nextElementSibling, li);
  else return;
  saveOrder(fullOrder(pageIds())).then(() => { const nh = PL.querySelector(`[data-handle][data-id="${id}"]`); if (nh) nh.focus(); });
});

// ---------- 臨時來賓 ----------
let walkFirst = "0";
$("#walkForm").addEventListener("click", e => { const s = e.target.closest("button[type=submit]"); if (s) walkFirst = s.dataset.first; });
$("#walkForm").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("#walkErr"); err.hidden = true;
  const title = $("#w-title").value.trim(), name = $("#w-name").value.trim();
  if (!name && !title) { err.textContent = "請至少填姓名或頭銜。"; err.hidden = false; $("#w-name").focus(); return; }
  const cat = (document.querySelector("input[name=wcat]:checked") || {}).value || CATS[1], now = Date.now(), id = newId(), first = walkFirst === "1";
  // 先存到這台裝置並顯示在「剛剛通報」（傳送中），不等伺服器；失敗時把資料填回表單
  watchAck(id, `${title ? title + " " : ""}${name}`.trim());
  setDoc(gref(id), { title, name, cat, first, status: "arrived", arrivedAt: now, createdAt: now, source: "walkin", reporterName: me.displayName || me.email })
    .catch(ex => {
      ackWatch.delete(id);
      if (!$("#w-title").value && !$("#w-name").value) { $("#w-title").value = title; $("#w-name").value = name; }
      err.textContent = `「${name || title}」沒有送出：` + (ex && ex.code === "permission-denied" ? "沒有權限，請請管理者把你加入工作人員。" : "請再按一次報到。");
      err.hidden = false;
    });
  toast(`${name || title} 報到傳送中…${first ? "（第一優先）" : ""}`);
  $("#w-title").value = ""; $("#w-name").value = ""; $("#w-title").focus();
});
$("#goWalk").addEventListener("click", () => { $("#walkForm").scrollIntoView({ block: "start", behavior: "smooth" }); $("#w-title").focus({ preventScroll: true }); });
$("#goReview").addEventListener("click", () => $("#reviewPanel").scrollIntoView({ block: "start", behavior: "smooth" }));

// ---------- 手動貼上 ----------
function parseLine(l) {
  const p = l.split(/[,，\t、]/).map(s => s.trim());
  if (p.length === 1) return { title: "", name: p[0], cat: CATS[1] };
  return { title: p[0] || "", name: p[1] || "", cat: CATS.includes(p[2]) ? p[2] : CATS[1] };
}
$("#bulkBtn").addEventListener("click", async () => {
  const err = $("#bulkErr"); err.hidden = true;
  const lines = $("#bulk").value.split(/\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { err.textContent = "請先輸入名單，一行一位。"; err.hidden = false; return; }
  const btn = $("#bulkBtn"); btn.disabled = true; const now = Date.now();
  try {
    await batchWrite(lines.map((l, i) => ({ type: "set", id: newId(), data: { ...parseLine(l), first: false, status: "expected", createdAt: now + i, source: "preload" } })));
    toast(`已加入 ${lines.length} 位`); $("#bulk").value = "";
  } catch (ex) { err.textContent = "加入失敗：" + (ex.code === "permission-denied" ? "沒有權限" : "請再試一次"); err.hidden = false; }
  btn.disabled = false;
});

// ---------- 匯入 Excel／CSV ----------
let impRows = [], impHead = [];
const NONE = "__none";
function loadXLSX() { return window.XLSX ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"; s.onload = ok; s.onerror = () => no(new Error("load")); document.head.appendChild(s); }); }
function guessCol(re) { const i = impHead.findIndex(h => re.test(h)); return i < 0 ? NONE : String(i); }
function normCat(v) {
  v = String(v || "").trim(); if (CATS.includes(v)) return v;
  if (/家長/.test(v)) return "家長"; if (/長官|民意|議員|縣長|鎮長|鄉長|立委/.test(v)) return "長官"; if (/其他/.test(v)) return "其他";
  return CATS.includes("貴賓") ? "貴賓" : CATS[1];
}
function mapped() {
  const g = k => $("#m-" + k).value, cell = (r, k) => g(k) === NONE ? "" : String(r[+g(k)] ?? "").trim();
  const have = new Set(guests.map(x => (x.title || "") + "|" + (x.name || ""))); const seen = new Set();
  return impRows.map(r => {
    const title = [cell(r, "org"), cell(r, "job")].filter(Boolean).join(" "), name = cell(r, "name"), cat = normCat(cell(r, "cat"));
    const key = title + "|" + name; const dup = have.has(key) || seen.has(key); seen.add(key);
    return { title, name, cat, dup, empty: !title && !name };
  }).filter(x => !x.empty);
}
function drawPreview() {
  const m = mapped(), add = m.filter(x => !x.dup);
  $("#impPrev").innerHTML = `<thead><tr><th>#</th><th>頭銜</th><th>姓名</th><th>身分</th></tr></thead><tbody>` + m.slice(0, 200).map((x, i) => `<tr class="${x.dup ? "dup" : ""}"><td>${i + 1}</td><td>${esc(x.title)}</td><td>${esc(x.name)}</td><td>${esc(x.cat)}${x.dup ? "（重複，略過）" : ""}</td></tr>`).join("") + (m.length > 200 ? `<tr><td colspan="4">…還有 ${m.length - 200} 筆</td></tr>` : "") + `</tbody>`;
  $("#impInfo").textContent = `將匯入 ${add.length} 位${m.length - add.length ? `，略過重複 ${m.length - add.length} 位` : ""}`;
  $("#impGo").disabled = !add.length;
}
$("#impPick").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#impFile").click(); } });
$("#impFile").addEventListener("change", async e => {
  const f = e.target.files[0], err = $("#impErr"); err.hidden = true; if (!f) return;
  $("#impName").textContent = "讀取 " + f.name + " 中…";
  try {
    await loadXLSX();
    const buf = await f.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(f.name)) {
      let txt = new TextDecoder("utf-8").decode(buf);
      if (txt.includes("�")) { try { txt = new TextDecoder("big5").decode(buf); } catch (x) {} }
      wb = XLSX.read(txt.replace(/^﻿/, ""), { type: "string" });
    } else wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", blankrows: false });
    if (rows.length < 2) throw new Error("empty");
    impHead = rows[0].map(h => String(h).trim()); impRows = rows.slice(1);
    const opts = `<option value="${NONE}">（無）</option>` + impHead.map((h, i) => `<option value="${i}">${esc(h || "第" + (i + 1) + "欄")}</option>`).join("");
    ["org", "job", "name", "cat"].forEach(k => $("#m-" + k).innerHTML = opts);
    $("#m-org").value = guessCol(/單位|機關|學校|服務|公司|組織/);
    $("#m-job").value = guessCol(/職稱|頭銜|職務|職位|稱謂/);
    $("#m-name").value = guessCol(/姓名|名字|^名$|來賓/);
    $("#m-cat").value = guessCol(/身分|類別|類型|分類/);
    if ($("#m-name").value === NONE && impHead.length >= 2) $("#m-name").value = "1";
    $("#impName").textContent = `${f.name}：${impRows.length} 列，請確認欄位對應`;
    $("#impMap").hidden = false; drawPreview();
  } catch (ex) {
    err.textContent = ex && ex.message === "load" ? "讀檔工具載入失敗，請確認網路後再試。" : ex && ex.message === "empty" ? "檔案裡沒有資料列，第一列要是欄位名稱，第二列開始是來賓。" : "無法讀取這個檔案，請確認是 .xlsx、.xls 或 .csv。";
    err.hidden = false; $("#impName").textContent = "";
  }
  e.target.value = "";
});
["org", "job", "name", "cat"].forEach(k => $("#m-" + k).addEventListener("change", drawPreview));
$("#impCancel").addEventListener("click", () => { impRows = []; $("#impMap").hidden = true; $("#impName").textContent = ""; });
$("#impGo").addEventListener("click", async () => {
  const add = mapped().filter(x => !x.dup), b = $("#impGo"); b.disabled = true; const now = Date.now();
  try {
    await batchWrite(add.map((x, i) => ({ type: "set", id: newId(), data: { title: x.title, name: x.name, cat: x.cat, first: false, status: "expected", createdAt: now + i, source: "import" } })));
    toast(`已匯入 ${add.length} 位來賓`); $("#impName").textContent = `已匯入 ${add.length} 位`;
    impRows = []; $("#impMap").hidden = true;
  } catch (ex) { $("#impErr").textContent = "匯入失敗：" + (ex.code === "permission-denied" ? "沒有權限" : "請再試一次"); $("#impErr").hidden = false; }
  b.disabled = false;
});

// ---------- 設定與工作人員 ----------
$("#saveCfg").addEventListener("click", async () => {
  const b = $("#saveCfg"); b.disabled = true;
  try { await setDoc(doc(db, "settings", "event"), { event: $("#c-event").value.trim(), notice: $("#c-notice").value.trim() }); toast("設定已儲存"); }
  catch (e) { toast("儲存失敗，需要管理者權限"); }
  b.disabled = false;
});
async function saveStaff(role, list) {
  const next = { owner: isOwner ? me.email : (staffDoc.owner || ""), admins: staffDoc.admins || [], emails: staffDoc.emails || [] };
  next[role] = [...new Set(list)].filter(e => e !== next.owner);
  if (role === "admins") next.emails = next.emails.filter(e => !next.admins.includes(e));
  if (role === "emails") next.emails = next.emails.filter(e => !next.admins.includes(e));
  try { await setDoc(doc(db, "settings", "staff"), next); toast("帳號名單已更新"); }
  catch (e) { toast(role === "admins" ? "只有系統管理者能調整管理者" : "更新失敗，需要管理者權限"); }
}
function addEmail(role) {
  const v = $("#newEmail").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast("請輸入完整的電子郵件"); return; }
  $("#newEmail").value = "";
  saveStaff(role, [...(staffDoc[role] || []), v]);
}
$("#addStaff").addEventListener("click", () => addEmail("emails"));
$("#addAdmin").addEventListener("click", () => addEmail("admins"));

// ---------- 下載 QR 總表 ----------
$("#dlSheet").addEventListener("click", () => {
  const list = [...guests].filter(g => g.source !== "self").sort((a, b) => catRank(a.cat) - catRank(b.cat) || (a.createdAt || 0) - (b.createdAt || 0));
  if (!list.length) { toast("名單是空的"); return; }
  const base = siteBase(), cols = 4, cw = 300, ch = 380, rows = Math.ceil(list.length / cols), head = 110;
  const cv = document.createElement("canvas"); cv.width = cols * cw + 40; cv.height = head + rows * ch + 20;
  const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = "#2a3a85"; c.font = "bold 40px 'LXGW WenKai TC','Noto Sans TC',sans-serif"; c.fillText(`${SCHOOL.name} ${cfg.event || SCHOOL.defaultEvent} 來賓報到 QR`, 20, 62);
  c.fillStyle = "#5e6585"; c.font = "22px 'Noto Sans TC',sans-serif"; c.fillText("接待老師用手機相機掃描即可報到", 20, 96);
  const tmp = document.createElement("canvas");
  list.forEach((g, i) => {
    const x = 20 + (i % cols) * cw, y = head + Math.floor(i / cols) * ch;
    c.strokeStyle = "#d3d7e6"; c.lineWidth = 2; c.strokeRect(x + 8, y + 8, cw - 16, ch - 16);
    qrCanvas(tmp, base + "#g-" + g.id, 240); c.imageSmoothingEnabled = false; c.drawImage(tmp, x + (cw - 240) / 2, y + 22, 240, 240);
    c.textAlign = "center"; c.fillStyle = "#5e6585"; c.font = "20px 'Noto Sans TC',sans-serif"; c.fillText(g.title || "", x + cw / 2, y + 300, cw - 30);
    c.fillStyle = "#1b2140"; c.font = "bold 30px 'Noto Sans TC',sans-serif"; c.fillText(g.name || "", x + cw / 2, y + 342, cw - 30); c.textAlign = "left";
  });
  cv.toBlob(blob => saveBlob(blob, "來賓報到QR總表.png"), "image/png");
});


// ---------- 系統管理（只有系統管理者） ----------
const ROLE_LABEL = { admins: "管理者", emails: "工作人員" };
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
async function writeStaff(next, okMsg) {
  next = { owner: me.email, admins: [...new Set(next.admins)].filter(e => e !== me.email), emails: [...new Set(next.emails)].filter(e => e !== me.email) };
  next.emails = next.emails.filter(e => !next.admins.includes(e));
  try { await setDoc(doc(db, "settings", "staff"), next); if (okMsg) toast(okMsg); return true; }
  catch (e) { toast("更新失敗：只有系統管理者能調整管理者"); return false; }
}
const cur = () => ({ admins: [...(staffDoc.admins || [])], emails: [...(staffDoc.emails || [])] });

function renderSystem() {
  if (!isOwner) return;
  const rb = $("#reqBadge"); rb.hidden = !requests.length; rb.textContent = requests.length;
  $("#reqPanel").hidden = false;
  $("#reqList").innerHTML = requests.length ? requests.map(r => `<li class="g"><div class="info"><span class="nm">${esc(r.name || "（未提供姓名）")}</span><div class="tt">${esc(r.email)}・${fmt(r.createdAt)} 申請</div></div><div class="btnrow"><button class="btn sm" data-act="reqok" data-id="${r.id}" data-role="admins">設為管理者</button><button class="btn sm ghost" data-act="reqok" data-id="${r.id}" data-role="emails">設為工作人員</button><button class="btn sm danger" data-act="reqno" data-id="${r.id}">拒絕</button></div></li>`).join("") : `<li class="empty">目前沒有待核准的申請。</li>`;
  const a = staffDoc.admins || [], st = staffDoc.emails || [];
  $("#si-owner").textContent = staffDoc.owner || me.email;
  $("#si-admins").textContent = `${a.length} 位`;
  $("#si-staff").textContent = `${st.length} 位`;
  $("#si-guests").textContent = `${guests.length} 筆`;
  const row = (e, role) => `<tr><td>${esc(e)}</td><td><select data-rolesel="${esc(e)}" aria-label="${esc(e)} 的身分"><option value="admins"${role === "admins" ? " selected" : ""}>管理者</option><option value="emails"${role === "emails" ? " selected" : ""}>工作人員</option></select></td><td><span data-rmbox="${esc(e)}"><button class="btn sm danger" data-act="sysask" data-email="${esc(e)}">移除</button></span></td></tr>`;
  $("#roleTable").innerHTML = `<thead><tr><th>帳號</th><th>身分</th><th></th></tr></thead><tbody><tr><td>${esc(staffDoc.owner || me.email)} <b>（你）</b></td><td><span class="rolepill">系統管理者</span></td><td></td></tr>${a.map(e => row(e, "admins")).join("")}${st.map(e => row(e, "emails")).join("")}${!a.length && !st.length ? `<tr><td colspan="3" class="hint">還沒有其他帳號。用上方「批次加入」或核准老師的申請。</td></tr>` : ""}</tbody>`;
}

document.addEventListener("change", async e => {
  const sel = e.target.closest("[data-rolesel]"); if (!sel || !isOwner) return;
  const email = sel.dataset.rolesel, to = sel.value, n = cur();
  n.admins = n.admins.filter(x => x !== email); n.emails = n.emails.filter(x => x !== email);
  n[to].push(email);
  await writeStaff(n, `${email} 已改為${ROLE_LABEL[to]}`);
});

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || !isOwner) return;
  const act = b.dataset.act;
  if (act === "sysask") { const em = b.dataset.email; document.querySelector(`[data-rmbox="${CSS.escape(em)}"]`).innerHTML = `<span class="confirm">確定移除？<button class="btn sm danger" data-act="sysrm" data-email="${esc(em)}">移除</button><button class="btn sm ghost" data-act="sysno">取消</button></span>`; return; }
  if (act === "sysno") { render(); return; }
  if (act === "sysrm") { const em = b.dataset.email, n = cur(); n.admins = n.admins.filter(x => x !== em); n.emails = n.emails.filter(x => x !== em); await writeStaff(n, `已移除 ${em}`); return; }
  if (act === "reqok" || act === "reqno") {
    const r = requests.find(x => x.id === b.dataset.id); if (!r) return; b.disabled = true;
    try {
      const batch = writeBatch(db);
      if (act === "reqok") {
        const n = cur(), role = b.dataset.role, em = String(r.email || "").toLowerCase();
        n.admins = n.admins.filter(x => x !== em); n.emails = n.emails.filter(x => x !== em); n[role].push(em);
        batch.set(doc(db, "settings", "staff"), { owner: me.email, admins: [...new Set(n.admins)], emails: [...new Set(n.emails)].filter(x => !n.admins.includes(x)) });
      }
      batch.delete(doc(db, "requests", r.id));
      await batch.commit();
      toast(act === "reqok" ? `已核准 ${r.email} 為${ROLE_LABEL[b.dataset.role]}` : `已拒絕 ${r.email}`);
    } catch (err) { toast("處理失敗，請再試一次"); b.disabled = false; }
  }
});

$("#batchBtn").addEventListener("click", async () => {
  const role = (document.querySelector("input[name=batchRole]:checked") || {}).value || "admins";
  const items = $("#batchEmails").value.split(/[\s,;，、]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!items.length) { $("#batchMsg").textContent = "請先貼上 email。"; return; }
  const bad = items.filter(x => !EMAIL_RE.test(x)), good = [...new Set(items.filter(x => EMAIL_RE.test(x)))].filter(x => x !== me.email);
  const n = cur(), already = good.filter(x => n[role].includes(x) || (role === "emails" && n.admins.includes(x)));
  const add = good.filter(x => !already.includes(x));
  if (!add.length) { $("#batchMsg").textContent = `沒有新增任何人${already.length ? `（${already.length} 位已在名單中；要把管理者降為工作人員，請在下方權限總覽切換）` : ""}${bad.length ? `，${bad.length} 筆格式不對` : ""}。`; return; }
  const other = role === "admins" ? "emails" : "admins";
  n[other] = n[other].filter(x => !add.includes(x)); n[role].push(...add);
  if (await writeStaff(n, `已加入 ${add.length} 位${ROLE_LABEL[role]}`)) {
    $("#batchEmails").value = bad.join("\n");
    $("#batchMsg").textContent = `已加入 ${add.length} 位${already.length ? `，略過 ${already.length} 位（已在名單中）` : ""}${bad.length ? `，${bad.length} 筆格式不對，留在框內請修正` : ""}。`;
  }
});

// 從外部檔案匯入工作人員／管理者
let staffRows = [];
function planStaffImport() {
  const def = (document.querySelector("input[name=batchRole]:checked") || {}).value || "admins";
  const n = cur(), seen = new Set();
  return staffRows.map(r => {
    const role = r.role || def; let st = "new";
    if (!EMAIL_RE.test(r.email)) st = "bad";
    else if (r.email === (staffDoc.owner || me.email)) st = "owner";
    else if (seen.has(r.email)) st = "dup";
    else if (n[role].includes(r.email)) st = "same";
    else if (role === "emails" && n.admins.includes(r.email)) st = "isadmin";
    else if (role === "admins" && n.emails.includes(r.email)) st = "promote";
    seen.add(r.email);
    return { ...r, role, st };
  });
}
const ST_TEXT = { new: "新增", promote: "工作人員 → 升為管理者", same: "已在名單，略過", isadmin: "已是管理者，略過", owner: "系統管理者本人，略過", dup: "檔案內重複，略過", bad: "email 格式不對，略過" };
function drawStaffPrev() {
  const plan = planStaffImport(), ok = plan.filter(x => x.st === "new" || x.st === "promote");
  $("#staffPrevTbl").innerHTML = `<thead><tr><th>#</th><th>姓名</th><th>email</th><th>設為</th><th>結果</th></tr></thead><tbody>` + plan.slice(0, 300).map((x, i) => `<tr class="${x.st === "new" || x.st === "promote" ? "" : "dup"}"><td>${i + 1}</td><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${ROLE_LABEL[x.role]}</td><td>${ST_TEXT[x.st]}</td></tr>`).join("") + `</tbody>`;
  $("#staffImpInfo").textContent = `將加入 ${ok.length} 位，略過 ${plan.length - ok.length} 位`;
  $("#staffImpGo").disabled = !ok.length;
}
$("#staffPick").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#staffFile").click(); } });
document.querySelectorAll("input[name=batchRole]").forEach(r => r.addEventListener("change", () => { if (staffRows.length) drawStaffPrev(); }));
$("#staffFile").addEventListener("change", async e => {
  const f = e.target.files[0], err = $("#staffImpErr"); err.hidden = true; if (!f) return;
  try {
    await loadXLSX();
    const buf = await f.arrayBuffer(); let wb;
    if (/\.csv$/i.test(f.name)) {
      let txt = new TextDecoder("utf-8").decode(buf);
      if (txt.includes("�")) { try { txt = new TextDecoder("big5").decode(buf); } catch (x) {} }
      wb = XLSX.read(txt.replace(/^﻿/, ""), { type: "string" });
    } else wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", blankrows: false }).map(r => r.map(c => String(c).trim()));
    if (!rows.length) throw new Error("empty");
    const head = rows[0], find = re => head.findIndex(h => re.test(h));
    const hasHeader = !head.some(c => EMAIL_RE.test(c.toLowerCase()));
    let ec = hasHeader ? find(/mail|郵件|信箱|帳號|account/i) : -1;
    const rc = hasHeader ? find(/身分|身份|權限|角色|類別|role/i) : -1;
    const nc = hasHeader ? find(/姓名|名字|老師|name/i) : -1;
    const body = hasHeader ? rows.slice(1) : rows;
    staffRows = body.map(r => {
      let email = ec >= 0 ? (r[ec] || "") : "";
      if (!EMAIL_RE.test(email.toLowerCase())) email = r.find(c => EMAIL_RE.test(c.toLowerCase())) || email;
      const rv = rc >= 0 ? r[rc] || "" : "";
      const role = /管理/.test(rv) ? "admins" : /工作|人員|staff/i.test(rv) ? "emails" : "";
      return { email: email.toLowerCase(), name: nc >= 0 ? r[nc] || "" : "", role };
    }).filter(x => x.email || x.name);
    if (!staffRows.length) throw new Error("noemail");
    $("#staffPrev").hidden = false; drawStaffPrev();
  } catch (ex) {
    err.textContent = ex && ex.message === "load" ? "讀檔工具載入失敗，請確認網路後再試。" : ex && (ex.message === "empty" || ex.message === "noemail") ? "檔案裡找不到 email，請確認有一欄是老師的 email。" : "無法讀取這個檔案，請確認是 .xlsx、.xls 或 .csv。";
    err.hidden = false; staffRows = []; $("#staffPrev").hidden = true;
  }
  e.target.value = "";
});
$("#staffImpCancel").addEventListener("click", () => { staffRows = []; $("#staffPrev").hidden = true; });
$("#staffImpGo").addEventListener("click", async () => {
  const plan = planStaffImport().filter(x => x.st === "new" || x.st === "promote"); if (!plan.length) return;
  const n = cur();
  plan.forEach(x => { n.admins = n.admins.filter(e => e !== x.email); n.emails = n.emails.filter(e => e !== x.email); n[x.role].push(x.email); });
  const na = plan.filter(x => x.role === "admins").length, ns = plan.length - na;
  if (await writeStaff(n, `已匯入：管理者 ${na} 位、工作人員 ${ns} 位`)) { staffRows = []; $("#staffPrev").hidden = true; }
});

// ---------- 沒有權限的人：申請使用權限 ----------
async function showRequestBox(u) {
  $("#requestBox").hidden = false; $("#requestBtn").hidden = false;
  $("#requestMsg").textContent = "送出後，請系統管理者核准，核准後重新整理頁面即可使用。";
  try {
    const r = await getDoc(doc(db, "requests", u.uid));
    if (r.exists()) { $("#requestBtn").hidden = true; $("#requestMsg").textContent = `已在 ${fmt(r.data().createdAt)} 送出申請，等待系統管理者核准。核准後重新整理頁面即可使用。`; }
  } catch (e) {}
}
$("#requestBtn").addEventListener("click", async () => {
  const u = auth.currentUser; if (!u) return;
  const b = $("#requestBtn"); b.disabled = true;
  try {
    await setDoc(doc(db, "requests", u.uid), { email: (u.email || "").toLowerCase(), name: (u.displayName || "").slice(0, 60), createdAt: Date.now() });
    b.hidden = true; $("#requestMsg").textContent = "申請已送出，請通知系統管理者核准。核准後重新整理頁面即可使用。";
  } catch (e) { $("#requestMsg").textContent = "申請送出失敗，請稍後再試，或直接聯絡系統管理者。"; }
  b.disabled = false;
});

// ---------- 活動結案、切換與 CSV 匯出 ----------
// archives/{id}：摘要（活動名稱、結案時間、人數）；archives/{id}/rows/all：完整名單（含 QR 用的原始 id）
const fullTime = ms => { if (!ms) return ""; const d = new Date(ms); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ST_LABEL = { expected: "未報到", review: "自助待確認", arrived: "已報到（待介紹）", introduced: "已介紹" };
const SRC_LABEL = { preload: "手動貼上", import: "匯入名單", walkin: "臨時來賓", self: "自助報到" };
const ARCH_FIELDS = ["no", "title", "name", "cat", "status", "source", "first", "arrivedAt", "introducedAt", "reporterName", "selfReported", "createdAt", "rank"];
function rowOf(g) { const r = { id: g.id }; ARCH_FIELDS.forEach(k => r[k] = g[k] === undefined ? null : g[k]); r.first = !!g.first; r.selfReported = !!g.selfReported; return r; }
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s;              // 避免 Excel 當成公式
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(list, eventName) {
  const rows = [...list].filter(g => g.status !== "merged").sort((a, b) => (typeof a.no === "number" ? a.no : 1e9) - (typeof b.no === "number" ? b.no : 1e9) || catRank(a.cat) - catRank(b.cat) || (a.createdAt || 0) - (b.createdAt || 0));
  const head = ["報到序號", "頭銜", "姓名", "身分", "狀態", "第一優先", "來源", "報到時間", "介紹時間", "通報人"];
  const body = rows.map(g => [noTxt(g.no), g.title, g.name, g.cat, ST_LABEL[g.status] || g.status, g.first ? "是" : "", (SRC_LABEL[g.source] || g.source || "") + (g.selfReported && g.source !== "self" ? "（自助報到）" : ""), fullTime(g.arrivedAt), fullTime(g.introducedAt), g.reporterName || ""]);
  const csv = [head, ...body].map(r => r.map(csvCell).join(",")).join("\r\n");
  const d = new Date(), stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  saveBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${String(eventName || "活動").replace(/[\\/:*?"<>|]/g, "_")}_來賓紀錄_${stamp}.csv`);
}
$("#csvNow").addEventListener("click", () => {
  if (!guests.length) { toast("目前名單是空的"); return; }
  downloadCsv(guests, cfg.event || SCHOOL.defaultEvent); toast("已下載 CSV，可用 Excel 開啟");
});
async function exportArchive(id, b) {
  const a = archives.find(x => x.id === id); b.disabled = true;
  try { const s = await getDoc(doc(db, "archives", id, "rows", "all")); downloadCsv((s.exists() && s.data().guests) || [], a ? a.event : "活動"); toast("已下載 CSV，可用 Excel 開啟"); }
  catch (e) { toast("下載失敗，請確認網路後再試"); }
  b.disabled = false;
}

$("#askClose").addEventListener("click", () => {
  if (!guests.length) { toast("目前名單是空的，不需要結案"); return; }
  const arr = guests.filter(g => g.status === "arrived" || g.status === "introduced").length, intro = guests.filter(g => g.status === "introduced").length;
  const pend = guests.filter(g => g.status === "arrived").length, rv = guests.filter(g => g.status === "review").length;
  $("#closeSum").innerHTML = `將「<b>${esc(cfg.event || SCHOOL.defaultEvent)}</b>」共 ${guests.length} 位（已報到 ${arr}、已介紹 ${intro}）封存起來，然後清空目前名單。${pend ? `<br><b class="warnt">還有 ${pend} 位已報到但尚未介紹。</b>` : ""}${rv ? `<br><b class="warnt">還有 ${rv} 筆自助報到尚未確認。</b>` : ""}<br><span class="hint">封存後可以隨時匯出 CSV，也能在下方「切換回這場」繼續使用；印好的 QR Code 切換回來後仍可使用。</span>`;
  $("#closeErr").hidden = true; $("#nextEvent").value = ""; $("#closeBox").hidden = false; $("#nextEvent").focus();
});
$("#noClose").addEventListener("click", () => { $("#closeBox").hidden = true; });
$("#doClose").addEventListener("click", async () => {
  const err = $("#closeErr"), b = $("#doClose"); err.hidden = true;
  if (!conn.online || navigator.onLine === false) { err.textContent = "目前離線，請連上網路後再結案。"; err.hidden = false; return; }
  if (guests.some(g => g._pending)) { err.textContent = "還有通報尚未送達伺服器，請等「傳送中」消失後再結案。"; err.hidden = false; return; }
  const ev = cfg.event || SCHOOL.defaultEvent, next = $("#nextEvent").value.trim(), now = Date.now(), id = newId();
  const rows = guests.map(rowOf);
  if (JSON.stringify(rows).length > 900000) { err.textContent = "名單太大，無法一次封存，請先匯出 CSV 保存。"; err.hidden = false; return; }
  b.disabled = true;
  try {
    const bt = writeBatch(db);
    bt.set(doc(db, "archives", id), { event: ev, closedAt: now, closedBy: me.displayName || me.email, count: rows.length, arrived: rows.filter(g => g.status === "arrived" || g.status === "introduced").length, introduced: rows.filter(g => g.status === "introduced").length });
    bt.set(doc(db, "archives", id, "rows", "all"), { guests: rows });
    await bt.commit();                                       // 先確定封存成功，才清空名單
  } catch (e) {
    err.textContent = e && e.code === "permission-denied" ? "封存失敗：沒有權限。請確認你是管理者，且 Firebase 安全規則已更新成新版（見 README）。" : "封存失敗，名單沒有被清空，請再試一次。";
    err.hidden = false; b.disabled = false; return;
  }
  try {
    await batchWrite(allIds.map(x => ({ type: "delete", id: x })));
    await setDoc(doc(db, "settings", "event"), { event: next || ev, notice: "" });
    await setDoc(counterRef(), { n: 0 }).catch(() => {});   // 下一場從 001 開始
    $("#closeBox").hidden = true; toast(`「${ev}」已結案封存${next ? `，目前活動：${next}` : ""}`);
  } catch (e) { err.textContent = "已封存，但清空名單時中斷；請再按一次「結案封存」或用「清空名單」。"; err.hidden = false; }
  b.disabled = false;
});

async function restoreArchive(id) {
  const a = archives.find(x => x.id === id); if (!a) return;
  if (guests.length) { toast("目前名單還有資料：請先「結案封存」目前這場"); return; }
  try {
    const s = await getDoc(doc(db, "archives", id, "rows", "all"));
    const rows = (s.exists() && s.data().guests) || [];
    await batchWrite(rows.map(r => { const { id: gid, ...data } = r; return { type: "set", id: gid || newId(), data }; }));
    await setDoc(doc(db, "settings", "event"), { event: a.event, notice: cfg.notice || "" });
    await setDoc(counterRef(), { n: rows.reduce((m, r) => Math.max(m, typeof r.no === "number" ? r.no : 0), 0) }).catch(() => {});
    toast(`已切換回「${a.event}」，共 ${rows.length} 位`);
  } catch (e) { toast(e && e.code === "permission-denied" ? "切換失敗：需要管理者權限" : "切換失敗，請再試一次"); }
}
async function deleteArchive(id) {
  try { const bt = writeBatch(db); bt.delete(doc(db, "archives", id, "rows", "all")); bt.delete(doc(db, "archives", id)); await bt.commit(); toast("已刪除這份紀錄"); }
  catch (e) { toast("刪除失敗：只有系統管理者能刪除活動紀錄"); }
}

// ---------- 提示音 ----------
let chimeCtx = null;
$("#chime").addEventListener("change", e => { if (e.target.checked) { try { chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)(); chimeCtx.resume(); ding(false); } catch (err) {} } });
function ding(urgent) {
  if (!chimeCtx || !$("#chime").checked) return;
  const t = chimeCtx.currentTime;
  (urgent ? [880, 1175, 880, 1175] : [784, 1047]).forEach((f, i) => {
    const o = chimeCtx.createOscillator(), g = chimeCtx.createGain(), s = t + i * .17;
    o.frequency.value = f; g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(.25, s + .02); g.gain.exponentialRampToValueAtTime(.001, s + .5);
    o.connect(g).connect(chimeCtx.destination); o.start(s); o.stop(s + .55);
  });
}

// ---------- 自助報到待確認 ----------
// 來賓自己掃 QR 填的資料先停在「待確認」，老師可修改後確認；
// 若姓名與預約名單中唯一一位相同，確認時合併成同一筆
function matchOf(g, name) {
  const nm = nameKey(name ?? g.name); if (!nm) return null;
  const c = guests.filter(x => x.status === "expected" && nameKey(x.name) === nm);
  return c.length === 1 ? c[0] : null;
}
function renderReview() {
  const list = guests.filter(g => g.status === "review").sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const rb = $("#reviewBadge"); rb.hidden = !list.length; rb.textContent = list.length;
  $("#reviewPanel").hidden = !list.length;
  $("#goReview").hidden = !list.length; $("#rvCount").textContent = list.length;
  const key = list.map(g => g.id).join(",") + "|" + guests.filter(g => g.status === "expected").length;
  const box = $("#reviewList");
  if (key === reviewKey || box.contains(document.activeElement)) return; // 老師正在修改時不要重畫
  reviewKey = key;
  box.innerHTML = list.map(g => {
    const m = matchOf(g);
    return `<li class="rv" data-rv="${g.id}">
      <div class="rvf">
        <input type="text" data-f="title" value="${esc(g.title)}" maxlength="60" aria-label="頭銜" placeholder="頭銜">
        <input type="text" data-f="name" value="${esc(g.name)}" maxlength="20" aria-label="姓名" placeholder="姓名">
        <select data-f="cat" aria-label="身分">${CATS.map(c => `<option${c === g.cat ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>
      </div>
      <div class="match">${fmt(g.createdAt)} 送出${m ? `・名單中有 <b>${esc(who(m))}</b>，確認後會合併成同一筆` : "・不在預約名單中，確認後會新增"}</div>
      <div class="btnrow"><button class="btn sm" data-act="rvok" data-id="${g.id}" data-first="0">確認報到</button><button class="btn sm koi" data-act="rvok" data-id="${g.id}" data-first="1">確認・第一優先</button><span data-rvdel="${g.id}"><button class="btn sm danger" data-act="rvask" data-id="${g.id}">刪除</button></span></div>
    </li>`;
  }).join("");
}
async function confirmSelf(id, first) {
  const li = document.querySelector(`[data-rv="${id}"]`); if (!li) return;
  const val = f => li.querySelector(`[data-f="${f}"]`).value.trim();
  const title = val("title"), name = val("name"), cat = val("cat");
  if (!name && !title) { toast("請至少保留姓名或頭銜"); return; }
  const m = matchOf(null, name), now = Date.now(), by = me.displayName || me.email;
  const run = withNo => runTransaction(db, async tx => {
    // Firestore 交易要先讀完再寫
    const sd = await tx.get(gref(id)); if (!sd.exists() || sd.data().status !== "review") throw new Error("gone");
    const ed = m ? await tx.get(gref(m.id)) : null;
    const cs = withNo ? await tx.get(counterRef()) : null;
    const no = withNo ? ((cs.exists() && cs.data().n) || 0) + 1 : null;
    const numPatch = withNo ? { no } : {};
    if (ed && ed.exists() && ed.data().status === "expected") {
      tx.update(gref(m.id), { status: "arrived", arrivedAt: sd.data().arrivedAt || now, first, rank: null, selfReported: true, reporterName: "自助報到・" + by, ...numPatch });
      // 自助那筆保留為 merged，讓來賓手機看得到序號；工作人員畫面不顯示，結案時一起刪除
      if (withNo) tx.update(gref(id), { status: "merged", mergedInto: m.id, no }); else tx.delete(gref(id));
    } else tx.update(gref(id), { title, name, cat, first, status: "arrived", rank: null, reporterName: "自助報到・" + by, ...numPatch });
    if (withNo) tx.set(counterRef(), { n: no });
    return no;
  });
  try {
    let no;
    try { no = numBlocked ? await run(false) : await run(true); }
    catch (e) { if (e && e.code === "permission-denied" && !numBlocked) { numBlocked = true; no = await run(false); } else throw e; }
    reviewKey = ""; toast(`✓ ${name || title} 已確認，已送達介紹台${no ? `・報到序號 ${noTxt(no)}` : ""}${first ? "（第一優先）" : ""}`);
  } catch (e) { toast(e && e.message === "gone" ? "這筆已被其他老師處理" : e && e.code === "unavailable" ? "網路不穩，這筆沒有送出，請連上網路後再按一次" : "確認失敗，請再試一次"); reviewKey = ""; render(); }
}

// ---------- 報到序號：已報到但還沒有號碼的，依報到時間依序取號 ----------
// 報到本身不等伺服器（離線也能報到），號碼由任一台連線中的工作人員裝置用交易補上，多台同時補也不會重號
function scheduleNumbering() {
  if (numBlocked || numbering || numTimer || !conn.online) return;
  if (!guests.some(g => (g.status === "arrived" || g.status === "introduced") && typeof g.no !== "number" && !g._pending)) return;
  numTimer = setTimeout(assignNumbers, 150 + Math.random() * 450);
}
async function assignNumbers() {
  numTimer = null; numbering = true;
  const miss = guests.filter(g => (g.status === "arrived" || g.status === "introduced") && typeof g.no !== "number" && !g._pending)
    .sort((a, b) => (a.arrivedAt || 0) - (b.arrivedAt || 0)).slice(0, 25);
  try {
    if (miss.length) await runTransaction(db, async tx => {
      const cs = await tx.get(counterRef());
      const snaps = await Promise.all(miss.map(g => tx.get(gref(g.id))));
      const todo = snaps.filter(d => d.exists() && ["arrived", "introduced"].includes(d.data().status) && typeof d.data().no !== "number");
      if (!todo.length) return;
      let n = (cs.exists() && cs.data().n) || 0;
      todo.forEach(d => tx.update(gref(d.id), { no: ++n }));
      tx.set(counterRef(), { n });
    });
  } catch (e) { if (e && e.code === "permission-denied") { numBlocked = true; render(); } }
  numbering = false;
  setTimeout(scheduleNumbering, 300);
}

// ---------- 登入與資料連線 ----------
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; guests = []; requests = []; archives = []; loaded = false; prevStatus = new Map(); pendSince = new Map(); ackWatch = new Map(); conn = { online: false, syncedAt: 0, updatedAt: 0, offlineSince: 0, startedAt: 0 }; }

function startListeners() {
  connErr = ""; conn.startedAt = Date.now(); renderConn();
  const timer = setTimeout(renderConn, 10500);
  // includeMetadataChanges：伺服器確認寫入、或連線斷開／恢復時也會通知
  unsubs.push(onSnapshot(query(collection(db, "guests"), orderBy("createdAt", "asc"), limit(2000)), { includeMetadataChanges: true }, snap => {
    clearTimeout(timer); connErr = "";
    const now = Date.now();
    if (snap.metadata.fromCache) { if (conn.online) conn.offlineSince = now; conn.online = false; }
    else { conn.online = true; conn.offlineSince = 0; conn.syncedAt = now; if (snap.docChanges().length || !conn.updatedAt) conn.updatedAt = now; }
    const docsAll = snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }));
    allIds = docsAll.map(g => g.id);
    guests = docsAll.filter(g => g.status !== "merged");
    // 送達追蹤
    const byId = new Map(guests.map(g => [g.id, g]));
    for (const g of guests) { if (g._pending && !pendSince.has(g.id)) pendSince.set(g.id, now); }
    for (const id of [...pendSince.keys()]) { const g = byId.get(id); if (!g || !g._pending) pendSince.delete(id); }
    for (const [id, label] of [...ackWatch]) {
      const g = byId.get(id);
      if (g && !g._pending && g.status === "arrived" && (typeof g.no === "number" || numBlocked)) { ackWatch.delete(id); toast(`✓ ${label || who(g)} 已送達介紹台${typeof g.no === "number" ? `・報到序號 ${noTxt(g.no)}` : ""}`); }
      else if (!g || (g.status !== "arrived" && !g._pending)) ackWatch.delete(id);
    }
    scheduleNumbering();
    if (loaded) {
      let n = false, urgent = null;
      for (const g of guests) {
        const p = prevStatus.get(g.id);
        if (g.status === "arrived" && p !== "arrived" && p !== "introduced") {
          fresh.add(g.id); n = true; if (g.first) urgent = g;
          const id = g.id; setTimeout(() => { fresh.delete(id); render(); }, 6000);
        }
      }
      // 第一優先不再自動切換頁簽，改由介紹台上方的提示讓司儀決定
      const newReview = guests.some(g => g.status === "review" && prevStatus.get(g.id) === undefined);
      if (newReview) toast("有新的自助報到等待確認");
      if (n || newReview) ding(!!urgent);
    }
    prevStatus = new Map(guests.map(g => [g.id, g.status])); loaded = true;
    render();
  }, e => { clearTimeout(timer); setStatus(e.code === "permission-denied" ? "你的帳號沒有權限讀取名單。" : "連線中斷，請重新整理頁面。"); }));
  unsubs.push(onSnapshot(query(collection(db, "archives"), orderBy("closedAt", "desc"), limit(50)), snap => {
    archErr = ""; archives = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderArchives();
  }, e => { archErr = e.code === "permission-denied" ? "讀不到活動紀錄：需要先把 Firebase 安全規則更新成新版（見 README「更新安全規則」）。" : "活動紀錄暫時讀不到。"; renderArchives(); }));
  unsubs.push(onSnapshot(doc(db, "settings", "staff"), s => {
    if (s.exists()) { staffDoc = s.data(); applyRole(roleOf(staffDoc)); }
    render();
  }, () => {}));
  if (isOwner) {
    let firstReq = true;
    unsubs.push(onSnapshot(query(collection(db, "requests"), orderBy("createdAt", "asc"), limit(200)), snap => {
      const before = requests.length;
      requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!firstReq && requests.length > before) toast("有老師申請使用權限，請到「系統管理」核准");
      firstReq = false; render();
    }, () => {}));
  }
}

// 活動名稱公開可讀，首頁也看得到
function watchEvent() {
  onSnapshot(doc(db, "settings", "event"), s => {
    const d = s.exists() ? s.data() : {}; cfg = { event: d.event || "", notice: d.notice || "" };
    if (document.activeElement !== $("#c-event")) $("#c-event").value = cfg.event;
    if (document.activeElement !== $("#c-notice")) $("#c-notice").value = cfg.notice;
    render();
  }, () => {});
}

function roleOf(d) {
  if (!me || !d) return "none";
  if (d.owner === me.email) return "owner";
  if ((d.admins || []).includes(me.email)) return "admin";
  if ((d.emails || []).includes(me.email)) return "staff";
  return "none";
}
function applyRole(r) {
  isOwner = r === "owner"; isAdmin = isOwner || r === "admin"; isStaff = isAdmin || r === "staff";
  $("#userName").textContent = me ? `${me.displayName || me.email}${ROLE_NAME[r] ? "・" + ROLE_NAME[r] : ""}` : "";
}
async function checkStaff() {
  try {
    const s = await getDoc(doc(db, "settings", "staff"));
    if (s.exists()) {
      staffDoc = s.data(); const r = roleOf(staffDoc);
      if (r !== "none") return r;
      // 讀得到卻不在名單上：代表安全規則把你指定為新的系統管理者，更新名單上的紀錄
      staffDoc = { ...staffDoc, owner: me.email, admins: (staffDoc.admins || []).filter(e => e !== me.email), emails: (staffDoc.emails || []).filter(e => e !== me.email) };
      try { await setDoc(doc(db, "settings", "staff"), staffDoc); return "owner"; }
      catch (e2) { return "none"; }
    }
    // 名單還不存在：只有安全規則指定的系統管理者讀得到這裡，替系統建立名單
    staffDoc = { owner: me.email, admins: [], emails: [] };
    await setDoc(doc(db, "settings", "staff"), staffDoc);
    toast("已建立帳號名單，你是系統管理者");
    return "owner";
  } catch (e) {
    if (e.code === "permission-denied") return "none";
    throw e;
  }
}

$("#loginBtn").addEventListener("click", async () => {
  $("#loginErr").hidden = true;
  try { await googleLogin(); }
  catch (e) {
    if (e && e.code === "auth/unauthorized-domain") $("#loginErr").textContent = `這個網址（${location.hostname}）還沒加到 Firebase 的授權網域，請管理者依 README 設定。`;
    else if (e && e.code === "auth/popup-closed-by-user") return;
    else $("#loginErr").textContent = "登入失敗：" + (e && e.code || "請再試一次");
    $("#loginErr").hidden = false;
  }
});
$("#logoutBtn").addEventListener("click", () => signOut(auth));

drawLanding();
if (!configured) {
  $("#setupPanel").hidden = false; $("#loginBtn").disabled = true; $("#pwBtn").disabled = true; showView("landing");
} else {
  watchEvent();
  onAuthStateChanged(auth, u => handleUser(u));
}

let verifySent = "";
async function handleUser(u) {
  stopListeners();
  me = u && !u.isAnonymous ? { email: (u.email || "").toLowerCase(), displayName: u.displayName || "" } : null;
  $("#userName").hidden = !me; $("#logoutBtn").hidden = !me;
  $("#loginForms").hidden = !!me; $("#verifyBox").hidden = true; $("#requestBox").hidden = true; $("#loginErr").hidden = true;
  applyRole("none");
  if (me) {
    const isPw = (u.providerData || []).some(p => p.providerId === "password");
    if (isPw && !u.emailVerified) {
      $("#verifyEmail").textContent = me.email; $("#verifyBox").hidden = false;
      $("#loginMsg").textContent = "帳號密碼登入的老師，第一次使用要先驗證電子郵件。";
      if (verifySent !== u.uid) { verifySent = u.uid; sendEmailVerification(u).catch(() => {}); }
      route(); return;
    }
    let r = "none";
    try { r = await checkStaff(); } catch (e) { $("#loginErr").textContent = "無法連線資料庫，請稍後重新整理。"; $("#loginErr").hidden = false; }
    applyRole(r);
    if (!isStaff) { $("#loginMsg").textContent = `${me.email} 還沒有使用權限。`; showRequestBox(u); }
    else startListeners();
  } else $("#loginMsg").textContent = "接待老師、司儀與校長請登入後使用。";
  route();
}

// 帳號密碼登入
$("#pwForm").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("#loginErr"); err.hidden = true;
  const email = $("#pw-email").value.trim(), pass = $("#pw-pass").value;
  if (!email || !pass) { err.textContent = "請輸入帳號與密碼。"; err.hidden = false; return; }
  const b = $("#pwBtn"); b.disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pass); $("#pw-pass").value = ""; }
  catch (ex) {
    const c = ex && ex.code;
    err.textContent = c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found" || c === "auth/invalid-email" ? "帳號或密碼不正確。" : c === "auth/too-many-requests" ? "嘗試次數太多，請稍後再試，或按「忘記密碼」重設。" : c === "auth/operation-not-allowed" ? "系統尚未開啟帳號密碼登入，請洽系統管理者。" : "登入失敗，請再試一次。";
    err.hidden = false;
  } finally { b.disabled = false; }
});
$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#pw-email").value.trim(), err = $("#loginErr");
  if (!email) { err.textContent = "請先在「帳號」欄輸入你的電子郵件，再按忘記密碼。"; err.hidden = false; return; }
  try { await sendPasswordResetEmail(auth, email); } catch (e) {}
  err.hidden = true; toast("如果這個帳號存在，重設密碼的信已寄出，請查看信箱");
});
$("#resendBtn").addEventListener("click", async () => {
  try { await sendEmailVerification(auth.currentUser); toast("驗證信已重新寄出"); } catch (e) { toast("寄送太頻繁，請稍後再試"); }
});
$("#verifiedBtn").addEventListener("click", async () => {
  const u = auth.currentUser; if (!u) return;
  await u.reload(); await u.getIdToken(true);
  if (!u.emailVerified) { toast("還沒有完成驗證，請到信箱點連結"); return; }
  handleUser(u);
});
