import { useEffect, useMemo, useState } from 'react';
import { getAllowedMessageRecipients, getAllowedMessageRecipientsEnriched, EnrichedRecipient, getMessagesForUser, markMessageRead, sendMessage } from '../../lib/db/communications';
import { useRole } from '../../context/RoleContext';
import { Message, Role, User } from '../../types';
import { useToast } from '../../context/ToastContext';
import { supabase } from '../../lib/supabase';

export function MessagesPage() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [enrichedRecipients, setEnrichedRecipients] = useState<EnrichedRecipient[]>([]);
  const [recipientType, setRecipientType] = useState<Role | ''>('');
  const [recipientClass, setRecipientClass] = useState('');
  const [recipientStudentParent, setRecipientStudentParent] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [newMessagePrompt, setNewMessagePrompt] = useState<{ subject: string; snippet: string } | null>(null);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      getMessagesForUser(session.userId),
      getAllowedMessageRecipients(session.userId),
      getAllowedMessageRecipientsEnriched(session.userId),
    ])
      .then(([messagesData, usersData, enrichedData]) => {
        setMessages(messagesData);
        setUsers(usersData);
        setEnrichedRecipients(enrichedData);
      })
      .catch(() => addToast({ type: 'error', title: 'Failed to load messages' }));
  }, [session, addToast]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel(`messages-${session.userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipientId=eq.${session.userId}` },
        (payload: any) => {
          const incoming = payload.new as Message;
          setMessages(prev => [incoming, ...prev]);
          addToast({
            type: 'info',
            title: `New message: ${incoming.subject}`,
            description: incoming.body.slice(0, 80),
          });
          setNewMessagePrompt({
            subject: incoming.subject,
            snippet: incoming.body.slice(0, 80),
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, addToast]);

  const inbox = useMemo(
    () => messages.filter(message => message.recipientId === session?.userId),
    [messages, session],
  );

  const availableTypes = useMemo(() => {
    const roles = new Set(enrichedRecipients.map(r => r.role));
    return Array.from(roles);
  }, [enrichedRecipients]);

  const recipientsByType = useMemo(() => {
    if (!recipientType) return [];
    return enrichedRecipients.filter(r => r.role === recipientType);
  }, [enrichedRecipients, recipientType]);

  const classesForParents = useMemo(() => {
    if (recipientType !== 'parent') return [];
    const classes = new Set(
      recipientsByType
        .filter(r => r.className)
        .map(r => r.className!)
    );
    return Array.from(classes).sort();
  }, [recipientsByType, recipientType]);

  const studentsForClass = useMemo(() => {
    if (recipientType !== 'parent' || !recipientClass) return [];
    return recipientsByType.filter(r => r.className === recipientClass);
  }, [recipientsByType, recipientType, recipientClass]);

  const directRecipients = useMemo(() => {
    if (recipientType !== 'teacher' && recipientType !== 'supervisor') return [];
    return recipientsByType;
  }, [recipientsByType, recipientType]);

  useEffect(() => {
    setRecipientClass('');
    setRecipientStudentParent('');
    setRecipientId('');
  }, [recipientType]);

  useEffect(() => {
    setRecipientStudentParent('');
    setRecipientId('');
  }, [recipientClass]);

  useEffect(() => {
    if (recipientType === 'teacher' || recipientType === 'supervisor') {
      setRecipientId(recipientStudentParent);
    } else if (recipientType === 'parent' && recipientStudentParent) {
      setRecipientId(recipientStudentParent);
    }
  }, [recipientStudentParent, recipientType]);

  const handleSend = async () => {
    if (!session || !recipientId || !subject.trim() || !body.trim()) return;
    try {
      const sent = await sendMessage({
        senderId: session.userId,
        recipientId,
        subject: subject.trim(),
        body: body.trim(),
      });
      setMessages(prev => [sent, ...prev]);
      setSubject('');
      setBody('');
      setRecipientType('');
      setRecipientClass('');
      setRecipientStudentParent('');
      setRecipientId('');
      addToast({ type: 'success', title: 'Message sent' });
    } catch {
      addToast({ type: 'error', title: 'Failed to send message' });
    }
  };

  const ROLENAME: Record<Role, string> = {
    admin: 'Admin',
    teacher: 'Teacher',
    parent: 'Parent',
    supervisor: 'Supervisor',
  };

  return (
    <div className="space-y-6">
      {newMessagePrompt && (
        <div className="fixed top-5 right-5 z-50 w-full max-w-sm rounded-xl border border-indigo-200 bg-white shadow-xl p-4">
          <p className="text-xs font-semibold text-indigo-600 mb-1">New Message</p>
          <p className="text-sm font-semibold text-slate-900">{newMessagePrompt.subject}</p>
          <p className="text-xs text-slate-600 mt-1">{newMessagePrompt.snippet}...</p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                const inbox = document.getElementById('messages-inbox');
                inbox?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setNewMessagePrompt(null);
              }}
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-semibold"
            >
              Check Messages
            </button>
            <button
              onClick={() => setNewMessagePrompt(null)}
              className="px-3 py-1.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Secure Messages</h1>
        <p className="text-slate-500 mt-1">Internal inbox for teachers, admins, and parents</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h2 className="font-semibold text-slate-900">Send Message</h2>

        <select
          value={recipientType}
          onChange={e => setRecipientType(e.target.value as Role)}
          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
        >
          <option value="">Select recipient type...</option>
          {availableTypes.map(role => (
            <option key={role} value={role}>
              {ROLENAME[role]}
            </option>
          ))}
        </select>

        {recipientType === 'parent' && (
          <select
            value={recipientClass}
            onChange={e => setRecipientClass(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
          >
            <option value="">Select class...</option>
            {classesForParents.map(cls => (
              <option key={cls} value={cls}>
                {cls}
              </option>
            ))}
          </select>
        )}

        {recipientType === 'parent' && recipientClass && (
          <select
            value={recipientStudentParent}
            onChange={e => setRecipientStudentParent(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
          >
            <option value="">Select student → parent...</option>
            {studentsForClass.map(r => (
              <option key={r.id} value={r.id}>
                {r.studentName} → {r.name} (Parent)
              </option>
            ))}
          </select>
        )}

        {(recipientType === 'teacher' || recipientType === 'supervisor') && (
          <select
            value={recipientStudentParent}
            onChange={e => setRecipientStudentParent(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
          >
            <option value="">Select {recipientType}...</option>
            {directRecipients.map(r => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}

        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Subject"
          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Message"
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
        />
        <button
          onClick={handleSend}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700"
        >
          Send
        </button>
      </div>

      <div id="messages-inbox" className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-900 mb-3">Inbox</h2>
        <div className="space-y-2">
          {inbox.map(message => {
            const sender = users.find(user => user.id === message.senderId);
            return (
              <button
                key={message.id}
                onClick={() => markMessageRead(message.id).catch(() => null)}
                className="w-full text-left p-3 rounded-lg bg-slate-50 border border-slate-100"
              >
                <div className="text-sm font-semibold text-slate-800">{message.subject}</div>
                <div className="text-xs text-slate-500">From: {sender?.name || message.senderId}</div>
                <div className="text-sm text-slate-700 mt-1">{message.body}</div>
              </button>
            );
          })}
          {inbox.length === 0 && <p className="text-sm text-slate-400">No messages yet.</p>}
        </div>
      </div>
    </div>
  );
}
