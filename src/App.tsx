import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import ArtifactsPage from './pages/ArtifactsPage'
import ArtifactEditorPage from './pages/ArtifactEditorPage'
import WhiteboardsPage from './pages/WhiteboardsPage'
// Excalidraw is large — keep the editor out of the initial bundle (lazy chunk).
const WhiteboardEditorPage = lazy(() => import('./pages/WhiteboardEditorPage'))
import CardBoardsPage from './pages/CardBoardsPage'
import CardBoardEditorPage from './pages/CardBoardEditorPage'
import CollectionsPage from './pages/CollectionsPage'
import TodosPage from './pages/TodosPage'
import LinksPage from './pages/LinksPage'
import MemoryPage from './pages/MemoryPage'
import MeetingNotesPage from './pages/MeetingNotesPage'
import TerminologyPage from './pages/TerminologyPage'
import PublicArtifactPage from './pages/PublicArtifactPage'
import StandaloneArtifactPage from './pages/StandaloneArtifactPage'
import FilesPage from './pages/FilesPage'
import SkillsPage from './pages/SkillsPage'
import TablesPage from './pages/TablesPage'
import GuardrailsPage from './pages/GuardrailsPage'
import EvalsPage from './pages/EvalsPage'
import VaultPage from './pages/VaultPage'
import SecurityPage from './pages/SecurityPage'
import ActivityPage from './pages/ActivityPage'
import UsagePage from './pages/UsagePage'
import ProfileSettings from './pages/settings/ProfileSettings'
import ConnectClaudeSettings from './pages/settings/ConnectClaudeSettings'
import ModelsSettings from './pages/settings/ModelsSettings'
import TimezoneSettings from './pages/settings/TimezoneSettings'
import OrganizationSettings from './pages/settings/OrganizationSettings'
import McpSettings from './pages/settings/McpSettings'
import FeatureFlagsSettings from './pages/settings/FeatureFlagsSettings'

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
        <Route path="artifacts" element={<ArtifactsPage />} />
        <Route path="artifacts/:artifactId" element={<ArtifactEditorPage />} />
        <Route path="whiteboards" element={<WhiteboardsPage />} />
        <Route
          path="whiteboards/:whiteboardId"
          element={
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-faint">Loading editor…</div>
              }
            >
              <WhiteboardEditorPage />
            </Suspense>
          }
        />
        <Route path="cards" element={<CardBoardsPage />} />
        <Route path="cards/:boardId" element={<CardBoardEditorPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="collections/:collectionId" element={<CollectionsPage />} />
        <Route path="collections/:collectionId/:kindSlug/:itemId" element={<CollectionsPage />} />
        <Route path="todos" element={<TodosPage />} />
        <Route path="todos/:todoId" element={<TodosPage />} />
        <Route path="links" element={<LinksPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="meeting-notes" element={<MeetingNotesPage />} />
        <Route path="terminology" element={<TerminologyPage />} />
        <Route path="terminology/:termId" element={<TerminologyPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="tables" element={<TablesPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="evals" element={<EvalsPage />} />
        <Route path="vault" element={<VaultPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="settings" element={<Navigate to="/settings/profile" replace />} />
        <Route path="settings/profile" element={<ProfileSettings />} />
        <Route path="settings/connect" element={<ConnectClaudeSettings />} />
        <Route path="settings/models" element={<ModelsSettings />} />
        <Route path="settings/timezone" element={<TimezoneSettings />} />
        <Route path="settings/organization" element={<OrganizationSettings />} />
        <Route path="settings/mcp" element={<McpSettings />} />
        <Route path="settings/feature-flags" element={<FeatureFlagsSettings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
