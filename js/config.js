// ============================================================
//  學校設定：換一所學校使用時，只需要改這個檔案
// ============================================================

// 1. Firebase 設定
//    到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → 「SDK 設定和配置」
//    選「設定」(Config)，把整段貼過來取代下面的內容。
//    這些值本來就會出現在網頁原始碼裡，放到 GitHub 是正常的；
//    資料安全由 firestore.rules 控管。
export const firebaseConfig = {
  apiKey: "請貼上你的 apiKey",
  authDomain: "你的專案.firebaseapp.com",
  projectId: "你的專案",
  storageBucket: "你的專案.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000"
};

// 2. 學校與活動名稱（活動名稱之後也能在網站的「名單與 QR」頁修改）
export const SCHOOL = {
  name: "南投縣鯉魚國小",
  defaultEvent: "115鯉魚市集"
};

// 3. 來賓身分，順序就是介紹台的預設優先順序（第一個最優先）
export const CATS = ["長官", "貴賓", "家長", "其他"];
