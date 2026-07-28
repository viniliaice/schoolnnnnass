import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcademicYear, ClassSubject, Subject, Term, User } from '../../../../types';
import { getAcademicYears, getCurrentTerm, getTerms } from '../../../../lib/db/academic';
import { getClassSubjects } from '../../../../lib/db/classes';
import { getSubjects } from '../../../../lib/db/subjects';
import { getAllTeachers } from '../../../../lib/db/profiles';

type MappingRow = ClassSubject & { subjects?: { name: string }; users?: { name: string } };

/** Max retries per individual query */
const MAX_RETRIES = 2;
/** Base delay between retries in ms (exponential backoff: 500, 1000) */
const RETRY_BASE_DELAY_MS = 500;
/** Per-attempt timeout in ms — prevents hanging forever */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Race a promise against a timeout.
 * If the promise doesn't resolve/reject within `ms`, rejects with a timeout error.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${label}] timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Fetch with automatic retry, exponential backoff, and per-attempt timeout.
 * Returns the result on success, or undefined on total failure.
 */
async function fetchWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(fn(), FETCH_TIMEOUT_MS, label);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`[AcademicWorkspace] ${label} failed after ${MAX_RETRIES + 1} attempts:`, err);
        return undefined;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return undefined;
}

export function useAcademicWorkspaceData(onError?: (error: unknown) => void) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<(Term & { academic_years?: AcademicYear })[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [teachers, setTeachers] = useState<User[]>([]);
  const [currentTerm, setCurrentTerm] = useState<Term | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);

  // Track if component is still mounted to avoid setting state on unmounted component
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setPartialErrors([]);

    try {
      // ── Each query runs independently with timeout + retry + graceful fallback ──
      // If one fails/times out, the others still succeed and the workspace loads with partial data.
      // The 15s per-attempt timeout prevents the entire page from hanging forever.

      const [subjectRows, yearRows, termRows, mappingRows, teacherRows, activeTerm] = await Promise.all([
        fetchWithRetry('subjects', getSubjects),
        fetchWithRetry('academic years', getAcademicYears),
        fetchWithRetry('terms', getTerms),
        fetchWithRetry('class-subject mappings', getClassSubjects),
        fetchWithRetry('teachers', getAllTeachers),
        fetchWithRetry('current term', getCurrentTerm),
      ]);

      // Track which queries failed or timed out
      const errors: string[] = [];
      if (subjectRows === undefined) errors.push('subjects');
      if (yearRows === undefined) errors.push('academic years');
      if (termRows === undefined) errors.push('terms');
      if (mappingRows === undefined) errors.push('class assignments');
      if (teacherRows === undefined) errors.push('teachers');

      if (mountedRef.current) {
        // Apply whatever data we successfully fetched
        if (subjectRows !== undefined) setSubjects(subjectRows);
        if (yearRows !== undefined) setYears(yearRows);
        if (termRows !== undefined) setTerms(termRows);
        if (mappingRows !== undefined) setMappings(mappingRows as MappingRow[]);
        if (teacherRows !== undefined) setTeachers(teacherRows);
        if (activeTerm) setCurrentTerm(activeTerm);

        setPartialErrors(errors);

        // Only call onError if ALL core queries failed (nothing to show)
        const coreOk = subjectRows !== undefined || mappingRows !== undefined;
        if (!coreOk) {
          onError?.(new Error('Failed to load academic workspace data. Check your connection.'));
        } else if (errors.length > 0) {
          console.warn(`[AcademicWorkspace] Loaded with partial data. Missing: ${errors.join(', ')}`);
        }

        setLoading(false);
      }
    } catch (error) {
      // This should only catch unexpected errors now (individual queries have their own try/catch)
      console.error('[AcademicWorkspace] Unexpected error during refresh:', error);
      if (mountedRef.current) {
        onError?.(error);
        setLoading(false);
      }
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    loading,
    refreshing,
    refresh,
    subjects,
    setSubjects,
    years,
    terms,
    mappings,
    setMappings,
    teachers,
    currentTerm,
    partialErrors,
  };
}
