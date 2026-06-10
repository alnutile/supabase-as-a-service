import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import LoginPage from './pages/LoginPage'
import ChatPage from './pages/ChatPage'
import ArtifactsPage from './pages/ArtifactsPage'
import ArtifactEditorPage from './pages/ArtifactEditorPage'
import PublicArtifactPage from './pages/PublicArtifactPage'
import FilesPage from './pages/FilesPage'
import SkillsPage from './pages/SkillsPage'
import WebhooksPage from './pages/WebhooksPage'
import ToolsPage from './pages/ToolsPage'
import AgentsPage from './pages/AgentsPage'
import ActivityPage from './pages/ActivityPage'
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
        <Route index element={<ChatPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:conversationId" element={<ChatPage />} />
        <Route path="artifacts" element={<ArtifactsPage />} />
        <Route path="artifacts/:artifactId" element={<ArtifactEditorPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
