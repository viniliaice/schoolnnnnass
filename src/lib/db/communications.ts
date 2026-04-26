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
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  if (meError) throw meError;
  const meRole = (me.role || '') as Role;

  if (meRole === 'admin') {
    const { data, error } = await supabase.from('users').select('*').neq('id', userId);
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
    const { data: users, error: usersError } = await supabase.from('users').select('*');
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
      .from('users')
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
    const { data: parents, error: parentsError } = await supabase.from('users').select('*').in('id', parentIds);
    if (parentsError) throw parentsError;
    return (parents || []) as User[];
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
