import { useEffect, useState } from 'react'
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
  // Detect theme from document.documentElement data-theme attribute
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => {
    const theme = document.documentElement.getAttribute('data-theme')
    return (theme as 'light' | 'dark') || 'light'
  })

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme')
      setColorMode((theme as 'light' | 'dark') || 'light')
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex-1 overflow-hidden" data-color-mode={colorMode}>
      <div className="h-full overflow-y-scroll">
        <MDEditor
          value={content}
          onChange={(val) => onChange(val || '')}
          preview="edit"
          hideToolbar={false}
          height="100%"
          visibleDragbar={false}
          textareaProps={{
            placeholder,
          }}
        />
      </div>
    </div>
  )
}
