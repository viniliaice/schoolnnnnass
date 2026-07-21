import { supabase } from '../supabase';

export type AuditAction =
  | 'subject.created' | 'subject.updated' | 'subject.deleted'
  | 'academic-year.created' | 'academic-year.updated' | 'academic-year.deleted'
  | 'term.created' | 'term.updated' | 'term.deleted'
  | 'class-subject.created' | 'class-subject.updated' | 'class-subject.deleted'
  | 'teacher.replaced' | 'curriculum.copied' | 'bulk.assign' | 'bulk.remove';

export type AuditEntry = {
  id: number;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export async function createAuditLog(action: AuditAction, details: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      action,
      details,
      createdAt: new Date().toISOString(),
    });
    if (error) console.warn('audit_logs insert failed (table may not exist):', error.message);
  } catch {
    // audit_logs table may not exist yet — fail silently
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
