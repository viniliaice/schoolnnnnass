// Authorized pickup people ("drivers") for the dismissal gate.
//
// A driver is a person authorized to pick up a SET OF STUDENTS — possibly
// across multiple families. Writes go through the admin/supervisor/office
// SECURITY DEFINER RPC (see supabase/migrations/20260901_authorized_pickups.sql);
// students/authorized_pickups have no direct write policies.
//
// Photos live in the PRIVATE 'authorized-pickups' bucket. The DB stores only
// the object path ("photoPath"); the UI renders a short-lived signed URL
// produced by createSignedUrl(), which requires staff storage SELECT access.

import { supabase } from '../supabase';

export const PICKUP_BUCKET = 'authorized-pickups';
/** Signed URLs are short-lived; one hour covers a dismissal session. */
export const PICKUP_PHOTO_TTL_SECONDS = 3600;

export interface AuthorizedPickup {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  /** Object path within the private bucket (e.g. 'pickup-abc123.jpg'). */
  photoPath: string;
  addedAt: string;
  /** Student ids this person may pick up (within the queried family). */
  studentIds: string[];
}

/** A person authorized for one or more students in the family. */
export type FamilyPickup = AuthorizedPickup;

/** Create a pickup person linked to the given students (gate roles only in SQL). */
export async function createAuthorizedPickup(input: {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string;
  photoPath: string;
  studentIds: string[];
}): Promise<AuthorizedPickup> {
  const { data, error } = await supabase.rpc('create_authorized_pickup', {
    p_id: input.id,
    p_name: input.name,
    p_phone_number: input.phoneNumber,
    p_relationship: input.relationship,
    p_photo_path: input.photoPath,
    p_student_ids: input.studentIds,
  });
  if (error) throw error;
  return data as AuthorizedPickup;
}

/** Load every pickup person authorized for a student in this family. */
export async function getFamilyPickups(familyId: string): Promise<FamilyPickup[]> {
  const { data, error } = await supabase.rpc('get_family_pickups', { p_family_id: familyId });
  if (error) throw error;
  return (data ?? []) as FamilyPickup[];
}

/** Short-lived signed URL for a private-bucket photo (for <img> rendering). */
export async function getPickupPhotoSignedUrl(photoPath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(PICKUP_BUCKET)
    .createSignedUrl(photoPath, PICKUP_PHOTO_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Resolve signed photo URLs for a list of pickups (parallel, per render). */
export async function resolvePickupPhotoUrls(pickups: FamilyPickup[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    pickups.map(async p => [p.id, await getPickupPhotoSignedUrl(p.photoPath)] as const),
  );
  const map = new Map<string, string>();
  for (const [id, url] of entries) if (url) map.set(id, url);
  return map;
}
