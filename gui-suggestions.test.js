import assert from "node:assert/strict"
import { test } from "node:test"
import { startGuiSuggestions } from "./gui-suggestions.js"
import { suggestionPrompt } from "./suggestions.js"

const items = [
  { label: "推進：完成錯誤處理", prompt: "補上尚未完成的錯誤處理" },
  { label: "理解：解釋根因", prompt: "解釋這次問題的根因" },
  { label: "風險：檢視邊界", prompt: "檢視尚未涵蓋的邊界情境" },
]

function fixture(generate = async () => ({ text: JSON.stringify(items) })) {
  const handlers = new Map()
  let offer
  let calls = 0
  let eventID = 0
  let text = ""
  let focused = 0
  const composer = {
    text: () => text,
    quotable: () => true,
    setText(value) { text = value; runtime.changed() },
    focus() { focused++ },
  }
  const data = {
    on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type) },
    session: {
      status: () => "idle",
      pending: { list: () => [] },
      message: {
        sync: async () => {},
        list: () => [{ type: "assistant", finish: "stop", content: [{ type: "text", text: "回覆".repeat(50) }] }],
      },
    },
    location: {
      command: { sync: async () => {}, list: () => [{ name: "review" }] },
      skill: { sync: async () => {}, list: () => [{ id: "check" }] },
    },
  }
  const server = { id: "sidecar", data, client: { session: { generate(...args) { calls++; return generate(...args) } } } }
  let session = { id: "selected", key: "sidecar\nselected", server, location: { directory: "test" } }
  const screen = { composer }
  const ctx = { options: {}, sessions: { current: () => session }, screen: { current: () => screen } }
  const runtime = startGuiSuggestions(ctx, data, (value) => { offer = value })
  return {
    ctx, data, server, screen, composer, runtime, handlers,
    offer: () => offer,
    calls: () => calls,
    focused: () => focused,
    select(value) { session = value; runtime.changed() },
    emit(type = "session.execution.succeeded", sessionID = "selected", id = String(++eventID)) {
      handlers.get(type)?.({ id, data: { sessionID } })
    },
    flush: () => new Promise(setImmediate),
  }
}

// 驗證 GUI 使用共用三面向提示與目前 session 的 client，選取只填入草稿並聚焦輸入框。
test("GUI generates three directions and fills drafts without submitting", async () => {
  const f = fixture(async (input) => {
    assert.equal(input.sessionID, "selected")
    assert.equal(input.prompt, suggestionPrompt([{ name: "review" }], [{ id: "check" }]))
    return { text: JSON.stringify(items) }
  })
  f.emit()
  await f.flush()
  assert.equal(f.calls(), 1)
  assert.deepEqual(f.offer().items, items)
  assert.equal(f.composer.text(), "")
  for (const [index, item] of items.entries()) {
    assert.equal(f.runtime.fill(index), true)
    assert.equal(f.composer.text(), item.prompt)
  }
  assert.equal(f.focused(), 3)
  f.runtime.stop()
  assert.equal(f.handlers.size, 0)
})

// 驗證手動修改後不會被建議覆寫，清空輸入框後可重新選取且不重複生成。
test("GUI preserves manual edits and resumes selection after clearing", async () => {
  const f = fixture()
  f.emit()
  await f.flush()
  f.runtime.fill(0)
  f.composer.setText("自己的草稿")
  assert.equal(f.runtime.fill(1), false)
  assert.equal(f.composer.text(), "自己的草稿")
  f.composer.setText("")
  assert.equal(f.runtime.fill(2), true)
  assert.equal(f.composer.text(), items[2].prompt)
  assert.equal(f.calls(), 1)
  f.runtime.stop()
})

// 驗證新回合、切換 session、同 ID 的其他 server 與卸載都會取消生成並忽略晚到結果。
test("GUI cancels stale requests across turns, sessions, servers and cleanup", async () => {
  const actions = [
    (f) => f.emit("session.execution.started"),
    (f) => f.select({ id: "other", key: "sidecar\nother", server: f.server }),
    (f) => f.select({ id: "selected", key: "remote\nselected", server: { ...f.server, id: "remote" } }),
    (f) => {
      Object.assign(f.ctx.sessions.current(), { id: "other", key: "sidecar\nother" })
      f.runtime.changed()
    },
    (f) => f.runtime.stop(),
    (f) => f.composer.setText("自己的草稿"),
  ]
  for (const action of actions) {
    let resolve
    let signal
    const f = fixture((_input, options) => {
      signal = options.signal
      return new Promise((done) => { resolve = done })
    })
    f.emit()
    await f.flush()
    action(f)
    assert.equal(signal.aborted, true)
    resolve({ text: JSON.stringify(items) })
    await f.flush()
    assert.equal(f.offer(), undefined)
    assert.equal(f.runtime.fill(0), false)
    f.runtime.stop()
  }
})

// 驗證背景 session、既有草稿、Shell／子代理、執行中、待送出、過短與失敗回覆不啟動生成。
test("GUI generates only for eligible idle completed answers", async () => {
  const cases = [
    (f) => { f.ctx.sessions.current = () => undefined },
    (f) => { f.composer.setText("自己的草稿") },
    (f) => { f.composer.quotable = () => false },
    (f) => { f.data.session.status = () => "busy" },
    (f) => { f.data.session.pending.list = () => [{}] },
    (f) => { f.screen.composer = undefined },
    ...[
      { finish: "stop", content: [{ type: "text", text: "短回答" }] },
      { finish: "tool-calls", content: [] },
      { finish: "stop", error: {}, content: [] },
    ].map((assistant) => (f) => { f.data.session.message.list = () => [{ type: "assistant", ...assistant }] }),
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    f.emit()
    await f.flush()
    assert.equal(f.calls(), 0)
    assert.equal(f.offer(), undefined)
    f.runtime.stop()
  }
  const f = fixture()
  f.emit("session.execution.succeeded", "background")
  await f.flush()
  assert.equal(f.calls(), 0)
  f.runtime.stop()
})

// 驗證同步歷史期間切換 session 會取消請求，不再呼叫模型。
test("GUI cancels while synchronizing messages", async () => {
  const f = fixture()
  let resolve
  f.data.session.message.sync = () => new Promise((done) => { resolve = done })
  f.emit()
  f.select(undefined)
  resolve()
  await f.flush()
  assert.equal(f.calls(), 0)
  assert.equal(f.offer(), undefined)
  f.runtime.stop()
})

// 驗證無有效建議時不顯示，未知指令與 skill 仍會被共用解析器過濾。
test("GUI hides empty or unsafe suggestions", async () => {
  for (const text of ["[]", "[broken]", '[{"prompt":"/missing"},{"prompt":"@missing"}]']) {
    const f = fixture(async () => ({ text }))
    f.emit()
    await f.flush()
    assert.equal(f.offer(), undefined)
    assert.equal(f.runtime.fill(0), false)
    f.runtime.stop()
  }
})

// 驗證隱藏候選清單選項在兩種介面共用，且不會移除三面向要求或產生額外模型呼叫。
test("shared prompt respects disabled skill suggestions", async () => {
  const f = fixture(async (input) => {
    assert.match(input.prompt, /優先提供三則不同面向/)
    assert.doesNotMatch(input.prompt, /\/review|@check/)
    return { text: "[]" }
  })
  f.ctx.options.suggestSkills = false
  f.emit()
  await f.flush()
  assert.equal(f.calls(), 1)
  f.runtime.stop()
})

// 驗證重複完成事件不額外生成，關閉後不可再填入舊建議。
test("GUI deduplicates completion events and dismisses retained suggestions", async () => {
  const f = fixture()
  f.emit("session.execution.succeeded", "selected", "same")
  await f.flush()
  f.emit("session.execution.succeeded", "selected", "same")
  await f.flush()
  assert.equal(f.calls(), 1)
  f.runtime.hide()
  assert.equal(f.offer(), undefined)
  assert.equal(f.runtime.fill(0), false)
  f.runtime.stop()
})

// 驗證模型失敗時移除載入提示、不修改草稿，且下一次正常完成仍可產生建議。
test("GUI recovers from generation errors without modifying drafts", async (t) => {
  const log = t.mock.method(console, "error", () => {})
  let fail = true
  const f = fixture(async () => {
    if (fail) throw new Error("模擬模型失敗")
    return { text: JSON.stringify(items) }
  })
  f.emit()
  await f.flush()
  assert.equal(f.offer(), undefined)
  assert.equal(f.composer.text(), "")
  assert.equal(log.mock.callCount(), 1)
  fail = false
  f.emit()
  await f.flush()
  assert.deepEqual(f.offer().items, items)
  f.runtime.stop()
})
