import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import ArtifactsPage from './pages/ArtifactsPage'
import ArtifactEditorPage from './pages/ArtifactEditorPage'
import CollectionsPage from './pages/CollectionsPage'
import TodosPage from './pages/TodosPage'
import LinksPage from './pages/LinksPage'
import InboxPage from './pages/InboxPage'
import EventsPage from './pages/EventsPage'
import ListenersPage from './pages/ListenersPage'
import PublicArtifactPage from './pages/PublicArtifactPage'
import StandaloneArtifactPage from './pages/StandaloneArtifactPage'
import FilesPage from './pages/FilesPage'
import SkillsPage from './pages/SkillsPage'
import WebhooksPage from './pages/WebhooksPage'
import ToolsPage from './pages/ToolsPage'
import TablesPage from './pages/TablesPage'
import ForgePage from './pages/ForgePage'
import GuardrailsPage from './pages/GuardrailsPage'
import EvalsPage from './pages/EvalsPage'
import VaultPage from './pages/VaultPage'
import SecurityPage from './pages/SecurityPage'
import AgentsPage from './pages/AgentsPage'
import LoopsPage from './pages/LoopsPage'
import ActivityPage from './pages/ActivityPage'
import ApiPage from './pages/ApiPage'
import UsagePage from './pages/UsagePage'
import FeedbackPage from './pages/FeedbackPage'
import FeaturesPage from './pages/FeaturesPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  const { loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <div className="animate-pulse text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/share/a/:slug" element={<PublicArtifactPage />} />
      <Route path="/p/:slug" element={<StandaloneArtifactPage />} />

      {/* Authenticated app */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home" element={<HomePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:conversationId" element={<ChatPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="artifacts" element={<ArtifactsPage />} />
        <Route path="artifacts/:artifactId" element={<ArtifactEditorPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="collections/:collectionId" element={<CollectionsPage />} />
        <Route path="collections/:collectionId/:kindSlug/:itemId" element={<CollectionsPage />} />
        <Route path="todos" element={<TodosPage />} />
        <Route path="todos/:todoId" element={<TodosPage />} />
        <Route path="links" element={<LinksPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="tables" element={<TablesPage />} />
        <Route path="forge" element={<ForgePage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="evals" element={<EvalsPage />} />
        <Route path="vault" element={<VaultPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="loops" element={<LoopsPage />} />
        <Route path="listeners" element={<ListenersPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="api" element={<ApiPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="features" element={<FeaturesPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
