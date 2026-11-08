import { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents, EditBufferRenderableEvents, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { draftEditor, startSuggestions, suggestionHint } from "./suggestions.js"

type Offer = { sessionID: string; items: { label: string; prompt: string }[]; loading: boolean }

export default Plugin.define({
  id: "next-steps",
  setup(ctx) {
    if (ctx.options.debug) ctx.ui.toast.show({ message: "[next-steps] TUI 已載入（debug 開啟）", variant: "info" })
    const [offer, setOffer] = createSignal<Offer>()
    const [focusVersion, setFocusVersion] = createSignal(0)
    const suggestions = startSuggestions(ctx, setOffer)
    let observed: TextareaRenderable | undefined
    let ghost: { editor: TextareaRenderable; previous: TextareaRenderable["placeholder"]; text: string } | undefined
    const changed = () => {
      suggestions.changed()
      setFocusVersion((version) => version + 1)
    }
    const visible = createMemo(() => {
      focusVersion()
      const current = offer()
      return current && suggestions.editor() ? current : undefined
    })
    const observe = () => {
      observed?.off(EditBufferRenderableEvents.TRAITS_CHANGED, changed)
      observed?.editBuffer.off("content-changed", changed)
      observed = ctx.renderer.currentFocusedEditor as TextareaRenderable | undefined
      observed?.on(EditBufferRenderableEvents.TRAITS_CHANGED, changed)
      observed?.editBuffer.on("content-changed", changed)
      changed()
    }
    ctx.renderer.on(CliRenderEvents.FOCUSED_EDITOR, observe)
    observe()
    const restoreGhost = () => {
      if (ghost && !ghost.editor.isDestroyed && ghost.editor.placeholder === ghost.text) ghost.editor.placeholder = ghost.previous
      ghost = undefined
    }
    createEffect(() => {
      focusVersion()
      const current = offer()
      const route = ctx.ui.router.current()
      restoreGhost()
      if (current && (route.type !== "session" || route.sessionID !== current.sessionID)) {
        suggestions.hide()
        return
      }
      const editor = current && draftEditor(ctx, current.sessionID) as TextareaRenderable | undefined
      if (!editor || !current?.items[0]) return
      ghost = { editor, previous: editor.placeholder, text: current.items[0].prompt }
      editor.placeholder = ghost.text
    })
    ctx.keymap.layer(() => ({
      priority: 100,
      mode: "global",
      commands: [
        {
          id: "next-steps.refresh",
          title: "Generate next-step suggestions",
          palette: true,
          enabled: () => ctx.ui.router.current().type === "session",
          run: () => suggestions.refresh() ? undefined : false,
        },
      ],
    }))
    ctx.keymap.layer(() => ({
      priority: 100,
      enabled: () => !!visible()?.items.length && !!suggestions.editor(),
      commands: [
        ...[1, 2, 3].map((number) => ({
          id: `next-steps.${number}`,
          title: `Fill next step ${number}`,
          bind: String(number),
          enabled: () => !!offer()?.items[number - 1] && !!draftEditor(ctx, offer()!.sessionID),
          run: () => suggestions.fill(number - 1) ? undefined : false as const,
        })),
        { id: "next-steps.accept", title: "Cycle next-step suggestion", bind: "tab", run: () => suggestions.cycle() ? undefined : false },
        { id: "next-steps.dismiss", title: "Dismiss next-step suggestions", bind: "0", enabled: () => !!offer() && !!draftEditor(ctx, offer()!.sessionID), run: suggestions.hide },
      ],
    }))
    const slot = ctx.ui.slot({
      append: "session.composer.top",
      render: (props) => <Show when={visible()?.sessionID === props.sessionID && visible()}>
        {(current) => <box flexDirection="column" width="100%" flexShrink={0} marginTop={1}>
          <Show when={current().loading}><text fg={ctx.theme.text.muted}>Generating next-step suggestions…</text></Show>
          <For each={current().items}>{(item, index) =>
            <box width="100%" height={1} flexShrink={0}>
              <text width="100%" wrapMode="none" truncate fg={ctx.theme.text.muted} onMouseDown={() => {
                if (!suggestions.fill(index())) ctx.ui.toast.show({ message: "Clear the main input and return to normal mode first", variant: "info" })
              }}>{`${index() + 1}: ${item.label}`}</text>
            </box>
          }</For>
          <Show when={current().items.length}><text width="100%" fg={ctx.theme.text.muted}>{suggestionHint(current().items)}</text></Show>
        </box>}
      </Show>,
    })
    return () => {
      suggestions.stop()
      slot()
      ctx.renderer.off(CliRenderEvents.FOCUSED_EDITOR, observe)
      observed?.off(EditBufferRenderableEvents.TRAITS_CHANGED, changed)
      observed?.editBuffer.off("content-changed", changed)
      restoreGhost()
    }
  },
})
