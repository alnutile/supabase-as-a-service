import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import ArtifactsPage from './pages/ArtifactsPage'
import ArtifactEditorPage from './pages/ArtifactEditorPage'
import TodosPage from './pages/TodosPage'
import PublicArtifactPage from './pages/PublicArtifactPage'
import FilesPage from './pages/FilesPage'
import SkillsPage from './pages/SkillsPage'
import WebhooksPage from './pages/WebhooksPage'
import ToolsPage from './pages/ToolsPage'
import TablesPage from './pages/TablesPage'
import ForgePage from './pages/ForgePage'
import GuardrailsPage from './pages/GuardrailsPage'
import EvalsPage from './pages/EvalsPage'
import VaultPage from './pages/VaultPage'
import AgentsPage from './pages/AgentsPage'
import LoopsPage from './pages/LoopsPage'
import PluginsPage from './pages/PluginsPage'
import ActivityPage from './pages/ActivityPage'
import ApiPage from './pages/ApiPage'
import UsagePage from './pages/UsagePage'
import FeedbackPage from './pages/FeedbackPage'
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
        <Route path="artifacts" element={<ArtifactsPage />} />
        <Route path="artifacts/:artifactId" element={<ArtifactEditorPage />} />
        <Route path="todos" element={<TodosPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="tables" element={<TablesPage />} />
        <Route path="forge" element={<ForgePage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="evals" element={<EvalsPage />} />
        <Route path="vault" element={<VaultPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="loops" element={<LoopsPage />} />
        <Route path="plugins" element={<PluginsPage />} />
        <Route path="api" element={<ApiPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
