export * from './supervisor';
export * from './progress';

export * from './classes';
export * from './academic';
export * from './reports';
export * from './students';
export * from './exams';
export * from './communications';
export * from './parent-portal';
export * from './streams';

// Barrel for incremental DB migration. Modules expose small, focused wrappers
// that call into the legacy `src/lib/database.ts`. This lets UI components
// import from `@/lib/db` without forcing a full refactor.
