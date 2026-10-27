# OpenCode Next Steps

OpenCode V2 的 CLI 外掛：在目前對話完成後，產生最多三則下一步建議，選取時只填入草稿，不自動送出或執行。

本 repo 自既有的 `~/.config/opencode/plugins/next-steps` 獨立整理而來，保留原始實作與測試。建立 repo 不會變更目前 OpenCode 的外掛設定；目前仍由原位置載入，修改本 repo 不會自動同步至該位置。

## 操作

- `Tab`：填入第一則建議，繼續按可輪流切換。
- 輸入框空白時按 `1`、`2`、`3`：填入對應建議；也可點擊建議。
- 輸入框空白時按 `0`：關閉建議。
- 自行修改草稿後，停止替換；清空草稿後可重新選取。

只在目前 session 閒置、主輸入框空白且回答正常完成時請求建議。開始打字或新回合時會取消尚未完成的生成；簡短回答預設不生成建議。

建議透過 OpenCode 的 `session.generate` 額外呼叫模型，可能增加 token 用量與費用。模型可回傳空清單，不保證每回合都有建議。

## 從此 repo 載入

這是 CLI-only 外掛，不需要 server 入口或編譯步驟。OpenCode 執行時提供外掛及 UI 相依套件。

若要改由此 repo 載入，先將舊的 `~/.config/opencode/plugins/next-steps` 備份到 **plugins 目錄之外**，避免相同外掛重複載入，再將以下項目加入 `~/.config/opencode/cli.json` 的既有 `plugins` 陣列，保留其他設定與外掛：

```json
{
  "plugins": ["file:///D:/Github/opencode-next-steps"]
}
```

OpenCode 會監看設定變更；必要時在 TUI 執行 `/reload`。

可用物件形式傳入現有選項：

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

使用 Node.js 22 以上，不需先安裝套件即可執行既有邏輯測試：

```sh
npm test
npm pack --dry-run
```

- `tui.tsx`：UI、快捷鍵、輸入框提示與清理。
- `suggestions.js`：建議解析、生成、取消與草稿保護。
- `suggestions.test.js`：既有的解析、安全保護與回合行為測試。

測試使用模擬的 OpenCode context，不呼叫真實模型，也不涵蓋實際 TUI 渲染。輸入框辨識依賴 OpenCode 編輯器的 traits；升級 OpenCode 後需再確認相容性。

## 授權與來源

沿用原有 Apache-2.0 授權，詳見 [LICENSE](LICENSE)。文字清理與建議解析改寫自 [Anthropic next-steps](https://github.com/anthropics/claude-plugins-community/tree/main/next-steps)，來源及修改說明保留於 `suggestions.js` 檔頭。

外掛載入方式依 [OpenCode V2 CLI plugins](https://opencode.ai/v2/docs/cli/plugins) 與 [CLI plugin development](https://opencode.ai/v2/docs/build/plugins/cli)。
