// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildParentCredentialWhatsAppMessage,
  buildParentCredentialWhatsAppLink,
  sendParentCredentialWhatsApp,
  normalizeSomaliPhoneToWa,
} from '../whatsapp';

describe('normalizeSomaliPhoneToWa', () => {
  it('formats phone numbers correctly for WhatsApp URLs', () => {
    // Exact example from prompt
    expect(normalizeSomaliPhoneToWa('252634506719')).toBe('252634506719');
    expect(normalizeSomaliPhoneToWa('+252634506719')).toBe('252634506719');
    expect(normalizeSomaliPhoneToWa('+252 63 450 6719')).toBe('252634506719');
    expect(normalizeSomaliPhoneToWa('00252634506719')).toBe('252634506719');
    expect(normalizeSomaliPhoneToWa('0634506719')).toBe('252634506719');
    expect(normalizeSomaliPhoneToWa('634506719')).toBe('252634506719');
  });

  it('handles other international numbers correctly', () => {
    expect(normalizeSomaliPhoneToWa('+1 415 555 2671')).toBe('14155552671');
    expect(normalizeSomaliPhoneToWa('+44 7911 123456')).toBe('447911123456');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeSomaliPhoneToWa('')).toBe('');
  });
});

describe('buildParentCredentialWhatsAppMessage', () => {
  it('matches the exact required Somali message format', () => {
    const parentEmail = 'parent1@example.com';
    const message = buildParentCredentialWhatsAppMessage(parentEmail);
    const expected =
      'Walidka sharafta leh, app cusub oo walidka ka arki karo ardadu website-ka waa: https://schoolnnnnass.vercel.app waxaad ku gasho username: parent1@example.com iyo password: parent1@example.com.';
    expect(message).toBe(expected);
  });

  it('uses the parent email for both username and password', () => {
    const parentEmail = 'ikraan.cabdi@example.com';
    const message = buildParentCredentialWhatsAppMessage(parentEmail);
    expect(message).toContain('username: ikraan.cabdi@example.com');
    expect(message).toContain('password: ikraan.cabdi@example.com');
  });

  it('does not use student name or parent name as username/password', () => {
    const studentName = 'Barwaaqo Maxamed Heeban';
    const parentName = 'ikraan cabdi khaliif';
    const parentEmail = 'ikraan@domain.so';

    const message = buildParentCredentialWhatsAppMessage(parentEmail);
    expect(message).not.toContain(studentName);
    expect(message).not.toContain(parentName);
    expect(message).toContain('username: ikraan@domain.so');
    expect(message).toContain('password: ikraan@domain.so');
  });

  it('does not expose database IDs, internal IDs or debug information', () => {
    const message = buildParentCredentialWhatsAppMessage('parent@example.com');
    expect(message).not.toMatch(/uuid|id:|parent-[0-9]|stu-[0-9]|auth_/i);
  });
});

describe('buildParentCredentialWhatsAppLink', () => {
  it('generates the exact WhatsApp URL with URL-encoded message for the prompt example', () => {
    const link = buildParentCredentialWhatsAppLink({
      phone: '252634506719',
      email: 'parent1@example.com',
    });

    const expectedMessage =
      'Walidka sharafta leh, app cusub oo walidka ka arki karo ardadu website-ka waa: https://schoolnnnnass.vercel.app waxaad ku gasho username: parent1@example.com iyo password: parent1@example.com.';
    const expectedUrl = `https://wa.me/252634506719?text=${encodeURIComponent(expectedMessage)}`;

    expect(link).toBe(expectedUrl);
    expect(link).toContain('https://wa.me/252634506719?text=');
    // Verify decoding reproduces the exact message
    const urlObj = new URL(link);
    expect(urlObj.searchParams.get('text')).toBe(expectedMessage);
  });

  it('throws an error if email is missing or empty instead of producing undefined/null in text', () => {
    expect(() => buildParentCredentialWhatsAppLink({ phone: '252634506719', email: '' })).toThrow(
      'Parent email not found'
    );
    expect(() => buildParentCredentialWhatsAppLink({ phone: '252634506719', email: 'undefined' })).toThrow(
      'Parent email not found'
    );
    expect(() => buildParentCredentialWhatsAppLink({ phone: '252634506719', email: 'null' })).toThrow(
      'Parent email not found'
    );
  });

  it('throws an error if phone is missing', () => {
    expect(() => buildParentCredentialWhatsAppLink({ phone: '', email: 'test@example.com' })).toThrow(
      'Parent phone not found'
    );
  });
});

describe('sendParentCredentialWhatsApp helper', () => {
  it('opens WhatsApp with the prompt example details', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const parent = {
      name: 'ikraan cabdi khaliif',
      email: 'ikraan@example.com',
      phone1: '252634506719',
      phone2: null,
    };
    const student = {
      name: 'barwaaqo maxamed heeban',
      parentPhone: '252634506719',
    };

    const success = sendParentCredentialWhatsApp({
      parent,
      student,
      onToast: toastSpy,
    });

    expect(success).toBe(true);
    expect(toastSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledTimes(1);

    const openedUrl = openSpy.mock.calls[0][0] as string;
    expect(openedUrl).toContain('https://wa.me/252634506719?text=');
    const text = new URL(openedUrl).searchParams.get('text');
    expect(text).toBe(
      'Walidka sharafta leh, app cusub oo walidka ka arki karo ardadu website-ka waa: https://schoolnnnnass.vercel.app waxaad ku gasho username: ikraan@example.com iyo password: ikraan@example.com.'
    );

    openSpy.mockRestore();
  });

  it('works with a different parent email', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const parent = {
      name: 'Ali Yusuf',
      email: 'ali.yusuf@mbk.edu',
      phone1: '252634511111',
    };

    const success = sendParentCredentialWhatsApp({
      parent,
      onToast: toastSpy,
    });

    expect(success).toBe(true);
    expect(toastSpy).not.toHaveBeenCalled();
    const openedUrl = openSpy.mock.calls[0][0] as string;
    const text = new URL(openedUrl).searchParams.get('text');
    expect(text).toContain('username: ali.yusuf@mbk.edu iyo password: ali.yusuf@mbk.edu');

    openSpy.mockRestore();
  });

  it('works for multiple students belonging to the same parent', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const sharedParent = {
      name: 'ikraan cabdi khaliif',
      email: 'parent1@example.com',
      phone1: '252634506719',
    };

    // Sibling 1
    const student1 = { name: 'Barwaaqo Maxamed Heeban', parentPhone: '252634506719' };
    const success1 = sendParentCredentialWhatsApp({
      parent: sharedParent,
      student: student1,
      onToast: toastSpy,
    });
    expect(success1).toBe(true);

    // Sibling 2
    const student2 = { name: 'Sara Abdullahi', parentPhone: '252634506719' };
    const success2 = sendParentCredentialWhatsApp({
      parent: sharedParent,
      student: student2,
      onToast: toastSpy,
    });
    expect(success2).toBe(true);

    expect(openSpy).toHaveBeenCalledTimes(2);
    const url1 = openSpy.mock.calls[0][0] as string;
    const url2 = openSpy.mock.calls[1][0] as string;

    expect(url1).toBe(url2);
    expect(new URL(url1).searchParams.get('text')).toContain(
      'username: parent1@example.com iyo password: parent1@example.com'
    );

    openSpy.mockRestore();
  });

  it('shows clear toast "Parent email not found." when parent email is missing or empty', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    // Missing email
    const parentNoEmail = {
      name: 'Sahra Jaamac',
      email: '',
      phone1: '252634599999',
    };

    const success = sendParentCredentialWhatsApp({
      parent: parentNoEmail,
      onToast: toastSpy,
    });

    expect(success).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({
      type: 'error',
      title: 'Parent email not found',
    });

    openSpy.mockRestore();
  });

  it('shows clear toast "Parent email not found." when parent is null or undefined', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const success = sendParentCredentialWhatsApp({
      parent: null,
      onToast: toastSpy,
    });

    expect(success).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({
      type: 'error',
      title: 'Parent email not found',
    });

    openSpy.mockRestore();
  });

  it('shows clear toast "Parent phone not found" when phone is missing', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const parentNoPhone = {
      name: 'No Phone Parent',
      email: 'parent@example.com',
      phone1: null,
      phone2: null,
    };

    const success = sendParentCredentialWhatsApp({
      parent: parentNoPhone,
      onToast: toastSpy,
    });

    expect(success).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({
      type: 'error',
      title: 'Parent phone not found',
    });

    openSpy.mockRestore();
  });

  it('falls back to student.parentPhone when parent.phone1 and phone2 are absent', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const toastSpy = vi.fn();

    const parent = {
      name: 'Parent Name',
      email: 'parent@example.com',
      phone1: null,
      phone2: null,
    };
    const student = {
      parentPhone: '252634506719',
    };

    const success = sendParentCredentialWhatsApp({
      parent,
      student,
      onToast: toastSpy,
    });

    expect(success).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;
    expect(openedUrl).toContain('https://wa.me/252634506719?text=');

    openSpy.mockRestore();
  });
});
