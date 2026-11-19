// Firebase 初始化（網站兩個頁面共用）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithCredential, signInAnonymously,
  onAuthStateChanged, signOut, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, googleClientId } from "./config.js";

export const configured = !String(firebaseConfig.apiKey || "").startsWith("請貼上");
export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

// LINE、Facebook、Instagram、Messenger、微信等 App 的內建瀏覽器：Google 不允許在裡面登入
export function inAppBrowser() {
  const ua = navigator.userAgent || "";
  if (/\bLine\//i.test(ua)) return "LINE";
  if (/FBAN|FBAV|FB_IAB|Messenger/i.test(ua)) return "Facebook";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/MicroMessenger/i.test(ua)) return "微信";
  return "";
}
// LINE 支援在網址加 openExternalBrowser=1，自動改用手機預設瀏覽器開啟
export function openInLineExternal() {
  const u = new URL(location.href);
  if (u.searchParams.get("openExternalBrowser") === "1") return false;
  u.searchParams.set("openExternalBrowser", "1");
  location.replace(u.toString());
  return true;
}

// iPhone／iPad／Android 與 Safari 會把不同網站的資料隔開，Firebase 內建的 Google 登入要經過
// liyu-guest.firebaseapp.com 中轉，在這些裝置會出現「missing initial state」而失敗。
// 這些裝置改用 Google 官方的 Sign in with Google（GIS）直接取得授權，再交給 Firebase。
function needsGis() {
  const ua = navigator.userAgent || "";
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(ua);
  return apple || safari || /Android/.test(ua);
}
let gisLoading = null;
export function preloadGoogle() {
  if (!googleClientId || !needsGis()) return null;
  return gisLoading ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = ok; s.onerror = () => { gisLoading = null; no(new Error("gis-load")); };
    document.head.appendChild(s);
  });
}
function gisLogin() {
  return new Promise((ok, no) => {
    const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; no(e); };
    // 必須在按鈕點擊當下同步開啟視窗，否則會被當成廣告視窗擋掉
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: "openid email profile",
      prompt: "select_account",
      callback: async r => {
        if (!r || r.error || !r.access_token) return fail("gis/" + ((r && r.error) || "no-token"));
        try { ok(await signInWithCredential(auth, GoogleAuthProvider.credential(null, r.access_token))); }
        catch (e) { no(e); }
      },
      error_callback: err => {
        const t = err && err.type;
        fail(t === "popup_closed" ? "auth/popup-closed-by-user" : t === "popup_failed_to_open" ? "auth/popup-blocked" : "gis/" + (t || "unknown"));
      }
    });
    tc.requestAccessToken();
  });
}

export function googleLogin() {
  const inApp = inAppBrowser();
  if (inApp === "LINE" && openInLineExternal()) return Promise.resolve(null);
  if (inApp) { const e = new Error("in-app"); e.code = "app/in-app-browser"; e.app = inApp; return Promise.reject(e); }
  if (needsGis() && googleClientId) {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return gisLogin();
    // Google 登入元件還沒載入完成（網路慢）：請使用者稍候再按一次
    preloadGoogle();
    const e = new Error("gis-not-ready"); e.code = "app/gis-not-ready"; return Promise.reject(e);
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

export {
  signInAnonymously, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch, runTransaction
};
