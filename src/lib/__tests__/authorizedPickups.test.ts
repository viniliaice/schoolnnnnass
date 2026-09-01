import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  const upload = vi.fn();
  const remove = vi.fn();
  const getPublicUrl = vi.fn();
  const storageFrom = vi.fn(() => ({ upload, remove, getPublicUrl }));
  return { rpc, upload, remove, getPublicUrl, storageFrom };
});

vi.mock('../supabase', () => ({
  supabase: { rpc: mocks.rpc, storage: { from: mocks.storageFrom } },
}));

const { rpc, upload, remove, getPublicUrl, storageFrom } = mocks;

import {
  authorizedPickupPhotoPath,
  canonicalFamilyId,
  createAuthorizedPickup,
  getAuthorizedPickups,
  uploadAuthorizedPickupPhoto,
} from '../db/authorizedPickups';

beforeEach(() => {
  rpc.mockReset();
  upload.mockReset();
  remove.mockReset();
  getPublicUrl.mockReset();
  storageFrom.mockClear();
});

describe('authorized pickup data access', () => {
  it('canonicalizes the family segment used by Storage', () => {
    expect(canonicalFamilyId('MBK-42')).toBe('0042');
    expect(authorizedPickupPhotoPath('MBK-42', 'person-1')).toBe('authorized-pickups/0042/person-1.jpg');
  });

  it('reads pickup people through the gate-role RPC', async () => {
    rpc.mockResolvedValue({
      data: [{
        person_id: 'person-1', family_id: '0042', name: 'Aamina Ali',
        phone_number: '0630000000', relationship: 'Grandfather',
        photo_url: 'https://storage/photo.jpg', added_by_staff_id: 'staff-1',
        added_at: '2026-09-01T10:00:00Z',
      }],
      error: null,
    });
    const rows = await getAuthorizedPickups('0042');
    expect(rows[0]).toMatchObject({ personId: 'person-1', phoneNumber: '0630000000', photoUrl: 'https://storage/photo.jpg' });
    expect(rpc).toHaveBeenCalledWith('get_authorized_pickups', { p_family_id: '0042' });
  });

  it('uploads to the family/person JPEG path before creating the row', async () => {
    upload.mockResolvedValue({ error: null });
    getPublicUrl.mockReturnValue({ data: { publicUrl: 'https://storage/0042/person-1.jpg' } });
    rpc.mockResolvedValue({
      data: {
        personId: 'person-1', familyId: '0042', name: 'Aamina Ali', phoneNumber: '0630000000',
        relationship: null, photoUrl: 'https://storage/0042/person-1.jpg',
        addedByStaffId: 'staff-1', addedAt: '2026-09-01T10:00:00Z',
      },
      error: null,
    });
    const blob = new Blob(['photo'], { type: 'image/jpeg' });
    const photoUrl = await uploadAuthorizedPickupPhoto('42', 'person-1', blob);
    expect(photoUrl).toBe('https://storage/0042/person-1.jpg');
    expect(storageFrom).toHaveBeenCalledWith('authorized-pickups');
    expect(upload).toHaveBeenCalledWith('0042/person-1.jpg', blob, expect.objectContaining({ contentType: 'image/jpeg', upsert: false }));

    await createAuthorizedPickup({
      personId: 'person-1', familyId: '0042', name: 'Aamina Ali',
      phoneNumber: '0630000000', relationship: '', photoUrl,
    });
    expect(rpc).toHaveBeenCalledWith('create_authorized_pickup', expect.objectContaining({
      p_person_id: 'person-1', p_phone_number: '0630000000', p_photo_url: photoUrl,
    }));
  });
});
