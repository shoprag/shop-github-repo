import { Shop, JsonObject } from '@shoprag/core';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import cliProgress from 'cli-progress';

export default class GitHubRepoShop implements Shop {
    private octokit: Octokit;
    private config: JsonObject;
    private updateIntervalMs: number;

    /** Defines the required credentials for this shop */
    requiredCredentials(): { [credentialName: string]: string } {
        return {
            github_token: `To obtain a GitHub token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes (e.g., 'repo' for private repos)
4. Copy the token and paste it here.`
        };
    }

    /** Initializes the shop with credentials and configuration */
    async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
        this.config = config;
        const token = credentials['github_token'];
        if (!token) {
            throw new Error('GitHub token is required.');
        }
        this.octokit = new Octokit({ auth: token });

        const interval = config['updateInterval'] || '1d';
        this.updateIntervalMs = this.parseInterval(interval as string);
    }

    /** Parses a time interval string (e.g., '1d') into milliseconds */
    private parseInterval(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1), 10);
        switch (unit) {
            case 'm': return value * 60 * 1000; // minutes
            case 'h': return value * 60 * 60 * 1000; // hours
            case 'd': return value * 24 * 60 * 60 * 1000; // days
            case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks
            default: throw new Error(`Invalid interval unit: ${unit}`);
        }
    }

    /** Extracts owner and repo name from the repository URL */
    private getRepoInfo(): { owner: string; repo: string } {
        const url = this.config['repoUrl'] as string;
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error(`Invalid GitHub repo URL: ${url}`);
        }
        return { owner: match[1], repo: match[2] };
    }

    /** Fetches the recursive tree of the repository for the specified branch */
    private async getRepoTree(): Promise<any> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] as string || 'master';
        const response = await this.octokit.git.getTree({
            owner,
            repo,
            tree_sha: branch,
            recursive: 'true'
        });
        return response.data.tree;
    }

    /** Determines if a file path should be included based on config patterns */
    private shouldInclude(path: string): boolean {
        const includePatterns = this.config['include'] ? this.config['include'] as string[] : ['**/*'];
        const ignorePatterns = this.config['ignore'] ? this.config['ignore'] as string[] : [];
        const isIncluded = includePatterns.some((pattern: string) => minimatch(path, pattern));
        const isIgnored = ignorePatterns.some((pattern: string) => minimatch(path, pattern));
        return isIncluded && !isIgnored;
    }

    /** Fetches the current files in the repository that match the include patterns */
    private async getCurrentFiles(): Promise<{ [path: string]: { fileId: string; content: string } }> {
        const tree = await this.getRepoTree();
        const filesToInclude = tree.filter(item => item.type === 'blob' && this.shouldInclude(item.path));
        const totalFiles = filesToInclude.length;
        console.log(`Fetching ${totalFiles} files...`);

        // Initialize progress bar
        const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        bar.start(totalFiles, 0);

        // Fetch all file contents in parallel
        const fetchPromises = filesToInclude.map(async (item) => {
            const fileId = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-${item.path.replace(/\//g, '-')}`;
            const contentResponse = await this.octokit.git.getBlob({
                owner: this.getRepoInfo().owner,
                repo: this.getRepoInfo().repo,
                file_sha: item.sha
            });
            const content = Buffer.from(contentResponse.data.content, 'base64').toString('utf-8');
            bar.increment();
            return { path: item.path, fileId, content };
        });

        const results = await Promise.all(fetchPromises);
        bar.stop();

        // Build the files object
        const files: { [path: string]: { fileId: string; content: string } } = {};
        for (const result of results) {
            files[result.path] = { fileId: result.fileId, content: result.content };
        }
        return files;
    }

    /** Converts a fileId back to its original file path */
    private fileIdToPath(fileId: string): string {
        const prefix = `github-repo-${this.getRepoInfo().owner}-${this.getRepoInfo().repo}-`;
        if (!fileId.startsWith(prefix)) {
            throw new Error(`Invalid fileId: ${fileId}`);
        }
        return fileId.slice(prefix.length).replace(/-/g, '/');
    }

    /** Gets the timestamp of the last commit for a specific file */
    private async getLastCommitTimeForFile(path: string): Promise<number> {
        const { owner, repo } = this.getRepoInfo();
        const branch = this.config['branch'] as string || 'master';
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

    /** Updates the shop by comparing existing files with current repository state */
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

        // Map existing fileIds to paths for quick lookup
        const existingPaths: { [fileId: string]: string } = {};
        for (const fileId in existingFiles) {
            existingPaths[fileId] = this.fileIdToPath(fileId);
        }

        // Identify deleted files
        for (const fileId in existingFiles) {
            const path = existingPaths[fileId];
            if (!(path in currentFiles)) {
                updates[fileId] = { action: 'delete' };
            }
        }

        // Identify added files
        for (const path in currentFiles) {
            const { fileId, content } = currentFiles[path];
            if (!(fileId in existingFiles)) {
                updates[fileId] = { action: 'add', content };
            }
        }

        // Check for updated files
        const filesToCheck = Object.entries(existingFiles).filter(([fileId]) => {
            const path = existingPaths[fileId];
            return path in currentFiles;
        });

        if (filesToCheck.length > 0) {
            console.log(`Checking updates for ${filesToCheck.length} files...`);
            const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            bar.start(filesToCheck.length, 0);

            // Fetch last commit times in parallel
            const checkPromises = filesToCheck.map(async ([fileId, lastUpdated]) => {
                const path = existingPaths[fileId];
                const lastCommitTime = await this.getLastCommitTimeForFile(path);
                bar.increment();
                return { fileId, lastCommitTime, lastUpdated };
            });

            const checkResults = await Promise.all(checkPromises);
            bar.stop();

            // Determine updates based on commit times
            for (const { fileId, lastCommitTime, lastUpdated } of checkResults) {
                if (lastCommitTime > lastUpdated) {
                    const { content } = currentFiles[this.fileIdToPath(fileId)];
                    updates[fileId] = { action: 'update', content };
                }
            }
        }

        return updates;
    }
}
