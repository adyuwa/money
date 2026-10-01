# 台股智慧分析平台 — 網頁版（GitHub Pages）

純靜態網頁版，無需本地伺服器。透過 **Cloudflare Worker** 作為 API proxy，可直接部署至 GitHub Pages。

---

## 架構說明

```
瀏覽器（GitHub Pages）
    ↓  所有 /api/* 請求
Cloudflare Worker（免費 Proxy）
    ↓  依路由分發
Yahoo Finance API  ←  即時行情、歷史K線、EPS
TWSE OpenAPI       ←  基本面（本益比、殖利率）
FinMind API        ←  ETF 成分股
Google News RSS    ←  新聞
```

---

## 部署步驟

### 第一步：部署 Cloudflare Worker（必須先做）

1. 前往 [https://workers.cloudflare.com](https://workers.cloudflare.com) 免費註冊
2. 點選 **Create a Worker**
3. 將 `worker/index.js` 的全部內容貼入編輯器
4. 點選 **Deploy**
5. 記下你的 Worker URL，格式為：
   ```
   https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev
   ```

> **免費方案限制**：每天 100,000 次請求，日常使用完全足夠。

---

### 第二步：設定 Proxy URL

開啟 `網頁版/app.js`，找到第 17 行（檔案最頂部），將 `YOUR-WORKER` 替換為你的實際 Worker URL：

```js
// 修改前
const PROXY_BASE = 'https://YOUR-WORKER.workers.dev';

// 修改後（範例）
const PROXY_BASE = 'https://twstock-proxy.myname.workers.dev';
```

---

### 第三步：部署至 GitHub Pages

#### 方法 A：從 GitHub 倉庫部署（推薦）

1. 在 GitHub 建立新的 public repository
2. 將 `網頁版/` 資料夾內的所有檔案上傳到 repository **根目錄**：
   ```
   repository 根目錄/
   ├── index.html
   ├── app.js        ← 已修改 PROXY_BASE 的版本
   ├── style.css
   └── worker/
       └── index.js  （可保留作備份，不影響網頁運作）
   ```
3. 前往 repository **Settings → Pages**
4. Source 選擇 **Deploy from a branch**
5. Branch 選 `main`，目錄選 `/ (root)`
6. 點 **Save**，等候約 1 分鐘後即可透過以下網址存取：
   ```
   https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/
   ```

#### 方法 B：直接開啟本地檔案

修改 `PROXY_BASE` 後，直接用瀏覽器開啟 `index.html` 即可使用（不需要任何伺服器）。

---

## 檔案說明

| 檔案 | 說明 |
|------|------|
| `index.html` | 主頁面（與原版相同） |
| `app.js` | 前端邏輯（所有 API 呼叫改指向 `PROXY_BASE`） |
| `style.css` | 樣式（與原版相同） |
| `worker/index.js` | Cloudflare Worker 原始碼 |

---

## 與原版差異

| 項目 | 原版（本地） | 網頁版 |
|------|------------|--------|
| 需要 Python 環境 | ✅ 需要 | ❌ 不需要 |
| 需要執行 server.ps1 | ✅ 需要 | ❌ 不需要 |
| 可部署到 GitHub Pages | ❌ 不行 | ✅ 可以 |
| 資料來源 | Yahoo Finance（via Python） | Yahoo Finance（via Cloudflare Worker） |
| API 功能 | 完全相同 | 完全相同 |

---

## 注意事項

- **台灣股市顏色慣例**：漲 = 🔴 紅色，跌 = 🟢 綠色（與一般 Web 相反）
- Cloudflare Worker 免費方案每天上限 10 萬次請求；若超量可升級付費方案（約 $5/月）
- Yahoo Finance API 不保證永久可用，若行情資料異常請檢查 Worker 日誌
- FinMind ETF 成分股 API 若需高頻使用，建議申請 FinMind token 並填入 `worker/index.js` 第 220 行的 `token=` 後面
