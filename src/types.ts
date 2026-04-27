export interface SilentStoneSyncSettings {
	// Connection
	serverUrl: string;
	nickname: string;
	authToken: string;
	vaultAuthToken: string;

	// Sync
	folderId: string;
	syncInterval: number;
	autoSync: boolean;
	syncOnStartup: boolean;

	// Advanced
	ignorePaths: string[];
	conflictStrategy: 'ask' | 'keep-local' | 'keep-server' | 'keep-both';
	debugLogging: boolean;

	// Developer mode hides legacy Folder ID / Syncthing fields and other low-level controls
	// behind a collapsed section. Default off so the polished default UX is what most users see.
	developerMode: boolean;
}

export const DEFAULT_SETTINGS: SilentStoneSyncSettings = {
  serverUrl: '',
  nickname: '',
  authToken: '',
  vaultAuthToken: '',
  folderId: '',
  syncInterval: 5,
  autoSync: true,
  syncOnStartup: true,
  ignorePaths: ['.obsidian/**', '.trash/**'],
  conflictStrategy: 'ask',
  debugLogging: false,
  developerMode: false,
};

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'not-configured';

/**
 * Rich payload emitted by the sync engine on each state transition. Consumers
 * (settings panel, status bar) use it to render last-sync time + file count without
 * a follow-up request to the server.
 */
export interface SyncStatusEvent {
  state: 'idle' | 'syncing' | 'error';
  /** ISO 8601 timestamp of the most recent successful sync. */
  lastSyncAt?: string;
  /** Number of synced files (manifest entry count) at last successful sync. */
  fileCount?: number;
  /** Human-readable error reason when state === 'error'. */
  errorMessage?: string;
}

/**
 * Persisted slice of sync state restored on plugin reload so the settings panel
 * can render "47 files · just now" immediately on Obsidian open without waiting
 * for a fresh sync to populate the values.
 */
export interface PersistedSyncMetrics {
  lastSyncAt?: string;
  fileCount?: number;
  errorMessage?: string;
}

export interface SyncFileState {
	localHash: string;
	serverTimestamp: string;
	lastSynced: string;
}

export interface SyncState {
	files: Record<string, SyncFileState>;
	lastFullSync: string;
}
