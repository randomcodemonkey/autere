import { readFileSync, existsSync } from 'fs';
import { EXTENSION_CONFIGS } from './constants.js';
import { extensionsState } from './state.js';
// ── Extension monitoring ──
export function readExtensions() {
    const extensions = [];
    for (const [extId, config] of Object.entries(EXTENSION_CONFIGS)) {
        const hasConfig = existsSync(config.configPath);
        let status = hasConfig ? 'loaded' : 'not found';
        let details = {};
        if (hasConfig) {
            try {
                const raw = readFileSync(config.configPath, 'utf-8');
                const parsed = JSON.parse(raw);
                details = parsed;
                if (config.statusField && parsed[config.statusField]) {
                    if (config.statusMap) {
                        status = config.statusMap[parsed[config.statusField]] || parsed[config.statusField];
                    }
                    else {
                        status = 'configured';
                    }
                }
            }
            catch (err) {
                console.error(`[pi-monitor] Failed to read extension config for ${extId}:`, err);
                status = 'error';
            }
        }
        extensions.push({
            name: extId,
            displayName: config.displayName,
            configPath: config.configPath,
            hasConfig,
            status,
            details
        });
    }
    // Update the shared state array in place
    extensionsState.length = 0;
    extensionsState.push(...extensions);
}
