import { supabase } from '../supabase';

export type AuditAction =
  | 'subject.created' | 'subject.updated' | 'subject.deleted'
  | 'academic-year.created' | 'academic-year.updated' | 'academic-year.deleted'
  | 'term.created' | 'term.updated' | 'term.deleted'
  | 'class-subject.created' | 'class-subject.updated' | 'class-subject.deleted'
  | 'teacher.replaced' | 'curriculum.copied' | 'bulk.assign' | 'bulk.remove'
  // Family-ID feature (SQL RPCs also write family_ids.generate/transport/override)
  | 'family_ids.gate_not_found'
  | 'family_ids.release';

export type AuditEntry = {
  id: number;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export async function createAuditLog(action: AuditAction, details: Record<string, unknown>): Promise<void> {
  // audit_logs has no open INSERT policy: writes go through the SECURITY
  // DEFINER create_audit_log() RPC (staff-gated server-side), so a parent or
  // teacher can never forge an audit row. See
  // supabase/migrations/20260902_lockdown_audit_logs.sql.
  try {
    const { error } = await supabase.rpc('create_audit_log', { p_action: action, p_details: details });
    if (error) console.warn('create_audit_log failed:', error.message);
  } catch {
    // audit logging is non-critical — never let it break the caller's flow
  }
}

export async function getAuditLogs(limit = 50): Promise<AuditEntry[]> {
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('createdAt', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []) as AuditEntry[];
  } catch {
    return [];
  }
}
