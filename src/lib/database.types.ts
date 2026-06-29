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
export type ToolKind = 'http' | 'web' | 'builtin' | 'mcp'
export type CollectionVisibility = 'private' | 'workspace'
export type UserTableVisibility = 'private' | 'workspace'
export type UserTableColumnType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'

/** A column in a user-defined table's `columns` spec. */
export interface UserTableColumn {
  key: string
  label: string
  type: UserTableColumnType
}

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
      collections: {
        Row: {
          id: string
          owner_id: string
          name: string
          description: string
          color: string | null
          visibility: CollectionVisibility
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          description?: string
          color?: string | null
          visibility?: CollectionVisibility
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['collections']['Insert']>
        Relationships: []
      }
      collection_artifacts: {
        Row: {
          collection_id: string
          artifact_id: string
          added_by: string | null
          created_at: string
        }
        Insert: {
          collection_id: string
          artifact_id: string
          added_by?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['collection_artifacts']['Insert']>
        Relationships: []
      }
      collection_files: {
        Row: {
          collection_id: string
          file_id: string
          added_by: string | null
          created_at: string
        }
        Insert: {
          collection_id: string
          file_id: string
          added_by?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['collection_files']['Insert']>
        Relationships: []
      }
      todos: {
        Row: {
          id: string
          owner_id: string
          title: string
          notes: string
          due_date: string | null
          done: boolean
          completed_at: string | null
          position: number
          visibility: CollectionVisibility
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          title: string
          notes?: string
          due_date?: string | null
          done?: boolean
          completed_at?: string | null
          position?: number
          visibility?: CollectionVisibility
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['todos']['Insert']>
        Relationships: []
      }
      collection_todos: {
        Row: {
          collection_id: string
          todo_id: string
          added_by: string | null
          created_at: string
        }
        Insert: {
          collection_id: string
          todo_id: string
          added_by?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['collection_todos']['Insert']>
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
      user_tables: {
        Row: {
          id: string
          name: string
          description: string
          physical_name: string
          owner_id: string
          columns: Json
          visibility: UserTableVisibility
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string
          physical_name: string
          owner_id: string
          columns?: Json
          visibility?: UserTableVisibility
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['user_tables']['Insert']>
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
          collection_ids: string[]
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
          collection_ids?: string[]
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
          error?: string | null
          chunk_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['documents']['Insert']>
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
      vault_secrets: {
        Row: {
          id: string
          name: string
          description: string
          secret_id: string
          scope: 'workspace' | 'private'
          owner_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          description?: string
          secret_id: string
          scope?: 'workspace' | 'private'
          owner_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['vault_secrets']['Insert']>
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
          kind: 'email' | 'mcp'
          provider: 'postmark' | 'resend' | null
          from_address: string | null
          inbound_token: string | null
          allowed_recipients: string[] | null
          secret_id: string
          config: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          kind: 'email' | 'mcp'
          provider?: 'postmark' | 'resend' | null
          from_address?: string | null
          inbound_token?: string | null
          allowed_recipients?: string[] | null
          secret_id: string
          config?: Json
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['integrations']['Insert']>
        Relationships: []
      }
      mcp_servers: {
        Row: {
          id: string
          label: string
          url: string
          secret_id: string
          owner_id: string | null
          scope: 'workspace' | 'private'
          tool_id: string | null
          cached_tools: Json
          cached_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          label: string
          url: string
          secret_id: string
          owner_id?: string | null
          scope?: 'workspace' | 'private'
          tool_id?: string | null
          cached_tools?: Json
          cached_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['mcp_servers']['Insert']>
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
      loops: {
        Row: {
          id: string
          owner_id: string
          name: string
          goal: string
          agent_id: string
          feedback_tool_id: string | null
          rubric: string
          max_iterations: number
          budget_usd: number
          target_score: number | null
          visibility: Visibility
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          goal?: string
          agent_id: string
          feedback_tool_id?: string | null
          rubric?: string
          max_iterations?: number
          budget_usd?: number
          target_score?: number | null
          visibility?: Visibility
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['loops']['Insert']>
        Relationships: []
      }
      loop_runs: {
        Row: {
          id: string
          loop_id: string
          status: string
          stop_reason: string | null
          iterations: number
          cost_spent: number
          best_score: number | null
          best_output: string | null
          transcript: Json
          error: string | null
          triggered_by: string | null
          started_at: string
          ended_at: string | null
        }
        Insert: {
          id?: string
          loop_id: string
          status?: string
          stop_reason?: string | null
          iterations?: number
          cost_spent?: number
          best_score?: number | null
          best_output?: string | null
          transcript?: Json
          error?: string | null
          triggered_by?: string | null
          started_at?: string
          ended_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['loop_runs']['Insert']>
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
      set_mcp_server: {
        Args: {
          p_id: string | null
          p_label: string
          p_url: string
          p_token: string
        }
        Returns: string
      }
      delete_mcp_server: {
        Args: { p_id: string }
        Returns: undefined
      }
      set_vault_secret: {
        Args: {
          p_id: string | null
          p_name: string
          p_description: string
          p_value: string
          p_scope?: string
        }
        Returns: string
      }
      delete_vault_secret: {
        Args: { p_id: string }
        Returns: undefined
      }
      read_vault_secret: {
        Args: { p_name: string; p_user_id: string | null }
        Returns: string
      }
      usage_summary: {
        Args: { p_days?: number }
        Returns: Json
      }
      feedback_summary: {
        Args: { p_days?: number }
        Returns: Json
      }
      collection_token_stats: {
        Args: Record<PropertyKey, never>
        Returns: { collection_id: string; artifact_count: number; char_total: number }[]
      }
      collections_combined_chars: {
        Args: { p_ids: string[] }
        Returns: number
      }
      create_user_table: {
        Args: {
          p_name: string
          p_columns?: Json
          p_visibility?: string
          p_owner?: string | null
        }
        Returns: Database['public']['Tables']['user_tables']['Row']
      }
      add_user_column: {
        Args: { p_table_id: string; p_key: string; p_type?: string; p_label?: string | null }
        Returns: Database['public']['Tables']['user_tables']['Row']
      }
      drop_user_column: {
        Args: { p_table_id: string; p_key: string }
        Returns: Database['public']['Tables']['user_tables']['Row']
      }
      update_user_table: {
        Args: {
          p_table_id: string
          p_name?: string | null
          p_description?: string | null
          p_visibility?: string | null
        }
        Returns: Database['public']['Tables']['user_tables']['Row']
      }
      drop_user_table: {
        Args: { p_table_id: string }
        Returns: undefined
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
