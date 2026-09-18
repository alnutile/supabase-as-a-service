import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

interface RichTextEditorProps {
  content: string
  onChange: (markdown: string) => void
  placeholder?: string
}

export function RichTextEditor({
  content,
  onChange,
  placeholder = 'Write here…',
}: RichTextEditorProps) {
  return (
    <div className="flex-1 overflow-y-auto" data-color-mode="light">
      <MDEditor
        value={content}
        onChange={(val) => onChange(val || '')}
        preview="live"
        hideToolbar={false}
        height="100%"
        visibleDragbar={false}
        textareaProps={{
          placeholder,
        }}
      />
    </div>
  )
}
