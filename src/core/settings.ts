export interface Settings { enabled: boolean }
export const SETTINGS_KEY = 'cwq:settings:v1';
export const SETTINGS_CHANNEL = 'chatgpt-web-queue-settings-v1';
export const defaultSettings = (): Settings => ({ enabled: true });
export function parseSettings(value: unknown): Settings {
  return { enabled: !(value && typeof value === 'object' && 'enabled' in value && value.enabled === false) };
}
export interface SettingsRequest {
  channel: typeof SETTINGS_CHANNEL;
  action: { type: 'get' } | { type: 'setEnabled'; enabled: boolean };
}
