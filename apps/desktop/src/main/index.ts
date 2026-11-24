/**
 * Electron Main Process Entry (M0 Architecture Placeholder).
 *
 * Planned bootstrap wiring (M2–M4):
 * 1. Initialize managed userData directories (db, materials, artifacts, skills, browser-profiles).
 * 2. Run SQLite migrations (@jobhelper/storage) and recover interrupted tasks on startup.
 * 3. Initialize CredentialStore (Electron safeStorage / DPAPI) & ProviderRepository.
 * 4. Instantiate TaskControls (epoch leases), ScopedCdpBridge, SubmitHardGuard, TaskTabManager.
 * 5. Spawn shared Agent Worker process and register typed IPC handlers (RendererToMainIpc).
 * 6. Create main BrowserWindow loading apps/workbench and attach WebContentsView manager.
 */
export const DESKTOP_MAIN_BOOTSTRAP_PHASE = 'M2-M4' as const;
