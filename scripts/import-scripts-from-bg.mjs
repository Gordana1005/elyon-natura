#!/usr/bin/env node
// RETIRED 02.10.2026 — targeted call scripts (docs/CALL-SCRIPTS.md, migration 20260947000100).
//
// It READ the Bulgarian CRM (a separate live business) and wrote MK call_scripts with the service role, bypassing the audited writers.
// Since 20260947000100 every call-script write goes through the audited SQL writers
// (call_script_save / _duplicate / _bulk / _restore / _delete): versioned, restorable, one
// audit_log row per change. Write and publish scripts on /call-scripts instead.
// The previous body is in git history (git log -- scripts/import-scripts-from-bg.mjs).
console.error('scripts/import-scripts-from-bg.mjs is retired — use /call-scripts (the audited editor). See docs/CALL-SCRIPTS.md.');
process.exit(1);
