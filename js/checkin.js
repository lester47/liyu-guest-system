// 來賓自助報到頁：不用登入，以匿名身分送出一筆「待確認」資料，接待老師確認後才送上介紹台
import { configured, auth, db, signInAnonymously, signOut, doc, setDoc, onSnapshot } from "./firebase.js";
import { $, esc } from "./utils.js";
import { SCHOOL, CATS } from "./config.js";

$("#schoolName").textContent = SCHOOL.name;
$("#f-cat").innerHTML = CATS.map((c, i) => `<input type="radio" name="cat" id="cat${i}" value="${esc(c)}"${i === 1 ? " checked" : ""}><label for="cat${i}">${esc(c)}</label>`).join("");

const showErr = m => { $("#err").textContent = m; $("#err").hidden = false; };

if (!configured) {
  showErr("系統尚未完成設定，請洽接待人員。");
  $("#submitBtn").disabled = true;
} else {
  onSnapshot(doc(db, "settings", "event"), s => {
    const ev = (s.exists() && s.data().event) || SCHOOL.defaultEvent;
    $("#eventSub").textContent = ev + "・來賓報到";
    $("#welcome").textContent = `歡迎蒞臨${ev}，請填寫報到資料`;
    document.title = `來賓報到｜${ev}`;
  }, () => {});
}

let sending = false;
$("#form").addEventListener("submit", async e => {
  e.preventDefault(); if (sending) return;
  $("#err").hidden = true;
  const title = $("#f-title").value.trim(), name = $("#f-name").value.trim();
  if (!name) { showErr("請填寫姓名。"); $("#f-name").focus(); return; }
  const cat = (document.querySelector("input[name=cat]:checked") || {}).value || CATS[1];
  sending = true; const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "送出中…";
  try {
    // 每次匿名登入只能送一筆（安全規則限制），所以送出前一定換一個新的匿名身分
    if (auth.currentUser) await signOut(auth);
    const cred = await signInAnonymously(auth);
    const now = Date.now();
    await setDoc(doc(db, "guests", cred.user.uid), { title, name, cat, first: false, status: "review", source: "self", createdAt: now, arrivedAt: now });
    $("#doneName").textContent = `${title ? title + " " : ""}${name}，已送出報到`;
    $("#form").hidden = true; $("#done").hidden = false;
    watchMine(cred.user.uid);
  } catch (ex) {
    showErr(ex && ex.code === "auth/operation-not-allowed" ? "系統尚未開啟訪客報到，請洽接待人員。" : "送出失敗，請確認網路後再試一次，或洽接待人員。");
  } finally { sending = false; btn.disabled = false; btn.textContent = "送出報到"; }
});

// 送出後保持這個匿名身分，等接待老師確認後在畫面顯示報到序號（安全規則只允許讀自己這一筆）
let unwatch = null;
function showNo(state, no) {
  const box = $("#myNo"); box.hidden = false; box.className = "myno " + state;
  box.innerHTML = state === "ok" ? `<small>您的報到序號</small><b>${String(no).padStart(3, "0")}</b><span>號</span>`
    : state === "wait" ? `<small>報到序號</small><span class="wait">接待人員確認後，會在這裡顯示您的號碼…</span>`
    : `<small>報到序號</small><span class="wait">請洽接待人員</span>`;
}
function watchMine(uid) {
  if (unwatch) unwatch();
  showNo("wait");
  unwatch = onSnapshot(doc(db, "guests", uid), s => {
    if (!s.exists()) { showNo("gone"); return; }
    const d = s.data();
    if (typeof d.no === "number") { showNo("ok", d.no); $("#doneMsg").textContent = "已通知司儀與校長，歡迎您蒞臨。"; }
    else showNo("wait");
  }, () => { $("#myNo").hidden = true; });
}

$("#again").addEventListener("click", () => {
  if (unwatch) { unwatch(); unwatch = null; }
  signOut(auth).catch(() => {});
  $("#myNo").hidden = true; $("#doneMsg").textContent = "接待人員確認後會通知司儀與校長，歡迎您蒞臨。";
  $("#form").reset(); $("#form").hidden = false; $("#done").hidden = true;
  const def = document.getElementById("cat1"); if (def) def.checked = true;
  $("#f-title").focus();
});
