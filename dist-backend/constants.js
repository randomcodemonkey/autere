import { join } from 'path';
import { homedir } from 'os';
export const PI_DIR = join(homedir(), '.pi', 'agent');
export const AUTH_TOKENS_FILE = join(PI_DIR, 'monitor-auth-tokens.json');
export const AUTH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Known extension configurations
export const EXTENSION_CONFIGS = {
    'whatsapp-pi': {
        displayName: 'WhatsApp',
        configPath: join(PI_DIR, 'extensions', 'whatsapp-pi', 'config.json'),
        statusField: 'status',
        statusMap: { connected: 'connected', disconnected: 'error' }
    },
    'pi-9router-ext': {
        displayName: '9Router',
        configPath: join(PI_DIR, '9router-config.json'),
        statusField: 'baseUrl'
    }
};
