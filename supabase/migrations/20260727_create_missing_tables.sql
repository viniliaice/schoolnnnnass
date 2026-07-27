-- Migration: Create tables that are used by the app but have no CREATE TABLE
-- in any existing migration or schema file.

-- academic_years — academic year definitions with current-year flag
CREATE TABLE IF NOT EXISTS academic_years (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- terms — term definitions within an academic year
CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  months TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- grade_scales — grade letter/remark mappings from score ranges
CREATE TABLE IF NOT EXISTS grade_scales (
  id TEXT PRIMARY KEY,
  "minScore" INTEGER NOT NULL,
  "maxScore" INTEGER NOT NULL,
  grade TEXT NOT NULL,
  remark TEXT NOT NULL,
  gpa NUMERIC(3,1)
);

-- report_config — report card weight configuration (single row, id='default')
CREATE TABLE IF NOT EXISTS report_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  "caWeight" NUMERIC(5,2) NOT NULL DEFAULT 60,
  "midtermWeight" NUMERIC(5,2) NOT NULL DEFAULT 20,
  "finalWeight" NUMERIC(5,2) NOT NULL DEFAULT 20,
  "caTypes" TEXT[] NOT NULL DEFAULT '{CA,Homework,Classwork,Quiz,Attendance}',
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_terms_academic_year ON terms("academicYearId");
CREATE INDEX IF NOT EXISTS idx_terms_current ON terms("isCurrent");
CREATE INDEX IF NOT EXISTS idx_academic_years_current ON academic_years("isCurrent");
