import React, { useEffect, useState } from "react";
import { GitCommit, Calendar, User, RefreshCw, AlertCircle } from "lucide-react";
import { Repo, Commit } from "../types";

interface CommitsListProps {
  activeRepo: Repo | null;
  activeBranch: string;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
}

export const CommitsList: React.FC<CommitsListProps> = ({
  activeRepo,
  activeBranch,
  githubProxyRequest,
}) => {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCommits = async () => {
    if (!activeRepo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await githubProxyRequest(
        `/repos/${activeRepo.full_name}/commits?sha=${activeBranch}&per_page=40`,
        "GET"
      );

      const parsedCommits: Commit[] = data.map((item: any) => ({
        sha: item.sha,
        commit: {
          message: item.commit?.message || "No commit message",
          author: {
            name: item.commit?.author?.name || "Unknown Author",
            date: item.commit?.author?.date || "",
          },
        },
        author: item.author
          ? {
              login: item.author.login,
              avatar_url: item.author.avatar_url,
            }
          : null,
      }));

      setCommits(parsedCommits);
    } catch (err: any) {
      setError(err.message || "Failed to load commits.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCommits();
  }, [activeRepo, activeBranch]);

  return (
    <div id="screen-commits" className="space-y-4 animate-fadein">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Commit History</h2>
          <p className="text-xs text-slate-400">Chronological commit logs for the active workspace</p>
        </div>
        <button
          id="btn-commits-refresh"
          onClick={fetchCommits}
          disabled={!activeRepo || loading}
          className="h-10 px-3.5 bg-slate-900 border border-slate-800 text-slate-300 rounded-lg flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50 hover:bg-slate-850 transition cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span className="text-xs font-semibold">Refresh</span>
        </button>
      </div>

      {!activeRepo ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-3">
          <AlertCircle className="w-10 h-10 text-slate-700 mx-auto" />
          <p className="text-sm font-semibold">Active repository context required.</p>
          <p className="text-xs max-w-sm mx-auto">
            Please connect your GitHub account and select a repository in the sidebar to review the commit logs.
          </p>
        </div>
      ) : error ? (
        <div className="bg-slate-950/40 border border-rose-950 p-4 rounded-xl text-xs text-rose-400">
          <p className="font-bold">Error loading commits:</p>
          <p className="font-mono mt-1">{error}</p>
        </div>
      ) : loading && commits.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-2">
          <div className="w-6 h-6 border-2 border-blue-500/25 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-xs">Loading logs...</span>
        </div>
      ) : commits.length === 0 ? (
        <div className="text-center py-20 text-slate-500 text-xs bg-slate-900 border border-slate-800 rounded-xl p-4">
          No commits found on branch "{activeBranch}".
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider font-mono px-1">
            {activeRepo.full_name} @ {activeBranch} ({commits.length} commits listed)
          </div>
          <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
            {commits.map((c) => (
              <div
                key={c.sha}
                className="bg-slate-900 border border-slate-800 hover:border-slate-700 p-3.5 rounded-xl flex items-start justify-between gap-4 transition"
              >
                <div className="space-y-1.5 min-w-0">
                  <span className="inline-block font-mono text-[10px] font-bold text-blue-400 bg-blue-950/50 border border-blue-900/30 px-1.5 py-0.5 rounded">
                    {c.sha.substring(0, 7)}
                  </span>
                  <p className="font-semibold text-xs sm:text-sm text-slate-100 line-clamp-2 leading-relaxed">
                    {c.commit.message}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400 font-mono">
                    <span className="flex items-center gap-1 font-sans font-semibold">
                      {c.author ? (
                        <img
                          src={c.author.avatar_url}
                          alt={c.author.login}
                          className="w-4 h-4 rounded-full"
                        />
                      ) : (
                        <User className="w-3.5 h-3.5 text-slate-500" />
                      )}
                      {c.commit.author.name}
                    </span>
                    <span className="flex items-center gap-1 text-slate-500">
                      <Calendar className="w-3.5 h-3.5" />
                      {new Date(c.commit.author.date).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
