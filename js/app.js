// 鯉魚國小來賓通報系統：工作人員端（接待報到／介紹台／名單與 QR）
import {
  configured, auth, db, googleLogin, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit,
  writeBatch, runTransaction
} from "./firebase.js";
import { $, fmt, esc, newId, toast, startClock, siteBase, qrCanvas, saveBlob } from "./utils.js";
import { SCHOOL, CATS } from "./config.js";

const LAST = CATS[CATS.length - 1];
const catRank = c => { const i = CATS.indexOf(c); return i < 0 ? 99 : i; };
const grpOf = g => CATS.includes(g.cat) ? g.cat : LAST;
const who = g => `${g.title ? g.title + " " : ""}${g.name || ""}`.trim();
const catPill = c => `<span class="cat${c === CATS[0] ? " c0" : ""}">${esc(c)}</span>`;
const P_SIZE = 8, D_SIZE = 15;

// ---------- 狀態 ----------
let me = null, isStaff = false, isAdmin = false, isOwner = false, staffDoc = { owner: "", admins: [], emails: [] };
const ROLE_NAME = { owner: "系統管理者", admin: "管理者", staff: "工作人員" };
let guests = [], cfg = { event: "", notice: "" }, loaded = false;
let prevStatus = new Map(), fresh = new Set(), scanId = null, reviewKey = "";
let expTab = CATS[0], stageTab = CATS[0], pPage = 0, dPage = 0;
let curPending = [], curTabIds = [], drag = null, unsubs = [], requests = [];
try { const t = localStorage.getItem("liyu-exp-tab"); if (CATS.includes(t)) expTab = t; } catch (e) {}
try { const t = localStorage.getItem("liyu-stage-tab"); if (CATS.includes(t)) stageTab = t; } catch (e) {}

$("#schoolName").textContent = SCHOOL.name;
startClock($("#clock"));
$("#w-cat").innerHTML = CATS.map((c, i) => `<input type="radio" name="wcat" id="wcat${i}" value="${esc(c)}"${i === 1 ? " checked" : ""}><label for="wcat${i}">${esc(c)}</label>`).join("");
const tabsHtml = cls => CATS.map(c => `<button type="button" role="tab" class="stab ${cls}" data-grp="${esc(c)}">${esc(c)} <span class="cnt">0</span></button>`).join("");
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

function setStatus(m, warn) { ["#st1", "#st2", "#st3", "#st4"].forEach(s => { $(s).textContent = m; $(s).classList.toggle("warn", !!warn); }); }

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
    else { sc.className = "scan okay"; sc.innerHTML = `<div class="ttl">${esc(g.title)}</div><div class="who">${esc(g.name)}</div><div class="state">${g.status === "introduced" ? "已報到，也已介紹過" : "已報到"}（${fmt(g.arrivedAt)}）${g.first ? "・第一優先" : ""}</div><div class="btnrow" style="justify-content:center">${g.status === "arrived" && !g.first ? `<button class="btn koi sm" data-act="setfirst" data-id="${g.id}">改為第一優先</button>` : ""}<button class="btn ghost sm" data-act="closescan">完成</button></div>`; }
  } else sc.hidden = true;

  // 預約來賓（四頁簽）
  const q = $("#q").value.trim();
  let expAll = guests.filter(g => g.status === "expected");
  if (q) expAll = expAll.filter(g => (g.name + g.title).includes(q));
  const ecnt = {}; CATS.forEach(c => ecnt[c] = 0); expAll.forEach(g => ecnt[grpOf(g)]++);
  document.querySelectorAll(".stab.exp").forEach(t => { const on = t.dataset.grp === expTab; t.setAttribute("aria-selected", on); t.classList.toggle("on", on); t.querySelector(".cnt").textContent = ecnt[t.dataset.grp]; });
  const exp = expAll.filter(g => grpOf(g) === expTab).sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh-Hant"));
  const others = CATS.filter(c => c !== expTab && ecnt[c]).map(c => `${c} ${ecnt[c]} 位`);
  $("#expList").innerHTML = exp.length
    ? exp.slice(0, 40).map(g => `<li class="g"><div class="info">${catPill(g.cat)} <span class="nm">${esc(g.name)}</span><div class="tt">${esc(g.title)}</div></div><div class="btnrow"><button class="btn sm" data-act="arrive" data-id="${g.id}" data-first="0">報到</button><button class="btn sm koi" data-act="arrive" data-id="${g.id}" data-first="1">第一優先</button></div></li>`).join("") + (exp.length > 40 ? `<li class="empty">還有 ${exp.length - 40} 位，請輸入關鍵字縮小範圍</li>` : "")
    : `<li class="empty">${!loaded ? "讀取中…" : others.length ? `這個頁簽沒有${q ? "符合的" : "待報到的"}來賓；其他頁簽：${others.join("、")}。` : q ? "沒有符合的預約來賓，可以用下方「臨時來賓」通報。" : guests.length ? "預約來賓都已報到。" : "還沒有預約名單。到「名單與 QR」匯入，或直接用臨時來賓通報。"}</li>`;

  // 剛剛通報
  const recent = guests.filter(g => g.status === "arrived" || g.status === "introduced").sort((a, b) => (b.arrivedAt || 0) - (a.arrivedAt || 0)).slice(0, 8);
  $("#recentList").innerHTML = recent.length ? recent.map(g => `<li class="g"><div class="info">${g.first ? `<span class="first">第一優先</span> ` : ""}${g.selfReported || g.source === "self" ? `<span class="self">自助</span> ` : ""}<span class="nm">${esc(who(g))}</span><div class="tt">${fmt(g.arrivedAt)} 報到${g.status === "introduced" ? "・已介紹" : ""}${g.reporterName ? "・" + esc(g.reporterName) : ""}</div></div>${g.status === "introduced" ? "" : `<div class="btnrow">${g.first ? `<button class="btn sm ghost" data-act="unfirst" data-id="${g.id}">取消優先</button>` : `<button class="btn sm ghost" data-act="setfirst" data-id="${g.id}">設第一優先</button>`}<button class="btn sm danger" data-act="undo" data-id="${g.id}">撤回</button></div>`}</li>`).join("") : `<li class="empty">還沒有人報到。</li>`;

  // 介紹台（四頁簽）
  curPending = pendingAll.map(g => g.id);
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
      ? tabItems.slice(pStart, pStart + P_SIZE).map((g, i) => `<li class="prow" data-id="${g.id}"><button class="handle" data-handle data-id="${g.id}" aria-label="拖曳或用上下鍵調整 ${esc(g.name || g.title)} 的順序">⋮⋮</button><button class="card${g.first ? " isfirst" : ""}${fresh.has(g.id) ? " fresh" : ""}" data-act="intro" data-id="${g.id}"><span class="ord">${pStart + i + 1}</span><span class="line"><small>${esc(g.title)}</small>${esc(g.name)}</span><span class="meta">${g.first ? `<span class="first">第一優先</span>` : ""}${g.selfReported || g.source === "self" ? `<span class="self">自助</span>` : ""}${catPill(g.cat)}${fmt(g.arrivedAt)} 到場</span></button></li>`).join("")
      : `<li class="empty">${!loaded ? "讀取中…" : otherPend.length ? `「${esc(stageTab)}」目前沒有待介紹；其他頁簽：${otherPend.join("、")}。` : "目前沒有待介紹的來賓。接待老師報到後會即時出現在這裡。"}</li>`;
    $("#pendPager").innerHTML = pager("p", pPage, pPages, tabItems.length, tabItems.slice(0, pStart).some(g => g.first));
  }
  $("#donePager").innerHTML = pager("d", dPage, dPages, done.length, false);
  $("#doneList").innerHTML = done.length ? done.slice(dStart, dStart + D_SIZE).map(g => `<li class="dcard"><span class="ord">✓</span><span class="dinfo"><span class="line">${esc(who(g))}</span><span class="meta">${fmt(g.introducedAt)} 介紹</span></span><button class="btn sm ghost" data-act="back" data-id="${g.id}">↩ 送回待介紹</button></li>`).join("") : `<li class="empty">尚無</li>`;

  // 名單與 QR
  $("#cfgPanel").hidden = !isAdmin; $("#staffPanel").hidden = !isAdmin || isOwner;
  $("#sysTab").hidden = !isOwner;
  renderSystem();
  document.querySelectorAll(".admin-only").forEach(el => el.hidden = !isAdmin);
  document.querySelector(".admin-note").hidden = isAdmin;
  const total = guests.length, arr = guests.filter(g => g.status === "arrived" || g.status === "introduced").length;
  $("#countLine").textContent = total ? `共 ${total} 位・已報到 ${arr} 位` : "";
  const all = [...guests].sort((a, b) => catRank(a.cat) - catRank(b.cat) || (a.createdAt || 0) - (b.createdAt || 0));
  $("#allList").innerHTML = all.length ? all.map(g => `<li><span>${catPill(g.cat)} ${esc(who(g))}${g.status === "review" ? ` <span class="self">待確認</span>` : g.status !== "expected" ? ` <span class="hint">已報到</span>` : ""}</span>${isAdmin ? `<span data-delbox="${g.id}"><button class="btn sm danger" data-act="askdel" data-id="${g.id}">刪除</button></span>` : ""}</li>`).join("") : `<li class="empty" style="background:none">名單是空的</li>`;
  if (!$("#clearBox").dataset.asking) $("#clearBox").innerHTML = isAdmin && total ? `<button class="btn sm danger" data-act="askclear">清空全部名單（換下一場活動時用）</button>` : "";
  renderStaff();
  drawQRs();
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
async function setGuest(id, patch, msg) {
  try { await updateDoc(gref(id), patch); if (msg) toast(msg); }
  catch (e) { toast(e && e.code === "permission-denied" ? "沒有權限，請請管理者把你加入工作人員" : "更新失敗，請再試一次"); }
}
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
  if (act === "arrive" && g) { b.disabled = true; const f = b.dataset.first === "1"; await setGuest(id, { status: "arrived", rank: null, first: f, arrivedAt: Date.now(), reporterName: me.displayName || me.email }, `${g.name || g.title} 已報到${f ? "（第一優先）" : ""}`); return; }
  if (act === "setfirst") { await setGuest(id, { first: true, rank: null }, "已設為第一優先"); return; }
  if (act === "unfirst") { await setGuest(id, { first: false, rank: null }, "已取消優先"); return; }
  if (act === "intro") { await setGuest(id, { status: "introduced", introducedAt: Date.now() }); return; }
  if (act === "back") { b.disabled = true; await setGuest(id, { status: "arrived", rank: null, introducedAt: null }, `${g ? g.name || g.title : ""} 已送回待介紹`); return; }
  if (act === "undo" && g) {
    if (g.source === "walkin" || g.source === "self") { try { await deleteDoc(gref(id)); toast("已撤回"); } catch (err) { toast("撤回失敗"); } }
    else await setGuest(id, { status: "expected", first: false, rank: null, arrivedAt: null, reporterName: null, selfReported: false }, "已撤回，回到預約名單");
    return;
  }
  if (act === "askdel") { document.querySelector(`[data-delbox="${id}"]`).innerHTML = `<span class="confirm">確定？<button class="btn sm danger" data-act="del" data-id="${id}">刪除</button><button class="btn sm ghost" data-act="nodel">取消</button></span>`; return; }
  if (act === "nodel") { render(); return; }
  if (act === "del") { try { await deleteDoc(gref(id)); toast("已刪除"); } catch (err) { toast("刪除失敗"); } return; }
  if (act === "askclear") { const box = $("#clearBox"); box.dataset.asking = "1"; box.innerHTML = `確定清空全部 ${guests.length} 位來賓？無法復原。<button class="btn sm danger" data-act="doclear">清空</button><button class="btn sm ghost" data-act="noclear">取消</button>`; return; }
  if (act === "noclear") { delete $("#clearBox").dataset.asking; render(); return; }
  if (act === "doclear") { b.disabled = true; try { await batchWrite(guests.map(x => ({ type: "delete", id: x.id }))); toast("已清空名單"); } catch (err) { toast("清空失敗，需要管理者權限"); } delete $("#clearBox").dataset.asking; render(); return; }
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
  const cat = (document.querySelector("input[name=wcat]:checked") || {}).value || CATS[1], now = Date.now();
  try {
    await setDoc(gref(newId()), { title, name, cat, first: walkFirst === "1", status: "arrived", arrivedAt: now, createdAt: now, source: "walkin", reporterName: me.displayName || me.email });
    toast(`${name || title} 已報到${walkFirst === "1" ? "（第一優先）" : ""}`);
    $("#w-title").value = ""; $("#w-name").value = ""; $("#w-title").focus();
  } catch (ex) { err.textContent = ex && ex.code === "permission-denied" ? "沒有權限，請請管理者把你加入工作人員。" : "送出失敗，請再試一次。"; err.hidden = false; }
});

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
const nameKey = s => (s || "").replace(/\s/g, "");
function matchOf(g, name) {
  const nm = nameKey(name ?? g.name); if (!nm) return null;
  const c = guests.filter(x => x.status === "expected" && nameKey(x.name) === nm);
  return c.length === 1 ? c[0] : null;
}
function renderReview() {
  const list = guests.filter(g => g.status === "review").sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const rb = $("#reviewBadge"); rb.hidden = !list.length; rb.textContent = list.length;
  $("#reviewPanel").hidden = !list.length;
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
  try {
    await runTransaction(db, async tx => {
      const sd = await tx.get(gref(id)); if (!sd.exists() || sd.data().status !== "review") throw new Error("gone");
      if (m) {
        const ed = await tx.get(gref(m.id));
        if (ed.exists() && ed.data().status === "expected") {
          tx.update(gref(m.id), { status: "arrived", arrivedAt: sd.data().arrivedAt || now, first, rank: null, selfReported: true, reporterName: "自助報到・" + by });
          tx.delete(gref(id)); return;
        }
      }
      tx.update(gref(id), { title, name, cat, first, status: "arrived", rank: null, reporterName: "自助報到・" + by });
    });
    reviewKey = ""; toast(`${name || title} 已確認${first ? "（第一優先）" : ""}`);
  } catch (e) { toast(e && e.message === "gone" ? "這筆已被其他老師處理" : "確認失敗，請再試一次"); reviewKey = ""; render(); }
}

// ---------- 登入與資料連線 ----------
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; guests = []; requests = []; loaded = false; prevStatus = new Map(); }

function startListeners() {
  setStatus("連線中…");
  const timer = setTimeout(() => setStatus("資料暫時連不上，畫面可能不是最新。", true), 10000);
  unsubs.push(onSnapshot(query(collection(db, "guests"), orderBy("createdAt", "asc"), limit(2000)), snap => {
    clearTimeout(timer); setStatus(snap.metadata.fromCache ? "離線中，畫面可能不是最新" : "即時連線中・自動更新", snap.metadata.fromCache);
    guests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (loaded) {
      let n = false, urgent = null;
      for (const g of guests) {
        const p = prevStatus.get(g.id);
        if (g.status === "arrived" && p !== "arrived" && p !== "introduced") {
          fresh.add(g.id); n = true; if (g.first) urgent = g;
          const id = g.id; setTimeout(() => { fresh.delete(id); render(); }, 6000);
        }
      }
      if (urgent) { stageTab = grpOf(urgent); pPage = 0; }
      const newReview = guests.some(g => g.status === "review" && prevStatus.get(g.id) === undefined);
      if (newReview) toast("有新的自助報到等待確認");
      if (n || newReview) ding(!!urgent);
    }
    prevStatus = new Map(guests.map(g => [g.id, g.status])); loaded = true;
    render();
  }, e => { clearTimeout(timer); setStatus(e.code === "permission-denied" ? "你的帳號沒有權限讀取名單。" : "連線中斷，請重新整理頁面。", true); }));
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
