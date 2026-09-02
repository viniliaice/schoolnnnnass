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
import { createAuthorizedPickup, getFamilyPickups, resolvePickupPhotoUrls, PICKUP_BUCKET } from '../db/authorizedPickups';

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
    });
  });

  it('throws the RPC error (e.g. missing required photo)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'A photo is required.' } });
    await expect(
      createAuthorizedPickup({
        id: 'p',
        name: 'X',
        phoneNumber: '123',
        relationship: '',
        photoPath: '',
        studentIds: ['s1'],
      }),
    ).rejects.toThrow(/photo is required/);
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
});
