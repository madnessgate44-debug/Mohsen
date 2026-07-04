import React, { useState, useEffect } from "react";
import {
  Folder,
  FileCode,
  ArrowLeft,
  RefreshCw,
  Code,
  Info,
  Save,
  Loader,
  AlertCircle,
  File,
} from "lucide-react";
import { Repo, ExplorerItem } from "../types";

interface ExplorerProps {
  activeRepo: Repo | null;
  activeBranch: string;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
  onFileSelectForEdit?: (path: string, content: string) => void;
  onScreenChange?: (screen: string) => void;
}

export const Explorer: React.FC<ExplorerProps> = ({
  activeRepo,
  activeBranch,
  githubProxyRequest,
  onFileSelectForEdit,
  onScreenChange,
}) => {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [items, setItems] = useState<ExplorerItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Active loaded file state
  const [activeFile, setActiveFile] = useState<{
    path: string;
    sha: string;
    content: string;
    size: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"view" | "info">("view");
  const [fileContent, setFileContent] = useState<string>("");
  const [commitMsg, setCommitMsg] = useState<string>("");
  const [savingFile, setSavingFile] = useState<boolean>(false);

  const getFileIcon = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase();
    const codingExts = ["js", "jsx", "ts", "tsx", "html", "css", "py", "sh", "json", "md", "rs", "go", "c", "cpp"];
    if (codingExts.includes(ext || "")) return FileCode;
    return File;
  };

  const loadDirectory = async (path: string) => {
    if (!activeRepo) return;
    setLoading(true);
    setError(null);
    try {
      const cleanPath = path.trim().replace(/^\/+/, "");
      const data = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/contents/${cleanPath}?ref=${activeBranch}`,
        "GET"
      );

      const parsedItems = (Array.isArray(data) ? data : [data]).map((item: any) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size,
        type: item.type as "file" | "dir",
        url: item.url,
        download_url: item.download_url,
      }));

      // Sort: directories first, then files
      parsedItems.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "dir" ? -1 : 1;
      });

      setItems(parsedItems);
      setCurrentPath(cleanPath);
    } catch (err: any) {
      setError(err.message || "Failed to load directory content.");
    } finally {
      setLoading(false);
    }
  };

  const handleFileClick = async (item: ExplorerItem) => {
    if (!activeRepo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/contents/${item.path}?ref=${activeBranch}`,
        "GET"
      );

      let decoded = "";
      if (data.encoding === "base64") {
        try {
          decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
        } catch (e) {
          decoded = "[Binary file -- cannot display content]";
        }
      } else {
        decoded = data.content || "";
      }

      setActiveFile({
        path: item.path,
        sha: item.sha,
        content: decoded,
        size: item.size,
      });
      setFileContent(decoded);
      setCommitMsg(`Edit ${item.name} via Mission Control`);
      setActiveTab("view");
    } catch (err: any) {
      setError(err.message || "Failed to load file content.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveFile = async () => {
    if (!activeRepo || !activeFile) return;
    setSavingFile(true);
    try {
      const body = {
        message: commitMsg || `Edit ${activeFile.path}`,
        content: btoa(unescape(encodeURIComponent(fileContent))),
        branch: activeBranch,
        sha: activeFile.sha,
      };

      const result = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/contents/${activeFile.path}`,
        "PUT",
        body
      );

      // Update sha for successive edits
      setActiveFile((prev) =>
        prev
          ? {
              ...prev,
              sha: result.content?.sha || prev.sha,
              content: fileContent,
            }
          : null
      );

      // Refresh directory tree to reflect any changes
      await loadDirectory(currentPath);
      alert("✓ File saved successfully!");
    } catch (err: any) {
      alert("✗ Save failed: " + err.message);
    } finally {
      setSavingFile(false);
    }
  };

  const handleBackClick = () => {
    const segments = currentPath.split("/");
    segments.pop();
    const parentPath = segments.join("/");
    loadDirectory(parentPath);
  };

  // Auto load when activeRepo/branch changes
  useEffect(() => {
    if (activeRepo) {
      loadDirectory("");
      setActiveFile(null);
    }
  }, [activeRepo, activeBranch]);

  return (
    <div id="screen-explorer" className="space-y-4 animate-fadein">
      {/* Page Title */}
      <div className="mb-1">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">File Explorer</h2>
        <p className="text-xs text-slate-400">Browse folders, review assets, and edit code</p>
      </div>

      {/* Path Breadcrumb bar */}
      <div className="flex gap-2">
        <div className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-lg h-11 flex items-center px-3 font-mono text-xs text-slate-300 overflow-x-auto whitespace-nowrap">
          {activeRepo ? `${activeRepo.name} : /${currentPath}` : "No repository active"}
        </div>
        <button
          id="btn-explorer-load"
          onClick={() => loadDirectory(currentPath)}
          disabled={!activeRepo || loading}
          className="h-11 w-11 bg-slate-900 hover:bg-slate-850 text-slate-300 rounded-lg flex items-center justify-center border border-slate-800 active:scale-95 disabled:opacity-50 transition cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-blue-400" : ""}`} />
        </button>
      </div>

      {/* Workspace container */}
      <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-900 grid grid-cols-1 md:grid-cols-12 min-h-[460px]">
        {/* Left Tree Explorer (col-span-4) */}
        <div className="md:col-span-4 border-r border-slate-800 flex flex-col h-[240px] md:h-auto">
          {/* Header */}
          <div className="bg-slate-950 px-3.5 py-2.5 flex items-center justify-between border-b border-slate-800 shrink-0">
            <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
              Files Tree
            </span>
            {currentPath && (
              <button
                onClick={handleBackClick}
                className="text-[10px] text-blue-400 flex items-center gap-1 hover:text-blue-300"
              >
                <ArrowLeft className="w-3 h-3" /> Back
              </button>
            )}
          </div>

          {/* Tree body */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-slate-950/40">
            {loading && items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-500 gap-2">
                <Loader className="w-6 h-6 animate-spin text-blue-500" />
                <span className="text-xs">Loading tree...</span>
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-12 text-slate-500 text-xs">
                {activeRepo ? "This directory is empty." : "Select a repository to begin."}
              </div>
            ) : (
              items.map((item) => {
                const isDir = item.type === "dir";
                const FileIcon = isDir ? Folder : getFileIcon(item.name);
                const isActive = activeFile?.path === item.path;

                return (
                  <button
                    key={item.path}
                    onClick={() => (isDir ? loadDirectory(item.path) : handleFileClick(item))}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-all ${
                      isActive
                        ? "bg-blue-950/60 text-blue-400 border border-blue-900/30"
                        : "text-slate-300 hover:bg-slate-800/55 hover:text-white"
                    }`}
                  >
                    <FileIcon
                      className={`w-4 h-4 shrink-0 ${
                        isDir ? "text-amber-500" : isActive ? "text-blue-400" : "text-slate-400"
                      }`}
                    />
                    <span className="truncate flex-1">{item.name}</span>
                    {!isDir && (
                      <span className="text-[9px] text-slate-500 font-mono shrink-0">
                        {(item.size / 1024).toFixed(1)} KB
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Code Display Viewer (col-span-8) */}
        <div className="md:col-span-8 flex flex-col bg-slate-950">
          {/* Tabs */}
          <div className="flex bg-slate-950 border-b border-slate-800 shrink-0">
            <button
              onClick={() => setActiveTab("view")}
              className={`px-4 py-2.5 flex items-center gap-1.5 text-xs font-semibold border-r border-slate-800 transition ${
                activeTab === "view"
                  ? "bg-slate-900 text-white border-b-2 border-b-blue-500"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              <span>Editor</span>
            </button>
            <button
              onClick={() => setActiveTab("info")}
              className={`px-4 py-2.5 flex items-center gap-1.5 text-xs font-semibold border-r border-slate-800 transition ${
                activeTab === "info"
                  ? "bg-slate-900 text-white border-b-2 border-b-blue-500"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
              }`}
            >
              <Info className="w-3.5 h-3.5" />
              <span>Details</span>
            </button>
          </div>

          {/* Content panel */}
          <div className="flex-1 flex flex-col min-h-[220px]">
            {activeFile ? (
              <>
                {activeTab === "view" ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <textarea
                      value={fileContent}
                      onChange={(e) => setFileContent(e.target.value)}
                      className="w-full flex-1 p-3.5 bg-slate-950/70 text-slate-100 font-mono text-xs outline-none resize-none leading-relaxed min-h-[260px]"
                    />

                    {/* Commit save bar */}
                    <div className="bg-slate-900 border-t border-slate-800 p-3 flex flex-col sm:flex-row gap-2 shrink-0">
                      <input
                        type="text"
                        value={commitMsg}
                        onChange={(e) => setCommitMsg(e.target.value)}
                        placeholder="Commit message"
                        className="flex-1 h-9 px-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 font-mono outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={handleSaveFile}
                        disabled={savingFile}
                        className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 active:scale-95 disabled:opacity-50 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 shrink-0 transition cursor-pointer"
                      >
                        {savingFile ? (
                          <Loader className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        {savingFile ? "Saving..." : "Commit File"}
                      </button>

                      {/* Send to edit option */}
                      {onFileSelectForEdit && onScreenChange && (
                        <button
                          onClick={() => {
                            onFileSelectForEdit(activeFile.path, fileContent);
                            onScreenChange("push");
                          }}
                          className="h-9 px-3 border border-slate-700 hover:bg-slate-800 active:scale-95 text-slate-300 text-xs font-semibold rounded-lg shrink-0 transition cursor-pointer"
                        >
                          Send to Push Suite
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-4 space-y-3 text-xs">
                    <h3 className="font-bold text-white text-sm">File Metadata</h3>
                    <div className="divider border-slate-800 border-t my-1" />
                    <div className="space-y-2 font-mono text-slate-300">
                      <div>
                        <span className="text-slate-500 block">Relative Path:</span>
                        <span className="text-white">{activeFile.path}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">SHA Checksum:</span>
                        <span className="text-blue-400">{activeFile.sha}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">File Size:</span>
                        <span className="text-white">{(activeFile.size / 1024).toFixed(2)} KB ({activeFile.size} bytes)</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-500 gap-2">
                <AlertCircle className="w-10 h-10 text-slate-700" />
                <p className="text-xs">Select a file from the list to display content in the Editor.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
