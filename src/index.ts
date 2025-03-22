import { Shop } from '@shoprag/core';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';

export default class GitHubRepoShop implements Shop {
    private octokit: Octokit;
    private config: { [key: string]: string };
    private updateIntervalMs: number;

    requiredCredentials(): { [credentialName: string]: string } {
        return {
            github_token: `To obtain a GitHub token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes (e.g., 'repo' for private repos)
4. Copy the token and paste it here.`
        };
    }

    async init(credentials: { [key: string]: string }, config: { [key: string]: string }): Promise<void> {
        this.config = config;
        const token = credentials['github_token'];
        if (!token) {
            throw new Error('GitHub token is required.');
        }
        this.octokit = new Octokit({ auth: token });

        const interval = config['updateInterval'] || '1d';
        this.updateIntervalMs = this.parseInterval(interval);
    }

    private parseInterval(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            default: throw new Error(`Invalid interval unit: ${unit}`);
        }
    }

    private getRepoInfo(): { owner: string; repo: string } {
        const url = this.config['repoUrl'];
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error(`Invalid GitHub repo URL: ${url}`);
        }
        return { owner: match[1], repo: match[2] };
    }

    private async getRepoTree(): Promise<any> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] || 'main';
        const response = await this.octokit.git.getTree({
            owner,
            repo,
            tree_sha: branch,
            recursive: "true"
        });
        return response.data.tree;
    }

    private shouldInclude(path: string): boolean {
        const includePatterns = this.config['include'] ? JSON.parse(this.config['include']) : ['**/*'];
        const ignorePatterns = this.config['ignore'] ? JSON.parse(this.config['ignore']) : [];
        const isIncluded = includePatterns.some((pattern: string) => minimatch(path, pattern));
        const isIgnored = ignorePatterns.some((pattern: string) => minimatch(path, pattern));
        return isIncluded && !isIgnored;
    }

    private async getCurrentFiles(): Promise<{ [path: string]: { fileId: string; content: string } }> {
        const tree = await this.getRepoTree();
        const files: { [path: string]: { fileId: string; content: string } } = {};
        for (const item of tree) {
            if (item.type === 'blob' && this.shouldInclude(item.path)) {
                const fileId = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-${item.path.replace(/\//g, '-')}`;
                const contentResponse = await this.octokit.git.getBlob({
                    owner: this.getRepoInfo().owner,
                    repo: this.getRepoInfo().repo,
                    file_sha: item.sha
                });
                const content = Buffer.from(contentResponse.data.content, 'base64').toString('utf-8');
                files[item.path] = { fileId, content };
            }
        }
        return files;
    }

    private fileIdToPath(fileId: string): string {
        const prefix = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-`;
        if (!fileId.startsWith(prefix)) {
            throw new Error(`Invalid fileId: ${fileId}`);
        }
        return fileId.slice(prefix.length).replace(/-/g, '/');
    }

    private async getLastCommitTimeForFile(path: string): Promise<number> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] || 'main';
        const response = await this.octokit.repos.listCommits({
            owner,
            repo,
            sha: branch,
            path: path,
            per_page: 1
        });
        if (response.data.length === 0) {
            return 0;
        }
        return new Date(response.data[0].commit.author.date).getTime();
    }

    async update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number }
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }> {
        const now = Date.now();
        if (now - lastUsed < this.updateIntervalMs) {
            console.log(`Update interval not reached. Skipping update for ${this.config['repoUrl']}`);
            return {};
        }

        const currentFiles = await this.getCurrentFiles();
        const updates: { [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } } = {};

        const existingPaths: { [fileId: string]: string } = {};
        for (const fileId in existingFiles) {
            existingPaths[fileId] = this.fileIdToPath(fileId);
        }

        for (const fileId in existingFiles) {
            const path = existingPaths[fileId];
            if (!(path in currentFiles)) {
                updates[fileId] = { action: 'delete' };
            }
        }

        for (const path in currentFiles) {
            const { fileId, content } = currentFiles[path];
            if (!(fileId in existingFiles)) {
                updates[fileId] = { action: 'add', content };
            } else {
                const lastUpdated = existingFiles[fileId];
                const lastCommitTime = await this.getLastCommitTimeForFile(path);
                if (lastCommitTime > lastUpdated) {
                    updates[fileId] = { action: 'update', content };
                }
            }
        }

        return updates;
    }
}