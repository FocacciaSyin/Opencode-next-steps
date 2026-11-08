import assert from "node:assert/strict"
import { test } from "node:test"
import { clean, draftEditor, parseSuggestions, startSuggestions, suggestionHint } from "./suggestions.js"

// 驗證模型輸出會移除不安全文字、未知指令、重複項目，並限制三則。
test("safe suggestions keep only known commands and skills", () => {
  const reply = JSON.stringify([
    { label: "檢查", prompt: "/review repo" },
    { prompt: "/missing" },
    { prompt: "\u001b[31mrun tests\u001b[0m" },
    { prompt: "run tests" },
    { prompt: "hidden\u{E0001}text" },
    { prompt: "@missing task" },
    { prompt: "@check task" },
    { prompt: "extra" },
  ])
  assert.deepEqual(parseSuggestions(`prefix ${reply}`, new Set(["review"]), new Set(["check"])), [
    { label: "檢查", prompt: "/review repo" },
    { label: "run tests", prompt: "run tests" },
    { label: "@check task", prompt: "@check task" },
  ])
  for (const invalid of ["not json", "[broken]", "{}", '[null,{},1,{"prompt":false}]']) {
    assert.deepEqual(parseSuggestions(invalid, new Set()), [])
  }
  assert.equal(clean("😀".repeat(700), 600), "😀".repeat(599) + "…")
  assert.equal(clean("\u3164\u200b", 48), "")
})

// 驗證一至三則建議的提示只列出有效數字鍵，並區分 Tab 填入與輪流切換。
test("suggestion hints match available choices", () => {
  const items = [{ prompt: "第一則" }, { prompt: "第二則" }, { prompt: "第三則" }]
  const cases = [
    [1, "Tab fill · click to fill · 1 to select, 0 to dismiss (draft only)"],
    [2, "Tab cycle · click to fill · 1/2 to select, 0 to dismiss (draft only)"],
    [3, "Tab cycle · click to fill · 1/2/3 to select, 0 to dismiss (draft only)"],
  ]
  for (const [count, expected] of cases) {
    assert.equal(suggestionHint(items.slice(0, count)), expected)
  }
})

function fixture(generate = async () => ({ text: '[{"label":"測試","prompt":"執行剛才的測試"}]' })) {
  const handlers = new Map()
  let offer
  let generated = 0
  let eventID = 0
  const editor = {
    isDestroyed: false,
    focused: true,
    plainText: "",
    traits: { owner: "opencode", role: "prompt" },
    selected: false,
    selectAll() { this.selected = true },
    insertText(text) {
      this.plainText = this.selected ? text : this.plainText + text
      this.selected = false
      this.onChange?.()
    },
  }
  const session = {
    status: () => "idle",
    pending: { list: () => [] },
    get: () => ({ location: { directory: "test" } }),
    message: {
      sync: async () => {},
      list: () => [{ type: "assistant", finish: "stop", content: [{ type: "text", text: "a".repeat(100) }] }],
    },
  }
  const ctx = {
    options: {},
    ui: { router: { current: () => ({ type: "session", sessionID: "selected" }) } },
    renderer: { currentFocusedEditor: editor },
    keymap: { mode: { current: () => "base" }, commands: () => [] },
    data: {
      on: (type, handler) => { handlers.set(type, handler); return () => handlers.delete(type) },
      session,
      location: {
        command: { sync: async () => {}, list: () => [{ name: "review" }] },
        skill: { sync: async () => {}, list: () => [{ id: "check" }] },
      },
    },
    client: { session: { generate: (...args) => { generated++; return generate(...args) } } },
  }
  const runtime = startSuggestions(ctx, (value) => { offer = value })
  editor.onChange = () => runtime.changed()
  return {
    ctx, editor, session, runtime, handlers,
    offer: () => offer,
    generated: () => generated,
    emit: (type, sessionID = "selected", id = String(++eventID)) => handlers.get(type)?.({ id, data: { sessionID } }),
    flush: () => new Promise(setImmediate),
  }
}

// 驗證生成要求貼合目標、值得現在提出且結果有別的獨立面向，仍接受不足三則；選取只填入草稿，不送出或執行。
test("completion generates editable draft without submitting", async () => {
  const f = fixture(async (input) => {
    assert.equal(input.sessionID, "selected")
    assert.match(input.prompt, /\/review/)
    assert.match(input.prompt, /@check/)
    assert.doesNotMatch(input.prompt, /\/check/)
    assert.match(input.prompt, /優先提供三則不同面向的建議/)
    assert.match(input.prompt, /貼合使用者目前的目標/)
    assert.match(input.prompt, /值得現在提出/)
    assert.match(input.prompt, /目的或預期結果不同、可獨立選擇/)
    assert.match(input.prompt, /不是同一件事換句話說/)
    assert.match(input.prompt, /不是必須依序執行的三個步驟/)
    assert.match(input.prompt, /不要固定套用這些分類/)
    assert.match(input.prompt, /標籤直接點出各自的面向與具體內容/)
    assert.match(input.prompt, /不足三個有用面向時才減少則數/)
    assert.doesNotMatch(input.prompt, /一則有用就只給一則/)
    assert.match(input.prompt, /尚未完成的工作/)
    return { text: '[{"label":"測試","prompt":"執行剛才的測試"}]' }
  })
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.generated(), 1)
  assert.equal(f.offer().items.length, 1)
  assert.equal(f.editor.plainText, "")
  assert.equal(f.runtime.fill(0), true)
  assert.equal(f.editor.plainText, "執行剛才的測試")
  assert.equal(f.offer().items.length, 1)
  assert.equal(f.runtime.cycle(), true)
  assert.equal(f.editor.plainText, "執行剛才的測試")
  f.runtime.stop()
  assert.equal(f.handlers.size, 0)
})

// 驗證三個不同面向的標籤與完整提問會保留，且每個選項都能獨立填入草稿。
test("three distinct suggestions retain labels and independently fill drafts", async () => {
  const items = [
    { label: "推進：完成錯誤處理", prompt: "補上剛才尚未完成的錯誤處理" },
    { label: "理解：說明失敗根因", prompt: "解釋剛才問題的根因與影響範圍" },
    { label: "風險：檢視邊界情境", prompt: "找出目前方案尚未涵蓋的邊界情境" },
  ]
  const f = fixture(async () => ({ text: JSON.stringify(items) }))
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.deepEqual(f.offer().items, items)
  for (const [index, item] of items.entries()) {
    assert.equal(f.runtime.fill(index), true)
    assert.equal(f.editor.plainText, item.prompt)
  }
  assert.equal(f.generated(), 1)
  f.runtime.stop()
})

// 驗證任務結束可回傳空清單，不為湊三則而顯示建議或修改草稿。
test("completed tasks may return no suggestions", async () => {
  const f = fixture(async (input) => {
    assert.match(input.prompt, /任務已結束或沒有實用的下一步就回傳 \[\]/)
    return { text: "[]" }
  })
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.generated(), 1)
  assert.equal(f.offer(), undefined)
  assert.equal(f.editor.plainText, "")
  assert.equal(f.runtime.fill(0), false)
  f.runtime.stop()
})

// 驗證連按 Tab 依序替換三則建議並循環，不累加文字或刪掉建議。
test("Tab cycles retained suggestions without appending", async () => {
  const f = fixture(async () => ({ text: JSON.stringify([
    { prompt: "第一則" }, { prompt: "第二則" }, { prompt: "第三則" },
  ]) }))
  f.emit("session.execution.succeeded")
  await f.flush()
  for (const expected of ["第一則", "第二則", "第三則", "第一則"]) {
    assert.equal(f.runtime.cycle(), true)
    assert.equal(f.editor.plainText, expected)
    assert.equal(f.offer().items.length, 3)
  }
  assert.equal(f.runtime.fill(1), true)
  assert.equal(f.runtime.cycle(), true)
  assert.equal(f.editor.plainText, "第三則")
  f.runtime.stop()
})

// 驗證暫時失焦不會填入其他草稿，切回原輸入框後能接續切換；手動修改仍會停用切換。
test("Tab resumes after temporary focus changes but preserves manual edits", async () => {
  const f = fixture(async () => ({ text: JSON.stringify([
    { prompt: "第一則" }, { prompt: "第二則" },
  ]) }))
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.runtime.cycle(), true)
  const dialog = { ...f.editor, traits: { owner: "opencode", role: "dialog" }, plainText: "對話框的草稿" }
  f.editor.focused = false
  for (const current of [undefined, dialog]) {
    f.ctx.renderer.currentFocusedEditor = current
    f.runtime.changed()
    assert.equal(f.runtime.editor(), undefined)
    assert.equal(f.runtime.cycle(), false)
    assert.equal(f.editor.plainText, "第一則")
    assert.equal(dialog.plainText, "對話框的草稿")
  }
  f.ctx.renderer.currentFocusedEditor = f.editor
  f.editor.focused = true
  f.runtime.changed()
  assert.equal(f.runtime.cycle(), true)
  assert.equal(f.editor.plainText, "第二則")
  f.editor.plainText += "，自己的需求"
  f.runtime.changed()
  assert.equal(f.runtime.cycle(), false)
  assert.equal(f.editor.plainText, "第二則，自己的需求")
  assert.equal(f.generated(), 1)
  assert.equal(f.offer().items.length, 2)
  f.runtime.stop()
})

// 驗證手動修改不被替換；清空恢復第一則，保留原建議且不再次呼叫模型。
test("manual edits pause selection and clearing restores retained suggestions", async () => {
  const f = fixture()
  f.emit("session.execution.succeeded")
  await f.flush()
  f.runtime.cycle()
  f.editor.plainText += "，加上我的需求"
  f.runtime.changed()
  assert.equal(f.runtime.editor(), undefined)
  assert.equal(f.runtime.cycle(), false)
  assert.equal(f.runtime.fill(0), false)
  assert.equal(f.editor.plainText, "執行剛才的測試，加上我的需求")
  assert.equal(f.offer().items.length, 1)
  f.editor.plainText = ""
  f.runtime.changed()
  assert.equal(f.runtime.editor(), f.editor)
  assert.equal(f.runtime.cycle(), true)
  assert.equal(f.editor.plainText, "執行剛才的測試")
  assert.equal(f.generated(), 1)
  f.runtime.hide()
  f.editor.plainText = ""
  f.runtime.changed()
  assert.equal(f.offer(), undefined)
  assert.equal(f.runtime.cycle(), false)
  f.runtime.stop()
})

// 驗證填入後開始新回合會清除建議，清空輸入框也不會復活舊建議。
test("new turn clears retained suggestions", async () => {
  const f = fixture()
  f.emit("session.execution.succeeded")
  await f.flush()
  f.runtime.cycle()
  f.emit("session.execution.started")
  f.editor.plainText = ""
  f.runtime.changed()
  assert.equal(f.offer(), undefined)
  assert.equal(f.runtime.cycle(), false)
  f.runtime.stop()
})

// 驗證開始打字會取消生成，忽略延遲結果，不修改使用者草稿。
test("typing aborts pending generation and ignores late suggestions", async () => {
  let resolve
  let signal
  const f = fixture((_input, options) => {
    signal = options.signal
    return new Promise((done) => { resolve = done })
  })
  f.emit("session.execution.succeeded")
  await f.flush()
  f.editor.plainText = "自己的草稿"
  f.runtime.changed()
  assert.equal(signal.aborted, true)
  resolve({ text: '[{"prompt":"過期建議"}]' })
  await f.flush()
  assert.equal(f.offer(), undefined)
  assert.equal(f.editor.plainText, "自己的草稿")
  f.runtime.stop()
})

// 驗證已有草稿時不啟動生成，避免干擾輸入與浪費模型呼叫。
test("existing draft prevents suggestion generation", async () => {
  const f = fixture()
  f.editor.plainText = "正在打字"
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.generated(), 0)
  assert.equal(f.offer(), undefined)
  f.runtime.stop()
})

// 驗證填入會拒絕非空草稿、Shell、對話框、其他 session、執行中或未知編輯器。
test("draft guards preserve user input and reject other surfaces", () => {
  const baseline = fixture()
  assert.equal(draftEditor(baseline.ctx, "selected"), baseline.editor)
  baseline.runtime.stop()
  const cases = [
    (f) => { f.editor.plainText = "自己的草稿" },
    (f) => { f.editor.traits.status = "SHELL" },
    (f) => { f.editor.focused = false },
    (f) => { f.editor.isDestroyed = true },
    (f) => { f.editor.traits.role = "dialog" },
    (f) => { f.ctx.keymap.mode.current = () => "dialog" },
    (f) => { f.ctx.ui.router.current = () => ({ type: "session", sessionID: "other" }) },
    (f) => { f.session.status = () => "running" },
    (f) => { f.session.pending.list = () => [{}] },
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    assert.equal(draftEditor(f.ctx, "selected"), undefined)
    f.runtime.stop()
  }
})

// 驗證新回合取消舊生成；即使供應商稍後回傳，舊建議也不會重新出現。
test("new turn aborts generation and discards stale result", async () => {
  let resolve
  let signal
  const f = fixture((_input, options) => {
    signal = options.signal
    return new Promise((done) => { resolve = done })
  })
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.offer().loading, true)
  f.emit("session.execution.started")
  assert.equal(signal.aborted, true)
  resolve({ text: '[{"prompt":"過期建議"}]' })
  await f.flush()
  assert.equal(f.offer(), undefined)
  f.runtime.stop()
})

// 驗證新回合若在同步歷史期間開始，尚未送出的舊生成也會取消。
test("new turn during context sync prevents generation", async () => {
  let resolve
  const f = fixture()
  f.session.message.sync = () => new Promise((done) => { resolve = done })
  f.emit("session.execution.succeeded")
  f.emit("session.execution.started")
  resolve()
  await f.flush()
  assert.equal(f.generated(), 0)
  assert.equal(f.offer(), undefined)
  f.runtime.stop()
})

// 驗證背景 session、簡短回答、工具續跑與失敗回答不會額外生成。
test("only selected completed answers request suggestions", async () => {
  const f = fixture()
  f.emit("session.execution.succeeded", "background")
  await f.flush()
  assert.equal(f.generated(), 0)
  for (const assistant of [
    { finish: "stop", content: [{ type: "text", text: "短回答" }] },
    { finish: "tool-calls", content: [{ type: "text", text: "a".repeat(100) }] },
    { finish: "stop", error: {}, content: [{ type: "text", text: "a".repeat(100) }] },
  ]) {
    f.session.message.list = () => [{ type: "assistant", ...assistant }]
    f.emit("session.execution.succeeded")
    await f.flush()
    assert.equal(f.generated(), 0)
    assert.equal(f.offer(), undefined)
  }
  f.runtime.stop()
})

// 驗證手動觸發略過最小字數門檻，短回答也能產生建議。
test("manual refresh generates without minimum answer length", async () => {
  const f = fixture()
  f.session.message.list = () => [{ type: "assistant", finish: "stop", content: [{ type: "text", text: "太短" }] }]
  f.emit("session.execution.succeeded")
  await f.flush()
  assert.equal(f.generated(), 0)
  assert.equal(f.runtime.refresh(), true)
  await f.flush()
  assert.equal(f.generated(), 1)
  assert.equal(f.offer().items.length, 1)
  f.runtime.stop()
})

// 驗證 session 忙碌時手動觸發也不生成。
test("manual refresh skips busy session without generating", async () => {
  const f = fixture()
  f.session.status = () => "busy"
  assert.equal(f.runtime.refresh(), true)
  await f.flush()
  assert.equal(f.generated(), 0)
  assert.equal(f.offer(), undefined)
  f.runtime.stop()
})
