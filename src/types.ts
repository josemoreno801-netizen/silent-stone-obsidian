export interface SilentStoneSyncSettings {
	// Connection
	serverUrl: string;
	nickname: string;
	authToken: string;

	// Sync
	folderId: string;
	syncInterval: number;
	autoSync: boolean;
	syncOnStartup: boolean;

	// Advanced
	ignorePaths: string[];
	conflictStrategy: 'ask' | 'keep-local' | 'keep-server' | 'keep-both';
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: SilentStoneSyncSettings = {
  serverUrl: '',
  nickname: '',
  authToken: '',
  folderId: '',
  syncInterval: 5,
  autoSync: true,
  syncOnStartup: true,
  ignorePaths: ['.obsidian/**', '.trash/**'],
  conflictStrategy: 'ask',
  debugLogging: false,
};

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'not-configured';

export interface SyncFileState {
	localHash: string;
	serverTimestamp: string;
	lastSynced: string;
}

export interface SyncState {
	files: Record<string, SyncFileState>;
	lastFullSync: string;
}
