// Pure, import-side-effect-free helpers for Excalidraw whiteboard scenes — kept
// out of builtins.ts (which pulls in supabase-js) so they can be unit-tested with
// `deno test` and reused by the collection-context loader. Two jobs:
//
//   * sceneToText(scene) → a compact, AI-readable description of what's ON the
//     board (text labels, shapes, connections, frames). This is what makes a
//     whiteboard "chattable like an artifact": it's injected as primary context
//     and returned by the get_whiteboard builtin.
//   * buildScene / normalizeElements → turn the loose "skeleton" elements the
//     assistant writes (just type/x/y/width/height/text/label) into elements with
//     the fields Excalidraw needs to render, so update_whiteboard can DRAW. A
//     shape/arrow with a `label:{text}` convenience becomes the shape plus a bound
//     text child (what Excalidraw's own convertToExcalidrawElements does), so the
//     label both renders on the canvas and is picked up by sceneToText.
//
// Everything here is defensive: unknown/garbage input degrades to a sensible
// default rather than throwing — the callers treat a bad scene as an empty board.

// deno-lint-ignore no-explicit-any
export type El = Record<string, any>
export type Scene = { elements?: El[]; appState?: El; files?: El }

const CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const LINEAR_TYPES = new Set(['arrow', 'line'])

function rid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'el-' + Math.floor(Math.random() * 1e9).toString(36)
  }
}
function nonce(): number {
  return Math.floor(Math.random() * 2_000_000_000)
}
function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// ---------------------------------------------------------------------------
// sceneToText — describe a board so the model can reason about it.
// ---------------------------------------------------------------------------
export function sceneToText(scene: unknown): string {
  const els = elementsOf(scene).filter((e) => e && !e.isDeleted)
  if (!els.length) return '(empty whiteboard — nothing drawn yet)'

  const byId = new Map<string, El>(els.map((e) => [String(e.id), e]))
  // Bound labels live as separate text elements pointing at their container.
  const labelFor = new Map<string, string>()
  for (const e of els) {
    if (e.type === 'text' && e.containerId && typeof e.text === 'string' && e.text.trim()) {
      labelFor.set(String(e.containerId), e.text.trim())
    }
  }
  const nameOf = (e: El | null | undefined): string => {
    if (!e) return '?'
    return labelFor.get(String(e.id)) || inlineLabel(e) || e.type || 'element'
  }

  const freeText: string[] = []
  const shapes: string[] = []
  const connections: string[] = []
  const frames: string[] = []
  let drawings = 0

  for (const e of els) {
    const t = e.type
    if (t === 'text') {
      if (!e.containerId && typeof e.text === 'string' && e.text.trim()) freeText.push(e.text.trim())
    } else if (CONTAINER_TYPES.has(t)) {
      const label = labelFor.get(String(e.id)) || inlineLabel(e)
      shapes.push(label ? `${t} "${label}"` : t)
    } else if (t === 'frame' || t === 'magicframe') {
      frames.push(typeof e.name === 'string' && e.name.trim() ? e.name.trim() : 'Frame')
    } else if (LINEAR_TYPES.has(t)) {
      const a = e.startBinding?.elementId ? byId.get(String(e.startBinding.elementId)) : null
      const b = e.endBinding?.elementId ? byId.get(String(e.endBinding.elementId)) : null
      const label = labelFor.get(String(e.id)) || inlineLabel(e)
      const glyph = t === 'arrow' ? '→' : '—'
      if (a || b) {
        connections.push(`${nameOf(a)} ${glyph} ${nameOf(b)}${label ? ` (${label})` : ''}`)
      } else if (label) {
        connections.push(`${glyph} ${label}`)
      }
    } else if (t === 'freedraw' || t === 'image') {
      drawings++
    }
  }

  const parts: string[] = []
  if (freeText.length) parts.push(`Text on the board:\n${freeText.map((t) => `- ${t}`).join('\n')}`)
  if (shapes.length) parts.push(`Shapes:\n${shapes.map((s) => `- ${s}`).join('\n')}`)
  if (connections.length) parts.push(`Connections:\n${connections.map((c) => `- ${c}`).join('\n')}`)
  if (frames.length) parts.push(`Frames/sections: ${frames.join(', ')}`)
  if (drawings) parts.push(`Plus ${drawings} freehand drawing/image element(s).`)
  if (!parts.length) return `A whiteboard with ${els.length} element(s) and no text labels.`
  return parts.join('\n\n')
}

function elementsOf(scene: unknown): El[] {
  const s = scene as Scene | null
  const els = s?.elements
  return Array.isArray(els) ? (els as El[]) : []
}

// A convenience `label` (Excalidraw skeleton style) or a plain inline `text`.
function inlineLabel(e: El): string | null {
  if (e && e.label && typeof e.label.text === 'string' && e.label.text.trim()) return e.label.text.trim()
  if (typeof e?.text === 'string' && e.text.trim() && CONTAINER_TYPES.has(e.type)) return e.text.trim()
  return null
}

// ---------------------------------------------------------------------------
// normalizeElements — skeleton elements → renderable Excalidraw elements.
// Excalidraw's restore() on load fills further gaps, but we set the required
// fields (and generate ids) so a board written by the assistant renders.
// ---------------------------------------------------------------------------
export function normalizeElements(input: unknown): El[] {
  if (!Array.isArray(input)) return []
  const out: El[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const el = raw as El
    const type = String(el.type ?? '').trim()
    if (!type) continue
    const id = String(el.id ?? rid())
    const base: El = {
      id,
      type,
      x: num(el.x, 100),
      y: num(el.y, 100),
      width: num(el.width, type === 'text' ? 100 : 160),
      height: num(el.height, type === 'text' ? 25 : 80),
      angle: num(el.angle, 0),
      strokeColor: typeof el.strokeColor === 'string' ? el.strokeColor : '#1e1e1e',
      backgroundColor: typeof el.backgroundColor === 'string' ? el.backgroundColor : 'transparent',
      fillStyle: el.fillStyle ?? 'solid',
      strokeWidth: num(el.strokeWidth, 2),
      strokeStyle: el.strokeStyle ?? 'solid',
      roughness: num(el.roughness, 1),
      opacity: num(el.opacity, 100),
      groupIds: Array.isArray(el.groupIds) ? el.groupIds : [],
      frameId: el.frameId ?? null,
      roundness: el.roundness ?? (type === 'rectangle' ? { type: 3 } : null),
      seed: num(el.seed, nonce()),
      version: num(el.version, 1),
      versionNonce: num(el.versionNonce, nonce()),
      isDeleted: false,
      boundElements: Array.isArray(el.boundElements) ? el.boundElements : null,
      updated: 1,
      link: el.link ?? null,
      locked: false,
    }

    const label = el.label && typeof el.label.text === 'string' ? String(el.label.text) : null

    if (type === 'text') {
      out.push({
        ...base,
        text: String(el.text ?? ''),
        originalText: String(el.text ?? ''),
        fontSize: num(el.fontSize, 20),
        fontFamily: num(el.fontFamily, 1),
        textAlign: el.textAlign ?? 'left',
        verticalAlign: el.verticalAlign ?? 'top',
        containerId: el.containerId ?? null,
        lineHeight: num(el.lineHeight, 1.25),
        baseline: num(el.baseline, 18),
      })
      continue
    }

    if (LINEAR_TYPES.has(type)) {
      const w = base.width
      const h = base.height
      const points = Array.isArray(el.points) && el.points.length >= 2
        ? el.points
        : [[0, 0], [w, h]]
      out.push({
        ...base,
        points,
        lastCommittedPoint: null,
        startBinding: el.startBinding ?? null,
        endBinding: el.endBinding ?? null,
        startArrowhead: el.startArrowhead ?? null,
        endArrowhead: el.endArrowhead ?? (type === 'arrow' ? 'arrow' : null),
      })
      if (label) out.push(boundText(id, label, base.x, base.y))
      continue
    }

    // rectangle / ellipse / diamond / frame / other closed shapes.
    if (label && CONTAINER_TYPES.has(type)) {
      base.boundElements = [{ id: `${id}-label`, type: 'text' }]
      out.push(base)
      out.push(boundText(id, label, base.x, base.y, base.width, base.height))
    } else {
      out.push(base)
    }
  }
  return out
}

function boundText(containerId: string, text: string, x: number, y: number, w = 100, h = 25): El {
  return {
    id: `${containerId}-label`,
    type: 'text',
    x: x + 8,
    y: y + Math.max(0, h / 2 - 10),
    width: Math.max(20, w - 16),
    height: 25,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    lineHeight: 1.25,
    baseline: 18,
  }
}

// Build (or merge into) a scene from assistant-supplied elements.
export function buildScene(existing: unknown, input: unknown, mode: 'replace' | 'append'): Scene {
  const prev = (existing && typeof existing === 'object' ? (existing as Scene) : {}) || {}
  const fresh = normalizeElements(input)
  const base = mode === 'append' ? elementsOf(prev) : []
  return {
    elements: [...base, ...fresh],
    appState: prev.appState ?? { viewBackgroundColor: '#ffffff' },
    files: prev.files ?? {},
  }
}

// Count non-deleted elements (used for list/summary lines).
export function elementCount(scene: unknown): number {
  return elementsOf(scene).filter((e) => e && !e.isDeleted).length
}
