import { supabase } from '../supabase';
import { Announcement, Message, Role, User } from '../../types';

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function broadcastClassAnnouncement(params: {
  className: string;
  message: string;
  createdBy: string;
}) {
  const { className, message, createdBy } = params;

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('parentId')
    .eq('className', className)
    .not('parentId', 'is', null);
  if (studentsError) throw studentsError;

  const parentIds = Array.from(
    new Set((students || []).map((row: { parentId: string | null }) => row.parentId).filter(Boolean)),
  ) as string[];

  const { data: announcement, error: insertError } = await supabase
    .from('announcements')
    .insert({
      id: makeId('announcement'),
      className,
      message,
      createdBy,
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  if (parentIds.length > 0) {
    const notifications = parentIds.map(parentId => ({
      id: makeId('announcement-recipient'),
      announcementId: announcement.id,
      parentId,
    }));
    const { error: linkError } = await supabase
      .from('announcement_recipients')
      .insert(notifications);
    if (linkError) throw linkError;
  }

  return { announcement: announcement as Announcement, recipients: parentIds };
}

export async function getAnnouncementsForParent(parentId: string): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcement_recipients')
    .select('announcements(*)')
    .eq('parentId', parentId)
    .order('createdAt', { ascending: false, referencedTable: 'announcements' });
  if (error) throw error;
  return (data || [])
    .map((row: any) => row.announcements)
    .filter(Boolean) as Announcement[];
}

export async function getAnnouncementsByCreator(createdBy: string): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('createdBy', createdBy)
    .order('createdAt', { ascending: false });
  if (error) throw error;
  return (data || []) as Announcement[];
}

export async function deleteAnnouncement(announcementId: string): Promise<void> {
  const { error } = await supabase
    .from('announcements')
    .delete()
    .eq('id', announcementId);
  if (error) throw error;
}

export async function getMessagesForUser(userId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`senderId.eq.${userId},recipientId.eq.${userId}`)
    .order('createdAt', { ascending: false });
  if (error) throw error;
  return (data || []) as Message[];
}

export async function getAllowedMessageRecipients(userId: string): Promise<User[]> {
  const { data: me, error: meError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (meError) throw meError;
  const meRole = (me.role || '') as Role;

  if (meRole === 'admin') {
    const { data, error } = await supabase.from('profiles').select('*').neq('id', userId);
    if (error) throw error;
    return (data || []) as User[];
  }

  if (meRole === 'parent') {
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('className')
      .eq('parentId', userId);
    if (studentsError) throw studentsError;
    const classNames = Array.from(new Set((students || []).map((row: any) => row.className).filter(Boolean)));
    if (classNames.length === 0) return [];
    const { data: users, error: usersError } = await supabase.from('profiles').select('*');
    if (usersError) throw usersError;
    return (users || []).filter((user: any) => {
      if (user.id === userId) return false;
      if (user.role !== 'teacher' && user.role !== 'supervisor') return false;
      const assigned = Array.isArray(user.assignedClasses) ? user.assignedClasses : [];
      return assigned.some((cls: string) => classNames.includes(cls));
    }) as User[];
  }

  if (meRole === 'teacher') {
    const assigned = Array.isArray(me.assignedClasses) ? me.assignedClasses : [];
    if (assigned.length === 0) return [];
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('parentId,className')
      .in('className', assigned)
      .not('parentId', 'is', null);
    if (studentsError) throw studentsError;
    const parentIds = Array.from(new Set((students || []).map((row: any) => row.parentId).filter(Boolean)));
    if (parentIds.length === 0) return [];
    const { data: parents, error: parentsError } = await supabase
      .from('profiles')
      .select('*')
      .in('id', parentIds);
    if (parentsError) throw parentsError;
    return (parents || []) as User[];
  }

  if (meRole === 'supervisor') {
    const assigned = Array.isArray(me.assignedClasses) ? me.assignedClasses : [];
    if (assigned.length === 0) return [];
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('parentId,className')
      .in('className', assigned)
      .not('parentId', 'is', null);
    if (studentsError) throw studentsError;
    const parentIds = Array.from(new Set((students || []).map((row: any) => row.parentId).filter(Boolean)));
    if (parentIds.length === 0) return [];
    const { data: parents, error: parentsError } = await supabase.from('profiles').select('*').in('id', parentIds);
    if (parentsError) throw parentsError;
    return (parents || []) as User[];
  }

  return [];
}

export interface EnrichedRecipient {
  id: string;
  name: string;
  role: Role;
  studentId?: string;
  studentName?: string;
  className?: string;
}

export async function getAllowedMessageRecipientsEnriched(userId: string): Promise<EnrichedRecipient[]> {
  const { data: me, error: meError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (meError) throw meError;
  const meRole = (me.role || '') as Role;

  if (meRole === 'admin') {
    const { data: users } = await supabase.from('profiles').select('*').neq('id', userId);
    const recipients: EnrichedRecipient[] = (users || []).map((u: any) => ({ id: u.id, name: u.name, role: u.role }));
    const parentIds = recipients.filter(r => r.role === 'parent').map(r => r.id);
    if (parentIds.length > 0) {
      const { data: students } = await supabase
        .from('students')
        .select('id,name,className,parentId')
        .in('parentId', parentIds);
      const studentByParent = new Map<string, { studentId: string; studentName: string; className: string }>();
      for (const s of (students || [])) {
        if (s.parentId && !studentByParent.has(s.parentId)) {
          studentByParent.set(s.parentId, { studentId: s.id, studentName: s.name, className: s.className });
        }
      }
      for (const r of recipients) {
        if (r.role === 'parent' && studentByParent.has(r.id)) {
          const info = studentByParent.get(r.id)!;
          r.studentId = info.studentId;
          r.studentName = info.studentName;
          r.className = info.className;
        }
      }
    }
    return recipients;
  }

  if (meRole === 'parent') {
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('className')
      .eq('parentId', userId);
    if (studentsError) throw studentsError;
    const classNames = Array.from(new Set((students || []).map((row: any) => row.className).filter(Boolean)));
    if (classNames.length === 0) return [];
    const { data: users } = await supabase.from('profiles').select('*');
    return (users || [])
      .filter((u: any) => {
        if (u.id === userId) return false;
        if (u.role !== 'teacher' && u.role !== 'supervisor') return false;
        const assigned = Array.isArray(u.assignedClasses) ? u.assignedClasses : [];
        return assigned.some((cls: string) => classNames.includes(cls));
      })
      .map((u: any) => ({ id: u.id, name: u.name, role: u.role }));
  }

  if (meRole === 'teacher') {
    const assigned = Array.isArray(me.assignedClasses) ? me.assignedClasses : [];
    if (assigned.length === 0) return [];
    const { data: students } = await supabase
      .from('students')
      .select('id,name,className,parentId')
      .in('className', assigned)
      .not('parentId', 'is', null);
    if (!students || students.length === 0) return [];
    const parentIds = Array.from(new Set(students.map((s: any) => s.parentId).filter(Boolean)));
    const { data: parents } = await supabase
      .from('profiles')
      .select('id,name,role')
      .in('id', parentIds);
    const studentByParent = new Map<string, { studentId: string; studentName: string; className: string }>();
    for (const s of students) {
      if (s.parentId && !studentByParent.has(s.parentId)) {
        studentByParent.set(s.parentId, { studentId: s.id, studentName: s.name, className: s.className });
      }
    }
    return (parents || []).map((p: any) => {
      const info = studentByParent.get(p.id);
      return {
        id: p.id,
        name: p.name,
        role: 'parent' as Role,
        studentId: info?.studentId,
        studentName: info?.studentName,
        className: info?.className,
      };
    });
  }

  if (meRole === 'supervisor') {
    const assigned = Array.isArray(me.assignedClasses) ? me.assignedClasses : [];
    if (assigned.length === 0) return [];
    const { data: students } = await supabase
      .from('students')
      .select('id,name,className,parentId')
      .in('className', assigned)
      .not('parentId', 'is', null);
    if (!students || students.length === 0) return [];
    const parentIds = Array.from(new Set(students.map((s: any) => s.parentId).filter(Boolean)));
    const { data: parents } = await supabase
      .from('profiles')
      .select('id,name,role')
      .in('id', parentIds);
    const studentByParent = new Map<string, { studentId: string; studentName: string; className: string }>();
    for (const s of students) {
      if (s.parentId && !studentByParent.has(s.parentId)) {
        studentByParent.set(s.parentId, { studentId: s.id, studentName: s.name, className: s.className });
      }
    }
    return (parents || []).map((p: any) => {
      const info = studentByParent.get(p.id);
      return {
        id: p.id,
        name: p.name,
        role: 'parent' as Role,
        studentId: info?.studentId,
        studentName: info?.studentName,
        className: info?.className,
      };
    });
  }

  return [];
}

export async function sendMessage(payload: Omit<Message, 'id' | 'createdAt' | 'readAt'>): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ id: makeId('message'), ...payload })
    .select('*')
    .single();
  if (error) throw error;
  return data as Message;
}

export async function markMessageRead(messageId: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ readAt: new Date().toISOString() })
    .eq('id', messageId);
  if (error) throw error;
}
