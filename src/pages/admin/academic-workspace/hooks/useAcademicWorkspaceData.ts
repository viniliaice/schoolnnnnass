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
      console.log(`[AcademicWorkspace] Fetching ${label} (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
      const result = await withTimeout(fn(), FETCH_TIMEOUT_MS, label);
      console.log(`[AcademicWorkspace] ✅ ${label} loaded:`, Array.isArray(result) ? `${result.length} rows` : result);
      return result;
    } catch (err) {
      console.warn(`[AcademicWorkspace] ⚠️ ${label} attempt ${attempt + 1} failed:`, err);
      if (attempt === MAX_RETRIES) {
        console.warn(`[AcademicWorkspace] ❌ ${label} failed after ${MAX_RETRIES + 1} attempts`);
        return undefined;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`[AcademicWorkspace] Retrying ${label} in ${delay}ms...`);
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

  // ── CRITICAL FIX: Reset mounted ref on every mount (React 19 Strict Mode compatible) ──
  useEffect(() => {
    console.log('[AcademicWorkspace] Hook mounted — setting mountedRef = true');
    mountedRef.current = true;
    return () => {
      console.log('[AcademicWorkspace] Hook unmounting — setting mountedRef = false');
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    console.log('[AcademicWorkspace] refresh() called — mounted:', mountedRef.current);
    setRefreshing(true);
    setPartialErrors([]);

    try {
      console.log('[AcademicWorkspace] Starting parallel data fetch...');
      const [subjectRows, yearRows, termRows, mappingRows, teacherRows, activeTerm] = await Promise.all([
        fetchWithRetry('subjects', getSubjects),
        fetchWithRetry('academic years', getAcademicYears),
        fetchWithRetry('terms', getTerms),
        fetchWithRetry('class-subject mappings', getClassSubjects),
        fetchWithRetry('teachers', getAllTeachers),
        fetchWithRetry('current term', getCurrentTerm),
      ]);

      console.log('[AcademicWorkspace] All fetches complete. Results:', {
        subjects: subjectRows?.length ?? 'FAILED',
        years: yearRows?.length ?? 'FAILED',
        terms: termRows?.length ?? 'FAILED',
        mappings: mappingRows?.length ?? 'FAILED',
        teachers: teacherRows?.length ?? 'FAILED',
        currentTerm: activeTerm?.name ?? 'NONE',
      });

      // Track which queries failed or timed out
      const errors: string[] = [];
      if (subjectRows === undefined) errors.push('subjects');
      if (yearRows === undefined) errors.push('academic years');
      if (termRows === undefined) errors.push('terms');
      if (mappingRows === undefined) errors.push('class assignments');
      if (teacherRows === undefined) errors.push('teachers');

      // ── CRITICAL: Always set loading=false regardless of mountedRef ──
      // The mountedRef guard is only for data updates, NOT for loading state.
      // If we skip setLoading(false), the skeleton stays forever.
      console.log('[AcademicWorkspace] Setting loading=false (mounted:', mountedRef.current, ')');
      setLoading(false);

      if (mountedRef.current) {
        // Apply whatever data we successfully fetched
        if (subjectRows !== undefined) {
          console.log(`[AcademicWorkspace] Setting ${subjectRows.length} subjects`);
          setSubjects(subjectRows);
        }
        if (yearRows !== undefined) {
          console.log(`[AcademicWorkspace] Setting ${yearRows.length} years`);
          setYears(yearRows);
        }
        if (termRows !== undefined) {
          console.log(`[AcademicWorkspace] Setting ${termRows.length} terms`);
          setTerms(termRows);
        }
        if (mappingRows !== undefined) {
          console.log(`[AcademicWorkspace] Setting ${mappingRows.length} mappings`);
          setMappings(mappingRows as MappingRow[]);
        }
        if (teacherRows !== undefined) {
          console.log(`[AcademicWorkspace] Setting ${teacherRows.length} teachers`);
          setTeachers(teacherRows);
        }
        if (activeTerm) {
          console.log(`[AcademicWorkspace] Setting currentTerm: ${activeTerm.name}`);
          setCurrentTerm(activeTerm);
        }

        setPartialErrors(errors);

        // Only call onError if ALL core queries failed (nothing to show)
        const coreOk = subjectRows !== undefined || mappingRows !== undefined;
        if (!coreOk) {
          console.error('[AcademicWorkspace] ALL core queries failed!');
          onError?.(new Error('Failed to load academic workspace data. Check your connection.'));
        } else if (errors.length > 0) {
          console.warn(`[AcademicWorkspace] Loaded with partial data. Missing: ${errors.join(', ')}`);
        }
      } else {
        console.warn('[AcademicWorkspace] Component unmounted — skipping data state updates (but loading was set to false)');
      }
    } catch (error) {
      console.error('[AcademicWorkspace] Unexpected error during refresh:', error);
      // ── CRITICAL: Always set loading=false even on unexpected errors ──
      setLoading(false);
      if (mountedRef.current) {
        onError?.(error);
      }
    } finally {
      console.log('[AcademicWorkspace] refresh() finally block — setting refreshing=false');
      setRefreshing(false);
    }
  }, [onError]);

  useEffect(() => {
    console.log('[AcademicWorkspace] Effect running — calling refresh()');
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
