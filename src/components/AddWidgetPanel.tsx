import { useRef, useState } from 'react'
import { streamChat } from '../lib/chat'
import { isAbortError } from '../lib/chatError'
import { Markdown } from './Markdown'
import { CloseIcon, SendIcon, SparkleIcon } from './icons'

// The AI system prompt that turns a natural-language request into a create_widget
// call. Kept terse + concrete: the tool schema does the heavy validation, this
// just steers source/kind/spec choice and asks for a short confirmation.
const WIDGET_SYSTEM = `You add widgets to the user's Home dashboard by calling the create_widget tool. When the user describes what they want to see, choose the best fit and call create_widget:
- kind: "stat" (a single count), "list" (recent rows), or "chart".
- source: one of todos | artifacts | files | links | collections | activity.
- spec (optional): {"window":"today"|"7d"|"30d"|"all", "mine":true, "status":"open"|"done" (todos only), "limit":1-20 (list only), "viz":"bar"|"line"|"area"|"donut" (chart only), "groupBy":<dimension> (chart only)}.
Charts: by default a chart shows a per-day count over the last 14 days — use "viz":"line" or "area" for a trend line. To show a BREAKDOWN by category instead, set "groupBy" to one of the source's dimensions and optionally "viz":"donut": todos→"done", artifacts→"type", files→"mime_type", activity→"type". (links/collections have no groupBy.) Example: "artifacts by type as a donut" → kind:"chart", source:"artifacts", spec:{"groupBy":"type","viz":"donut","mine":true}.
Default to "mine": true unless the user clearly means the whole team. Give the widget a short, clear title. If the request can't map to one of those sources, say so briefly instead of guessing. After the tool succeeds, confirm in one short sentence what you added. Do not create more than one widget unless the user asks for several.`

const SUGGESTIONS = [
  'My open to-dos as a count',
  'Artifacts by type as a donut',
  'A trend line of my activity',
  'My latest 5 files',
]

// A focused composer that asks the assistant to add a dashboard widget. The
// widget itself lands via the parent's realtime subscription on
// dashboard_widgets, so this panel only needs to drive the model + show its
// confirmation.
export function AddWidgetPanel({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function submit(text: string) {
    const prompt = text.trim()
    if (!prompt || busy) return
    setBusy(true)
    setError(null)
    setReply('')
    try {
      const controller = new AbortController()
      abortRef.current = controller
      const full = await streamChat(
        [{ role: 'user', content: prompt }],
        (d) => setReply((s) => (s ?? '') + d),
        { system: WIDGET_SYSTEM, signal: controller.signal },
      )
      setReply(full.trim() || 'Done.')
      setInput('')
    } catch (err) {
      setReply(null)
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : 'Failed to add the widget')
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[18px] border border-primary-soft-border bg-surface p-5 shadow-soft">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <SparkleIcon className="h-[18px] w-[18px]" />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-text">Add a widget</div>
            <div className="text-[12px] text-faint">Describe what you want to see — the AI builds it.</div>
          </div>
        </div>
        <button onClick={onClose} title="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit(input)
            }
          }}
          placeholder="e.g. show my artifacts added today as a list"
          rows={2}
          disabled={busy}
          className="max-h-32 min-h-[52px] flex-1 resize-none rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:opacity-60"
        />
        <button
          onClick={() => void submit(input)}
          disabled={!input.trim() || busy}
          title="Add"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary-strong disabled:opacity-40"
        >
          <SendIcon className="h-4 w-4" />
        </button>
      </div>

      {!reply && !busy && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => void submit(s)}
              className="rounded-full border border-border bg-surface-2 px-3 py-1 text-[12px] font-medium text-muted transition hover:border-primary hover:text-primary"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {reply !== null && (
        <div className="mt-3 rounded-xl bg-surface-2 px-3.5 py-2 text-sm text-text">
          {reply ? <Markdown>{reply}</Markdown> : <span className="text-faint">Adding…</span>}
        </div>
      )}
      {error && <div className="mt-3 rounded-xl bg-red-50 px-3.5 py-2 text-xs text-red-600">{error}</div>}
    </div>
  )
}
