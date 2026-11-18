// 共用小工具
export const $ = s => document.querySelector(s);
export const pad = n => String(n).padStart(2, "0");
export const fmt = ms => { if (!ms) return ""; const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

export function toast(m) {
  const t = $("#toast"); if (!t) return;
  t.textContent = m; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600);
}

export function startClock(el) {
  const tick = () => {
    const d = new Date();
    el.textContent = `${d.getFullYear() - 1911}年${d.getMonth() + 1}月${d.getDate()}日（${"日一二三四五六"[d.getDay()]}） ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  tick(); setInterval(tick, 15000);
}

// 網站所在的資料夾網址（GitHub Pages 與 Vercel 都適用）
export function siteBase() {
  const u = new URL(location.href);
  u.hash = ""; u.search = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.toString();
}

// 用 qrcode-generator（index.html / checkin.html 以 <script> 載入）畫 QR
export function qrCanvas(cv, text, px) {
  if (typeof window.qrcode !== "function") return false;
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 2, s = Math.max(2, Math.floor(px / (n + m * 2)));
  cv.width = cv.height = s * (n + m * 2);
  const c = cv.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height); c.fillStyle = "#111";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) c.fillRect((k + m) * s, (r + m) * s, s, s);
  return true;
}

export function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
