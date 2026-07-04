import React, { useState } from "react";
import {
  Sparkles,
  FileSearch,
  Diff,
  Copy,
  Trash2,
  ListFilter,
  Check,
  FolderTree,
  Loader,
  AlertCircle,
} from "lucide-react";
import { Repo } from "../types";

interface InspectProps {
  activeRepo: Repo | null;
  activeBranch: string;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
}

export const Inspect: React.FC<InspectProps> = ({
  activeRepo,
  activeBranch,
  githubProxyRequest,
}) => {
  const [output, setOutput] = useState<string>("");
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");

  const handleCopy = () => {
    if (!output) return;
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const runSnapshot = async () => {
    if (!activeRepo) return;
    setLoadingAction("snapshot");
    setOutput("Generating repository snapshot. Reading tree and commit history...\n");
    try {
      // 1. Fetch file tree recursively
      const treeData = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/git/trees/${activeBranch}?recursive=1`,
        "GET"
      );

      // 2. Fetch commits
      const commitsData = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/commits?sha=${activeBranch}&per_page=10`,
        "GET"
      );

      // 3. Try to read README.md
      let readmeContent = "(no README.md found at root)";
      try {
        const readmeFile = await githubProxyRequest(
          `/repos/${activeRepo.full_name}/contents/README.md?ref=${activeBranch}`,
          "GET"
        );
        if (readmeFile.encoding === "base64") {
          readmeContent = decodeURIComponent(escape(atob(readmeFile.content.replace(/\n/g, ""))));
        }
      } catch (err) {
        // Ignored
      }

      // Format snapshot
      const blobs = (treeData.tree || []).filter((item: any) => item.type === "blob");
      const fileTreeText = blobs
        .map((item: any) => `  ${item.path} (${item.size ? (item.size / 1024).toFixed(1) : 0} KB)`)
        .join("\n");

      const commitsText = commitsData
        .map(
          (c: any, index: number) =>
            `  [${index + 1}] ${c.sha.substring(0, 7)}: ${c.commit?.message?.split("\n")[0]} (${
              c.commit?.author?.name
            })`
        )
        .join("\n");

      const compiledOutput = `=== REPOSITORY SNAPSHOT: ${activeRepo.full_name} ===
Branch: ${activeBranch}
Files Count: ${blobs.length}

--- 🌿 DIRECTORY STRUCTURE ---
${fileTreeText || "  (Empty Repository)"}

--- 📄 README.md ---
${readmeContent}

--- 🌿 LAST 10 COMMITS ---
${commitsText || "  (No commits found)"}
`;

      setOutput(compiledOutput);
    } catch (err: any) {
      setOutput(`Error generating snapshot: ${err.message || "Unknown error"}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const runCodeSearch = async () => {
    if (!activeRepo) return;
    if (!searchQuery.trim()) {
      alert("Please enter a keyword to search.");
      return;
    }
    setLoadingAction("search");
    setOutput(`Searching for keyword "${searchQuery}" inside code files...\n`);
    try {
      const data = await githubProxyRequest(
        `/search/code?q=${encodeURIComponent(`${searchQuery} repo:${activeRepo.full_name}`)}`,
        "GET"
      );

      const items = data.items || [];
      if (items.length === 0) {
        setOutput(`=== CODE SEARCH RESULTS: "${searchQuery}" ===\nNo matches found in repository.`);
      } else {
        const resultLines = items
          .map((item: any, i: number) => `  [${i + 1}] Path: ${item.path}\n      View file: ${item.html_url}`)
          .join("\n\n");

        setOutput(`=== CODE SEARCH RESULTS: "${searchQuery}" ===
Total Files Matched: ${items.length}

${resultLines}`);
      }
    } catch (err: any) {
      setOutput(`Error performing code search: ${err.message || "Unknown error"}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const runLatestDiff = async () => {
    if (!activeRepo) return;
    setLoadingAction("diff");
    setOutput("Loading the latest commit diff metadata...\n");
    try {
      const commits = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/commits?sha=${activeBranch}&per_page=1`,
        "GET"
      );

      if (commits.length === 0) {
        setOutput("No commits found in this branch yet.");
        return;
      }

      const latestSha = commits[0].sha;
      const commitDetails = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/commits/${latestSha}`,
        "GET"
      );

      const filesChanged = commitDetails.files || [];
      const filesSummary = filesChanged
        .map(
          (f: any) =>
            `--- FILE: ${f.filename} (${f.status})\n    +${f.additions} insertions, -${f.deletions} deletions\n\n${
              f.patch || "(binary modifications, no diff patch available)"
            }`
        )
        .join("\n\n========================================\n\n");

      const diffOutput = `=== LATEST COMMIT DETAILS: ${latestSha.substring(0, 7)} ===
Author: ${commitDetails.commit?.author?.name} (${commitDetails.commit?.author?.email})
Date: ${commitDetails.commit?.author?.date}
Message: ${commitDetails.commit?.message}

--- 📝 MODIFIED FILES (${filesChanged.length} changed) ---
${filesSummary || "No physical code file changes detected."}
`;

      setOutput(diffOutput);
    } catch (err: any) {
      setOutput(`Error fetching latest diff: ${err.message || "Unknown error"}`);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div id="screen-inspect" className="space-y-4 animate-fadein">
      {/* Header */}
      <div className="mb-1">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Inspect Repository</h2>
        <p className="text-xs text-slate-400">Bundle repository context, run code queries, or parse commits</p>
      </div>

      {!activeRepo ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-3">
          <AlertCircle className="w-10 h-10 text-slate-700 mx-auto" />
          <p className="text-sm font-semibold">Active repository context required.</p>
          <p className="text-xs max-w-sm mx-auto">
            Please connect your GitHub account and select a repository using the dropdown menu in the sidebar first.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Controls Column */}
          <div className="lg:col-span-4 space-y-3 shrink-0">
            {/* Snapshot Trigger */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
                <FolderTree className="w-4 h-4 text-blue-500" />
                Context Snapshot
              </h3>
              <p className="text-[10px] text-slate-400">
                Pulls the complete repository file tree structure, README documentation, and last 10 commit logs.
              </p>
              <button
                onClick={runSnapshot}
                disabled={loadingAction !== null}
                className="w-full h-10 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
              >
                {loadingAction === "snapshot" ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate Code Snapshot
              </button>
            </div>

            {/* Keyword Search */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
                <FileSearch className="w-4 h-4 text-amber-500" />
                Keyword search
              </h3>
              <p className="text-[10px] text-slate-400">
                Queries GitHub code search index to find files matching your keyword.
              </p>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="e.g. useEffect"
                  className="flex-1 h-9 px-2.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-xs text-slate-200 outline-none"
                />
                <button
                  onClick={runCodeSearch}
                  disabled={loadingAction !== null}
                  className="h-9 px-3.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-semibold text-xs rounded-lg flex items-center justify-center active:scale-95 disabled:opacity-50 transition cursor-pointer"
                >
                  {loadingAction === "search" ? (
                    <Loader className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    "Search"
                  )}
                </button>
              </div>
            </div>

            {/* Git Diff */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
                <Diff className="w-4 h-4 text-emerald-500" />
                Code Commit Diff
              </h3>
              <p className="text-[10px] text-slate-400">
                Pulls detailed patch modifications and lines added/removed from the latest commit.
              </p>
              <button
                onClick={runLatestDiff}
                disabled={loadingAction !== null}
                className="w-full h-10 border border-slate-700 hover:bg-slate-850 disabled:opacity-50 text-slate-200 font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
              >
                {loadingAction === "diff" ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Diff className="w-4 h-4 text-emerald-500" />
                )}
                Pull Latest Commit Diff
              </button>
            </div>
          </div>

          {/* Outputs Column */}
          <div className="lg:col-span-8 flex flex-col h-[400px] lg:h-auto">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col flex-1">
              <div className="flex items-center justify-between text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
                <span className="flex items-center gap-1.5">
                  <ListFilter className="w-4 h-4 text-blue-500" />
                  Context Payload Output
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    disabled={!output}
                    className="text-[10px] text-blue-400 hover:text-blue-300 font-bold tracking-wider flex items-center gap-1 disabled:opacity-30 cursor-pointer"
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    {copied ? "Copied" : "Copy Payload"}
                  </button>
                  <button
                    onClick={() => setOutput("")}
                    disabled={!output}
                    className="text-[10px] text-rose-400 hover:text-rose-300 font-bold tracking-wider flex items-center gap-1 disabled:opacity-30 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                </div>
              </div>

              {/* Textarea dump */}
              <textarea
                value={output}
                readOnly
                placeholder="Diagnostic metadata and snapshots will compile here..."
                className="w-full flex-1 min-h-[220px] p-3.5 bg-slate-950 border border-slate-850 rounded-lg text-slate-300 font-mono text-[11px] leading-relaxed outline-none resize-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
