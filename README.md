# OpenCode Next Steps

OpenCode V2 的 TUI 與 Desktop 外掛：在目前對話完成後，優先產生三則不同面向的下一步建議，選取時只填入草稿，不自動送出或執行。

本 repo 自既有的 `~/.config/opencode/plugins/next-steps` 獨立整理而來，保留原始實作與測試。TUI 與 Desktop 共用建議提示與安全解析，分別使用各介面的草稿 API。

## 操作

### 終端機 TUI

- `Tab`：填入第一則建議，繼續按可輪流切換。
- 輸入框空白時按 `1`、`2`、`3`：填入對應建議；也可點擊建議。
- 輸入框空白時按 `0`：關閉建議。
- 自行修改草稿後，停止替換；清空草稿後可重新選取。
- 沒自動出現時，可開命令面板執行「Generate next-step suggestions」手動觸發（只略過最小字數門檻，其餘規則不變）。
- 手動觸發會另開獨立面板（session panel，參考 openspec-board 做法），顯示產生進度與三則建議，點選填入草稿；自動生成仍只顯示在輸入框上方，不彈面板。

### 桌面版 GUI（OpenCode Desktop 2.2.0）

- 輸入框上方顯示「下一步 · 3 個方向」，點開可查看建議與完整提問。
- 點選建議只填入草稿並聚焦輸入框；可以接著編輯，或重新選擇其他建議。
- 手動修改後不覆寫；清空輸入框後可重新選取。選單中的「關閉建議」會移除本回合建議。
- 切換 session、開始新回合、開始輸入或外掛卸載時，取消尚未完成的生成並忽略晚到結果。
- 使用官方 `ComposerPill` 與 composer API，不讀寫頁面 DOM，也不註冊會干擾一般輸入的數字鍵。

只在目前 session 閒置、主輸入框空白且回答正常完成時請求建議。開始打字或新回合時會取消尚未完成的生成；簡短回答預設不生成建議。

建議依對話選擇不同目的、可獨立選擇的方向，例如推進工作、深入理解或檢視風險；不是同一件事的改寫，也不是必須依序執行的三個步驟，不固定套用分類。標籤會點出面向與具體內容。

建議透過 OpenCode 的 `session.generate` 額外呼叫模型，可能增加 token 用量與費用。面向差異由生成提示引導，未以程式判定語意。只有不足三個有用面向時才減少則數；任務結束或沒有實用下一步時可回傳空清單，不為湊數延伸新需求，也不保證每回合都有建議。

## 從此 repo 載入

### 快速安裝（免 npm 發布）

```sh
opencode plugin add github:FocacciaSyin/Opencode-next-steps
```

此 repo 已將 `dist/gui-experimental.cjs` 預建並提交，且避開 `build` 腳本名稱觸發的 Git 安裝問題（`git dep preparation failed`），TUI 與 Desktop 可一次啟用。之後 `opencode plugin check` / `opencode plugin update` 可檢查更新。

TUI 不需要編譯；Desktop 使用官方實驗性 GUI API，必須先建置單檔 CommonJS 入口。OpenCode 執行時提供外掛及 UI 相依套件。

### 同時啟用 Desktop 與 TUI

在此 repo 執行：

```sh
npm ci --legacy-peer-deps
npm run build:gui
```

若 npm 阻擋 esbuild 的安裝腳本，建置時因而找不到原生執行檔，可執行 `node node_modules/esbuild/install.js` 補齊，再重新建置；不需允許所有套件的安裝腳本。

將以下路徑加入全域 `~/.config/opencode/opencode.json(c)` 的既有 `plugins` 陣列，保留其他設定。若 `cli.json` 已列出同一套件，移除該項，避免重複載入 TUI；不要移除其他 CLI 外掛。

```json
{
  "plugins": ["file:///D:/Github/opencode-next-steps"]
}
```

GUI 的 `./gui-experimental` 指向 `dist/gui-experimental.cjs`，修改 GUI 原始碼後需重新執行 `npm run build:gui` 並提交該 bundle；Desktop 會監看本機 bundle 並重新載入。只改 `cli.json` 不會啟用 Desktop 外掛。

### 只啟用 TUI

先將舊的 `~/.config/opencode/plugins/next-steps` 備份到 **plugins 目錄之外**，避免相同外掛重複載入，再將以下項目加入 `~/.config/opencode/cli.json` 的既有 `plugins` 陣列，保留其他設定與外掛：

```json
{
  "plugins": ["file:///D:/Github/opencode-next-steps"]
}
```

OpenCode 會監看設定變更；必要時在 TUI 執行 `/reload`。

兩種載入方式都可用物件形式傳入現有選項：

```json
{
  "plugins": [
    {
      "package": "file:///D:/Github/opencode-next-steps",
      "options": {
        "minAnswerChars": 80,
        "suggestSkills": true
      }
    }
  ]
}
```

`minAnswerChars` 是觸發建議的最小回答字元數；`suggestSkills: false` 不將可用指令與 skills 清單提供給建議模型。上述兩種設定擇一，不要同時加入同一路徑。

## 開發與驗證

使用 Node.js 22.12 以上。邏輯測試不需先安裝套件；打包預檢會先建置 GUI，需先安裝開發相依套件：

```sh
npm test
npm ci --legacy-peer-deps
npm run build:gui
npm pack --dry-run
```

- `tui.tsx`：UI、快捷鍵、輸入框提示與清理。
- `suggestions.js`：共用建議提示與解析，以及 TUI 的生成、取消與草稿保護。
- `gui.ts`：Desktop 的建議選單與生命週期。
- `gui-suggestions.js`：Desktop 的生成、取消、session／server 隔離與草稿保護。
- `*.test.js`：兩種介面的解析、安全保護與回合行為測試。

測試使用模擬的 OpenCode context，不呼叫真實模型，也不涵蓋實際介面渲染。TUI 輸入框辨識依賴 OpenCode 編輯器的 traits；Desktop GUI API 仍屬實驗性。升級 OpenCode 後需再確認相容性。每個開啟中的介面獨立生成建議，同時開啟同一 session 可能增加模型呼叫。

## 授權與來源

沿用原有 Apache-2.0 授權，詳見 [LICENSE](LICENSE)。文字清理與建議解析改寫自 [Anthropic next-steps](https://github.com/anthropics/claude-plugins-community/tree/main/next-steps)，來源及修改說明保留於 `suggestions.js` 檔頭。

外掛載入方式依 [OpenCode V2 CLI plugins](https://opencode.ai/v2/docs/cli/plugins)、[CLI plugin development](https://opencode.ai/v2/docs/build/plugins/cli) 與 [GUI plugin development](https://opencode.ai/v2/docs/build/plugins/gui)。
