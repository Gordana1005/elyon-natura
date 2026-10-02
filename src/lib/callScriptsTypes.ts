/**
 * Targeted call scripts — the shared types (owner, 02.10.2026; contract docs/CALL-SCRIPTS.md).
 *
 * The pure rules (groups, matching, substitution, lint, sections ↔ text) come from the edge
 * function's own dependency-free module, re-exported here the src/lib/shiftsApi.ts way, so the
 * /call-scripts editor, its tester and the /calls dock run EXACTLY what the server runs.
 */
import type { CallScriptHelper } from '@/lib/api';
import type {
  LintIssue, MatchTier, ScriptGroup, ScriptMatch, SectionKey,
} from '../../supabase/functions/api/callScriptMatch';

export * from '../../supabase/functions/api/callScriptMatch';
export type { CallScriptHelper };

export type ScriptStatus = 'draft' | 'published' | 'archived';
export type ScriptsMode = 'off' | 'preview' | 'on';
export type ScriptContextType = 'targeted' | 'product' | 'order' | 'prediction_lead';

export interface ScriptSection {
  id: string;
  key: SectionKey;
  title?: string | null;
  text: string;
}

export interface ScriptTranslation {
  title?: string;
  description?: string | null;
  sections?: ScriptSection[];
  helpers?: CallScriptHelper[];
  /** Legacy rows only (product / order / prediction_lead). */
  script_text?: string;
}

export interface TargetedScript {
  id: string;
  context_type: ScriptContextType;
  status: ScriptStatus;
  title: string;
  description: string | null;
  sections: ScriptSection[];
  helpers: CallScriptHelper[];
  translations: { sq?: ScriptTranslation };
  groups: ScriptGroup[];
  product_ids: string[];
  priority: number;
  version: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  published_at: string | null;
  published_by: string | null;
  copied_from: string | null;
  /** Derived from the sections for targeted rows (SQL call_script_sections_text); edited directly on legacy rows. */
  script_text?: string;
  lint?: LintIssue[];
  updated_by_name?: string | null;
}

export interface ScriptContext {
  source: 'lead' | 'prediction' | 'manual';
  group: ScriptGroup | null;
  group_basis: 'order_status' | 'list_name' | 'attribution' | 'none';
  /** Raw — display only via listLabel(). */
  list_name: string | null;
  order: { id: string; display_id: string | null; status: 'pending' | 'take' | 'call_again'; created_at: string } | null;
  product: { id: string; name: string; price_eur: number | null } | null;
  products: { id: string; name: string }[];
  last_purchase: { at: string; product_name: string | null } | null;
  days_since_purchase: number | null;
  callback: boolean;
}

export interface ScriptVars {
  customer_name: string | null;
  first_name: string | null;
  agent_name: string | null;
  product: string | null;
  price_eur: number | null;
  last_product: string | null;
  last_purchase_at: string | null;
  days_since_purchase: number | null;
  city: string | null;
  order_id: string | null;
}

export type MatchedTargetedScript = TargetedScript & { match: ScriptMatch };

export interface CallScriptsForCall {
  enabled: boolean;
  mode: ScriptsMode;
  drafts_included: boolean;
  context: ScriptContext | null;
  vars: ScriptVars | null;
  best: MatchedTargetedScript | null;
  alternatives: MatchedTargetedScript[];
}

export interface CoverageWinner {
  script_id: string;
  title: string;
  tier: MatchTier;
}

export interface CoverageCell {
  waiting: number;
  assigned: number;
  winner: CoverageWinner | null;
  draft_winner: CoverageWinner | null;
  /** How many published scripts match this cell (> 1 = they compete; the winner is decided by tier / priority / newest). */
  overlap: number;
}

export interface CoverageRow {
  /** The product id, or the family key (families=1). */
  key: string;
  product_ids: string[];
  name: string;
  brand_line: string | null;
  kind: string | null;
  waiting: number;
  cells: Record<ScriptGroup, CoverageCell>;
}

export interface CoverageResponse {
  generated_at: string;
  groups: ScriptGroup[];
  /** Per group: every waiting client (any product, none included); the winner for a client with no product. */
  all_products: Record<ScriptGroup, CoverageCell>;
  rows: CoverageRow[];
  totals: {
    waiting: number;
    covered: number;
    covered_pct: number;
    empty_cells_with_waiting: number;
    published: number;
    drafts: number;
  };
}

// ── Route payloads ──────────────────────────────────────────────────────────

export interface ScriptsModeInfo {
  mode: ScriptsMode;
  /** The /calls dock is on for this caller (on, or preview for an admin / manager). */
  enabled_for_me: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_switch: boolean;
}

/** One catalogue product for the pickers (the library's `products`). */
export interface ProductIndexRow {
  id: string;
  name: string;
  brand_line: string | null;
  kind: string | null;
  is_active: boolean;
  /** productFamilyKey(name) — twins share it. */
  family: string;
}

export interface ScriptsLibrary {
  scripts: TargetedScript[];
  products: ProductIndexRow[];
}

export interface PublishedIndexRow {
  id: string;
  title: string;
  groups: ScriptGroup[];
  product_ids: string[];
  version: number;
}

/** What the editor sends. Targeted rows: every field; legacy rows: title, description, script_text, helpers, translations. */
export interface ScriptPatch {
  title?: string;
  description?: string | null;
  status?: ScriptStatus;
  groups?: ScriptGroup[];
  product_ids?: string[];
  priority?: number;
  sections?: ScriptSection[];
  helpers?: CallScriptHelper[];
  translations?: { sq?: ScriptTranslation };
  script_text?: string;
}

export type DuplicateSplit = 'none' | 'product' | 'group' | 'cell';
export interface DuplicateBody {
  groups: ScriptGroup[];
  product_ids: string[];
  split: DuplicateSplit;
  note?: string;
}
export interface DuplicateResult {
  created: { id: string; title: string }[];
}

export interface BulkOp {
  add_groups?: ScriptGroup[];
  remove_groups?: ScriptGroup[];
  add_products?: string[];
  remove_products?: string[];
  status?: ScriptStatus;
  priority?: number;
}
export interface BulkResult {
  updated: { id: string; version: number }[];
  skipped: { id: string; reason: string }[];
}

export type ScriptVersionAction =
  | 'migrate' | 'create' | 'update' | 'publish' | 'unpublish' | 'archive' | 'restore' | 'duplicate' | 'bulk' | 'delete';

export interface ScriptVersion {
  id: number;
  script_id: string;
  version: number;
  action: ScriptVersionAction;
  /** The row after the action (for delete: the row before). */
  snapshot: TargetedScript;
  actor_id: string | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

export interface DeletedScript {
  script_id: string;
  version: number;
  title: string;
  context_type: ScriptContextType;
  deleted_at: string;
  actor_name: string | null;
  note: string | null;
  snapshot: TargetedScript;
}

/** A waiting client for the tester (privacy-filtered by the caller's flags). */
export interface ScriptSample {
  kind: 'member' | 'lead';
  customer_name: string | null;
  customer_phone: string | null;
  list_id: string | null;
  list_name: string | null;
  order_id: string | null;
  product_id: string | null;
  product_name: string | null;
  last_purchase_at: string | null;
  assigned: boolean;
}

export interface CallScriptsQuery {
  phone: string;
  source: 'lead' | 'prediction' | 'manual';
  order_id?: string | null;
  list_id?: string | null;
  include_drafts?: boolean;
}

export interface LibraryQuery {
  status?: ScriptStatus | 'all';
  group?: ScriptGroup | 'none';
  product?: string;
  q?: string;
}
