import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { isMac, openGlobalSearch } from '../components/GlobalSearch'
import {
  ActivityIcon,
  AgentIcon,
  ArrowRightIcon,
  ArtifactIcon,
  ChatIcon,
  FileIcon,
  ForgeIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SkillIcon,
  SparkleIcon,
  ToolIcon,
  UploadIcon,
  UsageIcon,
  WebhookIcon,
  type IconProps,
} from '../components/icons'

type Card = {
  to: string
  title: string
  desc: string
  icon: (p: IconProps) => JSX.Element
  adminOnly?: boolean
}

const CARDS: Card[] = [
  { to: '/chat', title: 'Chat', icon: ChatIcon, desc: 'Chat with your AI — bring in your tools, skills and uploaded files, and work alongside teammates in a shared thread.' },
  { to: '/agents', title: 'Agents', icon: AgentIcon, desc: 'Processes that run on a schedule — every few minutes, hourly or daily — with the tools and skills they need to get the job done on their own.' },
  { to: '/artifacts', title: 'Artifacts', icon: ArtifactIcon, desc: 'As your team builds items and documents, save them all here and share any one of them with a hosted link.' },
  { to: '/skills', title: 'Skills', icon: SkillIcon, desc: 'Organize the documents that teach the AI how your team likes work done, and update them whenever things change.' },
  { to: '/tools', title: 'Tools', icon: ToolIcon, desc: 'Capabilities the AI can call to get work done. A handful come built in — and you’ll find plenty more that are easy to make.' },
  { to: '/forge', title: 'Forge', icon: ForgeIcon, adminOnly: true, desc: 'Build the more complex, deterministic functions the AI can lean on. A calculator is the classic example: exact math beats a guess.' },
  { to: '/guardrails', title: 'Guardrails', icon: ShieldIcon, adminOnly: true, desc: 'Put guardrails in place for your business that keep certain prompts and behaviors from ever running.' },
  { to: '/webhooks', title: 'Webhooks', icon: WebhookIcon, desc: 'Take in information from other systems like an API or an event, then have an agent react to it automatically.' },
  { to: '/activity', title: 'Activity', icon: ActivityIcon, desc: 'See everything happening across your system — built for logging and troubleshooting.' },
  { to: '/usage', title: 'Usage', icon: UsageIcon, adminOnly: true, desc: 'Track the tokens being spent and the models in use, with cost insights pulled straight from OpenRouter.' },
  { to: '/files', title: 'Files', icon: FileIcon, desc: 'Every uploaded file and its indexing status — soon usable across chats so your team can build shared context.' },
  { to: '/settings', title: 'Settings', icon: SettingsIcon, desc: 'Set up your email, your OpenRouter connection for AI, and the rest of your account details.' },
]

function greetingForNow(): string {
  const hr = new Date().getHours()
  return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'
}

export default function HomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('is_admin, display_name')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsAdmin(Boolean(data?.is_admin))
        const fallback = (user.email ?? '').split('@')[0]
        const raw = (data?.display_name || fallback || '').trim()
        setName(raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '')
      })
  }, [user])

  const cards = CARDS.filter((c) => !c.adminOnly || isAdmin)

  const quick =
    'flex items-center gap-2 rounded-2xl px-5 py-3 text-[15px] font-bold transition'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1140px] px-6 py-12 sm:px-11">
        <div className="mb-8">
          <h1 className="text-[34px] font-extrabold tracking-tight text-text">
            {greetingForNow()}{name ? `, ${name}` : ''}
          </h1>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-muted">
            Here’s your workspace. Jump back into a chat, or explore what each part of your intranet
            can do.
          </p>
        </div>

        {/* Global search — opens the ⌘K palette (mounted in Layout) */}
        <button
          onClick={openGlobalSearch}
          className="mb-6 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-[14px] text-left text-[15px] text-faint shadow-soft transition hover:border-primary hover:text-muted"
        >
          <SearchIcon className="h-5 w-5 shrink-0" />
          <span className="flex-1">Search chats, artifacts, files, to-dos, links, agents…</span>
          <kbd className="rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-semibold">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>

        <div className="mb-10 flex flex-wrap gap-3">
          <button
            onClick={() => navigate('/chat')}
            className={`${quick} border-none bg-primary text-white shadow-soft hover:bg-primary-strong`}
          >
            <SparkleIcon className="h-[18px] w-[18px]" /> Start a chat
          </button>
          <button
            onClick={() => navigate('/files')}
            className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
          >
            <UploadIcon className="h-[18px] w-[18px]" /> Upload a file
          </button>
          <button
            onClick={() => navigate('/agents')}
            className={`${quick} border border-border bg-surface text-text hover:border-primary hover:text-primary`}
          >
            <AgentIcon className="h-[18px] w-[18px]" /> New agent
          </button>
        </div>

        <div className="mb-4 text-[13px] font-bold uppercase tracking-[0.08em] text-faint">
          Explore your workspace
        </div>
        <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => {
            const Icon = c.icon
            return (
              <Link
                key={c.to}
                to={c.to}
                className="group flex flex-col items-start rounded-[18px] border border-border bg-surface p-[22px] text-left shadow-soft transition hover:-translate-y-[3px] hover:border-border-strong hover:shadow-soft-lg"
              >
                <div className="mb-4 flex w-full items-center justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-primary-soft text-primary">
                    <Icon className="h-[22px] w-[22px]" />
                  </div>
                  <span className="text-faint transition group-hover:text-primary">
                    <ArrowRightIcon className="h-[18px] w-[18px]" />
                  </span>
                </div>
                <div className="mb-[7px] text-[18px] font-bold tracking-tight text-text">{c.title}</div>
                <div className="text-sm leading-relaxed text-muted">{c.desc}</div>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
