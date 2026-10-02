export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_call_views: {
        Row: {
          agent_id: string
          agent_name: string
          customer_phone: string
          expires_at: string
          id: string
          last_heartbeat_at: string
          opened_at: string
          taken_from_status: string[]
          taken_order_ids: string[]
        }
        Insert: {
          agent_id: string
          agent_name: string
          customer_phone: string
          expires_at?: string
          id?: string
          last_heartbeat_at?: string
          opened_at?: string
          taken_from_status?: string[]
          taken_order_ids?: string[]
        }
        Update: {
          agent_id?: string
          agent_name?: string
          customer_phone?: string
          expires_at?: string
          id?: string
          last_heartbeat_at?: string
          opened_at?: string
          taken_from_status?: string[]
          taken_order_ids?: string[]
        }
        Relationships: []
      }
      ads_audit_logs: {
        Row: {
          action: string
          campaign_id: string | null
          created_at: string
          details: string | null
          id: string
          performed_by: string
        }
        Insert: {
          action: string
          campaign_id?: string | null
          created_at?: string
          details?: string | null
          id?: string
          performed_by: string
        }
        Update: {
          action?: string
          campaign_id?: string | null
          created_at?: string
          details?: string | null
          id?: string
          performed_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "ads_audit_logs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "ads_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      ads_campaigns: {
        Row: {
          assigned_leads: string[] | null
          assigned_products: string[] | null
          budget: number
          campaign_name: string
          clicks: number
          conversions: number
          created_at: string
          id: string
          impressions: number
          notes: string | null
          platform: string
          spent: number
          status: string
          updated_at: string
        }
        Insert: {
          assigned_leads?: string[] | null
          assigned_products?: string[] | null
          budget?: number
          campaign_name: string
          clicks?: number
          conversions?: number
          created_at?: string
          id?: string
          impressions?: number
          notes?: string | null
          platform?: string
          spent?: number
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_leads?: string[] | null
          assigned_products?: string[] | null
          budget?: number
          campaign_name?: string
          clicks?: number
          conversions?: number
          created_at?: string
          id?: string
          impressions?: number
          notes?: string | null
          platform?: string
          spent?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string
          created_at: string
          id: string
          payload: Json
          target_id: string | null
          target_name: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id: string
          created_at?: string
          id?: string
          payload?: Json
          target_id?: string | null
          target_name?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string
          created_at?: string
          id?: string
          payload?: Json
          target_id?: string | null
          target_name?: string | null
          target_type?: string | null
        }
        Relationships: []
      }
      bg_settlements: {
        Row: {
          created_at: string
          id: string
          municipality: string | null
          name: string
          name_en: string | null
          name_lc: string
          post_code: string | null
          region: string | null
        }
        Insert: {
          created_at?: string
          id: string
          municipality?: string | null
          name: string
          name_en?: string | null
          name_lc: string
          post_code?: string | null
          region?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          municipality?: string | null
          name?: string
          name_en?: string | null
          name_lc?: string
          post_code?: string | null
          region?: string | null
        }
        Relationships: []
      }
      blocked_login_attempts: {
        Row: {
          attempt_time: string
          created_at: string
          id: string
          reason: string
          role: string
          user_id: string
          user_name: string
        }
        Insert: {
          attempt_time?: string
          created_at?: string
          id?: string
          reason?: string
          role?: string
          user_id: string
          user_name?: string
        }
        Update: {
          attempt_time?: string
          created_at?: string
          id?: string
          reason?: string
          role?: string
          user_id?: string
          user_name?: string
        }
        Relationships: []
      }
      call_logs: {
        Row: {
          agent_id: string
          connected_at: string | null
          connection_state: string | null
          context_id: string
          context_type: string
          created_at: string
          customer_phone: string | null
          ended_at: string | null
          id: string
          notes: string | null
          outcome: string
          ring_seconds: number | null
          started_at: string | null
          talk_seconds: number | null
          total_seconds: number | null
        }
        Insert: {
          agent_id: string
          connected_at?: string | null
          connection_state?: string | null
          context_id: string
          context_type: string
          created_at?: string
          customer_phone?: string | null
          ended_at?: string | null
          id?: string
          notes?: string | null
          outcome: string
          ring_seconds?: number | null
          started_at?: string | null
          talk_seconds?: number | null
          total_seconds?: number | null
        }
        Update: {
          agent_id?: string
          connected_at?: string | null
          connection_state?: string | null
          context_id?: string
          context_type?: string
          created_at?: string
          customer_phone?: string | null
          ended_at?: string | null
          id?: string
          notes?: string | null
          outcome?: string
          ring_seconds?: number | null
          started_at?: string | null
          talk_seconds?: number | null
          total_seconds?: number | null
        }
        Relationships: []
      }
      call_script_versions: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          created_at: string
          id: number
          note: string | null
          script_id: string
          snapshot: Json
          version: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: number
          note?: string | null
          script_id: string
          snapshot: Json
          version: number
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: number
          note?: string | null
          script_id?: string
          snapshot?: Json
          version?: number
        }
        Relationships: []
      }
      call_scripts: {
        Row: {
          context_type: string
          copied_from: string | null
          created_at: string
          created_by: string | null
          description: string | null
          groups: string[]
          helpers: Json
          id: string
          priority: number
          product_ids: string[]
          published_at: string | null
          published_by: string | null
          script_text: string
          sections: Json
          status: string
          title: string
          translations: Json
          updated_at: string
          updated_by: string | null
          version: number
        }
        Insert: {
          context_type: string
          copied_from?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          groups?: string[]
          helpers?: Json
          id?: string
          priority?: number
          product_ids?: string[]
          published_at?: string | null
          published_by?: string | null
          script_text?: string
          sections?: Json
          status?: string
          title?: string
          translations?: Json
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Update: {
          context_type?: string
          copied_from?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          groups?: string[]
          helpers?: Json
          id?: string
          priority?: number
          product_ids?: string[]
          published_at?: string | null
          published_by?: string | null
          script_text?: string
          sections?: Json
          status?: string
          title?: string
          translations?: Json
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Relationships: []
      }
      courier_offices: {
        Row: {
          address: string
          city: string
          city_normalized: string
          courier: string
          hours: string
          id: string
          is_active: boolean
          lat: number | null
          lng: number | null
          name: string
          office_code: string
          post_code: string
          refreshed_at: string
        }
        Insert: {
          address?: string
          city: string
          city_normalized: string
          courier: string
          hours?: string
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          office_code: string
          post_code?: string
          refreshed_at?: string
        }
        Update: {
          address?: string
          city?: string
          city_normalized?: string
          courier?: string
          hours?: string
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          office_code?: string
          post_code?: string
          refreshed_at?: string
        }
        Relationships: []
      }
      customer_profiles: {
        Row: {
          apartment: string | null
          birthday: string | null
          block: string | null
          city: string | null
          courier_office_city: string | null
          courier_office_code: string | null
          courier_office_name: string | null
          created_at: string
          customer_name: string | null
          delivery_instructions: string | null
          delivery_type: string | null
          entry: string | null
          floor: string | null
          gift_note: string | null
          home_courier: string | null
          notes: string | null
          phone: string
          postal_code: string | null
          quarter: string | null
          street: string | null
          street_number: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          apartment?: string | null
          birthday?: string | null
          block?: string | null
          city?: string | null
          courier_office_city?: string | null
          courier_office_code?: string | null
          courier_office_name?: string | null
          created_at?: string
          customer_name?: string | null
          delivery_instructions?: string | null
          delivery_type?: string | null
          entry?: string | null
          floor?: string | null
          gift_note?: string | null
          home_courier?: string | null
          notes?: string | null
          phone: string
          postal_code?: string | null
          quarter?: string | null
          street?: string | null
          street_number?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          apartment?: string | null
          birthday?: string | null
          block?: string | null
          city?: string | null
          courier_office_city?: string | null
          courier_office_code?: string | null
          courier_office_name?: string | null
          created_at?: string
          customer_name?: string | null
          delivery_instructions?: string | null
          delivery_type?: string | null
          entry?: string | null
          floor?: string | null
          gift_note?: string | null
          home_courier?: string | null
          notes?: string | null
          phone?: string
          postal_code?: string | null
          quarter?: string | null
          street?: string | null
          street_number?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      financial_visibility: {
        Row: {
          id: string
          role: string
          show_cost: boolean
          show_financial_insights: boolean
          show_net_contribution: boolean
          show_profit: boolean
          show_returned_value: boolean
          updated_at: string
        }
        Insert: {
          id?: string
          role: string
          show_cost?: boolean
          show_financial_insights?: boolean
          show_net_contribution?: boolean
          show_profit?: boolean
          show_returned_value?: boolean
          updated_at?: string
        }
        Update: {
          id?: string
          role?: string
          show_cost?: boolean
          show_financial_insights?: boolean
          show_net_contribution?: boolean
          show_profit?: boolean
          show_returned_value?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      inbound_leads: {
        Row: {
          created_at: string
          id: string
          name: string
          phone: string
          product_name: string | null
          source: string | null
          status: string
          updated_at: string
          webhook_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          phone?: string
          product_name?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          webhook_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          phone?: string
          product_name?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          webhook_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_leads_webhook_id_fkey"
            columns: ["webhook_id"]
            isOneToOne: false
            referencedRelation: "webhooks"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_logs: {
        Row: {
          change_amount: number
          created_at: string
          id: string
          invoice_number: string | null
          movement_type: string | null
          new_stock: number
          notes: string | null
          previous_stock: number
          product_id: string
          reason: string
          supplier_name: string | null
          user_id: string | null
        }
        Insert: {
          change_amount: number
          created_at?: string
          id?: string
          invoice_number?: string | null
          movement_type?: string | null
          new_stock: number
          notes?: string | null
          previous_stock: number
          product_id: string
          reason?: string
          supplier_name?: string | null
          user_id?: string | null
        }
        Update: {
          change_amount?: number
          created_at?: string
          id?: string
          invoice_number?: string | null
          movement_type?: string | null
          new_stock?: number
          notes?: string | null
          previous_stock?: number
          product_id?: string
          reason?: string
          supplier_name?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_logs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_distribution_config: {
        Row: {
          id: string
          is_active: boolean
          max_leads_per_agent: number
          priority_threshold: number
          strategy: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: string
          is_active?: boolean
          max_leads_per_agent?: number
          priority_threshold?: number
          strategy?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: string
          is_active?: boolean
          max_leads_per_agent?: number
          priority_threshold?: number
          strategy?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      module_settings: {
        Row: {
          id: string
          is_enabled: boolean
          is_protected: boolean
          module_key: string
          module_label: string
          updated_at: string
        }
        Insert: {
          id?: string
          is_enabled?: boolean
          is_protected?: boolean
          module_key: string
          module_label: string
          updated_at?: string
        }
        Update: {
          id?: string
          is_enabled?: boolean
          is_protected?: boolean
          module_key?: string
          module_label?: string
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          link: string | null
          message: string
          title: string
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          link?: string | null
          message?: string
          title: string
          type?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          link?: string | null
          message?: string
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      order_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          changed_by_name: string | null
          from_status: Database["public"]["Enums"]["order_status"] | null
          id: string
          order_id: string
          to_status: Database["public"]["Enums"]["order_status"]
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          changed_by_name?: string | null
          from_status?: Database["public"]["Enums"]["order_status"] | null
          id?: string
          order_id: string
          to_status: Database["public"]["Enums"]["order_status"]
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          changed_by_name?: string | null
          from_status?: Database["public"]["Enums"]["order_status"] | null
          id?: string
          order_id?: string
          to_status?: Database["public"]["Enums"]["order_status"]
        }
        Relationships: [
          {
            foreignKeyName: "order_history_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          created_at: string
          id: string
          order_id: string
          price_per_unit: number
          product_id: string | null
          product_name: string
          quantity: number
          total_price: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          order_id: string
          price_per_unit?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          total_price?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          order_id?: string
          price_per_unit?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          total_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      order_locks: {
        Row: {
          id: string
          locked_at: string
          locked_by: string
          locked_by_name: string
          order_id: string
        }
        Insert: {
          id?: string
          locked_at?: string
          locked_by: string
          locked_by_name?: string
          order_id: string
        }
        Update: {
          id?: string
          locked_at?: string
          locked_by?: string
          locked_by_name?: string
          order_id?: string
        }
        Relationships: []
      }
      order_notes: {
        Row: {
          author_id: string | null
          author_name: string
          created_at: string
          id: string
          order_id: string
          text: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          created_at?: string
          id?: string
          order_id: string
          text: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          created_at?: string
          id?: string
          order_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_notes_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          apartment: string
          assigned_agent_id: string | null
          assigned_agent_name: string | null
          assigned_at: string | null
          assigned_by: string | null
          birthday: string | null
          block: string
          cancellation_reason: string | null
          cancellation_reason_notes: string | null
          cancelled_at: string | null
          cancelled_by_agent_id: string | null
          confirmed_at: string | null
          confirmed_by_agent_id: string | null
          confirmed_by_name: string | null
          courier_office_city: string
          courier_office_code: string
          courier_office_name: string
          created_at: string
          customer_address: string
          customer_city: string
          customer_name: string
          customer_phone: string
          delivery_instructions: string
          delivery_type: string
          display_id: string
          entry: string
          external_order_id: string | null
          external_source: string | null
          floor: string
          gift_note: string
          home_courier: string | null
          id: string
          inbound_lead_id: string | null
          postal_code: string | null
          price: number
          product_id: string | null
          product_name: string
          quantity: number
          quarter: string | null
          return_reason: string | null
          return_reason_notes: string | null
          returned_at: string | null
          ship_after_date: string | null
          source_lead_id: string | null
          source_type: string | null
          status: Database["public"]["Enums"]["order_status"]
          street: string
          street_number: string
          updated_at: string
        }
        Insert: {
          apartment?: string
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          birthday?: string | null
          block?: string
          cancellation_reason?: string | null
          cancellation_reason_notes?: string | null
          cancelled_at?: string | null
          cancelled_by_agent_id?: string | null
          confirmed_at?: string | null
          confirmed_by_agent_id?: string | null
          confirmed_by_name?: string | null
          courier_office_city?: string
          courier_office_code?: string
          courier_office_name?: string
          created_at?: string
          customer_address?: string
          customer_city?: string
          customer_name?: string
          customer_phone?: string
          delivery_instructions?: string
          delivery_type?: string
          display_id: string
          entry?: string
          external_order_id?: string | null
          external_source?: string | null
          floor?: string
          gift_note?: string
          home_courier?: string | null
          id?: string
          inbound_lead_id?: string | null
          postal_code?: string | null
          price?: number
          product_id?: string | null
          product_name: string
          quantity?: number
          quarter?: string | null
          return_reason?: string | null
          return_reason_notes?: string | null
          returned_at?: string | null
          ship_after_date?: string | null
          source_lead_id?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          street?: string
          street_number?: string
          updated_at?: string
        }
        Update: {
          apartment?: string
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          assigned_at?: string | null
          assigned_by?: string | null
          birthday?: string | null
          block?: string
          cancellation_reason?: string | null
          cancellation_reason_notes?: string | null
          cancelled_at?: string | null
          cancelled_by_agent_id?: string | null
          confirmed_at?: string | null
          confirmed_by_agent_id?: string | null
          confirmed_by_name?: string | null
          courier_office_city?: string
          courier_office_code?: string
          courier_office_name?: string
          created_at?: string
          customer_address?: string
          customer_city?: string
          customer_name?: string
          customer_phone?: string
          delivery_instructions?: string
          delivery_type?: string
          display_id?: string
          entry?: string
          external_order_id?: string | null
          external_source?: string | null
          floor?: string
          gift_note?: string
          home_courier?: string | null
          id?: string
          inbound_lead_id?: string | null
          postal_code?: string | null
          price?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          quarter?: string | null
          return_reason?: string | null
          return_reason_notes?: string | null
          returned_at?: string | null
          ship_after_date?: string | null
          source_lead_id?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          street?: string
          street_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_inbound_lead_id_fkey"
            columns: ["inbound_lead_id"]
            isOneToOne: false
            referencedRelation: "inbound_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_source_lead_id_fkey"
            columns: ["source_lead_id"]
            isOneToOne: false
            referencedRelation: "prediction_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_list_holds: {
        Row: {
          agent_id: string
          agent_name: string
          claimed_at: string
          created_at: string
          customer_name: string | null
          customer_phone: string
          escalated_at: string | null
          expires_at: string
          follow_up_by: string | null
          id: string
          reason: string
          released_at: string | null
          released_by: string | null
          released_reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          agent_name: string
          claimed_at?: string
          created_at?: string
          customer_name?: string | null
          customer_phone: string
          escalated_at?: string | null
          expires_at?: string
          follow_up_by?: string | null
          id?: string
          reason: string
          released_at?: string | null
          released_by?: string | null
          released_reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          agent_name?: string
          claimed_at?: string
          created_at?: string
          customer_name?: string | null
          customer_phone?: string
          escalated_at?: string | null
          expires_at?: string
          follow_up_by?: string | null
          id?: string
          reason?: string
          released_at?: string | null
          released_by?: string | null
          released_reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      prediction_lead_items: {
        Row: {
          created_at: string
          id: string
          lead_id: string
          price_per_unit: number
          product_id: string | null
          product_name: string
          quantity: number
          total_price: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          lead_id: string
          price_per_unit?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          total_price?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          lead_id?: string
          price_per_unit?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          total_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_lead_items_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "prediction_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_lead_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_leads: {
        Row: {
          address: string | null
          assigned_agent_id: string | null
          assigned_agent_name: string | null
          city: string | null
          created_at: string
          id: string
          list_id: string
          name: string
          notes: string | null
          price: number
          product: string | null
          quantity: number
          status: Database["public"]["Enums"]["lead_status"]
          telephone: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          city?: string | null
          created_at?: string
          id?: string
          list_id: string
          name?: string
          notes?: string | null
          price?: number
          product?: string | null
          quantity?: number
          status?: Database["public"]["Enums"]["lead_status"]
          telephone?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          city?: string | null
          created_at?: string
          id?: string
          list_id?: string
          name?: string
          notes?: string | null
          price?: number
          product?: string | null
          quantity?: number
          status?: Database["public"]["Enums"]["lead_status"]
          telephone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_leads_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "prediction_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_lists: {
        Row: {
          assigned_count: number
          id: string
          name: string
          total_records: number
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          assigned_count?: number
          id?: string
          name: string
          total_records?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          assigned_count?: number
          id?: string
          name?: string
          total_records?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      prediction_segment_lists: {
        Row: {
          category: string
          created_at: string
          description: string
          display_order: number
          id: string
          is_active: boolean
          is_static: boolean
          lifetime_min: number | null
          min_paid_count: number | null
          name: string
          recency_months_max: number | null
          recency_months_min: number | null
          single_price_max: number | null
          single_price_min: number | null
          trigger_event: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          description?: string
          display_order?: number
          id?: string
          is_active?: boolean
          is_static?: boolean
          lifetime_min?: number | null
          min_paid_count?: number | null
          name: string
          recency_months_max?: number | null
          recency_months_min?: number | null
          single_price_max?: number | null
          single_price_min?: number | null
          trigger_event: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string
          display_order?: number
          id?: string
          is_active?: boolean
          is_static?: boolean
          lifetime_min?: number | null
          min_paid_count?: number | null
          name?: string
          recency_months_max?: number | null
          recency_months_min?: number | null
          single_price_max?: number | null
          single_price_min?: number | null
          trigger_event?: string
          updated_at?: string
        }
        Relationships: []
      }
      prediction_segment_members: {
        Row: {
          assigned_agent_id: string | null
          assigned_agent_name: string | null
          assigned_at: string | null
          created_at: string
          customer_name: string | null
          customer_phone: string
          in_call_again_until: string | null
          is_completed: boolean
          last_call_at: string | null
          last_call_outcome: string | null
          last_paid_at: string | null
          lifetime_value: number
          list_id: string
          paid_count: number
          avg_package_price: number | null
          product_name: string | null
          trigger_event_at: string | null
          trigger_order_id: string | null
          trigger_price: number | null
          updated_at: string
        }
        Insert: {
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          assigned_at?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone: string
          in_call_again_until?: string | null
          is_completed?: boolean
          last_call_at?: string | null
          last_call_outcome?: string | null
          last_paid_at?: string | null
          lifetime_value?: number
          list_id: string
          paid_count?: number
          avg_package_price?: number | null
          product_name?: string | null
          trigger_event_at?: string | null
          trigger_order_id?: string | null
          trigger_price?: number | null
          updated_at?: string
        }
        Update: {
          assigned_agent_id?: string | null
          assigned_agent_name?: string | null
          assigned_at?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone?: string
          in_call_again_until?: string | null
          is_completed?: boolean
          last_call_at?: string | null
          last_call_outcome?: string | null
          last_paid_at?: string | null
          lifetime_value?: number
          list_id?: string
          paid_count?: number
          avg_package_price?: number | null
          product_name?: string | null
          trigger_event_at?: string | null
          trigger_order_id?: string | null
          trigger_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_segment_members_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "prediction_segment_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_segment_members_trigger_order_id_fkey"
            columns: ["trigger_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          barcode: string | null
          category: string | null
          cost_price: number
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          low_stock_threshold: number
          name: string
          photo_url: string | null
          price: number
          sku: string | null
          stock_quantity: number
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          barcode?: string | null
          category?: string | null
          cost_price?: number
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          low_stock_threshold?: number
          name: string
          photo_url?: string | null
          price?: number
          sku?: string | null
          stock_quantity?: number
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          barcode?: string | null
          category?: string | null
          cost_price?: number
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          low_stock_threshold?: number
          name?: string
          photo_url?: string | null
          price?: number
          sku?: string | null
          stock_quantity?: number
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          language: string
          last_seen_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id?: string
          is_active?: boolean
          language?: string
          last_seen_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          language?: string
          last_seen_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          can_create: boolean
          can_delete: boolean
          can_edit: boolean
          can_export: boolean
          can_view: boolean
          id: string
          module_key: string
          role: string
          updated_at: string
        }
        Insert: {
          can_create?: boolean
          can_delete?: boolean
          can_edit?: boolean
          can_export?: boolean
          can_view?: boolean
          id?: string
          module_key: string
          role: string
          updated_at?: string
        }
        Update: {
          can_create?: boolean
          can_delete?: boolean
          can_edit?: boolean
          can_export?: boolean
          can_view?: boolean
          id?: string
          module_key?: string
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      shift_assignments: {
        Row: {
          created_at: string
          id: string
          shift_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          shift_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          shift_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_assignments_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_breaks: {
        Row: {
          break_end: string | null
          break_start: string
          created_at: string
          id: string
          shift_date: string
          shift_id: string | null
          user_id: string
        }
        Insert: {
          break_end?: string | null
          break_start?: string
          created_at?: string
          id?: string
          shift_date: string
          shift_id?: string | null
          user_id: string
        }
        Update: {
          break_end?: string | null
          break_start?: string
          created_at?: string
          id?: string
          shift_date?: string
          shift_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_breaks_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_login_logs: {
        Row: {
          created_at: string
          id: string
          login_time: string
          logout_time: string | null
          shift_date: string
          shift_end_time: string
          shift_id: string
          shift_start_time: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          login_time?: string
          logout_time?: string | null
          shift_date: string
          shift_end_time: string
          shift_id: string
          shift_start_time: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          login_time?: string
          logout_time?: string | null
          shift_date?: string
          shift_end_time?: string
          shift_id?: string
          shift_start_time?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_login_logs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          created_at: string
          created_by: string | null
          end_time: string
          id: string
          name: string
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_time: string
          id?: string
          name: string
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_time?: string
          id?: string
          name?: string
          start_time?: string
          updated_at?: string
        }
        Relationships: []
      }
      shifts: {
        Row: {
          created_at: string
          created_by: string | null
          date: string
          end_time: string
          id: string
          name: string
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          date: string
          end_time: string
          id?: string
          name: string
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          date?: string
          end_time?: string
          id?: string
          name?: string
          start_time?: string
          updated_at?: string
        }
        Relationships: []
      }
      suppliers: {
        Row: {
          address: string | null
          contact_info: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          contact_info?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          contact_info?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_warehouse: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          created_at: string
          id: string
          notes: string | null
          product_id: string
          quantity: number
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          product_id: string
          quantity?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          product_id?: string
          quantity?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_warehouse_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      webhooks: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          id: string
          product_name: string
          slug: string
          status: string
          total_leads: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          product_name: string
          slug: string
          status?: string
          total_leads?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          product_name?: string
          slug?: string
          status?: string
          total_leads?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_phone_duplicates: {
        Args: { _exclude_order_id?: string; _phone: string }
        Returns: {
          source: string
          source_id: string
          source_name: string
        }[]
      }
      cleanup_expired_active_call_views: { Args: never; Returns: number }
      cleanup_expired_order_locks: { Args: never; Returns: undefined }
      count_expired_personal_list_holds: { Args: never; Returns: number }
      escalate_expired_personal_list_holds: {
        Args: never
        Returns: {
          agent_id: string
          agent_name: string
          customer_name: string
          customer_phone: string
          escalated_at: string
          expires_at: string
          id: string
          reason: string
        }[]
      }
      get_my_permissions: { Args: never; Returns: Json }
      get_my_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin_or_manager: { Args: { _user_id: string }; Returns: boolean }
      my_can_see_mex_cash: { Args: never; Returns: boolean }
      recompute_all_segments: { Args: never; Returns: number }
      recompute_customer_segments: {
        Args: { _phone: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "agent"
        | "warehouse"
        | "ads_admin"
        | "manager"
        | "pending_agent"
        | "prediction_agent"
      lead_status:
        | "not_contacted"
        | "no_answer"
        | "interested"
        | "not_interested"
        | "confirmed"
      order_status:
        | "pending"
        | "take"
        | "call_again"
        | "confirmed"
        | "shipped"
        | "delivered"
        | "returned"
        | "paid"
        | "trashed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "agent",
        "warehouse",
        "ads_admin",
        "manager",
        "pending_agent",
        "prediction_agent",
      ],
      lead_status: [
        "not_contacted",
        "no_answer",
        "interested",
        "not_interested",
        "confirmed",
      ],
      order_status: [
        "pending",
        "take",
        "call_again",
        "confirmed",
        "shipped",
        "delivered",
        "returned",
        "paid",
        "trashed",
        "cancelled",
      ],
    },
  },
} as const
