# `@shoprag/shop-github-repo`

This is a Shop plugin for [ShopRAG](https://github.com/shoprag/core), designed to fetch and synchronize files from a GitHub repository. It integrates seamlessly with ShopRAG's data pipeline, allowing you to pull files from a specified repository, apply filters, optionally add metadata headers, and keep your local dataset up-to-date with changes from GitHub.

---

## Features

- **Fetch files from a GitHub repository**: Specify a repo URL and branch to pull files from.
- **Filtering with include/ignore globs**: Use patterns like `**/*.md` to include only certain files or exclude others (e.g., `node_modules/**`).
- **Efficient updates**: Only fetches and updates files that have changed since the last run, based on commit timestamps.
- **Update interval control**: Define how often the Shop checks for updates (e.g., every hour, day, or week).
- **Optional Content Header**: Automatically prepend metadata (repo details, file path, permalink URL, modification date) to the fetched file content.
- **First-run support**: Automatically adds all filtered files from the repo on the initial run.

---

## Installation

To use this Shop plugin, you need to have [ShopRAG](https://github.com/shoprag/core) installed globally. Then, install this plugin globally via npm:

```bash
npm install -g @shoprag/shop-github-repo
```

---

## Usage

Follow these steps to configure and run the plugin in your ShopRAG project.

### Step 1: Configure `shoprag.json`

In your ShopRAG project directory, add this Shop to your `shoprag.json` file under the `Shops` array. Below is an example configuration:

```json
{
  "Project_Name": "MyDataProject",
  "ShopRAG": "1.0",
  "Shops": [
    {
      "from": "github-repo",
      "config": {
        "repoUrl": "https://github.com/your-org/your-repo",
        "branch": "main",
        "updateInterval": "1d",
        "include": ["**/*.md", "**/*.txt"],
        "ignore": ["node_modules/**", ".github/**"]
      }
    }
  ],
  "RAGs": [
    {
      "to": "dir",
      "config": {
        "outputDir": "./data"
      }
    }
    // ... potentially other RAGs
  ]
}
```

### Step 2: Provide Credentials

This Shop requires a GitHub personal access token to authenticate API requests. If you haven't already provided one, ShopRAG will prompt you to enter your token when you run the pipeline.

To generate a token:
1. Go to [GitHub's token settings](https://github.com/settings/tokens).
2. Click **Generate new token**.
3. Select scopes (e.g., `repo` for private repositories).
4. Copy the token and provide it when prompted by ShopRAG.

Your token will be securely stored in `~/.shoprag/creds.json` for future use.

### Step 3: Run ShopRAG

Once configured, run the ShopRAG pipeline:

```bash
shoprag
```

The plugin will:
- Fetch files from the specified repository and branch.
- Apply include/ignore filters.
- Add new files, update changed files, or mark deleted files based on the repository's state.
- Respect the update interval to avoid unnecessary API calls.

---

## Configuration Options

The following options can be specified in the `config` object for the `github-repo` shop in your `shoprag.json`:

| Option          | Description                                                                                                         | Type                    | Default       | Required     |
|-----------------|---------------------------------------------------------------------------------------------------------------------|-------------------------|---------------|--------------|
| `repoUrl`       | The HTTPS URL of the GitHub repository (e.g., `https://github.com/user/repo`).                                      | `string`                | -             | **Yes**      |
| `branch`        | The branch, tag, or commit SHA to fetch files from.                                                                 | `string`                | `"main"`      | No           |
| `updateInterval`| Minimum time between update checks (e.g., `5m`, `1h`, `1d`, `1w` for minutes, hours, days, weeks).                     | `string`                | `"1d"`        | No           |
| `include`       | Glob patterns or array of glob patterns specifying files to include. Uses [minimatch](https://github.com/isaacs/minimatch). | `string` \| `string[]`  | `["**/*"]`    | No           |
| `ignore`        | Glob patterns or array of glob patterns specifying files to exclude. Exclusions override inclusions.                    | `string` \| `string[]`  | `[]`          | No           |
| `includeHeader` | If `true`, prepend a metadata header to the content of each fetched file. See format below.                           | `boolean`               | `true`        | No           |

### Header Format (`includeHeader: true`)

When `includeHeader` is enabled, the content passed to the RAG will look like this:

```
File from the GitHub Repo ${owner}/${repo}
Path: ${pathInRepo}
Repo URL: ${repoURL}
File URL (permalink): ${fileURL}
Date modified: ${isoTimestamp}
----------
${originalFileContent}
[end of ${pathInRepo}]
```

- `${owner}/${repo}`: Repository owner and name.
- `${pathInRepo}`: Full path to the file within the repository.
- `${repoURL}`: The base URL of the repository provided in `repoUrl`.
- `${fileURL}`: A permalink URL pointing to the specific version (commit SHA) of the file on GitHub.
- `${isoTimestamp}`: The ISO 8601 timestamp of the last commit that modified the file.
- `${originalFileContent}`: The actual content of the file.

---

## How It Works

- **First Run**: Adds all files from the repository that match the include/ignore filters.
- **Subsequent Runs**:
  - Checks if the update interval has passed since the last run.
  - Fetches the current repository tree and filters files.
  - Compares file commit times with ShopRAG's last update timestamps.
  - Returns only added, updated, or deleted files since the last run.
- **File IDs**: Each file is assigned a unique ID like `github-repo-user-repo-file-path`, ensuring no conflicts across repositories.

This approach ensures efficiency by minimizing API calls and only processing changes.

---

## Troubleshooting

- **Invalid repo URL**: Ensure the `repoUrl` is correctly formatted (e.g., `https://github.com/user/repo`).
- **Missing token**: If prompted for a token, make sure to provide a valid GitHub personal access token.
- **Rate limiting**: GitHub's API has rate limits. If you hit them, consider increasing the `updateInterval`.
- **File not found**: If a file is missing, double-check your include/ignore patterns.

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/shoprag/shop-github-repo).

---

## License

This project is licensed under the MIT License.
