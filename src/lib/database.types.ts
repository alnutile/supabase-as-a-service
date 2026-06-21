// Hand-written to match supabase/migrations/0001_init.sql.
// Regenerate from the live project with: npm run gen:types
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Visibility = 'private' | 'unlisted' | 'public'
export type MessageRole = 'user' | 'assistant' | 'system'
export type ArtifactType = 'markdown' | 'code' | 'html' | 'text'
export type SkillOutputMode = 'artifact' | 'reply'
export type WebhookEventStatus = 'received' | 'ok' | 'error' | 'blocked'
export type ToolKind = 'http' | 'web'

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string | null
          display_name: string | null
          avatar_url: string | null
          is_admin: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email?: string | null
          display_name?: string | null
          avatar_url?: string | null
          is_admin?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>
        Relationships: []
      }
      conversations: {
        Row: {
          id: string
          owner_id: string
          title: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          title?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['conversations']['Insert']>
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          owner_id: string
          role: MessageRole
          content: string
          attachments: Json | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          owner_id: string
          role: MessageRole
          content: string
          attachments?: Json | null
          metadata?: Json
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['messages']['Insert']>
        Relationships: []
      }
      artifacts: {
        Row: {
          id: string
          owner_id: string
          conversation_id: string | null
          title: string
          type: ArtifactType
          language: string | null
          content: string
          visibility: Visibility
          public_slug: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          conversation_id?: string | null
          title: string
          type?: ArtifactType
          language?: string | null
          content?: string
          visibility?: Visibility
          public_slug?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['artifacts']['Insert']>
        Relationships: []
      }
      files: {
        Row: {
          id: string
          owner_id: string
          bucket: string
          path: string
          name: string
          mime_type: string | null
          size_bytes: number | null
          visibility: Visibility
          public_slug: string | null
          created_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          bucket?: string
          path: string
          name: string
          mime_type?: string | null
          size_bytes?: number | null
          visibility?: Visibility
          public_slug?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['files']['Insert']>
        Relationships: []
      }
      skills: {
        Row: {
          id: string
          owner_id: string | null
          name: string
          description: string | null
          instructions: string
          output_mode: SkillOutputMode
          artifact_type: ArtifactType
          auto_apply: boolean
          is_builtin: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id?: string | null
          name: string
          description?: string | null
          instructions?: string
          output_mode?: SkillOutputMode
          artifact_type?: ArtifactType
          auto_apply?: boolean
          is_builtin?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['skills']['Insert']>
        Relationships: []
      }
      allowed_emails: {
        Row: {
          email: string
          invited_by: string | null
          created_at: string
        }
        Insert: {
          email: string
          invited_by?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['allowed_emails']['Insert']>
        Relationships: []
      }
      webhooks: {
        Row: {
          id: string
          owner_id: string
          name: string
          prompt: string
          token: string
          agent_id: string | null
          tool_id: string | null
          allow_tools: boolean
          is_active: boolean
          secret: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          prompt?: string
          token?: string
          agent_id?: string | null
          tool_id?: string | null
          allow_tools?: boolean
          is_active?: boolean
          secret?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['webhooks']['Insert']>
        Relationships: []
      }
      webhook_events: {
        Row: {
          id: string
          webhook_id: string
          status: WebhookEventStatus
          payload: Json | null
          result: string | null
          error: string | null
          created_at: string
        }
        Insert: {
          id?: string
          webhook_id: string
          status?: WebhookEventStatus
          payload?: Json | null
          result?: string | null
          error?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['webhook_events']['Insert']>
        Relationships: []
      }
      tools: {
        Row: {
          id: string
          name: string
          description: string
          input_schema: Json
          kind: ToolKind
          config: Json
          is_active: boolean
          is_builtin: boolean
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string
          input_schema?: Json
          kind?: ToolKind
          config?: Json
          is_active?: boolean
          is_builtin?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['tools']['Insert']>
        Relationships: []
      }
      forged_functions: {
        Row: {
          id: string
          slug: string
          name: string
          spec: string
          source: string
          model: string | null
          input_schema: Json
          status: string
          deploy_error: string | null
          invoke_token: string
          tool_id: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          slug: string
          name: string
          spec?: string
          source: string
          model?: string | null
          input_schema?: Json
          status?: string
          deploy_error?: string | null
          invoke_token?: string
          tool_id?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['forged_functions']['Insert']>
        Relationships: []
      }
      activity_log: {
        Row: {
          id: string
          type: string
          summary: string
          detail: Json | null
          actor_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          type: string
          summary: string
          detail?: Json | null
          actor_id?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['activity_log']['Insert']>
        Relationships: []
      }
      usage_events: {
        Row: {
          id: string
          context: string
          model: string
          prompt_tokens: number
          completion_tokens: number
          total_tokens: number
          cost: number | null
          reasoning_tokens: number
          cached_tokens: number
          actor_id: string | null
          agent_id: string | null
          detail: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          context: string
          model: string
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
          cost?: number | null
          reasoning_tokens?: number
          cached_tokens?: number
          actor_id?: string | null
          agent_id?: string | null
          detail?: Json | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['usage_events']['Insert']>
        Relationships: []
      }
      message_feedback: {
        Row: {
          id: string
          message_id: string
          conversation_id: string | null
          owner_id: string
          rating: 'up' | 'down'
          category: string | null
          note: string | null
          agent_id: string | null
          context: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          message_id: string
          conversation_id?: string | null
          owner_id: string
          rating: 'up' | 'down'
          category?: string | null
          note?: string | null
          agent_id?: string | null
          context?: Json
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['message_feedback']['Insert']>
        Relationships: []
      }
      agents: {
        Row: {
          id: string
          owner_id: string
          name: string
          description: string
          instructions: string
          tool_ids: string[]
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          description?: string
          instructions?: string
          tool_ids?: string[]
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['agents']['Insert']>
        Relationships: []
      }
      mcp_tokens: {
        Row: {
          id: string
          owner_id: string
          name: string
          token: string
          last_used_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name?: string
          token?: string
          last_used_at?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['mcp_tokens']['Insert']>
        Relationships: []
      }
      schedules: {
        Row: {
          id: string
          owner_id: string
          agent_id: string
          input: string
          interval_minutes: number
          is_active: boolean
          last_run_at: string | null
          next_run_at: string
          created_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          agent_id: string
          input?: string
          interval_minutes?: number
          is_active?: boolean
          last_run_at?: string | null
          next_run_at?: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['schedules']['Insert']>
        Relationships: []
      }
      documents: {
        Row: {
          id: string
          owner_id: string
          file_id: string | null
          name: string
          status: string
          scope: string
          source: string
          source_ref: string | null
          error: string | null
          chunk_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          file_id?: string | null
          name: string
          status?: string
          scope?: string
          source?: string
          source_ref?: string | null
          error?: string | null
          chunk_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['documents']['Insert']>
        Relationships: []
      }
      github_sources: {
        Row: {
          id: string
          owner_id: string
          name: string
          repo: string
          branch: string
          include_globs: string[]
          ingest_issues: boolean
          scope: string
          token: string
          secret: string | null
          pat_secret_id: string | null
          is_active: boolean
          last_synced_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name?: string
          repo?: string
          branch?: string
          include_globs?: string[]
          ingest_issues?: boolean
          scope?: string
          token?: string
          secret?: string | null
          pat_secret_id?: string | null
          is_active?: boolean
          last_synced_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['github_sources']['Insert']>
        Relationships: []
      }
      github_events: {
        Row: {
          id: string
          source_id: string
          event_type: string
          status: string
          summary: string | null
          detail: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          source_id: string
          event_type: string
          status: string
          summary?: string | null
          detail?: Json | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['github_events']['Insert']>
        Relationships: []
      }
      document_chunks: {
        Row: {
          id: string
          document_id: string
          owner_id: string
          idx: number
          content: string
          embedding: string | null
          created_at: string
        }
        Insert: {
          id?: string
          document_id: string
          owner_id: string
          idx: number
          content: string
          embedding?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['document_chunks']['Insert']>
        Relationships: []
      }
      model_profiles: {
        Row: {
          id: string
          key: string
          name: string
          description: string
          provider: string
          model: string
          is_builtin: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          key: string
          name: string
          description?: string
          provider?: string
          model: string
          is_builtin?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['model_profiles']['Insert']>
        Relationships: []
      }
      guardrails: {
        Row: {
          id: string
          name: string
          instructions: string
          applies_to_webhooks: boolean
          applies_to_chat: boolean
          action: 'block' | 'flag'
          is_active: boolean
          is_builtin: boolean
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          instructions: string
          applies_to_webhooks?: boolean
          applies_to_chat?: boolean
          action?: 'block' | 'flag'
          is_active?: boolean
          is_builtin?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['guardrails']['Insert']>
        Relationships: []
      }
      plugins: {
        Row: {
          id: string
          slug: string
          name: string
          description: string | null
          category: string | null
          source_url: string | null
          enabled: boolean
          notes: string | null
          installed_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          slug: string
          name: string
          description?: string | null
          category?: string | null
          source_url?: string | null
          enabled?: boolean
          notes?: string | null
          installed_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['plugins']['Insert']>
        Relationships: []
      }
      integrations: {
        Row: {
          id: string
          kind: 'email'
          provider: 'postmark' | 'resend'
          from_address: string
          inbound_token: string | null
          allowed_recipients: string[] | null
          secret_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          kind: 'email'
          provider: 'postmark' | 'resend'
          from_address: string
          inbound_token?: string | null
          allowed_recipients?: string[] | null
          secret_id: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['integrations']['Insert']>
        Relationships: []
      }
      inbox_messages: {
        Row: {
          id: string
          from_address: string
          to_address: string | null
          subject: string
          body_text: string
          received_at: string
          read_at: string | null
          raw: Json | null
        }
        Insert: {
          id?: string
          from_address: string
          to_address?: string | null
          subject?: string
          body_text?: string
          received_at?: string
          read_at?: string | null
          raw?: Json | null
        }
        Update: Partial<Database['public']['Tables']['inbox_messages']['Insert']>
        Relationships: []
      }
      eval_suites: {
        Row: {
          id: string
          name: string
          description: string
          target_kind: string
          agent_id: string | null
          rubric: string
          judge_model: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string
          target_kind?: string
          agent_id?: string | null
          rubric?: string
          judge_model?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['eval_suites']['Insert']>
        Relationships: []
      }
      eval_cases: {
        Row: {
          id: string
          suite_id: string
          name: string
          input: string
          expected: string | null
          assertions: Json
          created_at: string
        }
        Insert: {
          id?: string
          suite_id: string
          name?: string
          input: string
          expected?: string | null
          assertions?: Json
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['eval_cases']['Insert']>
        Relationships: []
      }
      eval_runs: {
        Row: {
          id: string
          suite_id: string
          model: string | null
          status: string
          total: number
          passed: number
          score: number | null
          cost: number | null
          error: string | null
          triggered_by: string | null
          created_at: string
          finished_at: string | null
        }
        Insert: {
          id?: string
          suite_id: string
          model?: string | null
          status?: string
          total?: number
          passed?: number
          score?: number | null
          cost?: number | null
          error?: string | null
          triggered_by?: string | null
          created_at?: string
          finished_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['eval_runs']['Insert']>
        Relationships: []
      }
      eval_results: {
        Row: {
          id: string
          run_id: string
          case_id: string | null
          case_name: string
          passed: boolean
          score: number | null
          output: string | null
          detail: Json | null
          latency_ms: number | null
          created_at: string
        }
        Insert: {
          id?: string
          run_id: string
          case_id?: string | null
          case_name?: string
          passed?: boolean
          score?: number | null
          output?: string | null
          detail?: Json | null
          latency_ms?: number | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['eval_results']['Insert']>
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      set_email_integration: {
        Args: {
          p_provider: string
          p_from_address: string
          p_api_key: string
          p_allowed_recipients?: string[] | null
        }
        Returns: undefined
      }
      email_is_configured: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      set_github_source_pat: {
        Args: {
          p_source_id: string
          p_pat: string
        }
        Returns: undefined
      }
      usage_summary: {
        Args: { p_days?: number }
        Returns: Json
      }
      feedback_summary: {
        Args: { p_days?: number }
        Returns: Json
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
