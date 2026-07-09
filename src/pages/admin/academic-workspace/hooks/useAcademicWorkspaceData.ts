import { useCallback, useEffect, useState } from 'react';
import type { AcademicYear, ClassSubject, Subject, Term, User } from '../../../../types';
import { getAcademicYears, getCurrentTerm, getTerms } from '../../../../lib/db/academic';
import { getClassSubjects } from '../../../../lib/db/classes';
import { getSubjects } from '../../../../lib/db/subjects';
import { getUsers } from '../../../../lib/db/profiles';

type MappingRow = ClassSubject & { subjects?: { name: string }; users?: { name: string } };

function normalizeRole(user: User) {
  return String(user.role || '').toLowerCase().trim();
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [subjectRows, yearRows, termRows, mappingRows, users, activeTerm] = await Promise.all([
        getSubjects(),
        getAcademicYears(),
        getTerms(),
        getClassSubjects(),
        getUsers(),
        getCurrentTerm().catch(() => null),
      ]);

      setSubjects(subjectRows);
      setYears(yearRows);
      setTerms(termRows);
      setMappings(mappingRows as MappingRow[]);
      setTeachers((users || []).filter(user => normalizeRole(user) === 'teacher'));
      setCurrentTerm(activeTerm);
      setLoading(false);
    } catch (error) {
      onError?.(error);
      setLoading(false);
    } finally {
      setRefreshing(false);
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
  };
}
