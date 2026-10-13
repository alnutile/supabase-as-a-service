import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import { resolveImageUrl } from '../lib/artifactImageSync'

// A private artifact image's baked-in signed URL expires after a week; re-sign it
// on display so old content keeps rendering. Other images pass straight through.
function StorageImage({ src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const [resolved, setResolved] = useState(src)
  useEffect(() => {
    setResolved(src)
    if (typeof src !== 'string') return
    let live = true
    resolveImageUrl(src)?.then((url) => {
      if (live && url) setResolved(url)
    })
    return () => {
      live = false
    }
  }, [src])
  return <img src={resolved} alt={alt ?? ''} {...rest} />
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => {
            // Internal links (e.g. /artifacts/:id) navigate without a full reload.
            if (href && href.startsWith('/')) {
              return <Link to={href}>{children}</Link>
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            )
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          img: ({ node, ...props }) => <StorageImage {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
