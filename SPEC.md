# F1 2026 賽季戰績總覽 — 規格書（v4・與實作對照版）

> 本文件為 `hw5/` 作業的規格書。v1–v3 為實作前由「需求 → AI 提案 → 使用者回饋 → 修訂」迭代而成；v4 在 M1–M5 實作完成後，依實際成品回頭校對，逐項標示 **已實作 / 調整 / 未實作**，並附需求追溯表與 AI 迭代紀錄。

---

## 0. 變更紀錄（版本迭代）

| 版本 | 觸發 | 主要變更 |
|---|---|---|
| v1 | 使用者初始需求 | 單一 `index.html`、API + JSON 快取；車手積分、車隊積分、各分站全部 session |
| v2 | 使用者回覆待確認事項 | 可放額外檔案；繁中介面；不用圖表庫；新增 **賽道圖、換胎策略、全程位置概覽圖** |
| v3 | 使用者回覆待確認事項 | 不即時更新，**賽後手動抓取**；分站名稱英文；不做圈速比較；移除倒數計時 |
| v3.1 | 使用者指示 | 資源統一放 `hw5/assets/` |
| **v4** | 作業評分標準 | 依實作校對規格、新增驗收條件、需求追溯表、AI 迭代紀錄、已知落差 |
| **v4.1** | 使用者指示（M6） | **響應式移出範圍**；新增 **車手照片**；補上 **分站國旗**；加入 GitHub Pages 部署步驟 |

---

## 1. 專案概述

| 項目 | 內容 |
|---|---|
| 名稱 | F1 2026 Season Dashboard（F1 2026 賽季戰績總覽） |
| 類型 | 資料驅動的單頁式 Web App（SPA），靜態部署於 GitHub Pages |
| 前端 | 單一 `index.html`（CSS / JS 內嵌），原生 HTML・CSS・JS，無框架、無圖表庫 |
| 視覺化 | 全部以原生 SVG / CSS 手刻 |
| 語言 | 繁體中文介面；車手 / 車隊 / 分站名稱用英文 |
| 資料來源 | Jolpica-F1（賽程、積分、正賽、排位、衝刺賽、逐圈名次、進站）、OpenF1（FP1–3、衝刺排位、輪胎、賽道座標、車隊色） |
| 「後端」 | 賽後在本機手動執行 `assets/scripts/fetch.mjs`，產生 `assets/data/*.json` 並 push；前端只讀這些靜態 JSON，**不在瀏覽器呼叫外部 API** |

### 1.1 使用者原始需求（作業需求）
1. 展開 overall **車手**積分
2. 展開 overall **車隊**積分
3. 提供所有分站的 **FP1、FP2、FP3、排位賽、正賽、衝刺賽、衝刺排位賽**
4. （追加）分站選擇時加入 **賽道圖**、各車手 **換胎**、全賽 **位置概覽圖**（x=lap、y=position、P1 最上方、22 條線）

---

## 2. 專案結構（實際）

```
hw5/
├─ index.html                       # 唯一頁面（CSS / JS 內嵌）
├─ SPEC.md                          # 本規格書
└─ assets/
   ├─ scripts/fetch.mjs             # 抓取 + 轉換腳本（Node 22，不被網頁載入）
   ├─ img/
   │  ├─ drivers/{CODE}.png         # 車手大頭照（OpenF1 headshot，由 fetch.mjs 下載）
   │  └─ flags/{iso2}.png           # 各分站所在國國旗（flagcdn.com，由 fetch.mjs 下載）
   └─ data/
      ├─ meta.json                  # lastUpdated、roundsAvailable
      ├─ schedule.json              # 全季賽程與各 session 時間
      ├─ drivers.json               # 車手（姓名、車號、車隊、顏色）、車隊顏色
      ├─ driver_standings.json      # 積分榜 + 每站得分 perRound
      ├─ constructor_standings.json # 車隊積分榜 + 各車手貢獻
      ├─ rounds/{1..17}.json        # 各分站所有 session、逐圈名次、輪胎、進站
      └─ tracks/{circuitId}.json    # 賽道輪廓座標（降採樣約 300 點）
```

---

## 3. 資料層規格

### 3.1 資料來源對應
| 資料 | API | Endpoint |
|---|---|---|
| 賽程 | Jolpica | `/ergast/f1/2026.json` |
| 車手 / 車隊積分 | Jolpica | `/2026/driverstandings`、`/2026/constructorstandings` |
| 正賽 / 排位 / 衝刺賽 | Jolpica | `/2026/{round}/results`、`/qualifying`、`/sprint` |
| 正賽逐圈名次 | Jolpica | `/2026/{round}/laps`（分頁抓取合併） |
| 進站 | Jolpica | `/2026/{round}/pitstops` |
| FP1–3、衝刺排位 | OpenF1 | `/sessions`、`/session_result` |
| 輪胎 stint | OpenF1 | `/stints` |
| 衝刺賽逐圈名次 | OpenF1 | `/laps` + `/position`（Jolpica 無衝刺逐圈資料，由圈結束時間回推） |
| 賽道輪廓 | OpenF1 | `/laps` + `/location`（取冠軍一圈座標，降採樣） |
| 車隊顏色 | OpenF1 | `/drivers` |

### 3.2 抓取腳本行為
- `node assets/scripts/fetch.mjs`：只抓**已結束且尚無檔案**的分站；`--round N` 重抓單站；`--force` 全部重抓。
- 積分榜、賽程、車手資料每次執行都更新。
- 內建節流與重試（OpenF1 約 2.2 秒/請求；遇 HTTP 429 自動退避）。
- 賽道輪廓已存在則不重抓。

### 3.3 `rounds/{n}.json` 結構（實際）
```json
{
  "round": 2, "name": "Chinese Grand Prix", "circuitId": "shanghai", "circuit": "…",
  "country": "China", "locality": "Shanghai", "date": "2026-03-15", "isSprint": true, "totalLaps": 56,
  "sessions": {
    "fp1": [{ "pos":1, "driver":"LEC", "number":16, "team":"Ferrari", "laps":33, "time":"1:20.267", "gap":"" }],
    "sprintQualifying": [{ "pos":1, "driver":"RUS", "q1":"1:33.030", "q2":"…", "q3":"…" }],
    "sprint": [{ "pos":1, "driver":"RUS", "grid":1, "laps":19, "time":"33:38.998", "points":8, "status":"Finished", "fastestLap":{} }],
    "qualifying": [], "race": []
  },
  "lapPositions": { "RUS": [1, 2, 1, "…"] },
  "stints": { "RUS": [{ "stint":1, "compound":"MEDIUM", "start":1, "end":12, "age":0 }] },
  "pitstops": { "RUS": [{ "stop":1, "lap":12, "duration":"17.794" }] },
  "sprintLapPositions": {}, "sprintStints": {}
}
```
`lapPositions[code][0]` = 發車格位（Lap 0）。

---

## 4. 功能規格與驗收條件

> 狀態：✅ 已實作　🔧 與原規格有調整　❌ 未實作

### F1. 車手積分榜（`#drivers`）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 列表 | 名次、**車手照片**、車隊色條、車號、姓名、車隊、勝場、積分、對領先者的積分長條 | ✅ |
| **展開** | 點擊車手展開：大尺寸車手照片、車隊、與領先者分差、單站最高得分、得分站數、各站得分長條圖（hover 顯示站名與分數） | ✅ |
| 排序 | 積分 / 勝場 / 名稱，換排序後展開狀態保留 | ✅ |
| 批次 | 「全部展開 / 收合」 | ✅ |
| 驗收 | 23 位車手各站得分加總 = 積分榜總分（已用腳本核對，0 筆不符） | ✅ |

### F2. 車隊積分榜（`#constructors`）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 列表 | 名次、車隊色條、車隊、旗下車手縮寫、勝場、積分 | ✅ |
| **展開** | 各車手貢獻分數（含車手照片、長條 + 數字）、各站得分堆疊長條圖（兩位車手以同色深淺區分） | ✅ |
| 驗收 | 11 支車隊「車手貢獻加總 = 車隊總分」（已核對，0 筆不符） | ✅ |

### F3. 分站成績（`#rounds`、`#round/{n}/{session}`）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 分站卡片 | 站名、地點・日期、Sprint 標籤、已完賽 / 尚未舉行；未舉行不可點 | ✅ |
| 國旗 | 卡片與分站標題顯示國旗（圖片檔，本機 `assets/img/flags/`） | ✅ |
| Session 分頁 | `FP1｜FP2｜FP3｜衝刺排位｜衝刺賽｜排位賽｜正賽`；非衝刺週末隱藏衝刺分頁；無資料分頁停用；切換不重新載入、網址同步更新 | ✅ |
| 正賽 / 衝刺賽表 | 名次、車手（含小尺寸照片）、車隊、起跑格、進退位、圈數、時間或狀態、得分、最快圈 FL 標記、前三名配色、PL（維修區出發） | ✅ |
| 排位 / 衝刺排位表 | Q1/Q2/Q3，各段最快圈速標示 | ✅ |
| FP 表 | 最快圈、與第一名差距、圈數 | ✅ |
| 賽道資訊 | 圈數、賽道長度 | 🔧 顯示賽道名稱與日期；賽道長度 API 無提供，不顯示 |

### F4. 賽道圖
| 項目 | 規格 | 狀態 |
|---|---|---|
| 位置 | 分站詳情頁右上角卡片 | ✅ |
| 內容 | SVG 賽道輪廓、起終點線、行駛方向箭頭、沿賽道繞行的發光動畫 | ✅ |
| 資料 | 17 個賽道檔，各約 270–560 個座標點 | ✅ |
| 備註 | Y 軸方向已翻轉；各賽道形狀尚未逐一目視比對 | 🔧 待人工確認 |

### F5. 換胎策略（正賽、衝刺賽分頁內）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 圖形 | 每位車手一列，橫軸為圈數，依胎種上色並標字母與圈數；列依完賽名次排序 | ✅ |
| 胎種色 | 軟 `#E8002D`、中 `#FFD12E`、硬 `#F0F0F0`、半雨 `#43B02A`、全雨 `#0067AD`；缺資料 `UNKNOWN` 顯示灰色 | 🔧 新增缺資料灰色 |
| 展開明細 | 點車手列：各 stint 胎種、圈數區間、新舊胎、進站圈與停站秒數 | ✅ |
| 退賽車手 | 長條只畫到最後一圈 | ✅ |
| 結果表點車手跳至換胎 | — | ❌ 取消（換胎圖緊接在結果表下方，已可直接操作） |
| 衝刺賽進站 | — | 🔧 API 無衝刺進站資料，明細顯示 Pit / Finish |

### F6. 全程位置概覽圖（正賽、衝刺賽分頁內）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 座標 | x = 圈數（Grid → 最後一圈）、y = 名次，**P1 在最上方** | ✅ |
| 線條 | 22 條（每位車手一條）、車隊色、同隊第二位車手虛線 | ✅ |
| 退賽 | 線條於最後完成圈結束並標記 ✕；線尾標車手縮寫 | ✅ |
| 互動：參考線 | 滑鼠移動顯示垂直參考線與該圈所有名次 tooltip | ✅ |
| 互動：高亮 | hover 線條或圖例暫時高亮，點線條釘住高亮，其餘淡化 | ✅ |
| 互動：圖例 | 點圖例切換顯示 / 隱藏；Show all / Hide all | 🔧 圖例置於圖下方（原規格為右側） |
| 驗收 | 17 站正賽皆為 22 條線、無缺漏圈；6 站衝刺賽其中 4 站 22 條、2 站 20 條（2 位車手 OpenF1 無資料） | ✅ |

---

### F7. 車手照片與國旗（M6 新增）
| 項目 | 規格 | 狀態 |
|---|---|---|
| 照片來源 | OpenF1 `headshot_url`，由 `fetch.mjs` 下載為本機 PNG（網頁不依賴外部圖片網址） | ✅ |
| 顯示位置 | 車手積分榜（列與展開明細）、車隊展開的車手貢獻、所有 session 成績表 | ✅ |
| 外觀 | 圓形、車隊色外框；展開明細為大尺寸 | ✅ |
| 備援 | 缺照片或載入失敗時顯示車手縮寫圓形佔位 | ✅ |
| 資料缺口 | 22 位車手有照片檔（LIN 為官方預設剪影，TSU 已不在 OpenF1 名單故無照片） | 🔧 資料來源限制 |
| 國旗 | 20 個國家 / 23 站；圖片存 `assets/img/flags/`；新增國家需補 `COUNTRY_ISO` 對照 | ✅ |

---

## 5. UI / UX 規格（實作）
- 深色主題、F1 紅 `#E10600`、字型 Titillium Web、毛玻璃固定頁首。
- 路由（hash）：`#drivers`、`#constructors`、`#rounds`、`#round/{n}/{session}`；不存在的路徑顯示 404。
- 動畫：頁面淡入、展開滑動、積分長條生長、骨架載入、賽道發光；支援 `prefers-reduced-motion`。
- 錯誤處理：JSON 載入失敗顯示錯誤訊息與「重試」按鈕。
- **響應式不在本作業範圍**（使用者指示）：版面以桌面寬度為準；程式中保留少量窄螢幕樣式，不作驗收。
- SEO / 可及性：title 隨頁面更新、meta description、每頁單一 `<h1>`、語意化標籤、互動元件有 id 與 `aria-expanded` / `aria-selected`。
- 頁尾顯示資料更新時間。

---

## 6. 需求追溯表（需求 → 規格 → 實作）

| # | 使用者需求 | 規格 | 實作位置（`index.html`） | 結果 |
|---|---|---|---|---|
| 1 | 展開 overall 車手積分 | F1 | `viewDrivers`、`renderDriverList`、`roundChart` | ✅ |
| 2 | 展開 overall 車隊積分 | F2 | `viewConstructors`、`standingItem`、`roundChart`（堆疊） | ✅ |
| 3a | 所有分站 FP1/FP2/FP3 | F3 | `practiceTable`、`renderSession` | ✅ |
| 3b | 排位賽 | F3 | `qualiTable` | ✅ |
| 3c | 正賽 | F3 | `raceTable` | ✅ |
| 3d | 衝刺賽 | F3 | `raceTable(…, true)` | ✅ |
| 3e | 衝刺排位賽 | F3 | `qualiTable`（`sprintQualifying`） | ✅ |
| 4a | 分站賽道圖 | F4 | `trackCard`、`roundHead` | ✅ |
| 4b | 各車手換胎 | F5 | `stintChart` | ✅ |
| 4c | 全程位置概覽圖（22 條線、P1 最上） | F6 | `positionChart`、`applyChart`、`mousemove` handler | ✅ |
| 4d | 車手照片（追加） | F7 | `avatar`、`drvCell`、`renderDriverList` | ✅ |
| — | 單一 index.html，可含 CSS / JS | §1 | `index.html` 內嵌 `<style>`、`<script>` | ✅ |
| — | API 取資料並存後端（JSON） | §3 | `assets/scripts/fetch.mjs` → `assets/data/*.json` | ✅ |
| — | 部署 GitHub Pages | M6 | — | ⏳ 待做 |

---

## 7. 互動功能一覽（非靜態）

| 位置 | 互動 |
|---|---|
| 導覽列 | 切換三大頁面（hash 路由、無整頁重載） |
| 車手 / 車隊榜 | 展開收合、全部展開、排序、長條圖 hover 提示 |
| 分站列表 | 卡片 hover 動畫、點擊進入分站 |
| 分站詳情 | 7 個 session 分頁就地切換、網址同步（可分享連結） |
| 換胎策略 | 點車手列展開 stint 與進站明細 |
| 位置概覽圖 | 滑鼠參考線 + 名次 tooltip、hover / 點擊高亮、圖例顯示切換、全顯 / 全隱 |
| 全域 | 載入骨架、失敗重試、窄螢幕版面調整 |

---

## 8. AI 迭代紀錄（人機協作歷程）

| 回合 | 使用者回饋 / 指示 | AI 的調整 |
|---|---|---|
| 1 | 提出 F1 戰績 webapp、單檔、API + JSON、三大功能 | 產出 v1：Actions + JSON 架構、資料來源對應、UI 草案；列出 4 個待確認問題（檔案限制、語言、圖表、額外功能） |
| 2 | 允許額外檔案、繁中、不要圖表庫；追加賽道圖、換胎、位置概覽圖 | 產出 v2：新增 F4–F6 規格、`rounds/*.json` 加入逐圈名次與 stint 結構、定下手刻 SVG 方案 |
| 3 | 不需即時更新，賽後抓即可；分站名英文；不做圈速比較 | v3：移除 cron，改手動抓取流程（`--round` / `--force`）；移除倒數計時；範例名稱改英文 |
| 4 | 要求彙整規格書放 `hw5`，資源可放 `hw5/assets` | 規格書搬入 `hw5/SPEC.md`；專案結構改為 `assets/` 下分 `data/`、`scripts/` |
| 5 | 開始 M1 | 先實測兩個 API 的回傳格式再寫腳本；發現 Jolpica 429 限流、OpenF1 部分輪胎缺資料，加入節流 / 重試與 `UNKNOWN` 補值；實際抓回 17 站並以腳本檢核完整性 |
| 6 | M2 | 建立設計系統、hash 路由、資料層快取、骨架載入與重試；分站列表先完整可用 |
| 7 | M3 | 積分榜與展開明細；以腳本驗證「各站得分加總＝積分榜」「車手貢獻加總＝車隊總分」皆一致 |
| 8 | M4 | 各 session 表格；分頁改為就地切換避免畫面閃爍；無資料時自動退回正賽分頁 |
| 9 | M5 | 賽道圖、換胎策略、位置概覽圖；以 Node 腳本用真實資料渲染多個分站，檢查無 `undefined` / `NaN` 且 22 條線齊全 |
| 10 | 作業評分標準（規格清楚、有互動、規格與成品對應、可見 AI 迭代） | v4：逐項標註已實作 / 調整 / 未實作、加入驗收條件、追溯表、互動一覽與本迭代紀錄 |
| 11 | M6：不用做響應式；最好補上車手照片 | 將響應式移出範圍；`fetch.mjs` 新增圖片下載（車手照片、國旗）並寫入 `drivers.json` / `schedule.json`；前端新增 `avatar`、`flagImg`；以 Node 腳本渲染 6 個頁面並確認 0 個缺檔圖片、無 `undefined` / `NaN` |

---

## 9. 已知落差與待辦

| 項目 | 說明 | 預計 |
|---|---|---|
| 賽道方向確認 | 需逐條賽道目視比對是否上下顛倒（Y 軸已依 OpenF1 座標翻轉，但無法在無瀏覽器環境驗證） | 人工確認 |
| 部署 | 專案目前不是 git repo，尚未推上 GitHub Pages（步驟見 §11） | 使用者操作 |
| 瀏覽器實測 | 目前以語法檢查與 Node 渲染驗證，尚缺跨瀏覽器實機測試 | 人工確認 |
| 少量缺資料 | 第 1 站 6 段、第 11 站 1 段輪胎無胎種；第 1 站排位僅 19 位；4 位 / 2 位車手衝刺逐圈資料缺；TSU 無照片 | 資料來源限制 |

---

## 10. 里程碑

| 階段 | 內容 | 狀態 |
|---|---|---|
| M1 | `fetch.mjs`（手動）+ JSON 產出 | ✅ |
| M2 | 骨架、設計系統、路由、資料層 | ✅ |
| M3 | 車手 / 車隊積分與展開 | ✅ |
| M4 | 分站各 session 表格 | ✅ |
| M5 | 賽道圖、換胎策略、位置概覽圖 | ✅ |
| M6 | 國旗、車手照片、規格書校對（響應式已移出範圍） | ✅ |
| 部署 | 推上 GitHub 並啟用 Pages | ⏳ 使用者操作 |

---

## 11. GitHub Pages 部署步驟
1. 在 GitHub 建立 repo，將專案（含 `hw5/`）push 上去。
2. Repo → **Settings → Pages** → Source 選 **Deploy from a branch** → Branch 選 `main`、資料夾 `/ (root)` → Save。
3. 數分鐘後網址為 `https://<帳號>.github.io/<repo>/hw5/`（若 `hw5` 內容放在 repo 根目錄，則為 `https://<帳號>.github.io/<repo>/`）。
4. 所有資源皆使用**相對路徑**（`assets/...`），子資料夾部署不會壞。
5. 之後每站賽後：`node assets/scripts/fetch.mjs` → `git add . && git commit && git push`。
