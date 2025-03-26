import { Shop, JsonObject } from '@shoprag/core';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import cliProgress from 'cli-progress';
import { GetResponseTypeFromEndpointMethod } from "@octokit/types"; // Helper type

// Define types for Octokit responses we use frequently
type TreeItem = {
    path?: string | undefined;
    mode?: string | undefined;
    type?: string | undefined;
    sha?: string | undefined;
    size?: number | undefined;
    url?: string | undefined;
};

export default class GitHubRepoShop implements Shop {
    private octokit: Octokit;
    private config: JsonObject;
    private updateIntervalMs: number;
    private repoInfo: { owner: string; repo: string };
    private repoUrl: string;
    private branch: string;
    private shouldIncludeHeader: boolean;

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

        // Extract and store repo info early
        this.repoUrl = this.config['repoUrl'] as string;
        if (!this.repoUrl) {
            throw new Error('GitHub repo URL (repoUrl) is required in config.');
        }
        this.repoInfo = this.getRepoInfoFromUrl(this.repoUrl);
        this.branch = this.config['branch'] as string || 'master';

        // Read the includeHeader config option, defaulting to true
        this.shouldIncludeHeader = this.config['includeHeader'] !== undefined
            ? Boolean(this.config['includeHeader'])
            : true;
    }

    /** Parses a time interval string (e.g., '1d') into milliseconds */
    private parseInterval(interval: string): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1), 10);
        if (isNaN(value)) {
            throw new Error(`Invalid interval value: ${interval.slice(0, -1)}`);
        }
        switch (unit) {
            case 'm': return value * 60 * 1000; // minutes
            case 'h': return value * 60 * 60 * 1000; // hours
            case 'd': return value * 24 * 60 * 60 * 1000; // days
            case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks
            default: throw new Error(`Invalid interval unit: ${unit}. Use m, h, d, or w.`);
        }
    }

    /** Extracts owner and repo name from the repository URL */
    private getRepoInfoFromUrl(url: string): { owner: string; repo: string } {
        const match = url.match(/github\.com[/:]([^\/]+)\/([^\/]+?)(\.git)?$/i);
        if (!match) {
            throw new Error(`Invalid GitHub repo URL: ${url}`);
        }
        return { owner: match[1], repo: match[2] };
    }

    /** Fetches the recursive tree of the repository for the specified branch */
    private async getRepoTree(): Promise<TreeItem[]> {
        const { owner, repo } = this.repoInfo;
        try {
            const response = await this.octokit.git.getTree({
                owner,
                repo,
                tree_sha: this.branch,
                recursive: '1' // Use '1' for true as per Octokit docs recommendation
            });
            // Filter out potential null/undefined paths just in case
            return response.data.tree.filter(item => item.path !== undefined && item.path !== null) as TreeItem[];
        } catch (error: any) {
            if (error.status === 404) {
                throw new Error(`Branch '${this.branch}' not found in repo ${owner}/${repo}.`);
            }
            throw error; // Re-throw other errors
        }
    }

    /** Determines if a file path should be included based on config patterns */
    private shouldInclude(path: string): boolean {
        // Ensure patterns are always arrays
        const includePatterns = Array.isArray(this.config['include'])
            ? this.config['include'] as string[]
            : (this.config['include'] ? [this.config['include'] as string] : ['**/*']);

        const ignorePatterns = Array.isArray(this.config['ignore'])
            ? this.config['ignore'] as string[]
            : (this.config['ignore'] ? [this.config['ignore'] as string] : []);

        // Use { dot: true } to match hidden files if patterns start with '.'
        const options = { dot: true };
        const isIncluded = includePatterns.some((pattern: string) => minimatch(path, pattern, options));
        const isIgnored = ignorePatterns.some((pattern: string) => minimatch(path, pattern, options));

        return isIncluded && !isIgnored;
    }

    /** Formats the file content with the specified header and footer */
    private formatFileContentWithHeader(
        rawContent: string,
        pathInRepo: string,
        commitSha: string,
        commitDate: string | number | Date
    ): string {
        const { owner, repo } = this.repoInfo;
        const formattedDate = commitDate instanceof Date
            ? commitDate.toISOString()
            : new Date(commitDate).toISOString();

        // Construct permalink URL
        const fileURL = `${this.repoUrl}/blob/${commitSha}/${pathInRepo}`;

        const header = `File from the GitHub Repo ${owner}/${repo}
Path: ${pathInRepo}
Repo URL: ${this.repoUrl}
File URL (permalink): ${fileURL}
Date modified: ${formattedDate}
----------`;

        const footer = `[end of ${pathInRepo}]`;

        return `${header}\n${rawContent}\n${footer}`;
    }

    /** Fetches the raw content of a blob */
    private async fetchBlobContent(fileSha: string): Promise<string> {
        const { owner, repo } = this.repoInfo;
        const contentResponse = await this.octokit.git.getBlob({
            owner,
            repo,
            file_sha: fileSha
        });
        return Buffer.from(contentResponse.data.content, 'base64').toString('utf-8');
    }

    /** Gets the latest commit SHA and date for the specified branch */
    private async getBranchInfo(): Promise<{ sha: string; date: string }> {
        const { owner, repo } = this.repoInfo;
        try {
            const response = await this.octokit.repos.getBranch({
                owner,
                repo,
                branch: this.branch,
            });
            const commitSha = response.data.commit.sha;
            // Fetch the commit details to get the author date
            const commitResponse = await this.octokit.git.getCommit({
                owner,
                repo,
                commit_sha: commitSha,
            });
            const commitDate = commitResponse.data.author.date;
            if (!commitDate) {
                console.warn(`Could not retrieve commit date for branch ${this.branch}. Using current time.`);
                return { sha: commitSha, date: new Date().toISOString() };
            }
            return { sha: commitSha, date: commitDate };
        } catch (error: any) {
            if (error.status === 404) {
                throw new Error(`Branch '${this.branch}' not found when fetching branch info for ${owner}/${repo}.`);
            }
            console.error(`Error fetching branch info for ${this.branch}:`, error);
            throw new Error(`Could not fetch branch info for ${this.branch}.`);
        }
    }


    /** Fetches the current files in the repository, optionally adding headers */
    private async getCurrentFiles(): Promise<{ [path: string]: { fileId: string; rawContent: string } }> {
        const tree = await this.getRepoTree();
        const filesToInclude = tree.filter(item => item.type === 'blob' && item.path && this.shouldInclude(item.path));
        const totalFiles = filesToInclude.length;

        if (totalFiles === 0) {
            console.log(`No files matched include/ignore patterns in ${this.repoInfo.owner}/${this.repoInfo.repo}#${this.branch}.`);
            return {};
        }

        console.log(`Fetching ${totalFiles} files from ${this.repoInfo.owner}/${this.repoInfo.repo}#${this.branch}...`);

        const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        bar.start(totalFiles, 0);

        const { owner, repo } = this.repoInfo;

        // Fetch all file contents in parallel
        const fetchPromises = filesToInclude.map(async (item) => {
            // Type assertion: We've filtered for defined path and sha previously
            const path = item.path!;
            const sha = item.sha!;
            const fileId = `github-repo-${owner}-${repo}-${path.replace(/\//g, '-')}`;
            try {
                const rawContent = await this.fetchBlobContent(sha);
                bar.increment();
                return { path, fileId, rawContent };
            } catch (error) {
                console.error(`\nError fetching content for ${path} (sha: ${sha}):`, error);
                bar.increment(); // Still increment to not hang the progress bar
                return null; // Indicate failure
            }
        });

        const results = (await Promise.all(fetchPromises)).filter(r => r !== null); // Filter out failed fetches
        bar.stop();

        if (results.length < totalFiles) {
            console.warn(`\nWarning: Failed to fetch ${totalFiles - results.length} files.`);
        }

        // Build the files object
        const files: { [path: string]: { fileId: string; rawContent: string } } = {};
        for (const result of results) {
            if (result) { // Ensure result is not null
                files[result.path] = { fileId: result.fileId, rawContent: result.rawContent };
            }
        }
        return files;
    }

    /** Converts a fileId back to its original file path */
    private fileIdToPath(fileId: string): string {
        const { owner, repo } = this.repoInfo;
        const prefix = `github-repo-${owner}-${repo}-`;
        if (!fileId.startsWith(prefix)) {
            // Fallback for potentially old fileId formats if necessary, or just error
            console.warn(`Encountered potentially invalid fileId format: ${fileId}`);
            // Attempt a reasonable guess, assuming format was always path with replaced slashes
            const possiblePath = fileId.substring(fileId.indexOf('-') + 1).replace(/-/g, '/');
            if (possiblePath.length > 0) return possiblePath; // Basic check
            throw new Error(`Invalid fileId: ${fileId}`);
        }
        // Standard conversion
        return fileId.slice(prefix.length).replace(/-/g, '/');
    }

    /** Gets the last commit info (SHA and timestamp) for a specific file */
    private async getLastCommitInfoForFile(path: string): Promise<{ sha: string; timestamp: number } | null> {
        const { owner, repo } = this.repoInfo;
        try {
            const response = await this.octokit.repos.listCommits({
                owner,
                repo,
                sha: this.branch,
                path: path,
                per_page: 1
            });
            if (response.data.length === 0 || !response.data[0].commit?.author?.date) {
                // Could happen if file exists but has no commit history (unlikely?) or API issue
                console.warn(`No commit history found for file ${path} on branch ${this.branch}.`);
                return null;
            }
            const commit = response.data[0];
            const timestamp = new Date(commit.commit.author.date).getTime();
            return { sha: commit.sha, timestamp };
        } catch (error: any) {
            console.error(`\nError fetching last commit for ${path}:`, error);
            return null; // Return null on error to avoid breaking the update process
        }
    }

    /** Updates the shop by comparing existing files with current repository state */
    async update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number } // fileId -> last updated timestamp
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } }> {
        const now = Date.now();
        if (now - lastUsed < this.updateIntervalMs) {
            console.log(`Update interval not reached for ${this.repoUrl}. Skipping update.`);
            return {};
        }

        console.log(`Starting update check for ${this.repoUrl} (branch: ${this.branch})...`);
        const currentFiles = await this.getCurrentFiles(); // Fetches { path: { fileId, rawContent } }
        const updates: { [fileId: string]: { action: 'add' | 'update' | 'delete', content?: string } } = {};

        // --- Pre-fetch branch info if header inclusion is enabled ---
        let branchInfo: { sha: string; date: string } | null = null;
        if (this.shouldIncludeHeader) {
            try {
                branchInfo = await this.getBranchInfo();
            } catch (error) {
                console.error(`\nFailed to get branch info for header generation. Headers might be incomplete or missing. Error:`, error);
            }
        }
        // --- End pre-fetch ---


        // Map existing fileIds to paths for easier lookup
        const existingPaths: { [fileId: string]: string } = {};
        const existingFileIds = new Set(Object.keys(existingFiles));
        for (const fileId of existingFileIds) {
            try {
                existingPaths[fileId] = this.fileIdToPath(fileId);
            } catch (error) {
                console.warn(`\nCould not map existing fileId to path: ${error}. Marking as deleted.`);
                updates[fileId] = { action: 'delete' };
                existingFileIds.delete(fileId); // Remove from further processing
            }
        }

        // Map current paths to fileIds for easier lookup
        const currentPathsToFileId: { [path: string]: string } = {};
        for (const path in currentFiles) {
            currentPathsToFileId[path] = currentFiles[path].fileId;
        }
        const currentFilePaths = new Set(Object.keys(currentFiles));


        // 1. Identify deleted files
        for (const fileId of existingFileIds) {
            // Check if the path derived from the existing fileId is present in the current file list
            const path = existingPaths[fileId];
            if (!currentFilePaths.has(path)) {
                updates[fileId] = { action: 'delete' };
            }
        }

        // 2. Identify added files and prepare content
        for (const path of currentFilePaths) {
            const { fileId, rawContent } = currentFiles[path];
            if (!existingFileIds.has(fileId)) {
                let finalContent = rawContent;
                if (this.shouldIncludeHeader && branchInfo) {
                    // Use branch commit info for newly added files
                    finalContent = this.formatFileContentWithHeader(rawContent, path, branchInfo.sha, branchInfo.date);
                } else if (this.shouldIncludeHeader) {
                    console.warn(`Skipping header for added file ${path} due to missing branch info.`);
                }
                updates[fileId] = { action: 'add', content: finalContent };
            }
        }

        // 3. Check existing files for updates
        const filesToCheckForUpdate = [...existingFileIds].filter(fileId =>
            !updates[fileId] && // Not already marked for deletion
            currentPathsToFileId[existingPaths[fileId]] === fileId // Ensure path mapping hasn't changed unexpectedly
        );

        if (filesToCheckForUpdate.length > 0) {
            console.log(`Checking ${filesToCheckForUpdate.length} existing files for modifications...`);
            const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            bar.start(filesToCheckForUpdate.length, 0);

            // Process checks in parallel
            const checkPromises = filesToCheckForUpdate.map(async (fileId) => {
                const path = existingPaths[fileId];
                const lastIndexedTimestamp = existingFiles[fileId];
                const commitInfo = await this.getLastCommitInfoForFile(path);
                bar.increment();

                if (commitInfo && commitInfo.timestamp > lastIndexedTimestamp) {
                    // File has been updated since last index
                    const { rawContent } = currentFiles[path];
                    let finalContent = rawContent;
                    if (this.shouldIncludeHeader) {
                        // Use the specific commit info for the header of updated files
                        finalContent = this.formatFileContentWithHeader(rawContent, path, commitInfo.sha, commitInfo.timestamp);
                    }
                    return { fileId, action: 'update', content: finalContent };
                }
                return null; // No update needed or error occurred
            });

            const checkResults = (await Promise.all(checkPromises)).filter(r => r !== null);
            bar.stop();

            // Apply updates found
            for (const result of checkResults) {
                if (result) {
                    updates[result.fileId] = { action: 'update', content: result.content };
                }
            }
        } else {
            console.log("No existing files to check for modifications.");
        }

        const updateCount = Object.keys(updates).length;
        const addedCount = Object.values(updates).filter(u => u.action === 'add').length;
        const updatedCount = Object.values(updates).filter(u => u.action === 'update').length;
        const deletedCount = Object.values(updates).filter(u => u.action === 'delete').length;

        if (updateCount > 0) {
            console.log(`Update check complete for ${this.repoUrl}: ${addedCount} added, ${updatedCount} updated, ${deletedCount} deleted.`);
        } else {
            console.log(`Update check complete for ${this.repoUrl}: No changes detected.`);
        }

        return updates;
    }
}
