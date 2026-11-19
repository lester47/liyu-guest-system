// Firebase 初始化（網站兩個頁面共用）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously,
  onAuthStateChanged, signOut, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

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

export async function googleLogin() {
  const inApp = inAppBrowser();
  if (inApp === "LINE" && openInLineExternal()) return null;
  if (inApp) { const e = new Error("in-app"); e.code = "app/in-app-browser"; e.app = inApp; throw e; }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // 一律用彈出視窗。整頁跳轉在 iPhone／iPad 的 Safari 與新版 Chrome 會因「跨網站資料隔離」
  // 失敗（Unable to process request due to missing initial state），所以不再改用跳轉。
  return await signInWithPopup(auth, provider);
}

export {
  signInAnonymously, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch, runTransaction
};
