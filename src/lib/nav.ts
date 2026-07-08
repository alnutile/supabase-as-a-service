// Single source of truth for the sidebar navigation.
//
// Layout renders it, the ⌘K palette (GlobalSearch) jumps to its pages, and the
// Feature Flags settings area lists its flaggable items — so all three stay in
// sync. Each item has a stable `key` used as its feature-flag key: a
// `feature_flags` row `{key, enabled:false}` hides that area workspace-wide
// (see migration 0065). ABSENCE of a row = enabled.
//
// `alwaysOn` items (Home, Chat, and everything under Settings) can never be
// hidden by a flag, so an admin can't lock themselves out of the page that
// manages the flags. `adminOnly` items are visibility gating (only admins see
// them at all) — orthogonal to feature flags, which are about feature hiding.

import {
  ActivityIcon,
  AgentIcon,
  ApiIcon,
  ArtifactIcon,
  BoltIcon,
  ChatIcon,
  CollectionIcon,
  EvalIcon,
  FeedbackIcon,
  FileIcon,
  FlagIcon,
  ForgeIcon,
  GlobeIcon,
  HomeIcon,
  InboxIcon,
  LinkIcon,
  LockIcon,
  LoopIcon,
  MailIcon,
  MemoryIcon,
  PulseIcon,
  RadarIcon,
  ShieldIcon,
  SkillIcon,
  SlackIcon,
  SparkleIcon,
  TableIcon,
  TodoIcon,
  ToolIcon,
  UsageIcon,
  UsersIcon,
  WebhookIcon,
  type IconProps,
} from '../components/icons'

export type NavItem = {
  to: string
  label: string
  /** Stable feature-flag key (also used as a React key). */
  key: string
  icon: (p: IconProps) => JSX.Element
  end?: boolean
  /** Only admins ever see this item. */
  adminOnly?: boolean
  /** Cannot be hidden by a feature flag (core navigation). */
  alwaysOn?: boolean
  /** Extra search terms for the ⌘K palette. */
  keywords?: string
}

export type NavGroup = { label: string | null; items: NavItem[] }

// Main feature areas. The Settings group is separate (below) because it holds
// account/config areas rather than features, and is always shown.
export const navGroups: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/home', label: 'Home', key: 'home', icon: HomeIcon, alwaysOn: true, keywords: 'dashboard' },
      { to: '/chat', label: 'Chat', key: 'chat', icon: ChatIcon, alwaysOn: true, keywords: 'ai assistant conversation' },
      { to: '/inbox', label: 'Inbox', key: 'inbox', icon: InboxIcon, keywords: 'messages email slack whatsapp unified' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { to: '/collections', label: 'Collections', key: 'collections', icon: CollectionIcon },
      { to: '/files', label: 'Files', key: 'files', icon: FileIcon, keywords: 'upload storage pdf' },
      { to: '/tables', label: 'Tables', key: 'tables', icon: TableIcon, keywords: 'data spreadsheet' },
      { to: '/artifacts', label: 'Artifacts', key: 'artifacts', icon: ArtifactIcon, keywords: 'documents docs' },
      { to: '/todos', label: 'To-dos', key: 'todos', icon: TodoIcon, keywords: 'tasks todo' },
      { to: '/links', label: 'Links', key: 'links', icon: LinkIcon, keywords: 'bookmarks' },
      { to: '/memory', label: 'Memory', key: 'memory', icon: MemoryIcon, keywords: 'remember facts personal assistant recall' },
      { to: '/skills', label: 'Skills', key: 'skills', icon: SkillIcon, keywords: 'prompts' },
    ],
  },
  {
    label: 'Automation',
    items: [
      { to: '/agents', label: 'Agents', key: 'agents', icon: AgentIcon },
      { to: '/listeners', label: 'Listeners', key: 'listeners', icon: BoltIcon, keywords: 'automation events rules triggers' },
      { to: '/events', label: 'Events', key: 'events', icon: PulseIcon, keywords: 'automation stream feed' },
      { to: '/loops', label: 'Loops', key: 'loops', icon: LoopIcon },
      { to: '/tools', label: 'Tools', key: 'tools', icon: ToolIcon },
      { to: '/forge', label: 'Forge', key: 'forge', icon: ForgeIcon, adminOnly: true, keywords: 'functions deploy' },
    ],
  },
  {
    label: 'Connections',
    items: [
      { to: '/webhooks', label: 'Webhooks', key: 'webhooks', icon: WebhookIcon },
      { to: '/api', label: 'API', key: 'api', icon: ApiIcon, keywords: 'rest curl tokens' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/activity', label: 'Activity', key: 'activity', icon: ActivityIcon, keywords: 'log feed' },
      { to: '/usage', label: 'Usage', key: 'usage', icon: UsageIcon, adminOnly: true, keywords: 'cost spend tokens' },
      { to: '/feedback', label: 'Feedback', key: 'feedback', icon: FeedbackIcon, adminOnly: true },
      { to: '/features', label: 'Features', key: 'features', icon: SparkleIcon, keywords: 'roadmap board' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/guardrails', label: 'Guardrails', key: 'guardrails', icon: ShieldIcon, adminOnly: true },
      { to: '/security', label: 'Security', key: 'security', icon: RadarIcon, adminOnly: true },
      { to: '/evals', label: 'Evals', key: 'evals', icon: EvalIcon, adminOnly: true },
      { to: '/vault', label: 'Secrets', key: 'vault', icon: LockIcon, adminOnly: true, keywords: 'vault keys' },
    ],
  },
]

// The Settings section. Its items are config/account areas, never features, so
// they are all `alwaysOn` (a feature flag can't hide them) and pinned to the
// bottom of the sidebar.
export const settingsGroup: NavGroup = {
  label: 'Settings',
  items: [
    { to: '/settings/profile', label: 'Profile', key: 'settings.profile', icon: UsersIcon, alwaysOn: true, keywords: 'settings account name' },
    { to: '/settings/connect', label: 'Connect Claude', key: 'settings.connect', icon: ApiIcon, alwaysOn: true, keywords: 'settings mcp token claude code' },
    { to: '/settings/models', label: 'Models', key: 'settings.models', icon: SparkleIcon, adminOnly: true, alwaysOn: true, keywords: 'settings openrouter model profile' },
    { to: '/settings/email', label: 'Email', key: 'settings.email', icon: MailIcon, adminOnly: true, alwaysOn: true, keywords: 'settings postmark resend inbound' },
    { to: '/settings/slack', label: 'Slack', key: 'settings.slack', icon: SlackIcon, adminOnly: true, alwaysOn: true, keywords: 'settings bot channel' },
    { to: '/settings/mcp', label: 'External MCP', key: 'settings.mcp', icon: GlobeIcon, adminOnly: true, alwaysOn: true, keywords: 'settings zapier server' },
    { to: '/settings/people', label: 'Invite people', key: 'settings.people', icon: UsersIcon, adminOnly: true, alwaysOn: true, keywords: 'settings invite members allowed emails' },
    { to: '/settings/feature-flags', label: 'Feature flags', key: 'settings.feature-flags', icon: FlagIcon, adminOnly: true, alwaysOn: true, keywords: 'settings hide show disable areas sidebar' },
  ],
}

export type FlagMap = Record<string, boolean>

/**
 * Is a nav item currently enabled by the feature flags? `alwaysOn` items are
 * always enabled; otherwise the item is on unless a flag explicitly sets it to
 * false (absence of a flag = enabled).
 */
export function isFeatureEnabled(item: NavItem, flags: FlagMap): boolean {
  if (item.alwaysOn) return true
  return flags[item.key] !== false
}

/**
 * Filter nav groups down to what the current viewer should see: admin-only
 * items require `isAdmin`, and non-`alwaysOn` items must be enabled by the
 * feature flags. Groups left with no visible items are dropped.
 */
export function visibleGroups(
  groups: NavGroup[],
  { flags, isAdmin }: { flags: FlagMap; isAdmin: boolean },
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => (!item.adminOnly || isAdmin) && isFeatureEnabled(item, flags),
      ),
    }))
    .filter((group) => group.items.length > 0)
}

/** Every item across the main groups + settings, flattened (for the palette). */
export function allNavItems(): NavItem[] {
  return [...navGroups, settingsGroup].flatMap((g) => g.items)
}

/**
 * Items an admin can toggle on the Feature Flags page: everything that isn't
 * `alwaysOn`, grouped by their nav group for display.
 */
export function flaggableGroups(): NavGroup[] {
  return navGroups
    .map((group) => ({ ...group, items: group.items.filter((i) => !i.alwaysOn) }))
    .filter((group) => group.items.length > 0)
}
