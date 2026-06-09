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
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          owner_id: string
          role: MessageRole
          content: string
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
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
