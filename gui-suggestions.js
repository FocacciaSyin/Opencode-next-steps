import { parseSuggestions, suggestionPrompt } from "./suggestions.js"

export function startGuiSuggestions(ctx, data, publish) {
  let offer
  let pending
  let filled
  let controller
  let revision = 0
  let lastEvent
  const show = (value) => { offer = value; publish(value) }
  const hide = () => {
    revision++
    controller?.abort()
    pending = undefined
    filled = undefined
    show(undefined)
  }
  const current = (key) => {
    const session = ctx.sessions.current()
    return session?.key === key && session.server.data === data ? session : undefined
  }
  const editor = (key, expectedText = "") => {
    const session = current(key)
    const composer = ctx.screen.current()?.composer
    if (!session || !composer?.quotable() || composer.text() !== expectedText) return
    if (data.session.status(session.id) !== "idle" || data.session.pending.list(session.id).length) return
    return composer
  }
  const available = () => {
    if (!offer) return
    const composer = editor(offer.key, filled?.prompt ?? "")
    return (!filled || filled.composer === composer) ? composer : undefined
  }
  const started = data.on("session.execution.started", (event) => {
    if (event.data.sessionID === pending?.id || event.data.sessionID === offer?.sessionID) hide()
  })
  const succeeded = data.on("session.execution.succeeded", (event) => {
    const session = ctx.sessions.current()
    if (!session || session.server.data !== data || session.id !== event.data.sessionID || event.id === lastEvent) return
    lastEvent = event.id
    hide()
    const request = revision
    const key = session.key
    const sessionID = session.id
    const location = event.location ?? session.location
    pending = { key, id: sessionID }
    controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    const valid = () => request === revision && !signal.aborted && !!editor(key)
    void (async () => {
      try {
        await data.session.message.sync(sessionID)
        if (!valid()) return
        const assistant = data.session.message.list(sessionID).findLast((message) => message.type === "assistant")
        if (!assistant || assistant.finish !== "stop" || assistant.error) return
        const answer = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        const minimum = typeof ctx.options.minAnswerChars === "number" ? Math.max(0, ctx.options.minAnswerChars) : 80
        if (answer.trim().length < minimum) return
        show({ key, sessionID, items: [], loading: true })
        if (!location) return
        await Promise.all([data.location.command.sync(location), data.location.skill.sync(location)])
        if (!valid()) return
        const commands = data.location.command.list(location) ?? []
        const skills = data.location.skill.list(location) ?? []
        const reply = await session.server.client.session.generate({
          sessionID,
          prompt: suggestionPrompt(commands, skills, ctx.options.suggestSkills !== false),
        }, { signal })
        if (!valid()) return
        const items = parseSuggestions(reply.text, new Set(commands.map((item) => item.name)), new Set(skills.map((item) => item.id)))
        show(items.length ? { key, sessionID, items, loading: false } : undefined)
      } catch (error) {
        if (request === revision) {
          show(undefined)
          if (!signal.aborted) console.error("[next-steps] 無法產生 GUI 建議：", error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (request === revision) {
          pending = undefined
          if (offer?.loading) show(undefined)
        }
      }
    })()
  })
  return {
    hide,
    available,
    changed() {
      if ((pending && !current(pending.key)) || (offer && !current(offer.key))) { hide(); return }
      const composer = ctx.screen.current()?.composer
      if (filled && (filled.composer !== composer || composer.text() !== filled.prompt)) filled = undefined
      if (pending && !editor(pending.key)) hide()
    },
    fill(index) {
      const item = offer?.items[index]
      const composer = available()
      if (!item || !composer) return false
      filled = { composer, prompt: item.prompt }
      composer.setText(item.prompt)
      composer.focus()
      return true
    },
    stop() { started(); succeeded(); hide() },
  }
}
