import { ComposerPill, Plugin, createKeyed } from "@opencode/plugin/gui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { startGuiSuggestions } from "./gui-suggestions.js"

type Offer = { key: string; sessionID: string; items: { label: string; prompt: string }[]; loading: boolean }

export default Plugin.define({
  setup(ctx) {
    const [offer, setOffer] = createSignal<Offer>()
    let suggestions: ReturnType<typeof startGuiSuggestions> | undefined
    createKeyed(
      () => ctx.sessions.current()?.server.data,
      (data) => {
        const runtime = startGuiSuggestions(ctx, data, setOffer)
        suggestions = runtime
        createEffect(() => {
          ctx.sessions.current()?.key
          ctx.screen.current()?.composer.text()
          runtime.changed()
        })
        onCleanup(() => {
          runtime.stop()
          if (suggestions === runtime) suggestions = undefined
        })
      },
    )
    ctx.add(ComposerPill, {
      id: "suggestions",
      show: ({ session }) => {
        const value = offer()
        if (!value || value.key !== session.key || !suggestions?.available()) return
        return {
          label: value.loading ? "下一步建議產生中…" : `下一步 · ${value.items.length} 個方向`,
          title: "選擇下一步（僅填入草稿，不會自動送出）",
          rows: value.loading ? undefined : [
            ...value.items.map((item: { label: string; prompt: string }, index: number) => ({
              id: String(index),
              label: `${index + 1}. ${item.label}`,
              detail: item.prompt,
              run: () => { if (offer() === value) suggestions?.fill(index) },
            })),
            { id: "dismiss", label: "關閉建議", run: () => { if (offer() === value) suggestions?.hide() } },
          ],
        }
      },
    })
  },
})
