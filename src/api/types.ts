/**
 * API response types mirroring Silent Stone server types.
 * Source of truth: src/lib/core/folder-types.ts in the server codebase.
 */

export interface FolderDevice {
	deviceID: string;
	hasEncryptionPassword: boolean;
}

export interface FolderStatus {
	state: string;
	globalBytes: number;
	globalFiles: number;
	inSyncBytes: number;
	inSyncFiles: number;
	pullErrors?: number;
	error?: string;
}

export interface FolderInfo {
	id: string;
	label: string;
	path: string;
	type: string;
	encrypted: boolean;
	browsable?: boolean;
	notBrowsableReason?: 'encrypted-no-password' | 'outside-sync-dir';
	devices: FolderDevice[];
	status?: FolderStatus;
}

export interface TokenResponse {
	ok: boolean;
	token?: string;
	role?: string;
	nickname?: string;
	error?: string;
}

export interface MeResponse {
	nickname: string;
	role: string;
}

export interface FileEntry {
	name: string;
	isDir: boolean;
	size: number;
	modTime: string;
}

export interface ApiError {
	error: string;
}
