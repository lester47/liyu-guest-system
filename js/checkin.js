// 來賓自助報到頁：不用 Google 帳號，以匿名身分送出一筆「已到場」資料
import { configured, auth, db, signInAnonymously, doc, setDoc, onSnapshot } from "./firebase.js";
import { $, esc, newId } from "./utils.js";
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
    if (!auth.currentUser) await signInAnonymously(auth);
    const now = Date.now();
    await setDoc(doc(db, "guests", newId()), { title, name, cat, first: false, status: "arrived", source: "self", createdAt: now, arrivedAt: now });
    $("#doneName").textContent = `${title ? title + " " : ""}${name}，報到完成`;
    $("#form").hidden = true; $("#done").hidden = false;
  } catch (ex) {
    showErr(ex && ex.code === "auth/operation-not-allowed" ? "系統尚未開啟訪客報到，請洽接待人員。" : "送出失敗，請確認網路後再試一次，或洽接待人員。");
  } finally { sending = false; btn.disabled = false; btn.textContent = "送出報到"; }
});

$("#again").addEventListener("click", () => {
  $("#form").reset(); $("#form").hidden = false; $("#done").hidden = true;
  const def = document.getElementById("cat1"); if (def) def.checked = true;
  $("#f-title").focus();
});
