// ============================================================
//  學校設定：換一所學校使用時，只需要改這個檔案
// ============================================================

// 1. Firebase 設定
//    到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → 「SDK 設定和配置」
//    選「設定」(Config)，把整段貼過來取代下面的內容。
//    這些值本來就會出現在網頁原始碼裡，放到 GitHub 是正常的；
//    資料安全由 firestore.rules 控管。
export const firebaseConfig = {
  apiKey: "AIzaSyBM8mIAVjryNbD_ELOaiSv-NROdILau2ds",
  authDomain: "liyu-guest.firebaseapp.com",
  projectId: "liyu-guest",
  storageBucket: "liyu-guest.firebasestorage.app",
  messagingSenderId: "150463961873",
  appId: "1:150463961873:web:eb28ed05e372d085218ab0"
};

// 1-1. Google 登入用戶端 ID（手機、平板、Safari 登入用）
//      Google Cloud 主控台 → API 和服務 → 憑證 → OAuth 2.0 用戶端 ID →
//      「Web client (auto created by Google Service)」的用戶端 ID。
//      並在同一頁的「已授權的 JavaScript 來源」加入網站網址（例：https://你的帳號.github.io）。
export const googleClientId = "150463961873-gsin6sbaap1u6t4h70vjhumhmqerqu2r.apps.googleusercontent.com";

// 2. 學校與活動名稱（活動名稱之後也能在網站的「名單與 QR」頁修改）
export const SCHOOL = {
  name: "南投縣鯉魚國小",
  defaultEvent: "115鯉魚市集"
};

// 3. 來賓身分，順序就是介紹台的預設優先順序（第一個最優先）
export const CATS = ["長官", "貴賓", "家長", "其他"];
