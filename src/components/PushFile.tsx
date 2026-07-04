import React, { useState } from "react";
import {
  FileCode,
  FolderOpen,
  Layers,
  Upload,
  Terminal,
  Settings,
  AlertCircle,
  FilePlus,
  Play,
  CheckCircle,
} from "lucide-react";
import { Repo, PushLogEntry } from "../types";

interface PushFileProps {
  activeRepo: Repo | null;
  activeBranch: string;
  repos: Repo[];
  onRepoChange: (repoName: string) => void;
  onBranchChange: (branchName: string) => void;
  onPushSuccess: (logEntry: PushLogEntry) => void;
  pushLog: PushLogEntry[];
  onClearLog: () => void;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
}

interface ParsedFile {
  path: string;
  content: string;
  status: "pending" | "uploading" | "success" | "error";
}

export const PushFile: React.FC<PushFileProps> = ({
  activeRepo,
  activeBranch,
  repos,
  onRepoChange,
  onBranchChange,
  onPushSuccess,
  pushLog,
  onClearLog,
  githubProxyRequest,
}) => {
  const [mode, setMode] = useState<"new" | "edit" | "batch">("new");
  const [filePath, setFilePath] = useState<string>("");
  const [fileContent, setFileContent] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState<string>("Update via Mission Control");

  // Batch states
  const [batchInput, setBatchInput] = useState<string>("");
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [isDeployingBatch, setIsDeployingBatch] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [commitPrefix, setCommitPrefix] = useState<string>("Deploy");

  // Log function locally
  const [localLogs, setLocalLogs] = useState<{ time: string; msg: string; type: string }[]>([
    { time: new Date().toLocaleTimeString(), msg: "Push console initialized. Ready.", type: "info" },
  ]);

  const addLog = (msg: string, type: "info" | "success" | "warn" | "error") => {
    const time = new Date().toLocaleTimeString();
    setLocalLogs((prev) => [...prev, { time, msg, type }]);
  };

  const handleSinglePush = async () => {
    if (!activeRepo) {
      addLog("Push error: select a repository in the sidebar or config panel.", "error");
      return;
    }
    if (!filePath.trim()) {
      addLog("Push error: file path is required.", "warn");
      return;
    }
    if (!fileContent.trim()) {
      addLog("Push error: file content cannot be empty.", "warn");
      return;
    }

    const pathClean = filePath.trim().replace(/^\/+/, ""); // strip leading slash
    addLog(`Initiating push for "${pathClean}" to branch "${activeBranch}"...`, "info");

    try {
      // 1. Resolve existing file SHA to perform safe update
      let sha: string | undefined = undefined;
      try {
        const fileMeta = await githubProxyRequest(
          `/repos/${activeRepo.full_name}/contents/${pathClean}?ref=${activeBranch}`,
          "GET"
        );
        sha = fileMeta.sha;
        addLog(`File exists on GitHub (SHA: ${sha?.substring(0, 7)}). Planning an update.`, "info");
      } catch (err) {
        addLog("File does not exist yet. Planning creation.", "info");
      }

      // 2. Perform the file upload
      const body = {
        message: commitMessage || `Update ${pathClean}`,
        content: btoa(unescape(encodeURIComponent(fileContent))),
        branch: activeBranch,
        sha,
      };

      const result = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/contents/${pathClean}`,
        "PUT",
        body
      );

      const commitSha = result.commit?.sha?.substring(0, 7) || "unknown";
      addLog(`✓ Successfully pushed! Commit: ${commitSha}`, "success");

      // Notify parent to add state action logs
      onPushSuccess({
        id: Math.random().toString(),
        timestamp: new Date().toLocaleTimeString() + " - " + new Date().toLocaleDateString(),
        type: "success",
        message: `Pushed file "${pathClean}" (Commit: ${commitSha})`,
      });

      // Clear input on success for New Mode
      if (mode === "new") {
        setFilePath("");
        setFileContent("");
      }
    } catch (error: any) {
      addLog(`✗ Push failed: ${error.message || "Unknown error"}`, "error");
    }
  };

  // Batch Parser
  const handleParseBatch = () => {
    const files: ParsedFile[] = [];
    // Matches "FILE: path/to/file.ext\nContent:\n" up to next FILE: declaration
    const regex = /FILE:\s*([^\n]+)\s*\nContent:\s*\n([\s\S]*?)(?=\nFILE:|\s*$)/gi;
    let match;

    while ((match = regex.exec(batchInput)) !== null) {
      const pathRaw = match[1].trim();
      const contentRaw = match[2].trim();
      if (pathRaw && contentRaw && !files.some((f) => f.path === pathRaw)) {
        files.push({
          path: pathRaw,
          content: contentRaw,
          status: "pending",
        });
      }
    }

    if (files.length === 0) {
      addLog("Batch parser: could not extract files. Verify format matches 'FILE: <path>' followed by 'Content:'", "warn");
      return;
    }

    setParsedFiles(files);
    addLog(`Batch parser: successfully parsed ${files.length} file(s) for deployment.`, "info");
  };

  const handleDeployBatch = async () => {
    if (!activeRepo) {
      addLog("Deploy error: select a repository first.", "error");
      return;
    }
    if (parsedFiles.length === 0) {
      addLog("Deploy error: no parsed files to deploy.", "warn");
      return;
    }

    setIsDeployingBatch(true);
    addLog(`Starting batch deployment of ${parsedFiles.length} files...`, "info");

    const total = parsedFiles.length;
    let currentIdx = 0;

    for (let i = 0; i < parsedFiles.length; i++) {
      const file = parsedFiles[i];
      if (file.status === "success") continue; // skip already successfully pushed files

      // Update local file state
      setParsedFiles((prev) =>
        prev.map((f, idx) => (idx === i ? { ...f, status: "uploading" } : f))
      );
      setBatchProgress({ current: i + 1, total });

      try {
        const pathClean = file.path.trim().replace(/^\/+/, "");
        let sha: string | undefined = undefined;

        // Get file SHA if exists
        try {
          const fileMeta = await githubProxyRequest(
            `/repos/${activeRepo.full_name}/contents/${pathClean}?ref=${activeBranch}`,
            "GET"
          );
          sha = fileMeta.sha;
        } catch (err) {
          // File does not exist, ignore
        }

        const body = {
          message: `${commitPrefix || "Deploy"}: ${pathClean}`,
          content: btoa(unescape(encodeURIComponent(file.content))),
          branch: activeBranch,
          sha,
        };

        await githubProxyRequest(`/repos/${activeRepo.full_name}/contents/${pathClean}`, "PUT", body);

        setParsedFiles((prev) =>
          prev.map((f, idx) => (idx === i ? { ...f, status: "success" } : f))
        );
        addLog(`[Batch ${i + 1}/${total}] Successfully pushed "${pathClean}"`, "success");

        onPushSuccess({
          id: Math.random().toString(),
          timestamp: new Date().toLocaleTimeString() + " - " + new Date().toLocaleDateString(),
          type: "success",
          message: `Batch Pushed: "${pathClean}"`,
        });

        currentIdx++;
      } catch (err: any) {
        setParsedFiles((prev) =>
          prev.map((f, idx) => (idx === i ? { ...f, status: "error" } : f))
        );
        addLog(`[Batch ${i + 1}/${total}] ✗ Failed "${file.path}": ${err.message}`, "error");
      }

      // Small throttling delay to avoid rate limiting
      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    setIsDeployingBatch(false);
    addLog(`Batch deployment complete. Succeeded: ${currentIdx}/${total}`, "info");
  };

  return (
    <div id="screen-push" className="space-y-4 animate-fadein">
      <div className="mb-1">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Push to GitHub</h2>
        <p className="text-xs text-slate-400">Deploy singular changes or parse multi-file bundles</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Main interactive form */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 lg:col-span-7 space-y-4">
          {/* Tabs */}
          <div className="flex border border-slate-800 rounded-lg overflow-hidden shrink-0">
            <button
              id="push-mode-new"
              onClick={() => setMode("new")}
              className={`flex-1 flex items-center justify-center py-2 px-3 text-xs font-semibold gap-1.5 transition ${
                mode === "new" ? "bg-blue-600 text-white font-bold" : "bg-slate-950 text-slate-400 hover:text-slate-200"
              }`}
            >
              <FilePlus className="w-3.5 h-3.5" />
              New File
            </button>
            <button
              id="push-mode-edit"
              onClick={() => setMode("edit")}
              className={`flex-1 flex items-center justify-center py-2 px-3 text-xs font-semibold gap-1.5 transition ${
                mode === "edit" ? "bg-blue-600 text-white font-bold" : "bg-slate-950 text-slate-400 hover:text-slate-200"
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Edit File
            </button>
            <button
              id="push-mode-batch"
              onClick={() => setMode("batch")}
              className={`flex-1 flex items-center justify-center py-2 px-3 text-xs font-semibold gap-1.5 transition ${
                mode === "batch" ? "bg-blue-600 text-white font-bold" : "bg-slate-950 text-slate-400 hover:text-slate-200"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Batch Deploy
            </button>
          </div>

          {/* Form elements for single file */}
          {mode !== "batch" && (
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  File Path
                </label>
                <input
                  type="text"
                  id="push-file-path"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder={mode === "new" ? "src/components/CoolFeature.tsx" : "Select a file to edit from Explorer"}
                  className="w-full h-11 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-sm text-slate-100 outline-none"
                  readOnly={mode === "edit"}
                />
                {mode === "edit" && (
                  <span className="text-[10px] text-amber-500 flex items-center gap-1 mt-1">
                    <AlertCircle className="w-3 h-3" />
                    Load and select file edit states inside the "File Explorer" tab.
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  File Content
                </label>
                <textarea
                  id="push-content"
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  placeholder="Paste complete code or text blocks here..."
                  className="w-full min-h-[180px] p-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-xs text-slate-100 outline-none resize-y"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Commit Message
                </label>
                <input
                  type="text"
                  id="push-commit-msg"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Update file"
                  className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 text-xs text-slate-100 outline-none"
                />
              </div>

              <button
                id="btn-push-execute"
                onClick={handleSinglePush}
                disabled={!activeRepo}
                className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-50 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                Commit & Push Changes
              </button>
            </div>
          )}

          {/* Form elements for batch parser */}
          {mode === "batch" && (
            <div className="space-y-4">
              <div className="bg-slate-950 border border-slate-850 p-3 rounded-lg text-xs space-y-1 text-slate-400">
                <p className="font-semibold text-slate-300">💡 Direct LLM Deployer</p>
                <p>Paste multiple outputs from Claude, DeepSeek, or ChatGPT. The format requires:</p>
                <pre className="font-mono text-[10px] text-blue-400 bg-slate-900 border border-slate-800 p-1.5 rounded mt-1.5">
                  {"FILE: src/components/Feature.tsx\nContent:\n<code content>\n\nFILE: package.json\nContent:\n<json content>"}
                </pre>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Aggregated Output Block
                </label>
                <textarea
                  id="batch-input"
                  value={batchInput}
                  onChange={(e) => setBatchInput(e.target.value)}
                  placeholder="Paste entire file-bundled output here..."
                  className="w-full min-h-[160px] p-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-[11px] text-slate-100 outline-none"
                />
              </div>

              <button
                id="btn-batch-parse"
                onClick={handleParseBatch}
                className="w-full h-10 border border-slate-700 hover:bg-slate-850 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 text-blue-400" />
                Parse Aggregated Blocks
              </button>

              {parsedFiles.length > 0 && (
                <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Parsed Files Queue
                  </label>
                  <div
                    id="batch-file-list"
                    className="border border-slate-800 bg-slate-950 rounded-lg max-h-44 overflow-y-auto divide-y divide-slate-850 text-xs"
                  >
                    {parsedFiles.map((f, i) => (
                      <div key={i} className="p-2.5 flex items-center justify-between font-mono gap-3">
                        <span className="text-slate-300 truncate max-w-[180px]">{f.path}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-500">
                            {(f.content.length / 1024).toFixed(1)} KB
                          </span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                              f.status === "success"
                                ? "bg-emerald-950 text-emerald-400"
                                : f.status === "error"
                                ? "bg-rose-950 text-rose-400"
                                : f.status === "uploading"
                                ? "bg-blue-950 text-blue-400 animate-pulse"
                                : "bg-slate-900 text-slate-400"
                            }`}
                          >
                            {f.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {batchProgress.total > 0 && (
                    <div id="batch-progress" className="space-y-1 text-[11px] font-mono">
                      <div className="flex justify-between text-slate-400 text-[10px]">
                        <span>Deploy Progress</span>
                        <span>
                          {batchProgress.current}/{batchProgress.total} Files
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-950 border border-slate-850 rounded-full overflow-hidden">
                        <div
                          id="batch-progress-fill"
                          className="h-full bg-blue-500 transition-all duration-300"
                          style={{
                            width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Commit Message Prefix
                    </label>
                    <input
                      type="text"
                      id="batch-commit-prefix"
                      value={commitPrefix}
                      onChange={(e) => setCommitPrefix(e.target.value)}
                      placeholder="Deploy"
                      className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 text-xs text-slate-100 outline-none font-mono"
                    />
                  </div>

                  <button
                    id="btn-batch-deploy"
                    onClick={handleDeployBatch}
                    disabled={isDeployingBatch || !activeRepo}
                    className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 transition cursor-pointer"
                  >
                    {isDeployingBatch ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/25 border-t-white rounded-full animate-spin" />
                        Deploying Batch...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        Deploy All to GitHub
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Console Log Section */}
        <div className="lg:col-span-5 flex flex-col space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex-1 flex flex-col">
            <div className="flex items-center justify-between text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
              <span className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-500" />
                Console Logs
              </span>
              <button
                id="btn-push-clear-log"
                onClick={() => {
                  setLocalLogs([{ time: new Date().toLocaleTimeString(), msg: "Logs cleared.", type: "info" }]);
                  onClearLog();
                }}
                className="text-[10px] text-slate-500 hover:text-slate-300 font-bold tracking-wider"
              >
                Clear
              </button>
            </div>

            <div
              id="push-log"
              className="flex-1 min-h-[160px] bg-slate-950 border border-slate-850 p-3 rounded-lg font-mono text-[10px] space-y-2 overflow-y-auto max-h-[320px] lg:max-h-[380px]"
            >
              {localLogs.map((log, index) => (
                <div key={index} className="flex gap-2 items-start leading-relaxed">
                  <span className="text-slate-500 shrink-0 select-none">{log.time}</span>
                  <span
                    className={
                      log.type === "success"
                        ? "text-emerald-400"
                        : log.type === "error"
                        ? "text-rose-400 font-bold"
                        : log.type === "warn"
                        ? "text-amber-400"
                        : "text-slate-300"
                    }
                  >
                    {log.msg}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Repo Config Box */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
              <Settings className="w-4 h-4 text-blue-500" />
              Target Settings
            </div>
            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold text-slate-400 uppercase font-mono">
                  Repository
                </span>
                <select
                  id="push-repo-select"
                  value={activeRepo ? activeRepo.full_name : ""}
                  onChange={(e) => onRepoChange(e.target.value)}
                  className="w-full h-9 bg-slate-950 border border-slate-850 hover:border-slate-700 rounded-lg text-xs px-2 text-slate-200 outline-none"
                >
                  <option value="">-- select repo --</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.full_name}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </div>

              {activeRepo && (
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-bold text-slate-400 uppercase font-mono">
                    Branch
                  </span>
                  <select
                    id="push-branch-select"
                    value={activeBranch}
                    onChange={(e) => onBranchChange(e.target.value)}
                    className="w-full h-9 bg-slate-950 border border-slate-850 hover:border-emerald-500 rounded-lg text-xs px-2 text-emerald-400 font-mono outline-none"
                  >
                    <option value="main">main</option>
                    <option value="master">master</option>
                    <option value="dev">dev</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
