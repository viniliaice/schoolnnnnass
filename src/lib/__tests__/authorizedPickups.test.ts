import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSignedUrl = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    storage: {
      from: () => ({ createSignedUrl }),
    },
  },
}));

import { supabase } from '../supabase';
import {
  attachStudentsToAuthorizedPickup, createAuthorizedPickup, findAuthorizedPickupByPhone,
  findDriverByPhone, getFamilyPickups, listAuthorizedPickups, removeStudentDriver,
  removeStudentFromAuthorizedPickup, searchAuthorizedPickups,
  resolvePickupPhotoUrls, updateAuthorizedPickupPhoto, PICKUP_BUCKET, type ManagedDriver,
} from '../db/authorizedPickups';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc.mockReset();
  createSignedUrl.mockReset();
});

describe('createAuthorizedPickup', () => {
  it('creates a pickup person linked to the given students (stores the photo path)', async () => {
    rpc.mockResolvedValue({
      data: {
        id: 'pickup-1',
        name: 'Xasan Cali',
        phoneNumber: '+252 61 1234567',
        relationship: 'Awoowe',
        photoPath: 'pickup-1.jpg',
        addedByStaffId: 'office-umal',
        addedAt: '2026-09-01T12:00:00Z',
        studentIds: ['s1', 's2'],
      },
      error: null,
    });

    const person = await createAuthorizedPickup({
      id: 'pickup-1',
      name: 'Xasan Cali',
      phoneNumber: '+252 61 1234567',
      relationship: 'Awoowe',
      photoPath: 'pickup-1.jpg',
      studentIds: ['s1', 's2'],
    });

    expect(person.name).toBe('Xasan Cali');
    expect(rpc).toHaveBeenCalledWith('create_authorized_pickup', {
      p_id: 'pickup-1',
      p_name: 'Xasan Cali',
      p_phone_number: '+252 61 1234567',
      p_relationship: 'Awoowe',
      p_photo_path: 'pickup-1.jpg',
      p_student_ids: ['s1', 's2'],
      p_allow_duplicate_phone: false,
    });
  });

  it('passes p_allow_duplicate_phone = true for the explicit duplicate override', async () => {
    rpc.mockResolvedValue({ data: { id: 'p', studentIds: ['s1'] }, error: null });
    await createAuthorizedPickup({
      id: 'p',
      name: 'X',
      phoneNumber: '123',
      relationship: '',
      photoPath: 'p.jpg',
      studentIds: ['s1'],
      allowDuplicatePhone: true,
    });
    expect(rpc).toHaveBeenCalledWith('create_authorized_pickup', expect.objectContaining({ p_allow_duplicate_phone: true }));
  });

  it('sends p_photo_path: null when the driver is saved without a photo', async () => {
    rpc.mockResolvedValue({ data: { id: 'p', studentIds: ['s1'] }, error: null });
    await createAuthorizedPickup({
      id: 'p',
      name: 'X',
      phoneNumber: '123',
      relationship: '',
      photoPath: null,
      studentIds: ['s1'],
    });
    expect(rpc).toHaveBeenCalledWith('create_authorized_pickup', expect.objectContaining({ p_photo_path: null }));
  });

  it('throws the RPC error (e.g. duplicate phone) and sends a null photo path', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'A driver with this phone number already exists.' } });
    await expect(
      createAuthorizedPickup({
        id: 'p',
        name: 'X',
        phoneNumber: '123',
        relationship: '',
        photoPath: null,
        studentIds: ['s1'],
      }),
    ).rejects.toThrow(/phone number already exists/);
    expect(rpc).toHaveBeenCalledWith('create_authorized_pickup', expect.objectContaining({ p_photo_path: null }));
  });
});

describe('updateAuthorizedPickupPhoto', () => {
  it('replaces a driver photo via the RPC', async () => {
    rpc.mockResolvedValue({ data: { id: 'pickup-1', photoPath: 'pickup-1.jpg' }, error: null });
    await updateAuthorizedPickupPhoto('pickup-1', 'pickup-1.jpg');
    expect(rpc).toHaveBeenCalledWith('update_authorized_pickup_photo', {
      p_pickup_id: 'pickup-1',
      p_photo_path: 'pickup-1.jpg',
    });
  });

  it('removes a driver photo when given null', async () => {
    rpc.mockResolvedValue({ data: { id: 'pickup-1', photoPath: null }, error: null });
    await updateAuthorizedPickupPhoto('pickup-1', null);
    expect(rpc).toHaveBeenCalledWith('update_authorized_pickup_photo', {
      p_pickup_id: 'pickup-1',
      p_photo_path: null,
    });
  });

  it('rejects a missing driver id WITHOUT calling the RPC', async () => {
    await expect(updateAuthorizedPickupPhoto('', 'p.jpg')).rejects.toThrow(/required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('findDriverByPhone (de-dupe)', () => {
  const drivers: ManagedDriver[] = [
    { id: 'a', name: 'Xasan', phoneNumber: '+252 61 2345678', relationship: null, photoPath: 'a.jpg', addedAt: '', studentCount: 1, familyCount: 1, students: [] },
    { id: 'b', name: 'Cali', phoneNumber: '0619999999', relationship: null, photoPath: 'b.jpg', addedAt: '', studentCount: 1, familyCount: 1, students: [] },
  ];

  it('matches the same normalized phone across formats', () => {
    // '+252 61 2345678' normalizes to '612345678' (the +252 prefix is stripped
    // when 9 digits follow), and so do the other +252 spellings.
    expect(findDriverByPhone(drivers, '612345678')?.id).toBe('a');
    expect(findDriverByPhone(drivers, '+252 61 2345678')?.id).toBe('a');
    expect(findDriverByPhone(drivers, '+252612345678')?.id).toBe('a');
  });

  it('returns undefined for a non-matching or empty phone', () => {
    expect(findDriverByPhone(drivers, '0700000000')).toBeUndefined();
    expect(findDriverByPhone(drivers, '')).toBeUndefined();
    expect(findDriverByPhone(drivers, 'abc')).toBeUndefined();
  });
});

describe('findAuthorizedPickupByPhone', () => {
  it('returns the existing driver for the phone (server-side normalization)', async () => {
    rpc.mockResolvedValue({
      data: { id: 'pickup-1', name: 'Xasan Cali', phoneNumber: '+252 61 2345678', relationship: null, photoPath: 'p.jpg', addedAt: '' },
      error: null,
    });
    const found = await findAuthorizedPickupByPhone('0612345678');
    expect(found?.id).toBe('pickup-1');
    expect(rpc).toHaveBeenCalledWith('find_authorized_pickup_by_phone', { p_phone: '0612345678' });
  });

  it('returns null when there is no match', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(findAuthorizedPickupByPhone('0700000000')).resolves.toBeNull();
  });
});

describe('listAuthorizedPickups', () => {
  it('returns every driver with linked students and counts', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          id: 'pickup-1', name: 'Xasan Cali', phoneNumber: '612345678', relationship: 'Adeer',
          photoPath: 'pickup-1.jpg', addedAt: '', studentCount: 2, familyCount: 2,
          students: [
            { id: 's1', name: 'Fartun', className: 'Grade 4-A', familyId: '0042', transport: 'WALKER' },
            { id: 's2', name: 'Axmed', className: 'Grade 7-B', familyId: '0017', transport: '9' },
          ],
        },
      ],
      error: null,
    });
    const list = await listAuthorizedPickups();
    expect(list).toHaveLength(1);
    expect(list[0].studentCount).toBe(2);
    expect(list[0].familyCount).toBe(2);
    expect(rpc).toHaveBeenCalledWith('list_authorized_pickups');
  });
});

describe('attachStudentsToAuthorizedPickup', () => {
  it('links an existing driver to additional students', async () => {
    rpc.mockResolvedValue({ data: { id: 'pickup-1', studentIds: ['s3', 's4'] }, error: null });
    await attachStudentsToAuthorizedPickup('pickup-1', ['s3', 's4']);
    expect(rpc).toHaveBeenCalledWith('attach_students_to_authorized_pickup', {
      p_pickup_id: 'pickup-1',
      p_student_ids: ['s3', 's4'],
    });
  });

  it('rejects an empty student selection WITHOUT calling the RPC', async () => {
    await expect(attachStudentsToAuthorizedPickup('pickup-1', [])).rejects.toThrow(/At least one student/);
    await expect(attachStudentsToAuthorizedPickup('pickup-1', '' as unknown as string[])).rejects.toThrow(/At least one student/);
    await expect(attachStudentsToAuthorizedPickup('', ['s1'])).rejects.toThrow(/driver is required/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when the RPC rejects (e.g. driver not found)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Driver not found.' } });
    await expect(attachStudentsToAuthorizedPickup('nope', ['s1'])).rejects.toThrow(/Driver not found/);
  });

  it('surfaces a bus-student rejection from the server', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Bus students cannot be assigned a driver.' } });
    await expect(attachStudentsToAuthorizedPickup('pickup-1', ['s-bus'])).rejects.toThrow(/Bus students/);
  });
});

describe('searchAuthorizedPickups', () => {
  it('searches registered drivers (identity only) for the gate picker', async () => {
    rpc.mockResolvedValue({
      data: [
        { id: 'pickup-1', name: 'ASKO', phoneNumber: '980797', relationship: null, photoPath: 'pickup-1.jpg', addedAt: '' },
        { id: 'pickup-2', name: 'MOHAMED', phoneNumber: '982115', relationship: null, photoPath: 'pickup-2.jpg', addedAt: '' },
      ],
      error: null,
    });
    const results = await searchAuthorizedPickups('ASKO');
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('ASKO');
    expect(rpc).toHaveBeenCalledWith('search_authorized_pickups', { p_query: 'ASKO' });
  });

  it('returns [] on empty results', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(searchAuthorizedPickups('zzz')).resolves.toEqual([]);
  });
});

describe('removeStudentDriver', () => {
  it('clears a student assignment via the student-centric RPC', async () => {
    rpc.mockResolvedValue({ data: { studentId: 's1', removed: true }, error: null });
    await removeStudentDriver('s1');
    expect(rpc).toHaveBeenCalledWith('remove_student_driver', { p_student_id: 's1' });
  });

  it('rejects an empty student WITHOUT calling the RPC', async () => {
    await expect(removeStudentDriver('')).rejects.toThrow(/required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('removeStudentFromAuthorizedPickup', () => {
  it('unlinks one student from a driver', async () => {
    rpc.mockResolvedValue({ data: { personId: 'pickup-1', studentId: 's1', removed: true }, error: null });
    await removeStudentFromAuthorizedPickup('pickup-1', 's1');
    expect(rpc).toHaveBeenCalledWith('remove_student_from_authorized_pickup', {
      p_pickup_id: 'pickup-1',
      p_student_id: 's1',
    });
  });

  it('rejects a missing driver or student WITHOUT calling the RPC', async () => {
    await expect(removeStudentFromAuthorizedPickup('', 's1')).rejects.toThrow(/required/);
    await expect(removeStudentFromAuthorizedPickup('pickup-1', '')).rejects.toThrow(/required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('getFamilyPickups', () => {
  it('returns the family pickups (a driver may span multiple students)', async () => {
    rpc.mockResolvedValue({
      data: [
        { id: 'pickup-1', name: 'Xasan Cali', phoneNumber: '61234567', relationship: 'Adeer', photoPath: 'pickup-1.jpg', addedAt: '2026-09-01T12:00:00Z', studentIds: ['s1', 's2'] },
      ],
      error: null,
    });

    const pickups = await getFamilyPickups('0421');
    expect(pickups).toHaveLength(1);
    expect(pickups[0].studentIds).toEqual(['s1', 's2']);
    expect(rpc).toHaveBeenCalledWith('get_family_pickups', { p_family_id: '0421' });
  });

  it('returns [] on empty result', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(getFamilyPickups('9999')).resolves.toEqual([]);
  });
});

describe('resolvePickupPhotoUrls', () => {
  it('signs each private-bucket photo and maps personId -> signed URL', async () => {
    createSignedUrl.mockImplementation((path: string) =>
      Promise.resolve({ data: { signedUrl: `https://x/signed/${path}?token=abc` }, error: null }),
    );

    const urls = await resolvePickupPhotoUrls([
      { id: 'p1', name: 'A', phoneNumber: '1', relationship: null, photoPath: 'p1.jpg', addedAt: '', studentIds: [] },
      { id: 'p2', name: 'B', phoneNumber: '2', relationship: null, photoPath: 'p2.jpg', addedAt: '', studentIds: [] },
    ]);

    expect(urls.get('p1')).toContain('p1.jpg');
    expect(urls.get('p2')).toContain('p2.jpg');
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    expect(createSignedUrl).toHaveBeenCalledWith('p1.jpg', 3600);
  });

  it('accepts ManagedDriver rows (id + photoPath) as well', async () => {
    createSignedUrl.mockImplementation((path: string) =>
      Promise.resolve({ data: { signedUrl: `https://x/signed/${path}` }, error: null }),
    );
    const urls = await resolvePickupPhotoUrls([
      { id: 'd1', name: 'A', phoneNumber: '1', relationship: null, photoPath: 'd1.jpg', addedAt: '', studentCount: 1, familyCount: 1, students: [] },
    ]);
    expect(urls.get('d1')).toContain('d1.jpg');
  });

  it('drops entries whose signing failed (falls back to initial avatar)', async () => {
    createSignedUrl.mockImplementation((path: string) =>
      path === 'ok.jpg'
        ? Promise.resolve({ data: { signedUrl: 'https://x/signed/ok.jpg' }, error: null })
        : Promise.resolve({ data: null, error: { message: 'forbidden' } }),
    );

    const urls = await resolvePickupPhotoUrls([
      { id: 'good', name: 'A', phoneNumber: '1', relationship: null, photoPath: 'ok.jpg', addedAt: '', studentIds: [] },
      { id: 'bad', name: 'B', phoneNumber: '2', relationship: null, photoPath: 'denied.jpg', addedAt: '', studentIds: [] },
    ]);

    expect(urls.has('good')).toBe(true);
    expect(urls.has('bad')).toBe(false);
    expect(PICKUP_BUCKET).toBe('authorized-pickups');
  });

  it('skips drivers without a photo (null photoPath) without signing', async () => {
    const urls = await resolvePickupPhotoUrls([{ id: 'nophoto', photoPath: null }]);
    expect(urls.has('nophoto')).toBe(false);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
