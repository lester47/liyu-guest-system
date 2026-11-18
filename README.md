# 鯉魚國小來賓通報系統

南投縣鯉魚國小活動（例如「115鯉魚市集」）使用的來賓報到與介紹系統。接待老師一按，司儀和校長馬上在介紹台看到來賓，並依優先順序排好。

網站本體是純靜態網頁，可以同時放在 **GitHub Pages** 和 **Vercel**；資料存在 **Firebase**（免費方案即可）。

## 功能

| 頁面 | 給誰用 | 做什麼 |
|---|---|---|
| 首頁 `index.html` | 所有人 | 顯示「來賓自助報到」QR Code；工作人員從這裡用 Google 帳號登入 |
| 來賓自助報到 `checkin.html` | 來賓 | 不用登入，填頭銜、姓名、身分即完成報到；也可放在門口平板 |
| 接待報到 | 接待老師 | 掃來賓 QR 一鍵報到、搜尋預約名單（長官／貴賓／家長／其他四個頁簽）、臨時來賓、設定第一優先、撤回 |
| 介紹台 | 司儀、校長 | 待介紹分四個頁簽，依「第一優先 → 身分 → 到場先後」排序；可拖曳調整順位、分頁；點卡片移到已介紹，按錯可送回 |
| 名單與 QR | 工作人員／管理者 | 匯入 Excel／CSV、手動貼上名單、產生並下載來賓 QR 總表、活動設定、管理工作人員帳號 |

來賓自助報到時，如果姓名和預約名單中某一位相同，系統會自動合併成同一筆。

---

## 第一次設定（約 20 分鐘）

### 步驟 1：建立 Firebase 專案

1. 到 <https://console.firebase.google.com/>，用學校的 Google 帳號登入，按「建立專案」，名稱例如 `liyu-guest`。Google Analytics 可以關掉。
2. 專案建好後，在首頁按 **`</>`（網頁）** 新增應用程式，暱稱隨意，**不用**勾 Firebase Hosting。
3. 畫面會出現一段 `const firebaseConfig = { ... }`，把大括號裡的內容複製下來，貼到本專案的 **`js/config.js`**，取代裡面的範例值。

### 步驟 2：開啟登入方式

Firebase 主控台左側 →「Authentication」→「開始使用」→「Sign-in method」：

- 開啟 **Google**（支援電子郵件選你的帳號）
- 開啟 **匿名**（Anonymous）：來賓自助報到要用

### 步驟 3：建立資料庫並貼上安全規則

1. 左側「Firestore Database」→「建立資料庫」→ 位置選 **`asia-east1`（台灣）** →「以正式版模式啟動」。
2. 切到「規則」分頁，把本專案 **`firestore.rules`** 的全部內容貼上，按「發布」。

### 步驟 4：放到 GitHub，開啟 GitHub Pages

1. 在 GitHub 建立一個新的 repository（例如 `liyu-guest-system`），把本資料夾的所有檔案上傳（包含 `.github` 資料夾）。
2. repository 的「Settings」→「Pages」→「Build and deployment」→ Source 選 **GitHub Actions**。
3. 到「Actions」分頁等「部署到 GitHub Pages」跑完（約 1 分鐘），網址會是  
   `https://你的帳號.github.io/liyu-guest-system/`

### 步驟 5：同步到 Vercel

1. 到 <https://vercel.com/>，用 GitHub 帳號登入 →「Add New… → Project」→ 選剛剛的 repository →「Import」。
2. Framework Preset 選 **Other**，Build Command 和 Output Directory 都留空 →「Deploy」。
3. 之後每次推送到 GitHub 的 `main` 分支，**GitHub Pages 和 Vercel 會同時自動更新**，兩個網址內容永遠一致。

### 步驟 6：把網址加入 Firebase 授權網域（很重要）

Firebase 主控台 →「Authentication」→「設定」→「已授權的網域」→「新增網域」，把兩個網址的網域都加進去：

- `你的帳號.github.io`
- `你的專案.vercel.app`（若有自訂網域也要加）

沒加的話，按「以 Google 帳號登入」會出現「未授權的網域」。

### 步驟 7：第一次登入，設定工作人員

1. 打開網站，按「以 Google 帳號登入」。**第一個登入的人會自動成為管理者**，所以請負責的老師先登入。
2. 到「名單與 QR」→「工作人員帳號」，輸入接待老師、司儀、校長的 Google 帳號，按「加為工作人員」。
3. 他們登入後就能使用接待報到與介紹台。不在名單上的帳號登入後只會看到首頁。

---

## 活動當天怎麼用

1. **活動前**：在「名單與 QR」匯入預約名單（可按「下載範本」照格式填，或用 Google 表單收集後下載成 Excel），下載 QR 總表印在邀請卡或名牌上；首頁的自助報到 QR 印出來貼在入口。
2. **接待桌**：老師用手機掃來賓的 QR，按「報到」或「第一優先」；沒有 QR 的來賓用「臨時來賓」通報。
3. **來賓自己來**：掃入口的自助報到 QR 填寫，或在門口平板打開 `checkin.html` 填寫。
4. **介紹台**：平板或筆電開「介紹台」，助手依序介紹，介紹完點卡片；要調整順序就拖曳左側 ⋮⋮。
5. **活動後**：管理者在「名單與 QR」按「清空全部名單」，刪除當天的個人資料。

## 換一所學校使用

只要改 `js/config.js` 的學校名稱與 Firebase 設定，並用自己的 Firebase 專案（每所學校的資料彼此獨立）。若修改了來賓身分 `CATS`，`firestore.rules` 裡 `validSelf()` 的身分清單也要一起改。

## 檔案說明

```
index.html            首頁＋工作人員介面
checkin.html          來賓自助報到頁
css/style.css         樣式（含深色模式）
js/config.js          ★ 學校與 Firebase 設定
js/firebase.js        Firebase 初始化
js/app.js             工作人員端程式
js/checkin.js         自助報到程式
js/utils.js           共用工具（QR、時間、下載）
firestore.rules       ★ 資料庫安全規則（貼到 Firebase）
templates/            名單範本（CSV）與範例 Excel
.github/workflows/    GitHub Pages 自動部署
vercel.json           Vercel 設定
```

## 常見問題

- **Firebase 設定放在 GitHub 公開安全嗎？** 可以。`apiKey` 本來就會出現在網頁裡，資料安全靠 `firestore.rules`：只有工作人員名單上的 Google 帳號能讀寫名單，來賓只能新增自己的一筆報到。
- **會不會要錢？** 一場幾百人的活動遠低於 Firebase 免費額度（每天 5 萬次讀取、2 萬次寫入）。GitHub Pages 與 Vercel 個人方案也免費。
- **手機用 LINE 開啟無法登入？** LINE 內建瀏覽器會擋 Google 登入，請點右上角選「用預設瀏覽器開啟」。來賓自助報到不需要登入，不受影響。
- **介紹台一個畫面看得到幾位？** 10 吋平板橫放約 6～7 位，直放約 9～10 位；待介紹每頁 8 位，已介紹每頁 15 位。
