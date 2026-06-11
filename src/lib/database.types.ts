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
export type WebhookEventStatus = 'received' | 'ok' | 'error'
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
          is_active: boolean
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
          is_active?: boolean
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
          file_id: string
          name: string
          status: string
          scope: string
          error: string | null
          chunk_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          file_id: string
          name: string
          status?: string
          scope?: string
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
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
