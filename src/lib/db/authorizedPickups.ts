// Authorized pickup people ("drivers") for the dismissal gate.
//
// A driver is a person authorized to pick up a SET OF STUDENTS — possibly
// across multiple families. Writes go through the admin/supervisor/office
// SECURITY DEFINER RPC (see supabase/migrations/20260901_authorized_pickups.sql
// and 20260902_manage_drivers.sql); students/authorized_pickups have no direct
// write policies.
//
// Photos live in the PRIVATE 'authorized-pickups' bucket. The DB stores only
// the object path ("photoPath"); the UI renders a short-lived signed URL
// produced by createSignedUrl(), which requires staff storage SELECT access.
//
// A driver photo is OPTIONAL (photoPath may be null). Camera capture and
// gallery upload both write the SAME single photoPath — there are no separate
// fields for the two capture methods.
//
// De-dupe: drivers are matched on normalized phone (the same normalize_phone()
// the family generator uses). The UI checks findAuthorizedPickupByPhone() (or
// findDriverByPhone() against an already-loaded list) before creating, offers
// "attach to existing" instead, and createAuthorizedPickup() sends
// p_allow_duplicate_phone only for an explicit "create separate anyway".

import { supabase } from '../supabase';
import { normalizePhone } from '../transport';

export const PICKUP_BUCKET = 'authorized-pickups';
/** Signed URLs are short-lived; one hour covers a dismissal session. */
export const PICKUP_PHOTO_TTL_SECONDS = 3600;

export interface AuthorizedPickup {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  /** Object path within the private bucket (e.g. 'pickup-abc123.jpg'), or null when the driver has no photo. */
  photoPath: string | null;
  addedAt: string;
  /** Student ids this person may pick up (within the queried family). */
  studentIds: string[];
}

/** A person authorized for one or more students in the family. */
export type FamilyPickup = AuthorizedPickup;

/** One linked student as returned by list_authorized_pickups(). */
export interface AuthorizedPickupStudent {
  id: string;
  name: string;
  className: string;
  familyId: string | null;
  transport?: string | null;
}

/** A driver row for the management screen: the person + their linked students. */
export interface ManagedDriver {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  photoPath: string | null;
  addedAt: string;
  studentCount: number;
  familyCount: number;
  students: AuthorizedPickupStudent[];
}

/** Create a pickup person linked to the given students (gate roles only in SQL). */
export async function createAuthorizedPickup(input: {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string;
  /** Object path for the photo, or null when the driver is saved without one. */
  photoPath: string | null;
  studentIds: string[];
  /** Explicitly allow a second driver with the same (normalized) phone. */
  allowDuplicatePhone?: boolean;
}): Promise<AuthorizedPickup> {
  const { data, error } = await supabase.rpc('create_authorized_pickup', {
    p_id: input.id,
    p_name: input.name,
    p_phone_number: input.phoneNumber,
    p_relationship: input.relationship,
    p_photo_path: input.photoPath ?? null,
    p_student_ids: input.studentIds,
    p_allow_duplicate_phone: input.allowDuplicatePhone ?? false,
  });
  if (error) throw error;
  return data as AuthorizedPickup;
}

/** Replace (or remove, with null) an existing driver's photo. Admin/office only in SQL. */
export async function updateAuthorizedPickupPhoto(
  pickupId: string,
  photoPath: string | null,
): Promise<AuthorizedPickup> {
  if (!pickupId) throw new Error('A driver is required.');
  const { data, error } = await supabase.rpc('update_authorized_pickup_photo', {
    p_pickup_id: pickupId,
    p_photo_path: photoPath ?? null,
  });
  if (error) throw error;
  return data as AuthorizedPickup;
}

/**
 * De-dupe lookup: the existing driver whose NORMALIZED phone matches `phone`,
 * or null. The server applies normalize_phone(), so formatting differences
 * ('+252 61 2345678' vs '0612345678') resolve to the same person.
 */
export async function findAuthorizedPickupByPhone(phone: string): Promise<AuthorizedPickup | null> {
  const { data, error } = await supabase.rpc('find_authorized_pickup_by_phone', { p_phone: phone });
  if (error) throw error;
  return (data as AuthorizedPickup | null) ?? null;
}

/**
 * Pure de-dupe against an already-loaded driver list (the management screen
 * holds the whole list, so no extra round-trip is needed there). Mirrors the
 * server's normalize_phone() matching.
 */
export function findDriverByPhone<T extends { phoneNumber: string }>(
  drivers: T[],
  phone: string,
): T | undefined {
  const target = normalizePhone(phone);
  if (!target) return undefined;
  return drivers.find(d => normalizePhone(d.phoneNumber) === target);
}

/** Load every driver with their linked students (admin/office only in SQL). */
export async function listAuthorizedPickups(): Promise<ManagedDriver[]> {
  const { data, error } = await supabase.rpc('list_authorized_pickups');
  if (error) throw error;
  return (data ?? []) as ManagedDriver[];
}

/**
 * Search registered drivers by name or phone for the gate's "Add driver" picker.
 * Returns driver IDENTITY only (no student/family data) — gate roles in SQL.
 */
export async function searchAuthorizedPickups(query: string): Promise<AuthorizedPickup[]> {
  const { data, error } = await supabase.rpc('search_authorized_pickups', { p_query: query ?? '' });
  if (error) throw error;
  return (data ?? []) as AuthorizedPickup[];
}

/**
 * Clear a student's driver assignment(s). Removes the junction rows only — the
 * registered driver record is untouched. Gate roles in SQL.
 */
export async function removeStudentDriver(studentId: string): Promise<void> {
  if (!studentId) throw new Error('A student is required.');
  const { error } = await supabase.rpc('remove_student_driver', { p_student_id: studentId });
  if (error) throw error;
}

/**
 * Assign an EXISTING driver to students. REPLACE semantics: a student ends up
 * with exactly ONE driver (the RPC clears any prior assignment first), so this
 * is both "Add driver" and "Change driver". An empty selection never reaches
 * the RPC (the RPC re-checks the same rule server-side).
 */
export async function attachStudentsToAuthorizedPickup(
  pickupId: string,
  studentIds: string[],
): Promise<AuthorizedPickup> {
  if (!pickupId) throw new Error('A driver is required.');
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new Error('At least one student must be selected.');
  }
  const { data, error } = await supabase.rpc('attach_students_to_authorized_pickup', {
    p_pickup_id: pickupId,
    p_student_ids: studentIds,
  });
  if (error) throw error;
  return data as AuthorizedPickup;
}

/** Unlink one student from a driver (hard delete of the junction row). */
export async function removeStudentFromAuthorizedPickup(
  pickupId: string,
  studentId: string,
): Promise<void> {
  if (!pickupId || !studentId) throw new Error('Driver and student are required.');
  const { error } = await supabase.rpc('remove_student_from_authorized_pickup', {
    p_pickup_id: pickupId,
    p_student_id: studentId,
  });
  if (error) throw error;
}

/** Load every pickup person authorized for a student in this family. */
export async function getFamilyPickups(familyId: string): Promise<FamilyPickup[]> {
  const { data, error } = await supabase.rpc('get_family_pickups', { p_family_id: familyId });
  if (error) throw error;
  return (data ?? []) as FamilyPickup[];
}

/** Short-lived signed URL for a private-bucket photo (for <img> rendering). */
export async function getPickupPhotoSignedUrl(photoPath: string | null): Promise<string | null> {
  if (!photoPath) return null;
  const { data, error } = await supabase.storage
    .from(PICKUP_BUCKET)
    .createSignedUrl(photoPath, PICKUP_PHOTO_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/**
 * Resolve signed photo URLs for a list of pickups (parallel, per render).
 * Accepts any record carrying id + photoPath, so it serves both the per-family
 * gate list (FamilyPickup) and the management list (ManagedDriver). Drivers
 * without a photo simply have no map entry (callers fall back to an avatar).
 */
export async function resolvePickupPhotoUrls<T extends { id: string; photoPath: string | null }>(
  pickups: T[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    pickups.map(async p => [p.id, await getPickupPhotoSignedUrl(p.photoPath)] as const),
  );
  const map = new Map<string, string>();
  for (const [id, url] of entries) if (url) map.set(id, url);
  return map;
}
