import { requestUrl } from 'obsidian';
import type { TokenResponse, MeResponse, FolderInfo, FileEntry } from './types';

export class SilentStoneClient {
  private serverUrl: string;
  private token: string;

  constructor(serverUrl: string, token: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.token = token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
	 * Authenticate and receive a Bearer token.
	 * Uses the new /api/auth/token endpoint (returns token in body).
	 */
  async login(nickname: string, password: string): Promise<TokenResponse> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/api/auth/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, password }),
    });
    return resp.json as TokenResponse;
  }

  /** Validate current token. Returns user info or throws on 401. */
  async me(): Promise<MeResponse> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/api/auth/me`,
      method: 'GET',
      headers: this.authHeaders(),
    });
    return resp.json as MeResponse;
  }

  /** List all folders on the server. */
  async listFolders(): Promise<FolderInfo[]> {
    const resp = await requestUrl({
      url: `${this.serverUrl}/api/folders`,
      method: 'GET',
      headers: this.authHeaders(),
    });
    return resp.json as FolderInfo[];
  }

  /** List files in a folder. */
  async listFiles(folderId: string, path = ''): Promise<FileEntry[]> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const resp = await requestUrl({
      url: `${this.serverUrl}/api/folders/${folderId}/files${query}`,
      method: 'GET',
      headers: this.authHeaders(),
    });
    return resp.json as FileEntry[];
  }

  /** Check server health (public endpoint). */
  async health(): Promise<boolean> {
    try {
      const resp = await requestUrl({
        url: `${this.serverUrl}/api/health`,
        method: 'GET',
      });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  // TODO: uploadFile — multipart upload via requestUrl
  // TODO: downloadFile — fetch file content
  // TODO: mkdir — create directory
  // TODO: deleteFile — delete file
}
