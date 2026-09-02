import { supabase } from '../supabase';

/** A driver authorized for a selected set of students in one family. */
export interface AuthorizedPickup {
  personId: string;
  familyId: string;
  /** Authorization is per student, not blanket access to every sibling. */
  studentIds: string[];
  studentNames: string[];
  name: string;
  phoneNumber: string;
  relationship: string | null;
  photoUrl: string;
  addedByStaffId: string;
  addedAt: string;
}

export interface CreateAuthorizedPickupInput {
  personId: string;
  familyId: string;
  studentIds: string[];
  name: string;
  phoneNumber: string;
  relationship?: string;
  photoUrl: string;
}

export function canonicalFamilyId(familyId: string): string {
  return (familyId ?? '').replace(/\D/g, '').padStart(4, '0');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mapPickup(row: any): AuthorizedPickup {
  const studentNames = asStringArray(row.studentNames ?? row.student_names);
  const studentIds = asStringArray(row.studentIds ?? row.student_ids);
  return {
    personId: String(row.personId ?? row.person_id ?? row.id),
    familyId: String(row.familyId ?? row.family_id ?? ''),
    studentIds,
    studentNames,
    name: String(row.name ?? ''),
    phoneNumber: String(row.phoneNumber ?? row.phone_number ?? row.phone ?? ''),
    relationship: row.relationship ?? null,
    photoUrl: String(row.photoUrl ?? row.photo_url ?? ''),
    addedByStaffId: String(row.addedByStaffId ?? row.added_by_staff_id ?? ''),
    addedAt: String(row.addedAt ?? row.added_at ?? ''),
  };
}

/** Load the authorized pickup list for a family. */
export async function getAuthorizedPickups(familyId: string): Promise<AuthorizedPickup[]> {
  const { data, error } = await supabase.rpc('get_authorized_pickups', { p_family_id: familyId });
  if (error) throw error;
  return ((data ?? []) as any[]).map(mapPickup);
}

/**
 * Upload the already-resized photo to the required family/person namespace.
 * The bucket name is the first path segment in the resulting Storage URL:
 * authorized-pickups/{family_id}/{person_id}.jpg.
 */
export async function uploadAuthorizedPickupPhoto(
  familyId: string,
  personId: string,
  image: Blob,
): Promise<string> {
  const normalizedFamilyId = canonicalFamilyId(familyId);
  const objectPath = `${normalizedFamilyId}/${personId}.jpg`;
  const { error } = await supabase.storage
    .from('authorized-pickups')
    .upload(objectPath, image, {
      contentType: 'image/jpeg',
      // A new UUID is generated for every creation. Do not overwrite a
      // driver's original photo after the record is created.
      upsert: false,
      cacheControl: '3600',
    });
  if (error) throw error;

  const { data } = supabase.storage.from('authorized-pickups').getPublicUrl(objectPath);
  if (!data.publicUrl) throw new Error('Photo uploaded but no photo URL was returned.');
  return data.publicUrl;
}

export async function deleteAuthorizedPickupPhoto(familyId: string, personId: string): Promise<void> {
  const normalizedFamilyId = canonicalFamilyId(familyId);
  const { error } = await supabase.storage.from('authorized-pickups').remove([`${normalizedFamilyId}/${personId}.jpg`]);
  if (error) console.warn('[authorized-pickups] orphaned photo cleanup failed:', error.message);
}

/** Insert only after the photo upload succeeds, so every record is complete. */
export async function createAuthorizedPickup(input: CreateAuthorizedPickupInput): Promise<AuthorizedPickup> {
  const { data, error } = await supabase.rpc('create_authorized_pickup', {
    p_person_id: input.personId,
    p_family_id: input.familyId,
    p_student_ids: [...new Set(input.studentIds)],
    p_name: input.name.trim(),
    p_phone_number: input.phoneNumber.trim(),
    p_relationship: input.relationship?.trim() || null,
    p_photo_url: input.photoUrl,
  });
  if (error) throw error;
  return mapPickup(data);
}

/** Canonical Storage URL path used by tests and operational documentation. */
export function authorizedPickupPhotoPath(familyId: string, personId: string): string {
  return `authorized-pickups/${canonicalFamilyId(familyId)}/${personId}.jpg`;
}
