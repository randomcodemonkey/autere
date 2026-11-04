/**
 * Settings schema contract, shared by the backend (which builds it) and the
 * frontend (which renders it). One definition — the two copies drifted before.
 */

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'list' | 'packages' | 'textarea' | 'perModel' | 'folderIgnores' | 'mcpServers';
  min?: number;
  max?: number;
  placeholder?: string;
  options?: { value: string; label: string }[];
  description?: string;
  listPlaceholder?: string;
  listAddLabel?: string;
  /** Renderer config for type 'perModel': one control per entry of enabledModels */
  perModel?: {
    control: 'select' | 'number';
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
  };
}

export interface SettingSection {
  id: string;
  label: string;
  fields: SettingField[];
}
