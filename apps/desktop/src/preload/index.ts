import type { RendererToMainIpc } from '@jobhelper/contracts';

/**
 * Electron Preload Bridge Contract (M0 Placeholder).
 * Exposes a strictly typed `window.jobHelper` surface via contextBridge with contextIsolation enabled.
 * Never exposes raw Node APIs or plaintext model API keys to the renderer.
 */
export type JobHelperPreloadApi = RendererToMainIpc;
