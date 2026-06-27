import { formatCount, type ModelContext } from '../lib/tokens'

// Visualizes how much of the live model's context window a chunk of content
// (typically a collection) would fill. The percentage is an estimate — labelled
// as such — because token counts vary by tokenizer; it answers "will this fit?".

function pctOf(tokens: number, model: ModelContext | null): number | null {
  if (!model?.contextLength) return null
  return Math.round((tokens / model.contextLength) * 100)
}

function band(pct: number | null): { bar: string; text: string } {
  if (pct === null) return { bar: 'bg-faint', text: 'text-muted' }
  if (pct < 60) return { bar: 'bg-emerald-500', text: 'text-emerald-600' }
  if (pct < 90) return { bar: 'bg-amber-500', text: 'text-amber-600' }
  return { bar: 'bg-red-500', text: 'text-red-600' }
}

// Inline one-liner for tight spots (chat chip, picker rows).
export function ContextUsage({ tokens, model }: { tokens: number; model: ModelContext | null }) {
  const pct = pctOf(tokens, model)
  const { text } = band(pct)
  return (
    <span className={`whitespace-nowrap text-[11px] font-medium ${text}`}>
      ≈{formatCount(tokens)} tok{pct !== null && ` · ${pct}%`}
    </span>
  )
}

// Full meter with a bar + explanatory caption for the Artifacts collection header.
export function ContextMeter({ tokens, model }: { tokens: number; model: ModelContext | null }) {
  const pct = pctOf(tokens, model)
  const { bar, text } = band(pct)
  const windowLabel = model?.contextLength ? `${formatCount(model.contextLength)} window` : 'context window'
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">
          ≈<span className="font-semibold text-text">{formatCount(tokens)}</span> tokens
          {pct !== null && (
            <>
              {' '}
              · <span className={`font-semibold ${text}`}>{pct}%</span> of the {windowLabel}
            </>
          )}
        </span>
        <span className="truncate pl-2 font-mono text-[10px] text-faint" title={model?.slug}>
          {model?.name ?? '…'}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-faint">
        {pct === null
          ? "Couldn't read this model's context size — estimate only."
          : pct >= 100
            ? 'Larger than the window — only the start is sent; the rest is dropped. Trim it or pick a bigger-context model.'
            : pct >= 90
              ? 'Nearly fills the window, leaving little room for the conversation and reply.'
              : 'Estimate; the rest of the window holds your conversation and the reply.'}
      </p>
    </div>
  )
}
