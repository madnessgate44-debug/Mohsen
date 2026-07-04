import React, { useState } from "react";
import {
  FolderKanban,
  Search,
  Plus,
  RefreshCw,
  Globe,
  Lock,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { Repo } from "../types";

interface ReposListProps {
  repos: Repo[];
  activeRepo: Repo | null;
  onRepoSelect: (repo: Repo) => void;
  onRefresh: () => Promise<void>;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
}

export const ReposList: React.FC<ReposListProps> = ({
  repos,
  activeRepo,
  onRepoSelect,
  onRefresh,
  githubProxyRequest,
}) => {
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
  const [newRepoName, setNewRepoName] = useState<string>("");
  const [newRepoDesc, setNewRepoDesc] = useState<string>("");
  const [newRepoPrivate, setNewRepoPrivate] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const filteredRepos = filterQuery
    ? repos.filter((r) => r.full_name.toLowerCase().includes(filterQuery.toLowerCase()))
    : repos;

  const handleCreateRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim()) {
      alert("Repository name is required.");
      return;
    }
    setCreating(true);
    try {
      const body = {
        name: newRepoName.trim(),
        description: newRepoDesc.trim(),
        private: newRepoPrivate,
        auto_init: true, // Auto create README.md to make it immediately cloneable/workable
      };

      const result = await githubProxyRequest("/user/repos", "POST", body);

      // Refresh repos list and select newly created repo
      await onRefresh();
      setShowCreateForm(false);
      setNewRepoName("");
      setNewRepoDesc("");
      setNewRepoPrivate(false);

      alert(`✓ Repository "${result.name}" created successfully!`);
    } catch (err: any) {
      alert("✗ Failed to create repository: " + err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRefreshClick = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div id="screen-repos" className="space-y-4 animate-fadein">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Repositories</h2>
          <p className="text-xs text-slate-400">Discover and switch active workspace containers</p>
        </div>
        <div className="flex gap-2">
          <button
            id="btn-repos-refresh"
            onClick={handleRefreshClick}
            disabled={refreshing}
            className="h-10 w-10 bg-slate-900 border border-slate-800 text-slate-300 rounded-lg flex items-center justify-center active:scale-95 disabled:opacity-50 hover:bg-slate-850 transition cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin text-blue-400" : ""}`} />
          </button>
          <button
            id="btn-create-repo"
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="h-10 px-3.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer shrink-0 shadow-md shadow-blue-900/20"
          >
            <Plus className="w-4 h-4" />
            <span>Create</span>
          </button>
        </div>
      </div>

      {/* Repository Creation Overlay Form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateRepo}
          className="bg-slate-900 border border-blue-900/30 p-4 rounded-xl space-y-3 animate-fadein shadow-lg"
        >
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            Create New Repository
          </h3>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Repo Name
            </span>
            <input
              type="text"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
              placeholder="e.g. my-awesome-project"
              required
              className="w-full h-10 px-3 bg-slate-950 border border-slate-850 focus:border-blue-500 rounded-lg text-xs text-slate-100 font-mono outline-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Description (Optional)
            </span>
            <input
              type="text"
              value={newRepoDesc}
              onChange={(e) => setNewRepoDesc(e.target.value)}
              placeholder="A short tagline explaining this codebase"
              className="w-full h-10 px-3 bg-slate-950 border border-slate-850 focus:border-blue-500 rounded-lg text-xs text-slate-100 outline-none"
            />
          </div>

          <div className="flex items-center gap-2.5 bg-slate-950 border border-slate-850 p-3 rounded-lg">
            <input
              type="checkbox"
              id="new-repo-private"
              checked={newRepoPrivate}
              onChange={(e) => setNewRepoPrivate(e.target.checked)}
              className="w-4 h-4 text-blue-600 border-slate-700 bg-slate-900 rounded focus:ring-blue-500 focus:ring-2 cursor-pointer"
            />
            <label htmlFor="new-repo-private" className="text-xs text-slate-300 cursor-pointer">
              Make this repository <strong className="text-slate-100">Private</strong>
            </label>
          </div>

          <div className="flex justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="h-9 px-3 border border-slate-750 hover:bg-slate-850 rounded-lg text-xs text-slate-400 font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50 transition cursor-pointer"
            >
              {creating && (
                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              )}
              {creating ? "Creating..." : "Create Repo"}
            </button>
          </div>
        </form>
      )}

      {/* Filtration input */}
      <div className="flex gap-2">
        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-lg h-11 flex items-center px-3 gap-2">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            type="text"
            id="repos-search"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search repositories by name..."
            className="w-full h-full bg-transparent text-slate-200 outline-none text-xs"
          />
        </div>
      </div>

      {/* Directory list */}
      <div id="repos-list" className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
        {filteredRepos.length === 0 ? (
          <div className="text-center py-20 text-slate-500 text-xs bg-slate-900 border border-slate-800 rounded-xl p-4">
            No repositories found matching that search.
          </div>
        ) : (
          filteredRepos.map((repo) => {
            const isActive = activeRepo?.full_name === repo.full_name;
            return (
              <div
                key={repo.id}
                onClick={() => onRepoSelect(repo)}
                className={`p-3.5 rounded-xl border flex items-center justify-between gap-4 transition-all duration-150 active:scale-[0.99] cursor-pointer ${
                  isActive
                    ? "bg-blue-950/40 border-blue-600/50 shadow-md shadow-blue-950/20"
                    : "bg-slate-900 border-slate-800/80 hover:border-slate-700/80"
                }`}
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FolderKanban className={`w-4 h-4 shrink-0 ${isActive ? "text-blue-400 animate-pulse" : "text-slate-400"}`} />
                    <h3 className="font-bold text-white text-xs sm:text-sm truncate">
                      {repo.name}
                    </h3>
                    <span
                      className={`text-[8px] font-bold tracking-wider px-1.5 py-0.5 rounded-md flex items-center gap-0.5 uppercase shrink-0 font-mono ${
                        repo.private
                          ? "bg-amber-950 text-amber-400 border border-amber-900/40"
                          : "bg-emerald-950 text-emerald-400 border border-emerald-900/40"
                      }`}
                    >
                      {repo.private ? <Lock className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
                      {repo.private ? "Private" : "Public"}
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 line-clamp-1">
                    {repo.description || "No description tags available."}
                  </p>

                  <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono">
                    <span className="truncate max-w-[120px]">{repo.full_name}</span>
                    <span>·</span>
                    <span>⭐ {repo.stargazers_count}</span>
                    {repo.language && (
                      <>
                        <span>·</span>
                        <span className="font-sans font-semibold text-slate-400">{repo.language}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="shrink-0 flex items-center">
                  <ChevronRight className={`w-5 h-5 ${isActive ? "text-blue-400" : "text-slate-600"}`} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
